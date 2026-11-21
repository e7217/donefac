import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { isCalendarDate } from '../shared/calendar.js';
import {
  ISSUE_BULK_EDIT_LIMIT, ISSUE_BULK_LABEL_LIMIT, ISSUE_BULK_LABEL_MAX_LENGTH, PRIORITY, WORKFLOW_STATUS_MIGRATION_LIMIT,
  type Issue, type IssueBulkEditChanges, type IssueBulkEditPreview,
  type IssueBulkEditPreviewInput, type IssueBulkEditResult, type IssueBulkEditRow, type IssueBulkEditValues,
  type IssueFieldBreakdownSelection, type ProjectWorkflow, type WorkflowStatusMigrationPreviewInput,
} from '../shared/types.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS } from './automatic-schedule.js';
import { parseFieldBreakdownSelection } from './field-breakdown-routes.js';
import type { Store } from './store.js';

export class IssueBulkEditError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

type IssueSelection = IssueBulkEditPreviewInput['issues'][number];
type IssueUpdate = Partial<IssueBulkEditValues>;
type FieldBreakdownMatches = (projectId: string, selection: IssueFieldBreakdownSelection, issueIds: readonly string[]) => boolean;
interface BulkEditHooks<T extends { issue: Issue }> {
  actor(request: Request): string;
  configurationToken(projectId: string): string;
  fieldBreakdownMatches?: FieldBreakdownMatches;
  prepare(before: Issue, update: IssueUpdate): T;
  commit(request: Request, before: Issue, prepared: T): void;
}
interface StatusMigrationHooks<T extends { issue: Issue }> extends BulkEditHooks<T> {
  workflow(projectId: string): ProjectWorkflow;
}
interface BulkEditScope extends IssueBulkEditPreviewInput {
  projectId: string;
  actorId: string;
  migrationFromStatusId?: string;
}
interface BulkEditProposal extends BulkEditScope {
  id: string;
  removeAfter: string;
  configurationToken: string;
  rows: IssueBulkEditRow[];
  result?: IssueBulkEditResult;
}
interface BulkEditCandidate<T> { before: Issue; row: IssueBulkEditRow; prepared?: T }

const TABLE = 'issue_bulk_edit_previews';
const STALE_MESSAGE = '업무 또는 프로젝트 설정이 변경되었습니다. 다시 미리 확인해 주세요.';
const CHANGE_FIELDS = new Set(['status', 'priority', 'assigneeId', 'dueDate', 'addLabels', 'removeLabels']);
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

function parsePreview(raw: unknown): IssueBulkEditPreviewInput {
  const input = object(raw);
  if (Object.keys(input).some(field => field !== 'issues' && field !== 'changes' && field !== 'fieldBreakdown')) fail(400, '업무 일괄 편집 요청 항목을 확인해 주세요.');
  if (!Array.isArray(input.issues) || input.issues.length < 1 || input.issues.length > ISSUE_BULK_EDIT_LIMIT) {
    fail(400, `업무를 1~${ISSUE_BULK_EDIT_LIMIT}개 선택해 주세요.`);
  }
  const ids = new Set<string>();
  const issues = input.issues.map((value): IssueSelection => {
    const selection = object(value);
    const { id, expectedVersion } = selection;
    if (Object.keys(selection).length !== 2 || !isId(id) || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      fail(400, '업무 ID와 확인한 버전을 입력해 주세요.');
    }
    if (ids.has(id)) fail(400, '업무를 중복으로 선택할 수 없습니다.');
    ids.add(id);
    return { id, expectedVersion };
  });

  const change = object(input.changes);
  const fields = Object.keys(change);
  if (!fields.length || fields.some(field => !CHANGE_FIELDS.has(field))) fail(400, '지원하는 변경 항목을 한 가지 이상 선택해 주세요.');
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
  if (Object.hasOwn(change, 'addLabels')) changes.addLabels = parseLabels(change.addLabels, 'add');
  if (Object.hasOwn(change, 'removeLabels')) changes.removeLabels = parseLabels(change.removeLabels, 'remove');
  if (changes.addLabels?.some(label => changes.removeLabels?.includes(label))) fail(400, '같은 라벨을 함께 추가하고 제거할 수 없습니다.');
  const fieldBreakdown = Object.hasOwn(input, 'fieldBreakdown') ? parseFieldBreakdownSelection(input.fieldBreakdown) : undefined;
  return { issues, changes, ...(fieldBreakdown ? { fieldBreakdown } : {}) };
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

function issueUpdate(before: Issue, { addLabels, removeLabels, ...fields }: IssueBulkEditChanges): IssueUpdate {
  if (!addLabels && !removeLabels) return fields;
  const removed = new Set(removeLabels);
  const labels = before.labels.filter(label => !removed.has(label));
  const retained = new Set(labels);
  for (const label of addLabels ?? []) if (!retained.has(label)) {
    retained.add(label);
    labels.push(label);
  }
  return { ...fields, labels };
}

function values({ status, priority, assigneeId, dueDate, labels }: Issue, update: IssueUpdate): IssueBulkEditValues {
  // Include these fields when requested so reviews saved before their introduction still match on replay.
  return { status, priority, assigneeId,
    ...(Object.hasOwn(update, 'dueDate') ? { dueDate } : {}),
    ...(Object.hasOwn(update, 'labels') ? { labels } : {}),
  };
}

function sameLabels(left: string[] | undefined, right: string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((label, index) => label === right[index]));
}

function sameValues(left: IssueBulkEditValues | null, right: IssueBulkEditValues | null): boolean {
  return left === null || right === null ? left === right
    : left.status === right.status && left.priority === right.priority && left.assigneeId === right.assigneeId
      && left.dueDate === right.dueDate && sameLabels(left.labels, right.labels);
}

function candidate<T extends { issue: Issue }>(before: Issue, changes: IssueBulkEditChanges, prepare: BulkEditHooks<T>['prepare']): BulkEditCandidate<T> {
  const { id, key, title } = before;
  const update = issueUpdate(before, changes);
  const row = { id, key, title, before: values(before, update) };
  if (sameValues(row.before, { ...row.before, ...update })) {
    return { before, row: { ...row, after: row.before, outcome: 'unchanged', reason: null } };
  }
  try {
    const prepared = prepare(before, update);
    const next = prepared.issue;
    if (next.id !== before.id || next.projectId !== before.projectId || next.version !== before.version + 1) {
      fail(500, '일괄 변경할 업무의 식별자 또는 버전이 일치하지 않습니다.');
    }
    const nextValues = values(next, update);
    if (sameValues(row.before, nextValues)) return { before, row: { ...row, after: nextValues, outcome: 'unchanged', reason: null } };
    return { before, prepared, row: { ...row, after: nextValues, outcome: 'changed', reason: null } };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== 'number' || !(status >= 400 && status < 500)) throw error;
    const reason = error instanceof Error ? error.message : '현재 업무 조건에서 변경할 수 없습니다.';
    return { before, row: { ...row, after: null, outcome: 'blocked', reason } };
  }
}

function matchesReview(current: IssueBulkEditRow, reviewed: IssueBulkEditRow): boolean {
  return current.id === reviewed.id && current.outcome === reviewed.outcome
    && sameValues(current.before, reviewed.before) && sameValues(current.after, reviewed.after);
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

  private loadIssues(projectId: string, selections: IssueSelection[], missingStatus: 404 | 409): Issue[] {
    const getIssue = this.store.db.prepare('SELECT json FROM issues WHERE id = ? AND project_id = ?');
    const issues = selections.map(({ id }) => {
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

  private review<T extends { issue: Issue }>(scope: BulkEditScope, issues: Issue[], hooks: BulkEditHooks<T>): IssueBulkEditPreview {
    const rows = issues.map(issue => candidate(issue, scope.changes, hooks.prepare).row);
    const counts = { changed: 0, unchanged: 0, blocked: 0 };
    for (const row of rows) counts[row.outcome]++;
    if (counts.blocked || !counts.changed) return { previewId: null, expiresAt: null, rows, ...counts };

    const id = randomUUID();
    const expiresAt = after(AUTO_PREVIEW_TTL_MS);
    const proposal: BulkEditProposal = {
      ...scope, id, removeAfter: expiresAt, rows, configurationToken: hooks.configurationToken(scope.projectId),
    };
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
      const issues = this.loadIssues(projectId, input.issues, 404);
      return this.review({ ...input, projectId, actorId }, issues, hooks);
    });
  }

  private previewStatusMigration<T extends { issue: Issue }>(projectId: string, request: Request, hooks: StatusMigrationHooks<T>): IssueBulkEditPreview {
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
      if (!proposal || proposal.projectId !== projectId || proposal.actorId !== actorId || Boolean(proposal.migrationFromStatusId) !== statusMigration) {
        fail(404, '적용할 미리보기를 찾을 수 없습니다.');
      }
      if (proposal.removeAfter <= after(0)) fail(409, '미리보기가 만료되었습니다. 다시 확인해 주세요.');
      if (proposal.result) return proposal.result;
      verifyFieldBreakdown(projectId, proposal, hooks.fieldBreakdownMatches);
      if (!this.store.get('projects', projectId) || proposal.configurationToken !== hooks.configurationToken(projectId)) fail(409, STALE_MESSAGE);

      // The migration preview represents the whole active source status, so an issue newly entering or leaving it also invalidates the review.
      const issues = proposal.migrationFromStatusId
        ? this.statusCohort(projectId, proposal.migrationFromStatusId)
        : this.loadIssues(projectId, proposal.issues, 409);
      if (proposal.migrationFromStatusId && (issues.length !== proposal.issues.length || issues.some(({ id, version }, index) =>
        id !== proposal.issues[index].id || version !== proposal.issues[index].expectedVersion))) fail(409, STALE_MESSAGE);
      const prepared = issues.map(issue => candidate(issue, proposal.changes, hooks.prepare));
      if (prepared.some(({ row }, index) => !matchesReview(row, proposal.rows[index]))) fail(409, STALE_MESSAGE);

      const result: IssueBulkEditResult = { previewId, updated: [], unchanged: 0 };
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
    });
  }

  resetForImport(): void {
    if (!this.store.db.isTransaction) fail(500, '업무 일괄 편집 미리보기 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM issue_bulk_edit_previews');
  }

  registerRoutes<T extends { issue: Issue }>(app: Express, hooks: BulkEditHooks<T>): void {
    app.post('/api/projects/:projectId/issues/bulk-preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.preview(request.params.projectId, request, hooks));
    });
    app.post('/api/projects/:projectId/issues/bulk-apply', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.apply(request.params.projectId, request, hooks));
    });
  }

  registerStatusMigrationRoutes<T extends { issue: Issue }>(app: Express, hooks: StatusMigrationHooks<T>): void {
    app.post('/api/projects/:projectId/workflow/status-migration-preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.previewStatusMigration(request.params.projectId, request, hooks));
    });
    app.post('/api/projects/:projectId/workflow/status-migration-apply', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.apply(request.params.projectId, request, hooks, true));
    });
  }
}
