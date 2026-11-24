import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTeamFollowUpSchedule, teamBatchFollowUpScope, TeamFollowUpScheduleError } from '../../server/team-follow-up-schedule.js';
import { createCalendarMath, defaultWorkCalendar } from '../../shared/calendar.js';
import type { Dependency, Issue, ScheduleAnchorChange } from '../../shared/types.js';

const mon = '2026-11-23', tue = '2026-11-24', wed = '2026-11-25';
const thu = '2026-11-26', fri = '2026-11-27', nextMon = '2026-11-30';
const nextWed = '2026-12-02', nextThu = '2026-12-03';
const usual = createCalendarMath(defaultWorkCalendar('usual'));
const receiving = createCalendarMath({
  ...defaultWorkCalendar('receiving'),
  exceptions: [{ date: thu, isWorking: false, label: '프로젝트 휴무' }],
});
const calendar = (projectId: string) => projectId === 'receiving' ? receiving : usual;
const terminal = (issue: Issue) => issue.status === 'done';

function issue(id: string, projectId: string, startDate: string | null, endDate: string | null, status = 'todo'): Issue {
  return {
    id, projectId, key: id, title: id, type: 'task', status, description: '', priority: 'medium', assigneeId: null,
    collaboratorIds: [], parentId: null, labels: [], startDate, endDate, dueDate: null, estimate: null,
    cycle: null, module: null, release: null, version: 1, createdAt: mon, updatedAt: mon, completedAt: null,
  };
}

function dates(issue: Issue, startDate = issue.startDate, endDate = issue.endDate): ScheduleAnchorChange {
  return { id: issue.id, expectedVersion: issue.version, startDate, endDate };
}

function edge(predecessor: Issue, successor: Issue, type: Dependency['type'] = 'FS'): Dependency {
  return { id: `${predecessor.id}-${successor.id}`, predecessorId: predecessor.id, successorId: successor.id, type, lagDays: 0 };
}

test('multiple fixed roots converge once using each receiving calendar and incoming stored endpoint', () => {
  const a = issue('FIRST-1', 'first', mon, mon);
  const b = issue('SECOND-1', 'second', tue, tue);
  const convergence = { ...issue('RECV-1', 'receiving', mon, tue), dueDate: fri };
  const downstream = issue('END-1', 'last', thu, fri);
  const outside = issue('STORED-1', 'outside', nextWed, null, 'done');
  const unrelated = issue('UNRELATED-1', 'receiving', thu, fri);
  const issues = [a, b, convergence, downstream, outside, unrelated];
  const dependencies = [edge(a, convergence), edge(b, convergence), edge(convergence, downstream), edge(outside, downstream, 'SS')];
  const changes = [dates(a, mon, tue), dates(b, tue, wed)];
  const original = structuredClone({ issues, dependencies, changes });

  const scope = teamBatchFollowUpScope(changes, issues, dependencies);
  assert.deepEqual(scope.selectedIds, [a.id, b.id, convergence.id, downstream.id]);
  assert.deepEqual(scope.issues.map(value => value.id), [a.id, b.id, convergence.id, downstream.id, outside.id]);
  assert.deepEqual(scope.dependencies, dependencies);
  assert.deepEqual([...scope.fixedDates.keys()], [a.id, b.id]);

  const result = calculateTeamFollowUpSchedule(scope, calendar, terminal);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [a.id, mon, tue], [b.id, tue, wed], [convergence.id, fri, nextMon], [downstream.id, nextWed, nextThu],
  ]);
  assert.deepEqual(result.warnings, [`${convergence.key} · 조정한 종료일 ${nextMon}이 목표 마감일 ${fri} 이후입니다.`]);
  assert.deepEqual({ issues, dependencies, changes }, original);
});

test('a reached explicit successor retains its proposed dates and blocks dependent shifts when invalid', () => {
  const root = issue('ROOT-1', 'first', mon, mon);
  const fixed = issue('FIXED-1', 'second', tue, wed);
  const afterFixed = issue('AFTER-1', 'first', wed, thu);
  const terminalSuccessor = issue('DONE-1', 'second', tue, wed, 'done');
  const terminalAnchor = issue('DONE-2', 'first', wed, thu, 'done');

  const scope = teamBatchFollowUpScope([dates(root, mon, wed), dates(fixed, tue, fri), dates(terminalAnchor, wed, fri)],
    [root, fixed, afterFixed, terminalSuccessor, terminalAnchor],
    [edge(root, fixed), edge(fixed, afterFixed), edge(root, terminalSuccessor)]);
  const result = calculateTeamFollowUpSchedule(scope, calendar, terminal);
  assert.deepEqual(result.changes.map(change => change.id), [root.id]);
  assert.ok(result.blocking.some(message => message.includes(`${fixed.key} · 입력한 시작일 ${tue}이 선후행 조건 ${thu}`)));
  assert.ok(result.blocking.some(message => message.includes(`${afterFixed.key} · ${fixed.key}의 일정을 먼저 확인`)));
  assert.ok(result.blocking.some(message => message.includes(`${terminalSuccessor.key} · 완료·취소 업무의 고정 일정과 선후행 조건이 충돌`)));
  assert.ok(result.blocking.some(message => message.includes(`${terminalAnchor.key} · 완료·취소 업무의 고정 일정은 변경할 수 없습니다`)));
});

test('only changed anchors start traversal while reached unchanged anchors still constrain their successors', () => {
  const root = issue('ROOT-1', 'first', mon, mon);
  const reached = issue('REACHED-1', 'second', wed, thu);
  const afterReached = issue('AFTER-1', 'first', wed, thu);
  const independent = issue('UNCHANGED-1', 'second', mon, mon);
  const ignored = issue('IGNORED-1', 'first', mon, mon);
  const scope = teamBatchFollowUpScope([dates(root, tue, null), dates(reached), dates(independent)],
    [root, reached, afterReached, independent, ignored],
    [edge(root, reached, 'SS'), edge(reached, afterReached), edge(independent, ignored)]);

  assert.deepEqual(scope.selectedIds, [root.id, reached.id, afterReached.id, independent.id]);
  assert.deepEqual([...scope.fixedDates.keys()], [root.id, reached.id, independent.id]);
  const result = calculateTeamFollowUpSchedule(scope, calendar, terminal);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [root.id, tue, null], [afterReached.id, fri, nextMon],
  ]);
});

test('a projected link seeds an adjustable successor and later cross-project work without any date edits', () => {
  const stored = issue('LOCAL-1', 'first', mon, mon);
  const seeded = issue('LOCAL-2', 'first', mon, tue);
  const downstream = issue('RECV-1', 'receiving', tue, wed);
  const dependencies = [edge(stored, seeded), edge(seeded, downstream)];
  const scope = teamBatchFollowUpScope([], [stored, seeded, downstream], dependencies, [seeded.id, seeded.id]);

  assert.deepEqual(scope.selectedIds, [seeded.id, downstream.id]);
  assert.deepEqual(scope.issues.map(value => value.id), [stored.id, seeded.id, downstream.id]);
  assert.deepEqual(scope.dependencies, dependencies);
  assert.equal(scope.fixedDates.size, 0);
  const result = calculateTeamFollowUpSchedule(scope, calendar, terminal);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [seeded.id, tue, wed], [downstream.id, fri, nextMon],
  ]);
});

test('date anchors and adjustable link seeds converge once while an overlapping anchor stays fixed', () => {
  const anchor = issue('FIRST-1', 'first', mon, mon);
  const stored = issue('SECOND-1', 'second', mon, mon);
  const seeded = issue('SECOND-2', 'second', mon, tue);
  const convergence = issue('RECV-1', 'receiving', mon, tue);
  const dependencies = [edge(anchor, convergence), edge(seeded, convergence), edge(stored, seeded)];
  const scope = teamBatchFollowUpScope([dates(anchor, mon, tue)], [anchor, stored, seeded, convergence], dependencies,
    [seeded.id, anchor.id]);

  assert.deepEqual(scope.selectedIds, [anchor.id, seeded.id, convergence.id]);
  assert.deepEqual([...scope.fixedDates], [[anchor.id, { startDate: mon, endDate: tue }]]);
  const result = calculateTeamFollowUpSchedule(scope, calendar, terminal);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [anchor.id, mon, tue], [seeded.id, tue, wed], [convergence.id, fri, nextMon],
  ]);
});

test('batch requires at least one anchor or known successor and bounds the seed set', () => {
  const seed = issue('PRESENT-1', 'first', mon, tue);
  const status = (expected: number) => (error: unknown) =>
    error instanceof TeamFollowUpScheduleError && error.status === expected;
  assert.throws(() => teamBatchFollowUpScope([], [seed], []), status(400));
  assert.throws(() => teamBatchFollowUpScope([], [seed], [], ['MISSING-1']), status(409));
  const oversized = Array.from({ length: 1_001 }, (_, index) => issue(`PRESENT-${index + 1}`, 'first', mon, tue));
  assert.throws(() => teamBatchFollowUpScope([], oversized, [], oversized.map(value => value.id)), status(422));
  assert.throws(() => teamBatchFollowUpScope([dates(oversized[1_000])], oversized, [], oversized.slice(0, 1_000).map(value => value.id)),
    status(422));
});

test('batch rejects stale or duplicate fixed rows and blocks cycles or missing required dates', () => {
  const root = issue('ROOT-1', 'first', mon, mon);
  const downstream = issue('CHILD-1', 'receiving', tue, null);
  const issues = [root, downstream];
  const changed = dates(root, mon, wed);
  const dependency = edge(root, downstream);
  assert.throws(() => teamBatchFollowUpScope([{ ...changed, expectedVersion: 2 }], issues, [dependency]),
    (error: unknown) => error instanceof TeamFollowUpScheduleError && error.status === 409);
  assert.throws(() => teamBatchFollowUpScope([changed, changed], issues, [dependency]),
    (error: unknown) => error instanceof TeamFollowUpScheduleError && error.status === 400);

  const cycle = teamBatchFollowUpScope([changed], issues, [dependency, edge(downstream, root)]);
  assert.deepEqual(calculateTeamFollowUpSchedule(cycle, calendar, terminal), {
    changes: [], warnings: [], blocking: ['후행 업무에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.'],
  });

  const incomplete = teamBatchFollowUpScope([changed], issues, [dependency]);
  const result = calculateTeamFollowUpSchedule(incomplete, calendar, terminal);
  assert.deepEqual(result.changes.map(change => change.id), [root.id]);
  assert.ok(result.blocking.some(message => message.includes(`${downstream.key} · 시작일과 종료일을 입력`)));
});
