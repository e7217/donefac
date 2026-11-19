import { CalendarError, createCalendarMath, isCalendarDate } from './calendar.js';
import { calculateProjectWorkload, calculateTeamWorkload, MAX_PLANNED_EFFORT_MINUTES, validateWorkloadRange, WorkloadError } from './project-workload.js';
import { dependencyBound, isDependencyLag, isDependencyType } from './schedule-dependencies.js';
import type {
  Dependency, Issue, ProjectWorkflow, ProjectWorkloadCapacity, ProjectWorkloadResult, TeamWorkloadCapacity,
  TeamWorkloadLevelPlan, WorkCalendar, WorkloadLevelConflict, WorkloadLevelPlan, WorkloadLevelSummary,
} from './types.js';

export const MAX_WORKLOAD_LEVEL_ISSUES = 10_000;
export const MAX_WORKLOAD_LEVEL_DEPENDENCIES = 50_000;
export const MAX_WORKLOAD_LEVEL_CELLS = 36_000;
export const MAX_WORKLOAD_LEVEL_CHANGES = 1_000;
export const MAX_WORKLOAD_LEVEL_REMAINING = 60;
export const MAX_WORKLOAD_LEVEL_CONFLICT_ISSUES = 20;
const MAX_SEARCH_CHECKS = 2_000_000;
const MOVE_ORDER = { low: 0, medium: 1, high: 2, urgent: 3 } as const;

type SharedInput = {
  startDate: string;
  endDate: string;
  dependencies: readonly Dependency[];
  userIds: readonly string[];
};

type LevelProject = { calendar: WorkCalendar; workflow: ProjectWorkflow; issues: readonly Issue[] };
type ProjectInput = SharedInput & LevelProject & {
  capacity: ProjectWorkloadCapacity;
  issueIds?: readonly string[];
};
type TeamInput = SharedInput & {
  capacity: TeamWorkloadCapacity;
  projects: readonly LevelProject[];
  movableProjectIds: readonly string[];
};
type LevelScope = Omit<LevelProject, 'workflow'> & {
  terminalStatusIds: string[];
  activeStatusIds: ReadonlySet<string>;
};

type Dates = Pick<Issue, 'startDate' | 'endDate'>;
type WorkdayCell = { scheduled: number; available: number };
type SchedulingCalendar = {
  math: ReturnType<typeof createCalendarMath>;
  dates: string[];
  indices: number[];
};
type MovableIssue = {
  issue: Issue;
  cells: WorkdayCell[];
  working: SchedulingCalendar;
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

function completionDates(projects: readonly LevelScope[]) {
  const dates = new Map<string, string | null>();
  for (const project of projects) {
    let last: string | null = null;
    for (const { endDate } of project.issues) {
      if (isCalendarDate(endDate) && (!last || endDate > last)) last = endDate;
    }
    dates.set(project.calendar.projectId, last);
  }
  return dates;
}

function summarize(workload: ProjectWorkloadResult, dates: ReadonlyMap<string, string | null>): WorkloadLevelSummary {
  let excessMinutes = 0;
  for (const row of workload.rows) {
    for (const cell of row.days) excessMinutes += excess(cell.scheduledMinutes, cell.availableMinutes);
  }
  let completionDate: string | null = null;
  for (const date of dates.values()) if (date && (!completionDate || date > completionDate)) completionDate = date;
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
  candidate: MovableIssue, dates: Dates, issues: ReadonlyMap<string, Issue>, moved: ReadonlyMap<string, Dates>,
) {
  const { id, projectId } = candidate.issue;
  for (const dependency of candidate.dependencies) {
    const predecessor = issues.get(dependency.predecessorId);
    const successor = issues.get(dependency.successorId);
    if (predecessor?.projectId !== projectId || successor?.projectId !== projectId || predecessor.id === successor.id ||
        !isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) return false;
    try {
      const predecessorDates = predecessor.id === id ? dates : moved.get(predecessor.id) ?? predecessor;
      const bound = dependencyBound(dependency, predecessorDates, candidate.working.math);
      if (!bound) return false;
      const successorDates = successor.id === id ? dates : moved.get(successor.id) ?? successor;
      const actual = successorDates[bound.endpoint];
      if (!isCalendarDate(actual) || actual < bound.date) return false;
    } catch (error) {
      if (!(error instanceof CalendarError)) throw error;
      return false;
    }
  }
  return true;
}

function cellAt(candidate: MovableIssue, workday: number) {
  return candidate.cells[candidate.working.indices[workday]];
}

function minutesAt(candidate: MovableIssue, offset: number) {
  if (offset < 0 || offset >= candidate.duration) return 0;
  return candidate.dailyMinutes + Number(offset < candidate.extraMinutes);
}

function hasCurrentOverload(candidate: MovableIssue) {
  for (let offset = 0; offset < candidate.duration; offset++) {
    const cell = cellAt(candidate, candidate.originalStart + offset);
    if (minutesAt(candidate, offset) > 0 && cell.scheduled > cell.available) return true;
  }
  return false;
}

/** Check before modifying any cells, including offsets where the old and new spans overlap. */
function improvement(candidate: MovableIssue, next: number) {
  let reduction = 0;
  for (let offset = 0; offset < candidate.duration; offset++) {
    const position = next + offset;
    const cell = cellAt(candidate, position);
    const before = excess(cell.scheduled, cell.available);
    const after = excess(cell.scheduled - minutesAt(candidate, position - candidate.originalStart)
      + minutesAt(candidate, offset), cell.available);
    if (after > before) return 0;
    reduction += before - after;
  }
  const removedDays = Math.min(candidate.duration, next - candidate.originalStart);
  for (let offset = 0; offset < removedDays; offset++) {
    const cell = cellAt(candidate, candidate.originalStart + offset);
    reduction += Math.min(minutesAt(candidate, offset), excess(cell.scheduled, cell.available));
  }
  return reduction;
}

function move(candidate: MovableIssue, next: number) {
  for (let offset = 0; offset < candidate.duration; offset++) {
    const minutes = minutesAt(candidate, offset);
    cellAt(candidate, candidate.originalStart + offset).scheduled -= minutes;
    cellAt(candidate, next + offset).scheduled += minutes;
  }
}

function scope({ calendar, workflow, issues }: LevelProject): LevelScope {
  if (workflow.projectId !== calendar.projectId) {
    throw new WorkloadError(400, '작업 달력·워크플로의 프로젝트가 일치하지 않습니다.');
  }
  const terminalStatusIds: string[] = [];
  const activeStatusIds = new Set<string>();
  for (const status of workflow.statuses) {
    if (status.category === 'done' || status.category === 'cancelled') terminalStatusIds.push(status.id);
    else activeStatusIds.add(status.id);
  }
  return { calendar, issues: issues.filter(issue => issue.projectId === calendar.projectId), terminalStatusIds, activeStatusIds };
}

function schedulingCalendar(calendar: WorkCalendar, days: ProjectWorkloadResult['days']): SchedulingCalendar {
  const math = createCalendarMath(calendar);
  const dates: string[] = [];
  const indices: number[] = [];
  for (let index = 0; index < days.length; index++) {
    const { date } = days[index];
    if (math.isWorking(date)) {
      dates.push(date);
      indices.push(index);
    }
  }
  return { math, dates, indices };
}

function findCandidates(
  { startDate: rangeStart, endDate: rangeEnd, dependencies }: SharedInput, projects: readonly LevelScope[],
  issues: ReadonlyMap<string, Issue>, current: ProjectWorkloadResult, canMove: (issue: Issue) => boolean,
) {
  const affected = new Set<string>();
  const rows = new Map<string, WorkdayCell[]>();
  for (const row of current.rows) {
    rows.set(row.userId, row.days.map(cell => {
      if (cell.scheduledMinutes > cell.availableMinutes) {
        for (const allocation of cell.allocations) affected.add(allocation.issueId);
      }
      return { scheduled: cell.scheduledMinutes, available: cell.availableMinutes };
    }));
  }

  const byProject = new Map(projects.map(project => [project.calendar.projectId, {
    activeStatusIds: project.activeStatusIds, working: schedulingCalendar(project.calendar, current.days),
  }]));
  const byDependency = incidentDependencies(issues, dependencies);
  const candidates: MovableIssue[] = [];
  for (const id of affected) {
    const issue = issues.get(id);
    if (!issue || !issue.assigneeId || !canMove(issue)) continue;
    const project = byProject.get(issue.projectId);
    const cells = rows.get(issue.assigneeId);
    if (!project?.activeStatusIds.has(issue.status) || !cells) continue;
    const { working } = project;
    const { startDate, endDate, dueDate, plannedEffortMinutes } = issue;
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate < rangeStart ||
        startDate > endDate || endDate > rangeEnd || (dueDate != null && !isCalendarDate(dueDate)) ||
        typeof plannedEffortMinutes !== 'number' || !Number.isSafeInteger(plannedEffortMinutes) ||
        plannedEffortMinutes <= 0 || plannedEffortMinutes > MAX_PLANNED_EFFORT_MINUTES) continue;
    const duration = working.math.count(startDate, endDate);
    if (duration === 0) continue;
    candidates.push({
      issue, cells, working, originalStart: workingIndex(working.dates, startDate), duration,
      dailyMinutes: Math.floor(plannedEffortMinutes / duration), extraMinutes: plannedEffortMinutes % duration,
      latestEnd: dueDate && dueDate < rangeEnd ? dueDate : rangeEnd,
      dependencies: byDependency.get(id) ?? [],
    });
  }
  return candidates.sort((a, b) => MOVE_ORDER[a.issue.priority] - MOVE_ORDER[b.issue.priority]
    || compareText(a.issue.startDate!, b.issue.startDate!) || compareText(a.issue.key, b.issue.key) || compareText(a.issue.id, b.issue.id));
}

function findMoves(candidates: readonly MovableIssue[], issues: ReadonlyMap<string, Issue>, excessMinutes: number) {
  const moved = new Map<string, Dates>();
  const changes: WorkloadLevelPlan['changes'] = [];
  let checksLeft = MAX_SEARCH_CHECKS;
  let excessLeft = excessMinutes;
  let reachedSearchLimit = false;
  // A later move can free capacity or add room before a fixed successor, so reconsider
  // previously blocked candidates after any successful pass. Each issue moves at most once.
  let movedThisPass: boolean;
  search: do {
    movedThisPass = false;
    for (const candidate of candidates) {
      const { issue, duration, originalStart, latestEnd, working: { dates } } = candidate;
      if (moved.has(issue.id)) continue;
      checksLeft -= duration;
      if (checksLeft < 0) {
        reachedSearchLimit = true;
        break search;
      }
      if (!hasCurrentOverload(candidate)) continue;
      const nextWorkingStart = originalStart + Number(dates[originalStart] === issue.startDate);
      for (let next = nextWorkingStart; next + duration <= dates.length; next++) {
        const startDate = dates[next], endDate = dates[next + duration - 1];
        if (endDate > latestEnd) break;
        if (endDate < issue.endDate!) continue;
        checksLeft -= 2 * duration + candidate.dependencies.length;
        if (checksLeft < 0 || changes.length === MAX_WORKLOAD_LEVEL_CHANGES) {
          reachedSearchLimit = true;
          break search;
        }
        const reduction = improvement(candidate, next);
        if (reduction === 0 || !linksPermit(candidate, { startDate, endDate }, issues, moved)) continue;
        move(candidate, next);
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
  return { changes, moved, reachedSearchLimit };
}

function validateSize(input: SharedInput, issueCount: number) {
  const { span } = validateWorkloadRange(input.startDate, input.endDate);
  if (issueCount > MAX_WORKLOAD_LEVEL_ISSUES || input.dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES ||
      new Set(input.userIds).size * span > MAX_WORKLOAD_LEVEL_CELLS) {
    throw new WorkloadError(422, '일정 조정 범위가 너무 큽니다. 업무·연결 수 또는 팀원·기간을 줄여 주세요.');
  }
}

function levelWorkload(input: SharedInput, projects: readonly LevelScope[], canMove: (issue: Issue) => boolean,
  calculate: (projects: readonly LevelScope[]) => ProjectWorkloadResult,
) {
  const issues = new Map<string, Issue>();
  for (const project of projects) for (const issue of project.issues) issues.set(issue.id, issue);
  const current = calculate(projects);
  const beforeDates = completionDates(projects);
  const before = summarize(current, beforeDates);
  let plan: WorkloadLevelPlan = { changes: [], before, after: before, remaining: [] };
  if (before.excessMinutes === 0) return { plan, issues, beforeDates, afterDates: beforeDates };

  const candidates = findCandidates(input, projects, issues, current, canMove);
  const { changes, moved, reachedSearchLimit } = findMoves(candidates, issues, before.excessMinutes);
  const projectedProjects = changes.length ? projects.map(project => ({ ...project, issues: project.issues.map(issue => {
    const dates = moved.get(issue.id);
    return dates ? { ...issue, ...dates } : issue;
  }) })) : projects;
  const projected = changes.length ? calculate(projectedProjects) : current;
  const afterDates = completionDates(projectedProjects);
  const after = summarize(projected, afterDates);
  plan = { changes, before, after, remaining: remainingConflicts(projected),
    ...(reachedSearchLimit && after.excessMinutes > 0 ? { reason: 'search-limit' } : {}) };
  return { plan, issues, beforeDates, afterDates };
}

/** Delay whole issues within one project's capacity and the selected date window. */
export function levelProjectWorkload(input: ProjectInput): WorkloadLevelPlan {
  if (input.workflow.projectId !== input.calendar.projectId || input.capacity.projectId !== input.calendar.projectId) {
    throw new WorkloadError(400, '작업 달력·워크플로·가용 시간의 프로젝트가 일치하지 않습니다.');
  }
  validateSize(input, input.issues.length);
  const selected = input.issueIds && new Set(input.issueIds);
  return levelWorkload(input, [scope(input)], issue => !selected || selected.has(issue.id),
    ([project]) => calculateProjectWorkload({ ...input, ...project })).plan;
}

/** Share a member's calendar-date capacity across all projects while restricting moves to selected projects. */
export function levelTeamWorkload(input: TeamInput): TeamWorkloadLevelPlan {
  validateSize(input, input.projects.reduce((count, project) => count + project.issues.length, 0));
  const projectIds = new Set(input.projects.map(project => project.calendar.projectId));
  const movable = new Set(input.movableProjectIds);
  if (movable.size !== input.movableProjectIds.length || [...movable].some(id => !projectIds.has(id))) {
    throw new WorkloadError(400, '일정을 조정할 프로젝트를 확인해 주세요.');
  }
  const { plan, issues, beforeDates, afterDates } = levelWorkload(input, input.projects.map(scope),
    issue => movable.has(issue.projectId), projects => calculateTeamWorkload({ ...input, projects }));
  const changes = plan.changes.map(change => ({ ...change, projectId: issues.get(change.id)!.projectId }));
  const projectCompletions = [...new Set(changes.map(change => change.projectId))].sort(compareText).map(projectId => ({
    projectId, before: beforeDates.get(projectId) ?? null, after: afterDates.get(projectId) ?? null,
  }));
  return { ...plan, changes, projectCompletions };
}
