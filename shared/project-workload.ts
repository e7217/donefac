import { calendarDate, calendarDay, createCalendarMath, defaultWorkCalendar, isCalendarDate } from './calendar.js';
import type {
  Issue,
  ProjectWorkloadCapacity,
  ProjectWorkloadDay,
  ProjectWorkloadResult,
  ProjectWorkloadRow,
  TeamWorkloadAllocation,
  TeamWorkloadCapacity,
  TeamWorkloadResult,
  WorkloadAllocation,
  WorkCalendar,
  WorkloadIncompleteReason,
} from './types.js';

export const DEFAULT_DAILY_WORKLOAD_MINUTES = 480;
export const MAX_DAILY_WORKLOAD_MINUTES = 1440;
export const MAX_PLANNED_EFFORT_MINUTES = 1_000_000;
export const MAX_WORKLOAD_DAYS = 180;
export const MAX_TEAM_WORKLOAD_PROJECTS = 100;
export const MAX_TEAM_WORKLOAD_ISSUES = 10_000;
const MAX_TEAM_WORKLOAD_CELLS = 36_000;
const MAX_TEAM_WORKLOAD_ALLOCATIONS = 100_000;

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

export type WorkloadIssue = Pick<Issue, 'id' | 'projectId' | 'status' | 'assigneeId' | 'startDate' | 'endDate' | 'plannedEffortMinutes'>;

type WorkloadScope = {
  calendar: WorkCalendar;
  issues: readonly WorkloadIssue[];
  terminalStatusIds: ReadonlySet<string> | readonly string[];
};

type WorkloadQuery = { startDate: unknown; endDate: unknown; userIds: readonly string[] };

export function validateWorkloadRange(startDate: unknown, endDate: unknown) {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
    throw new WorkloadError(400, '업무량 조회의 시작일과 종료일을 확인해 주세요.');
  }
  const startDay = calendarDay(startDate);
  const span = calendarDay(endDate) - startDay + 1;
  if (span > MAX_WORKLOAD_DAYS) {
    throw new WorkloadError(400, `업무량은 한 번에 최대 ${MAX_WORKLOAD_DAYS}일까지 조회할 수 있습니다.`);
  }
  return { startDate, endDate, startDay, span };
}

function workloadRange(start: unknown, end: unknown) {
  const { startDate, endDate, startDay, span } = validateWorkloadRange(start, end);
  return { startDate, endDate, dates: Array.from({ length: span }, (_, index) => calendarDate(startDay + index)) };
}

function workloadRows<Allocation extends WorkloadAllocation>(
  days: readonly ProjectWorkloadDay[],
  capacity: Pick<ProjectWorkloadCapacity, 'members' | 'exceptions' | 'defaultDailyMinutes'>,
  userIds: readonly string[],
  useOverridesOnNonWorkingDays: boolean,
): Map<string, ProjectWorkloadRow<Allocation>> {
  const dailyMinutes = new Map(capacity.members.map(member => [member.userId, member.dailyMinutes]));
  const dateOverrides = new Map<string, Map<string, number>>();
  for (const { userId, date, availableMinutes } of capacity.exceptions) {
    const overrides = dateOverrides.get(userId) ?? new Map<string, number>();
    overrides.set(date, availableMinutes);
    dateOverrides.set(userId, overrides);
  }
  return new Map([...new Set(userIds)].map(userId => {
    const available = dailyMinutes.get(userId) ?? capacity.defaultDailyMinutes;
    const overrides = dateOverrides.get(userId);
    return [userId, {
      userId,
      scheduledMinutes: 0,
      availableMinutes: 0,
      overloadedDays: 0,
      days: days.map(({ date, working }) => ({
        date,
        scheduledMinutes: 0,
        availableMinutes: (working || useOverridesOnNonWorkingDays ? overrides?.get(date) : undefined) ?? (working ? available : 0),
        allocations: [],
      })),
    }];
  }));
}

function allocateIssues<Allocation extends WorkloadAllocation>(
  { calendar, issues, terminalStatusIds }: WorkloadScope,
  { startDate, endDate }: ReturnType<typeof workloadRange>,
  days: readonly ProjectWorkloadDay[],
  math: ReturnType<typeof createCalendarMath>,
  memberRows: ReadonlyMap<string, ProjectWorkloadRow<Allocation>>,
  reportIncomplete: (issue: WorkloadIssue, reasons: WorkloadIncompleteReason[]) => void,
  allocation: (issue: WorkloadIssue, minutes: number) => Allocation,
) {
  const workingDays = days.flatMap((day, index) => day.working ? [{ date: day.date, index }] : []);
  const terminal = new Set(terminalStatusIds);

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
    if (reasons.length > 0) reportIncomplete(issue, reasons);

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
      cell.allocations.push(allocation(issue, minutes));
    }
  }
}

function sumWorkload(rows: readonly ProjectWorkloadRow[]) {
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
  return { totalScheduledMinutes, totalAvailableMinutes, overloadedCells };
}

export function calculateProjectWorkload(input: WorkloadQuery & WorkloadScope & { capacity: ProjectWorkloadCapacity }): ProjectWorkloadResult {
  const { calendar, capacity, userIds } = input;
  const range = workloadRange(input.startDate, input.endDate);
  if (capacity.projectId !== calendar.projectId) {
    throw new WorkloadError(400, '작업 달력과 가용 시간의 프로젝트가 일치하지 않습니다.');
  }
  const math = createCalendarMath(calendar);
  const days = range.dates.map(date => ({ date, working: math.isWorking(date) }));
  const memberRows = workloadRows<WorkloadAllocation>(days, capacity, userIds, false);
  const incomplete: ProjectWorkloadResult['incomplete'] = [];
  allocateIssues(input, range, days, math, memberRows, (issue, reasons) => incomplete.push({ issueId: issue.id, reasons }),
    (issue, minutes) => ({ issueId: issue.id, minutes }));
  const rows = [...memberRows.values()];
  return { startDate: range.startDate, endDate: range.endDate, days, rows, incomplete, ...sumWorkload(rows) };
}

export function calculateTeamWorkload({
  startDate, endDate, userIds, capacity, projects,
}: WorkloadQuery & { capacity: TeamWorkloadCapacity; projects: readonly WorkloadScope[] }): TeamWorkloadResult {
  const range = workloadRange(startDate, endDate);
  const projectIds = projects.map(project => project.calendar.projectId);
  if (projects.length > MAX_TEAM_WORKLOAD_PROJECTS || new Set(projectIds).size !== projectIds.length) {
    throw new WorkloadError(400, `작업량 조회 프로젝트는 중복 없이 최대 ${MAX_TEAM_WORKLOAD_PROJECTS}개를 선택해 주세요.`);
  }
  if (new Set(userIds).size * range.dates.length > MAX_TEAM_WORKLOAD_CELLS) {
    throw new WorkloadError(422, '팀원별 날짜 칸이 너무 많습니다. 조회 기간을 줄여 주세요.');
  }
  if (projects.reduce((total, project) => total + project.issues.length, 0) > MAX_TEAM_WORKLOAD_ISSUES) {
    throw new WorkloadError(422, `작업량 조회는 최대 ${MAX_TEAM_WORKLOAD_ISSUES.toLocaleString('ko-KR')}개 업무를 처리합니다. 프로젝트를 줄여 주세요.`);
  }
  const teamCalendar = createCalendarMath({ ...defaultWorkCalendar('team'),
    workingWeekdays: capacity.workingWeekdays, exceptions: capacity.calendarExceptions });
  const days = range.dates.map(date => ({ date, working: teamCalendar.isWorking(date) }));
  const memberRows = workloadRows<TeamWorkloadAllocation>(days, capacity, userIds, true);
  const incomplete: TeamWorkloadResult['incomplete'] = [];
  let allocationCount = 0;
  for (const project of projects) {
    const math = createCalendarMath(project.calendar);
    const projectDays = range.dates.map(date => ({ date, working: math.isWorking(date) }));
    allocateIssues(project, range, projectDays, math, memberRows,
      (issue, reasons) => incomplete.push({ issueId: issue.id, projectId: issue.projectId, reasons }), (issue, minutes) => {
        if (++allocationCount > MAX_TEAM_WORKLOAD_ALLOCATIONS) {
          throw new WorkloadError(422, '날짜별 업무 배정이 너무 많습니다. 조회 기간이나 프로젝트를 줄여 주세요.');
        }
        return { issueId: issue.id, projectId: issue.projectId, minutes };
      });
  }
  const rows = [...memberRows.values()];
  return {
    startDate: range.startDate, endDate: range.endDate, days, rows, incomplete, projectIds, capacityVersion: capacity.version,
    ...sumWorkload(rows),
  };
}
