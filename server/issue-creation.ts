import type { Issue } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';

type IssueInput = Record<string, unknown>;
type CreationScope = { kind: 'schedule-successor'; predecessorId: string } |
  { kind: 'schedule-predecessor'; successorId: string } | { kind: 'issue-clone'; sourceIssueId: string };
type Receipt = { actorId: string; projectId: string; fingerprint: string; issueId: string | null };
type CreationReason = 'invalid_request_id' | 'invalid_request_body' | 'request_conflict' | 'result_unavailable';

export class IssueCreationError extends Error {
  constructor(public status: number, message: string, public details: { reason: CreationReason }) { super(message); }
}

function fingerprint(input: IssueInput): string {
  try { return creationRequestFingerprint(input); }
  catch {
    throw new IssueCreationError(400, '업무 생성 입력 형식을 확인해 주세요.', { reason: 'invalid_request_body' });
  }
}

export class IssueCreationService {
  constructor(private readonly store: Store) {
    // Retain used IDs independently of issue deletion or workspace replacement.
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_creation_requests (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      issue_id TEXT
    )`);
  }

  create(actorId: () => string, input: IssueInput, create: () => Issue, scope?: CreationScope): { issue: Issue; duplicate: boolean } {
    if (!scope && !Object.hasOwn(input, 'requestId')) {
      return { issue: this.store.transaction(create), duplicate: false };
    }
    const requestId = input.requestId;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) {
      throw new IssueCreationError(400, '업무 생성 요청 ID를 확인해 주세요.', { reason: 'invalid_request_id' });
    }
    const id = requestId.toLowerCase();
    // Keep the scope prefix and identity fields of previously saved requests.
    const { kind, ...identity } = scope ?? {};
    const digest = kind ? `${kind}:${fingerprint({ ...input, ...identity })}` : fingerprint(input);
    return this.store.transaction(() => {
      const author = actorId();
      const receipt = this.store.db.prepare(`SELECT actor_id AS actorId, project_id AS projectId,
        fingerprint, issue_id AS issueId FROM issue_creation_requests WHERE id=?`).get(id) as Receipt | undefined;
      if (receipt) {
        if (receipt.actorId !== author || receipt.fingerprint !== digest) {
          throw new IssueCreationError(409, '이미 사용한 업무 생성 요청입니다. 저장한 업무를 확인해 주세요.', { reason: 'request_conflict' });
        }
        const issue = receipt.issueId && this.store.get<Issue>('issues', receipt.issueId);
        if (!issue || issue.projectId !== receipt.projectId) {
          throw new IssueCreationError(409, '이 요청에서 생성한 업무를 현재 확인할 수 없습니다. 업무 목록과 휴지통을 확인해 주세요.', { reason: 'result_unavailable' });
        }
        return { issue, duplicate: true };
      }

      const issue = create();
      this.store.db.prepare('INSERT INTO issue_creation_requests(id,actor_id,project_id,fingerprint,issue_id) VALUES (?,?,?,?,?)')
        .run(id, author, issue.projectId, digest, issue.id);
      return { issue, duplicate: false };
    });
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Issue creation receipts must be invalidated in the import transaction.');
    this.store.db.exec('UPDATE issue_creation_requests SET issue_id=NULL WHERE issue_id IS NOT NULL');
  }
}
