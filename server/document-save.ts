import type { DocPage, DocRevision } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type SaveRequest = { id: string; documentId: string; actorId: string; generation: string; fingerprint: string };
type SaveReceipt = { documentId: string; actorId: string; fingerprint: string; revisionId: string | null; metadata: string };
type SavedMetadata = Omit<DocPage, 'title' | 'content' | 'plainText'>;

export class DocumentSaveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class DocumentSaveService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_save_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      revision_id TEXT,
      metadata TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS document_save_requests_document_id ON document_save_requests(document_id)`);
  }

  parse(documentId: string, body: Record<string, unknown>, actorId: string, operation: 'save' | 'restore' = 'save'): SaveRequest {
    const { requestId, expectedRestoreGeneration } = body;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId) ||
        typeof expectedRestoreGeneration !== 'string' || !expectedRestoreGeneration) {
      throw new DocumentSaveError(400, '문서 저장 요청 ID와 워크스페이스 세대를 확인해 주세요.');
    }
    let fingerprint: string;
    try {
      fingerprint = creationRequestFingerprint(body);
      if (operation === 'restore') fingerprint = `restore:${fingerprint}`;
    }
    catch { throw new DocumentSaveError(400, '문서 저장 요청 내용을 확인해 주세요.'); }
    return { id: requestId.toLowerCase(), documentId, actorId, generation: expectedRestoreGeneration, fingerprint };
  }

  replay(request: SaveRequest): DocPage | undefined {
    if (request.generation !== workspaceRestoreGeneration(this.store)) {
      throw new DocumentSaveError(409, '워크스페이스가 복원되었습니다. 새로고침한 뒤 현재 문서를 확인해 주세요.');
    }
    const saved = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
      revision_id AS revisionId, metadata FROM document_save_requests WHERE id=?`).get(request.id) as SaveReceipt | undefined;
    if (!saved) return undefined;
    if (saved.actorId !== request.actorId || saved.documentId !== request.documentId || saved.fingerprint !== request.fingerprint) {
      throw new DocumentSaveError(409, '이미 사용한 문서 저장 요청입니다. 현재 문서를 확인해 주세요.');
    }
    const current = this.store.get<DocPage>('documents', saved.documentId);
    const revision = saved.revisionId ? this.store.get<DocRevision>('revisions', saved.revisionId) : undefined;
    const metadata = revision ? JSON.parse(saved.metadata) as SavedMetadata : undefined;
    if (!current || !revision || !metadata || revision.documentId !== saved.documentId || revision.version !== metadata.version ||
        current.projectId !== metadata.projectId || current.version < metadata.version) {
      throw new DocumentSaveError(409, '이 요청에서 저장한 문서를 현재 확인할 수 없습니다. 문서 목록과 휴지통을 확인해 주세요.');
    }
    return { ...metadata, title: revision.title, content: revision.content, plainText: revision.plainText };
  }

  record(request: SaveRequest, document: DocPage, revisionId: string): void {
    if (!this.store.db.isTransaction) throw new Error('Document save receipts must be recorded in the write transaction.');
    const { id, projectId, parentId, icon, status, version, authorId, createdAt, updatedAt, labels } = document;
    const metadata: SavedMetadata = { id, projectId, parentId, icon, status, version, authorId, createdAt, updatedAt, labels };
    this.store.db.prepare(`INSERT INTO document_save_requests(id,document_id,actor_id,fingerprint,revision_id,metadata)
      VALUES(?,?,?,?,?,?)`).run(request.id, id, request.actorId, request.fingerprint, revisionId, JSON.stringify(metadata));
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Document save receipts must be invalidated in the import transaction.');
    this.store.db.exec("UPDATE document_save_requests SET revision_id=NULL, metadata='{}' WHERE revision_id IS NOT NULL");
  }

  purgeDocument(documentId: string): void {
    if (!this.store.db.isTransaction) throw new Error('Document save receipts must be cleared in the purge transaction.');
    this.store.db.prepare("UPDATE document_save_requests SET revision_id=NULL, metadata='{}' WHERE document_id=? AND revision_id IS NOT NULL")
      .run(documentId);
  }
}
