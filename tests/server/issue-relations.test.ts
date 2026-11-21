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
import type {
  ApiKeyCreated, Dependency, Issue, IssueChangeHistoryPage, IssueRelation, ProjectWorkflow, TeamScheduleBlocker, WorkspaceSnapshot,
} from '../../shared/types.js';

const actor = 'user-seo';
const otherActor = 'user-min';
const primary = 'project-neo';
const secondary = 'project-team';
const pathFor = (issueId: string) => `/issues/${issueId}/relations`;
const child = (issueId: string, relationId: string) => `${pathFor(issueId)}/${relationId}`;
const erase = (issueId: string, relation: IssueRelation) => `${child(issueId, relation.id)}?expectedVersion=${relation.version}`;
const add = (otherIssueId: string, type = 'related', direction = 'outgoing') => ({ otherIssueId, type, direction });
const schedulePath = (issueId: string, relation: IssueRelation) => `${child(issueId, relation.id)}/schedule-dependency`;
const scheduleBody = (relation: IssueRelation) => ({ expectedVersion: relation.version, predecessorId: relation.sourceIssueId,
  successorId: relation.targetIssueId, type: 'SS', lagDays: 2 });
const duplicatePath = (issueId: string) => `/issues/${issueId}/close-as-duplicate`;
const duplicateBody = (issue: Issue, original: Issue, workflow: ProjectWorkflow, status = 'done') => ({
  status, originalIssueId: original.id, expectedVersion: issue.version,
  expectedOriginalVersion: original.version, expectedWorkflowVersion: workflow.version,
});
type DuplicateClosure = { issue: Issue; relation: IssueRelation };
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
    return { status: result.status, headers: result.headers, data: await result.json() as T };
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

test('close as duplicate commits the selected terminal status, records actor history and reuses an existing original edge', async t => {
  const f = await fixture(t);
  const workflow = await f.call<ProjectWorkflow>(`/projects/${primary}/workflow`);
  const original = await f.create('원본으로 남길 다른 프로젝트 업무', secondary);
  const existingSource = await f.create('이미 같은 중복 관계가 있는 업무');
  const existing = await f.call<IssueRelation>(pathFor(existingSource.id), { method: 'POST', body: add(original.id, 'duplicates') }, 201);
  const newSource = await f.create('API로 닫을 중복 업무');
  const read = await f.key('중복 업무 읽기', [primary, secondary], 'read');
  const narrow = await f.key('중복 업무 한 프로젝트 쓰기', [primary], 'write');
  const wide = await f.key('중복 업무 두 프로젝트 쓰기', [primary, secondary], 'write');
  const route = `/v1${duplicatePath(newSource.id)}`;
  const request = { method: 'POST', body: duplicateBody(newSource, original, workflow) };
  const untouched = await f.call<WorkspaceSnapshot>('/workspace');
  await f.call(route, { ...request, headers: read }, 403);
  await f.call(route, { ...request, headers: narrow }, 403);
  assert.deepEqual(await f.call<WorkspaceSnapshot>('/workspace'), untouched);
  assert.deepEqual(await f.call(pathFor(newSource.id)), []);

  const send = () => f.request<DuplicateClosure>(route, { ...request, headers: wide });
  const responses = await Promise.all([send(), send()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const success = responses.find(response => response.status === 200)!;
  assert.equal(success.headers.get('cache-control'), 'no-store');
  const closed = success.data;
  assert.equal(closed.issue.status, 'done');
  assert.equal(closed.issue.version, newSource.version + 1);
  assert.ok(closed.issue.completedAt);
  assert.deepEqual([closed.issue.startDate, closed.issue.endDate, closed.issue.dueDate], [newSource.startDate, newSource.endDate, newSource.dueDate]);
  assert.deepEqual([closed.relation.origin, closed.relation.type, closed.relation.sourceIssueId, closed.relation.targetIssueId],
    ['teamspace', 'duplicates', newSource.id, original.id]);
  assert.deepEqual(await f.call(pathFor(newSource.id)), [closed.relation]);

  const reused = await f.call<DuplicateClosure>(duplicatePath(existingSource.id), { method: 'POST',
    body: duplicateBody(existingSource, original, workflow, 'cancelled') });
  assert.equal(reused.issue.status, 'cancelled');
  assert.equal(reused.issue.completedAt, null);
  assert.deepEqual(reused.relation, existing);
  assert.deepEqual(await f.call(pathFor(existingSource.id)), [existing]);

  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues.find(issue => issue.id === original.id), original);
  const previousEvents = new Set(untouched.activities.map(event => event.id));
  const events = after.activities.filter(event => !previousEvents.has(event.id));
  const relationEvents = events.filter(event => event.action === '업무 관계 추가');
  assert.deepEqual(new Set(relationEvents.map(event => event.resourceId)), new Set([original.id, newSource.id]));
  assert.equal(relationEvents.length, 2);
  assert.deepEqual(new Set(events.filter(event => event.action === '중복으로 닫기').map(event => event.resourceId)), new Set([existingSource.id, newSource.id]));
  assert.ok(events.every(event => event.actorId === actor));

  const history = await f.call<IssueChangeHistoryPage>(`/issues/${newSource.id}/change-history`);
  const status = history.entries[0];
  assert.equal(status.issueVersion, closed.issue.version);
  assert.equal(status.actorId, actor);
  assert.deepEqual(status.changes.filter(change => change.field === 'status').map(change => [change.before.value, change.after.value]),
    [[newSource.status, 'done']]);
  await f.call(duplicatePath(newSource.id), { method: 'POST', body: duplicateBody(closed.issue, original, workflow) }, 409);
  assert.deepEqual(await f.call<WorkspaceSnapshot>('/workspace'), after);
});

test('close as duplicate rolls back workflow rejection and failures while recording either side of the change', async t => {
  const f = await fixture(t);
  const source = await f.create('완료 전에 조건을 충족할 중복 업무');
  const original = await f.create('중복 업무의 원본');
  const workflowPath = `/projects/${primary}/workflow`;
  const current = await f.call<ProjectWorkflow>(workflowPath);
  const workflow = await f.call<ProjectWorkflow>(workflowPath, { method: 'PATCH', body: { ...current, expectedVersion: current.version,
    transitions: current.transitions.map(edge => edge.from === source.status && edge.to === 'done' ? { ...edge, requiredFields: ['description'] } : edge),
  } });
  const route = duplicatePath(source.id);
  const workspace = () => f.call<WorkspaceSnapshot>('/workspace');
  const before = await workspace();
  const rejected = await f.call<{ details: { requiredFields: string[] } }>(route, { method: 'POST', body: duplicateBody(source, original, workflow) }, 422);
  assert.deepEqual(rejected.details.requiredFields, ['description']);
  assert.deepEqual(await workspace(), before);
  assert.deepEqual(await f.call(pathFor(source.id)), []);

  const updated = await f.call<Issue>(`/issues/${source.id}`, { method: 'PATCH', body: {
    expectedVersion: source.version, description: '중복임을 확인한 근거를 먼저 저장합니다.',
  } });
  const ready = await workspace();
  const changes = () => f.call<IssueChangeHistoryPage>(`/issues/${source.id}/change-history`);
  const readyHistory = await changes();
  const operation = { method: 'POST', body: duplicateBody(updated, original, workflow) };
  const database = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    for (const [action, resourceId] of [['업무 관계 추가', original.id], ['중복으로 닫기', source.id]]) {
      database.exec(`CREATE TRIGGER fail_duplicate_closure BEFORE INSERT ON activities
        WHEN json_extract(NEW.json, '$.resourceId')='${resourceId}' AND json_extract(NEW.json, '$.action')='${action}'
        BEGIN SELECT RAISE(ABORT, 'synthetic duplicate closure activity failure'); END`);
      await f.call(route, operation, 500);
      assert.deepEqual(await workspace(), ready);
      assert.deepEqual(await changes(), readyHistory);
      assert.deepEqual(await f.call(pathFor(source.id)), []);
      assert.deepEqual(await f.call(pathFor(original.id)), []);
      database.exec('DROP TRIGGER fail_duplicate_closure');
    }
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_duplicate_closure');
    database.close();
  }
  const accepted = await f.call<DuplicateClosure>(route, operation);
  assert.equal(accepted.issue.status, 'done');
  assert.equal(accepted.relation.targetIssueId, original.id);
});

test('close as duplicate guards source, original and workflow versions and rejects conflicting and cyclic originals', async t => {
  const f = await fixture(t);
  const source = await f.create('순환 연결이 있는 중복 후보');
  const middle = await f.create('연쇄 중복 원본 후보');
  const tail = await f.create('두 번째 중복 연결');
  const other = await f.create('이미 다른 원본에 연결한 업무');
  const unrelated = await f.create('순환을 만들지 않는 중복 후보');
  const workflowPath = `/projects/${primary}/workflow`;
  const initialWorkflow = await f.call<ProjectWorkflow>(workflowPath);
  const connect = (first: Issue, second: Issue) => f.call<IssueRelation>(pathFor(first.id), { method: 'POST', body: add(second.id, 'duplicates') }, 201);
  await connect(middle, tail);
  await connect(tail, source);
  const existing = await connect(other, source);
  const patch = (issue: Issue) => f.call<Issue>(`/issues/${issue.id}`, { method: 'PATCH', body: { expectedVersion: issue.version, title: `${issue.title} 수정` } });
  const edited = await patch(source);
  const original = await patch(middle);
  const workflow = await f.call<ProjectWorkflow>(workflowPath, { method: 'PATCH', body: { ...initialWorkflow, expectedVersion: initialWorkflow.version,
    statuses: initialWorkflow.statuses.map(status => status.id === 'review' ? { ...status, label: '검토 상태 이름 변경' } : status),
  } });
  const workspace = () => f.call<WorkspaceSnapshot>('/workspace');
  const before = await workspace();
  type Rejection = { error: string; details?: { reason: string; currentVersion?: number; currentWorkflowVersion?: number } };
  const run = (issue: Issue, body: Record<string, unknown>, status: number) => f.call<Rejection>(duplicatePath(issue.id), { method: 'POST', body }, status);
  const staleSource = await run(edited, duplicateBody(source, original, workflow), 409);
  assert.equal(staleSource.details?.currentVersion, edited.version);
  const staleOriginal = await run(edited, duplicateBody(edited, middle, workflow), 409);
  assert.equal(staleOriginal.details?.reason, 'original_version_changed');
  assert.equal(staleOriginal.details?.currentVersion, original.version);
  const staleWorkflow = await run(edited, duplicateBody(edited, original, initialWorkflow), 409);
  assert.equal(staleWorkflow.details?.reason, 'workflow_changed');
  assert.equal(staleWorkflow.details?.currentWorkflowVersion, workflow.version);
  await run(edited, { ...duplicateBody(edited, original, workflow), expectedOriginalVersion: undefined }, 400);
  await run(edited, { ...duplicateBody(edited, original, workflow), originalIssueId: 'missing-issue' }, 404);
  await run(edited, duplicateBody(edited, edited, workflow), 400);
  await run(edited, duplicateBody(edited, original, workflow, 'review'), 422);
  assert.match((await run(edited, duplicateBody(edited, original, workflow), 409)).error, /순환/u);
  assert.match((await run(other, duplicateBody(other, original, workflow), 409)).error, /이미 다른 업무/u);
  assert.deepEqual(await workspace(), before);
  assert.equal((await f.call<IssueRelation[]>(pathFor(edited.id))).filter(relation => relation.sourceIssueId === edited.id).length, 0);
  assert.deepEqual(await f.call(pathFor(other.id)), [existing]);
  const noncyclic = await f.call<DuplicateClosure>(duplicatePath(unrelated.id), { method: 'POST', body: duplicateBody(unrelated, original, workflow) });
  assert.equal(noncyclic.issue.status, 'done');
  assert.equal(noncyclic.relation.targetIssueId, original.id);
});

test('team Gantt blockers expose only native cross-project relations between live issues, leaving status and dates to the chart', async t => {
  const f = await fixture(t);
  const source = await f.create('다른 프로젝트의 차단 원인');
  const target = await f.create('외부 차단을 받는 업무', secondary);
  const local = await f.create('같은 프로젝트의 차단 대상');
  const imported: IssueRelation = {
    id: randomUUID(), sourceIssueId: target.id, targetIssueId: source.id,
    type: 'blocks', version: 1, createdAt: new Date().toISOString(),
  };
  const backup = await f.call<Backup>('/export');
  await f.call('/import', { method: 'POST', body: { data: { ...backup, issueRelations: [...backup.issueRelations, imported] } } });
  const scheduleBefore = (await f.call<WorkspaceSnapshot>('/workspace')).dependencies;

  await f.call(pathFor(source.id), { method: 'POST', body: add(local.id, 'blocks') }, 201);
  await f.call(pathFor(source.id), { method: 'POST', body: add(target.id, 'related') }, 201);
  const original = await f.call<IssueRelation>(pathFor(source.id), { method: 'POST', body: add(target.id, 'blocks') }, 201);
  const payload = (relation: IssueRelation): TeamScheduleBlocker => {
    const { id, sourceIssueId, targetIssueId, version } = relation;
    return { id, sourceIssueId, targetIssueId, version };
  };
  const readPath = '/schedule/team-blockers';
  const result = await f.request<TeamScheduleBlocker[]>(readPath);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.data, [payload(original)]);

  const currentSource = (await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === source.id);
  assert.ok(currentSource);
  const terminal = await f.call<Issue>(`/issues/${source.id}`, { method: 'PATCH', body: { expectedVersion: currentSource.version, status: 'done' } });
  assert.equal(terminal.status, 'done');
  assert.deepEqual(await f.call(readPath), [payload(original)]);

  const reversed = await f.call<IssueRelation>(child(source.id, original.id), { method: 'PATCH', body: {
    expectedVersion: original.version, type: 'blocks', direction: 'incoming',
  } });
  assert.ok(reversed.version > original.version);
  assert.deepEqual(await f.call(readPath), [{ ...payload(reversed), sourceIssueId: target.id, targetIssueId: source.id }]);
  const readKey = await f.key('팀 간트 전체 범위 읽기', [primary, secondary], 'read');
  await f.call(`/v1${readPath}`, { headers: readKey }, 403);

  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/issues/${source.id}`, { method: 'DELETE', body: { expectedVersion: terminal.version } });
  assert.deepEqual(await f.call(readPath), []);
  await f.call(`/trash/${trashEntryId}/restore`, { method: 'POST', body: {} });
  const [restored] = await f.call<TeamScheduleBlocker[]>(readPath);
  assert.ok(restored.version > reversed.version);
  assert.deepEqual({ ...restored, version: reversed.version }, payload(reversed));
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).dependencies, scheduleBefore);
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

test('schedule creation from a native blocking relation verifies its member, direction and version and is atomic and idempotent', async t => {
  const f = await fixture(t);
  const a = await f.create('일정 변환 선행 업무');
  const b = await f.create('일정 변환 후행 업무');
  const c = await f.create('일정 변환의 관계 외 업무');
  const relation = await f.call<IssueRelation>(pathFor(b.id), { method: 'POST', body: add(a.id, 'blocks', 'incoming') }, 201);
  const linked = await f.call<IssueRelation>(pathFor(a.id), { method: 'POST', body: add(c.id) }, 201);
  const initial = await f.call<WorkspaceSnapshot>('/workspace');
  const body = scheduleBody(relation);
  const createFrom = (issueId: string, input: unknown = body) => f.request<Dependency>(schedulePath(issueId, relation), { method: 'POST', body: input });
  await f.call(schedulePath(c.id, relation), { method: 'POST', body }, 404);
  await f.call(schedulePath(a.id, linked), { method: 'POST', body: scheduleBody(linked) }, 400);
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, predecessorId: b.id, successorId: a.id } }, 400);
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, successorId: c.id } }, 400);
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, expectedVersion: 0 } }, 400);
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, type: 'other' } }, 400);
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, lagDays: 3_651 } }, 400);

  const db = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_schedule_relation_activity BEFORE INSERT ON activities
      WHEN json_extract(NEW.json, '$.action')='선행 업무 연결'
      BEGIN SELECT RAISE(ABORT, 'synthetic schedule relation activity failure'); END`);
    await f.call(schedulePath(b.id, relation), { method: 'POST', body }, 500);
    assert.deepEqual(await f.call('/workspace'), initial);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_schedule_relation_activity');
    db.close();
  }

  const saved = await Promise.all([createFrom(a.id), createFrom(b.id)]);
  assert.deepEqual(saved.map(result => result.status).sort(), [200, 201]);
  const dependency = saved[0].data;
  assert.deepEqual(saved[1].data, dependency);
  assert.deepEqual(dependency, { id: dependency.id, predecessorId: a.id, successorId: b.id, type: 'SS', lagDays: 2, version: 1 });
  await f.call(schedulePath(a.id, relation), { method: 'POST', body: { ...body, lagDays: 3 } }, 409);
  await f.call('/dependencies', { method: 'POST', body: { predecessorId: a.id, successorId: b.id, type: 'SS', lagDays: 2 } }, 409);
  assert.deepEqual(await f.call(pathFor(b.id)), [relation]);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues, initial.issues);
  assert.equal(after.dependencies.length, initial.dependencies.length + 1);
  assert.equal(after.activities.length, initial.activities.length + 1);
  assert.equal(after.activities.filter(event => event.action === '선행 업무 연결' && event.resourceId === b.id).length, 1);

  const changed = await f.call<IssueRelation>(child(a.id, relation.id), { method: 'PATCH', body: {
    expectedVersion: relation.version, type: 'related', direction: 'outgoing',
  } });
  const conflict = await f.call<{ details: { currentVersion: number } }>(schedulePath(a.id, relation), { method: 'POST', body }, 409);
  assert.equal(conflict.details.currentVersion, changed.version);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).dependencies.find(edge => edge.id === dependency.id), dependency);
});

test('legacy blocking labels let the actor choose either direction without replacing the source and still guard cycles and project scope', async t => {
  const f = await fixture(t);
  const a = await f.create('이관한 차단 업무 A');
  const b = await f.create('이관한 차단 업무 B');
  const outsider = await f.create('다른 프로젝트의 차단 업무', secondary);
  const legacy: IssueRelation = { id: randomUUID(), sourceIssueId: a.id, targetIssueId: b.id,
    type: '  Is  bLoCkEd   By  ', version: 1, createdAt: new Date().toISOString() };
  const backup = await f.call<Backup>('/export');
  await f.call('/import', { method: 'POST', body: { data: { ...backup, schemaVersion: 50, issueRelations: [legacy] } } });
  const original = await f.call<WorkspaceSnapshot>('/workspace');
  const chosen = { ...scheduleBody(legacy), predecessorId: b.id, successorId: a.id, type: 'SF', lagDays: -2 };
  const dependency = await f.call<Dependency>(schedulePath(b.id, legacy), { method: 'POST', body: chosen }, 201);
  assert.deepEqual(dependency, { id: dependency.id, predecessorId: b.id, successorId: a.id, type: 'SF', lagDays: -2, version: 1 });
  assert.deepEqual(await f.call(pathFor(a.id)), [legacy]);
  assert.deepEqual(await f.call(schedulePath(a.id, legacy), { method: 'POST', body: chosen }), dependency);
  assert.match((await f.call<{ error: string }>(schedulePath(a.id, legacy), { method: 'POST', body: scheduleBody(legacy) }, 400)).error, /순환/);

  const cross = await f.call<IssueRelation>(pathFor(a.id), { method: 'POST', body: add(outsider.id, 'blocks') }, 201);
  assert.match((await f.call<{ error: string }>(schedulePath(a.id, cross), { method: 'POST', body: scheduleBody(cross) }, 400)).error, /같은 프로젝트/);
  const publicKey = await f.key('차단 일정 공개 API 확인', [primary], 'write');
  assert.deepEqual(await f.call(`/v1${schedulePath(a.id, legacy)}`, { method: 'POST', body: chosen, headers: publicKey }), dependency);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues, original.issues);
  assert.deepEqual(after.dependencies, [...original.dependencies, dependency]);
});
