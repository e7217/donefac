import { CalendarError, createCalendarMath, isCalendarDate, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from './calendar.js';
import { DEPENDENCY_ENDPOINTS, SCHEDULE_DATE_LABELS, dependencyBound, isDependencyLag, isDependencyType } from './schedule-dependencies.js';
import type { Dependency, Issue, ProjectScheduleAnalysis, ProjectWorkflow, ScheduleAnalysisTask, WorkCalendar } from './types.js';

export const MAX_SCHEDULE_ANALYSIS_TASKS = 10_000;
export const MAX_SCHEDULE_ANALYSIS_DEPENDENCIES = 50_000;

export class ScheduleAnalysisError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type AnalysisInput = {
  projectId: string;
  issues: readonly Issue[];
  dependencies: readonly Dependency[];
  calendar: WorkCalendar;
  workflow: ProjectWorkflow;
};
type CalendarMath = ReturnType<typeof createCalendarMath>;
type Timing = { duration: number; savedStart: number; earlyStart: number; latestStart: number; normalized: boolean };
type Task = {
  issue: Issue;
  timing: Timing | null;
  reason?: string;
  incoming: number;
  outgoing: Constraint[];
  neighbors: Task[];
};
type Constraint = { id: string; predecessor: Task; successor: Task; offset: number };

function workdayIndex(math: CalendarMath, date: string) {
  return math.count(MIN_CALENDAR_DATE, math.onOrAfter(date)) - 1;
}

function activeTask(issue: Issue, math: CalendarMath): Task {
  const task: Task = { issue, timing: null, incoming: 0, outgoing: [], neighbors: [] };
  const { startDate, endDate } = issue;
  if (!startDate || !endDate) {
    task.reason = '시작일과 종료일을 입력해 주세요.';
    return task;
  }
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
    task.reason = '시작일과 종료일의 범위를 확인해 주세요.';
    return task;
  }
  const duration = math.count(startDate, endDate);
  if (duration === 0) {
    task.reason = '저장된 날짜 범위에 근무일이 없습니다. 업무 날짜와 작업 달력을 확인해 주세요.';
    return task;
  }
  const savedStart = workdayIndex(math, startDate);
  task.timing = { duration, savedStart, earlyStart: savedStart, latestStart: savedStart, normalized: !math.isWorking(startDate) || !math.isWorking(endDate) };
  return task;
}

function applyCompletedAnchor(dependency: Dependency, predecessor: Issue, successor: Task, math: CalendarMath) {
  if (!successor.timing) return;
  const { predecessor: sourceEndpoint } = DEPENDENCY_ENDPOINTS[dependency.type];
  if (!isCalendarDate(predecessor[sourceEndpoint])) {
    successor.reason ??= `완료된 선행 업무 ${predecessor.key}의 ${SCHEDULE_DATE_LABELS[sourceEndpoint]}을 확인해 주세요.`;
    return;
  }
  try {
    const bound = dependencyBound(dependency, predecessor, math)!;
    const finishOffset = bound.endpoint === 'endDate' ? successor.timing.duration - 1 : 0;
    successor.timing.earlyStart = Math.max(successor.timing.earlyStart, workdayIndex(math, bound.date) - finishOffset);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    // A negative shift beyond the first representable workday leaves every active date feasible.
    if (dependency.lagDays + Number(dependency.type === 'FS') < 0) return;
    successor.reason ??= `완료된 선행 업무 ${predecessor.key}의 연결 간격이 달력 범위를 벗어납니다.`;
  }
}

/** Move the source/target endpoint offsets to the start of each task. */
function startOffset(dependency: Dependency, source: Timing, target: Timing) {
  const endpoints = DEPENDENCY_ENDPOINTS[dependency.type];
  const sourceOffset = endpoints.predecessor === 'endDate' ? source.duration - 1 : 0;
  const targetOffset = endpoints.successor === 'endDate' ? target.duration - 1 : 0;
  return sourceOffset + dependency.lagDays + Number(dependency.type === 'FS') - targetOffset;
}

function connectedTasks(root: Task, visited: Set<Task>) {
  const component = [root];
  visited.add(root);
  for (const task of component) {
    for (const neighbor of task.neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      component.push(neighbor);
    }
  }
  return component;
}

function projectComponent(component: Task[], maxDay: number): Task[] {
  const invalid = component.find(task => task.reason);
  if (invalid) {
    for (const task of component) task.reason ??= `연결된 업무 ${invalid.issue.key}의 일정이나 업무 연결을 먼저 확인해 주세요.`;
    return [];
  }
  const order = component.filter(task => task.incoming === 0);
  for (const task of order) {
    for (const edge of task.outgoing) {
      const next = edge.successor;
      next.timing!.earlyStart = Math.max(next.timing!.earlyStart, task.timing!.earlyStart + edge.offset);
      if (--next.incoming === 0) order.push(next);
    }
  }
  if (order.length !== component.length) {
    for (const task of component) task.reason = '순환하는 선후행 업무 연결을 확인해 주세요.';
    return [];
  }
  if (order.some(task => task.timing!.earlyStart + task.timing!.duration - 1 > maxDay)) {
    for (const task of component) task.reason = '선후행 조건을 적용한 일정이 달력의 날짜 범위를 벗어납니다.';
    return [];
  }
  return order;
}

/** Project the saved active schedule without editing it, then work backward from its earliest finish. */
export function analyzeProjectSchedule({ projectId, issues, dependencies, calendar, workflow }: AnalysisInput): ProjectScheduleAnalysis {
  if (calendar.projectId !== projectId || workflow.projectId !== projectId) {
    throw new ScheduleAnalysisError(422, '작업 달력과 워크플로의 프로젝트를 확인해 주세요.');
  }
  const projectIssues = issues.filter(issue => issue.projectId === projectId);
  if (projectIssues.length > MAX_SCHEDULE_ANALYSIS_TASKS) {
    throw new ScheduleAnalysisError(422, `일정 여유 분석은 업무 ${MAX_SCHEDULE_ANALYSIS_TASKS.toLocaleString('ko-KR')}개까지 지원합니다.`);
  }
  let math: CalendarMath;
  try {
    math = createCalendarMath(calendar);
  } catch (error) {
    if (!(error instanceof CalendarError)) throw error;
    throw new ScheduleAnalysisError(422, error.message);
  }
  const byId = new Map(projectIssues.map(issue => [issue.id, issue]));
  if (byId.size !== projectIssues.length) throw new ScheduleAnalysisError(422, '중복된 업무 ID가 있어 일정 여유를 분석할 수 없습니다.');

  const categories = new Map(workflow.statuses.map(status => [status.id, status.category]));
  const active = new Map<string, Task>();
  let completedCount = 0, cancelledCount = 0;
  for (const issue of projectIssues) {
    const category = categories.get(issue.status);
    if (category === 'done') completedCount++;
    else if (category === 'cancelled') cancelledCount++;
    else active.set(issue.id, activeTask(issue, math));
  }

  let relevantDependencies = 0;
  const constraints: Constraint[] = [];
  for (const dependency of dependencies) {
    const sourceIssue = byId.get(dependency.predecessorId);
    const targetIssue = byId.get(dependency.successorId);
    if (!sourceIssue && !targetIssue) continue;
    if (++relevantDependencies > MAX_SCHEDULE_ANALYSIS_DEPENDENCIES) {
      throw new ScheduleAnalysisError(422, `일정 여유 분석은 업무 연결 ${MAX_SCHEDULE_ANALYSIS_DEPENDENCIES.toLocaleString('ko-KR')}개까지 지원합니다.`);
    }
    const predecessor = active.get(dependency.predecessorId);
    const successor = active.get(dependency.successorId);
    const affected = predecessor ?? successor;
    if ((!sourceIssue || !targetIssue) && affected) {
      affected.reason ??= '연결된 업무가 프로젝트에 있는지 확인해 주세요.';
      continue;
    }
    if (!sourceIssue || !successor || categories.get(sourceIssue.status) === 'cancelled') continue;
    if (predecessor) {
      predecessor.neighbors.push(successor);
      successor.neighbors.push(predecessor);
    }
    if (!isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) {
      successor.reason ??= `선행 업무 ${sourceIssue.key}의 연결 종류와 간격을 확인해 주세요.`;
      continue;
    }
    if (!predecessor) {
      applyCompletedAnchor(dependency, sourceIssue, successor, math);
      continue;
    }
    if (!predecessor.timing || !successor.timing) continue;
    const edge = { id: dependency.id, predecessor, successor, offset: startOffset(dependency, predecessor.timing, successor.timing) };
    successor.incoming++;
    predecessor.outgoing.push(edge);
    constraints.push(edge);
  }

  const maxDay = math.count(MIN_CALENDAR_DATE, MAX_CALENDAR_DATE) - 1;
  const visited = new Set<Task>();
  const order: Task[] = [];
  let finish = -1;
  for (const task of active.values()) {
    if (visited.has(task)) continue;
    const componentOrder = projectComponent(connectedTasks(task, visited), maxDay);
    for (const scheduled of componentOrder) {
      const timing = scheduled.timing!;
      finish = Math.max(finish, timing.earlyStart + timing.duration - 1);
      order.push(scheduled);
    }
  }
  for (let index = order.length - 1; index >= 0; index--) {
    const { timing, outgoing } = order[index];
    timing!.latestStart = finish - timing!.duration + 1;
    for (const edge of outgoing) timing!.latestStart = Math.min(timing!.latestStart, edge.successor.timing!.latestStart - edge.offset);
  }

  const firstWorkday = math.onOrAfter(MIN_CALENDAR_DATE);
  const dateCache = new Map<number, string>();
  function dateAt(index: number): string {
    const cached = dateCache.get(index);
    if (cached) return cached;
    const date = math.shift(firstWorkday, index);
    dateCache.set(index, date);
    return date;
  }
  const tasks: ScheduleAnalysisTask[] = [];
  const excluded: ProjectScheduleAnalysis['excluded'] = [];
  let normalizedCount = 0, movedCount = 0;
  for (const { issue, reason, timing } of active.values()) {
    const identity = { issueId: issue.id, key: issue.key, title: issue.title };
    if (reason) {
      excluded.push({ ...identity, reason });
      continue;
    }
    const { duration, savedStart, earlyStart, latestStart, normalized } = timing!;
    normalizedCount += Number(normalized);
    movedCount += Number(earlyStart > savedStart);
    const slackDays = latestStart - earlyStart;
    tasks.push({
      ...identity, earlyStart: dateAt(earlyStart), earlyFinish: dateAt(earlyStart + duration - 1),
      latestStart: dateAt(latestStart), latestFinish: dateAt(latestStart + duration - 1), slackDays, critical: slackDays === 0,
    });
  }

  const criticalDependencyIds = constraints.filter(({ predecessor, successor, offset }) => {
    if (predecessor.reason || successor.reason) return false;
    const prior = predecessor.timing!, next = successor.timing!;
    return prior.latestStart === prior.earlyStart && next.latestStart === next.earlyStart && next.earlyStart === prior.earlyStart + offset;
  }).map(edge => edge.id);
  const warnings: string[] = [];
  if (excluded.length) warnings.push(`분석에서 빠진 업무 ${excluded.length}개의 날짜와 연결을 확인해 주세요.`);
  if (normalizedCount) warnings.push(`날짜 경계가 비근무일인 업무 ${normalizedCount}개는 저장한 범위 안의 근무일을 사용했습니다.`);
  if (movedCount) warnings.push(`선후행 조건을 반영해 업무 ${movedCount}개의 시작이 저장된 근무일보다 늦어질 수 있습니다.`);
  return {
    projectId, projectedFinish: finish < 0 ? null : dateAt(finish), tasks, criticalDependencyIds, excluded,
    completedCount, cancelledCount, warnings, partial: excluded.length > 0,
  };
}
