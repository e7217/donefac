import { createHash, randomUUID } from 'node:crypto';
import { DOCUMENT_SELECTION_TEXT_LIMIT } from '../shared/document-selection.js';
import type {
  DocPage, DocRevision, DocumentDecisionSource, DocumentFollowUpResult, DocumentIssueLinkResult, DocumentSourceSelection, Issue, ResourceLink,
} from '../shared/types.js';
import { readDocumentSelection } from './document-content.js';
import type { Store } from './store.js';

type IssueInput = Record<string, unknown>;
type RequestInput = { documentId: string; actorId: string; body: unknown };
type CreationHooks = {
  create(documentId: string, expectedVersion: number, issueInput: IssueInput, selection?: DocumentSourceSelection): Pick<DocumentFollowUpResult, 'issue' | 'link'>;
};
type DecisionLinkHooks = {
  checkVersion(document: DocPage, expectedVersion: number): void;
  onLinked(issue: Issue, document: DocPage): void;
};
type Receipt = { documentId: string; actorId: string; fingerprint: string; issueId: string; linkId: string };
type DecisionLinkReceipt = Receipt & { revisionId: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class DocumentFollowUpError extends Error {
  constructor(public status: number, message: string, public details?: { reason: 'source_selection_changed' | 'decision_source_exists' }) { super(message); }
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

export function parseDocumentSourceSelection(input: unknown): DocumentSourceSelection | undefined {
  if (!record(input) || Object.keys(input).length !== 3 || !validSelection(input)) return;
  const { from, to, text } = input;
  return { from, to, text };
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
    selection = parseDocumentSourceSelection(body.sourceSelection);
    if (!selection) {
      throw new DocumentFollowUpError(400, '후속 업무에 남길 문서의 선택 범위를 확인해 주세요.');
    }
  }
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, issue, selection };
}

function parseDecisionLink(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !['requestId', 'expectedDocumentVersion', 'issueId', 'actorId', 'sourceSelection'].includes(key))) {
    throw new DocumentFollowUpError(400, '결정 근거 연결 요청을 확인해 주세요.');
  }
  const { requestId, expectedDocumentVersion, issueId } = body;
  if (typeof requestId !== 'string' || !uuid.test(requestId)) {
    throw new DocumentFollowUpError(400, '결정 근거 연결 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedDocumentVersion !== 'number' || !Number.isSafeInteger(expectedDocumentVersion) || expectedDocumentVersion < 1) {
    throw new DocumentFollowUpError(400, '연결할 문서의 버전을 확인해 주세요.');
  }
  if (typeof issueId !== 'string' || !issueId.length) throw new DocumentFollowUpError(400, '연결할 업무를 확인해 주세요.');
  const selection = parseDocumentSourceSelection(body.sourceSelection);
  if (!selection) throw new DocumentFollowUpError(400, '결정 근거로 남길 문서의 선택 범위를 확인해 주세요.');
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, issueId, selection };
}

function sameSelection(a: DocumentSourceSelection, b: DocumentSourceSelection): boolean {
  return a.from === b.from && a.to === b.to && a.text === b.text;
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

export function resolveDocumentDecisionSource(store: Store, document: DocPage, actorId: string, selection: DocumentSourceSelection,
  summary = '후속 업무 원문 저장', acceptExisting: (revision: DocRevision) => boolean = () => true): DocumentDecisionSource {
  if (!store.db.isTransaction) throw new DocumentFollowUpError(500, '문서 발췌 저장에는 트랜잭션이 필요합니다.');
  const { from, to } = selection;
  const text = readDocumentSelection(document.content, from, to);
  if (text === null || text !== selection.text) {
    throw new DocumentFollowUpError(409, '선택한 문장이 현재 저장된 문서와 일치하지 않습니다. 원문에서 다시 선택해 주세요.', { reason: 'source_selection_changed' });
  }
  const content = JSON.stringify(document.content);
  const rows = store.db.prepare(`SELECT json FROM revisions
    WHERE document_id=? AND json_extract(json,'$.version')=? AND json_type(json,'$.confluenceSourceVersion') IS NULL
    ORDER BY rowid DESC`).all(document.id, document.version) as { json: string }[];
  const existing = rows.map(row => JSON.parse(row.json) as DocRevision)
    .find(revision => revision.title === document.title && JSON.stringify(revision.content) === content && acceptExisting(revision));
  if (existing) return { revisionId: existing.id, from, to, text };

  const revision: DocRevision = {
    id: randomUUID(), documentId: document.id, version: document.version, title: document.title,
    content: document.content, plainText: document.plainText, authorId: actorId, createdAt: new Date().toISOString(), summary,
  };
  store.put('revisions', revision);
  return { revisionId: revision.id, from, to, text };
}

export function validateDocumentDecisionSource(value: unknown, documentId: string, revisions: ReadonlyMap<string, DocRevision>, knownDocument: boolean,
  errorMessage = '업무에 연결된 문서 발췌와 원문 저장본을 확인해 주세요.'): void {
  const invalidSource = () => new DocumentFollowUpError(400, errorMessage);
  if (!record(value) || Object.keys(value).length !== 4 || !validSelection(value)) throw invalidSource();
  const { revisionId, from, to, text } = value;
  if (typeof revisionId !== 'string' || !revisionId.trim() || revisionId.length > 200
      || !revisionId.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(revisionId)) throw invalidSource();
  const revision = revisions.get(revisionId);
  if (!revision && !knownDocument) return;
  if (!revision || revision.documentId !== documentId || revision.confluenceSourceVersion !== undefined ||
      readDocumentSelection(revision.content, from, to) !== text) throw invalidSource();
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
    );
    CREATE TABLE IF NOT EXISTS document_decision_link_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      revision_id TEXT NOT NULL
    )`);
  }

  create({ documentId, actorId, body }: RequestInput, hooks: CreationHooks): DocumentFollowUpResult {
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

  linkExisting({ documentId, actorId, body }: RequestInput, hooks: DecisionLinkHooks): DocumentIssueLinkResult {
    const { requestId, expectedDocumentVersion, issueId, selection } = parseDecisionLink(body);
    const fingerprint = createHash('sha256').update(JSON.stringify([expectedDocumentVersion, issueId, selection])).digest('hex');
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
        issue_id AS issueId, link_id AS linkId, revision_id AS revisionId FROM document_decision_link_requests WHERE id=?`)
        .get(requestId) as DecisionLinkReceipt | undefined;
      if (receipt && (receipt.actorId !== actorId || receipt.documentId !== documentId || receipt.issueId !== issueId || receipt.fingerprint !== fingerprint)) {
        throw new DocumentFollowUpError(409, '이미 사용한 결정 근거 연결 요청입니다. 문서와 업무의 연결을 확인해 주세요.');
      }

      const document = this.store.get<DocPage>('documents', documentId);
      const issue = this.store.get<Issue>('issues', issueId);
      if (receipt) {
        const link = this.store.get<ResourceLink>('resource_links', receipt.linkId);
        const source = link?.documentSource;
        if (!document || !issue || link?.documentId !== documentId || link.issueId !== issueId ||
            !source || source.revisionId !== receipt.revisionId || !sameSelection(source, selection)) {
          throw new DocumentFollowUpError(409, '이전에 저장한 결정 근거 연결을 확인할 수 없습니다.');
        }
        return { issue, link, duplicate: true };
      }

      if (!document || !issue) throw new DocumentFollowUpError(404, '연결할 문서 또는 업무를 찾을 수 없습니다.');
      hooks.checkVersion(document, expectedDocumentVersion);
      const row = this.store.db.prepare('SELECT json FROM resource_links WHERE issue_id=? AND document_id=?')
        .get(issueId, documentId) as { json: string } | undefined;
      const existing = row && JSON.parse(row.json) as ResourceLink;
      const pinned = existing?.documentSource;
      let link: ResourceLink;
      let source: DocumentDecisionSource;
      if (existing && pinned) {
        const revision = this.store.get<DocRevision>('revisions', pinned.revisionId);
        if (!sameSelection(pinned, selection) || !revision || revision.documentId !== documentId ||
            revision.confluenceSourceVersion !== undefined || revision.version !== expectedDocumentVersion ||
            revision.title !== document.title || JSON.stringify(revision.content) !== JSON.stringify(document.content) ||
            readDocumentSelection(document.content, selection.from, selection.to) !== selection.text) {
          throw new DocumentFollowUpError(409, '이 업무에 이 문서의 다른 결정 근거가 이미 연결되어 있습니다.', { reason: 'decision_source_exists' });
        }
        link = existing;
        source = pinned;
      } else {
        source = resolveDocumentDecisionSource(this.store, document, actorId, selection, '결정 근거 원문 저장');
        link = { ...(existing ?? { id: randomUUID(), documentId, issueId, kind: '결정 근거' }), documentSource: source };
        this.store.put('resource_links', link);
        hooks.onLinked(issue, document);
      }

      this.store.db.prepare(`INSERT INTO document_decision_link_requests(id, document_id, actor_id, fingerprint, issue_id, link_id, revision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(requestId, documentId, actorId, fingerprint, issueId, link.id, source.revisionId);
      return { issue, link, duplicate: Boolean(pinned) };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new DocumentFollowUpError(500, '문서 업무 연결 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM document_follow_up_requests; DELETE FROM document_decision_link_requests');
  }
}
