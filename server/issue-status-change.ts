import type { Comment, Issue, IssueStatusChangeReceipt, IssueStatusChangeRequest, IssueStatusChangeResult } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type StatusChangeReason = 'request_reused' | 'receipt_unavailable' | 'workspace_changed';

export class IssueStatusChangeError extends Error {
  constructor(public status: number, message: string, reason?: StatusChangeReason) {
    super(message);
    this.details = reason ? { reason } : undefined;
  }

  readonly details?: { reason: StatusChangeReason };
}

type StoredReceipt = Omit<IssueStatusChangeReceipt, 'requestId'> & { actorId: string; fingerprint: string };
type CommentDraft = Pick<Comment, 'body' | 'mentions'>;
type TransitionInput = Pick<IssueStatusChangeRequest, 'status' | 'assigneeId' | 'expectedVersion' | 'expectedWorkflowVersion'>;
type StatusChangeHooks = {
  parseComment: (body: unknown, mentions: unknown) => CommentDraft;
  transition: (before: Issue, input: TransitionInput) => Issue;
  saveComment: (issue: Issue, draft: CommentDraft) => Comment;
};

const statusChangeFields = new Set(['requestId', 'expectedVersion', 'expectedWorkflowVersion', 'restoreGeneration', 'status', 'assigneeId', 'comment']);
const receiptLifetimeMs = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseStatusChange(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some(key => !statusChangeFields.has(key))) {
    throw new IssueStatusChangeError(400, '업무 상태 변경 요청을 확인해 주세요.');
  }
  const { requestId, expectedVersion, expectedWorkflowVersion, restoreGeneration, status, assigneeId, comment } = value;
  if (typeof requestId !== 'string' || !creationRequestId.test(requestId) || !isVersion(expectedVersion) ||
      !isVersion(expectedWorkflowVersion) || !isIdentifier(restoreGeneration) || !isIdentifier(status) ||
      (assigneeId !== undefined && assigneeId !== null && !isIdentifier(assigneeId))) {
    throw new IssueStatusChangeError(400, '업무 상태 변경 요청을 확인해 주세요.');
  }
  if (comment !== undefined && (!isRecord(comment) || Object.keys(comment).some(key => key !== 'body' && key !== 'mentions'))) {
    throw new IssueStatusChangeError(400, '업무 상태와 함께 저장할 댓글 요청을 확인해 주세요.');
  }
  return {
    requestId: requestId.toLowerCase(), restoreGeneration, comment,
    transition: { expectedVersion, expectedWorkflowVersion, status, ...(assigneeId === undefined ? {} : { assigneeId }) },
  };
}

export class IssueStatusChangeService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_status_change_requests (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      applied_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      assignee_id TEXT,
      comment_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issue_status_change_requests_expiry ON issue_status_change_requests(expires_at)`);
  }

  apply(issueId: string, actorId: string, value: unknown, hooks: StatusChangeHooks): IssueStatusChangeResult {
    const { requestId, restoreGeneration, comment, transition } = parseStatusChange(value);
    const draft = comment === undefined ? null : hooks.parseComment(comment.body, comment.mentions);
    const fingerprint = creationRequestFingerprint({ ...transition, restoreGeneration, comment });
    return this.store.transaction(() => {
      if (workspaceRestoreGeneration(this.store) !== restoreGeneration) {
        throw new IssueStatusChangeError(409, '워크스페이스가 복원되었습니다. 최신 업무를 불러와 주세요.', 'workspace_changed');
      }
      const now = Date.now();
      this.store.db.prepare('DELETE FROM issue_status_change_requests WHERE expires_at <= ?').run(new Date(now).toISOString());
      // Existing databases require a text value in comment_id. An empty value stores a receipt without a comment.
      const stored = this.store.db.prepare(`SELECT issue_id AS issueId, project_id AS projectId, actor_id AS actorId,
        fingerprint, applied_version AS appliedVersion, status, assignee_id AS assigneeId, NULLIF(comment_id, '') AS commentId
        FROM issue_status_change_requests WHERE id=?`).get(requestId) as StoredReceipt | undefined;
      if (stored) {
        if (stored.issueId !== issueId || stored.actorId !== actorId || stored.fingerprint !== fingerprint) {
          throw new IssueStatusChangeError(409, '이미 사용한 상태 변경 요청입니다. 현재 업무를 확인해 주세요.', 'request_reused');
        }
        const current = this.store.get<Issue>('issues', issueId);
        if (!current || current.projectId !== stored.projectId || current.version < stored.appliedVersion) {
          throw new IssueStatusChangeError(409, '상태를 변경한 업무를 현재 프로젝트에서 확인할 수 없습니다.', 'receipt_unavailable');
        }
        const { issueId: savedIssueId, projectId, appliedVersion, status, assigneeId, commentId } = stored;
        return { issue: current, receipt: { requestId, issueId: savedIssueId, projectId, appliedVersion, status, assigneeId, commentId }, duplicate: true };
      }

      const previous = this.store.get<Issue>('issues', issueId);
      if (!previous) throw new IssueStatusChangeError(404, '업무를 찾을 수 없습니다.');
      const issue = hooks.transition(previous, transition);
      const commentId = draft === null ? null : hooks.saveComment(issue, draft).id;
      const receipt: IssueStatusChangeReceipt = {
        requestId, issueId, projectId: issue.projectId, appliedVersion: issue.version,
        status: issue.status, assigneeId: issue.assigneeId, commentId,
      };
      this.store.db.prepare(`INSERT INTO issue_status_change_requests(id, issue_id, project_id, actor_id, fingerprint,
        applied_version, status, assignee_id, comment_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requestId, issueId, receipt.projectId, actorId, fingerprint, receipt.appliedVersion, receipt.status, receipt.assigneeId,
          receipt.commentId ?? '', new Date(now + receiptLifetimeMs).toISOString());
      return { issue, receipt, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Issue status change receipts must be cleared in the import transaction.');
    this.store.db.exec('DELETE FROM issue_status_change_requests');
  }
}
