import type { Issue, IssueViewDateFilter, IssueViewPlanningFilter, PlanningItem, ProjectIssueOrder, ProjectIssueSchema, SavedViewState, WorkspaceSnapshot } from './types.js';
import { isCalendarDate } from './calendar.js';
import { createIssueFieldMatcher } from './issue-field-filter.js';
import { issueSearchText } from './issue-schema.js';
import { PLANNING_FIELDS } from './planning-helpers.js';

export class IssueViewPlanningFilterError extends Error {
  readonly status = 400;
}

const planSelectors = Object.entries(PLANNING_FIELDS);
const planningFilterKeys = [...planSelectors.map(([, fields]) => fields.idField), 'dates'];

function checkedFilterObject(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IssueViewPlanningFilterError(`${label}은 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IssueViewPlanningFilterError(`${label}은 일반 객체여야 합니다.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowedKeys.includes(key) || !field || !Object.hasOwn(field, 'value')) {
      throw new IssueViewPlanningFilterError(`${label}에 올바르지 않은 속성이 있습니다.`);
    }
  }
  return value as Record<string, unknown>;
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

/** The same criteria drive the issue screen and snapshots of a shared view. */
export function createIssueViewMatcher(
  filters: SavedViewState['filters'],
  data: Pick<WorkspaceSnapshot, 'issueSchemas' | 'users'>,
  schema: ProjectIssueSchema,
): (issue: Issue) => boolean {
  const {status,assigneeId,type,planning} = filters;
  const search = filters.query.toLowerCase();
  const matchFields = createIssueFieldMatcher(filters.fieldFilter, schema);
  const planConditions = planning ? planSelectors.flatMap(([, { idField }]) => {
    const selected = planning[idField];
    return selected === undefined ? [] : [{ idField, selected }];
  }) : [];
  return issue =>
    (status === 'all' || issue.status === status) &&
    (assigneeId === 'all' || (assigneeId === 'none' ? !issue.assigneeId : issue.assigneeId === assigneeId)) &&
    (type === 'all' || issue.type === type) &&
    planConditions.every(({ idField, selected }) => (issue[idField] ?? null) === selected) &&
    (!planning?.dates || matchesDateFilter(issue, planning.dates)) &&
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
