import { createHash, randomUUID } from 'node:crypto';
import { DOCUMENT_SELECTION_TEXT_LIMIT } from '../shared/document-selection.js';
import type {
  DocPage, DocRevision, DocumentDecisionSource, DocumentFollowUpResult, DocumentSourceSelection, Issue, ResourceLink,
} from '../shared/types.js';
import { readDocumentSelection } from './document-content.js';
import type { Store } from './store.js';

type IssueInput = Record<string, unknown>;
type CreationInput = { documentId: string; actorId: string; body: unknown };
type CreationHooks = {
  create(documentId: string, expectedVersion: number, issueInput: IssueInput, selection?: DocumentSourceSelection): Pick<DocumentFollowUpResult, 'issue' | 'link'>;
};
type Receipt = { documentId: string; actorId: string; fingerprint: string; issueId: string; linkId: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class DocumentFollowUpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSelection(value: Record<string, unknown>): value is Record<string, unknown> & DocumentSourceSelection {
  const { from, to, text } = value;
  return typeof from === 'number' && Number.isSafeInteger(from) && from >= 0
    && typeof to === 'number' && Number.isSafeInteger(to) && to > from
    && typeof text === 'string' && text.length <= DOCUMENT_SELECTION_TEXT_LIMIT && Boolean(text.trim()) && text.isWellFormed();
}

function parse(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !['requestId', 'expectedDocumentVersion', 'issue', 'actorId', 'sourceSelection'].includes(key))) {
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
  let selection: DocumentSourceSelection | undefined;
  if (Object.hasOwn(body, 'sourceSelection')) {
    const input = body.sourceSelection;
    if (!record(input) || Object.keys(input).length !== 3 || !validSelection(input)) {
      throw new DocumentFollowUpError(400, '후속 업무에 남길 문서의 선택 범위를 확인해 주세요.');
    }
    const { from, to, text } = input;
    selection = { from, to, text };
  }
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, issue, selection };
}

function requestFingerprint(version: number, issue: IssueInput, selection?: DocumentSourceSelection): string {
  let payload: string;
  try {
    // Keep earlier unquoted requests' fingerprints valid across upgrades.
    payload = JSON.stringify(selection ? [version, issue, selection] : [version, issue], (_key, value: unknown) => record(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  } catch {
    throw new DocumentFollowUpError(400, '생성할 업무의 입력 형식을 확인해 주세요.');
  }
  return createHash('sha256').update(payload).digest('hex');
}

export function resolveDocumentDecisionSource(store: Store, document: DocPage, actorId: string, selection: DocumentSourceSelection): DocumentDecisionSource {
  if (!store.db.isTransaction) throw new DocumentFollowUpError(500, '후속 업무의 문서 발췌 저장에는 트랜잭션이 필요합니다.');
  const { from, to } = selection;
  const text = readDocumentSelection(document.content, from, to);
  if (text === null || text !== selection.text) {
    throw new DocumentFollowUpError(409, '선택한 문장이 현재 저장된 문서와 일치하지 않습니다. 원문에서 다시 선택해 주세요.');
  }
  const content = JSON.stringify(document.content);
  const rows = store.db.prepare(`SELECT json FROM revisions
    WHERE document_id=? AND json_extract(json,'$.version')=? ORDER BY rowid DESC`).all(document.id, document.version) as { json: string }[];
  const existing = rows.map(row => JSON.parse(row.json) as DocRevision)
    .find(revision => revision.title === document.title && JSON.stringify(revision.content) === content);
  if (existing) return { revisionId: existing.id, from, to, text };

  const revision: DocRevision = {
    id: randomUUID(), documentId: document.id, version: document.version, title: document.title,
    content: document.content, plainText: document.plainText, authorId: actorId, createdAt: new Date().toISOString(), summary: '후속 업무 원문 저장',
  };
  store.put('revisions', revision);
  return { revisionId: revision.id, from, to, text };
}

export function validateDocumentDecisionSource(value: unknown, documentId: string, revisions: ReadonlyMap<string, DocRevision>, knownDocument: boolean): void {
  const invalidSource = () => new DocumentFollowUpError(400, '후속 업무에 저장된 문서 발췌와 원문 저장본을 확인해 주세요.');
  if (!record(value) || Object.keys(value).length !== 4 || !validSelection(value)) throw invalidSource();
  const { revisionId, from, to, text } = value;
  if (typeof revisionId !== 'string' || !revisionId.trim() || revisionId.length > 200
      || !revisionId.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(revisionId)) throw invalidSource();
  const revision = revisions.get(revisionId);
  if (!revision && !knownDocument) return;
  if (!revision || revision.documentId !== documentId || readDocumentSelection(revision.content, from, to) !== text) throw invalidSource();
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
    const { requestId, expectedDocumentVersion, issue: issueInput, selection } = parse(body);
    const fingerprint = requestFingerprint(expectedDocumentVersion, issueInput, selection);
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

      const { issue, link } = hooks.create(documentId, expectedDocumentVersion, issueInput, selection);
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
