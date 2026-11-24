import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { createApp } from '../../server/app.js';
import { includeRevisionOwner, registerDocumentIncludeRevisionRoutes } from '../../server/document-include-revisions.js';
import { Store } from '../../server/store.js';
import { TrashService } from '../../server/trash.js';
import type { DocPage, DocRevision } from '../../shared/types.js';

const owner = { id: 'document-author', name: '저장본 작성자', email: 'pinned-author@example.test', color: '#102030' };
const stamp = '2026-11-19T10:00:00.000Z';
const firstPage = '/api/documents/source/include-revisions';
type SummaryPage = { items: Pick<DocRevision, 'id' | 'version' | 'title' | 'createdAt'>[]; nextOffset: number | null };

function body(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function document(id: string): DocPage {
  return { id, projectId: null, parentId: null, version: 29, title: '현재 제목', status: 'draft', icon: '📄',
    content: body('현재 본문'), plainText: '현재 본문', authorId: owner.id, createdAt: stamp, updatedAt: stamp };
}

function version(id: string, number: number, documentId = 'source'): DocRevision {
  return { id, documentId, version: number, title: `저장본 ${number}`, content: body(`본문 ${number}`), plainText: `본문 ${number}`,
    authorId: owner.id, createdAt: stamp, summary: '저장본 확인' };
}

test('revision selection pages contain only summaries and exact reads follow trash lifecycle', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'teamspace-include-revisions-'));
  const store = new Store(scratch);
  const app = express();
  registerDocumentIncludeRevisionRoutes(app, store);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      store.db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function get<T = unknown>(path: string, status = 200) {
    const result = await fetch(baseUrl + path);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.status, status, path);
    return result.json() as Promise<T>;
  }

  store.put('users', owner);
  store.put('documents', document('source'));
  store.put('documents', document('other'));
  for (let number = 1; number <= 27; number++) store.put('revisions', version(`saved-${number}`, number));
  const lastOfFirst = version('same-version', 3);
  store.put('revisions', lastOfFirst);
  const foreign = version('foreign', 100, 'other');
  store.put('revisions', foreign);
  const oldest = version('saved-1', 1);
  assert.equal(includeRevisionOwner(store, oldest.id), 'source');
  assert.equal(includeRevisionOwner(store, foreign.id), 'other');
  assert.equal(includeRevisionOwner(store, 'missing'), undefined);
  const first = await get<SummaryPage>(firstPage);
  assert.equal(first.items.length, 25);
  assert.equal(first.nextOffset, 25);
  assert.deepEqual(first.items[0], { id: 'saved-27', version: 27, title: '저장본 27', createdAt: stamp });
  assert.equal(first.items.at(-1)?.id, 'same-version');
  const second = await get<SummaryPage>(`${firstPage}?offset=25`);
  assert.deepEqual(second.items.map(item => item.id), ['saved-3', 'saved-2', 'saved-1']);
  assert.equal(second.nextOffset, null);
  for (const query of ['offset=-1', 'offset=0&offset=1', 'limit=3']) await get(`${firstPage}?${query}`, 400);
  await get(`${firstPage}/missing`, 404);
  await get(`${firstPage}/${foreign.id}`, 404);
  assert.deepEqual(await get(`${firstPage}/${oldest.id}`), oldest);

  new TrashService(store);
  store.transaction(() => {
    store.db.prepare(`INSERT INTO trash_entries (id,resource_type,resource_id,deleted_at,json,summary)
      VALUES(?,?,?,?,?,?)`).run('archive-source', 'document', 'source', stamp, JSON.stringify({ revisions: [oldest] }), '{}');
    store.remove('documents', 'source');
  });
  await get(firstPage, 404);
  await get(`/api/documents/other/include-revisions/${oldest.id}`, 404);
  assert.equal(includeRevisionOwner(store, oldest.id), 'source');
  assert.deepEqual(await get(`${firstPage}/${oldest.id}`), oldest);
  store.remove('trash_entries', 'archive-source');
  assert.equal(includeRevisionOwner(store, oldest.id), undefined);
  await get(`${firstPage}/${oldest.id}`, 404);
});

test('version-specific links download the saved file through trash and backup without sharing archived files across documents', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'teamspace-revision-files-'));
  const runtime = createApp({ dataDir: scratch, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { runtime.close(); rmSync(scratch, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const actor = { 'X-Actor-Id': 'user-min' };
  async function json<T>(path: string, method = 'GET', data?: unknown, status = 200) {
    const response = await fetch(base + path, { method, headers: { ...actor, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json() as T;
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  type VersionHead = { id: string; currentVersionId: string };
  async function upload(path: string, bytes: Uint8Array<ArrayBuffer>) {
    const response = await fetch(base + path, { method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(response.status, 201);
    return response.json() as Promise<VersionHead>;
  }
  const create = (title: string) => json<DocPage>('/documents', 'POST', { title, projectId: null, content: body('처음 저장') }, 201);
  const source = await create('첨부파일 원문'), other = await create('다른 첨부파일 참조');
  const original = await upload(`/attachments?resourceType=document&resourceId=${source.id}&filename=guide.txt`, Uint8Array.of(1, 2, 3));
  const savedBytes = Uint8Array.of(0, 25, 89, 255);
  const selected = await upload(`/attachments/${original.id}/versions?expectedVersionId=${original.id}&filename=guide-reviewed.pdf`, savedBytes);
  const fileId = selected.currentVersionId;
  assert.notEqual(fileId, original.id);
  const update = async (page: DocPage, href: string) => json<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: page.version,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '검토할 안내서',
      marks: [{ type: 'link', attrs: { href } }] }] }] } });
  await update(source, `/api/attachments/${fileId}/content`);
  await update(other, `/api/attachment-versions/${fileId}/download`);
  const [sourceRevision, unreferenced] = await json<DocRevision[]>(`/documents/${source.id}/revisions`);
  const [otherRevision] = await json<DocRevision[]>(`/documents/${other.id}/revisions`);
  const fixed = (doc: string, revision: string, id = fileId, kind = 'files') => `/documents/${doc}/include-revisions/${revision}/${kind}/${id}`;
  const sourceDownload = fixed(source.id, sourceRevision.id), otherDownload = fixed(other.id, otherRevision.id);
  async function verifyBytes(path: string) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; .+guide-reviewed\.pdf$/u);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
  }
  await verifyBytes(sourceDownload);
  await verifyBytes(otherDownload);
  for (const path of [fixed(source.id, unreferenced.id), fixed(other.id, sourceRevision.id),
    fixed(source.id, sourceRevision.id, original.id), fixed(source.id, sourceRevision.id, fileId, 'images')]) await json(path, 'GET', undefined, 404);
  await json(`${sourceDownload}?inline=1`, 'GET', undefined, 400);

  const latest = await upload(`/attachments/${original.id}/versions?expectedVersionId=${fileId}&filename=guide-next.pdf`, Uint8Array.of(4, 5, 6));
  await verifyBytes(sourceDownload);
  const { trashItemId } = await json<{ trashItemId: string }>(`/attachments/${original.id}?expectedVersionId=${latest.currentVersionId}`, 'DELETE');
  await json(`/attachments/${fileId}/content`, 'GET', undefined, 404);
  await verifyBytes(sourceDownload);
  await json(otherDownload, 'GET', undefined, 404);
  const backup = await json('/export');
  await json('/import', 'POST', { data: backup });
  await verifyBytes(sourceDownload);
  await json(otherDownload, 'GET', undefined, 404);

  await json(`/trash/items/${trashItemId}/restore`, 'POST', {});
  const { trashEntryId } = await json<{ trashEntryId: string }>(`/documents/${source.id}`, 'DELETE');
  await verifyBytes(sourceDownload);
  await json(otherDownload, 'GET', undefined, 404);
  await json(`/trash/${trashEntryId}`, 'DELETE');
  await json(sourceDownload, 'GET', undefined, 404);
});
