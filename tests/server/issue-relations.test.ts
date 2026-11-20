import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, Issue, IssueRelation, WorkspaceSnapshot } from '../../shared/types.js';

const actor = 'user-seo';
const otherActor = 'user-min';
const primary = 'project-neo';
const secondary = 'project-team';
const pathFor = (issueId: string) => `/issues/${issueId}/relations`;
const child = (issueId: string, relationId: string) => `${pathFor(issueId)}/${relationId}`;
const erase = (issueId: string, relation: IssueRelation) => `${child(issueId, relation.id)}?expectedVersion=${relation.version}`;
const add = (otherIssueId: string, type = 'related', direction = 'outgoing') => ({ otherIssueId, type, direction });
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  issueRelations: IssueRelation[];
  trashEntries: { id: string; issueRelations: IssueRelation[] }[];
};
type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-relations-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, headers }: RequestOptions = {}) {
    const result = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: await result.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, status = 200) {
    const result = await request<T>(path, options);
    assert.equal(result.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  async function create(title: string, projectId = primary) {
    return call<Issue>('/issues', { method: 'POST', body: { projectId, title, startDate: '2026-11-20', endDate: '2026-11-24' } }, 201);
  }
  async function key(name: string, projectIds: string[], access: 'read' | 'write') {
    const result = await call<ApiKeyCreated>('/api-keys', { method: 'POST', body: { name, access, projectIds } }, 201);
    return { Authorization: `Bearer ${result.token}`, 'X-Actor-Id': otherActor };
  }
  return { call, request, create, key, directory };
}

test('team issue links are symmetric or directional as requested, idempotent, versioned and atomic', async t => {
  const f = await fixture(t);
  const a = await f.create('선행 검증 업무');
  const b = await f.create('연결할 다른 프로젝트 업무', secondary);
  const c = await f.create('관계에 없는 업무');
  const initial = await f.call<WorkspaceSnapshot>('/workspace');
  await f.call(pathFor(a.id), { method: 'POST', body: add(a.id) }, 400);
  await f.call(pathFor(a.id), { method: 'POST', body: add(b.id, 'FS') }, 400);
  await f.call(pathFor(a.id), { method: 'POST', body: add(b.id, 'blocks', 'sideways') }, 400);
  await f.call(pathFor(a.id), { method: 'POST', body: add('missing-issue') }, 404);

  const sql = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    const lastEndpoint = [a.id, b.id].sort()[1];
    sql.exec(`CREATE TRIGGER fail_issue_relation_activity BEFORE INSERT ON activities
      WHEN json_extract(NEW.json, '$.resourceId')='${lastEndpoint}'
      BEGIN SELECT RAISE(ABORT, 'synthetic issue relation activity failure'); END`);
    await f.call(pathFor(a.id), { method: 'POST', body: add(b.id) }, 500);
    assert.deepEqual(await f.call<IssueRelation[]>(pathFor(a.id)), []);
    assert.deepEqual(await f.call<WorkspaceSnapshot>('/workspace'), initial);
  } finally {
    sql.exec('DROP TRIGGER IF EXISTS fail_issue_relation_activity');
    sql.close();
  }

  const sameLink = await Promise.all([
    f.request<IssueRelation>(pathFor(a.id), { method: 'POST', body: add(b.id) }),
    f.request<IssueRelation>(pathFor(b.id), { method: 'POST', body: add(a.id, 'related', 'incoming') }),
  ]);
  assert.deepEqual(sameLink.map(result => result.status).sort(), [200, 201]);
  const relation = sameLink[0].data;
  assert.deepEqual(sameLink[1].data, relation);
  assert.equal(relation.origin, 'teamspace');
  assert.equal(relation.type, 'related');
  assert.deepEqual([relation.sourceIssueId, relation.targetIssueId], [a.id, b.id].sort());
  assert.deepEqual(await f.call(pathFor(a.id)), [relation]);
  assert.deepEqual(await f.call(pathFor(b.id)), [relation]);
  await f.call(child(c.id, relation.id), { method: 'PATCH', body: { expectedVersion: relation.version, type: 'blocks', direction: 'incoming' } }, 404);

  const editPath = child(a.id, relation.id);
  const edit = { method: 'PATCH', body: { expectedVersion: relation.version, type: 'blocks', direction: 'incoming' } };
  const changed = await f.call<IssueRelation>(editPath, edit);
  assert.equal(changed.id, relation.id);
  assert.equal(changed.createdAt, relation.createdAt);
  assert.equal(changed.sourceIssueId, b.id);
  assert.equal(changed.targetIssueId, a.id);
  assert.equal(changed.type, 'blocks');
  assert.ok(changed.version > relation.version);
  const conflicting = await f.call<{ details: { currentVersion: number } }>(editPath, edit, 409);
  assert.equal(conflicting.details.currentVersion, changed.version);
  assert.deepEqual(await f.call(child(b.id, relation.id), { method: 'PATCH', body: {
    expectedVersion: changed.version, type: 'blocks', direction: 'outgoing',
  } }), changed);
  await f.call(erase(a.id, relation), { method: 'DELETE' }, 409);
  await f.call(child(a.id, relation.id), { method: 'DELETE' }, 400);

  const duplicate = await f.call<IssueRelation>(pathFor(a.id), { method: 'POST', body: add(b.id, 'duplicates', 'outgoing') }, 201);
  await f.call(editPath, { method: 'PATCH', body: { expectedVersion: changed.version, type: 'duplicates', direction: 'outgoing' } }, 409);
  assert.deepEqual(await f.call(pathFor(b.id)), [changed, duplicate]);
  await f.call(erase(b.id, changed), { method: 'DELETE' });
  assert.deepEqual(await f.call(pathFor(a.id)), [duplicate]);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues, initial.issues);
  assert.deepEqual(after.dependencies, initial.dependencies);
  const events = after.activities.filter(event => event.action.startsWith('업무 관계 '));
  assert.equal(events.length, 8);
  assert.ok(events.every(event => [a.id, b.id].includes(event.resourceId) && event.actorId === actor));
});

test('relation API keys can only read or edit edges whose two endpoints are in scope', async t => {
  const f = await fixture(t);
  const a = await f.create('자동화 업무 A');
  const b = await f.create('자동화 업무 B');
  const outside = await f.create('다른 범위 업무', secondary);
  const read = await f.key('관계 읽기', [primary], 'read');
  const narrow = await f.key('한 프로젝트 관계 쓰기', [primary], 'write');
  const wide = await f.key('두 프로젝트 관계 쓰기', [primary, secondary], 'write');
  const path = `/v1${pathFor(a.id)}`;
  await f.call(path, { method: 'POST', body: add(b.id), headers: read }, 403);
  await f.call(path, { method: 'POST', body: add(outside.id), headers: narrow }, 403);
  const local = await f.call<IssueRelation>(path, { method: 'POST', body: { ...add(b.id), actorId: otherActor }, headers: narrow }, 201);
  const cross = await f.call<IssueRelation>(path, { method: 'POST', body: add(outside.id, 'blocks'), headers: wide }, 201);
  assert.deepEqual(await f.call(path, { headers: read }), [local]);
  assert.deepEqual(await f.call(path, { headers: wide }), [local, cross]);
  await f.call(`/v1${pathFor(outside.id)}`, { headers: narrow }, 403);
  await f.call(`/v1${child(a.id, cross.id)}`, { method: 'PATCH', headers: narrow, body: {
    expectedVersion: cross.version, type: 'duplicates', direction: 'incoming',
  } }, 403);
  await f.call(`/v1${erase(a.id, cross)}`, { method: 'DELETE', headers: narrow }, 403);
  await f.call(`/v1${erase(a.id, local)}`, { method: 'DELETE', headers: read }, 403);
  const update = await f.call<IssueRelation>(`/v1${child(outside.id, cross.id)}`, { method: 'PATCH', headers: wide, body: {
    expectedVersion: cross.version, type: 'duplicates', direction: 'outgoing',
  } });
  assert.deepEqual([update.sourceIssueId, update.targetIssueId], [outside.id, a.id]);
  assert.deepEqual(await f.call(`/v1${erase(outside.id, update)}`, { method: 'DELETE', headers: wide }), { ok: true });
  assert.deepEqual(await f.call(path, { headers: wide }), [local]);
  const events = (await f.call<WorkspaceSnapshot>('/workspace')).activities.filter(event => event.action.startsWith('업무 관계 '));
  assert.ok(events.length && events.every(event => event.actorId === actor));
});

test('restore preserves legacy labels and advances active and archived team links past stale versions', async t => {
  const f = await fixture(t);
  const a = await f.create('복원할 관계의 한쪽 업무');
  const b = await f.create('복원할 관계의 상대 업무', secondary);
  const backup = () => f.call<Backup>('/export');
  const restore = (data: Backup, status = 200) => f.call<{ error?: string }>('/import', { method: 'POST', body: { data } }, status);
  const migrated: IssueRelation = { id: randomUUID(), sourceIssueId: a.id, targetIssueId: b.id, type: '원본 Jira 링크 타입', version: 1, createdAt: new Date().toISOString() };
  await restore({ ...await backup(), schemaVersion: 50, issueRelations: [migrated] });
  assert.deepEqual(await f.call(pathFor(b.id)), [migrated]);
  await f.call(erase(b.id, migrated), { method: 'DELETE' }, 409);
  await f.call(child(a.id, migrated.id), { method: 'PATCH', body: { expectedVersion: 1, type: 'related', direction: 'outgoing' } }, 409);

  const original = await f.call<IssueRelation>(pathFor(a.id), { method: 'POST', body: add(b.id) }, 201);
  const active = await backup();
  assert.equal(active.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.match((await restore({ ...active, schemaVersion: 50 }, 400)).error!, /schemaVersion 51/);
  const duplicated = structuredClone(active);
  duplicated.issueRelations.push({ ...original, id: randomUUID() });
  await restore(duplicated, 400);
  const backwards = structuredClone(active);
  const wrong = backwards.issueRelations.find(value => value.id === original.id)!;
  [wrong.sourceIssueId, wrong.targetIssueId] = [wrong.targetIssueId, wrong.sourceIssueId];
  await restore(backwards, 400);

  const modified = await f.call<IssueRelation>(child(a.id, original.id), { method: 'PATCH', body: {
    expectedVersion: original.version, type: 'duplicates', direction: 'outgoing',
  } });
  await f.call(erase(a.id, modified), { method: 'DELETE' });
  await restore(active);
  const afterImport = (await f.call<IssueRelation[]>(pathFor(a.id))).find(value => value.id === original.id)!;
  assert.equal(afterImport.type, 'related');
  assert.ok(afterImport.version > modified.version);
  await f.call(erase(a.id, modified), { method: 'DELETE' }, 409);

  const trashed = async (id: string) => {
    const live = (await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === id);
    assert.ok(live);
    return f.call<{ trashEntryId: string }>(`/issues/${id}`, { method: 'DELETE', body: { expectedVersion: live.version } });
  };
  const first = await trashed(a.id);
  const second = await trashed(b.id);
  const archived = await backup();
  assert.deepEqual(archived.issueRelations.filter(value => [migrated.id, original.id].includes(value.id)), []);
  assert.equal(archived.trashEntries.flatMap(entry => entry.issueRelations).filter(value => value.id === original.id).length, 1);
  assert.match((await restore({ ...archived, schemaVersion: 50 }, 400)).error!, /schemaVersion 51/);
  await restore(archived);
  await f.call(`/trash/${first.trashEntryId}/restore`, { method: 'POST', body: {} });
  assert.deepEqual(await f.call(pathFor(a.id)), []);
  await f.call(`/trash/${second.trashEntryId}/restore`, { method: 'POST', body: {} });
  const afterTrash = await f.call<IssueRelation[]>(pathFor(a.id));
  assert.deepEqual(afterTrash.find(value => value.id === migrated.id), migrated);
  const restored = afterTrash.find(value => value.id === original.id)!;
  assert.deepEqual({ ...restored, version: original.version }, original);
  assert.ok(restored.version > afterImport.version);
  await f.call(erase(b.id, afterImport), { method: 'DELETE' }, 409);
  await f.call(erase(b.id, restored), { method: 'DELETE' });
  assert.deepEqual(await f.call(pathFor(a.id)), [migrated]);
});
