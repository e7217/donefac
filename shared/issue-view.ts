import { isIssueViewGitlabFilter, PRIORITY, type Issue, type IssueViewAssigneeFilter, type IssueViewDateFilter, type IssueViewGitlabFilter, type IssueViewLabelFilter, type IssueViewPlanningFilter, type IssueViewReporterFilter, type IssueViewSortField, type IssueViewSortRule, type PlanningItem, type Priority, type Project, type ProjectIssueOrder, type ProjectIssueSchema, type SavedViewState, type User, type WorkspaceSnapshot } from './types.js';
import { calendarDay, isCalendarDate } from './calendar.js';
import { createIssueFieldMatcher } from './issue-field-filter.js';
import { issueSearchText } from './issue-schema.js';
import { summarizeIssueGitlabLinks, type IssueGitlabSummary } from './issue-gitlab-view.js';
import { PLANNING_FIELDS } from './planning-helpers.js';
import { reservationLocalDateTime } from './time-reservations.js';
import { issueSearchAliases, normalizeWorkspaceSearchKey } from './workspace-search.js';

export class IssueViewPlanningFilterError extends Error {
  readonly status = 400;
}

export class IssueViewGitlabFilterError extends Error {
  readonly status = 400;
}

export class IssueViewPriorityLabelFilterError extends Error {
  readonly status = 400;
}

export class IssueViewAssigneeFilterError extends Error {
  readonly status = 400;
}

export class IssueViewReporterFilterError extends Error {
  readonly status = 400;
}

export class IssueViewStatusFilterError extends Error {
  readonly status = 400;
}

export const ISSUE_VIEW_SORT_LABELS = {
  dueDate: '목표 마감일', priority: '우선순위', startDate: '시작일', endDate: '종료일',
  createdAt: '등록일', updatedAt: '수정일', key: '업무 키', title: '제목',
} satisfies Record<IssueViewSortField, string>;
export const ISSUE_VIEW_SORT_FIELDS = Object.keys(ISSUE_VIEW_SORT_LABELS) as IssueViewSortField[];
export const ISSUE_VIEW_SORT_LIMIT = ISSUE_VIEW_SORT_FIELDS.length;

export class IssueViewSortError extends Error {
  readonly status = 400;
}

export function parseIssueViewSort(value: unknown): IssueViewSortRule[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > ISSUE_VIEW_SORT_LIMIT) {
    throw new IssueViewSortError(`정렬 기준은 최대 ${ISSUE_VIEW_SORT_LIMIT}개까지 지정할 수 있습니다.`);
  }
  const rules: IssueViewSortRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2) {
      throw new IssueViewSortError('정렬 기준과 방향을 확인해 주세요.');
    }
    const { field, direction } = entry as Record<string, unknown>;
    if (typeof field !== 'string' || !Object.hasOwn(ISSUE_VIEW_SORT_LABELS, field) || (direction !== 'asc' && direction !== 'desc')) {
      throw new IssueViewSortError('정렬 기준과 방향을 확인해 주세요.');
    }
    const key = field as IssueViewSortField;
    if (rules.some(rule => rule.field === key)) throw new IssueViewSortError('같은 정렬 기준을 두 번 지정할 수 없습니다.');
    rules.push({ field: key, direction });
  }
  return rules.length ? rules : undefined;
}

export const ISSUE_VIEW_STATUS_LIMIT = 40;
export const ISSUE_VIEW_LABEL_FILTER_LIMIT = 20;
export const ISSUE_VIEW_LABEL_MAX_LENGTH = 60;

const issueViewPriorities = Object.keys(PRIORITY) as Priority[];
type IssuePriorityLabelCriteria = Pick<SavedViewState['filters'], 'priorities' | 'labels'>;
type IssueViewStatusCriteria = Pick<SavedViewState['filters'], 'status' | 'statusIds'>;

function normalizeStatusIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function parseIssueViewStatusIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > ISSUE_VIEW_STATUS_LIMIT) {
    throw new IssueViewStatusFilterError(`상태 조건은 최대 ${ISSUE_VIEW_STATUS_LIMIT}개의 ID 배열이어야 합니다.`);
  }
  for (const statusId of value) {
    if (typeof statusId !== 'string' || !statusId || statusId.length > 80 || statusId === 'all' ||
        statusId.trim() !== statusId || !statusId.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(statusId)) {
      throw new IssueViewStatusFilterError('상태 조건의 ID를 확인해 주세요.');
    }
  }
  return value.length ? normalizeStatusIds(value) : undefined;
}

export function issueViewStatusIds({ status, statusIds }: IssueViewStatusCriteria): readonly string[] {
  return status === 'all' ? statusIds ?? [] : [status];
}

export function issueViewStatusCriteria(ids: readonly string[]): IssueViewStatusCriteria {
  const statusIds = normalizeStatusIds(ids);
  return statusIds.length > 1 ? { status: 'all', statusIds } : { status: statusIds[0] ?? 'all' };
}

export function parseIssueViewGitlabFilter(value: unknown): IssueViewGitlabFilter | undefined {
  if (value === undefined || isIssueViewGitlabFilter(value)) return value;
  throw new IssueViewGitlabFilterError('GitLab 활동 필터를 확인해 주세요.');
}

const planSelectors = Object.entries(PLANNING_FIELDS);
const planningFilterKeys = [...planSelectors.map(([, fields]) => fields.idField), 'dates', 'releaseFilter'];
export const ISSUE_VIEW_RELEASE_LIMIT = 40;

function checkedFilterObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  FilterError = IssueViewPlanningFilterError,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FilterError(`${label}은 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FilterError(`${label}은 일반 객체여야 합니다.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowedKeys.includes(key) || !field || !Object.hasOwn(field, 'value')) {
      throw new FilterError(`${label}에 올바르지 않은 속성이 있습니다.`);
    }
  }
  return value as Record<string, unknown>;
}

export function parseIssueViewAssigneeFilter(value: unknown): IssueViewAssigneeFilter | undefined {
  if (value === undefined || value === null) return undefined;
  const input = checkedFilterObject(value, ['kind'], '담당자 조건', IssueViewAssigneeFilterError);
  if (Object.hasOwn(input, 'kind') && input.kind === 'current-user') return { kind: 'current-user' };
  throw new IssueViewAssigneeFilterError('담당자 조건을 확인해 주세요.');
}

export function parseIssueViewReporterFilter(value: unknown, users: readonly Pick<User, 'id'>[]): IssueViewReporterFilter | undefined {
  if (value === undefined || value === null) return undefined;
  const input = checkedFilterObject(value, ['kind', 'memberId'], '요청자 조건', IssueViewReporterFilterError);
  const kind = Object.hasOwn(input, 'kind') ? input.kind : undefined;
  const memberId = Object.hasOwn(input, 'memberId') ? input.memberId : undefined;
  if (kind === 'member' && typeof memberId === 'string' && memberId) {
    if (!users.some(user => user.id === memberId)) throw new IssueViewReporterFilterError('요청자 필터의 팀원을 찾을 수 없습니다.');
    return { kind, memberId };
  }
  if ((kind === 'unset' || kind === 'unknown' || kind === 'current-user') && !Object.hasOwn(input, 'memberId')) return { kind };
  throw new IssueViewReporterFilterError('요청자 조건을 확인해 주세요.');
}

export function parseIssueViewPriorities(value: unknown): Priority[] | undefined {
  if (!Array.isArray(value)) throw new IssueViewPriorityLabelFilterError('우선순위 조건은 배열이어야 합니다.');
  const selected = new Set<string>();
  for (const priority of value) {
    if (typeof priority !== 'string' || !Object.hasOwn(PRIORITY, priority)) {
      throw new IssueViewPriorityLabelFilterError('우선순위 값을 확인해 주세요.');
    }
    selected.add(priority);
  }
  return selected.size ? issueViewPriorities.filter(priority => selected.has(priority)) : undefined;
}

function parseIssueViewLabelList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > ISSUE_VIEW_LABEL_FILTER_LIMIT) {
    throw new IssueViewPriorityLabelFilterError(`라벨 조건은 목록마다 최대 ${ISSUE_VIEW_LABEL_FILTER_LIMIT}개까지 지정할 수 있습니다.`);
  }
  const labels = new Set<string>();
  for (const label of value) {
    if (typeof label !== 'string' || !label.length || label.length > ISSUE_VIEW_LABEL_MAX_LENGTH) {
      throw new IssueViewPriorityLabelFilterError(`라벨 값은 1~${ISSUE_VIEW_LABEL_MAX_LENGTH}자여야 합니다.`);
    }
    labels.add(label);
  }
  return labels.size ? [...labels].sort() : undefined;
}

export function parseIssueViewLabelFilter(value: unknown): IssueViewLabelFilter | undefined {
  const input = checkedFilterObject(value, ['include', 'exclude', 'match', 'presence'], '라벨 조건', IssueViewPriorityLabelFilterError);
  const include = Object.hasOwn(input, 'include') ? parseIssueViewLabelList(input.include) : undefined;
  const exclude = Object.hasOwn(input, 'exclude') ? parseIssueViewLabelList(input.exclude) : undefined;
  const match = Object.hasOwn(input, 'match') ? input.match : 'any';
  const presence = Object.hasOwn(input, 'presence') ? input.presence : undefined;
  if (match !== 'any' && match !== 'all') throw new IssueViewPriorityLabelFilterError('라벨 포함 조건을 확인해 주세요.');
  if (Object.hasOwn(input, 'presence') && presence !== 'set' && presence !== 'empty') {
    throw new IssueViewPriorityLabelFilterError('라벨 입력 여부 조건을 확인해 주세요.');
  }
  if (!include && !exclude && presence === undefined) return undefined;
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(include && match === 'all' ? { match } : {}),
    ...(presence === 'set' || presence === 'empty' ? { presence } : {}),
  };
}

export function createIssuePriorityLabelMatcher({ priorities, labels }: IssuePriorityLabelCriteria) {
  const selectedPriorities = new Set(priorities);
  return (issue: Pick<Issue, 'priority' | 'labels'>): boolean => {
    if (selectedPriorities.size && !selectedPriorities.has(issue.priority)) return false;
    if (!labels) return true;
    const hasLabel = (label: string) => issue.labels.includes(label);
    if (labels.presence && issue.labels.some(Boolean) !== (labels.presence === 'set')) return false;
    if (labels.exclude?.some(hasLabel)) return false;
    if (!labels.include?.length) return true;
    return labels.match === 'all' ? labels.include.every(hasLabel) : labels.include.some(hasLabel);
  };
}

export function issueViewLabelName(label: string): string {
  return label.trim() !== label || /[,\t\r\n]/u.test(label) ? JSON.stringify(label) : label;
}

export function issuePriorityLabelFilterLabels({ priorities, labels }: IssuePriorityLabelCriteria): string[] {
  const summaries: string[] = [];
  if (priorities?.length) summaries.push(`우선순위 · ${priorities.map(priority => PRIORITY[priority]).join(', ')}`);
  if (labels?.include?.length) summaries.push(`라벨 ${labels.match === 'all' ? '모두' : '하나 이상'} · ${labels.include.map(issueViewLabelName).join(', ')}`);
  if (labels?.exclude?.length) summaries.push(`라벨 제외 · ${labels.exclude.map(issueViewLabelName).join(', ')}`);
  if (labels?.presence) summaries.push(labels.presence === 'set' ? '라벨 있음' : '라벨 없음');
  return summaries;
}

export const ISSUE_VIEW_RELATIVE_DUE_DAY_LIMIT = 3650;

export function isIssueViewRelativeDueDay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= ISSUE_VIEW_RELATIVE_DUE_DAY_LIMIT;
}

export function issueViewToday(now = new Date()): string {
  return reservationLocalDateTime(now.toISOString()).slice(0, 10);
}

function parseDateFilter(value: unknown): IssueViewDateFilter {
  const filter = checkedFilterObject(value, ['mode', 'from', 'to', 'fromDays', 'toDays'], '날짜 조건');
  const mode = Object.hasOwn(filter, 'mode') ? filter.mode : undefined;
  const hasFrom = Object.hasOwn(filter, 'from');
  const hasTo = Object.hasOwn(filter, 'to');
  const hasFromDays = Object.hasOwn(filter, 'fromDays');
  const hasToDays = Object.hasOwn(filter, 'toDays');
  if (mode !== 'due_relative' && (hasFromDays || hasToDays)) {
    throw new IssueViewPlanningFilterError('오늘 기준의 일 수는 상대 마감일에만 지정할 수 있습니다.');
  }
  if (mode === 'planned' || mode === 'needs_dates' || mode === 'due_set' || mode === 'due_missing') {
    if (hasFrom || hasTo) throw new IssueViewPlanningFilterError('날짜 입력 여부 조건에 날짜 범위를 지정할 수 없습니다.');
    return { mode };
  }
  if (mode !== 'overlap' && mode !== 'due' && mode !== 'due_relative') throw new IssueViewPlanningFilterError('날짜 조건 종류를 확인해 주세요.');
  const from = hasFrom ? filter.from : undefined;
  const to = hasTo ? filter.to : undefined;
  if ((hasFrom && !isCalendarDate(from)) || (hasTo && !isCalendarDate(to))) {
    throw new IssueViewPlanningFilterError('날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (typeof from === 'string' && typeof to === 'string' && from > to) {
    throw new IssueViewPlanningFilterError('종료 날짜는 시작 날짜보다 빠를 수 없습니다.');
  }
  const range = { ...(typeof from === 'string' ? { from } : {}), ...(typeof to === 'string' ? { to } : {}) };
  if (mode === 'due_relative') {
    const fromDays = hasFromDays ? filter.fromDays : undefined;
    const toDays = hasToDays ? filter.toDays : undefined;
    if (!hasFromDays && !hasToDays) throw new IssueViewPlanningFilterError('오늘 기준 시작 또는 종료 일 수를 지정해 주세요.');
    if ((hasFromDays && !isIssueViewRelativeDueDay(fromDays)) || (hasToDays && !isIssueViewRelativeDueDay(toDays))) {
      throw new IssueViewPlanningFilterError(`오늘 기준 일 수는 -${ISSUE_VIEW_RELATIVE_DUE_DAY_LIMIT}~${ISSUE_VIEW_RELATIVE_DUE_DAY_LIMIT} 사이의 정수여야 합니다.`);
    }
    if (typeof fromDays === 'number' && typeof toDays === 'number' && fromDays > toDays) {
      throw new IssueViewPlanningFilterError('오늘 기준 종료 일 수는 시작 일 수보다 작을 수 없습니다.');
    }
    return { mode, ...range, ...(typeof fromDays === 'number' ? { fromDays: fromDays || 0 } : {}),
      ...(typeof toDays === 'number' ? { toDays: toDays || 0 } : {}) };
  }
  if (!hasFrom && !hasTo) throw new IssueViewPlanningFilterError('시작 또는 종료 날짜를 지정해 주세요.');
  return { mode, ...range };
}

export function parseIssueViewPlanningFilter(value: unknown, projectId: string, items: readonly PlanningItem[]): IssueViewPlanningFilter | undefined {
  if (value === undefined) return undefined;
  const input = checkedFilterObject(value, planningFilterKeys, '계획 필터');
  const filter: IssueViewPlanningFilter = {};
  for (const [kind, { idField }] of planSelectors) {
    if (!Object.hasOwn(input, idField)) continue;
    const id = input[idField];
    if (id !== null && (typeof id !== 'string' || !id || !items.some(item => item.id === id && item.projectId === projectId && item.kind === kind))) {
      throw new IssueViewPlanningFilterError('필터에 지정한 종류의 계획 항목을 이 프로젝트에서 찾을 수 없습니다.');
    }
    filter[idField] = id;
  }
  if (Object.hasOwn(input, 'releaseFilter')) {
    if (Object.hasOwn(input, 'releaseId')) throw new IssueViewPlanningFilterError('릴리스 조건은 한 방식으로 지정해 주세요.');
    const raw = checkedFilterObject(input.releaseFilter, ['kind', 'ids'], '릴리스 조건');
    if (raw.kind === 'assigned' && !Object.hasOwn(raw, 'ids')) {
      filter.releaseFilter = { kind: 'assigned' };
    } else if (raw.kind === 'any' && Array.isArray(raw.ids) && raw.ids.length >= 2 && raw.ids.length <= ISSUE_VIEW_RELEASE_LIMIT) {
      const releases = new Set(items.filter(item => item.projectId === projectId && item.kind === 'release').map(item => item.id));
      if (new Set(raw.ids).size !== raw.ids.length || raw.ids.some(id => typeof id !== 'string' || !releases.has(id))) {
        throw new IssueViewPlanningFilterError('이 프로젝트의 서로 다른 릴리스를 지정해 주세요.');
      }
      filter.releaseFilter = { kind: 'any', ids: [...raw.ids].sort() };
    } else {
      throw new IssueViewPlanningFilterError(`릴리스 조건은 지정 여부 또는 2~${ISSUE_VIEW_RELEASE_LIMIT}개의 릴리스를 선택할 수 있습니다.`);
    }
  }
  if (Object.hasOwn(input, 'dates')) filter.dates = parseDateFilter(input.dates);
  return Object.keys(filter).length ? filter : undefined;
}

function matchesDateFilter(issue: Issue, filter: IssueViewDateFilter): boolean {
  if (filter.mode === 'due_set') return isCalendarDate(issue.dueDate);
  if (filter.mode === 'due_missing') return !isCalendarDate(issue.dueDate);
  if (filter.mode === 'due') {
    const { dueDate } = issue;
    return isCalendarDate(dueDate) && (!filter.from || dueDate >= filter.from) && (!filter.to || dueDate <= filter.to);
  }

  const { startDate, endDate } = issue;
  const complete = isCalendarDate(startDate) && isCalendarDate(endDate) && startDate <= endDate;
  if (filter.mode === 'planned') return complete;
  if (filter.mode === 'needs_dates') return !complete;
  return filter.mode === 'overlap' && complete && (!filter.from || endDate >= filter.from) && (!filter.to || startDate <= filter.to);
}

function createIssueDateMatcher(filter: IssueViewDateFilter, today?: string) {
  if (filter.mode !== 'due_relative') return (issue: Issue) => matchesDateFilter(issue, filter);
  const reference = calendarDay(today ?? issueViewToday());
  const from = Math.max(filter.from ? calendarDay(filter.from) : -Infinity, reference + (filter.fromDays ?? -Infinity));
  const to = Math.min(filter.to ? calendarDay(filter.to) : Infinity, reference + (filter.toDays ?? Infinity));
  return ({ dueDate }: Issue) => {
    if (!isCalendarDate(dueDate)) return false;
    const day = calendarDay(dueDate);
    return day >= from && day <= to;
  };
}

export function matchesGitlabFilter(filter: IssueViewGitlabFilter, summary: IssueGitlabSummary | undefined): boolean {
  switch (filter) {
    case 'open_merge_request': return Boolean(summary?.openMergeRequests);
    case 'merge_blocked': return Boolean(summary?.blockedMergeRequests);
    case 'failed_pipeline': return Boolean(summary?.failedPipelines);
    case 'running_pipeline': return Boolean(summary?.runningPipelines);
    case 'manual_pipeline': return Boolean(summary?.manualPipelines);
    case 'no_activity': return !summary?.activityCount;
  }
}

export function createTeamIssueSearchMatcher(query?: string) {
  const terms = normalizeWorkspaceSearchKey(query ?? '').split(' ').filter(Boolean);
  return (data: WorkspaceSnapshot, issue: Issue, project: Pick<Project, 'key' | 'name'> | undefined, statusLabel: string) => {
    if (!terms.length) return true;
    const text = normalizeWorkspaceSearchKey(`${project?.key ?? ''} ${project?.name ?? ''} ${statusLabel} ${issueSearchText(data, issue)}`);
    const aliases = issueSearchAliases(data, issue.id).map(alias => normalizeWorkspaceSearchKey(alias.key));
    return terms.every(term => text.includes(term) || aliases.some(key => key.includes(term)));
  };
}

function matchesReporterFilter(filter: IssueViewReporterFilter, reporterId: Issue['reporterId'], currentUserId?: string): boolean {
  switch (filter.kind) {
    case 'member': return reporterId === filter.memberId;
    case 'unset': return reporterId === null;
    case 'unknown': return reporterId === undefined;
    case 'current-user': return currentUserId !== undefined && reporterId === currentUserId;
  }
}

export function issueViewUsesCurrentUser(filters: SavedViewState['filters']): boolean {
  return filters.assignee?.kind === 'current-user' || filters.reporter?.kind === 'current-user';
}

/** The same criteria drive the issue screen and snapshots of a shared view. */
export function createIssueViewMatcher(
  filters: SavedViewState['filters'],
  data: Pick<WorkspaceSnapshot, 'issueSchemas' | 'users'> & Partial<Pick<WorkspaceSnapshot, 'gitlabLinks'>>,
  schema: ProjectIssueSchema,
  actorId?: string,
  today?: string,
): (issue: Issue) => boolean {
  const {assignee,assigneeId,type,planning,gitlab,reporter} = filters;
  const currentUserId = issueViewUsesCurrentUser(filters) && actorId && data.users.some(user => user.id === actorId)
    ? actorId : undefined;
  const matchAssignee = assignee
    ? (issue: Issue) => currentUserId !== undefined && issue.assigneeId === currentUserId
    : (issue: Issue) => assigneeId === 'all' || (assigneeId === 'none' ? !issue.assigneeId : issue.assigneeId === assigneeId);
  const selectedStatuses = new Set(issueViewStatusIds(filters));
  const search = filters.query.toLowerCase();
  const matchFields = createIssueFieldMatcher(filters.fieldFilter, schema);
  const matchDates = planning?.dates ? createIssueDateMatcher(planning.dates, today) : undefined;
  const matchPriorityLabels = createIssuePriorityLabelMatcher(filters);
  const gitlabSummaries = gitlab ? summarizeIssueGitlabLinks(data.gitlabLinks ?? []) : undefined;
  const planConditions = planning ? planSelectors.flatMap(([, { idField }]) => {
    const selected = planning[idField];
    return selected === undefined ? [] : [{ idField, selected }];
  }) : [];
  const releaseFilter = planning?.releaseFilter;
  const selectedReleases = releaseFilter?.kind === 'any' ? new Set(releaseFilter.ids) : undefined;
  return issue =>
    (selectedStatuses.size === 0 || selectedStatuses.has(issue.status)) &&
    matchAssignee(issue) &&
    (!reporter || matchesReporterFilter(reporter, issue.reporterId, currentUserId)) &&
    (type === 'all' || issue.type === type) &&
    planConditions.every(({ idField, selected }) => (issue[idField] ?? null) === selected) &&
    (!releaseFilter || Boolean(issue.releaseId && (!selectedReleases || selectedReleases.has(issue.releaseId)))) &&
    (!matchDates || matchDates(issue)) &&
    (!gitlab || matchesGitlabFilter(gitlab, gitlabSummaries?.get(issue.id))) &&
    matchPriorityLabels(issue) &&
    matchFields(issue) &&
    (!search || issueSearchText(data, issue).toLowerCase().includes(search));
}

/** Use the project's ranks for a filtered subset and keep unranked rows in source order. */
export function orderProjectIssues(issues: Issue[], order: ProjectIssueOrder | undefined): Issue[] {
  if (!order?.issueIds.length || issues.length < 2) return issues;
  const remaining = new Map(issues.map(issue => [issue.id, issue]));
  const ranked: Issue[] = [];
  for (const id of order.issueIds) {
    const issue = remaining.get(id);
    if (!issue) continue;
    ranked.push(issue);
    remaining.delete(id);
  }
  for (const issue of remaining.values()) ranked.push(issue);
  return ranked;
}

const prioritySortValue = { low: 0, medium: 1, high: 2, urgent: 3 } satisfies Record<Priority, number>;
const issueSortCollator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function issueSortValue(issue: Issue, field: IssueViewSortField): string | number | null {
  if (field === 'priority') return prioritySortValue[issue.priority] ?? null;
  if (field === 'createdAt' || field === 'updatedAt') {
    const timestamp = Date.parse(issue[field]);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return issue[field] || null;
}

export function orderIssueView(issues: Issue[], order: ProjectIssueOrder | undefined, sort?: readonly IssueViewSortRule[]): Issue[] {
  const ranked = orderProjectIssues(issues, order);
  if (!sort?.length || ranked.length < 2) return ranked;
  const rows = ranked.map(issue => ({ issue, values: sort.map(({ field }) => issueSortValue(issue, field)) }));
  // Stable sort retains project rank for ties. Empty values always follow populated values.
  return rows.sort((a, b) => {
    for (const [index, { direction }] of sort.entries()) {
      const left = a.values[index], right = b.values[index];
      if (left === right) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right : issueSortCollator.compare(String(left), String(right));
      if (comparison) return direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  }).map(({ issue }) => issue);
}
