import { CalendarError, createCalendarMath, isCalendarDate } from './calendar.js';
import { calculateProjectWorkload, MAX_PLANNED_EFFORT_MINUTES, validateWorkloadRange, WorkloadError } from './project-workload.js';
import { dependencyBound, isDependencyLag, isDependencyType } from './schedule-dependencies.js';
import type {
  Dependency, Issue, ProjectWorkflow, ProjectWorkloadCapacity, ProjectWorkloadResult, ScheduleChange,
  WorkCalendar, WorkloadLevelConflict, WorkloadLevelPlan, WorkloadLevelSummary,
} from './types.js';

export const MAX_WORKLOAD_LEVEL_ISSUES = 10_000;
export const MAX_WORKLOAD_LEVEL_DEPENDENCIES = 50_000;
export const MAX_WORKLOAD_LEVEL_CELLS = 36_000;
export const MAX_WORKLOAD_LEVEL_CHANGES = 1_000;
export const MAX_WORKLOAD_LEVEL_REMAINING = 60;
export const MAX_WORKLOAD_LEVEL_CONFLICT_ISSUES = 20;
const MAX_SEARCH_CHECKS = 2_000_000;
const MOVE_ORDER = { low: 0, medium: 1, high: 2, urgent: 3 } as const;

type Input = {
  startDate: string;
  endDate: string;
  calendar: WorkCalendar;
  capacity: ProjectWorkloadCapacity;
  workflow: ProjectWorkflow;
  issues: readonly Issue[];
  dependencies: readonly Dependency[];
  userIds: readonly string[];
  issueIds?: readonly string[];
};

type Dates = Pick<Issue, 'startDate' | 'endDate'>;
type WorkdayCell = { scheduled: number; available: number };
type MovableIssue = {
  issue: Issue;
  cells: WorkdayCell[];
  originalStart: number;
  duration: number;
  dailyMinutes: number;
  extraMinutes: number;
  latestEnd: string;
  dependencies: Dependency[];
};

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function excess(scheduled: number, available: number) {
  return Math.max(0, scheduled - available);
}

function summarize(workload: ProjectWorkloadResult, issues: readonly Issue[], projectId: string): WorkloadLevelSummary {
  let excessMinutes = 0;
  for (const row of workload.rows) {
    for (const cell of row.days) excessMinutes += excess(cell.scheduledMinutes, cell.availableMinutes);
  }
  let completionDate: string | null = null;
  for (const issue of issues) {
    if (issue.projectId === projectId && isCalendarDate(issue.endDate) && (!completionDate || issue.endDate > completionDate)) {
      completionDate = issue.endDate;
    }
  }
  return { overloadedCells: workload.overloadedCells, excessMinutes, completionDate };
}

function remainingConflicts(workload: ProjectWorkloadResult): WorkloadLevelConflict[] {
  const conflicts: WorkloadLevelConflict[] = [];
  for (const row of workload.rows) {
    for (const cell of row.days) {
      const excessMinutes = excess(cell.scheduledMinutes, cell.availableMinutes);
      if (excessMinutes === 0) continue;
      conflicts.push({ userId: row.userId, date: cell.date, excessMinutes,
        issueIds: cell.allocations.map(allocation => allocation.issueId).sort(compareText).slice(0, MAX_WORKLOAD_LEVEL_CONFLICT_ISSUES) });
      if (conflicts.length === MAX_WORKLOAD_LEVEL_REMAINING) return conflicts;
    }
  }
  return conflicts;
}

function workingIndex(dates: readonly string[], date: string) {
  let first = 0, last = dates.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (dates[middle] < date) first = middle + 1;
    else last = middle;
  }
  return first;
}

function incidentDependencies(issues: ReadonlyMap<string, Issue>, dependencies: readonly Dependency[]) {
  const byIssue = new Map<string, Dependency[]>();
  for (const dependency of dependencies) {
    for (const id of new Set([dependency.predecessorId, dependency.successorId])) {
      if (!issues.has(id)) continue;
      const existing = byIssue.get(id);
      if (existing) existing.push(dependency);
      else byIssue.set(id, [dependency]);
    }
  }
  return byIssue;
}

function linksPermit(
  candidate: MovableIssue, dates: Dates, effective: ReadonlyMap<string, Dates>,
  math: ReturnType<typeof createCalendarMath>,
) {
  for (const dependency of candidate.dependencies) {
    const predecessor = dependency.predecessorId === candidate.issue.id ? dates : effective.get(dependency.predecessorId);
    const successor = dependency.successorId === candidate.issue.id ? dates : effective.get(dependency.successorId);
    if (!predecessor || !successor || dependency.predecessorId === dependency.successorId ||
        !isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) return false;
    try {
      const bound = dependencyBound(dependency, predecessor, math);
      if (!bound) return false;
      const actual = successor[bound.endpoint];
      if (!isCalendarDate(actual) || actual < bound.date) return false;
    } catch (error) {
      if (!(error instanceof CalendarError)) throw error;
      return false;
    }
  }
  return true;
}

function minutesAt(candidate: MovableIssue, offset: number) {
  if (offset < 0 || offset >= candidate.duration) return 0;
  return candidate.dailyMinutes + Number(offset < candidate.extraMinutes);
}

function hasCurrentOverload(candidate: MovableIssue) {
  for (let offset = 0; offset < candidate.duration; offset++) {
    const cell = candidate.cells[candidate.originalStart + offset];
    if (minutesAt(candidate, offset) > 0 && cell.scheduled > cell.available) return true;
  }
  return false;
}

/** Check before modifying any cells, including offsets where the old and new spans overlap. */
function improvement(candidate: MovableIssue, next: number) {
  let reduction = 0;
  for (let offset = 0; offset < candidate.duration; offset++) {
    const position = next + offset;
    const cell = candidate.cells[position];
    const before = excess(cell.scheduled, cell.available);
    const after = excess(cell.scheduled - minutesAt(candidate, position - candidate.originalStart)
      + minutesAt(candidate, offset), cell.available);
    if (after > before) return 0;
    reduction += before - after;
  }
  const removedDays = Math.min(candidate.duration, next - candidate.originalStart);
  for (let offset = 0; offset < removedDays; offset++) {
    const cell = candidate.cells[candidate.originalStart + offset];
    reduction += Math.min(minutesAt(candidate, offset), excess(cell.scheduled, cell.available));
  }
  return reduction;
}

function move(candidate: MovableIssue, next: number) {
  for (let offset = 0; offset < candidate.duration; offset++) {
    const minutes = minutesAt(candidate, offset);
    candidate.cells[candidate.originalStart + offset].scheduled -= minutes;
    candidate.cells[next + offset].scheduled += minutes;
  }
}

/** Delay whole issues within one project's capacity and the selected date window. */
export function levelProjectWorkload(input: Input): WorkloadLevelPlan {
  const { issues, dependencies, calendar, capacity, workflow } = input;
  const range = validateWorkloadRange(input.startDate, input.endDate);
  if (workflow.projectId !== calendar.projectId || capacity.projectId !== calendar.projectId) {
    throw new WorkloadError(400, '작업 달력·워크플로·가용 시간의 프로젝트가 일치하지 않습니다.');
  }
  if (issues.length > MAX_WORKLOAD_LEVEL_ISSUES || dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES ||
      new Set(input.userIds).size * range.span > MAX_WORKLOAD_LEVEL_CELLS) {
    throw new WorkloadError(422, '일정 조정 범위가 너무 큽니다. 업무·연결 수 또는 팀원·기간을 줄여 주세요.');
  }
  const projectIssues = new Map(issues.filter(issue => issue.projectId === calendar.projectId).map(issue => [issue.id, issue]));
  const terminalStatusIds = workflow.statuses.filter(status => status.category === 'done' || status.category === 'cancelled').map(status => status.id);
  const workloadInput = { ...input, terminalStatusIds };
  const current = calculateProjectWorkload(workloadInput);
  const before = summarize(current, issues, calendar.projectId);
  if (before.excessMinutes === 0) return { changes: [], before, after: before, remaining: [] };

  const activeStatusIds = new Set(workflow.statuses.filter(status => status.category !== 'done' && status.category !== 'cancelled').map(status => status.id));
  const affected = new Set<string>();
  const rows = new Map<string, WorkdayCell[]>();
  const workingDays = current.days.flatMap(day => day.working ? [day.date] : []);
  for (const row of current.rows) {
    const cells: WorkdayCell[] = [];
    for (let index = 0; index < row.days.length; index++) {
      const cell = row.days[index];
      if (cell.scheduledMinutes > cell.availableMinutes) {
        for (const allocation of cell.allocations) affected.add(allocation.issueId);
      }
      if (current.days[index].working) cells.push({ scheduled: cell.scheduledMinutes, available: cell.availableMinutes });
    }
    rows.set(row.userId, cells);
  }

  const selected = input.issueIds && new Set(input.issueIds);
  const byDependency = incidentDependencies(projectIssues, dependencies);
  const math = createCalendarMath(calendar);
  const candidates: MovableIssue[] = [];
  for (const id of affected) {
    const issue = projectIssues.get(id);
    if (!issue || (selected && !selected.has(id)) || !issue.assigneeId || !activeStatusIds.has(issue.status)) continue;
    const { startDate, endDate, dueDate, plannedEffortMinutes } = issue;
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate < range.startDate ||
        startDate > endDate || endDate > range.endDate || (dueDate != null && !isCalendarDate(dueDate)) ||
        typeof plannedEffortMinutes !== 'number' || !Number.isSafeInteger(plannedEffortMinutes) ||
        plannedEffortMinutes <= 0 || plannedEffortMinutes > MAX_PLANNED_EFFORT_MINUTES) continue;
    const duration = math.count(startDate, endDate);
    if (duration === 0) continue;
    candidates.push({
      issue, cells: rows.get(issue.assigneeId)!, originalStart: workingIndex(workingDays, startDate), duration,
      dailyMinutes: Math.floor(plannedEffortMinutes / duration), extraMinutes: plannedEffortMinutes % duration,
      latestEnd: dueDate && dueDate < range.endDate ? dueDate : range.endDate,
      dependencies: byDependency.get(id) ?? [],
    });
  }
  candidates.sort((a, b) => MOVE_ORDER[a.issue.priority] - MOVE_ORDER[b.issue.priority]
    || compareText(a.issue.startDate!, b.issue.startDate!) || compareText(a.issue.key, b.issue.key) || compareText(a.issue.id, b.issue.id));

  const effective = new Map<string, Dates>(projectIssues);
  const moved = new Map<string, Dates>();
  const changes: ScheduleChange[] = [];
  let checksLeft = MAX_SEARCH_CHECKS;
  let excessLeft = before.excessMinutes;
  let reachedSearchLimit = false;
  // A later move can free capacity or add room before a fixed successor, so reconsider
  // previously blocked candidates after any successful pass. Each issue moves at most once.
  let movedThisPass: boolean;
  search: do {
    movedThisPass = false;
    for (const candidate of candidates) {
      const { issue, duration, originalStart, latestEnd } = candidate;
      if (moved.has(issue.id)) continue;
      checksLeft -= duration;
      if (checksLeft < 0) {
        reachedSearchLimit = true;
        break search;
      }
      if (!hasCurrentOverload(candidate)) continue;
      const nextWorkingStart = originalStart + Number(workingDays[originalStart] === issue.startDate);
      for (let next = nextWorkingStart; next + duration <= workingDays.length; next++) {
        const startDate = workingDays[next], endDate = workingDays[next + duration - 1];
        if (endDate > latestEnd) break;
        if (endDate < issue.endDate!) continue;
        checksLeft -= 2 * duration + candidate.dependencies.length;
        if (checksLeft < 0 || changes.length === MAX_WORKLOAD_LEVEL_CHANGES) {
          reachedSearchLimit = true;
          break search;
        }
        const reduction = improvement(candidate, next);
        if (reduction === 0 || !linksPermit(candidate, { startDate, endDate }, effective, math)) continue;
        move(candidate, next);
        effective.set(issue.id, { startDate, endDate });
        moved.set(issue.id, { startDate, endDate });
        changes.push({ id: issue.id, key: issue.key, title: issue.title, version: issue.version,
          fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate });
        movedThisPass = true;
        excessLeft -= reduction;
        if (excessLeft === 0) break search;
        break;
      }
    }
  } while (movedThisPass);

  const projectedIssues = issues.map(issue => moved.has(issue.id) ? { ...issue, ...moved.get(issue.id)! } : issue);
  const projected = changes.length ? calculateProjectWorkload({ ...workloadInput, issues: projectedIssues }) : current;
  const after = summarize(projected, projectedIssues, calendar.projectId);
  return { changes, before, after, remaining: remainingConflicts(projected),
    ...(reachedSearchLimit && after.excessMinutes > 0 ? { reason: 'search-limit' as const } : {}) };
}
