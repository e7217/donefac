import { calculateWorkingDateRange, CalendarError, isCalendarDate, MAX_WORKING_DURATION_DAYS, type createCalendarMath } from '../shared/calendar.js';
import { DEPENDENCY_ENDPOINTS, SCHEDULE_DATE_LABELS, dependencyBound, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import type { AutomaticSchedulePreview, Dependency, Issue, ScheduleAnchorChange, ScheduleChange } from '../shared/types.js';

type ScheduleDates = Pick<Issue, 'startDate' | 'endDate'>;
type CalendarMath = ReturnType<typeof createCalendarMath>;
interface FollowUpGraph {
  issues: Issue[];
  selectedIds: string[];
  dependencies: Dependency[];
}

interface TeamFollowUpScope extends FollowUpGraph {
  sourceId: string;
  anchorChange?: ScheduleDates;
}

interface TeamBatchFollowUpScope extends FollowUpGraph {
  fixedDates: ReadonlyMap<string, ScheduleDates>;
}

const MAX_FOLLOW_UP_ISSUES = 1_000;
const FIXED_FOLLOW_UP_LIMIT = '선행 업무를 포함해 한 번에 1,000개 업무까지 계산할 수 있습니다.';

export class TeamFollowUpScheduleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function edgesByIssue(dependencies: Dependency[], direction: 'predecessorId' | 'successorId') {
  const groups = new Map<string, Dependency[]>();
  for (const dependency of dependencies) {
    const id = dependency[direction];
    const group = groups.get(id);
    if (group) group.push(dependency);
    else groups.set(id, [dependency]);
  }
  return groups;
}

function reachableSuccessors(startIds: readonly string[], byId: ReadonlyMap<string, Issue>, dependencies: Dependency[], limitMessage: string) {
  const outgoing = edgesByIssue(dependencies, 'predecessorId');
  const selected = new Set(startIds);
  for (const id of selected) {
    for (const dependency of outgoing.get(id) ?? []) {
      if (!byId.has(dependency.successorId)) throw new TeamFollowUpScheduleError(409, '선후행 연결에 현재 없는 업무가 있습니다.');
      selected.add(dependency.successorId);
      if (selected.size > MAX_FOLLOW_UP_ISSUES) throw new TeamFollowUpScheduleError(422, limitMessage);
    }
  }
  return selected;
}

function followUpGraph(selected: ReadonlySet<string>, issues: Issue[], dependencies: Dependency[], sourceId?: string): FollowUpGraph {
  const incoming = dependencies.filter(dependency => selected.has(dependency.successorId));
  const references = new Set([...selected, ...incoming.map(dependency => dependency.predecessorId)]);
  if (sourceId !== undefined) references.add(sourceId);
  return { issues: issues.filter(issue => references.has(issue.id)), selectedIds: [...selected], dependencies: incoming };
}

export function teamFollowUpScope(sourceId: string, targetIds: readonly string[], issues: Issue[], dependencies: Dependency[],
  anchorChange?: ScheduleDates): TeamFollowUpScope {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  if (!byId.has(sourceId) || !targetIds.length || targetIds.some(id => !byId.has(id))) {
    throw new TeamFollowUpScheduleError(409, '계속할 차단 업무를 찾을 수 없습니다.');
  }
  const selected = reachableSuccessors(anchorChange ? [sourceId] : targetIds, byId, dependencies,
    anchorChange ? FIXED_FOLLOW_UP_LIMIT : '후행 업무는 한 번에 1,000개까지 계산할 수 있습니다.');
  if (anchorChange && targetIds.some(id => !selected.has(id))) throw new TeamFollowUpScheduleError(409, '계속할 차단 업무를 찾을 수 없습니다.');
  return { sourceId, ...followUpGraph(selected, issues, dependencies, sourceId), ...(anchorChange ? { anchorChange } : {}) };
}

export function teamBatchFollowUpScope(anchors: readonly ScheduleAnchorChange[], issues: Issue[], dependencies: Dependency[]): TeamBatchFollowUpScope {
  if (!anchors.length) throw new TeamFollowUpScheduleError(400, '후행 일정의 기준 업무를 지정해 주세요.');
  if (anchors.length > MAX_FOLLOW_UP_ISSUES) throw new TeamFollowUpScheduleError(422, FIXED_FOLLOW_UP_LIMIT);
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const fixedDates = new Map<string, ScheduleDates>();
  const changedIds: string[] = [];
  for (const { id, expectedVersion, startDate, endDate } of anchors) {
    const issue = byId.get(id);
    if (!issue || issue.version !== expectedVersion) {
      throw new TeamFollowUpScheduleError(409, '기준 업무가 변경되었습니다. 최신 일정을 확인해 주세요.');
    }
    if (fixedDates.has(id)) throw new TeamFollowUpScheduleError(400, '후행 일정의 기준 업무를 중복해서 지정할 수 없습니다.');
    fixedDates.set(id, { startDate, endDate });
    if (startDate !== issue.startDate || endDate !== issue.endDate) changedIds.push(id);
  }
  // Unchanged explicit rows remain fixed without pulling in unrelated successors.
  const selected = reachableSuccessors(changedIds, byId, dependencies, FIXED_FOLLOW_UP_LIMIT);
  for (const id of fixedDates.keys()) selected.add(id);
  if (selected.size > MAX_FOLLOW_UP_ISSUES) throw new TeamFollowUpScheduleError(422, FIXED_FOLLOW_UP_LIMIT);
  return { ...followUpGraph(selected, issues, dependencies), fixedDates };
}

function requiredDates(issue: Issue, incoming: Dependency[], issues: ReadonlyMap<string, Issue>,
  effective: ReadonlyMap<string, ScheduleDates>, blocked: ReadonlySet<string>, math: CalendarMath) {
  const dates: ScheduleDates = { startDate: null, endDate: null };
  const problems: string[] = [];
  for (const edge of incoming) {
    const predecessor = issues.get(edge.predecessorId);
    if (!predecessor) { problems.push('연결된 선행 업무를 찾을 수 없습니다.'); continue; }
    if (blocked.has(predecessor.id)) { problems.push(`${predecessor.key}의 일정을 먼저 확인해 주세요.`); continue; }
    if (!isDependencyType(edge.type) || !isDependencyLag(edge.lagDays)) {
      problems.push(`${predecessor.key} 연결의 유형과 근무일 간격을 확인해 주세요.`);
      continue;
    }
    try {
      const bound = dependencyBound(edge, effective.get(predecessor.id) ?? predecessor, math);
      if (!bound) {
        const label = SCHEDULE_DATE_LABELS[DEPENDENCY_ENDPOINTS[edge.type].predecessor];
        problems.push(`${predecessor.key}의 ${label}을 입력해 주세요.`);
      } else {
        const previous = dates[bound.endpoint];
        if (!previous || bound.date > previous) dates[bound.endpoint] = bound.date;
      }
    } catch (cause) {
      if (!(cause instanceof CalendarError)) throw cause;
      problems.push(`${predecessor.key} · ${cause.message}`);
    }
  }
  return { dates, problems: problems.map(message => `${issue.key} · ${message}`) };
}

function delaySchedule(issue: Issue, required: ScheduleDates, math: CalendarMath) {
  const { startDate, endDate } = issue;
  if (!startDate || !endDate) throw new CalendarError(422, '시작일과 종료일을 입력해 근무일 기간을 정해 주세요.');
  const duration = math.count(startDate, endDate);
  if (duration < 1 || duration > MAX_WORKING_DURATION_DAYS) {
    throw new CalendarError(422, '후행 업무의 기간은 1~3,650근무일이어야 합니다.');
  }
  const earliestStart = required.startDate && required.startDate > startDate ? required.startDate : startDate;
  const range = calculateWorkingDateRange(math, 'startDate', math.onOrAfter(earliestStart), duration);
  if (required.endDate && required.endDate > range.endDate) {
    return calculateWorkingDateRange(math, 'endDate', math.onOrAfter(required.endDate), duration);
  }
  // If the original finish was a day off, retain that tail when the counted days still fit before it.
  if (endDate > range.endDate) range.endDate = endDate;
  return range;
}

export function calculateTeamFollowUpSchedule(scope: TeamFollowUpScope | TeamBatchFollowUpScope, calendar: (projectId: string) => CalendarMath,
  terminal: (issue: Issue) => boolean): Pick<AutomaticSchedulePreview, 'changes' | 'warnings' | 'blocking'> {
  const changes: ScheduleChange[] = [];
  const warnings: string[] = [];
  const blocking: string[] = [];
  const selected = new Set(scope.selectedIds);
  const incoming = edgesByIssue(scope.dependencies, 'successorId');
  const cycleThroughSource = 'sourceId' in scope && (scope.anchorChange
    ? (incoming.get(scope.sourceId) ?? []).some(edge => selected.has(edge.predecessorId))
    : selected.has(scope.sourceId));
  if (cycleThroughSource) {
    return { changes, warnings, blocking: ['선행 업무까지 돌아오는 순환 관계가 있습니다. 연결 방향을 확인해 주세요.'] };
  }
  const issues = new Map(scope.issues.map(issue => [issue.id, issue]));
  const outgoing = edgesByIssue(scope.dependencies, 'predecessorId');
  const indegree = new Map(scope.selectedIds.map(id => [id,
    (incoming.get(id) ?? []).filter(edge => selected.has(edge.predecessorId)).length]));
  const queue = scope.selectedIds.filter(id => indegree.get(id) === 0);
  const blocked = new Set<string>();
  const effective = new Map<string, ScheduleDates>();
  function recordChange(issue: Issue, next: ScheduleDates) {
    const { startDate, endDate } = next;
    effective.set(issue.id, next);
    if (startDate === issue.startDate && endDate === issue.endDate) return;
    changes.push({ id: issue.id, projectId: issue.projectId, key: issue.key, title: issue.title, version: issue.version,
      fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate });
    if (issue.dueDate && endDate && endDate > issue.dueDate) {
      warnings.push(`${issue.key} · 조정한 종료일 ${endDate}이 목표 마감일 ${issue.dueDate} 이후입니다.`);
    }
  }

  for (const id of queue) {
    const issue = issues.get(id)!;
    const math = calendar(issue.projectId);
    const { dates, problems } = requiredDates(issue, incoming.get(id) ?? [], issues, effective, blocked, math);
    const anchor = 'fixedDates' in scope ? scope.fixedDates.get(id) : id === scope.sourceId ? scope.anchorChange : undefined;
    const current = anchor ?? issue;
    const conflict = (dates.startDate && (!current.startDate || dates.startDate > current.startDate)) ||
      (dates.endDate && (!current.endDate || dates.endDate > current.endDate));
    if (anchor) {
      const { startDate, endDate } = anchor;
      if ((startDate !== null && !isCalendarDate(startDate)) || (endDate !== null && !isCalendarDate(endDate))) {
        problems.push(`${issue.key} · YYYY-MM-DD 형식의 날짜를 입력해 주세요.`);
      } else if (startDate && endDate && endDate < startDate) {
        problems.push(`${issue.key} · 종료일은 시작일보다 빠를 수 없습니다.`);
      }
      if (!endDate && 'sourceId' in scope) problems.push(`${issue.key} · 선택한 차단 관계를 계산하려면 종료일을 입력해 주세요.`);
      if (terminal(issue) && (startDate !== issue.startDate || endDate !== issue.endDate)) {
        problems.push(`${issue.key} · 완료·취소 업무의 고정 일정은 변경할 수 없습니다.`);
      }
      if (conflict) {
        for (const endpoint of ['startDate', 'endDate'] as const) {
          const earliest = dates[endpoint];
          const actual = anchor[endpoint];
          if (earliest && (!actual || earliest > actual)) {
            problems.push(`${issue.key} · 입력한 ${SCHEDULE_DATE_LABELS[endpoint]} ${actual ?? '미정'}이 선후행 조건 ${earliest}을 충족하지 않습니다.`);
          }
        }
      }
      if (!problems.length) recordChange(issue, anchor);
    } else if (!problems.length && conflict) {
      if (terminal(issue)) problems.push(`${issue.key} · 완료·취소 업무의 고정 일정과 선후행 조건이 충돌합니다.`);
      else {
        try {
          recordChange(issue, delaySchedule(issue, dates, math));
        } catch (cause) {
          if (!(cause instanceof CalendarError)) throw cause;
          problems.push(`${issue.key} · ${cause.message}`);
        }
      }
    }
    if (problems.length) {
      blocked.add(id);
      blocking.push(...problems);
    }
    for (const edge of outgoing.get(id) ?? []) {
      const degree = indegree.get(edge.successorId)! - 1;
      indegree.set(edge.successorId, degree);
      if (degree === 0) queue.push(edge.successorId);
    }
  }
  if (queue.length !== selected.size) blocking.push('후행 업무에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.');
  return { changes, warnings, blocking: [...new Set(blocking)] };
}
