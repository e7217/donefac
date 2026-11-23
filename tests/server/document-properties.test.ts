import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import type { CollaborationExport } from '../../server/collaboration.js';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration.js';
import { renderDocumentExportMarkdown } from '../../shared/document-export-markdown.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { collectDocumentPropertyReport, normalizeDocumentPropertyReportOptions } from '../../shared/document-properties.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, DocPage, DocRevision, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const properties = (attrs: Record<string, unknown>): RichContent => ({ type: 'documentProperties', attrs });
const report = (attrs: Record<string, unknown>): RichContent => ({ type: 'documentPropertyReport', attrs });

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-properties-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', payload?: unknown, token?: string) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Actor-Id': 'user-min' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function create(title: string, content: RichContent, options: { projectId?: string | null; labels?: string[] } = {}) {
    const response = await call<DocPage>('/documents', 'POST', { projectId: 'project-neo', ...options, title, content });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  return { call, create };
}

test('saved document properties produce one report row per block with exact group, label, column and space scope', async t => {
  const f = await fixture(t);
  const reportOptions = {
    projectId: 'project-neo', group: ' Cafe\u0301 ', labels: ['Rollup', '결정'], match: 'all',
    columns: [' cafe\u0301 ', '__proto__', '상태'], sort: 'title', descending: false, limit: 2, title: ' 운영 기록 ',
  };
  const host = await f.create('운영 기록 색인', body(report(reportOptions)));
  assert.equal(documentContentSchemaVersion(host.content), 13);
  const canonicalReport = normalizeDocumentPropertyReportOptions(host.content.content?.[0]?.attrs);
  assert.ok(canonicalReport);
  assert.deepEqual(canonicalReport.columns, ['café', '__proto__', '상태']);
  assert.equal(canonicalReport.group, 'Café');
  assert.equal(canonicalReport.title, '운영 기록');
  const withStatus = (value: string, group = 'Café', hidden = false) => properties({ group, hidden, entries: [
    { name: '상태', value },
  ] });
  const labels = ['rollup', '결정'];
  const hiddenValue = '숨긴 원본 값\na | *b*';
  const first = await f.create('Alpha 2', body(
    properties({ group: 'Cafe\u0301', hidden: true, entries: [
      { name: 'cafe\u0301', value: hiddenValue }, { name: '__proto__', value: '저장한 텍스트' },
    ] }),
    { type: 'callout', attrs: { variant: 'info', title: '검토' }, content: [withStatus('같은 문서의 두 번째 블록')] },
    withStatus('다른 그룹', 'café'),
  ), { labels });
  const later = await f.create('Alpha 9', body(withStatus('세 번째 결과')), { labels });
  const partial = await f.create('Beta 1', body(withStatus('한 가지 라벨')), { labels: ['Rollup'] });
  const common = await f.create('팀 공통 자료', body(withStatus('공통 값')), { projectId: null, labels });
  await f.create('외부 프로젝트 자료', body(withStatus('다른 프로젝트 값')), { projectId: 'project-team', labels });
  const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const rollup = collectDocumentPropertyReport(workspace.documents, canonicalReport);
  assert.equal(rollup.total, 3);
  assert.deepEqual(rollup.columns, ['café', '__proto__', '상태']);
  assert.deepEqual(rollup.rows.map(row => row.document.id), [first.id, first.id]);
  assert.notEqual(rollup.rows[0].id, rollup.rows[1].id);
  assert.equal(rollup.rows[0].entries.café, hiddenValue);
  assert.equal(rollup.rows[0].entries['__proto__'], '저장한 텍스트');
  assert.equal(Object.hasOwn(rollup.rows[1].entries, '__proto__'), false);
  assert.equal(rollup.rows[1].entries['상태'], '같은 문서의 두 번째 블록');
  const all = collectDocumentPropertyReport(workspace.documents, { ...canonicalReport, match: 'any', group: '', columns: [], limit: 12 });
  assert.deepEqual(all.rows.map(row => row.document.id), [first.id, first.id, first.id, later.id, partial.id]);
  assert.deepEqual(all.columns, ['café', '__proto__', '상태']);
  assert.deepEqual(collectDocumentPropertyReport(workspace.documents, { ...canonicalReport, projectId: null }).rows.map(row => row.document.id), [common.id]);
  assert.equal(collectDocumentPropertyReport(workspace.documents, { ...canonicalReport, labels: [] }).total, 0);

  const patched = await f.call<DocPage>(`/documents/${first.id}`, 'PATCH', {
    expectedVersion: first.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
    content: body(withStatus('최신 서버 값')), labels,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const after = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const revisedRollup = collectDocumentPropertyReport(after.documents, canonicalReport);
  assert.deepEqual(revisedRollup.rows.map(row => row.entries['상태']), ['최신 서버 값', '세 번째 결과']);
  assert.equal(after.documents.find(document => document.id === host.id)?.version, host.version);
  const revision = (await f.call<DocRevision[]>(`/documents/${host.id}/revisions`)).data[0];
  assert.deepEqual(revision.content, host.content);
  assert.doesNotMatch(JSON.stringify(revision.content), /최신 서버 값|세 번째 결과/u);
  const resolve = { document: () => undefined, attachment: () => undefined };
  const exportedSource = renderDocumentExportMarkdown(first, resolve);
  assert.match(exportedSource.markdown, /문서 속성.*Café.*원문에서 숨김/u);
  assert.ok(exportedSource.markdown.includes('| café | 숨긴 원본 값<br>a \\| \\*b\\* |'));
  assert.ok(exportedSource.diagnostics.some(entry => entry.code === 'properties_as_table'));
  const exportedHost = renderDocumentExportMarkdown(host, resolve);
  assert.match(exportedHost.markdown, /운영 기록.*모든 라벨.*최대 2행.*조회 결과 생략/u);
  assert.doesNotMatch(exportedHost.markdown, /숨긴 원본 값|최신 서버 값|세 번째 결과/u);
  assert.ok(exportedHost.diagnostics.some(entry => entry.code === 'dynamic_block' && entry.nodeType === 'documentPropertyReport'));
});

test('document property definitions enforce bounds and content versions, and survive collaboration and backup restoration', async t => {
  const f = await fixture(t);
  const propertyOptions = { group: '운영', hidden: false, entries: [{ name: '상태', value: '검토 대기' }] };
  const reportOptions = { projectId: 'project-neo', group: '운영', labels: ['검토'], columns: ['상태'] };
  for (const node of [
    properties({ ...propertyOptions, group: '가'.repeat(81) }),
    properties({ ...propertyOptions, hidden: 'yes' }),
    properties({ ...propertyOptions, entries: [{ name: '', value: '값' }] }),
    properties({ ...propertyOptions, entries: [{ name: '가'.repeat(81), value: '값' }] }),
    properties({ ...propertyOptions, entries: [{ name: '상태', value: '가'.repeat(801) }] }),
    properties({ ...propertyOptions, entries: Array.from({ length: 25 }, (_, index) => ({ name: `열 ${index}`, value: '값' })) }),
    properties({ ...propertyOptions, entries: [{ name: 'Cafe\u0301', value: '1' }, { name: 'Café', value: '2' }] }),
    report({ ...reportOptions, projectId: 'missing-project' }),
    report({ ...reportOptions, match: 'none' }),
    report({ ...reportOptions, columns: ['가'.repeat(81)] }),
    report({ ...reportOptions, columns: Array.from({ length: 25 }, (_, index) => `열 ${index}`) }),
    report({ ...reportOptions, limit: 201 }),
  ]) {
    const result = await f.call('/documents', 'POST', { title: '유효하지 않은 속성 설정', projectId: 'project-neo', content: body(node) });
    assert.equal(result.status, 422, JSON.stringify([node, result.data]));
  }
  const authored = await f.create('공동 편집할 운영 속성', body(paragraph('검토 기준'), properties(propertyOptions), report(reportOptions)));
  const older = await f.create('이전 공동 편집 문서', body(paragraph('이전 형식으로 보관할 본문')));
  const path = `/documents/${authored.id}`;
  const stale = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
    expectedVersion: authored.version, contentSchemaVersion: 12, content: body(paragraph('옛 편집기의 본문')),
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.details.contentSchemaVersion, 13);
  const live = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: authored.version });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.schemaVersion, COLLABORATION_SCHEMA);
  assert.deepEqual(live.data.document.content, authored.content);
  const olderPath = `/documents/${older.id}/collaboration`;
  assert.equal((await f.call(`${olderPath}/enable`, 'POST', { expectedVersion: older.version })).status, 200);
  type Backup = WorkspaceSnapshot & { schemaVersion: number; collabStates: CollaborationExport[] };
  const exported = (await f.call<Backup>('/export')).data;
  assert.equal(exported.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const rejected = await f.call<{ error: string }>('/import', 'POST', { data: { ...exported, schemaVersion: 95 } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error, /schemaVersion 96/u);
  const mislabeled = { ...exported, collabStates: exported.collabStates.map(state =>
    state.documentId === authored.id ? { ...state, schemaVersion: 12 } : state) };
  assert.equal((await f.call('/import', 'POST', { data: mislabeled })).status, 422);

  const supported = { ...exported, collabStates: exported.collabStates.map(state =>
    state.documentId === older.id ? { ...state, schemaVersion: 12 } : state) };
  assert.equal((await f.call('/import', 'POST', { data: supported })).status, 200);
  const compatible = (await f.call<CollaborationSession>(olderPath)).data;
  assert.equal(compatible.schemaVersion, COLLABORATION_SCHEMA);
  assert.deepEqual(compatible.document.content, older.content);
  const restored = (await f.call<CollaborationSession>(`${path}/collaboration`)).data;
  assert.notEqual(restored.epoch, live.data.epoch);
  assert.deepEqual(restored.document.content, authored.content);
  const trash = await f.call<{ trashEntryId: string }>(path, 'DELETE', { expectedVersion: restored.document.version });
  assert.equal(trash.status, 200);
  const archive = (await f.call<Backup>('/export')).data;
  assert.equal(archive.documents.some(document => document.id === authored.id), false);
  assert.equal((await f.call('/import', 'POST', { data: { ...archive, schemaVersion: 95 } })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: archive })).status, 200);
  assert.equal((await f.call(`/trash/${trash.data.trashEntryId}/restore`, 'POST', {})).status, 200);
  assert.deepEqual((await f.call<CollaborationSession>(`${path}/collaboration`)).data.document.content, authored.content);
  assert.ok((await f.call<DocRevision[]>(`${path}/revisions`)).data.some(revision =>
    documentContentSchemaVersion(revision.content) === 13));
});

test('scoped document API keys fence property reports on writes, collections, history and review snapshots', async t => {
  const f = await fixture(t);
  const settings = (projectId: string | null) => body({
    type: 'callout', attrs: { variant: 'info', title: '업무 현황' }, content: [report({ projectId, labels: ['결정'] })],
  });
  const createdKey = await f.call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '보고서 범위 확인', access: 'write', projectIds: ['project-neo'],
  });
  assert.equal(createdKey.status, 201, JSON.stringify(createdKey.data));
  const { token } = createdKey.data;
  const allowed = await f.call<DocPage>('/v1/documents', 'POST', {
    title: '같은 범위의 보고서', projectId: 'project-neo', content: settings('project-neo'),
  }, token);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
  assert.equal((await f.call(`/v1/documents/${allowed.data.id}`, 'GET', undefined, token)).status, 200);
  for (const scope of ['project-team', null]) {
    assert.equal((await f.call('/v1/documents', 'POST', {
      title: '범위 밖 보고서', projectId: 'project-neo', content: settings(scope),
    }, token)).status, 403);
    assert.equal((await f.call(`/v1/documents/${allowed.data.id}`, 'PATCH', {
      expectedVersion: allowed.data.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: settings(scope),
    }, token)).status, 403);
    const foreign = await f.create('다른 공간을 집계하는 문서', settings(scope));
    const path = `/documents/${foreign.id}`;
    assert.equal((await f.call(`/v1${path}`, 'GET', undefined, token)).status, 403);
    assert.equal((await f.call(`/v1${path}`, 'PATCH', { expectedVersion: foreign.version, title: '제목만 수정' }, token)).status, 403);
    const listed = await f.call<DocPage[]>('/v1/documents', 'GET', undefined, token);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.some(document => document.id === allowed.data.id));
    assert.ok(listed.data.every(document => document.id !== foreign.id));
    assert.deepEqual((await f.call<DocRevision[]>(`/v1${path}/revisions`, 'GET', undefined, token)).data, []);

    const publication = `${path}/publication`;
    const state = (await f.call<DocumentPublicationView>(publication)).data;
    const review = await f.call<DocumentPublicationView>(publication, 'POST', {
      action: 'request', expectedVersion: state.version, workspaceGeneration: state.workspaceGeneration,
      expectedDocumentVersion: foreign.version, reviewerId: 'user-seo',
    });
    assert.equal(review.status, 200, JSON.stringify(review.data));
    assert.ok(review.data.review);
    const snapshot = `${publication}/snapshot?kind=review&revisionId=${review.data.review.revisionId}`;
    assert.equal((await f.call(snapshot)).status, 200);
    assert.equal((await f.call(`/v1${snapshot}`, 'GET', undefined, token)).status, 403);
  }
});
