import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { isCalendarDate } from '../shared/calendar.js';
import { hasCustomValue } from '../shared/issue-schema.js';
import { PLANNING_FIELDS, PLANNING_META, planningFields } from '../shared/planning-helpers.js';
import {
  ISSUE_BULK_EDIT_LIMIT, ISSUE_BULK_LABEL_LIMIT, ISSUE_BULK_LABEL_MAX_LENGTH, PRIORITY, WORKFLOW_STATUS_MIGRATION_LIMIT,
  type CustomFieldValue, type Issue, type IssueBulkEditChanges, type IssueBulkEditPreview,
  type IssueBulkEditPreviewInput, type IssueBulkEditResult, type IssueBulkEditRow, type IssueBulkEditValues,
  type IssueFieldBreakdownSelection, type PlanningItem, type PlanningKind, type ProjectWorkflow, type TeamIssueBulkEditPreviewInput, type WorkflowStatusMigrationPreviewInput,
} from '../shared/types.js';
import { MAX_PACKAGE_BYTES } from './attachments.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS } from './automatic-schedule.js';
import { parseFieldBreakdownSelection } from './field-breakdown-routes.js';
import type { Store } from './store.js';

export class IssueBulkEditError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

type IssueSelection = IssueBulkEditPreviewInput['issues'][number];
type TeamIssueSelection = TeamIssueBulkEditPreviewInput['issues'][number];
type IssueUpdate = Partial<IssueBulkEditValues>;
type FieldBreakdownMatches = (projectId: string, selection: IssueFieldBreakdownSelection, issueIds: readonly string[]) => boolean;
interface BulkEditHooks<T extends { issue: Issue }> {
  actor(request: Request): string;
  configurationToken(projectId: string, changes: IssueBulkEditChanges): string;
  fieldBreakdownMatches?: FieldBreakdownMatches;
  prepare(before: Issue, update: IssueUpdate, preparedAt: string): T;
  commit(request: Request, before: Issue, prepared: T): void;
}
interface WorkflowBulkEditHooks<T extends { issue: Issue }> extends BulkEditHooks<T> {
  workflow(projectId: string): ProjectWorkflow;
}
interface BulkEditScope extends IssueBulkEditPreviewInput {
  team?: never;
  projectId: string;
  actorId: string;
  migrationFromStatusId?: string;
}
interface TeamBulkEditScope extends TeamIssueBulkEditPreviewInput {
  team: true;
  actorId: string;
}
type EditScope = BulkEditScope | TeamBulkEditScope;
type BulkEditProposal = ((BulkEditScope & { configurationToken: string }) |
  (TeamBulkEditScope & { configurationTokens: [string, string][] })) & {
  id: string;
  removeAfter: string;
  rows: IssueBulkEditRow[];
  parentFingerprint?: string;
  planFingerprint?: string;
  result?: IssueBulkEditResult;
};
interface BulkEditCandidate<T> { before: Issue; row: IssueBulkEditRow; prepared?: T }
type ParentIssue = Pick<Issue, 'id' | 'projectId' | 'parentId' | 'version' | 'key' | 'title'>;
type ParentReview = {
  fingerprint: string;
  label(id: string | null | undefined): Pick<Issue, 'id' | 'key' | 'title'> | null;
};
type PlanReference = Pick<PlanningItem, 'id' | 'projectId' | 'kind' | 'status' | 'name' | 'version'>;
type PlanReview = {
  fingerprint: string;
  labels(issue: Issue): NonNullable<IssueBulkEditRow['plans']>;
};
type BulkEditReferences = { parents?: ParentReview; plans?: PlanReview };

const TABLE = 'issue_bulk_edit_previews';
const STALE_MESSAGE = '업무 또는 프로젝트 설정이 변경되었습니다. 다시 미리 확인해 주세요.';
const PLANNING_KINDS = Object.keys(PLANNING_FIELDS) as PlanningKind[];
const PLAN_ID_FIELDS = PLANNING_KINDS.map(kind => planningFields(kind).idField);
const CHANGE_FIELDS = new Set(['status', 'priority', 'assigneeId', 'dueDate', 'parentId', ...PLAN_ID_FIELDS, 'addLabels', 'removeLabels', 'customFields']);
const TEAM_CHANGE_FIELDS = new Set(['priority', 'assigneeId', 'dueDate', 'addLabels', 'removeLabels']);
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

function fail(status: number, message: string, details?: unknown): never {
  throw new IssueBulkEditError(status, message, details);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '업무 일괄 편집 요청을 확인해 주세요.');
  return value as Record<string, unknown>;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 200;
}

function parseLabels(value: unknown, operation: 'add' | 'remove'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ISSUE_BULK_LABEL_LIMIT) {
    fail(400, `추가하거나 제거할 라벨을 항목별로 1~${ISSUE_BULK_LABEL_LIMIT}개 선택해 주세요.`);
  }
  const labels = value.map((label: unknown) => {
    if (typeof label !== 'string' || label.length > ISSUE_BULK_LABEL_MAX_LENGTH
      || (operation === 'add' && (!label.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(label)))) {
      fail(400, '변경할 라벨의 형식과 길이를 확인해 주세요.');
    }
    return label;
  });
  if (new Set(labels).size !== labels.length) fail(400, '같은 라벨을 중복으로 지정할 수 없습니다.');
  return labels;
}

function parseCustomFields(value: unknown): Record<string, CustomFieldValue> {
  const entries = Object.entries(object(value));
  if (!entries.length || entries.length > 100) fail(400, '변경할 사용자 정의 필드를 1~100개 선택해 주세요.');
  const parsed: [string, CustomFieldValue][] = entries.map(([id, fieldValue]) => {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(id) || id === 'constructor' || id === 'prototype') {
      fail(400, '변경할 사용자 정의 필드 ID를 확인해 주세요.');
    }
    if (fieldValue === null || typeof fieldValue === 'boolean' ||
        (typeof fieldValue === 'string' && fieldValue.length <= 20_000) ||
        (typeof fieldValue === 'number' && Number.isFinite(fieldValue))) return [id, fieldValue];
    if (Array.isArray(fieldValue) && fieldValue.length <= 200 &&
        fieldValue.every(option => typeof option === 'string' && option.length <= 48)) return [id, fieldValue];
    return fail(400, '변경할 사용자 정의 필드 값의 형식과 길이를 확인해 주세요.');
  });
  return Object.fromEntries(parsed);
}

function parseSelectedIssues<T extends IssueSelection>(value: unknown,
  withScope: (record: Record<string, unknown>, issue: IssueSelection) => T): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ISSUE_BULK_EDIT_LIMIT) {
    fail(400, `업무를 1~${ISSUE_BULK_EDIT_LIMIT}개 선택해 주세요.`);
  }
  const ids = new Set<string>();
  return value.map((value: unknown) => {
    const selection = object(value);
    const { id, expectedVersion } = selection;
    if (!isId(id) || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      fail(400, '업무 ID와 확인한 버전을 입력해 주세요.');
    }
    if (ids.has(id)) fail(400, '업무를 중복으로 선택할 수 없습니다.');
    ids.add(id);
    return withScope(selection, { id, expectedVersion });
  });
}

function parseChanges(raw: unknown, allowedFields = CHANGE_FIELDS, allowEmpty = false): IssueBulkEditChanges {
  const change = object(raw);
  const fields = Object.keys(change);
  if ((!allowEmpty && !fields.length) || fields.some(field => !allowedFields.has(field))) {
    fail(400, '지원하는 변경 항목을 한 가지 이상 선택해 주세요.');
  }
  const changes: IssueBulkEditChanges = {};
  if (Object.hasOwn(change, 'status')) {
    if (!isId(change.status)) fail(400, '변경할 업무 상태를 확인해 주세요.');
    changes.status = change.status;
  }
  if (Object.hasOwn(change, 'priority')) {
    if (typeof change.priority !== 'string' || !Object.hasOwn(PRIORITY, change.priority)) fail(400, '변경할 우선순위를 확인해 주세요.');
    changes.priority = change.priority as IssueBulkEditValues['priority'];
  }
  if (Object.hasOwn(change, 'assigneeId')) {
    if (change.assigneeId !== null && !isId(change.assigneeId)) fail(400, '변경할 담당자를 확인해 주세요.');
    changes.assigneeId = change.assigneeId;
  }
  if (Object.hasOwn(change, 'dueDate')) {
    if (change.dueDate !== null && !isCalendarDate(change.dueDate)) fail(400, '마감일을 YYYY-MM-DD 형식으로 입력해 주세요.');
    changes.dueDate = change.dueDate;
  }
  if (Object.hasOwn(change, 'parentId')) {
    if (change.parentId !== null && !isId(change.parentId)) fail(400, '지정할 상위 업무를 확인해 주세요.');
    changes.parentId = change.parentId;
  }
  for (const kind of PLANNING_KINDS) {
    const { idField } = planningFields(kind);
    if (!Object.hasOwn(change, idField)) continue;
    const id = change[idField];
    if (id !== null && !isId(id)) fail(400, `${PLANNING_META[kind].label} ID를 확인해 주세요.`);
    changes[idField] = id;
  }
  if (Object.hasOwn(change, 'addLabels')) changes.addLabels = parseLabels(change.addLabels, 'add');
  if (Object.hasOwn(change, 'removeLabels')) changes.removeLabels = parseLabels(change.removeLabels, 'remove');
  if (Object.hasOwn(change, 'customFields')) changes.customFields = parseCustomFields(change.customFields);
  if (changes.addLabels?.some(label => changes.removeLabels?.includes(label))) fail(400, '같은 라벨을 함께 추가하고 제거할 수 없습니다.');
  return changes;
}

function parsePreview(raw: unknown): IssueBulkEditPreviewInput {
  const input = object(raw);
  if (Object.keys(input).some(field => field !== 'issues' && field !== 'changes' && field !== 'fieldBreakdown')) fail(400, '업무 일괄 편집 요청 항목을 확인해 주세요.');
  const issues = parseSelectedIssues(input.issues, (selection, issue) => {
    if (Object.keys(selection).length !== 2) fail(400, '업무 ID와 확인한 버전을 입력해 주세요.');
    return issue;
  });
  const changes = parseChanges(input.changes);
  const fieldBreakdown = Object.hasOwn(input, 'fieldBreakdown') ? parseFieldBreakdownSelection(input.fieldBreakdown) : undefined;
  return { issues, changes, ...(fieldBreakdown ? { fieldBreakdown } : {}) };
}

function parseTeamPreview(raw: unknown): TeamIssueBulkEditPreviewInput {
  const input = object(raw);
  if (Object.keys(input).some(field => !['issues', 'changes', 'statuses', 'workflowVersions'].includes(field))) fail(400, '업무 일괄 편집 요청 항목을 확인해 주세요.');
  const issues = parseSelectedIssues(input.issues, (selection, issue) => {
    if (Object.keys(selection).length !== 3 || !isId(selection.projectId)) fail(400, '선택한 업무마다 프로젝트 ID를 입력해 주세요.');
    return { ...issue, projectId: selection.projectId };
  });
  const projects = new Set(issues.map(issue => issue.projectId));
  const entries = Object.hasOwn(input, 'statuses') ? Object.entries(object(input.statuses)) : [];
  const statuses = Object.fromEntries(entries.map(([projectId, status]) => {
    if (!projects.has(projectId) || !isId(status)) fail(400, '선택한 업무의 프로젝트별 상태를 확인해 주세요.');
    return [projectId, status];
  }));
  const versions = Object.hasOwn(input, 'workflowVersions') ? Object.entries(object(input.workflowVersions)) : [];
  if (versions.length !== entries.length) fail(400, '상태를 선택한 프로젝트마다 확인한 워크플로 버전을 보내 주세요.');
  const workflowVersions = Object.fromEntries(versions.map(([projectId, version]) => {
    if (!Object.hasOwn(statuses, projectId) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      fail(400, '상태를 선택한 프로젝트마다 확인한 워크플로 버전을 보내 주세요.');
    }
    return [projectId, version];
  }));
  return { issues, changes: parseChanges(input.changes, TEAM_CHANGE_FIELDS, entries.length > 0),
    ...(entries.length ? { statuses, workflowVersions } : {}) };
}

function verifyFieldBreakdown(projectId: string, { issues, fieldBreakdown }: IssueBulkEditPreviewInput, matches?: FieldBreakdownMatches) {
  if (fieldBreakdown && !matches?.(projectId, fieldBreakdown, issues.map(issue => issue.id))) {
    fail(409, '집계 이후 업무·보기·속성이 변경되었습니다. 필드 집계를 다시 조회해 주세요.', { reason: 'field_breakdown_stale' });
  }
}

function parseApply(raw: unknown): string {
  const input = object(raw);
  if (Object.keys(input).length !== 1 || !isId(input.previewId)) fail(400, '적용할 미리보기 ID를 확인해 주세요.');
  return input.previewId;
}

function parseStatusMigration(raw: unknown): WorkflowStatusMigrationPreviewInput {
  const input = object(raw);
  const { fromStatusId, toStatusId, expectedWorkflowVersion } = input;
  if (Object.keys(input).length !== 3 || !isId(fromStatusId) || !isId(toStatusId) || fromStatusId === toStatusId
      || typeof expectedWorkflowVersion !== 'number' || !Number.isSafeInteger(expectedWorkflowVersion) || expectedWorkflowVersion < 1) {
    fail(400, '서로 다른 출발·도착 상태와 확인한 워크플로 버전을 입력해 주세요.');
  }
  return { fromStatusId, toStatusId, expectedWorkflowVersion };
}

function customFieldValue(fields: Issue['customFields'], id: string): CustomFieldValue {
  const value = fields && Object.hasOwn(fields, id) ? fields[id] : null;
  return hasCustomValue(value) ? value : null;
}

function sameCustomValue(left: CustomFieldValue, right: CustomFieldValue): boolean {
  return Array.isArray(left) && Array.isArray(right) ? sameLabels([...left].sort(), [...right].sort()) : left === right;
}

function issueUpdate(before: Issue, { addLabels, removeLabels, customFields, ...fields }: IssueBulkEditChanges): IssueUpdate {
  const update: IssueUpdate = fields;
  if (customFields) update.customFields = Object.fromEntries(Object.entries(customFields).map(([id, value]) => {
    const previous = customFieldValue(before.customFields, id);
    return [id, sameCustomValue(previous, value) ? previous : value];
  }));
  if (!addLabels && !removeLabels) return update;
  const removed = new Set(removeLabels);
  const labels = before.labels.filter(label => !removed.has(label));
  const retained = new Set(labels);
  for (const label of addLabels ?? []) if (!retained.has(label)) {
    retained.add(label);
    labels.push(label);
  }
  return { ...update, labels };
}

function values(issue: Issue, update: IssueUpdate,
  includeDueDate = Object.hasOwn(update, 'dueDate')): IssueBulkEditValues {
  const { status, priority, assigneeId, dueDate, parentId, labels, customFields } = issue;
  const snapshot: IssueBulkEditValues = { status, priority, assigneeId,
    ...(includeDueDate ? { dueDate: dueDate ?? null } : {}),
    ...(Object.hasOwn(update, 'parentId') ? { parentId: parentId ?? null } : {}),
    ...(Object.hasOwn(update, 'labels') ? { labels } : {}),
    ...(update.customFields ? { customFields: Object.fromEntries(Object.keys(update.customFields).map(id => [id, customFieldValue(customFields, id)])) } : {}),
  };
  for (const field of PLAN_ID_FIELDS) if (Object.hasOwn(update, field)) snapshot[field] = issue[field] ?? null;
  return snapshot;
}

function sameLabels(left: string[] | undefined, right: string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((label, index) => label === right[index]));
}

function sameCustomFields(left: Issue['customFields'], right: Issue['customFields']): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every(id => Object.hasOwn(right, id) && sameCustomValue(left[id], right[id]));
}

function sameValues(left: IssueBulkEditValues | null, right: IssueBulkEditValues | null): boolean {
  return left === null || right === null ? left === right
    : left.status === right.status && left.priority === right.priority && left.assigneeId === right.assigneeId
      && left.dueDate === right.dueDate && left.parentId === right.parentId
      && PLAN_ID_FIELDS.every(field => left[field] === right[field])
      && sameLabels(left.labels, right.labels) && sameCustomFields(left.customFields, right.customFields);
}

function candidate<T extends { issue: Issue }>(before: Issue, changes: IssueBulkEditChanges, prepare: BulkEditHooks<T>['prepare'],
  preparedAt: string, { parents, plans }: BulkEditReferences): BulkEditCandidate<T> {
  const { id, key, title } = before;
  const update = issueUpdate(before, changes);
  const row = { id, key, title, before: values(before, update),
    ...(parents ? { parents: { before: parents.label(before.parentId), after: parents.label(update.parentId) } } : {}),
    ...(plans ? { plans: plans.labels(before) } : {}) };
  if (!update.customFields && sameValues(row.before, { ...row.before, ...update })) {
    return { before, row: { ...row, after: row.before, outcome: 'unchanged', reason: null } };
  }
  try {
    const prepared = prepare(before, update, preparedAt);
    const next = prepared.issue;
    if (next.id !== before.id || next.projectId !== before.projectId || next.version !== before.version + 1) {
      fail(500, '일괄 변경할 업무의 식별자 또는 버전이 일치하지 않습니다.');
    }
    const includeDueDate = Object.hasOwn(update, 'dueDate') || (next.dueDate ?? null) !== (before.dueDate ?? null);
    const reviewed = { ...row, before: values(before, update, includeDueDate), after: values(next, update, includeDueDate) };
    if (sameValues(reviewed.before, reviewed.after)) return { before, row: { ...reviewed, outcome: 'unchanged', reason: null } };
    return { before, prepared, row: { ...reviewed, outcome: 'changed', reason: null } };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== 'number' || !(status >= 400 && status < 500)) throw error;
    const reason = error instanceof Error ? error.message : '현재 업무 조건에서 변경할 수 없습니다.';
    return { before, row: { ...row, after: null, outcome: 'blocked', reason } };
  }
}

function matchesReview(current: IssueBulkEditRow, reviewed: IssueBulkEditRow): boolean {
  return current.id === reviewed.id && current.projectId === reviewed.projectId && current.outcome === reviewed.outcome
    && sameValues(current.before, reviewed.before) && sameValues(current.after, reviewed.after)
    && JSON.stringify(current.parents) === JSON.stringify(reviewed.parents)
    && JSON.stringify(current.plans) === JSON.stringify(reviewed.plans);
}

function changesFor(scope: EditScope, projectId: string): IssueBulkEditChanges {
  if (!scope.team || !scope.statuses || !Object.hasOwn(scope.statuses, projectId)) return scope.changes;
  return { ...scope.changes, status: scope.statuses[projectId] };
}

function reviewCandidate<T extends { issue: Issue }>(scope: EditScope, issue: Issue,
  prepare: BulkEditHooks<T>['prepare'], preparedAt: string, references: BulkEditReferences): BulkEditCandidate<T> {
  const result = candidate(issue, changesFor(scope, issue.projectId), prepare, preparedAt, references);
  if (scope.team) result.row.projectId = issue.projectId;
  return result;
}

export class IssueBulkEditService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_bulk_edit_previews (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS issue_bulk_edit_remove_after ON issue_bulk_edit_previews(json_extract(json,'$.removeAfter'));`);
    this.prune();
  }

  private prune(): void {
    this.store.db.prepare("DELETE FROM issue_bulk_edit_previews WHERE json_extract(json,'$.removeAfter') <= ?").run(after(0));
  }

  private loadIssues(selections: TeamIssueSelection[], missingStatus: 404 | 409): Issue[] {
    const getIssue = this.store.db.prepare('SELECT json FROM issues WHERE id = ? AND project_id = ?');
    const issues = selections.map(({ id, projectId }) => {
      const row = getIssue.get(id, projectId) as { json: string } | undefined;
      if (!row) fail(missingStatus, missingStatus === 404 ? '선택한 업무를 이 프로젝트에서 찾을 수 없습니다.' : STALE_MESSAGE, { issueId: id });
      return JSON.parse(row.json) as Issue;
    });
    for (const [index, issue] of issues.entries()) {
      if (issue.version !== selections[index].expectedVersion) fail(409, STALE_MESSAGE, { issueId: issue.id, currentVersion: issue.version });
    }
    return issues;
  }

  private statusCohort(projectId: string, statusId: string): Issue[] {
    const rows = this.store.db.prepare(`SELECT json FROM issues
      WHERE project_id = ? AND json_extract(json, '$.status') = ? ORDER BY rowid LIMIT ?`)
      .all(projectId, statusId, WORKFLOW_STATUS_MIGRATION_LIMIT + 1) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as Issue);
  }

  private teamConfigurationTokens<T extends { issue: Issue }>(scope: TeamBulkEditScope, hooks: BulkEditHooks<T>): [string, string][] {
    const projectIds = new Set(scope.issues.map(({ projectId }) => projectId));
    return [...projectIds].map(projectId => [projectId, hooks.configurationToken(projectId, changesFor(scope, projectId))]);
  }

  private parentReview(scope: EditScope, issues: readonly Issue[]): ParentReview | undefined {
    if (scope.team || !Object.hasOwn(scope.changes, 'parentId')) return undefined;
    const references = new Map<string, ParentIssue | null>();
    const roots = [scope.changes.parentId, ...issues.map(issue => issue.parentId)];
    // Version and ancestry are review evidence even when a parent's displayed label does not change.
    for (const root of roots) {
      for (let id = root; id && !references.has(id);) {
        const issue = this.store.get<Issue>('issues', id);
        const parent = issue ? { id: issue.id, key: issue.key, title: issue.title, version: issue.version,
          projectId: issue.projectId, parentId: issue.parentId ?? null } : null;
        references.set(id, parent);
        id = parent?.projectId === scope.projectId ? parent.parentId : null;
      }
    }
    return {
      fingerprint: createHash('sha256').update(JSON.stringify([...references])).digest('hex'),
      label(id) {
        const parent = id ? references.get(id) : null;
        return parent?.projectId === scope.projectId ? { id: parent.id, key: parent.key, title: parent.title } : null;
      },
    };
  }

  private planReview(scope: EditScope, issues: readonly Issue[]): PlanReview | undefined {
    if (scope.team) return undefined;
    const fields = PLANNING_KINDS.map(kind => ({ kind, idField: planningFields(kind).idField }))
      .filter(({ idField }) => Object.hasOwn(scope.changes, idField));
    if (!fields.length) return undefined;

    const references = new Map<string, PlanReference | null>();
    for (const { idField } of fields) {
      for (const id of [scope.changes[idField], ...issues.map(issue => issue[idField])]) {
        if (!id || references.has(id)) continue;
        const item = this.store.get<PlanningItem>('planning_items', id);
        references.set(id, item ? { id: item.id, projectId: item.projectId, kind: item.kind,
          status: item.status, name: item.name, version: item.version } : null);
      }
    }
    const label = (kind: PlanningKind, id?: string | null) => {
      const item = id ? references.get(id) : null;
      return item?.projectId === scope.projectId && item.kind === kind ? { id: item.id, name: item.name } : null;
    };
    return {
      fingerprint: createHash('sha256').update(JSON.stringify([...references])).digest('hex'),
      labels(issue) {
        const result: NonNullable<IssueBulkEditRow['plans']> = {};
        for (const { kind, idField } of fields) {
          result[kind] = { before: label(kind, issue[idField]), after: label(kind, scope.changes[idField]) };
        }
        return result;
      },
    };
  }

  private review<T extends { issue: Issue }>(scope: EditScope, issues: Issue[], hooks: BulkEditHooks<T>): IssueBulkEditPreview {
    const rows: IssueBulkEditRow[] = [];
    const counts = { changed: 0, unchanged: 0, blocked: 0 };
    const preparedAt = new Date().toISOString();
    const parents = this.parentReview(scope, issues), plans = this.planReview(scope, issues);
    const hasCustomFields = !scope.team && Boolean(scope.changes.customFields);
    let remainingBytes = hasCustomFields ? MAX_PACKAGE_BYTES - Buffer.byteLength(JSON.stringify(scope)) : Infinity;
    for (const issue of issues) {
      const { row } = reviewCandidate(scope, issue, hooks.prepare, preparedAt, { parents, plans });
      if (hasCustomFields) {
        remainingBytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
        if (remainingBytes < 0) fail(413, '미리보기 데이터가 너무 큽니다. 업무 또는 변경할 필드 수를 줄여 주세요.');
      }
      rows.push(row);
      counts[row.outcome]++;
    }
    if (counts.blocked || !counts.changed) return { previewId: null, expiresAt: null, rows, ...counts };

    const id = randomUUID();
    const expiresAt = after(AUTO_PREVIEW_TTL_MS);
    const summary = { id, removeAfter: expiresAt, rows, ...(parents ? { parentFingerprint: parents.fingerprint } : {}),
      ...(plans ? { planFingerprint: plans.fingerprint } : {}) };
    const proposal: BulkEditProposal = scope.team
      ? { ...scope, ...summary, configurationTokens: this.teamConfigurationTokens(scope, hooks) }
      : { ...scope, ...summary, configurationToken: hooks.configurationToken(scope.projectId, scope.changes) };
    this.store.put(TABLE, proposal);
    return { previewId: id, expiresAt, rows, ...counts };
  }

  private preview<T extends { issue: Issue }>(projectId: string, request: Request, hooks: BulkEditHooks<T>): IssueBulkEditPreview {
    const input = parsePreview(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      if (!this.store.get('projects', projectId)) fail(404, '프로젝트를 찾을 수 없습니다.');
      verifyFieldBreakdown(projectId, input, hooks.fieldBreakdownMatches);
      const issues = this.loadIssues(input.issues.map(issue => ({ ...issue, projectId })), 404);
      return this.review({ ...input, projectId, actorId }, issues, hooks);
    });
  }

  private previewTeam<T extends { issue: Issue }>(request: Request, hooks: WorkflowBulkEditHooks<T>): IssueBulkEditPreview {
    const input = parseTeamPreview(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      const issues = this.loadIssues(input.issues, 404);
      for (const [projectId, expectedVersion] of Object.entries(input.workflowVersions ?? {})) {
        const { version } = hooks.workflow(projectId);
        if (version !== expectedVersion) fail(409, STALE_MESSAGE, { projectId, currentWorkflowVersion: version });
      }
      return this.review({ ...input, team: true, actorId }, issues, hooks);
    });
  }

  private previewStatusMigration<T extends { issue: Issue }>(projectId: string, request: Request, hooks: WorkflowBulkEditHooks<T>): IssueBulkEditPreview {
    const { fromStatusId, toStatusId, expectedWorkflowVersion } = parseStatusMigration(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      const workflow = hooks.workflow(projectId);
      if (workflow.version !== expectedWorkflowVersion) fail(409, STALE_MESSAGE, { currentVersion: workflow.version });
      if (![fromStatusId, toStatusId].every(id => workflow.statuses.some(status => status.id === id))) {
        fail(400, '이 프로젝트의 출발·도착 상태를 선택해 주세요.');
      }
      const issues = this.statusCohort(projectId, fromStatusId);
      if (issues.length > WORKFLOW_STATUS_MIGRATION_LIMIT) {
        fail(422, `한 번에 활성 업무 ${WORKFLOW_STATUS_MIGRATION_LIMIT}개까지 상태를 이관할 수 있습니다.`, { limit: WORKFLOW_STATUS_MIGRATION_LIMIT });
      }
      return this.review({
        projectId, actorId, migrationFromStatusId: fromStatusId,
        issues: issues.map(({ id, version }) => ({ id, expectedVersion: version })),
        changes: { status: toStatusId },
      }, issues, hooks);
    });
  }

  private apply<T extends { issue: Issue }>(projectId: string, request: Request, hooks: BulkEditHooks<T>, statusMigration = false): IssueBulkEditResult {
    const previewId = parseApply(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<BulkEditProposal>(TABLE, previewId);
      if (!proposal || proposal.team || proposal.projectId !== projectId || proposal.actorId !== actorId || Boolean(proposal.migrationFromStatusId) !== statusMigration) {
        fail(404, '적용할 미리보기를 찾을 수 없습니다.');
      }
      if (proposal.removeAfter <= after(0)) fail(409, '미리보기가 만료되었습니다. 다시 확인해 주세요.');
      if (proposal.result) return proposal.result;
      verifyFieldBreakdown(projectId, proposal, hooks.fieldBreakdownMatches);
      if (!this.store.get('projects', projectId) || proposal.configurationToken !== hooks.configurationToken(projectId, proposal.changes)) fail(409, STALE_MESSAGE);

      // The migration preview represents the whole active source status, so an issue newly entering or leaving it also invalidates the review.
      const issues = proposal.migrationFromStatusId
        ? this.statusCohort(projectId, proposal.migrationFromStatusId)
        : this.loadIssues(proposal.issues.map(issue => ({ ...issue, projectId })), 409);
      if (proposal.migrationFromStatusId && (issues.length !== proposal.issues.length || issues.some(({ id, version }, index) =>
        id !== proposal.issues[index].id || version !== proposal.issues[index].expectedVersion))) fail(409, STALE_MESSAGE);
      return this.commitReview(proposal, issues, request, hooks);
    });
  }

  private applyTeam<T extends { issue: Issue }>(request: Request, hooks: BulkEditHooks<T>): IssueBulkEditResult {
    const previewId = parseApply(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<BulkEditProposal>(TABLE, previewId);
      if (!proposal?.team || proposal.actorId !== actorId) fail(404, '적용할 미리보기를 찾을 수 없습니다.');
      if (proposal.removeAfter <= after(0)) fail(409, '미리보기가 만료되었습니다. 다시 확인해 주세요.');
      if (proposal.result) return proposal.result;
      const issues = this.loadIssues(proposal.issues, 409);
      const tokens = this.teamConfigurationTokens(proposal, hooks);
      if (JSON.stringify(tokens) !== JSON.stringify(proposal.configurationTokens)) fail(409, STALE_MESSAGE);
      return this.commitReview(proposal, issues, request, hooks);
    });
  }

  private commitReview<T extends { issue: Issue }>(proposal: BulkEditProposal, issues: Issue[], request: Request,
    hooks: BulkEditHooks<T>): IssueBulkEditResult {
    const preparedAt = new Date().toISOString();
    const parents = this.parentReview(proposal, issues), plans = this.planReview(proposal, issues);
    if (parents?.fingerprint !== proposal.parentFingerprint || plans?.fingerprint !== proposal.planFingerprint) fail(409, STALE_MESSAGE);
    const prepared = issues.map(issue => reviewCandidate(proposal, issue, hooks.prepare, preparedAt, { parents, plans }));
    if (prepared.some(({ row }, index) => !matchesReview(row, proposal.rows[index]))) fail(409, STALE_MESSAGE);

    const result: IssueBulkEditResult = { previewId: proposal.id, updated: [], unchanged: 0 };
    for (const { before, prepared: change } of prepared) {
      if (!change) {
        result.unchanged++;
        continue;
      }
      hooks.commit(request, before, change);
      const { id, key, version } = change.issue;
      result.updated.push({ id, key, version });
    }
    this.store.put(TABLE, { ...proposal, result, removeAfter: after(AUTO_RESULT_RETENTION_MS) });
    return result;
  }

  resetForImport(): void {
    if (!this.store.db.isTransaction) fail(500, '업무 일괄 편집 미리보기 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM issue_bulk_edit_previews');
  }

  registerRoutes<T extends { issue: Issue }>(app: Express, hooks: WorkflowBulkEditHooks<T>): void {
    app.post('/api/team/issues/bulk-preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.previewTeam(request, hooks));
    });
    app.post('/api/team/issues/bulk-apply', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.applyTeam(request, hooks));
    });
    app.post('/api/projects/:projectId/issues/bulk-preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.preview(request.params.projectId, request, hooks));
    });
    app.post('/api/projects/:projectId/issues/bulk-apply', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.apply(request.params.projectId, request, hooks));
    });
  }

  registerStatusMigrationRoutes<T extends { issue: Issue }>(app: Express, hooks: WorkflowBulkEditHooks<T>): void {
    app.post('/api/projects/:projectId/workflow/status-migration-preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.previewStatusMigration(request.params.projectId, request, hooks));
    });
    app.post('/api/projects/:projectId/workflow/status-migration-apply', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.apply(request.params.projectId, request, hooks, true));
    });
  }
}
