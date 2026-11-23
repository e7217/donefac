import { CalendarError, MAX_CALENDAR_DATE, type createCalendarMath } from './calendar.js';
import type { Dependency, DependencyType } from './types.js';

export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export const MAX_DEPENDENCY_LAG_DAYS = 3650;

export type ScheduleDependencyEndpoint = 'startDate' | 'endDate';
type ScheduleDates = Record<ScheduleDependencyEndpoint, string | null>;
type KeyedScheduleDates = ScheduleDates & { key: string };
type DependencyRule = Pick<Dependency, 'type' | 'lagDays'>;
type CalendarMath = ReturnType<typeof createCalendarMath>;

export type DependencyScheduleCheck =
  | { kind: 'valid' }
  | {
      kind: 'missing';
      predecessorEndpoint: ScheduleDependencyEndpoint;
      successorEndpoint: ScheduleDependencyEndpoint;
      predecessorDate: string | null;
      successorDate: string | null;
    }
  | {
      kind: 'conflict';
      predecessorEndpoint: ScheduleDependencyEndpoint;
      successorEndpoint: ScheduleDependencyEndpoint;
      predecessorDate: string;
      successorDate: string;
      requiredDate: string;
    }
  | { kind: 'invalid'; reason: string };

export const DEPENDENCY_ENDPOINTS = {
  FS: { predecessor: 'endDate', successor: 'startDate' },
  SS: { predecessor: 'startDate', successor: 'startDate' },
  FF: { predecessor: 'endDate', successor: 'endDate' },
  SF: { predecessor: 'startDate', successor: 'endDate' },
} as const satisfies Record<DependencyType, { predecessor: ScheduleDependencyEndpoint; successor: ScheduleDependencyEndpoint }>;

export const DEPENDENCY_LABELS = {
  FS: '완료 후 시작',
  SS: '시작 후 시작',
  FF: '완료 후 완료',
  SF: '시작 후 완료',
} as const satisfies Record<DependencyType, string>;

export const SCHEDULE_DATE_LABELS = { startDate: '시작일', endDate: '종료일' } as const;

export function isDependencyType(value: unknown): value is DependencyType {
  return DEPENDENCY_TYPES.some(type => type === value);
}

export function isDependencyLag(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_DEPENDENCY_LAG_DAYS;
}

function workdayOffset(dependency: DependencyRule) {
  return dependency.lagDays + Number(dependency.type === 'FS');
}

/** Inclusive dates make the first working day after the predecessor the FS zero-lag bound. */
export function dependencyBound(dependency: DependencyRule, predecessor: ScheduleDates, math: CalendarMath) {
  const endpoints = DEPENDENCY_ENDPOINTS[dependency.type];
  const anchor = predecessor[endpoints.predecessor];
  if (!anchor) return null;
  return { endpoint: endpoints.successor, date: math.shift(anchor, workdayOffset(dependency)) };
}

/** Latest working predecessor endpoint that satisfies the stored successor date. */
export function dependencyPredecessorBound(dependency: DependencyRule, successor: ScheduleDates, math: CalendarMath) {
  const endpoints = DEPENDENCY_ENDPOINTS[dependency.type];
  const anchor = successor[endpoints.successor];
  if (!anchor) return null;
  const workingAnchor = math.isWorking(anchor) ? anchor : math.shift(anchor, -1);
  const inverse = -workdayOffset(dependency);
  // A negative lag can put the exact boundary beyond the last representable workday.
  const offset = inverse > 0 && Number.isSafeInteger(inverse)
    ? Math.min(inverse, math.count(workingAnchor, MAX_CALENDAR_DATE) - 1) : inverse;
  return { endpoint: endpoints.predecessor, date: math.shift(workingAnchor, offset) };
}

export function checkDependencySchedule(
  dependency: DependencyRule, predecessor: ScheduleDates, successor: ScheduleDates, math: CalendarMath,
): DependencyScheduleCheck {
  if (!isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) {
    return { kind: 'invalid', reason: '업무 연결 종류와 간격을 확인해 주세요.' };
  }
  const { predecessor: predecessorEndpoint, successor: successorEndpoint } = DEPENDENCY_ENDPOINTS[dependency.type];
  const predecessorDate = predecessor[predecessorEndpoint] || null;
  const successorDate = successor[successorEndpoint] || null;
  if (!predecessorDate || !successorDate) {
    return { kind: 'missing', predecessorEndpoint, successorEndpoint, predecessorDate, successorDate };
  }
  try {
    const bound = dependencyBound(dependency, predecessor, math);
    if (!bound || successorDate >= bound.date) return { kind: 'valid' };
    return { kind: 'conflict', predecessorEndpoint, successorEndpoint, predecessorDate, successorDate, requiredDate: bound.date };
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    return { kind: 'invalid', reason: error.message };
  }
}

/** Manual schedules retain their dates and show a warning only when both dates are known. */
export function dependencyScheduleWarning(
  dependency: DependencyRule, predecessor: KeyedScheduleDates, successor: KeyedScheduleDates, math: CalendarMath,
): string | null {
  const check = checkDependencySchedule(dependency, predecessor, successor, math);
  if (check.kind === 'valid' || check.kind === 'missing') return null;
  const keyPair = `${predecessor.key} → ${successor.key}`;
  if (check.kind === 'invalid') return `${keyPair} · ${check.reason}`;
  const label = dependency.type === 'FS' ? '선행 업무 종료 후 시작' : DEPENDENCY_LABELS[dependency.type];
  const lag = dependency.lagDays > 0 ? `+${dependency.lagDays}` : String(dependency.lagDays);
  return `${keyPair} · ${label} (${dependency.type}, ${lag}근무일) 조건에 따라 후행 업무 ${SCHEDULE_DATE_LABELS[check.successorEndpoint]}은 ${check.requiredDate} 이후여야 합니다.`;
}

export function dependencyGuardFields(dependency: Dependency) {
  const { id, predecessorId, successorId, type, lagDays, version = 1 } = dependency;
  const fields = [id, predecessorId, successorId, type, lagDays] as const;
  // Version 1 uses the original guard shape, including existing unstamped dependencies.
  return version === 1 ? fields : [...fields, version] as const;
}
