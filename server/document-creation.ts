import type { DocPage } from '../shared/types.js';
import { documentNodes } from '../shared/document-references.js';
import { documentSectionHash, isMarkdownImportSectionId } from '../shared/document-sections.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';

type Receipt = { actorId: string; projectId: string | null; fingerprint: string; documentId: string | null };
type CreationReason = 'invalid_request_id' | 'invalid_request_body' | 'request_conflict' | 'result_unavailable';

export function bindImportedDocumentSections(document: DocPage): void {
  const sections = new Set<string>();
  for (const node of documentNodes(document.content)) {
    if (node.type === 'heading' && isMarkdownImportSectionId(node.attrs?.sectionId)) sections.add(node.attrs.sectionId);
  }
  if (!sections.size) return;
  for (const node of documentNodes(document.content)) for (const mark of node.marks ?? []) {
    const href = mark.attrs?.href;
    if (mark.type !== 'link' || typeof href !== 'string' || !href.startsWith('#') || !sections.has(href.slice(1))) continue;
    mark.attrs = { ...mark.attrs, href: documentSectionHash(document.id, href.slice(1)) };
  }
}

export class DocumentCreationError extends Error {
  readonly details: { reason: CreationReason };

  constructor(public status: number, message: string, reason: CreationReason) {
    super(message);
    this.details = { reason };
  }
}

export class DocumentCreationService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_creation_requests (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      project_id TEXT,
      fingerprint TEXT NOT NULL,
      document_id TEXT
    )`);
  }

  create(actorId: string, input: Record<string, unknown>, persist: () => DocPage): { document: DocPage; duplicate: boolean } {
    if (!Object.hasOwn(input, 'requestId')) return { document: this.store.transaction(persist), duplicate: false };
    const requestId = input.requestId;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) {
      throw new DocumentCreationError(400, '문서 생성 요청 ID를 확인해 주세요.', 'invalid_request_id');
    }
    const id = requestId.toLowerCase();
    let fingerprint: string;
    try { fingerprint = creationRequestFingerprint(input); }
    catch { throw new DocumentCreationError(400, '문서 생성 입력 형식을 확인해 주세요.', 'invalid_request_body'); }

    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT actor_id AS actorId, project_id AS projectId,
        fingerprint, document_id AS documentId FROM document_creation_requests WHERE id=?`).get(id) as Receipt | undefined;
      if (receipt) {
        if (receipt.actorId !== actorId || receipt.fingerprint !== fingerprint) {
          throw new DocumentCreationError(409, '이미 사용한 문서 생성 요청입니다. 현재 문서를 확인해 주세요.', 'request_conflict');
        }
        const document = receipt.documentId && this.store.get<DocPage>('documents', receipt.documentId);
        if (!document || document.projectId !== receipt.projectId || document.authorId !== actorId) {
          throw new DocumentCreationError(409, '이 요청에서 생성한 문서를 현재 확인할 수 없습니다. 문서 목록과 휴지통을 확인해 주세요.', 'result_unavailable');
        }
        return { document, duplicate: true };
      }

      const document = persist();
      this.store.db.prepare('INSERT INTO document_creation_requests(id,actor_id,project_id,fingerprint,document_id) VALUES (?,?,?,?,?)')
        .run(id, actorId, document.projectId, fingerprint, document.id);
      return { document, duplicate: false };
    });
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Document creation receipts must be invalidated in the import transaction.');
    this.store.db.exec('UPDATE document_creation_requests SET document_id=NULL WHERE document_id IS NOT NULL');
  }
}
