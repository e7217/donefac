import { createHash } from 'node:crypto';
import type { DocPage, DocumentFollowUpResult, Issue, ResourceLink } from '../shared/types.js';
import type { Store } from './store.js';

type IssueInput = Record<string, unknown>;
type CreationInput = { documentId: string; actorId: string; body: unknown };
type CreationHooks = {
  create(documentId: string, expectedVersion: number, issueInput: IssueInput): Pick<DocumentFollowUpResult, 'issue' | 'link'>;
};
type Receipt = { documentId: string; actorId: string; fingerprint: string; issueId: string; linkId: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class DocumentFollowUpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parse(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !['requestId', 'expectedDocumentVersion', 'issue', 'actorId'].includes(key))) {
    throw new DocumentFollowUpError(400, '후속 업무 요청을 확인해 주세요.');
  }
  const { requestId, expectedDocumentVersion, issue } = body;
  if (typeof requestId !== 'string' || !uuid.test(requestId)) {
    throw new DocumentFollowUpError(400, '후속 업무 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedDocumentVersion !== 'number' || !Number.isSafeInteger(expectedDocumentVersion) || expectedDocumentVersion < 1) {
    throw new DocumentFollowUpError(400, '연결할 문서의 버전을 확인해 주세요.');
  }
  if (!record(issue)) throw new DocumentFollowUpError(400, '생성할 업무 정보를 확인해 주세요.');
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, issue };
}

function requestFingerprint(version: number, issue: IssueInput): string {
  let payload: string;
  try {
    payload = JSON.stringify([version, issue], (_key, value: unknown) => record(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  } catch {
    throw new DocumentFollowUpError(400, '생성할 업무의 입력 형식을 확인해 주세요.');
  }
  return createHash('sha256').update(payload).digest('hex');
}

export class DocumentFollowUpService {
  constructor(private readonly store: Store) {
    // Receipts survive removal of either item so retries cannot recreate a purged issue.
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_follow_up_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      link_id TEXT NOT NULL
    )`);
  }

  create({ documentId, actorId, body }: CreationInput, hooks: CreationHooks): DocumentFollowUpResult {
    const { requestId, expectedDocumentVersion, issue: issueInput } = parse(body);
    const fingerprint = requestFingerprint(expectedDocumentVersion, issueInput);
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
        issue_id AS issueId, link_id AS linkId FROM document_follow_up_requests WHERE id=?`).get(requestId) as Receipt | undefined;
      if (receipt) {
        if (receipt.actorId !== actorId || receipt.documentId !== documentId || receipt.fingerprint !== fingerprint) {
          throw new DocumentFollowUpError(409, '이미 사용한 후속 업무 요청입니다. 현재 업무와 연결을 확인해 주세요.');
        }
        const document = this.store.get<DocPage>('documents', documentId);
        const issue = this.store.get<Issue>('issues', receipt.issueId);
        const link = this.store.get<ResourceLink>('resource_links', receipt.linkId);
        if (!document || !issue || !link || link.documentId !== documentId || link.issueId !== issue.id) {
          throw new DocumentFollowUpError(409, '이전에 생성한 후속 업무 또는 문서 연결을 확인할 수 없습니다.');
        }
        return { issue, link, duplicate: true };
      }

      const { issue, link } = hooks.create(documentId, expectedDocumentVersion, issueInput);
      this.store.db.prepare(`INSERT INTO document_follow_up_requests(id, document_id, actor_id, fingerprint, issue_id, link_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(requestId, documentId, actorId, fingerprint, issue.id, link.id);
      return { issue, link, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new DocumentFollowUpError(500, '후속 업무 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM document_follow_up_requests');
  }
}
