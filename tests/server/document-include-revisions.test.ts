import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
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
