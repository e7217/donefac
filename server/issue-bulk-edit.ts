import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import {
  ISSUE_BULK_EDIT_LIMIT, PRIORITY, type Issue, type IssueBulkEditChanges, type IssueBulkEditPreview,
  type IssueBulkEditPreviewInput, type IssueBulkEditResult, type IssueBulkEditRow, type IssueBulkEditValues,
} from '../shared/types.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS } from './automatic-schedule.js';
import type { Store } from './store.js';

export class IssueBulkEditError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

type IssueSelection = IssueBulkEditPreviewInput['issues'][number];
interface BulkEditHooks<T extends { issue: Issue }> {
  actor(request: Request): string;
  configurationToken(projectId: string): string;
  prepare(before: Issue, changes: IssueBulkEditChanges): T;
  commit(request: Request, before: Issue, prepared: T): void;
}
interface BulkEditProposal extends IssueBulkEditPreviewInput {
  id: string;
  projectId: string;
  actorId: string;
  removeAfter: string;
  configurationToken: string;
  rows: IssueBulkEditRow[];
  result?: IssueBulkEditResult;
}
interface BulkEditCandidate<T> { before: Issue; row: IssueBulkEditRow; prepared?: T }

const TABLE = 'issue_bulk_edit_previews';
const STALE_MESSAGE = '업무 또는 프로젝트 설정이 변경되었습니다. 다시 미리 확인해 주세요.';
const CHANGE_FIELDS = new Set(['status', 'priority', 'assigneeId']);
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

function parsePreview(raw: unknown): IssueBulkEditPreviewInput {
  const input = object(raw);
  if (Object.keys(input).some(field => field !== 'issues' && field !== 'changes')) fail(400, '업무 일괄 편집 요청 항목을 확인해 주세요.');
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
  if (!fields.length || fields.some(field => !CHANGE_FIELDS.has(field))) fail(400, '상태, 우선순위 또는 담당자 변경을 한 가지 이상 선택해 주세요.');
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
  return { issues, changes };
}

function parseApply(raw: unknown): string {
  const input = object(raw);
  if (Object.keys(input).length !== 1 || !isId(input.previewId)) fail(400, '적용할 미리보기 ID를 확인해 주세요.');
  return input.previewId;
}

function values({ status, priority, assigneeId }: Issue): IssueBulkEditValues {
  return { status, priority, assigneeId };
}

function sameValues(left: IssueBulkEditValues | null, right: IssueBulkEditValues | null): boolean {
  return left === null || right === null ? left === right
    : left.status === right.status && left.priority === right.priority && left.assigneeId === right.assigneeId;
}

function candidate<T extends { issue: Issue }>(before: Issue, changes: IssueBulkEditChanges, prepare: BulkEditHooks<T>['prepare']): BulkEditCandidate<T> {
  const { id, key, title } = before;
  const row = { id, key, title, before: values(before) };
  if (sameValues(row.before, { ...row.before, ...changes })) {
    return { before, row: { ...row, after: row.before, outcome: 'unchanged', reason: null } };
  }
  try {
    const prepared = prepare(before, changes);
    const next = prepared.issue;
    if (next.id !== before.id || next.projectId !== before.projectId || next.version !== before.version + 1) {
      fail(500, '일괄 변경할 업무의 식별자 또는 버전이 일치하지 않습니다.');
    }
    const nextValues = values(next);
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

  private preview<T extends { issue: Issue }>(projectId: string, request: Request, hooks: BulkEditHooks<T>): IssueBulkEditPreview {
    const input = parsePreview(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      if (!this.store.get('projects', projectId)) fail(404, '프로젝트를 찾을 수 없습니다.');
      const issues = this.loadIssues(projectId, input.issues, 404);
      const rows = issues.map(issue => candidate(issue, input.changes, hooks.prepare).row);
      const counts = { changed: 0, unchanged: 0, blocked: 0 };
      for (const row of rows) counts[row.outcome]++;
      if (counts.blocked || !counts.changed) return { previewId: null, expiresAt: null, rows, ...counts };

      const id = randomUUID();
      const expiresAt = after(AUTO_PREVIEW_TTL_MS);
      const proposal: BulkEditProposal = {
        ...input, id, projectId, actorId, removeAfter: expiresAt, rows, configurationToken: hooks.configurationToken(projectId),
      };
      this.store.put(TABLE, proposal);
      return { previewId: id, expiresAt, rows, ...counts };
    });
  }

  private apply<T extends { issue: Issue }>(projectId: string, request: Request, hooks: BulkEditHooks<T>): IssueBulkEditResult {
    const previewId = parseApply(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<BulkEditProposal>(TABLE, previewId);
      if (!proposal || proposal.projectId !== projectId || proposal.actorId !== actorId) fail(404, '적용할 미리보기를 찾을 수 없습니다.');
      if (proposal.removeAfter <= after(0)) fail(409, '미리보기가 만료되었습니다. 다시 확인해 주세요.');
      if (proposal.result) return proposal.result;
      if (!this.store.get('projects', projectId) || proposal.configurationToken !== hooks.configurationToken(projectId)) fail(409, STALE_MESSAGE);

      const issues = this.loadIssues(projectId, proposal.issues, 409);
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
}
