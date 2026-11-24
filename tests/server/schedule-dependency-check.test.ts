import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarError, createCalendarMath, defaultWorkCalendar, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from '../../shared/calendar.js';
import { TEAM_BLOCKER_SCHEDULE_RULE, checkDependencySchedule, checkTeamBlockerSchedule, dependencyPredecessorBound, dependencyScheduleWarning } from '../../shared/schedule-dependencies.js';
import type { DependencyType } from '../../shared/types.js';

const predecessor = { key: 'TEAM-1', startDate: '2026-11-19', endDate: '2026-11-20' };
const successor = { key: 'TEAM-2', startDate: '2026-11-17', endDate: '2026-11-18' };
const projectCalendar = defaultWorkCalendar('project-team');
const math = createCalendarMath(projectCalendar);

test('dependency checks report the exact endpoint dates and required bound for each relationship', () => {
  const cases = [
    ['FS', 'endDate', 'startDate', '2026-11-23'],
    ['SS', 'startDate', 'startDate', '2026-11-19'],
    ['FF', 'endDate', 'endDate', '2026-11-20'],
    ['SF', 'startDate', 'endDate', '2026-11-19'],
  ] as const;

  for (const [type, predecessorEndpoint, successorEndpoint, requiredDate] of cases) {
    const dependency = { type, lagDays: 0 };
    assert.deepEqual(checkDependencySchedule(dependency, predecessor, successor, math), {
      kind: 'conflict', predecessorEndpoint, successorEndpoint,
      predecessorDate: predecessor[predecessorEndpoint], successorDate: successor[successorEndpoint], requiredDate,
    });
    const onBound = { ...successor, [successorEndpoint]: requiredDate };
    const afterBound = { ...successor, [successorEndpoint]: '2026-11-24' };
    assert.deepEqual(checkDependencySchedule(dependency, predecessor, onBound, math), { kind: 'valid' });
    assert.deepEqual(checkDependencySchedule(dependency, predecessor, afterBound, math), { kind: 'valid' });
    assert.equal(dependencyScheduleWarning(dependency, predecessor, onBound, math), null);
  }
});

test('FS inclusive timing and signed lag honor project working-day overrides', () => {
  const exceptionMath = createCalendarMath({ ...projectCalendar, exceptions: [
    { date: '2026-11-21', isWorking: true, label: '특별 근무' },
    { date: '2026-11-23', isWorking: false, label: '휴무' },
  ] });
  for (const [lagDays, requiredDate] of [[0, '2026-11-21'], [1, '2026-11-24'], [-1, '2026-11-20'], [-2, '2026-11-19']] as const) {
    assert.deepEqual(checkDependencySchedule({ type: 'FS', lagDays }, predecessor, successor, exceptionMath), {
      kind: 'conflict', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate',
      predecessorDate: predecessor.endDate, successorDate: successor.startDate, requiredDate,
    });
  }
  assert.equal(dependencyScheduleWarning({ type: 'FS', lagDays: 1 }, predecessor, successor, exceptionMath),
    'TEAM-1 → TEAM-2 · 선행 업무 종료 후 시작 (FS, +1근무일) 조건에 따라 후행 업무 시작일은 2026-11-24 이후여야 합니다.');
  assert.equal(dependencyScheduleWarning({ type: 'SF', lagDays: -1 }, predecessor, { ...successor, endDate: '2026-11-17' }, math),
    'TEAM-1 → TEAM-2 · 시작 후 완료 (SF, -1근무일) 조건에 따라 후행 업무 종료일은 2026-11-18 이후여야 합니다.');
});

test('missing endpoint dates identify the correct fields without changing legacy warnings', () => {
  const dependency = { type: 'FS', lagDays: 0 } as const;
  const noEnd = { ...predecessor, endDate: null };
  const noStart = { ...successor, startDate: null };
  for (const [before, after] of [[noEnd, successor], [predecessor, noStart], [noEnd, noStart]]) {
    assert.deepEqual(checkDependencySchedule(dependency, before, after, math), {
      kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate',
      predecessorDate: before.endDate, successorDate: after.startDate,
    });
    assert.equal(dependencyScheduleWarning(dependency, before, after, math), null);
  }
});

test('team blockers use the receiving calendar for conflicts and a missing successor start', () => {
  const receivingMath = createCalendarMath({ ...defaultWorkCalendar('receiving-project'), exceptions: [
    { date: '2026-11-23', isWorking: false, label: '후행 프로젝트 휴무일' },
  ] });
  const onSourceCalendar = { ...successor, startDate: '2026-11-23', endDate: '2026-11-25' };
  const missingStart = { ...onSourceCalendar, startDate: null };
  assert.deepEqual(TEAM_BLOCKER_SCHEDULE_RULE, { type: 'FS', lagDays: 0 });
  assert.deepEqual(checkTeamBlockerSchedule(predecessor, onSourceCalendar, math), { kind: 'valid' });
  assert.deepEqual(checkTeamBlockerSchedule(predecessor, onSourceCalendar, receivingMath), {
    kind: 'conflict', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate',
    predecessorDate: predecessor.endDate, successorDate: '2026-11-23', requiredDate: '2026-11-24',
  });
  assert.deepEqual(checkTeamBlockerSchedule(predecessor, { ...onSourceCalendar, startDate: '2026-11-24' }, receivingMath), { kind: 'valid' });
  assert.deepEqual(checkTeamBlockerSchedule(predecessor, missingStart, receivingMath), {
    kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate',
    predecessorDate: predecessor.endDate, successorDate: null, requiredDate: '2026-11-24',
  });
  const missingEnd = { ...predecessor, endDate: null };
  for (const next of [onSourceCalendar, missingStart]) {
    assert.deepEqual(checkTeamBlockerSchedule(missingEnd, next, receivingMath), {
      kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate', predecessorDate: null, successorDate: next.startDate,
    });
  }
  assert.deepEqual(checkDependencySchedule(TEAM_BLOCKER_SCHEDULE_RULE, predecessor, missingStart, receivingMath), {
    kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate', predecessorDate: predecessor.endDate, successorDate: null,
  });
});

test('team blockers preserve missing starts when a calendar bound is unavailable and rethrow other failures', () => {
  const missingStart = { ...successor, startDate: null };
  const last = { ...predecessor, endDate: MAX_CALENDAR_DATE };
  assert.deepEqual(checkTeamBlockerSchedule(last, missingStart, math), {
    kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate', predecessorDate: MAX_CALENDAR_DATE, successorDate: null,
  });
  assert.deepEqual(checkTeamBlockerSchedule(last, successor, math), {
    kind: 'invalid', reason: '이후에 필요한 작업일이 없거나 날짜 범위를 벗어났습니다.',
  });
  const sevenDays = createCalendarMath({ ...projectCalendar, workingWeekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(checkTeamBlockerSchedule({ ...predecessor, endDate: MIN_CALENDAR_DATE }, missingStart, sevenDays), {
    kind: 'missing', predecessorEndpoint: 'endDate', successorEndpoint: 'startDate', predecessorDate: MIN_CALENDAR_DATE,
    successorDate: null, requiredDate: '0000-01-02',
  });
  const unexpected = new Error('unexpected calendar failure');
  const failingMath = { ...math, shift() { throw unexpected; } };
  assert.throws(() => checkTeamBlockerSchedule(predecessor, missingStart, failingMath), error => error === unexpected);
});

test('invalid dependency rules and calendar bounds retain their prior warnings', () => {
  const ruleReason = '업무 연결 종류와 간격을 확인해 주세요.';
  for (const dependency of [{ type: 'unsupported' as DependencyType, lagDays: 0 }, { type: 'FF' as const, lagDays: 3651 }]) {
    assert.deepEqual(checkDependencySchedule(dependency, predecessor, successor, math), { kind: 'invalid', reason: ruleReason });
    assert.equal(dependencyScheduleWarning(dependency, predecessor, successor, math), `TEAM-1 → TEAM-2 · ${ruleReason}`);
  }

  const dateReason = '이후에 필요한 작업일이 없거나 날짜 범위를 벗어났습니다.';
  const endOfRange = { ...predecessor, endDate: '9999-12-31' };
  const dependency = { type: 'FS', lagDays: 0 } as const;
  assert.deepEqual(checkDependencySchedule(dependency, endOfRange, successor, math), { kind: 'invalid', reason: dateReason });
  assert.equal(dependencyScheduleWarning(dependency, endOfRange, successor, math), `TEAM-1 → TEAM-2 · ${dateReason}`);
  assert.equal(dependencyScheduleWarning(dependency, endOfRange, { ...successor, startDate: null }, math), null);
});

test('new predecessor suggestions invert every connection using the participating successor endpoint', () => {
  const fixed = { startDate: '2026-11-23', endDate: '2026-11-25' };
  const cases = [
    ['FS', 0, 'endDate', '2026-11-20'],
    ['SS', 1, 'startDate', '2026-11-20'],
    ['FF', -1, 'endDate', '2026-11-26'],
    ['SF', 2, 'startDate', '2026-11-23'],
  ] as const;
  for (const [type, lagDays, endpoint, date] of cases) {
    const rule = { type, lagDays };
    const next = math.shift(date, 1);
    assert.deepEqual(dependencyPredecessorBound(rule, fixed, math), { endpoint, date });
    assert.deepEqual(checkDependencySchedule(rule, { startDate: date, endDate: date }, fixed, math), { kind: 'valid' });
    assert.equal(checkDependencySchedule(rule, { startDate: next, endDate: next }, fixed, math).kind, 'conflict');
  }

  assert.equal(dependencyPredecessorBound({ type: 'SS', lagDays: 0 }, { ...fixed, startDate: null }, math), null);
  assert.equal(dependencyPredecessorBound({ type: 'FF', lagDays: 0 }, { ...fixed, endDate: null }, math), null);
});

test('new predecessor suggestions floor a fixed nonworking date and use project calendar exceptions', () => {
  const exceptionMath = createCalendarMath({ ...projectCalendar, exceptions: [
    { date: '2026-11-21', isWorking: true, label: '특별 근무' },
    { date: '2026-11-23', isWorking: false, label: '휴무' },
  ] });
  const fixed = { startDate: '2026-11-23', endDate: '2026-11-23' };
  const cases = [
    ['FS', 1, '2026-11-19'],
    ['FS', 0, '2026-11-20'],
    ['FS', -1, '2026-11-21'],
    ['SS', 0, '2026-11-21'],
    ['SF', -2, '2026-11-25'],
  ] as const;
  for (const [type, lagDays, date] of cases) {
    const rule = { type, lagDays };
    const next = exceptionMath.shift(date, 1);
    assert.equal(dependencyPredecessorBound(rule, fixed, exceptionMath)?.date, date);
    assert.equal(checkDependencySchedule(rule, { startDate: date, endDate: date }, fixed, exceptionMath).kind, 'valid');
    assert.equal(checkDependencySchedule(rule, { startDate: next, endDate: next }, fixed, exceptionMath).kind, 'conflict');
  }
});

test('new predecessor suggestions honor the first and last supported calendar years', () => {
  const continuousMath = createCalendarMath({ ...projectCalendar, workingWeekdays: [0, 1, 2, 3, 4, 5, 6] });
  const first = { startDate: MIN_CALENDAR_DATE, endDate: MIN_CALENDAR_DATE };
  const last = { startDate: MAX_CALENDAR_DATE, endDate: MAX_CALENDAR_DATE };
  const fs = { type: 'FS', lagDays: 0 } as const;
  assert.throws(() => dependencyPredecessorBound(fs, first, continuousMath), CalendarError);
  assert.deepEqual(dependencyPredecessorBound(fs, { ...first, startDate: '0000-01-02' }, continuousMath),
    { endpoint: 'endDate', date: MIN_CALENDAR_DATE });
  assert.deepEqual(dependencyPredecessorBound({ ...fs, lagDays: -1 }, first, continuousMath),
    { endpoint: 'endDate', date: MIN_CALENDAR_DATE });
  const leads = { type: 'FF', lagDays: -2 } as const;
  const priorToLast = { ...last, endDate: '9999-12-30' };
  assert.deepEqual(dependencyPredecessorBound(leads, priorToLast, continuousMath),
    { endpoint: 'endDate', date: MAX_CALENDAR_DATE });
  assert.deepEqual(checkDependencySchedule(leads, last, priorToLast, continuousMath), { kind: 'valid' });
});
