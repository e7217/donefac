import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import { calculateProjectWorkload, defaultWorkloadCapacity } from '../../shared/project-workload.js';
import type { Dependency, Issue } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';
import { levelProjectWorkload, MAX_WORKLOAD_LEVEL_CHANGES } from '../../shared/workload-leveling.js';

const projectId = 'leveling-project';
const friday = '2026-11-20';
const saturday = '2026-11-21';
const monday = '2026-11-23';
const tuesday = '2026-11-24';
const wednesday = '2026-11-25';
const thursday = '2026-11-26';
const nextFriday = '2026-11-27';
const assignee = 'assignee';
const timestamp = '2026-11-19T00:00:00.000Z';
const base = {
  calendar: defaultWorkCalendar(projectId),
  capacity: { ...defaultWorkloadCapacity(projectId), defaultDailyMinutes: 10 },
  workflow: defaultWorkflow(projectId),
  startDate: monday,
  endDate: nextFriday,
  userIds: [assignee],
  dependencies: [] as Dependency[],
};

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id, key: `LEVEL-${id}`, projectId, title: id, description: '', type: '작업', status: 'todo',
    priority: 'low', assigneeId: assignee, collaboratorIds: [], parentId: null, labels: [],
    startDate: monday, endDate: monday, dueDate: null, plannedEffortMinutes: 10, estimate: null,
    cycle: null, module: null, release: null, version: 1, createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    ...fields,
  };
}

function applyPreview(input: Parameters<typeof levelProjectWorkload>[0], plan: ReturnType<typeof levelProjectWorkload>) {
  const moves = new Map(plan.changes.map(change => [change.id, change]));
  return calculateProjectWorkload({
    ...input, terminalStatusIds: ['done', 'cancelled'],
    issues: input.issues.map(value => {
      const change = moves.get(value.id);
      return change ? { ...value, startDate: change.toStart, endDate: change.toEnd } : value;
    }),
  });
}

test('leveling postpones the lower-priority issue while preserving its workdays, remainder minutes and date exceptions', () => {
  const calendar = {
    ...base.calendar,
    exceptions: [
      { date: saturday, isWorking: true, label: '토요일 근무' },
      { date: monday, isWorking: false, label: '대체 휴무' },
    ],
  };
  const capacity = { ...base.capacity, exceptions: [{ userId: assignee, date: tuesday, availableMinutes: 0 }] };
  const high = issue('high', { priority: 'urgent', startDate: friday, endDate: friday, plannedEffortMinutes: 8 });
  const low = issue('low', { startDate: friday, endDate: saturday, plannedEffortMinutes: 11, dueDate: thursday });
  const input = { ...base, startDate: friday, calendar, capacity, issues: [high, low] };
  const plan = levelProjectWorkload(input);
  assert.deepEqual(plan.before, { overloadedCells: 1, excessMinutes: 4, completionDate: saturday });
  assert.deepEqual(plan.changes.map(change => [change.id, change.fromStart, change.fromEnd, change.toStart, change.toEnd]),
    [[low.id, friday, saturday, wednesday, thursday]]);
  assert.deepEqual(plan.after, { overloadedCells: 0, excessMinutes: 0, completionDate: thursday });
  assert.deepEqual(plan.remaining, []);
  assert.deepEqual(applyPreview(input, plan).rows[0].days.map(cell => cell.scheduledMinutes), [8, 0, 0, 0, 0, 6, 5, 0]);
  assert.equal(low.startDate, friday);
});

test('leveling uses the right endpoints and signed lags with a fixed successor for all dependency types', () => {
  const moving = issue('move', { endDate: tuesday, plannedEffortMinutes: 14 });
  const fixed = issue('keep', { priority: 'high' });
  const fixtures = [
    { type: 'FS', lagDays: -1, allowed: [wednesday, thursday], blocked: [tuesday, thursday] },
    { type: 'SS', lagDays: 1, allowed: [wednesday, thursday], blocked: [tuesday, thursday] },
    { type: 'FF', lagDays: 0, allowed: [monday, wednesday], blocked: [monday, tuesday] },
    { type: 'SF', lagDays: 1, allowed: [monday, wednesday], blocked: [monday, tuesday] },
  ] as const;
  for (const { type, lagDays, allowed, blocked } of fixtures) {
    const dependencies = [{ id: 'connected', type, lagDays, predecessorId: moving.id, successorId: 'neighbor' }];
    function preview([startDate, endDate]: readonly [string, string]) {
      const neighbor = issue('neighbor', { assigneeId: null, startDate, endDate });
      return levelProjectWorkload({ ...base, issues: [fixed, moving, neighbor], dependencies, issueIds: [moving.id] });
    }
    assert.deepEqual(preview(allowed).changes.map(change => [change.toStart, change.toEnd]), [[tuesday, wednesday]], type);
    const blockedPlan = preview(blocked);
    assert.deepEqual(blockedPlan.changes, [], type);
    assert.equal(blockedPlan.after.excessMinutes, 7, type);
  }
});

test('leveling rechecks incoming bounds and leaves tasks fixed when an incident relationship cannot be validated', () => {
  const moving = issue('move', { endDate: tuesday, plannedEffortMinutes: 14 });
  const fixed = issue('keep', { priority: 'high' });
  const earlier = issue('earlier', { assigneeId: null, startDate: tuesday, endDate: wednesday });
  const input = { ...base, issues: [fixed, moving, earlier], issueIds: [moving.id] };
  const dependency = { id: 'related', type: 'FS', lagDays: 0, predecessorId: earlier.id, successorId: moving.id } as const;
  assert.deepEqual(levelProjectWorkload({ ...input, dependencies: [dependency] }).changes.map(change => change.toStart), [thursday]);
  for (const edge of [{ ...dependency, predecessorId: 'unknown' }, { ...dependency, lagDays: Number.NaN }]) {
    const plan = levelProjectWorkload({ ...input, dependencies: [edge] });
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.after.excessMinutes, 7);
  }
});

test('leveling preserves other loads while reconsidering earlier candidates after a linked successor moves safely', () => {
  const earlier = issue('earlier');
  const later = issue('later', { assigneeId: 'another', startDate: tuesday, endDate: tuesday });
  const issues = [earlier, later, issue('keep-a', { priority: 'high' }),
    issue('keep-b', { priority: 'high', assigneeId: 'another', startDate: tuesday, endDate: tuesday })];
  const plan = levelProjectWorkload({
    ...base, issues, userIds: [assignee, 'another'], issueIds: [earlier.id, later.id],
    dependencies: [{ id: 'successor', type: 'FS', lagDays: 0, predecessorId: earlier.id, successorId: later.id }],
  });
  assert.deepEqual(plan.changes.map(change => [change.id, change.toStart]), [[later.id, wednesday], [earlier.id, tuesday]]);
  assert.equal(plan.after.excessMinutes, 0);
});

test('leveling leaves deadlines and partially in-range work fixed, returns partial improvements and avoids shifting residual overload', () => {
  const movable = issue('movable');
  const fixed = issue('partially-in-range', { startDate: friday, plannedEffortMinutes: 20 });
  const deadline = issue('deadline', { assigneeId: 'another', dueDate: monday });
  const mustStay = issue('same-day', { assigneeId: 'another', dueDate: monday });
  const finished = issue('finished', { assigneeId: 'another', plannedEffortMinutes: 100, status: 'done' });
  const report = levelProjectWorkload({ ...base, userIds: [assignee, 'another'], issues: [fixed, movable, deadline, mustStay, finished] });
  assert.deepEqual(report.changes.map(change => [change.id, change.toStart]), [[movable.id, tuesday]]);
  assert.equal(report.before.excessMinutes, 20);
  assert.equal(report.after.excessMinutes, 10);
  assert.deepEqual(report.remaining, [{ userId: 'another', date: monday, excessMinutes: 10, issueIds: [deadline.id, mustStay.id] }]);
  const indivisible = issue('too-large', { endDate: tuesday, plannedEffortMinutes: 11 });
  const blocked = levelProjectWorkload({ ...base, capacity: { ...base.capacity, defaultDailyMinutes: 5 }, issues: [indivisible] });
  assert.deepEqual(blocked.changes, []);
  assert.equal(blocked.after.excessMinutes, 1);
  assert.equal(blocked.remaining[0].date, monday);
  assert.equal(blocked.reason, undefined);
});

test('leveling reports a reached search limit and keeps exact remaining totals', () => {
  const userIds = Array.from({ length: MAX_WORKLOAD_LEVEL_CHANGES + 1 }, (_, index) => `user-${String(index).padStart(4, '0')}`);
  const issues = userIds.flatMap(userId => [
    issue(`move-${userId}`, { assigneeId: userId }),
    issue(`keep-${userId}`, { assigneeId: userId, priority: 'high' }),
  ]);
  const plan = levelProjectWorkload({ ...base, endDate: tuesday, userIds, issues });
  assert.equal(plan.changes.length, MAX_WORKLOAD_LEVEL_CHANGES);
  assert.equal(plan.before.overloadedCells, userIds.length);
  assert.equal(plan.after.overloadedCells, 1);
  assert.equal(plan.after.excessMinutes, 10);
  assert.equal(plan.remaining[0].userId, userIds.at(-1));
  assert.equal(plan.reason, 'search-limit');
});
