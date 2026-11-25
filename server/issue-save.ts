import type { Issue } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type SaveRequest = { id: string; issueId: string; actorId: string; generation: string; fingerprint: string };
type SaveReceipt = { issueId: string; actorId: string; fingerprint: string; projectId: string; appliedVersion: number | null };

export class IssueSaveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class IssueSaveService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_save_requests (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      project_id TEXT NOT NULL,
      applied_version INTEGER
    )`);
  }

  parse(issueId: string, body: Record<string, unknown>, actorId: string): SaveRequest {
    const { requestId, expectedRestoreGeneration } = body;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId) ||
        typeof expectedRestoreGeneration !== 'string' || !expectedRestoreGeneration) {
      throw new IssueSaveError(400, '업무 저장 요청 ID와 워크스페이스 세대를 확인해 주세요.');
    }
    return { id: requestId.toLowerCase(), actorId, issueId, generation: expectedRestoreGeneration,
      fingerprint: creationRequestFingerprint(body) };
  }

  replay(request: SaveRequest): Issue | undefined {
    if (request.generation !== workspaceRestoreGeneration(this.store)) {
      throw new IssueSaveError(409, '워크스페이스가 복원되었습니다. 새로고침한 뒤 현재 업무를 확인해 주세요.');
    }
    const receipt = this.store.db.prepare(`SELECT issue_id AS issueId, actor_id AS actorId, fingerprint,
      project_id AS projectId, applied_version AS appliedVersion FROM issue_save_requests WHERE id=?`)
      .get(request.id) as SaveReceipt | undefined;
    if (!receipt) return undefined;
    if (receipt.actorId !== request.actorId || receipt.issueId !== request.issueId || receipt.fingerprint !== request.fingerprint) {
      throw new IssueSaveError(409, '이미 사용한 업무 저장 요청입니다. 현재 업무를 확인해 주세요.');
    }
    const issue = this.store.get<Issue>('issues', receipt.issueId);
    if (receipt.appliedVersion === null || !issue || issue.projectId !== receipt.projectId || issue.version < receipt.appliedVersion) {
      throw new IssueSaveError(409, '이 요청에서 저장한 업무를 현재 확인할 수 없습니다. 업무 목록과 휴지통을 확인해 주세요.');
    }
    return issue;
  }

  record(request: SaveRequest, issue: Issue): void {
    if (!this.store.db.isTransaction) throw new Error('Issue save receipts must be recorded in the write transaction.');
    this.store.db.prepare(`INSERT INTO issue_save_requests(id,issue_id,actor_id,fingerprint,project_id,applied_version)
      VALUES(?,?,?,?,?,?)`).run(request.id, issue.id, request.actorId, request.fingerprint, issue.projectId, issue.version);
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Issue save receipts must be invalidated in the import transaction.');
    this.store.db.exec('UPDATE issue_save_requests SET applied_version=NULL WHERE applied_version IS NOT NULL');
  }
}
