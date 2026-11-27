import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, DocPage, Favorite, FavoriteRecord, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const first = 'user-min';
const second = 'user-seo';
const favoritePath = (type: Favorite['resourceType'], id: string) => `/favorites/${type}/${id}`;
type Backup = WorkspaceSnapshot & { schemaVersion: number; favorites?: FavoriteRecord[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-favorites-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { runtime, server, base: `http://127.0.0.1:${address.port}/api` };
  }
  let service = await start();
  async function stop() {
    await new Promise<void>(resolve => service.server.close(() => resolve()));
    service.runtime.close();
  }
  t.after(async () => {
    try { await stop(); } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = first, token?: string) {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, cacheControl: response.headers.get('cache-control'), data: await response.json() as T };
  }
  async function expectStatus<T = unknown>(status: number, path: string, method = 'GET', body?: unknown, actor = first, token?: string) {
    const response = await call<T>(path, method, body, actor, token);
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const issue = (title: string) => expectStatus<Issue>(201, '/issues', 'POST', { projectId: 'project-neo', title });
  const document = (title: string) => expectStatus<DocPage>(201, '/documents', 'POST', { projectId: null, title });
  const list = (actor = first) => expectStatus<Favorite[]>(200, '/favorites', 'GET', undefined, actor);
  const mark = (path: string, actor = first) => expectStatus<Favorite>(200, path, 'PUT', {}, actor);
  const exportWorkspace = () => expectStatus<Backup>(200, '/export');
  const archive = (type: Favorite['resourceType'], id: string) =>
    expectStatus<{ trashEntryId: string }>(200, `/${type === 'issue' ? 'issues' : 'documents'}/${id}`, 'DELETE');
  const restore = (entry: string) => expectStatus(200, `/trash/${entry}/restore`, 'POST', {});
  return { call, expectStatus, issue, document, list, mark, exportWorkspace, archive, restore,
    async restart() { await stop(); service = await start(); },
  };
}

test('favorite changes affect only the chosen actor and repeated calls keep the same record across restart', async t => {
  const f = await fixture(t);
  const issue = await f.issue('즐겨찾기 검증 업무');
  const document = await f.document('즐겨찾기 검증 공통 문서');
  const issuePath = favoritePath('issue', issue.id), docPath = favoritePath('document', document.id);
  const { token } = await f.expectStatus<ApiKeyCreated>(201, '/api-keys', 'POST', { name: '합성 자동화 키', access: 'write', projectIds: null });
  const before = await f.expectStatus<WorkspaceSnapshot>(200, '/workspace');
  assert.deepEqual(await f.call('/favorites'), { status: 200, cacheControl: 'no-store', data: [] });
  await f.expectStatus(400, '/favorites', 'GET', undefined, 'missing-user');
  await f.expectStatus(400, '/favorites', 'GET', undefined, '');
  await f.expectStatus(400, `/favorites?userId=${second}`);
  await f.expectStatus(400, issuePath, 'PUT', { userId: second });
  await f.expectStatus(400, issuePath, 'DELETE', { actorId: second });
  await f.expectStatus(400, `/favorites/project/${issue.projectId}`, 'PUT', {});
  await f.expectStatus(404, favoritePath('document', issue.id), 'PUT', {});
  await f.expectStatus(403, '/v1/favorites', 'GET', undefined, first, token);
  await f.expectStatus(403, `/v1${issuePath}`, 'PUT', {}, first, token);
  await f.expectStatus(403, `/v1${issuePath}`, 'DELETE', undefined, first, token);

  const marked = await f.call<Favorite>(issuePath, 'PUT', {});
  assert.equal(marked.status, 200);
  assert.equal(marked.cacheControl, 'no-store');
  assert.deepEqual(marked.data, { resourceType: 'issue', resourceId: issue.id, createdAt: marked.data.createdAt });
  assert.equal(new Date(marked.data.createdAt).toISOString(), marked.data.createdAt);
  assert.deepEqual(await f.list(second), []);
  await f.restart();
  assert.deepEqual(await f.mark(issuePath), marked.data);
  const documentFavorite = await f.mark(docPath);
  const anotherFavorite = await f.mark(issuePath, second);
  assert.deepEqual(await f.list(), [documentFavorite, marked.data]);
  assert.deepEqual(await f.list(second), [anotherFavorite]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await f.call(issuePath, 'DELETE');
    assert.deepEqual(removed, { status: 200, cacheControl: 'no-store', data: { ok: true } });
  }
  assert.deepEqual(await f.list(), [documentFavorite]);
  assert.deepEqual(await f.list(second), [anotherFavorite]);
  assert.deepEqual(await f.expectStatus<WorkspaceSnapshot>(200, '/workspace'), before);
});

test('favorite records are hidden through trash, restored for every user, then purged with permanent deletion', async t => {
  const f = await fixture(t);
  const issue = await f.issue('휴지통에서 복원할 즐겨찾기 업무');
  const doc = await f.document('휴지통에서 복원할 즐겨찾기 문서');
  const issuePath = favoritePath('issue', issue.id), docPath = favoritePath('document', doc.id);
  const issueFavorite = await f.mark(issuePath), docFavorite = await f.mark(docPath), shared = await f.mark(issuePath, second);
  const { trashEntryId: issueEntry } = await f.archive('issue', issue.id);
  const { trashEntryId: docEntry } = await f.archive('document', doc.id);
  assert.deepEqual(await f.list(), []);
  assert.deepEqual(await f.list(second), []);
  for (const path of [issuePath, docPath]) {
    await f.expectStatus(404, path, 'PUT', {});
    await f.expectStatus(404, path, 'DELETE');
  }
  assert.equal((await f.exportWorkspace()).favorites?.length, 3);
  await f.restore(docEntry);
  assert.deepEqual(await f.list(), [docFavorite]);
  await f.restore(issueEntry);
  const live = await f.list();
  assert.deepEqual(new Map(live.map(item => [item.resourceType, item])), new Map([['issue', issueFavorite], ['document', docFavorite]]));
  assert.deepEqual(await f.list(second), [shared]);

  for (const [type, id] of [['issue', issue.id], ['document', doc.id]] as const) {
    const { trashEntryId } = await f.archive(type, id);
    await f.expectStatus(200, `/trash/${trashEntryId}`, 'DELETE');
    await f.expectStatus(404, favoritePath(type, id), 'PUT', {});
  }
  assert.deepEqual(await f.list(), []);
  assert.deepEqual(await f.list(second), []);
  assert.deepEqual((await f.exportWorkspace()).favorites, []);
});

test('native format 94 restores live and archived actor favorites and rejects invalid rows atomically', async t => {
  const f = await fixture(t);
  const issue = await f.issue('백업의 즐겨찾기 업무');
  const doc = await f.document('백업에서 휴지통에 있는 즐겨찾기 문서');
  const issuePath = favoritePath('issue', issue.id), docPath = favoritePath('document', doc.id);
  const active = await f.mark(issuePath), archived = await f.mark(docPath, second);
  const { trashEntryId } = await f.archive('document', doc.id);
  const backup = await f.exportWorkspace();
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const rows = backup.favorites;
  assert.ok(rows);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Map(rows.map(({ userId, ...favorite }) => [userId, favorite])), new Map([[first, active], [second, archived]]));

  const later = await f.issue('잘못된 가져오기에서 보존할 현재 업무');
  const laterFavorite = await f.mark(favoritePath('issue', later.id), second);
  const before = await f.exportWorkspace();
  const importWorkspace = (data: unknown, status = 200) => f.expectStatus<{ error?: string }>(status, '/import', 'POST', { data });
  const [row] = rows;
  for (const invalid of [[row, ...rows], [{ ...row, userId: 'missing-user' }], [{ ...row, resourceId: 'missing-resource' }],
    [{ ...row, resourceType: row.resourceType === 'issue' ? 'document' : 'issue' }], [{ ...row, createdAt: '2026-02-30' }],
    [{ ...row, unexpected: true }], { rows }]) {
    await importWorkspace({ ...backup, favorites: invalid }, 400);
    const current = await f.exportWorkspace();
    assert.deepEqual(current.favorites, before.favorites);
    assert.deepEqual(current.issues, before.issues);
    assert.deepEqual(await f.list(second), [laterFavorite]);
  }
  const downgraded = await importWorkspace({ ...backup, schemaVersion: 93 }, 400);
  assert.match(downgraded.error ?? '', /schemaVersion 94/u);

  await importWorkspace({ ...backup, schemaVersion: 93, favorites: undefined });
  assert.deepEqual(await f.list(), []);
  assert.deepEqual(await f.list(second), []);

  await importWorkspace({ ...backup, schemaVersion: 94 });
  assert.deepEqual(await f.list(), [active]);
  assert.deepEqual(await f.list(second), []);
  await f.restore(trashEntryId);
  assert.deepEqual(await f.list(second), [archived]);
});
