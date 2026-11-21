import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, Comment, DocPage, DocumentSelectionCommentResult, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types.js';

const owner = 'user-seo';
const reviewer = 'user-min';
const projectId = 'project-neo';
const quote = '검토할 시험 조건';
const commentsPath = (id: string) => `/comments?resourceType=document&resourceId=${id}`;
const createPath = (id: string) => `/documents/${id}/selection-comments`;
const resolvePath = (comment: Comment) => `${createPath(comment.resourceId)}/${comment.id}/resolution`;

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  comments: Comment[];
  trashEntries: { comments: Comment[] }[];
  trashItems: { item: Comment }[];
};
type RequestOptions = { method?: string; body?: unknown; actor?: string | null; headers?: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-comment-resolution-'));
  async function start() {
    const app = createApp({ dataDir: directory, outboundWorker: false });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function close() {
    service.server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())); }
    finally { service.app.close(); }
  }
  t.after(async () => {
    try { await close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, actor = reviewer, headers }: RequestOptions = {}) {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, cache: response.headers.get('Cache-Control'), data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, status = 200) {
    const response = await request<T>(path, options);
    assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  async function createDoc(title: string) {
    return call<DocPage>('/documents', { method: 'POST', actor: owner, body: { title, projectId,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }] },
    } }, 201);
  }
  async function createComment(document: DocPage, body = '조건을 확인해 주세요.') {
    const input = { requestId: randomUUID(), expectedDocumentVersion: document.version,
      sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body,
    };
    const { comment } = await call<DocumentSelectionCommentResult>(createPath(document.id), { method: 'POST', body: input }, 201);
    return { comment, input };
  }
  const resolve = (comment: Comment, state: 'open' | 'resolved', expectedVersion: number, actor = reviewer) =>
    call<Comment>(resolvePath(comment), { method: 'PATCH', actor, body: { state, expectedVersion } });
  const restore = (backup: Backup, status = 200) => call<{ error?: string }>('/import', { method: 'POST', body: { data: backup } }, status);
  async function restart() { await close(); service = await start(); }
  return { request, call, createDoc, createComment, resolve, restore, restart };
}

test('document comment resolution is per selected comment, versioned, and independent of document edits and selection receipts', async t => {
  const f = await fixture(t);
  const document = await f.createDoc('시험 검토');
  const foreign = await f.createDoc('다른 시험 검토');
  const { comment, input } = await f.createComment(document);
  const ordinary = await f.call<Comment>('/comments', { method: 'POST', body: { resourceType: 'document', resourceId: document.id,
    body: '문서 전체 댓글', resolution: { state: 'resolved', version: 1 },
  } }, 201);
  assert.equal(comment.resolution, undefined);
  assert.equal(ordinary.resolution, undefined);
  const patch = { method: 'PATCH', body: { state: 'resolved', expectedVersion: 0 } };
  await f.call(resolvePath(comment), { ...patch, actor: null }, 400);
  await f.call(resolvePath(comment), { ...patch, actor: 'missing-user' }, 400);
  for (const body of [{}, { state: 'closed', expectedVersion: 0 }, { state: 'resolved', expectedVersion: -1 },
    { state: 'resolved', expectedVersion: '0' }, { state: 'resolved', expectedVersion: 0, actorId: owner }]) {
    await f.call(resolvePath(comment), { method: 'PATCH', body }, 400);
  }
  await f.call(resolvePath(ordinary), patch, 404);
  await f.call(`${createPath(foreign.id)}/${comment.id}/resolution`, patch, 404);
  const key = await f.call<ApiKeyCreated>('/api-keys', { method: 'POST', body: { name: '합성 문장 검토 연동', access: 'write', projectIds: [projectId] } }, 201);
  const headers = { Authorization: `Bearer ${key.token}` };
  await f.call(`/v1${resolvePath(comment)}`, { ...patch, headers }, 403);

  const editedDocument = await f.call<DocPage>(`/documents/${document.id}`, { method: 'PATCH', actor: owner,
    body: { title: '편집 후 시험 검토', expectedVersion: document.version },
  });
  const before = await f.call<WorkspaceSnapshot>('/workspace');
  const beforeNotices = await f.call<TeamNotificationPage>('/notifications', { actor: owner });
  assert.deepEqual(await f.resolve(comment, 'open', 0), comment);
  const clients = await Promise.all([owner, reviewer].map(actor => f.request<Comment>(resolvePath(comment), { ...patch, actor })));
  assert.deepEqual(clients.map(result => result.status).sort(), [200, 409]);
  const winner = clients.findIndex(result => result.status === 200);
  assert.equal(clients[winner].cache, 'no-store');
  const resolved = clients[winner].data;
  assert.deepEqual(resolved, { ...comment, resolution: {
    state: 'resolved', version: 1, actorId: [owner, reviewer][winner], changedAt: resolved.resolution?.changedAt,
  } });
  assert.ok(resolved.resolution?.changedAt);
  const changedTime = Date.parse(resolved.resolution.changedAt);
  assert.ok(changedTime >= Date.parse(comment.createdAt));
  assert.deepEqual((clients[1 - winner].data as unknown as { details: unknown }).details,
    { reason: 'resolution_version_changed', currentVersion: 1 });
  assert.deepEqual(await f.resolve(comment, 'resolved', 1), resolved);
  await f.call(resolvePath(comment), patch, 409);

  const reopened = await f.resolve(comment, 'open', 1, owner);
  assert.deepEqual(reopened, { ...comment, resolution: { state: 'open', version: 2, actorId: owner, changedAt: reopened.resolution?.changedAt } });
  assert.deepEqual(await f.call(createPath(document.id), { method: 'POST', body: input }), { comment: reopened, duplicate: true });
  await f.restart();
  assert.deepEqual(await f.call(`/v1${commentsPath(document.id)}`, { headers }), [reopened, ordinary]);
  assert.deepEqual(await f.call(commentsPath(document.id)), [reopened, ordinary]);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.documents.find(row => row.id === document.id), editedDocument);
  assert.deepEqual(after.activities, before.activities);
  assert.deepEqual(await f.call<TeamNotificationPage>('/notifications', { actor: owner }), beforeNotices);
});

test('backup validation and trash restore preserve real resolution metadata and keep older untouched comments open', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  const document = await source.createDoc('휴지통 문장 검토');
  const activeDoc = await source.createDoc('활성 문장 검토');
  const documentComment = (await source.createComment(document)).comment;
  const itemComment = (await source.createComment(document, '별도의 확인 사항')).comment;
  const activeComment = (await source.createComment(activeDoc)).comment;
  const ordinary = await source.call<Comment>('/comments', { method: 'POST', body: { resourceType: 'document', resourceId: activeDoc.id, body: '일반 댓글' } }, 201);
  const archivedWithDocument = await source.resolve(documentComment, 'resolved', 0);
  const archivedAsItem = await source.resolve(itemComment, 'resolved', 0, owner);
  const active = await source.resolve(activeComment, 'resolved', 0);
  const { trashItemId } = await source.call<{ trashItemId: string }>(`/comments/${itemComment.id}`, { method: 'DELETE' });
  const { trashEntryId } = await source.call<{ trashEntryId: string }>(`/documents/${document.id}`, { method: 'DELETE', body: { expectedVersion: document.version } });
  await source.call(resolvePath(itemComment), { method: 'PATCH', body: { state: 'open', expectedVersion: 1 } }, 404);
  await source.call(resolvePath(documentComment), { method: 'PATCH', body: { state: 'open', expectedVersion: 1 } }, 404);

  const backup = await source.call<Backup>('/export');
  assert.ok(backup.schemaVersion >= 73);
  assert.match((await target.restore({ ...backup, schemaVersion: 72 }, 400)).error ?? '', /schemaVersion 73/);
  const candidates = (data: Backup) => [data.comments.find(row => row.id === active.id)!,
    data.trashEntries.flatMap(entry => entry.comments).find(row => row.id === archivedWithDocument.id)!,
    data.trashItems.find(entry => entry.item.id === archivedAsItem.id)!.item];
  assert.deepEqual(candidates(backup), [active, archivedWithDocument, archivedAsItem]);
  for (const alter of [
    (comment: Comment) => { comment.resolution!.actorId = 'missing-user'; },
    (comment: Comment) => { comment.resolution!.version = 0; },
    (comment: Comment) => { comment.resolution!.changedAt = '2024-04-30'; },
    (comment: Comment) => { Object.assign(comment.resolution!, { state: 'pending' }); },
  ]) {
    for (const index of [0, 1, 2]) {
      const corrupt = structuredClone(backup);
      alter(candidates(corrupt)[index]);
      await target.restore(corrupt, 400);
    }
  }
  const notAnchored = structuredClone(backup);
  notAnchored.comments.find(row => row.id === ordinary.id)!.resolution = active.resolution;
  await target.restore(notAnchored, 400);

  const previous = structuredClone(backup);
  previous.schemaVersion = 72;
  for (const comment of candidates(previous)) delete comment.resolution;
  await target.restore(previous);
  assert.equal((await target.call<Comment[]>(commentsPath(activeDoc.id))).find(row => row.id === active.id)?.resolution, undefined);
  await target.restore(backup);
  await target.call(`/trash/${trashEntryId}/restore`, { method: 'POST', body: {} });
  await target.call(`/trash/items/${trashItemId}/restore`, { method: 'POST', body: {} });
  assert.deepEqual(await target.call(commentsPath(document.id)), [archivedWithDocument, archivedAsItem]);
  assert.deepEqual(await target.call(commentsPath(activeDoc.id)), [active, ordinary]);

  const reopened = await target.resolve(active, 'open', 1, owner);
  assert.equal(reopened.resolution?.version, 2);
  await target.restore(backup);
  const [restored] = await target.call<Comment[]>(commentsPath(activeDoc.id));
  assert.deepEqual(restored, { ...active, resolution: { ...active.resolution, version: 3 } });
  await target.call(resolvePath(active), { method: 'PATCH', body: { state: 'open', expectedVersion: 2 } }, 409);
  const fresh = await target.resolve(active, 'open', 3, owner);
  assert.equal(fresh.resolution?.version, 4);
});
