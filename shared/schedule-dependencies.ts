import { CalendarError, type createCalendarMath } from './calendar.js';
import type { Dependency, DependencyType } from './types.js';

export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export const MAX_DEPENDENCY_LAG_DAYS = 3650;

type ScheduleDate = 'startDate' | 'endDate';
type ScheduleDates = Record<ScheduleDate, string | null>;
type KeyedScheduleDates = ScheduleDates & { key: string };
type DependencyRule = Pick<Dependency, 'type' | 'lagDays'>;
type CalendarMath = ReturnType<typeof createCalendarMath>;

export const DEPENDENCY_ENDPOINTS = {
  FS: { predecessor: 'endDate', successor: 'startDate' },
  SS: { predecessor: 'startDate', successor: 'startDate' },
  FF: { predecessor: 'endDate', successor: 'endDate' },
  SF: { predecessor: 'startDate', successor: 'endDate' },
} as const satisfies Record<DependencyType, { predecessor: ScheduleDate; successor: ScheduleDate }>;

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

/** Inclusive dates make the first working day after the predecessor the FS zero-lag bound. */
export function dependencyBound(dependency: DependencyRule, predecessor: ScheduleDates, math: CalendarMath) {
  const endpoints = DEPENDENCY_ENDPOINTS[dependency.type];
  const anchor = predecessor[endpoints.predecessor];
  if (!anchor) return null;
  return { endpoint: endpoints.successor, date: math.shift(anchor, dependency.lagDays + Number(dependency.type === 'FS')) };
}

/** Manual schedules retain their dates and show a warning only when both dates are known. */
export function dependencyScheduleWarning(
  dependency: DependencyRule, predecessor: KeyedScheduleDates, successor: KeyedScheduleDates, math: CalendarMath,
): string | null {
  const keyPair = `${predecessor.key} → ${successor.key}`;
  if (!isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) {
    return `${keyPair} · 업무 연결 종류와 간격을 확인해 주세요.`;
  }
  const actual = successor[DEPENDENCY_ENDPOINTS[dependency.type].successor];
  if (!actual) return null;
  try {
    const bound = dependencyBound(dependency, predecessor, math);
    if (!bound || actual >= bound.date) return null;
    const label = dependency.type === 'FS' ? '선행 업무 종료 후 시작' : DEPENDENCY_LABELS[dependency.type];
    const lag = dependency.lagDays > 0 ? `+${dependency.lagDays}` : String(dependency.lagDays);
    return `${keyPair} · ${label} (${dependency.type}, ${lag}근무일) 조건에 따라 후행 업무 ${SCHEDULE_DATE_LABELS[bound.endpoint]}은 ${bound.date} 이후여야 합니다.`;
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    return `${keyPair} · ${error.message}`;
  }
}

export function dependencyGuardFields(dependency: Dependency) {
  const { id, predecessorId, successorId, type, lagDays, version = 1 } = dependency;
  const fields = [id, predecessorId, successorId, type, lagDays] as const;
  // Version 1 uses the original guard shape, including existing unstamped dependencies.
  return version === 1 ? fields : [...fields, version] as const;
}
