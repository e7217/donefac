import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import {
  documentLabelKey, documentSearchText, MAX_DOCUMENT_LABEL_LENGTH, MAX_DOCUMENT_LABELS,
  normalizeDocumentLabel, normalizeDocumentLabelKey, normalizeDocumentLabels,
} from '../../shared/document-labels.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, DocPage, DocRevision, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-document-labels-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  return async <T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, token?: string, actorId = 'user-min') => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Actor-Id': actorId });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const result = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await result.text();
    assert.equal(result.status, status, `${method} ${path}: ${json}`);
    return JSON.parse(json) as T;
  };
}

const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('document save replays its original version after a later collaborator edit', async t => {
  const call = await fixture(t);
  const created = await call<DocPage>('/documents', 'POST', { title: '합성 문서 저장', projectId: 'project-neo', content: content('처음 본문') }, 201);
  const path = `/documents/${created.id}`;
  const current = async () => {
    const page = (await call<WorkspaceSnapshot>('/workspace')).documents.find(document => document.id === created.id);
    assert.ok(page);
    return page;
  };
  const { restoreGeneration } = await call<WorkspaceSnapshot>('/workspace');
  assert.ok(restoreGeneration);
  const body = { requestId: randomUUID(), expectedRestoreGeneration: restoreGeneration, expectedVersion: created.version,
    title: '확인할 원래 저장 제목', labels: ['처음 라벨'], content: content('확인할 원래 저장 본문') };
  const saved = await call<DocPage>(path, 'PATCH', body);
  assert.deepEqual(await call<DocPage>(path, 'PATCH', body), saved);
  await call(path, 'PATCH', body, 409, undefined, 'user-seo');
  await call(path, 'PATCH', { ...body, title: '같은 요청의 다른 제목' }, 409);

  const peerSave = await call<DocPage>(path, 'PATCH', { expectedVersion: saved.version, title: '다른 작업자의 제목', labels: ['나중 라벨'] }, 200, undefined, 'user-seo');
  assert.deepEqual(await call<DocPage>(path, 'PATCH', body), saved);
  assert.deepEqual(await current(), peerSave);
  const history = await call<DocRevision[]>(`${path}/revisions`);
  assert.deepEqual(history.map(revision => revision.version), [peerSave.version, saved.version, created.version]);
  assert.equal(history.find(revision => revision.version === saved.version)?.authorId, 'user-min');

  const backup = await call('/export');
  await call('/import', 'POST', { data: backup });
  await call(path, 'PATCH', body, 409);
  const { restoreGeneration: nextGeneration } = await call<WorkspaceSnapshot>('/workspace');
  assert.ok(nextGeneration);
  assert.notEqual(nextGeneration, restoreGeneration);
  const restored = await current();
  await call(path, 'PATCH', { ...body, expectedRestoreGeneration: nextGeneration, expectedVersion: restored.version }, 409);
  assert.deepEqual(await current(), restored);
});

test('document labels normalize display values, deduplicate canonically and enforce input bounds', () => {
  assert.deepEqual(normalizeDocumentLabels([' zeta ', 'Cafe\u0301', 'CAFÉ', 'Alpha', 'ZETA', '한글']), ['Alpha', 'Café', 'zeta', '한글']);
  assert.equal(documentLabelKey('CAFE\u0301'), 'café');
  assert.equal(normalizeDocumentLabel('x'.repeat(MAX_DOCUMENT_LABEL_LENGTH)), 'x'.repeat(MAX_DOCUMENT_LABEL_LENGTH));
  assert.deepEqual(normalizeDocumentLabels(Array(MAX_DOCUMENT_LABELS).fill('same')), ['same']);
  assert.deepEqual(normalizeDocumentLabels([]), []);
  for (const value of [null, 'text', {}, [null], [' '], ['trailing\n'], ['a\u009f'], ['\ud800'], ['x'.repeat(MAX_DOCUMENT_LABEL_LENGTH + 1)], Array(MAX_DOCUMENT_LABELS + 1).fill('same'), Array(1)]) {
    assert.equal(normalizeDocumentLabels(value), null);
  }
  const expandedKey = documentLabelKey('İ'.repeat(MAX_DOCUMENT_LABEL_LENGTH));
  assert.equal(expandedKey.length, MAX_DOCUMENT_LABEL_LENGTH * 2);
  assert.equal(normalizeDocumentLabelKey(expandedKey), expandedKey);
  assert.equal(normalizeDocumentLabelKey(`${expandedKey}x`), null);
  assert.equal(normalizeDocumentLabelKey('Café\t'), null);
  assert.equal(documentSearchText({ title: ' A ', plainText: 'B', labels: ['CAFE\u0301'] }), ' a  b café');
});

test('document label edits respect version checks, scoped API access, search and historical restore', async t => {
  const call = await fixture(t);
  const projectId = 'project-neo';
  const { token } = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '문서 라벨 테스트 키', access: 'write', projectIds: [projectId], expiresAt: null }, 201);
  const document = await call<DocPage>('/v1/documents', 'POST', {
    projectId, title: '합성 설계 문서', content: content('원래 본문'), labels: [' Zeta ', 'Cafe\u0301 설계', 'CAFÉ 설계'],
  }, 201, token);
  assert.deepEqual(document.labels, ['Café 설계', 'Zeta']);
  const path = `/documents/${document.id}`;
  const [original] = await call<DocRevision[]>(`${path}/revisions`);
  assert.equal(Object.hasOwn(original, 'labels'), false);
  const renamed = await call<DocPage>(path, 'PATCH', { expectedVersion: document.version, title: '수정 제목', content: content('수정 본문') });
  assert.deepEqual(renamed.labels, document.labels);
  await call(`/v1${path}`, 'PATCH', { expectedVersion: document.version, labels: [] }, 409, token);
  await call(`/v1${path}`, 'PATCH', { expectedVersion: renamed.version, labels: null }, 400, token);
  await call('/documents', 'POST', { title: '잘못된 라벨', labels: 'text' }, 400);
  assert.deepEqual(await call(`/v1${path}`, 'GET', undefined, 200, token), renamed);

  const relabeled = await call<DocPage>(`/v1${path}`, 'PATCH', { expectedVersion: renamed.version, labels: [' Cafe\u0301 검토 '] }, 200, token);
  assert.deepEqual(relabeled.labels, ['Café 검토']);
  assert.deepEqual(relabeled.content, renamed.content);
  const outside = await call<DocPage>('/documents', 'POST', { projectId: 'project-team', title: '범위 밖 문서', labels: ['Café 검토'] }, 201);
  await call(`/v1/documents/${outside.id}`, 'PATCH', { expectedVersion: outside.version, labels: [] }, 403, token);
  const scoped = await call<DocPage[]>('/v1/documents', 'GET', undefined, 200, token);
  assert.deepEqual(scoped.find(row => row.id === relabeled.id)?.labels, relabeled.labels);
  assert.ok(!scoped.some(row => row.id === outside.id));
  const query = `/search?${new URLSearchParams({ q: '  CAFE\u0301 검토  ' })}`;
  const matches = await call<{ documents: DocPage[] }>(query);
  assert.deepEqual(new Set(matches.documents.map(row => row.id)), new Set([document.id, outside.id]));

  const restored = await call<DocPage>(`${path}/restore`, 'POST', { expectedVersion: relabeled.version, revisionId: original.id });
  assert.deepEqual(restored.labels, relabeled.labels);
  assert.deepEqual(restored.content, original.content);
  const cleared = await call<DocPage>(path, 'PATCH', { expectedVersion: restored.version, labels: [] });
  assert.equal(Object.hasOwn(cleared, 'labels'), false);
  assert.deepEqual((await call<{ documents: DocPage[] }>(query)).documents.map(row => row.id), [outside.id]);
});

test('native backup v58 validates active and archived document labels and accepts label-free v57 backups', async t => {
  const call = await fixture(t);
  type Backup = WorkspaceSnapshot & { schemaVersion: number; trashEntries: { id: string; resource: DocPage }[] };
  const live = await call<DocPage>('/documents', 'POST', { title: '사용 중인 문서', labels: [' Active '] }, 201);
  const archived = await call<DocPage>('/documents', 'POST', { title: '보관 문서', labels: ['Archived'] }, 201);
  const { trashEntryId } = await call<{ trashEntryId: string }>(`/documents/${archived.id}?expectedVersion=${archived.version}`, 'DELETE');
  const backup = await call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const activeDocument = (data: Backup) => data.documents.find(row => row.id === live.id)!;
  const archivedDocument = (data: Backup) => data.trashEntries.find(row => row.id === trashEntryId)!.resource;
  assert.deepEqual(activeDocument(backup).labels, ['Active']);
  assert.deepEqual(archivedDocument(backup).labels, ['Archived']);

  for (const select of [activeDocument, archivedDocument]) {
    const invalid = structuredClone(backup);
    select(invalid).labels = ['line\nbreak'];
    const malformed = await call<{ error: string }>('/import', 'POST', { data: invalid }, 400);
    assert.match(malformed.error, /문서 라벨/);
  }
  const legacy = structuredClone(backup);
  legacy.schemaVersion = 57;
  let rejected = await call<{ error: string }>('/import', 'POST', { data: legacy }, 400);
  assert.match(rejected.error, /schemaVersion 58/);
  delete activeDocument(legacy).labels;
  rejected = await call<{ error: string }>('/import', 'POST', { data: legacy }, 400);
  assert.match(rejected.error, /schemaVersion 58/);
  const preserved = await call<Backup>('/export');
  assert.deepEqual(activeDocument(preserved), activeDocument(backup));
  assert.deepEqual(archivedDocument(preserved), archivedDocument(backup));
  delete archivedDocument(legacy).labels;
  await call('/import', 'POST', { data: legacy });
  const compatibility = await call<Backup>('/export');
  assert.equal(Object.hasOwn(activeDocument(compatibility), 'labels'), false);
  assert.equal(Object.hasOwn(archivedDocument(compatibility), 'labels'), false);

  activeDocument(backup).labels = [' Active ', 'ACTIVE'];
  archivedDocument(backup).labels = [' Archived ', 'ARCHIVED'];
  await call('/import', 'POST', { data: { ...backup, schemaVersion: 58 } });
  await call(`/trash/${trashEntryId}/restore`, 'POST');
  const current = (await call<WorkspaceSnapshot>('/workspace')).documents;
  assert.deepEqual(current.find(row => row.id === live.id)?.labels, ['Active']);
  assert.deepEqual(current.find(row => row.id === archived.id)?.labels, ['Archived']);
});
