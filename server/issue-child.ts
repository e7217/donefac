import { createHash } from 'node:crypto';
import type { Issue, IssueChildCreationResult } from '../shared/types.js';
import type { Store } from './store.js';

type IssueInput = Record<string, unknown>;
type ChildRequest = { parentId: string; actorId: string; body: unknown };
type ChildReceipt = { parentId: string; actorId: string; fingerprint: string; childId: string };
type CreationHooks = {
  checkParentVersion(parent: Issue, expectedVersion: number): void;
  create(parent: Issue, input: IssueInput): Issue;
};

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class IssueChildCreationError extends Error {
  constructor(public status: number, message: string, public details?: { reason: 'parent_missing' }) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(body: unknown) {
  if (!isRecord(body) || Object.keys(body).some(key => !['requestId', 'expectedParentVersion', 'issue', 'actorId'].includes(key))) {
    throw new IssueChildCreationError(400, '하위 업무 생성 요청을 확인해 주세요.');
  }
  const { requestId, expectedParentVersion, issue } = body;
  if (typeof requestId !== 'string' || !uuidV4.test(requestId)) {
    throw new IssueChildCreationError(400, '하위 업무 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedParentVersion !== 'number' || !Number.isSafeInteger(expectedParentVersion) || expectedParentVersion < 1) {
    throw new IssueChildCreationError(400, '상위 업무의 버전을 확인해 주세요.');
  }
  if (!isRecord(issue)) throw new IssueChildCreationError(400, '생성할 하위 업무 정보를 확인해 주세요.');
  return { requestId: requestId.toLowerCase(), expectedParentVersion, issue };
}

function requestFingerprint(version: number, issue: IssueInput): string {
  let payload: string;
  try {
    payload = JSON.stringify([version, issue], (_key, value: unknown) => isRecord(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  } catch {
    throw new IssueChildCreationError(400, '하위 업무 입력 형식을 확인해 주세요.');
  }
  return createHash('sha256').update(payload).digest('hex');
}

export class IssueChildService {
  constructor(private readonly store: Store) {
    // Keep receipts when an issue is removed so a retry can never recreate it.
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_child_requests (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      child_id TEXT NOT NULL
    )`);
  }

  create({ parentId, actorId, body }: ChildRequest, hooks: CreationHooks): IssueChildCreationResult {
    const { requestId, expectedParentVersion, issue: input } = parseRequest(body);
    const fingerprint = requestFingerprint(expectedParentVersion, input);
    return this.store.transaction(() => {
      const parent = this.store.get<Issue>('issues', parentId);
      const receipt = this.store.db.prepare(`SELECT parent_id AS parentId, actor_id AS actorId,
        fingerprint, child_id AS childId FROM issue_child_requests WHERE id=?`).get(requestId) as ChildReceipt | undefined;
      if (receipt) {
        if (receipt.parentId !== parentId || receipt.actorId !== actorId || receipt.fingerprint !== fingerprint) {
          throw new IssueChildCreationError(409, '이미 사용한 하위 업무 생성 요청입니다. 상위 업무의 하위 목록을 확인해 주세요.');
        }
        const issue = this.store.get<Issue>('issues', receipt.childId);
        if (!parent || !issue || issue.parentId !== parentId || issue.projectId !== parent.projectId) {
          throw new IssueChildCreationError(409, '이전에 생성한 하위 업무 또는 현재 상위 관계를 확인할 수 없습니다.');
        }
        return { issue, duplicate: true };
      }

      if (!parent) throw new IssueChildCreationError(404, '상위 업무를 찾을 수 없습니다.', { reason: 'parent_missing' });
      hooks.checkParentVersion(parent, expectedParentVersion);
      if ((Object.hasOwn(input, 'projectId') && input.projectId !== parent.projectId) ||
          (Object.hasOwn(input, 'parentId') && input.parentId !== parent.id)) {
        throw new IssueChildCreationError(400, '하위 업무는 지정한 상위 업무와 같은 프로젝트에 만들어 주세요.');
      }
      const issue = hooks.create(parent, { ...input, projectId: parent.projectId, parentId: parent.id });
      this.store.db.prepare(`INSERT INTO issue_child_requests(id,parent_id,actor_id,fingerprint,child_id)
        VALUES (?,?,?,?,?)`).run(requestId, parent.id, actorId, fingerprint, issue.id);
      return { issue, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new IssueChildCreationError(500, '하위 업무 생성 기록 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM issue_child_requests');
  }
}
