import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.js';
import type {
  ApiKeyCreated, CycleCompletionPreview, CycleCompletionRecord, CycleCompletionRecordsPage, CycleCompletionResult, Issue,
  PlanningItem, ProjectIssueOrder, ProjectWorkflow, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';

async function open(dir: string) {
  const service = createApp({ dataDir: dir });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let closed = false;
  return {
    async call<T = unknown>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() as T };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof open>>;

async function withFixture(run: (app: Fixture, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-cycle-completion-'));
  try {
    const app = await open(dir);
    try { await run(app, dir); } finally { await app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function plan(app: Fixture, name: string, fields: Partial<PlanningItem> = {}) {
  const result = await app.call<PlanningItem>('/planning-items', 'POST', { name, projectId, kind: 'cycle', status: 'active', ...fields });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function issue(app: Fixture, name: string, fields: Partial<Issue> = {}) {
  const result = await app.call<Issue>('/issues', 'POST', { title: name, projectId, ...fields });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

function completion(cycle: PlanningItem) { return `/planning-items/${cycle.id}/complete`; }
function requestPreview(app: Fixture, cycle: PlanningItem, destination: PlanningItem | null) {
  return app.call<CycleCompletionPreview>(`${completion(cycle)}/preview`, 'POST', { expectedVersion: cycle.version, destinationId: destination?.id ?? null });
}

async function review(app: Fixture, cycle: PlanningItem, destination: PlanningItem | null) {
  const preview = await requestPreview(app, cycle, destination);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  return preview.data;
}

async function workspace(app: Fixture) { return (await app.call<WorkspaceSnapshot>('/workspace')).data; }
function findIssue(state: WorkspaceSnapshot, id: string) { return state.issues.find(value => value.id === id)!; }

test('cycle completion follows workflow categories and carries live tickets without changing their dates or hierarchy', async () => {
  await withFixture(async app => {
    const source = await plan(app, '이번 사이클', { startDate: '2026-11-02', endDate: '2026-11-13' });
    const destination = await plan(app, '다음 사이클', { status: 'planned', startDate: '2026-11-16' });
    const developmentModule = await plan(app, '개발 모듈', { kind: 'module' });
    const workflow = (await app.call<ProjectWorkflow>(`/projects/${projectId}/workflow`)).data;
    const stage = { id: 'released', label: '출시 승인', color: '#654321', category: 'done' };
    const cancelled = { id: 'dropped', label: '범위 제외', color: '#654321', category: 'cancelled' };
    const updated = await app.call(`/projects/${projectId}/workflow`, 'PATCH', { ...workflow,
      expectedVersion: workflow.version, statuses: [...workflow.statuses, stage, cancelled],
      transitions: [...workflow.transitions, ...[stage, cancelled].map(status => ({ from: 'todo', to: status.id, issueTypes: [], requiredFields: [] }))],
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    const parent = await issue(app, '자체 완료 상태', { cycleId: source.id });
    const carried = await issue(app, '다음 사이클로 이동', { cycleId: source.id, parentId: parent.id,
      moduleId: developmentModule.id, startDate: '2026-11-10', endDate: '2026-11-12', dueDate: '2026-11-13', plannedEffortMinutes: 180 });
    const abandoned = await issue(app, '자체 취소 상태', { cycleId: source.id });
    const existing = await issue(app, '이미 다음 사이클', { cycleId: destination.id });
    const trashed = await issue(app, '휴지통 업무', { cycleId: source.id });
    assert.equal((await app.call(`/issues/${parent.id}`, 'PATCH', { expectedVersion: parent.version, status: stage.id })).status, 200);
    assert.equal((await app.call(`/issues/${abandoned.id}`, 'PATCH', { expectedVersion: abandoned.version, status: cancelled.id })).status, 200);
    assert.equal((await app.call(`/issues/${trashed.id}`, 'DELETE', { expectedVersion: trashed.version })).status, 200);
    assert.equal((await app.call('/dependencies', 'POST', { predecessorId: parent.id, successorId: carried.id, type: 'FS', lagDays: 0 })).status, 201);
    const before = await workspace(app);
    const order = (await app.call<ProjectIssueOrder>(`/projects/${projectId}/issue-order`)).data;

    const preview = await review(app, source, destination);
    assert.ok(preview.previewId && preview.expiresAt);
    assert.deepEqual(preview.counts, { carry: 1, done: 1, cancelled: 1, blocked: 0 });
    assert.deepEqual(preview.destination, { id: destination.id, name: destination.name, version: 1 });
    assert.deepEqual(preview.issues.map(row => [row.id, row.disposition, row.statusLabel]).sort(), [
      [parent.id, 'done', stage.label], [abandoned.id, 'cancelled', cancelled.label], [carried.id, 'carry', '할 일'],
    ].sort());
    assert.deepEqual((await workspace(app)).activities, before.activities);

    const applied = await app.call<CycleCompletionResult>(completion(source), 'POST', { previewId: preview.previewId });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.deepEqual(applied.data.counts, preview.counts);
    assert.deepEqual(applied.data.cycle, { ...source, status: 'completed', version: source.version + 1, updatedAt: applied.data.cycle.updatedAt });
    const after = await workspace(app);
    const moved = findIssue(after, carried.id);
    assert.deepEqual(moved, { ...findIssue(before, carried.id), cycleId: destination.id, cycle: destination.name,
      version: carried.version + 1, updatedAt: moved.updatedAt });
    for (const unchanged of [parent.id, abandoned.id, existing.id]) assert.deepEqual(findIssue(after, unchanged), findIssue(before, unchanged));
    assert.equal(findIssue(after, trashed.id), undefined);
    assert.deepEqual(after.dependencies, before.dependencies);
    const afterOrder = (await app.call<ProjectIssueOrder>(`/projects/${projectId}/issue-order`)).data;
    assert.deepEqual(afterOrder.issueIds, order.issueIds);
    assert.notEqual(afterOrder.version, order.version);
    assert.equal(after.activities.filter(row => row.resourceId === source.id).length, before.activities.filter(row => row.resourceId === source.id).length + 1);
    assert.equal(after.activities.filter(row => row.resourceId === carried.id).length, before.activities.filter(row => row.resourceId === carried.id).length + 1);
  });
});

test('cycle preview blocks invalid backlog moves and revalidates source membership, workflow, and destination versions', async () => {
  await withFixture(async app => {
    const source = await plan(app, '경쟁 사이클');
    const destination = await plan(app, '변경될 사이클', { status: 'planned' });
    const otherProject = await plan(app, '다른 프로젝트', { projectId: 'project-team' });
    const archived = await plan(app, '보관된 사이클', { status: 'archived' });
    const child = await issue(app, '필수 사이클 업무', { cycleId: source.id });
    const initial = (await app.call<ProjectWorkflow>(`/projects/${projectId}/workflow`)).data;
    const setRules = async (workflow: ProjectWorkflow) => {
      const response = await app.call<ProjectWorkflow>(`/projects/${projectId}/workflow`, 'PATCH', { ...workflow,
        expectedVersion: workflow.version, fieldRules: [{ issueType: '*', statusId: 'todo', requiredFields: ['cycle'] }],
      });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
    const workflow = await setRules(initial);
    for (const invalid of [source, otherProject, archived]) assert.equal((await requestPreview(app, source, invalid)).status, 422);
    assert.equal((await requestPreview(app, { ...source, version: 3 }, null)).status, 409);
    const blocked = await review(app, source, null);
    assert.equal(blocked.previewId, null);
    assert.equal(blocked.expiresAt, null);
    assert.deepEqual(blocked.counts, { carry: 1, done: 0, cancelled: 0, blocked: 1 });
    assert.match(blocked.issues[0].blockedReason ?? '', /사이클/);

    let preview = await review(app, source, destination);
    assert.ok(preview.previewId);
    await issue(app, '검토 후 합류', { cycleId: source.id });
    const apply = () => app.call(completion(source), 'POST', { previewId: preview.previewId });
    assert.equal((await apply()).status, 409);
    preview = await review(app, source, destination);
    assert.equal(preview.counts.carry, 2);
    const renamed = await app.call<PlanningItem>(`/planning-items/${destination.id}`, 'PATCH', { name: '새 사이클 이름', expectedVersion: destination.version });
    assert.equal(renamed.status, 200);
    assert.equal((await apply()).status, 409);
    preview = await review(app, source, renamed.data);
    await setRules(workflow);
    assert.equal((await apply()).status, 409);
    assert.equal(findIssue(await workspace(app), child.id).cycleId, source.id);
    assert.equal((await app.call<PlanningItem>(`/planning-items/${source.id}`)).data.status, 'active');
  });
});

test('scoped write keys can complete a cycle, and receipt replay crosses a restart and stays actor bound', async () => {
  await withFixture(async (app, dir) => {
    const source = await plan(app, '백로그로 이동');
    const foreign = await plan(app, '다른 팀 사이클', { projectId: 'project-team' });
    const member = await issue(app, '백로그 업무', { cycleId: source.id });
    const key = async (access: 'read' | 'write', owner = 'user-min') => {
      const response = await app.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 키', projectIds: [projectId], access }, { 'X-Actor-Id': owner });
      assert.equal(response.status, 201);
      return { Authorization: `Bearer ${response.data.token}` };
    };
    const [write, read, otherActor] = await Promise.all([key('write'), key('read'), key('write', 'user-seo')]);
    const url = `/v1${completion(source)}`;
    assert.equal((await app.call(`${url}/preview`, 'POST', { expectedVersion: source.version, destinationId: null }, read)).status, 403);
    assert.equal((await app.call(`/v1${completion(foreign)}/preview`, 'POST', { expectedVersion: foreign.version, destinationId: null }, write)).status, 403);
    assert.equal((await app.call(`${url}/preview`, 'POST', { expectedVersion: source.version, destinationId: foreign.id }, write)).status, 403);
    const preview = await app.call<CycleCompletionPreview>(`${url}/preview`, 'POST', { expectedVersion: source.version, destinationId: null, actorId: 'user-seo' }, { ...write, 'X-Actor-Id': 'user-seo' });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal((await app.call(url, 'POST', { previewId: preview.data.previewId }, otherActor)).status, 404);
    const applied = await app.call<CycleCompletionResult>(url, 'POST', { previewId: preview.data.previewId }, write);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.destination, null);
    const saved = await workspace(app);
    assert.equal(findIssue(saved, member.id).cycleId, null);
    assert.equal(saved.activities.find(row => row.resourceId === source.id && row.action === '사이클 완료')?.actorId, 'user-min');

    await app.close();
    const reopened = await open(dir);
    try {
      assert.deepEqual(await reopened.call(url, 'POST', { previewId: preview.data.previewId }, write), applied);
      assert.deepEqual((await workspace(reopened)).activities, saved.activities);
      const backup = (await reopened.call('/export')).data;
      assert.equal((await reopened.call('/import', 'POST', { data: backup })).status, 200);
      assert.equal((await reopened.call(completion(source), 'POST', { previewId: preview.data.previewId }, { 'X-Actor-Id': 'user-min' })).status, 404);
    } finally { await reopened.close(); }
  });
});

test('a failed cycle write rolls back earlier ticket and audit changes and the same review remains usable', async () => {
  await withFixture(async (app, dir) => {
    const source = await plan(app, '완료 롤백 사이클');
    const first = await issue(app, '한 번째 업무', { cycleId: source.id });
    const second = await issue(app, '두 번째 업무', { cycleId: source.id });
    const preview = await review(app, source, null);
    const before = await workspace(app);
    const db = new DatabaseSync(join(dir, 'teamspace.sqlite'));
    const apply = () => app.call<CycleCompletionResult>(completion(source), 'POST', { previewId: preview.previewId });
    try {
      db.exec(`CREATE TRIGGER synthetic_cycle_commit_error BEFORE UPDATE ON planning_items
        WHEN json_extract(NEW.json, '$.status') = 'completed'
        BEGIN SELECT RAISE(ABORT, 'synthetic cycle completion failure'); END`);
      assert.equal((await apply()).status, 500);
      const state = await workspace(app);
      assert.deepEqual(state.activities, before.activities);
      assert.deepEqual(state.planningItems, before.planningItems);
      assert.deepEqual(state.issues, before.issues);
      db.exec('DROP TRIGGER synthetic_cycle_commit_error');
      const result = await apply();
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.counts.carry, 2);
      const after = await workspace(app);
      assert.equal(findIssue(after, first.id).cycleId, null);
      assert.equal(findIssue(after, second.id).cycleId, null);
    } finally { db.close(); }
  });
});

const recordsPath = `/projects/${projectId}/cycle-completion-records`;

test('completed cycles archive the reviewed outcomes and preserve independent completion records after reopening and restart', async () => {
  await withFixture(async (app, dir) => {
    const { users } = await workspace(app);
    const actor = users.find(user => user.id === 'user-min')!;
    const assignee = users.find(user => user.id === 'user-seo')!;
    const actorHeader = { 'X-Actor-Id': actor.id };
    const source = await plan(app, '원래 사이클', { startDate: '2026-11-02', endDate: '2026-11-13', targetDate: '2026-11-14' });
    const destination = await plan(app, '원래 이월 대상', { status: 'planned' });
    const legacy = await plan(app, '기록 기능 이전 완료', { status: 'completed' });
    const done = await issue(app, '완료된 업무', { cycleId: source.id, status: 'done' });
    const cancelled = await issue(app, '취소된 업무', { cycleId: source.id, status: 'cancelled' });
    const carried = await issue(app, '이월된 업무', { cycleId: source.id, assigneeId: assignee.id });
    const outside = await issue(app, '이전 사이클 밖 업무', { cycleId: destination.id });
    const trashed = await issue(app, '완료 전 휴지통 업무', { cycleId: source.id });
    assert.equal((await app.call(`/issues/${trashed.id}`, 'DELETE', { expectedVersion: trashed.version })).status, 200);

    const prepare = async (cycle: PlanningItem, target: PlanningItem | null) => {
      const response = await app.call<CycleCompletionPreview>(`${completion(cycle)}/preview`, 'POST', {
        expectedVersion: cycle.version, destinationId: target?.id ?? null,
      }, actorHeader);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.ok(response.data.previewId);
      return response.data.previewId;
    };
    const getRecord = (activeApp: Fixture, id: string) => activeApp.call<CycleCompletionRecord>(`${recordsPath}/${id}`);
    const listRecords = (activeApp: Fixture, cycleId: string) =>
      activeApp.call<CycleCompletionRecordsPage>(`${recordsPath}?cycleId=${encodeURIComponent(cycleId)}`);
    const previewId = await prepare(source, destination);
    assert.deepEqual(await listRecords(app, source.id), { status: 200, data: { items: [], nextCursor: null } });
    const apply = () => app.call<CycleCompletionResult>(completion(source), 'POST', { previewId }, actorHeader);
    const [first, replay] = await Promise.all([apply(), apply()]);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(replay, first);
    assert.ok(first.data.recordId);

    const firstRead = await getRecord(app, first.data.recordId);
    assert.equal(firstRead.status, 200, JSON.stringify(firstRead.data));
    const captured = firstRead.data;
    assert.deepEqual(captured, {
      id: first.data.recordId, projectId, actorId: actor.id, actorName: actor.name, completedAt: first.data.cycle.updatedAt,
      cycle: { id: source.id, name: source.name, version: first.data.cycle.version,
        startDate: source.startDate, endDate: source.endDate, targetDate: source.targetDate },
      destination: { id: destination.id, name: destination.name, version: destination.version },
      counts: { carry: 1, done: 1, cancelled: 1 },
      issues: [
        { id: done.id, key: done.key, title: done.title, statusId: 'done', statusLabel: '완료', disposition: 'done', assigneeId: null, assigneeName: null },
        { id: cancelled.id, key: cancelled.key, title: cancelled.title, statusId: 'cancelled', statusLabel: '취소', disposition: 'cancelled', assigneeId: null, assigneeName: null },
        { id: carried.id, key: carried.key, title: carried.title, statusId: 'todo', statusLabel: '할 일', disposition: 'carry',
          assigneeId: assignee.id, assigneeName: assignee.name },
      ],
    });

    const nextCycle = await app.call<PlanningItem>(`/planning-items/${source.id}`, 'PATCH', {
      expectedVersion: first.data.cycle.version, status: 'active', name: '다시 진행할 사이클', startDate: '2026-11-03',
    });
    assert.equal(nextCycle.status, 200);
    assert.equal((await app.call(`/users/${actor.id}`, 'PATCH', { name: '다시 완료한 팀원' })).status, 200);
    assert.equal((await app.call(`/users/${assignee.id}`, 'PATCH', { name: '바뀐 담당자 이름' })).status, 200);
    const workflowPath = `/projects/${projectId}/workflow`;
    const workflow = (await app.call<ProjectWorkflow>(workflowPath)).data;
    const renamedStatus = await app.call(workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map(status => status.id === 'done' ? { ...status, label: '출시 완료' } : status),
    });
    assert.equal(renamedStatus.status, 200);
    const carriedVersion = findIssue(await workspace(app), carried.id).version;
    const edited = await app.call<Issue>(`/issues/${carried.id}`, 'PATCH', { expectedVersion: carriedVersion, title: '이월 후 새 제목' });
    assert.equal(edited.status, 200);
    for (const item of [edited.data, outside]) {
      assert.equal((await app.call(`/issues/${item.id}`, 'DELETE', { expectedVersion: item.version })).status, 200);
    }
    assert.equal((await app.call(`/planning-items/${destination.id}?expectedVersion=${destination.version}`, 'DELETE')).status, 200);
    assert.deepEqual((await getRecord(app, captured.id)).data, captured);

    const newcomer = await issue(app, '두 번째 완료에서 새로 이월', { cycleId: source.id });
    const secondPreviewId = await prepare(nextCycle.data, null);
    const second = await app.call<CycleCompletionResult>(completion(source), 'POST', { previewId: secondPreviewId }, actorHeader);
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.ok(second.data.recordId);
    assert.notEqual(second.data.recordId, captured.id);
    const nextRecord = await getRecord(app, second.data.recordId);
    assert.equal(nextRecord.status, 200);
    assert.deepEqual(nextRecord.data.cycle, { ...captured.cycle, name: nextCycle.data.name, startDate: nextCycle.data.startDate,
      version: second.data.cycle.version });
    assert.equal(nextRecord.data.actorName, '다시 완료한 팀원');
    assert.equal(nextRecord.data.destination, null);
    assert.deepEqual(nextRecord.data.issues.map(item => item.id), [done.id, cancelled.id, newcomer.id]);
    assert.equal(nextRecord.data.issues.find(item => item.id === done.id)?.statusLabel, '출시 완료');
    const otherProjectRead = await app.call(`/projects/project-team/cycle-completion-records/${captured.id}`);
    assert.equal(otherProjectRead.status, 404);
    assert.deepEqual(await listRecords(app, legacy.id), { status: 200, data: { items: [], nextCursor: null } });

    for (const id of [done.id, cancelled.id]) {
      const version = findIssue(await workspace(app), id).version;
      assert.equal((await app.call(`/issues/${id}`, 'DELETE', { expectedVersion: version })).status, 200);
    }
    assert.equal((await app.call(`/planning-items/${source.id}?expectedVersion=${second.data.cycle.version}`, 'DELETE')).status, 200);

    await app.close();
    const restarted = await open(dir);
    try {
      assert.deepEqual(await getRecord(restarted, captured.id), firstRead);
      assert.deepEqual(await getRecord(restarted, nextRecord.data.id), nextRecord);
      const archived = await listRecords(restarted, source.id);
      assert.equal(archived.status, 200);
      assert.deepEqual(archived.data.items.map(row => row.id), [nextRecord.data.id, captured.id]);
      assert.deepEqual(await restarted.call(completion(source), 'POST', { previewId }, actorHeader), first);
    } finally { await restarted.close(); }
  });
});

test('a failure saving the retry receipt also rolls back the cycle history and ticket changes', async () => {
  await withFixture(async (app, dir) => {
    const source = await plan(app, '기록과 영수증 롤백');
    await issue(app, '이월 롤백 업무', { cycleId: source.id });
    const preview = await review(app, source, null);
    const before = await workspace(app);
    const db = new DatabaseSync(join(dir, 'teamspace.sqlite'));
    const apply = () => app.call<CycleCompletionResult>(completion(source), 'POST', { previewId: preview.previewId });
    try {
      db.exec(`CREATE TRIGGER synthetic_cycle_receipt_error BEFORE UPDATE ON cycle_completion_previews
        WHEN json_type(NEW.json, '$.result.recordId') = 'text'
        BEGIN SELECT RAISE(ABORT, 'synthetic cycle completion receipt failure'); END`);
      assert.equal((await apply()).status, 500);
      const after = await workspace(app);
      assert.deepEqual(after.issues, before.issues);
      assert.deepEqual(after.planningItems, before.planningItems);
      assert.deepEqual(after.activities, before.activities);
      const { count: rolledBack } = db.prepare('SELECT count(*) AS count FROM cycle_completion_records').get() as { count: number };
      assert.equal(rolledBack, 0);
      db.exec('DROP TRIGGER synthetic_cycle_receipt_error');

      const saved = await apply();
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.ok(saved.data.recordId);
      assert.equal((await app.call(`${recordsPath}/${saved.data.recordId}`)).status, 200);
      assert.deepEqual(await apply(), saved);
      const { count: total } = db.prepare('SELECT count(*) AS count FROM cycle_completion_records').get() as { count: number };
      assert.equal(total, 1);
    } finally { db.close(); }
  });
});
