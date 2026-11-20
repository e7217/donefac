import { createHash } from 'node:crypto';
import type { Comment, DocPage, DocRevision, DocumentSelectionCommentResult } from '../shared/types.js';
import { parseDocumentSourceSelection, resolveDocumentDecisionSource } from './document-follow-up.js';
import type { Store } from './store.js';

type RequestInput = { documentId: string; actorId: string; body: unknown };
type Hooks = {
  validateBody(body: unknown): string;
  onCreated(document: DocPage, comment: Comment): void;
};
type Receipt = { documentId: string; actorId: string; fingerprint: string; commentId: string };
type ErrorDetails =
  | { reason: 'source_version_changed'; currentVersion: number }
  | { reason: 'request_reused' | 'receipt_unavailable' };

const requestUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class DocumentSelectionCommentError extends Error {
  constructor(readonly status: number, message: string, readonly details?: ErrorDetails) { super(message); }
}

function parse(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['requestId', 'expectedDocumentVersion', 'sourceSelection', 'body', 'actorId'].includes(key))) {
    throw new DocumentSelectionCommentError(400, '선택한 문장에 남길 댓글 요청을 확인해 주세요.');
  }
  const { requestId, expectedDocumentVersion, sourceSelection, body } = input as Record<string, unknown>;
  if (typeof requestId !== 'string' || !requestUuid.test(requestId)) {
    throw new DocumentSelectionCommentError(400, '댓글 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedDocumentVersion !== 'number' || !Number.isSafeInteger(expectedDocumentVersion) || expectedDocumentVersion < 1) {
    throw new DocumentSelectionCommentError(400, '댓글을 남길 문서의 버전을 확인해 주세요.');
  }
  const selection = parseDocumentSourceSelection(sourceSelection);
  if (!selection) throw new DocumentSelectionCommentError(400, '댓글을 남길 문서의 선택 범위를 확인해 주세요.');
  return { requestId: requestId.toLowerCase(), expectedDocumentVersion, selection, body };
}

function commentIdForRequest(documentId: string, actorId: string, requestId: string): string {
  // Deterministic UUIDv8 keeps a restored comment identifiable after native import clears receipts.
  const digest = createHash('sha256').update(JSON.stringify(['document-selection-comment', documentId, actorId, requestId])).digest();
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class DocumentSelectionCommentService {
  constructor(private readonly store: Store) {
    // Receipts survive deleting the document or comment so retries cannot recreate either.
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS document_selection_comment_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      comment_id TEXT NOT NULL
    );`);
  }

  create({ documentId, actorId, body: input }: RequestInput, hooks: Hooks): DocumentSelectionCommentResult {
    const { requestId, expectedDocumentVersion, selection, body: unvalidatedBody } = parse(input);
    const body = hooks.validateBody(unvalidatedBody);
    const fingerprint = createHash('sha256').update(JSON.stringify([expectedDocumentVersion, selection, body])).digest('hex');
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, actor_id AS actorId, fingerprint,
        comment_id AS commentId FROM document_selection_comment_requests WHERE id=?`).get(requestId) as Receipt | undefined;
      if (receipt && (receipt.actorId !== actorId || receipt.documentId !== documentId || receipt.fingerprint !== fingerprint)) {
        throw new DocumentSelectionCommentError(409, '이미 사용한 댓글 요청입니다. 현재 댓글 목록을 확인해 주세요.', { reason: 'request_reused' });
      }
      const document = this.store.get<DocPage>('documents', documentId);
      if (receipt) {
        const comment = this.store.get<Comment>('comments', receipt.commentId);
        const source = comment?.documentSource;
        const revision = source && this.store.get<DocRevision>('revisions', source.revisionId);
        if (!document || comment?.resourceType !== 'document' || comment.resourceId !== documentId || comment.authorId !== actorId ||
            comment.body !== body || source?.from !== selection.from || source.to !== selection.to || source.text !== selection.text ||
            revision?.documentId !== documentId || revision.version !== expectedDocumentVersion) {
          throw new DocumentSelectionCommentError(409, '이전에 저장한 댓글이나 원문 저장본을 확인할 수 없습니다.', { reason: 'receipt_unavailable' });
        }
        return { comment, duplicate: true };
      }

      if (!document) throw new DocumentSelectionCommentError(404, '댓글을 남길 문서를 찾을 수 없습니다.');
      if (document.version !== expectedDocumentVersion) {
        throw new DocumentSelectionCommentError(409, '문서가 변경되었습니다. 최신 문서에서 문장을 다시 선택해 주세요.', {
          reason: 'source_version_changed', currentVersion: document.version,
        });
      }
      const id = commentIdForRequest(documentId, actorId, requestId);
      const archived = this.store.db.prepare("SELECT 1 FROM trash_items WHERE item_type='comment' AND item_id=?").get(id);
      if (archived || this.store.get<Comment>('comments', id)) {
        throw new DocumentSelectionCommentError(409, '이 요청의 기존 댓글을 확인해 주세요.', { reason: 'receipt_unavailable' });
      }
      const importedRevision = this.store.db.prepare(`SELECT 1 FROM source_records
        WHERE target_type='revision' AND target_id=? AND product='confluence' LIMIT 1`);
      const documentSource = resolveDocumentDecisionSource(this.store, document, actorId, selection, '문장 댓글 원문 저장',
        revision => !importedRevision.get(revision.id));
      const comment: Comment = { id, resourceId: documentId, resourceType: 'document', authorId: actorId,
        body, createdAt: new Date().toISOString(), documentSource };
      this.store.put('comments', comment);
      hooks.onCreated(document, comment);
      this.store.db.prepare(`INSERT INTO document_selection_comment_requests (id, document_id, actor_id, fingerprint, comment_id)
        VALUES (?, ?, ?, ?, ?)`).run(requestId, documentId, actorId, fingerprint, id);
      return { comment, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new DocumentSelectionCommentError(500, '문장 댓글 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM document_selection_comment_requests');
  }
}
