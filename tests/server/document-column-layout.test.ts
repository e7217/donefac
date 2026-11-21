import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { CollaborationExport } from '../../server/collaboration.js';
import { DocumentContentError, normalizeDocumentContent } from '../../server/document-content.js';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration.js';
import { contentReferences, DOCUMENT_CONTENT_SCHEMA_VERSION, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { DocPage, DocRevision, DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const column = (...content: RichContent[]): RichContent => ({ type: 'documentColumn', content });
const layout = (weights: number[], border: boolean, ...content: RichContent[]): RichContent => ({
  type: 'documentColumnLayout', attrs: { weights, border }, content,
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-column-layout-'));
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
  async function call<T = unknown>(path: string, method = 'GET', payload?: unknown) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-min' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function create(title: string, content: RichContent) {
    const response = await call<DocPage>('/documents', 'POST', { title, content, projectId: 'project-neo' });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async function enable(document: DocPage) {
    const response = await call<CollaborationSession>(`/documents/${document.id}/collaboration/enable`, 'POST', { expectedVersion: document.version });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.ok(response.data.epoch);
    return response.data;
  }
  return { call, create, enable };
}

test('document column layout keeps ordered content and references and rejects malformed width or node placement', () => {
  const heading: RichContent = {
    type: 'heading', attrs: { level: 2, sectionId: 'left-column' },
    content: [{ type: 'text', text: '첫 번째 열', marks: [{ type: 'bold' }] }],
  };
  const reference: RichContent = { type: 'documentReference', attrs: { documentId: 'target', label: '원본 연결' } };
  const validLayout = layout([300, 700], true,
    column(heading, reference), column(layout([1], false, column(paragraph('안쪽 열'))), paragraph('마지막 블록')));
  const original = body(paragraph('위쪽 본문'), validLayout, paragraph('아래쪽 본문'));
  const normalized = normalizeDocumentContent(original);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.content)), original);
  assert.equal(documentContentSchemaVersion(normalized.content), DOCUMENT_CONTENT_SCHEMA_VERSION);
  assert.equal(normalized.plainText, '위쪽 본문\n첫 번째 열\n[문서: 원본 연결 (target)]\n안쪽 열\n마지막 블록\n아래쪽 본문');
  assert.deepEqual(contentReferences(normalized.content), [{ type: 'document', id: 'target', kind: 'reference', label: '원본 연결' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeDocumentContent(body({ ...validLayout, attrs: { weights: [300, 700] } })).content)),
    body({ ...validLayout, attrs: { ...validLayout.attrs, border: false } }));

  const invalidLayouts = [
    { ...validLayout, attrs: undefined },
    { ...validLayout, attrs: { weights: [1], border: true } },
    { ...validLayout, attrs: { weights: [1, 2], border: 'true' } },
    { ...validLayout, attrs: { weights: [1, 2], border: null } },
    { ...validLayout, attrs: { weights: [1, 2], style: '--document-column-tracks:1fr' } },
    ...[0, -1, 1.5, 1001, '1', null].map(weight => ({ ...validLayout, attrs: { weights: [1, weight] } })),
    { ...validLayout, content: [] },
    layout([1, 1, 1, 1], false, ...Array.from({ length: 4 }, () => column(paragraph('열')))),
    layout([1], false, paragraph('레이아웃 안의 고립된 문단')),
    layout([1], false, { type: 'documentColumn', attrs: { width: 20 }, content: [paragraph('열')] }),
    layout([1], false, column()),
    column(paragraph('독립 열')),
  ];
  for (const invalid of invalidLayouts) {
    assert.throws(() => normalizeDocumentContent(body(invalid)), (error: unknown) =>
      error instanceof DocumentContentError && error.code === 'INVALID_SCHEMA' && error.status === 422, JSON.stringify(invalid));
  }
});

test('document columns survive REST updates, templates, trash and collaboration restore with version guards', async t => {
  const f = await fixture(t);
  const first = body(layout([1, 2], true, column(paragraph('첫 열의 첫 버전')), column(paragraph('둘째 열의 본문'))));
  const last = body(layout([1, 2], false, column(paragraph('첫 열의 개정본')), column(paragraph('둘째 열의 본문'))));
  const original = await f.create('다단 점검 문서', first);
  const path = `/documents/${original.id}`;
  const priorClient = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
    expectedVersion: original.version, contentSchemaVersion: 11, content: body(paragraph('구형 편집기의 본문')),
  });
  assert.equal(priorClient.status, 409, JSON.stringify(priorClient.data));
  assert.equal(priorClient.data.details.contentSchemaVersion, DOCUMENT_CONTENT_SCHEMA_VERSION);
  const changed = await f.call<DocPage>(path, 'PATCH', {
    expectedVersion: original.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: last,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data.content, last);
  const live = await f.enable(changed.data);
  const template = await f.call<DocumentTemplateSummary>('/document-templates', 'POST', {
    requestId: randomUUID(), sourceDocumentId: original.id, expectedDocumentVersion: live.document.version, name: '다단 점검 양식',
  });
  assert.equal(template.status, 201, JSON.stringify(template.data));

  const archive = await f.create('휴지통에 보낼 다단 문서', first);
  const archivedSession = await f.enable(archive);
  const removed = await f.call<{ trashEntryId: string }>(`/documents/${archive.id}`, 'DELETE');
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const preceding = await f.create('이전 공동 편집 형식', body({
    type: 'documentExcerpt', attrs: { hidden: false }, content: [paragraph('이전 발췌 내용')],
  }));
  const precedingSession = await f.enable(preceding);

  type Backup = WorkspaceSnapshot & {
    schemaVersion: number; collabStates: CollaborationExport[]; revisions: DocRevision[]; documentTemplates: unknown[];
  };
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.collabStates.some(status => status.documentId === original.id));
  const oldTemplate = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 78 } });
  assert.equal(oldTemplate.status, 400);
  assert.match(oldTemplate.data.error, /템플릿.*79/u);
  const oldBody = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 78, documentTemplates: [] } });
  assert.equal(oldBody.status, 400);
  assert.match(oldBody.data.error, /열 배치.*79/u);
  const oldTrash = await f.call<{ error: string }>('/import', 'POST', { data: {
    ...backup, schemaVersion: 78, documentTemplates: [], documents: backup.documents.filter(doc => doc.id !== original.id),
    revisions: backup.revisions.filter(revision => revision.documentId !== original.id),
    collabStates: backup.collabStates.filter(state => state.documentId !== original.id),
  } });
  assert.equal(oldTrash.status, 400);
  assert.match(oldTrash.data.error, /열 배치.*79/u);
  const wrongState = { ...backup, collabStates: backup.collabStates.map(state =>
    state.documentId === original.id ? { ...state, schemaVersion: 11 } : state) };
  assert.equal((await f.call('/import', 'POST', { data: wrongState })).status, 422);

  const accepted = { ...backup, collabStates: backup.collabStates.map(state =>
    state.documentId === preceding.id ? { ...state, schemaVersion: 11 } : state) };
  const restored = await f.call('/import', 'POST', { data: accepted });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const revived = await f.call(`/trash/${removed.data.trashEntryId}/restore`, 'POST');
  assert.equal(revived.status, 200, JSON.stringify(revived.data));
  for (const before of [live, archivedSession, precedingSession]) {
    const response = await f.call<CollaborationSession>(`/documents/${before.document.id}/collaboration`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.schemaVersion, COLLABORATION_SCHEMA);
    assert.notEqual(response.data.epoch, before.epoch);
    assert.deepEqual(response.data.document.content, before.document.content);
  }
  const revisions = (await f.call<DocRevision[]>(`${path}/revisions`)).data;
  assert.ok(revisions.some(revision => JSON.stringify(revision.content) === JSON.stringify(first)));
  assert.ok(revisions.some(revision => JSON.stringify(revision.content) === JSON.stringify(last)));
  const templates = await f.call<DocumentTemplateSummary[]>('/document-templates?projectId=project-neo');
  const restoredTemplate = templates.data.find(candidate => candidate.id === template.data.id);
  assert.ok(restoredTemplate);
  const copy = await f.call<DocPage>('/documents', 'POST', {
    requestId: randomUUID(), templateId: restoredTemplate.id, expectedTemplateVersion: restoredTemplate.version,
    title: '양식에서 만든 다단 문서', projectId: 'project-neo',
  });
  assert.equal(copy.status, 201, JSON.stringify(copy.data));
  assert.deepEqual(copy.data.content, last);
});
