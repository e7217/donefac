import { calendarDate, calendarDay, createCalendarMath, isCalendarDate } from './calendar.js';
import type {
  Issue,
  ProjectWorkloadCapacity,
  ProjectWorkloadResult,
  ProjectWorkloadRow,
  WorkCalendar,
  WorkloadIncompleteReason,
} from './types.js';

export const DEFAULT_DAILY_WORKLOAD_MINUTES = 480;
export const MAX_DAILY_WORKLOAD_MINUTES = 1440;
export const MAX_PLANNED_EFFORT_MINUTES = 1_000_000;
export const MAX_WORKLOAD_DAYS = 180;

export class WorkloadError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

function isEffortMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PLANNED_EFFORT_MINUTES;
}

export function validatePlannedEffortMinutes(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isEffortMinutes(value)) {
    throw new WorkloadError(400, '계획 작업 시간은 0~1,000,000 사이의 정수 분으로 입력해 주세요.');
  }
  return value;
}

export function defaultWorkloadCapacity(projectId: string, updatedAt?: string): ProjectWorkloadCapacity {
  return {
    id: projectId,
    projectId,
    version: 1,
    updatedAt: typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt)) ? updatedAt : '1970-01-01T00:00:00.000Z',
    defaultDailyMinutes: DEFAULT_DAILY_WORKLOAD_MINUTES,
    members: [],
    exceptions: [],
  };
}

type WorkloadInput = {
  startDate: unknown;
  endDate: unknown;
  calendar: WorkCalendar;
  capacity: ProjectWorkloadCapacity;
  userIds: readonly string[];
  issues: readonly Issue[];
  terminalStatusIds: ReadonlySet<string> | readonly string[];
};

export function calculateProjectWorkload({
  startDate, endDate, calendar, capacity, userIds, issues, terminalStatusIds,
}: WorkloadInput): ProjectWorkloadResult {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
    throw new WorkloadError(400, '업무량 조회의 시작일과 종료일을 확인해 주세요.');
  }
  const startDay = calendarDay(startDate);
  const span = calendarDay(endDate) - startDay + 1;
  if (span > MAX_WORKLOAD_DAYS) {
    throw new WorkloadError(400, `업무량은 한 번에 최대 ${MAX_WORKLOAD_DAYS}일까지 조회할 수 있습니다.`);
  }
  if (capacity.projectId !== calendar.projectId) {
    throw new WorkloadError(400, '작업 달력과 가용 시간의 프로젝트가 일치하지 않습니다.');
  }

  const math = createCalendarMath(calendar);
  const days = Array.from({ length: span }, (_, index) => {
    const date = calendarDate(startDay + index);
    return { date, working: math.isWorking(date) };
  });
  const workingDays = days.flatMap((day, index) => day.working ? [{ date: day.date, index }] : []);
  const dailyMinutes = new Map(capacity.members.map(member => [member.userId, member.dailyMinutes]));
  const dateOverrides = new Map<string, Map<string, number>>();
  for (const { userId, date, availableMinutes } of capacity.exceptions) {
    const overrides = dateOverrides.get(userId) ?? new Map<string, number>();
    overrides.set(date, availableMinutes);
    dateOverrides.set(userId, overrides);
  }
  const rows: ProjectWorkloadRow[] = [...new Set(userIds)].map(userId => {
    const available = dailyMinutes.get(userId) ?? capacity.defaultDailyMinutes;
    const overrides = dateOverrides.get(userId);
    return {
      userId,
      scheduledMinutes: 0,
      availableMinutes: 0,
      overloadedDays: 0,
      days: days.map(({ date, working }) => ({
        date,
        scheduledMinutes: 0,
        availableMinutes: working ? overrides?.get(date) ?? available : 0,
        allocations: [],
      })),
    };
  });
  const memberRows = new Map(rows.map(row => [row.userId, row]));
  const terminal = new Set(terminalStatusIds);
  const incomplete: ProjectWorkloadResult['incomplete'] = [];

  for (const issue of issues) {
    if (issue.projectId !== calendar.projectId || terminal.has(issue.status)) continue;
    const from = isCalendarDate(issue.startDate) ? issue.startDate : null;
    const to = isCalendarDate(issue.endDate) ? issue.endDate : null;
    if ((from && from > endDate) || (to && to < startDate)) continue;

    const row = issue.assigneeId ? memberRows.get(issue.assigneeId) : undefined;
    const effort = issue.plannedEffortMinutes;
    const hasDates = from !== null && to !== null && from <= to;
    const workdays = hasDates ? math.count(from, to) : 0;
    const reasons: WorkloadIncompleteReason[] = [];
    if (!row) reasons.push('unassigned');
    if (!hasDates) reasons.push('missing-dates');
    if (!isEffortMinutes(effort)) reasons.push('missing-effort');
    if (hasDates && workdays === 0) reasons.push('no-working-days');
    if (reasons.length > 0) incomplete.push({ issueId: issue.id, reasons });

    if (!row || !hasDates || !workdays || !isEffortMinutes(effort) || effort === 0) continue;
    const first = workingDays.findIndex(day => day.date >= from);
    if (first === -1 || workingDays[first].date > to) continue;

    // Use the full issue's working days, including any before the display range, to place remainder minutes once.
    const firstDate = workingDays[first].date;
    let ordinal = firstDate === from ? 0 : math.count(from, calendarDate(calendarDay(firstDate) - 1));
    const quotient = Math.floor(effort / workdays);
    const remainder = effort % workdays;
    for (let index = first; index < workingDays.length && workingDays[index].date <= to; index++, ordinal++) {
      const minutes = quotient + Number(ordinal < remainder);
      if (minutes === 0) break;
      const cell = row.days[workingDays[index].index];
      cell.scheduledMinutes += minutes;
      cell.allocations.push({ issueId: issue.id, minutes });
    }
  }

  let totalScheduledMinutes = 0;
  let totalAvailableMinutes = 0;
  let overloadedCells = 0;
  for (const row of rows) {
    for (const cell of row.days) {
      row.scheduledMinutes += cell.scheduledMinutes;
      row.availableMinutes += cell.availableMinutes;
      if (cell.scheduledMinutes > cell.availableMinutes) row.overloadedDays++;
    }
    totalScheduledMinutes += row.scheduledMinutes;
    totalAvailableMinutes += row.availableMinutes;
    overloadedCells += row.overloadedDays;
  }
  return { startDate, endDate, days, rows, incomplete, totalScheduledMinutes, totalAvailableMinutes, overloadedCells };
}
