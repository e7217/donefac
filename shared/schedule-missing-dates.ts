import {
  calculateWorkingDateRange, CalendarError, MAX_WORKING_DURATION_DAYS, MIN_CALENDAR_DATE,
  type createCalendarMath,
} from './calendar.js';
import {
  checkDependencySchedule, dependencyBound, DEPENDENCY_ENDPOINTS, isDependencyLag, isDependencyType,
  SCHEDULE_DATE_LABELS, type ScheduleDependencyEndpoint,
} from './schedule-dependencies.js';
import type { Dependency, Issue } from './types.js';

type ScheduleDates = Record<ScheduleDependencyEndpoint, string | null>;
type CompleteScheduleDates = Record<ScheduleDependencyEndpoint, string>;
type CalendarMath = ReturnType<typeof createCalendarMath>;

export type MissingScheduleLink = Pick<Dependency, 'type' | 'lagDays'> & {
  role: 'predecessor' | 'successor';
  other: Pick<Issue, 'key' | 'startDate' | 'endDate'>;
};

export type MissingScheduleSuggestion = {
  dates: CompleteScheduleDates | null;
  pendingKeys: string[];
  conflicts: string[];
};

type MissingScheduleInput = ScheduleDates & {
  notBefore: string;
  workingDays: number;
  links: readonly MissingScheduleLink[];
  calendarMath: CalendarMath;
};

function constrain(dates: ScheduleDates, field: ScheduleDependencyEndpoint, date: string) {
  if (!dates[field] || dates[field] < date) dates[field] = date;
}

function earliestRange(notBefore: string, workingDays: number, lower: ScheduleDates, math: CalendarMath): CompleteScheduleDates {
  const baseline = math.onOrAfter(notBefore);
  const earliestStart = lower.startDate && lower.startDate > baseline ? math.onOrAfter(lower.startDate) : baseline;
  const range = calculateWorkingDateRange(math, 'startDate', earliestStart, workingDays);
  if (!lower.endDate || range.endDate >= lower.endDate) return range;
  return calculateWorkingDateRange(math, 'endDate', math.onOrAfter(lower.endDate), workingDays);
}

/** Computes the earliest range with working dates for blank endpoints, retaining any dates already entered. */
export function suggestMissingScheduleDates({ startDate, endDate, notBefore, workingDays, links, calendarMath }: MissingScheduleInput): MissingScheduleSuggestion {
  const pendingKeys = new Set<string>();
  const conflicts: string[] = [];
  const finish = (dates: CompleteScheduleDates | null) => ({ dates, pendingKeys: [...pendingKeys], conflicts });
  const lower: ScheduleDates = { startDate: null, endDate: null };
  const knownLinks: MissingScheduleLink[] = [];
  for (const link of links) {
    const { type, lagDays, other, role } = link;
    if (!isDependencyType(type) || !isDependencyLag(lagDays)) {
      conflicts.push(`${other.key} · 업무 연결 종류와 간격을 확인해 주세요.`);
      continue;
    }
    const endpoints = DEPENDENCY_ENDPOINTS[type];
    if (!other[endpoints[role]]) {
      pendingKeys.add(other.key);
      continue;
    }
    knownLinks.push(link);
    if (startDate || endDate) continue;
    try {
      if (role === 'predecessor') {
        const bound = dependencyBound(link, other, calendarMath);
        if (bound) constrain(lower, bound.endpoint, bound.date);
      } else {
        // A negative effective lag needs enough earlier workdays to be representable.
        const offset = lagDays + Number(type === 'FS');
        if (offset < 0) {
          const firstWorkingDay = calendarMath.onOrAfter(MIN_CALENDAR_DATE);
          constrain(lower, endpoints.predecessor, calendarMath.shift(firstWorkingDay, -offset));
        }
      }
    } catch (error) {
      if (!(error instanceof CalendarError)) throw error;
      conflicts.push(`${other.key} · ${error.message}`);
    }
  }
  if (!Number.isSafeInteger(workingDays) || workingDays < 1 || workingDays > MAX_WORKING_DURATION_DAYS) {
    conflicts.push('근무일 수는 1~3,650 사이의 정수여야 합니다.');
  }
  if (conflicts.length) return finish(null);

  let dates: CompleteScheduleDates;
  try {
    if (startDate && endDate) {
      if (calendarMath.count(startDate, endDate) !== workingDays) {
        conflicts.push('입력한 시작일과 종료일의 근무일 수가 제안 기간과 다릅니다.');
        return finish(null);
      }
      dates = { startDate, endDate };
    } else if (startDate) dates = calculateWorkingDateRange(calendarMath, 'startDate', startDate, workingDays);
    else if (endDate) dates = calculateWorkingDateRange(calendarMath, 'endDate', endDate, workingDays);
    else dates = earliestRange(notBefore, workingDays, lower, calendarMath);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    conflicts.push(error.message);
    return finish(null);
  }

  for (const link of knownLinks) {
    const { role, other } = link;
    const check = role === 'predecessor'
      ? checkDependencySchedule(link, other, dates, calendarMath)
      : checkDependencySchedule(link, dates, other, calendarMath);
    if (check.kind === 'invalid') conflicts.push(`${other.key} · ${check.reason}`);
    if (check.kind !== 'conflict') continue;
    const successorLabel = SCHEDULE_DATE_LABELS[check.successorEndpoint];
    if (role === 'predecessor') {
      conflicts.push(`${other.key} 선행 조건에 따라 ${successorLabel}은 ${check.requiredDate} 이후여야 합니다.`);
    } else {
      const predecessorLabel = SCHEDULE_DATE_LABELS[check.predecessorEndpoint];
      conflicts.push(`${other.key} 후행 업무 ${successorLabel} ${check.successorDate}에 맞추려면 현재 업무 ${predecessorLabel}을 ${check.predecessorDate}보다 앞당겨야 합니다.`);
    }
  }
  return finish(conflicts.length ? null : dates);
}
