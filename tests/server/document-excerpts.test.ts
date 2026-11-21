import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import type { CollaborationExport } from '../../server/collaboration.js';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration.js';
import { contentReferences, documentContentSchemaVersion, findDocumentExcerpt } from '../../shared/document-nodes.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, DocPage, DocRevision, DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const excerpt = (...content: RichContent[]): RichContent => ({ type: 'documentExcerpt', attrs: { hidden: true }, content });
const include = (documentId: string): RichContent => ({ type: 'documentExcerptInclude', attrs: { documentId, label: '팀 점검 절차', noPanel: true } });

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-excerpts-'));
  const app = createApp({ dataDir: directory, outboundWorker: false });
  const server = app.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>(resolve => server.close(() => resolve()));
      app.close();
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
  async function create(title: string, content: RichContent, projectId = 'project-neo') {
    const response = await call<DocPage>('/documents', 'POST', { title, content, projectId });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async function enable(doc: DocPage) {
    const response = await call<CollaborationSession>(`/documents/${doc.id}/collaboration/enable`, 'POST', { expectedVersion: doc.version });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.schemaVersion, COLLABORATION_SCHEMA);
    return response.data;
  }
  return { call, create, enable };
}

test('document excerpts preserve rich content, version guards, and shared inclusion cycle checks', async t => {
  const f = await fixture(t);
  const first = excerpt({ type: 'heading', attrs: { level: 2, sectionId: 'live-checks' }, content: [
    { type: 'text', text: '점검 순서', marks: [{ type: 'bold' }] },
  ] });
  const reference = await f.create('절차 원본', body(paragraph('바깥 본문'), first, excerpt(paragraph('두 번째 발췌'))));
  assert.deepEqual(findDocumentExcerpt(reference.content), first);
  assert.equal(documentContentSchemaVersion(reference.content), 11);
  const host = await f.create('절차 참조', body(include(reference.id)));
  assert.deepEqual(host.content, body(include(reference.id)));
  assert.equal(documentContentSchemaVersion(host.content), 11);
  assert.deepEqual(contentReferences(host.content), [{ type: 'document', kind: 'include', id: reference.id, label: '팀 점검 절차' }]);

  const malformedNodes: RichContent[] = [
    { ...first, attrs: { hidden: 'true' } }, { ...first, attrs: { hidden: null } },
    { ...first, content: [{ type: 'text', text: '블록이 아닌 내용' }] },
    { ...include(reference.id), attrs: { ...include(reference.id).attrs, noPanel: 0 } },
    { ...include(reference.id), attrs: { ...include(reference.id).attrs, name: '없는 속성' } },
    include('missing-source'),
  ];
  for (const node of malformedNodes) {
    const invalid = await f.call('/documents', 'POST', { title: '잘못된 발췌', projectId: 'project-neo', content: body(node) });
    assert.equal(invalid.status, 422, JSON.stringify([node, invalid.data]));
  }
  const oldBody = await f.call<{ details: { contentSchemaVersion: number } }>(`/documents/${host.id}`, 'PATCH', {
    expectedVersion: host.version, contentSchemaVersion: 10, content: body(paragraph('구형 편집기의 본문')),
  });
  assert.equal(oldBody.status, 409);
  assert.equal(oldBody.data.details.contentSchemaVersion, 11);
  const cycle = await f.call<{ details: { code: string } }>(`/documents/${reference.id}`, 'PATCH', {
    expectedVersion: reference.version, contentSchemaVersion: 11, content: body(excerpt({
      type: 'documentInclude', attrs: { documentId: host.id, label: '절차 참조' },
    })),
  });
  assert.equal(cycle.status, 422, JSON.stringify(cycle.data));
  const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(snapshot.documents.find(doc => doc.id === reference.id)?.content, reference.content);
});

test('backup format 69 keeps excerpts across revisions, templates, trash and protocol 10 upgrades', async t => {
  const f = await fixture(t);
  const legacy = await f.create('프로토콜 10 문서', body({ type: 'documentChildList' }));
  await f.enable(legacy);
  const source = await f.create('발췌 원본', body(excerpt(paragraph('합성 작업 절차'))));
  const host = await f.create('발췌 포함 문서', body(include(source.id)));
  const sourceState = await f.enable(source);
  const template = await f.call<DocumentTemplateSummary>('/document-templates', 'POST', {
    requestId: randomUUID(), sourceDocumentId: source.id, expectedDocumentVersion: sourceState.document.version, name: '점검 문서',
  });
  assert.equal(template.status, 201, JSON.stringify(template.data));
  await f.enable(host);
  const trashed = await f.call<{ trashEntryId: string }>(`/documents/${host.id}`, 'DELETE');
  assert.equal(trashed.status, 200, JSON.stringify(trashed.data));

  type Backup = WorkspaceSnapshot & { schemaVersion: number; collabStates: CollaborationExport[]; revisions: DocRevision[]; documentTemplates: unknown[] };
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const oldBackup = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 68 } });
  assert.equal(oldBackup.status, 400);
  assert.match(oldBackup.data.error, /템플릿.*69/u);
  const noTemplates = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 68, documentTemplates: [] } });
  assert.equal(noTemplates.status, 400);
  assert.match(noTemplates.data.error, /발췌.*69/u);
  const mismarked = { ...backup, collabStates: backup.collabStates.map(state =>
    state.documentId === source.id ? { ...state, schemaVersion: 10 } : state) };
  assert.equal((await f.call('/import', 'POST', { data: mismarked })).status, 422);

  const priorState = backup.collabStates.find(state => state.documentId === legacy.id)!;
  priorState.schemaVersion = 10;
  const restored = await f.call('/import', 'POST', { data: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const revived = await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST');
  assert.equal(revived.status, 200, JSON.stringify(revived.data));
  for (const original of [host, source, legacy]) {
    const session = (await f.call<CollaborationSession>(`/documents/${original.id}/collaboration`)).data;
    assert.equal(session.schemaVersion, COLLABORATION_SCHEMA);
    assert.notEqual(session.epoch, backup.collabStates.find(state => state.documentId === original.id)?.epoch);
    assert.deepEqual(session.document.content, original.content);
    assert.ok((await f.call<DocRevision[]>(`/documents/${original.id}/revisions`)).data
      .some(revision => JSON.stringify(revision.content) === JSON.stringify(original.content)));
  }
  const templates = await f.call<DocumentTemplateSummary[]>('/document-templates?projectId=project-neo');
  const latest = templates.data.find(candidate => candidate.id === template.data.id)!;
  const instance = await f.call<DocPage>('/documents', 'POST', {
    requestId: randomUUID(), templateId: latest.id, expectedTemplateVersion: latest.version, title: '새 점검 문서', projectId: 'project-neo',
  });
  assert.equal(instance.status, 201, JSON.stringify(instance.data));
  assert.deepEqual(instance.data.content, source.content);
});

test('project-scoped keys follow the current project of the excerpt source', async t => {
  const f = await fixture(t);
  const source = await f.create('발췌 소유 문서', body(excerpt(paragraph('합성 발췌'))));
  const host = await f.create('같은 공간의 포함', body(include(source.id)));
  const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '발췌 확인 키', access: 'write', projectIds: ['project-neo'] });
  assert.equal(key.status, 201, JSON.stringify(key.data));
  const token = key.data.token;
  const path = `/v1/documents/${host.id}`;
  assert.equal((await f.call(path, 'GET', undefined, token)).status, 200);
  assert.equal((await f.call<DocRevision[]>(`${path}/revisions`, 'GET', undefined, token)).data.length, 1);
  const moved = await f.call(`/documents/${source.id}`, 'PATCH', { projectId: 'project-team', expectedVersion: source.version });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal((await f.call(path, 'GET', undefined, token)).status, 403);
  assert.equal((await f.call(path, 'PATCH', { expectedVersion: host.version, title: '범위 밖 포함' }, token)).status, 403);
  assert.deepEqual((await f.call<DocRevision[]>(`${path}/revisions`, 'GET', undefined, token)).data, []);
  const rejected = await f.call('/v1/documents', 'POST', { title: '범위 밖 자료', projectId: 'project-neo', content: body(include(source.id)) }, token);
  assert.equal(rejected.status, 403);
});
