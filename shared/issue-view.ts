import { isIssueViewGitlabFilter, PRIORITY, type Issue, type IssueViewDateFilter, type IssueViewGitlabFilter, type IssueViewLabelFilter, type IssueViewPlanningFilter, type IssueViewReporterFilter, type PlanningItem, type Priority, type Project, type ProjectIssueOrder, type ProjectIssueSchema, type SavedViewState, type User, type WorkspaceSnapshot } from './types.js';
import { isCalendarDate } from './calendar.js';
import { createIssueFieldMatcher } from './issue-field-filter.js';
import { issueSearchText } from './issue-schema.js';
import { summarizeIssueGitlabLinks, type IssueGitlabSummary } from './issue-gitlab-view.js';
import { PLANNING_FIELDS } from './planning-helpers.js';

export class IssueViewPlanningFilterError extends Error {
  readonly status = 400;
}

export class IssueViewGitlabFilterError extends Error {
  readonly status = 400;
}

export class IssueViewPriorityLabelFilterError extends Error {
  readonly status = 400;
}

export class IssueViewReporterFilterError extends Error {
  readonly status = 400;
}

export class IssueViewStatusFilterError extends Error {
  readonly status = 400;
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
const planningFilterKeys = [...planSelectors.map(([, fields]) => fields.idField), 'dates'];

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

export function parseIssueViewReporterFilter(value: unknown, users: readonly Pick<User, 'id'>[]): IssueViewReporterFilter | undefined {
  if (value === undefined || value === null) return undefined;
  const input = checkedFilterObject(value, ['kind', 'memberId'], '요청자 조건', IssueViewReporterFilterError);
  const kind = Object.hasOwn(input, 'kind') ? input.kind : undefined;
  const memberId = Object.hasOwn(input, 'memberId') ? input.memberId : undefined;
  if (kind === 'member' && typeof memberId === 'string' && memberId) {
    if (!users.some(user => user.id === memberId)) throw new IssueViewReporterFilterError('요청자 필터의 팀원을 찾을 수 없습니다.');
    return { kind, memberId };
  }
  if ((kind === 'unset' || kind === 'unknown') && !Object.hasOwn(input, 'memberId')) return { kind };
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

function parseDateFilter(value: unknown): IssueViewDateFilter {
  const filter = checkedFilterObject(value, ['mode', 'from', 'to'], '날짜 조건');
  const mode = Object.hasOwn(filter, 'mode') ? filter.mode : undefined;
  const hasFrom = Object.hasOwn(filter, 'from');
  const hasTo = Object.hasOwn(filter, 'to');
  if (mode === 'planned' || mode === 'needs_dates') {
    if (hasFrom || hasTo) throw new IssueViewPlanningFilterError('일정 입력 여부 조건에 날짜 범위를 지정할 수 없습니다.');
    return { mode };
  }
  if (mode !== 'overlap' && mode !== 'due') throw new IssueViewPlanningFilterError('날짜 조건 종류를 확인해 주세요.');
  if (!hasFrom && !hasTo) throw new IssueViewPlanningFilterError('시작 또는 종료 날짜를 지정해 주세요.');
  const from = hasFrom ? filter.from : undefined;
  const to = hasTo ? filter.to : undefined;
  if ((hasFrom && !isCalendarDate(from)) || (hasTo && !isCalendarDate(to))) {
    throw new IssueViewPlanningFilterError('날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (typeof from === 'string' && typeof to === 'string' && from > to) {
    throw new IssueViewPlanningFilterError('종료 날짜는 시작 날짜보다 빠를 수 없습니다.');
  }
  return { mode, ...(typeof from === 'string' ? { from } : {}), ...(typeof to === 'string' ? { to } : {}) };
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
  if (Object.hasOwn(input, 'dates')) filter.dates = parseDateFilter(input.dates);
  return Object.keys(filter).length ? filter : undefined;
}

function matchesDateFilter(issue: Issue, filter: IssueViewDateFilter): boolean {
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
  const terms = (query ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return (data: WorkspaceSnapshot, issue: Issue, project: Pick<Project, 'key' | 'name'> | undefined, statusLabel: string) => {
    if (!terms.length) return true;
    const text = `${project?.key ?? ''} ${project?.name ?? ''} ${statusLabel} ${issueSearchText(data, issue)}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  };
}

function matchesReporterFilter(filter: IssueViewReporterFilter, reporterId: Issue['reporterId']): boolean {
  if (filter.kind === 'member') return reporterId === filter.memberId;
  return filter.kind === 'unset' ? reporterId === null : reporterId === undefined;
}

/** The same criteria drive the issue screen and snapshots of a shared view. */
export function createIssueViewMatcher(
  filters: SavedViewState['filters'],
  data: Pick<WorkspaceSnapshot, 'issueSchemas' | 'users'> & Partial<Pick<WorkspaceSnapshot, 'gitlabLinks'>>,
  schema: ProjectIssueSchema,
): (issue: Issue) => boolean {
  const {assigneeId,type,planning,gitlab,reporter} = filters;
  const selectedStatuses = new Set(issueViewStatusIds(filters));
  const search = filters.query.toLowerCase();
  const matchFields = createIssueFieldMatcher(filters.fieldFilter, schema);
  const matchPriorityLabels = createIssuePriorityLabelMatcher(filters);
  const gitlabSummaries = gitlab ? summarizeIssueGitlabLinks(data.gitlabLinks ?? []) : undefined;
  const planConditions = planning ? planSelectors.flatMap(([, { idField }]) => {
    const selected = planning[idField];
    return selected === undefined ? [] : [{ idField, selected }];
  }) : [];
  return issue =>
    (selectedStatuses.size === 0 || selectedStatuses.has(issue.status)) &&
    (assigneeId === 'all' || (assigneeId === 'none' ? !issue.assigneeId : issue.assigneeId === assigneeId)) &&
    (!reporter || matchesReporterFilter(reporter, issue.reporterId)) &&
    (type === 'all' || issue.type === type) &&
    planConditions.every(({ idField, selected }) => (issue[idField] ?? null) === selected) &&
    (!planning?.dates || matchesDateFilter(issue, planning.dates)) &&
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
