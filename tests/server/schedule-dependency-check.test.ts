import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalendarMath, defaultWorkCalendar } from '../../shared/calendar.js';
import { checkDependencySchedule, dependencyScheduleWarning } from '../../shared/schedule-dependencies.js';
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
