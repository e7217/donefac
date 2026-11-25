import { randomUUID } from 'node:crypto';
import { isRelationId } from '../shared/issue-relations.js';
import type { Issue, IssueIntakePage, IssueIntakeRequest, IssueIntakeResult } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

const statuses = new Set(['pending', 'accepted', 'duplicate', 'rejected']);
const proposalFields = new Set(['title', 'description', 'type', 'status', 'priority', 'assigneeId', 'dueDate', 'startDate', 'endDate',
  'labels', 'parentId', 'collaboratorIds', 'cycleId', 'moduleId', 'releaseId', 'estimate', 'plannedEffortMinutes', 'customFields']);
const baseFields = ['requestId', 'restoreGeneration'];
const reviewFields = [...baseFields, 'expectedVersion', 'decision', 'reason'];
const pageSize = 30;
const receiptLifetime = 7 * 24 * 60 * 60 * 1000;
const titleLimit = 200;
const descriptionLimit = 5000;
const reasonLimit = 1000;

type ErrorReason = 'stale_request' | 'stale_target' | 'stale_workflow' | 'stale_schema' |
  'request_reused' | 'workspace_changed' | 'result_unavailable';
type Review = { expectedVersion: number; reason: string | null } & (
  { decision: 'accept'; issue: Record<string, unknown>; expectedWorkflowVersion: number; expectedIssueSchemaVersion: number } |
  { decision: 'duplicate'; issueId: string; expectedIssueVersion: number } |
  { decision: 'reject' });
type ReviewHooks = {
  versions: () => { workflow: number; schema: number };
  accept: (fields: Record<string, unknown>, request: IssueIntakeRequest) => Issue;
  record: (request: IssueIntakeRequest) => void;
};
type Receipt = { projectId: string; actorId: string; itemId: string; fingerprint: string };

export class IssueIntakeError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: ErrorReason) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const exactFields = (body: Record<string, unknown>, fields: readonly string[]) => Object.keys(body).every(field => fields.includes(field));
const validTimestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function boundedText(value: unknown, max: number, label: string, required = false, singleLine = false) {
  const controls = singleLine ? /[\u0000-\u001f\u007f]/u : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || controls.test(value) || (required && !value.trim())) {
    throw new IssueIntakeError(400, `${label}은(는) ${max}자 이내로 입력해 주세요.`);
  }
  return value.trim();
}

function parseAttempt(value: unknown) {
  if (!record(value) || typeof value.requestId !== 'string' || !creationRequestId.test(value.requestId) || !isRelationId(value.restoreGeneration)) {
    throw new IssueIntakeError(400, '접수 요청 ID와 워크스페이스 데이터를 확인해 주세요.');
  }
  return { body: value, requestId: value.requestId.toLowerCase(), generation: value.restoreGeneration };
}

function parseReview(body: Record<string, unknown>): Review {
  const { expectedVersion, decision } = body;
  if (!version(expectedVersion)) throw new IssueIntakeError(400, '검토할 접수 버전을 확인해 주세요.');
  const reason = body.reason === undefined ? null : boundedText(body.reason, reasonLimit, '검토 사유') || null;
  const common = { expectedVersion, reason };
  if (decision === 'reject' && exactFields(body, reviewFields) && reason) return { ...common, decision };
  if (decision === 'duplicate' && exactFields(body, [...reviewFields, 'issueId', 'expectedIssueVersion']) &&
      isRelationId(body.issueId) && version(body.expectedIssueVersion)) {
    return { ...common, decision, issueId: body.issueId, expectedIssueVersion: body.expectedIssueVersion };
  }
  if (decision === 'accept' && exactFields(body, [...reviewFields, 'issue', 'expectedWorkflowVersion', 'expectedIssueSchemaVersion']) &&
      record(body.issue) && Object.keys(body.issue).every(field => proposalFields.has(field)) &&
      version(body.expectedWorkflowVersion) && version(body.expectedIssueSchemaVersion)) {
    return { ...common, decision, issue: body.issue, expectedWorkflowVersion: body.expectedWorkflowVersion,
      expectedIssueSchemaVersion: body.expectedIssueSchemaVersion };
  }
  throw new IssueIntakeError(400, '등록할 업무, 중복 업무의 버전 또는 반려 사유를 확인해 주세요.');
}

export class IssueIntakeService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_intake (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL, reporter_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issue_intake_project_status ON issue_intake(project_id,status,created_at,id);
    CREATE TABLE IF NOT EXISTS issue_intake_receipts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, item_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issue_intake_receipts_expiry ON issue_intake_receipts(expires_at);`);
  }

  private put(item: IssueIntakeRequest) {
    this.store.db.prepare(`INSERT INTO issue_intake(id,project_id,status,reporter_id,created_at,updated_at,json) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,json=excluded.json`)
      .run(item.id, item.projectId, item.status, item.reporterId, item.createdAt, item.updatedAt, JSON.stringify(item));
  }

  private ensureProject(projectId: string) {
    if (!this.store.get('projects', projectId)) throw new IssueIntakeError(404, '접수함을 열 프로젝트를 찾을 수 없습니다.');
  }

  private item(projectId: string, id: string): IssueIntakeRequest | null {
    const row = this.store.db.prepare('SELECT json FROM issue_intake WHERE project_id=? AND id=?').get(projectId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as IssueIntakeRequest : null;
  }

  get(projectId: string, id: string): IssueIntakeRequest {
    const item = this.item(projectId, id);
    if (!item) throw new IssueIntakeError(404, '이 프로젝트에서 접수 요청을 찾을 수 없습니다.');
    return item;
  }

  list(projectId: string, actorId: string, query: Record<string, unknown>): IssueIntakePage {
    this.ensureProject(projectId);
    const { state = 'pending', offset = '0', q = '', mine } = query;
    if (!exactFields(query, ['state', 'offset', 'q', 'mine']) || (state !== 'pending' && state !== 'closed') ||
        typeof offset !== 'string' || !/^\d{1,7}$/u.test(offset) || Number(offset) > 1_000_000 || (mine !== undefined && mine !== '1')) {
      throw new IssueIntakeError(400, '접수 상태와 조회 범위를 확인해 주세요.');
    }
    const term = boundedText(q, 200, '검색어', false, true).toLowerCase();
    const filters = `project_id=?${mine ? ' AND reporter_id=?' : ''}${term
      ? " AND instr(lower(json_extract(json,'$.title') || ' ' || json_extract(json,'$.description') || ' ' || coalesce(json_extract(json,'$.issueKey'),'')),?)>0" : ''}`;
    const bindings = [projectId, ...(mine ? [actorId] : []), ...(term ? [term] : [])];
    const totals = this.store.db.prepare(`SELECT count(*) AS total, count(*) FILTER (WHERE status='pending') AS pending
      FROM issue_intake WHERE ${filters}`).get(...bindings) as { total: number; pending: number };
    const counts = { pending: totals.pending, closed: totals.total - totals.pending };
    const total = counts[state];
    const requestedOffset = Number(offset);
    const start = requestedOffset < total ? requestedOffset : Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
    const rows = this.store.db.prepare(`SELECT json FROM issue_intake WHERE ${filters} AND status ${state === 'pending' ? '=' : '!='} 'pending'
      ORDER BY ${state === 'pending' ? 'created_at' : 'updated_at'} DESC,id DESC LIMIT ? OFFSET ?`).all(...bindings, pageSize, start) as { json: string }[];
    return { items: rows.map(row => JSON.parse(row.json) as IssueIntakeRequest), total, offset: start, limit: pageSize, counts };
  }

  private withAttempt(projectId: string, actorId: string, attempt: ReturnType<typeof parseAttempt>, input: Record<string, unknown>,
    write: () => IssueIntakeRequest): IssueIntakeResult {
    return this.store.transaction(() => {
      this.ensureProject(projectId);
      if (workspaceRestoreGeneration(this.store) !== attempt.generation) {
        throw new IssueIntakeError(409, '워크스페이스가 복원되었습니다. 새 데이터에서 접수를 다시 확인해 주세요.', 'workspace_changed');
      }
      const now = Date.now();
      this.store.db.prepare('DELETE FROM issue_intake_receipts WHERE expires_at<=?').run(now);
      const fingerprint = creationRequestFingerprint(input);
      const receipt = this.store.db.prepare(`SELECT project_id AS projectId,actor_id AS actorId,item_id AS itemId,fingerprint
        FROM issue_intake_receipts WHERE id=?`).get(attempt.requestId) as Receipt | undefined;
      if (receipt) {
        if (receipt.projectId !== projectId || receipt.actorId !== actorId || receipt.fingerprint !== fingerprint) {
          throw new IssueIntakeError(409, '이미 다른 접수 요청에 사용한 ID입니다.', 'request_reused');
        }
        const item = this.item(projectId, receipt.itemId);
        if (!item) throw new IssueIntakeError(409, '저장한 접수 결과를 현재 프로젝트에서 찾을 수 없습니다.', 'result_unavailable');
        return { item, duplicate: true };
      }
      const item = write();
      this.store.db.prepare('INSERT INTO issue_intake_receipts(id,project_id,actor_id,item_id,fingerprint,expires_at) VALUES(?,?,?,?,?,?)')
        .run(attempt.requestId, projectId, actorId, item.id, fingerprint, now + receiptLifetime);
      return { item, duplicate: false };
    });
  }

  create(projectId: string, actorId: string, input: unknown, log: (item: IssueIntakeRequest) => void): IssueIntakeResult {
    const attempt = parseAttempt(input);
    const { body } = attempt;
    if (!exactFields(body, [...baseFields, 'title', 'description'])) throw new IssueIntakeError(400, '접수 입력을 확인해 주세요.');
    const title = boundedText(body.title, titleLimit, '요청 제목', true, true);
    const description = boundedText(body.description === undefined ? '' : body.description, descriptionLimit, '요청 설명');
    return this.withAttempt(projectId, actorId, attempt, { action: 'create', title, description }, () => {
      const now = new Date().toISOString();
      const item: IssueIntakeRequest = { id: randomUUID(), projectId, version: 1, title, description, reporterId: actorId, status: 'pending',
        createdAt: now, updatedAt: now, reviewerId: null, issueId: null, issueKey: null, reason: null };
      this.put(item);
      log(item);
      return item;
    });
  }

  review(projectId: string, id: string, actorId: string, input: unknown, hooks: ReviewHooks): IssueIntakeResult {
    const attempt = parseAttempt(input);
    const review = parseReview(attempt.body);
    return this.withAttempt(projectId, actorId, attempt, { action: 'review', id, review }, () => {
      const before = this.get(projectId, id);
      if (before.version !== review.expectedVersion || before.status !== 'pending') {
        throw new IssueIntakeError(409, '다른 작업자가 접수 요청을 처리했습니다. 최신 상태를 확인해 주세요.', 'stale_request');
      }
      let issue: Issue | null = null;
      if (review.decision === 'accept') {
        const current = hooks.versions();
        if (current.workflow !== review.expectedWorkflowVersion) {
          throw new IssueIntakeError(409, '프로젝트 워크플로가 바뀌었습니다. 최신 상태를 확인해 주세요.', 'stale_workflow');
        }
        if (current.schema !== review.expectedIssueSchemaVersion) {
          throw new IssueIntakeError(409, '프로젝트 업무 양식이 바뀌었습니다. 최신 필드를 확인해 주세요.', 'stale_schema');
        }
        issue = hooks.accept(review.issue, before);
      } else if (review.decision === 'duplicate') {
        issue = this.store.get<Issue>('issues', review.issueId) ?? null;
        if (issue?.projectId !== projectId || issue.version !== review.expectedIssueVersion) {
          throw new IssueIntakeError(409, '중복 업무가 변경되었거나 이 프로젝트에 없습니다. 업무를 다시 선택해 주세요.', 'stale_target');
        }
      }
      const status = review.decision === 'accept' ? 'accepted' : review.decision === 'reject' ? 'rejected' : 'duplicate';
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(before.updatedAt))).toISOString();
      const next: IssueIntakeRequest = { ...before, status, version: before.version + 1, updatedAt,
        reviewerId: actorId, issueId: issue?.id ?? null, issueKey: issue?.key ?? null, reason: review.reason };
      this.put(next);
      hooks.record(next);
      return next;
    });
  }

  exportRows(): IssueIntakeRequest[] {
    const rows = this.store.db.prepare('SELECT json FROM issue_intake ORDER BY id').all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as IssueIntakeRequest);
  }

  validateImport(value: unknown, projects: { id: string }[], users: { id: string }[]): IssueIntakeRequest[] {
    const bad = () => new IssueIntakeError(400, '백업의 업무 접수 목록, 작업자 또는 검토 결과를 확인해 주세요.');
    if (!Array.isArray(value) || value.length > 100_000) throw bad();
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const seen = new Set<string>();
    const accepted = new Set<string>();
    const fields = ['id', 'projectId', 'version', 'title', 'description', 'reporterId', 'status', 'createdAt', 'updatedAt',
      'reviewerId', 'issueId', 'issueKey', 'reason'];
    return value.map(row => {
      if (!record(row) || Object.keys(row).length !== fields.length || !exactFields(row, fields)) throw bad();
      const { id, projectId, reporterId, reviewerId, issueId, issueKey, reason, createdAt, updatedAt } = row;
      if (typeof id !== 'string' || !creationRequestId.test(id) || seen.has(id) || !isRelationId(projectId) || !projectIds.has(projectId) ||
          !isRelationId(reporterId) || !userIds.has(reporterId) || !version(row.version) ||
          typeof row.status !== 'string' || !statuses.has(row.status) || !validTimestamp(createdAt) || !validTimestamp(updatedAt) || updatedAt < createdAt) throw bad();
      const title = boundedText(row.title, titleLimit, '요청 제목', true, true);
      const description = boundedText(row.description, descriptionLimit, '요청 설명');
      const reviewReason = reason === null ? null : boundedText(reason, reasonLimit, '검토 사유') || null;
      const status = row.status as IssueIntakeRequest['status'];
      const hasIssue = status === 'accepted' || status === 'duplicate';
      if ((status === 'pending' ? reviewerId !== null || reviewReason !== null : !isRelationId(reviewerId) || !userIds.has(reviewerId)) ||
          (hasIssue ? !isRelationId(issueId) || !isRelationId(issueKey) : issueId !== null || issueKey !== null) ||
          (status === 'rejected' && !reviewReason)) throw bad();
      if (status === 'accepted' && typeof issueId === 'string') {
        if (accepted.has(issueId)) throw bad();
        accepted.add(issueId);
      }
      seen.add(id);
      return { id, projectId, reporterId, reviewerId: reviewerId as string | null, issueId: issueId as string | null,
        issueKey: issueKey as string | null, reason: reviewReason, version: row.version, title, description, status, createdAt, updatedAt };
    });
  }

  clearForImport(): Map<string, number> {
    const versions = new Map(this.exportRows().map(item => [item.id, item.version]));
    this.store.db.exec('DELETE FROM issue_intake_receipts; DELETE FROM issue_intake;');
    return versions;
  }

  restore(items: IssueIntakeRequest[], versions: Map<string, number>) {
    for (const item of items) this.put({ ...item, version: Math.max(item.version, (versions.get(item.id) ?? 0) + 1) });
  }
}
