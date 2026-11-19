import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import { calculateTeamWorkload, WorkloadError } from '../../shared/project-workload.js';
import { defaultTeamWorkloadCapacity } from '../../shared/team-workload-capacity.js';
import type { Dependency, Issue } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';
import { levelTeamWorkload } from '../../shared/workload-leveling.js';

const friday = '2026-11-20';
const saturday = '2026-11-21';
const monday = '2026-11-23';
const tuesday = '2026-11-24';
const wednesday = '2026-11-25';
const thursday = '2026-11-26';
const nextFriday = '2026-11-27';
const assignee = 'team-member';
const timestamp = '2026-11-19T00:00:00.000Z';
const base = {
  capacity: { ...defaultTeamWorkloadCapacity(), defaultDailyMinutes: 100 },
  startDate: monday,
  endDate: nextFriday,
  userIds: [assignee],
  dependencies: [] as Dependency[],
};

function issue(id: string, projectId: string, fields: Partial<Issue> = {}): Issue {
  return {
    id, key: `${projectId}-${id}`, projectId, title: id, description: '', type: '작업', status: 'todo',
    priority: 'low', assigneeId: assignee, collaboratorIds: [], parentId: null, labels: [],
    startDate: monday, endDate: monday, dueDate: null, plannedEffortMinutes: 60, estimate: null,
    cycle: null, module: null, release: null, version: 1, createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    ...fields,
  };
}

function project(id: string, issues: Issue[], workingWeekdays = [1, 2, 3, 4, 5]) {
  return { calendar: { ...defaultWorkCalendar(id), workingWeekdays }, workflow: defaultWorkflow(id), issues };
}

function allocations(input: Parameters<typeof levelTeamWorkload>[0], changes: ReturnType<typeof levelTeamWorkload>['changes'] = []) {
  const dates = new Map(changes.map(change => [change.id, { startDate: change.toStart, endDate: change.toEnd }]));
  return calculateTeamWorkload({
    ...input,
    projects: input.projects.map(project => ({
      ...project, terminalStatusIds: ['done', 'cancelled'],
      issues: project.issues.map(issue => ({ ...issue, ...dates.get(issue.id) })),
    })),
  });
}

test('team leveling uses project workdays and personal capacity overrides on team days off', () => {
  const moving = issue('move', 'a', { startDate: friday, endDate: saturday, dueDate: monday, plannedEffortMinutes: 51 });
  const fixedFriday = issue('fixed-friday', 'b', { startDate: friday, endDate: friday, plannedEffortMinutes: 80 });
  const fixedMonday = issue('fixed-monday', 'b', { plannedEffortMinutes: 70 });
  const input = {
    ...base, startDate: friday, capacity: { ...base.capacity, exceptions: [{ userId: assignee, date: saturday, availableMinutes: 30 }] },
    projects: [project('a', [moving], [1, 2, 3, 4, 5, 6]), project('b', [fixedFriday, fixedMonday])], movableProjectIds: ['a'],
  };
  const plan = levelTeamWorkload(input);
  assert.deepEqual(plan.before, { overloadedCells: 1, excessMinutes: 6, completionDate: monday });
  assert.deepEqual(plan.after, { overloadedCells: 0, excessMinutes: 0, completionDate: monday });
  assert.deepEqual(plan.changes.map(change => [change.id, change.projectId, change.toStart, change.toEnd]),
    [[moving.id, 'a', saturday, monday]]);
  assert.deepEqual(plan.projectCompletions, [{ projectId: 'a', before: saturday, after: monday }]);
  const projected = allocations(input, plan.changes);
  assert.deepEqual(projected.rows[0].days.slice(0, 4).map(cell => [cell.scheduledMinutes, cell.availableMinutes]),
    [[80, 100], [26, 30], [0, 0], [95, 100]]);
  const noOverride = levelTeamWorkload({ ...input, capacity: base.capacity });
  assert.deepEqual(noOverride.changes, []);
  assert.equal(noOverride.after.excessMinutes, 31);
});

test('projects outside the movable selection still occupy shared daily capacity', () => {
  const moving = issue('move', 'a', { priority: 'high' });
  const mondayBlock = issue('same-day', 'b', { plannedEffortMinutes: 70 });
  const tuesdayBlock = issue('next-day', 'b', { startDate: tuesday, endDate: tuesday, plannedEffortMinutes: 70 });
  const input = {
    ...base, projects: [project('a', [moving]), project('b', [mondayBlock, tuesdayBlock])], movableProjectIds: ['a'],
  };
  const plan = levelTeamWorkload(input);
  assert.deepEqual(plan.before, { overloadedCells: 1, excessMinutes: 30, completionDate: tuesday });
  assert.deepEqual(plan.after, { overloadedCells: 0, excessMinutes: 0, completionDate: wednesday });
  assert.deepEqual(plan.changes.map(change => [change.id, change.toStart]), [[moving.id, wednesday]]);
  assert.deepEqual(plan.projectCompletions, [{ projectId: 'a', before: monday, after: wednesday }]);
  assert.deepEqual(allocations(input, plan.changes).rows[0].days.slice(0, 3).map(cell => cell.scheduledMinutes), [70, 70, 60]);
  const fixed = levelTeamWorkload({ ...input, movableProjectIds: [] });
  assert.deepEqual(fixed.remaining, [{ userId: assignee, date: monday, excessMinutes: 30, issueIds: [moving.id, mondayBlock.id] }]);
  assert.deepEqual(fixed.projectCompletions, []);
  for (const movableProjectIds of [['a', 'a'], ['unknown']]) {
    assert.throws(() => levelTeamWorkload({ ...input, movableProjectIds }), (error: unknown) => error instanceof WorkloadError && error.status === 400);
  }
});

test('later proposals see space consumed by other project moves even when the project workday indices differ', () => {
  const movingA = issue('move-a', 'a');
  const movingB = issue('move-b', 'b', { startDate: tuesday, endDate: tuesday });
  const fixedMonday = issue('fixed-monday', 'fixed', { plannedEffortMinutes: 70 });
  const fixedTuesday = issue('fixed-tuesday', 'fixed', { startDate: tuesday, endDate: tuesday, plannedEffortMinutes: 70 });
  const input = {
    ...base, projects: [project('a', [movingA], [1, 3, 4, 5]), project('b', [movingB]), project('fixed', [fixedMonday, fixedTuesday])],
    movableProjectIds: ['b', 'a'],
  };
  const before = allocations(input);
  const plan = levelTeamWorkload(input);
  assert.deepEqual(plan.changes.map(change => [change.id, change.toStart]), [[movingA.id, wednesday], [movingB.id, thursday]]);
  assert.deepEqual(plan.projectCompletions, [
    { projectId: 'a', before: monday, after: wednesday }, { projectId: 'b', before: tuesday, after: thursday },
  ]);
  assert.deepEqual(plan.after, { overloadedCells: 0, excessMinutes: 0, completionDate: thursday });
  const after = allocations(input, plan.changes);
  assert.deepEqual(after.rows[0].days.map(cell => cell.scheduledMinutes), [70, 70, 60, 60, 0]);
  assert.equal(after.totalScheduledMinutes, before.totalScheduledMinutes);
  assert.deepEqual(allocations(input), before);
  assert.deepEqual(levelTeamWorkload(input), plan);
});

test('team leveling checks signed relationships on the issue project calendar and holds unresolved links fixed', () => {
  const moving = issue('move', 'a', { startDate: friday, endDate: friday });
  const successor = issue('successor', 'a', { assigneeId: null, startDate: friday, endDate: friday });
  const fixed = issue('fixed', 'b', { startDate: friday, endDate: friday, plannedEffortMinutes: 70 });
  const input = {
    ...base, startDate: friday, projects: [project('a', [moving, successor], [1, 2, 3, 4, 5, 6]), project('b', [fixed])],
    movableProjectIds: ['a'],
  };
  assert.deepEqual(levelTeamWorkload(input).changes.map(change => change.toStart), [monday]);
  for (const successorId of [successor.id, fixed.id, 'unknown']) {
    const dependency: Dependency = { id: 'related', type: 'SS', lagDays: -1, predecessorId: moving.id, successorId };
    const plan = levelTeamWorkload({ ...input, dependencies: [dependency] });
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.after.excessMinutes, 30);
  }
});
