import type { Comment, DocPage, DocumentCommentReplyResult } from '../shared/types.js';
import { parseCommentMentions, validateCurrentMentionNames } from './comment-mentions.js';
import { creationRequestFingerprint, creationRequestId, deterministicCreationId } from './creation-request.js';
import type { Store } from './store.js';

type ReplyRequest = { documentId: string; parentCommentId: string; actorId: string; body: unknown };
type ReplyReceipt = { documentId: string; parentCommentId: string; actorId: string; fingerprint: string; commentId: string };
type ReplyHooks = {
  validateBody(body: unknown): string;
  onCreated(document: DocPage, comment: Comment, participants: string[]): void;
};
type ErrorDetails =
  | { reason: 'thread_changed' | 'thread_resolved'; currentResolutionVersion: number }
  | { reason: 'thread_missing' | 'request_reused' | 'receipt_unavailable' };

export class DocumentCommentReplyError extends Error {
  constructor(readonly status: number, message: string, readonly details?: ErrorDetails) { super(message); }
}

function parseRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['requestId', 'expectedResolutionVersion', 'body', 'mentions', 'actorId'].includes(key))) {
    throw new DocumentCommentReplyError(400, '문장 댓글 답글 요청을 확인해 주세요.');
  }
  const { requestId, expectedResolutionVersion, body, mentions } = value as Record<string, unknown>;
  if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) {
    throw new DocumentCommentReplyError(400, '답글 요청 ID를 확인해 주세요.');
  }
  if (typeof expectedResolutionVersion !== 'number' || !Number.isSafeInteger(expectedResolutionVersion) || expectedResolutionVersion < 0) {
    throw new DocumentCommentReplyError(400, '답글을 남길 댓글의 해결 상태 버전을 확인해 주세요.');
  }
  return { requestId: requestId.toLowerCase(), expectedResolutionVersion, body, mentions };
}

const unavailableReceipt = () => new DocumentCommentReplyError(
  409, '이전에 저장한 답글이나 문장 댓글을 확인할 수 없습니다.', { reason: 'receipt_unavailable' },
);

export class DocumentCommentReplyService {
  constructor(private readonly store: Store) {
    // Keep live receipts after deletion so a retry cannot create the same reply again.
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_comment_reply_requests (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      parent_comment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      comment_id TEXT NOT NULL
    );`);
  }

  private liveThread(documentId: string, parentCommentId: string) {
    const parent = this.store.get<Comment>('comments', parentCommentId);
    if (parent?.resourceType !== 'document' || parent.resourceId !== documentId ||
        parent.parentCommentId !== undefined || !parent.documentSource) return null;
    const source = this.store.db.prepare('SELECT 1 FROM revisions WHERE id=? AND document_id=?')
      .get(parent.documentSource.revisionId, documentId);
    if (!source) return null;
    const document = this.store.get<DocPage>('documents', documentId);
    return document ? { document, parent } : null;
  }

  create({ documentId, parentCommentId, actorId, body: input }: ReplyRequest, hooks: ReplyHooks): DocumentCommentReplyResult {
    const { requestId, expectedResolutionVersion, body: rawBody, mentions: rawMentions } = parseRequest(input);
    const body = hooks.validateBody(rawBody);
    const mentions = parseCommentMentions(body, rawMentions);
    const fingerprint = creationRequestFingerprint({ expectedResolutionVersion, body, mentions });
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare(`SELECT document_id AS documentId, parent_comment_id AS parentCommentId,
        actor_id AS actorId, fingerprint, comment_id AS commentId FROM document_comment_reply_requests WHERE id=?`)
        .get(requestId) as ReplyReceipt | undefined;
      if (receipt && (receipt.documentId !== documentId || receipt.parentCommentId !== parentCommentId ||
          receipt.actorId !== actorId || receipt.fingerprint !== fingerprint)) {
        throw new DocumentCommentReplyError(409, '이미 사용한 답글 요청입니다. 현재 답글을 확인해 주세요.', { reason: 'request_reused' });
      }

      const thread = this.liveThread(documentId, parentCommentId);
      if (receipt) {
        const comment = this.store.get<Comment>('comments', receipt.commentId);
        if (!thread || comment?.resourceType !== 'document' || comment.resourceId !== documentId ||
            comment.parentCommentId !== parentCommentId || comment.authorId !== actorId ||
            comment.body !== body || JSON.stringify(comment.mentions ?? []) !== JSON.stringify(mentions)) throw unavailableReceipt();
        return { comment, duplicate: true };
      }

      const id = deterministicCreationId(['document-comment-reply', documentId, parentCommentId, actorId, requestId]);
      const archived = this.store.db.prepare("SELECT 1 FROM trash_items WHERE item_type='comment' AND item_id=?").get(id);
      if (archived || this.store.get('comments', id)) throw unavailableReceipt();
      if (!thread) {
        throw new DocumentCommentReplyError(404, '답글을 남길 문장 댓글을 찾을 수 없습니다.', { reason: 'thread_missing' });
      }
      const { document, parent } = thread;
      const currentResolutionVersion = parent.resolution?.version ?? 0;
      if (parent.resolution?.state === 'resolved') {
        throw new DocumentCommentReplyError(409, '해결된 댓글을 다시 연 뒤 답글을 남겨 주세요.', {
          reason: 'thread_resolved', currentResolutionVersion,
        });
      }
      if (currentResolutionVersion !== expectedResolutionVersion) {
        throw new DocumentCommentReplyError(409, '문장 댓글의 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.', {
          reason: 'thread_changed', currentResolutionVersion,
        });
      }

      validateCurrentMentionNames(this.store, body, mentions);
      const replies = this.store.db.prepare(`SELECT DISTINCT author_id AS authorId FROM comments
        WHERE resource_type='document' AND resource_id=? AND json_extract(json,'$.parentCommentId')=?`)
        .all(documentId, parentCommentId) as { authorId: string }[];
      const comment: Comment = {
        id, resourceType: 'document', resourceId: documentId, parentCommentId, authorId: actorId, body,
        createdAt: new Date().toISOString(), ...(mentions.length ? { mentions } : {}),
      };
      this.store.put('comments', comment);
      hooks.onCreated(document, comment, [parent.authorId, ...replies.map(reply => reply.authorId)]);
      this.store.db.prepare(`INSERT INTO document_comment_reply_requests(id, document_id, parent_comment_id, actor_id, fingerprint, comment_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(requestId, documentId, parentCommentId, actorId, fingerprint, id);
      return { comment, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new DocumentCommentReplyError(500, '답글 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec('DELETE FROM document_comment_reply_requests');
  }
}
