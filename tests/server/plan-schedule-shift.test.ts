import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Dependency, Issue, PlanningItem, PlanScheduleShiftPreview, PlanScheduleShiftResult,
  Project, ProjectIssueSchema, ProjectWorkflow, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

async function fixture(directory?: string) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'teamspace-plan-shift-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const database = new DatabaseSync(join(dir, 'teamspace.sqlite'));
  let closed = false;
  return {
    dir, database,
    async call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-min') {
      const response = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() as T };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
      database.close();
    },
    remove() { rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function project(f: Fixture) {
  const response = await f.call<Project>('/projects', 'POST', {
    key: `PS${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, name: '합성 계획 일정 이동',
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function plan(f: Fixture, projectId: string, extra: Partial<PlanningItem> = {}) {
  const response = await f.call<PlanningItem>('/planning-items', 'POST', {
    projectId, kind: 'cycle', name: `이동 계획 ${randomUUID()}`,
    startDate: '2026-11-16', endDate: '2026-11-20', targetDate: '2026-11-23', ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function member(f: Fixture, item: PlanningItem, extra: Partial<Issue> = {}) {
  const response = await f.call<Issue>('/issues', 'POST', {
    projectId: item.projectId, title: `합성 연결 업무 ${randomUUID()}`,
    [`${item.kind}Id`]: item.id, startDate: '2026-11-16', endDate: '2026-11-18', ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function state(f: Fixture) {
  const response = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(response.status, 200);
  return response.data;
}
async function currentPlan(f: Fixture, id: string) {
  const response = await f.call<PlanningItem>(`/planning-items/${id}`);
  assert.equal(response.status, 200);
  return response.data;
}
async function preview(f: Fixture, item: PlanningItem, extra: Record<string, unknown> = {}, actor = 'user-min') {
  const response = await f.call<PlanScheduleShiftPreview>(`/planning-items/${item.id}/schedule-preview`, 'POST', {
    expectedPlanVersion: item.version, days: 2, workingDays: false, includeLinked: true, ...extra,
  }, actor);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
function apply(f: Fixture, item: PlanningItem, proposal: PlanScheduleShiftPreview, actor = 'user-min') {
  return f.call<PlanScheduleShiftResult>(`/planning-items/${item.id}/schedule-apply`, 'POST', { previewId: proposal.previewId }, actor);
}
function dates(item: PlanningItem) { return { startDate: item.startDate, endDate: item.endDate, targetDate: item.targetDate }; }

test('combined preview has no canonical writes, shifts every known date and explicitly skips terminal/unscheduled members', async () => {
  const f = await fixture();
  try {
    const p = await project(f), item = await plan(f, p.id);
    const scheduled = await member(f, item);
    const startOnly = await member(f, item, { startDate: '2026-11-19', endDate: null });
    const endOnly = await member(f, item, { startDate: null, endDate: '2026-11-20' });
    const done = await member(f, item, { status: 'done' });
    const cancelled = await member(f, item, { status: 'cancelled', startDate: null, endDate: null });
    const unscheduled = await member(f, item, { startDate: null, endDate: null });
    const otherPlan = await plan(f, p.id);
    const unrelated = await member(f, otherPlan);
    const before = await state(f);
    const proposal = await preview(f, item);
    assert.ok(proposal.previewId);
    assert.ok(proposal.expiresAt);
    assert.deepEqual(proposal.blocking, []);
    assert.deepEqual(proposal.plan, {
      id: item.id, name: item.name, kind: item.kind, version: item.version,
      from: dates(item), to: { startDate: '2026-11-18', endDate: '2026-11-22', targetDate: '2026-11-25' },
    });
    const changes = new Map(proposal.changes.map(change => [change.id, change]));
    assert.equal(changes.size, 3);
    assert.deepEqual([changes.get(scheduled.id)!.toStart, changes.get(scheduled.id)!.toEnd], ['2026-11-18', '2026-11-20']);
    assert.deepEqual([changes.get(startOnly.id)!.toStart, changes.get(startOnly.id)!.toEnd], ['2026-11-21', null]);
    assert.deepEqual([changes.get(endOnly.id)!.toStart, changes.get(endOnly.id)!.toEnd], [null, '2026-11-22']);
    assert.deepEqual(new Map(proposal.skipped.map(value => [value.id, value.reason])), new Map([
      [done.id, 'terminal'], [cancelled.id, 'terminal'], [unscheduled.id, 'unscheduled'],
    ]));
    assert.equal(changes.has(unrelated.id), false);
    assert.deepEqual(await state(f), before);
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.deepEqual(dates(applied.data.plan), proposal.plan.to);
    assert.equal(applied.data.updated.length, 3);
    const after = await state(f);
    for (const skipped of [done, cancelled, unscheduled, unrelated]) assert.deepEqual(after.issues.find(value => value.id === skipped.id), skipped);
  } finally { await f.close(); f.remove(); }
});

test('workday moves honor a working Saturday/holiday, preserve partial dates and undo all plan dates', async () => {
  const f = await fixture();
  try {
    const p = await project(f);
    const calendar = await f.call<WorkCalendar>(`/projects/${p.id}/calendar`);
    assert.equal((await f.call(`/projects/${p.id}/calendar`, 'PATCH', {
      ...calendar.data, expectedVersion: calendar.data.version,
      exceptions: [
        { date: '2026-11-21', isWorking: true, label: '합성 토요일 작업' },
        { date: '2026-11-23', isWorking: false, label: '합성 월요일 휴무' },
      ],
    })).status, 200);
    const item = await plan(f, p.id, { startDate: '2026-11-20', endDate: '2026-11-20', targetDate: '2026-11-23' });
    const full = await member(f, item, { startDate: '2026-11-20', endDate: '2026-11-23' });
    const partialStart = await member(f, item, { startDate: '2026-11-20', endDate: null });
    const partialEnd = await member(f, item, { startDate: null, endDate: '2026-11-23' });
    const proposal = await preview(f, item, { days: 1, workingDays: true });
    assert.deepEqual(proposal.plan.to, { startDate: '2026-11-21', endDate: '2026-11-21', targetDate: '2026-11-24' });
    const changes = new Map(proposal.changes.map(change => [change.id, change]));
    assert.deepEqual([changes.get(full.id)!.toStart, changes.get(full.id)!.toEnd], ['2026-11-21', '2026-11-24']);
    assert.deepEqual([changes.get(partialStart.id)!.toStart, changes.get(partialStart.id)!.toEnd], ['2026-11-21', null]);
    assert.deepEqual([changes.get(partialEnd.id)!.toStart, changes.get(partialEnd.id)!.toEnd], [null, '2026-11-24']);
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const undone = await f.call<PlanScheduleShiftResult>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    assert.deepEqual(dates(undone.data.plan), dates(item));
    for (const original of [full, partialStart, partialEnd]) {
      const restored = undone.data.updated.find(issue => issue.id === original.id)!;
      assert.deepEqual([restored.startDate, restored.endDate], [original.startDate, original.endDate]);
    }
    const negative = await preview(f, await currentPlan(f, item.id), { days: -1, workingDays: true });
    assert.deepEqual(negative.plan.to, { startDate: '2026-11-19', endDate: '2026-11-19', targetDate: '2026-11-21' });
    assert.deepEqual([negative.changes.find(change => change.id === full.id)!.toStart, negative.changes.find(change => change.id === full.id)!.toEnd], ['2026-11-19', '2026-11-21']);
  } finally { await f.close(); f.remove(); }
});

test('plan-only moves support zero linked issues and goal-only plans, while no known date blocks a proposal', async () => {
  const f = await fixture();
  try {
    const p = await project(f), item = await plan(f, p.id);
    const linked = await member(f, item);
    const proposal = await preview(f, item, { includeLinked: false });
    assert.deepEqual(proposal.changes, []);
    assert.deepEqual(proposal.skipped, []);
    assert.equal((await f.call(`/issues/${linked.id}`, 'PATCH', { expectedVersion: linked.version, description: '계획만 이동하는 동안 업무는 별도로 편집' })).status, 200);
    const added = await member(f, item);
    assert.equal((await f.call('/dependencies', 'POST', { predecessorId: linked.id, successorId: added.id, lagDays: 0 })).status, 201);
    const calendar = (await f.call<WorkCalendar>(`/projects/${p.id}/calendar`)).data;
    assert.equal((await f.call(`/projects/${p.id}/calendar`, 'PATCH', { expectedVersion: calendar.version, name: '계획 달력일 이동과 무관한 설정 변경' })).status, 200);
    const schema = (await f.call<ProjectIssueSchema>(`/projects/${p.id}/issue-schema`)).data;
    assert.equal((await f.call(`/projects/${p.id}/issue-schema`, 'PATCH', {
      ...schema, expectedVersion: schema.version,
      issueTypes: schema.issueTypes.map((type, index) => index === 0 ? { ...type, name: `${type.name} 변경` } : type),
    })).status, 200);
    const workflow = (await f.call<ProjectWorkflow>(`/projects/${p.id}/workflow`)).data;
    assert.equal((await f.call(`/projects/${p.id}/workflow`, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map((status, index) => index === 0 ? { ...status, label: `${status.label} 변경` } : status),
    })).status, 200);
    const beforePlanOnlyApply = await state(f);
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.deepEqual(applied.data.updated, []);
    assert.deepEqual((await state(f)).issues, beforePlanOnlyApply.issues);
    assert.deepEqual(dates(applied.data.plan), proposal.plan.to);
    const undone = await f.call<PlanScheduleShiftResult>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(undone.status, 200);
    assert.deepEqual(undone.data.updated, []);
    assert.deepEqual(dates(undone.data.plan), dates(item));
    const calendarBound = await preview(f, await currentPlan(f, item.id), { includeLinked: false, workingDays: true });
    const latestCalendar = (await f.call<WorkCalendar>(`/projects/${p.id}/calendar`)).data;
    assert.equal((await f.call(`/projects/${p.id}/calendar`, 'PATCH', { expectedVersion: latestCalendar.version, name: '계획 근무일 이동이 읽은 달력 변경' })).status, 200);
    const beforeCalendarConflict = await state(f);
    assert.equal((await apply(f, item, calendarBound)).status, 409);
    assert.deepEqual(await state(f), beforeCalendarConflict);
    const goalOnly = await plan(f, p.id, { kind: 'release', startDate: null, endDate: null, targetDate: '2026-11-20' });
    const empty = await preview(f, goalOnly);
    assert.deepEqual(empty.blocking, []);
    assert.deepEqual(empty.changes, []);
    assert.deepEqual(empty.plan.to, { startDate: null, endDate: null, targetDate: '2026-11-22' });
    assert.equal((await apply(f, goalOnly, empty)).status, 200);
    const unknown = await plan(f, p.id, { kind: 'module', startDate: null, endDate: null, targetDate: null });
    const blocked = await preview(f, unknown);
    assert.equal(blocked.previewId, null);
    assert.ok(blocked.blocking.length);
    assert.equal((await apply(f, unknown, blocked)).status, 400);
  } finally { await f.close(); f.remove(); }
});

test('actor/plan bindings protect guarded previews and successful apply receipts survive retry and server restart', async () => {
  const f = await fixture();
  let reopened: Fixture | undefined;
  try {
    const p = await project(f), item = await plan(f, p.id), other = await plan(f, p.id);
    const linked = await member(f, item);
    const proposal = await preview(f, item);
    const before = await state(f);
    assert.equal((await apply(f, item, proposal, 'user-seo')).status, 409);
    assert.equal((await apply(f, other, proposal)).status, 409);
    assert.equal((await f.call(`/planning-items/${item.id}/schedule-apply`, 'POST', { previewId: randomUUID() })).status, 404);
    assert.equal((await f.call(`/planning-items/${item.id}/schedule-preview`, 'POST', { expectedPlanVersion: item.version + 1, days: 1, workingDays: false, includeLinked: true })).status, 409);
    assert.equal((await f.call(`/planning-items/${item.id}/schedule-preview`, 'POST', { expectedPlanVersion: item.version, days: 0, workingDays: false, includeLinked: true })).status, 400);
    assert.deepEqual(await state(f), before);
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const after = await state(f);
    assert.deepEqual((await apply(f, item, proposal)).data, applied.data);
    assert.deepEqual(await state(f), after);
    assert.equal((await apply(f, item, proposal, 'user-seo')).status, 409);
    assert.equal((await apply(f, other, proposal)).status, 409);
    await f.close();
    reopened = await fixture(f.dir);
    const repeated = await apply(reopened, item, proposal);
    assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
    assert.deepEqual(repeated.data, applied.data);
    const undo = await reopened.call<PlanScheduleShiftResult>('/schedule/undo', 'POST', { undoId: repeated.data.undoId });
    assert.equal(undo.status, 200, JSON.stringify(undo.data));
    assert.deepEqual(dates(undo.data.plan), dates(item));
    const restored = undo.data.updated.find(issue => issue.id === linked.id)!;
    assert.deepEqual([restored.startDate, restored.endDate], [linked.startDate, linked.endDate]);
    assert.ok(restored.version > applied.data.updated[0].version);
    assert.equal((await reopened.call('/schedule/undo', 'POST', { undoId: repeated.data.undoId })).status, 409);
  } finally { if (reopened) await reopened.close(); await f.close(); f.remove(); }
});

test('plan/member/endpoint/dependency/calendar/schema/workflow changes invalidate the complete preview read set without partial writes', async () => {
  const guards = ['plan', 'add-member', 'remove-member', 'member', 'skipped-member', 'endpoint', 'dependency', 'calendar', 'schema', 'workflow'] as const;
  for (const guard of guards) {
    const f = await fixture();
    try {
      const p = await project(f), item = await plan(f, p.id), other = await plan(f, p.id);
      const linked = await member(f, item);
      const skipped = await member(f, item, { status: 'done' });
      const anchor = await member(f, other, { startDate: '2026-11-16', endDate: '2026-11-20' });
      const edge = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: anchor.id, successorId: linked.id, lagDays: 0 });
      assert.equal(edge.status, 201);
      const proposal = await preview(f, item, { days: 1, workingDays: true });
      assert.deepEqual(proposal.blocking, [], guard);
      assert.ok(proposal.warnings.some(warning => warning.includes(anchor.key) && warning.includes(linked.key)), guard);
      switch (guard) {
        case 'plan':
          assert.equal((await f.call(`/planning-items/${item.id}`, 'PATCH', { expectedVersion: item.version, description: '검토 후 계획 속성 변경' })).status, 200);
          break;
        case 'add-member':
          await member(f, item);
          break;
        case 'remove-member':
          assert.equal((await f.call(`/issues/${linked.id}`, 'PATCH', { expectedVersion: linked.version, cycleId: null })).status, 200);
          break;
        case 'member':
        case 'skipped-member':
        case 'endpoint': {
          const issue = guard === 'member' ? linked : guard === 'skipped-member' ? skipped : anchor;
          assert.equal((await f.call(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, description: '검토 후 읽기 집합 변경' })).status, 200);
          break;
        }
        case 'dependency':
          assert.equal((await f.call(`/dependencies/${edge.data.id}`, 'DELETE')).status, 200);
          break;
        case 'calendar': {
          const calendar = (await f.call<WorkCalendar>(`/projects/${p.id}/calendar`)).data;
          assert.equal((await f.call(`/projects/${p.id}/calendar`, 'PATCH', { expectedVersion: calendar.version, name: '변경한 합성 달력' })).status, 200);
          break;
        }
        case 'schema': {
          const schema = (await f.call<ProjectIssueSchema>(`/projects/${p.id}/issue-schema`)).data;
          assert.equal((await f.call(`/projects/${p.id}/issue-schema`, 'PATCH', {
            ...schema, expectedVersion: schema.version,
            issueTypes: schema.issueTypes.map((type, index) => index === 0 ? { ...type, name: `${type.name} 변경` } : type),
          })).status, 200);
          break;
        }
        case 'workflow': {
          const workflow = (await f.call<ProjectWorkflow>(`/projects/${p.id}/workflow`)).data;
          assert.equal((await f.call(`/projects/${p.id}/workflow`, 'PATCH', {
            ...workflow, expectedVersion: workflow.version,
            statuses: workflow.statuses.map((status, index) => index === 0 ? { ...status, label: `${status.label} 변경` } : status),
          })).status, 200);
          break;
        }
      }
      const beforeApply = await state(f);
      const result = await apply(f, item, proposal);
      assert.equal(result.status, 409, `${guard}: ${JSON.stringify(result.data)}`);
      assert.deepEqual(await state(f), beforeApply, guard);
      assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM schedule_undos').get()!.count, 0, guard);
    } finally { await f.close(); f.remove(); }
  }
});

test('undo plan and issue version conflicts are atomic, while a fresh valid undo restores both sets of dates', async () => {
  const f = await fixture();
  try {
    const p = await project(f), item = await plan(f, p.id);
    const a = await member(f, item), b = await member(f, item);
    const first = await apply(f, item, await preview(f, item));
    assert.equal(first.status, 200);
    const changedIssue = first.data.updated.find(issue => issue.id === a.id)!;
    assert.equal((await f.call(`/issues/${a.id}`, 'PATCH', { expectedVersion: changedIssue.version, description: '이후 작성한 설명은 보존' })).status, 200);
    let beforeUndo = await state(f);
    const firstReceipt = f.database.prepare('SELECT json FROM schedule_undos WHERE id=?').get(first.data.undoId)!.json;
    assert.equal((await f.call('/schedule/undo', 'POST', { undoId: first.data.undoId })).status, 409);
    assert.deepEqual(await state(f), beforeUndo);
    assert.equal(f.database.prepare('SELECT json FROM schedule_undos WHERE id=?').get(first.data.undoId)!.json, firstReceipt);
    const current = await currentPlan(f, item.id);
    const second = await apply(f, current, await preview(f, current, { days: 1 }));
    assert.equal(second.status, 200);
    assert.equal((await f.call(`/planning-items/${item.id}`, 'PATCH', { expectedVersion: second.data.plan.version, description: '검토 이후 변경한 계획 설명' })).status, 200);
    beforeUndo = await state(f);
    assert.equal((await f.call('/schedule/undo', 'POST', { undoId: second.data.undoId })).status, 409);
    assert.deepEqual(await state(f), beforeUndo);
    const latest = await currentPlan(f, item.id);
    const beforeThird = await state(f);
    const third = await apply(f, latest, await preview(f, latest, { days: -1 }));
    assert.equal(third.status, 200);
    const restored = await f.call<PlanScheduleShiftResult>('/schedule/undo', 'POST', { undoId: third.data.undoId });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(dates(restored.data.plan), dates(latest));
    assert.equal(restored.data.plan.description, '검토 이후 변경한 계획 설명');
    for (const id of [a.id, b.id]) {
      const before = beforeThird.issues.find(issue => issue.id === id)!;
      const after = restored.data.updated.find(issue => issue.id === id)!;
      assert.deepEqual([after.startDate, after.endDate, after.description], [before.startDate, before.endDate, before.description]);
    }
  } finally { await f.close(); f.remove(); }
});

test('late audit failures roll back plan, issue dates, undo and consumed receipt together for apply and undo', async () => {
  const f = await fixture();
  try {
    const p = await project(f), item = await plan(f, p.id);
    await member(f, item); await member(f, item);
    const proposal = await preview(f, item), before = await state(f);
    f.database.exec("CREATE TRIGGER reject_plan_shift_apply BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.resourceType')='schedule' BEGIN SELECT RAISE(ABORT,'synthetic plan shift apply audit failure'); END");
    try {
      assert.ok((await apply(f, item, proposal)).status >= 400);
      assert.deepEqual(await state(f), before);
      assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM schedule_undos').get()!.count, 0);
    } finally { f.database.exec('DROP TRIGGER reject_plan_shift_apply'); }
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const beforeUndo = await state(f);
    const receipt = f.database.prepare('SELECT json FROM schedule_undos WHERE id=?').get(applied.data.undoId)!.json;
    f.database.exec("CREATE TRIGGER reject_plan_shift_undo BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='계획 일정 되돌리기' BEGIN SELECT RAISE(ABORT,'synthetic plan shift undo audit failure'); END");
    try {
      assert.ok((await f.call('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status >= 400);
      assert.deepEqual(await state(f), beforeUndo);
      assert.equal(f.database.prepare('SELECT json FROM schedule_undos WHERE id=?').get(applied.data.undoId)!.json, receipt);
    } finally { f.database.exec('DROP TRIGGER reject_plan_shift_undo'); }
    const restored = await f.call<PlanScheduleShiftResult>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(restored.status, 200);
    assert.deepEqual(dates(restored.data.plan), dates(item));
    for (const issue of restored.data.updated) {
      const original = before.issues.find(value => value.id === issue.id)!;
      assert.deepEqual([issue.startDate, issue.endDate], [original.startDate, original.endDate]);
    }
  } finally { await f.close(); f.remove(); }
});

test('failed native imports preserve guarded previews and successful restore clears pending and completed receipts', async () => {
  const f = await fixture();
  try {
    const p = await project(f), item = await plan(f, p.id);
    await member(f, item);
    const proposal = await preview(f, item);
    const backup = (await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export')).data;
    assert.equal(JSON.stringify(backup).includes(proposal.previewId!), false);
    const invalid = structuredClone(backup);
    assert.ok(invalid.resourceLinks.length);
    invalid.resourceLinks[0].documentId = 'missing-document';
    assert.equal((await f.call('/import', 'POST', { data: invalid })).status, 404);
    const applied = await apply(f, item, proposal);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const latest = await currentPlan(f, item.id);
    const pending = await preview(f, latest);
    const currentBackup = (await f.call('/export')).data;
    assert.equal(JSON.stringify(currentBackup).includes(pending.previewId!), false);
    assert.equal((await f.call('/import', 'POST', { data: currentBackup })).status, 200);
    const restored = await state(f);
    assert.equal((await apply(f, item, proposal)).status, 404);
    assert.equal((await apply(f, latest, pending)).status, 404);
    assert.deepEqual(await state(f), restored);
  } finally { await f.close(); f.remove(); }
});
