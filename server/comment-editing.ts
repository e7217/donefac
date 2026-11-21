import { createHash, randomUUID } from 'node:crypto';
import type { Comment, CommentEditResult, CommentEditSnapshot, CommentMention } from '../shared/types.js';
import { parseCommentMentions, validateCurrentMentionNames } from './comment-mentions.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';

const COMMENT_EDIT_GENERATION = 'commentEditGeneration';
const COMMENT_EDIT_BACKUP_VERSION = 89;
const EDIT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

type EditRequest = { commentId: string; actorId: string; body: unknown };
type EditReceipt = { commentId: string; actorId: string; fingerprint: string };
type EditedComment = Comment & { editVersion: number; editedAt: string };
type EditHooks = {
  validateBody(body: unknown): string;
  onEdited(comment: EditedComment, newlyMentionedIds: string[]): void;
};
type EditErrorDetails = { reason: 'comment_edit_conflict' | 'comment_edit_request_reused' };

export class CommentEditError extends Error {
  constructor(readonly status: number, message: string, readonly details?: EditErrorDetails) { super(message); }
}

function parseInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['editToken', 'requestId', 'body', 'mentions', 'actorId'].includes(key))) {
    throw new CommentEditError(400, '댓글 수정 요청을 확인해 주세요.');
  }
  const { editToken, requestId, body, mentions } = input as Record<string, unknown>;
  if (typeof editToken !== 'string' || !EDIT_TOKEN_PATTERN.test(editToken)) {
    throw new CommentEditError(400, '수정할 댓글의 저장 상태를 확인해 주세요.');
  }
  if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) {
    throw new CommentEditError(400, '댓글 수정 요청 ID를 확인해 주세요.');
  }
  return { editToken, requestId: requestId.toLowerCase(), body, mentions };
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateCommentEdit(comment: Comment, schemaVersion: number, exportedAt?: unknown): void {
  if (!Object.hasOwn(comment, 'editVersion') && !Object.hasOwn(comment, 'editedAt')) return;
  if (schemaVersion < COMMENT_EDIT_BACKUP_VERSION) {
    throw new CommentEditError(400, '댓글 수정 정보를 포함한 백업은 schemaVersion 89가 필요합니다.');
  }
  if (typeof comment.editVersion !== 'number' || !Number.isSafeInteger(comment.editVersion) || comment.editVersion < 1 ||
      !isCanonicalTimestamp(comment.editedAt) ||
      (exportedAt !== undefined && (!isCanonicalTimestamp(exportedAt) || comment.editedAt > exportedAt))) {
    throw new CommentEditError(400, '백업의 댓글 수정 정보를 확인해 주세요.');
  }
}

function mentionKey(body: string, { userId, from, to }: CommentMention): string {
  return JSON.stringify([userId, body.slice(from, to)]);
}

const mentionParts = (mentions: CommentMention[]) => mentions.map(({ userId, from, to }) => [userId, from, to]);

export class CommentEditingService {
  constructor(private readonly store: Store) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS comment_edit_requests (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL
    );`);
    this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING')
      .run(COMMENT_EDIT_GENERATION, JSON.stringify(randomUUID()));
  }

  private ownedComment(commentId: string, actorId: string): { comment: Comment; generation: string } {
    const row = this.store.db.prepare(`SELECT c.json, s.value AS generation FROM comments c
      JOIN settings s ON s.key=? WHERE c.id=? AND (
        (c.resource_type='issue' AND EXISTS(SELECT 1 FROM issues WHERE id=c.resource_id)) OR
        (c.resource_type='document' AND EXISTS(SELECT 1 FROM documents WHERE id=c.resource_id))
      )`).get(COMMENT_EDIT_GENERATION, commentId) as { json: string; generation: string } | undefined;
    if (!row) {
      throw new CommentEditError(404, '수정할 댓글을 찾을 수 없습니다.');
    }
    const comment = JSON.parse(row.json) as Comment;
    if (comment.authorId !== actorId) throw new CommentEditError(403, '작성한 댓글만 수정할 수 있습니다.');
    return { comment, generation: row.generation };
  }

  private snapshot(comment: Comment, generation: string): CommentEditSnapshot {
    const { id, resourceType, resourceId, authorId, editVersion = 0, body, mentions = [] } = comment;
    const editToken = createHash('sha256')
      .update(JSON.stringify([generation, id, resourceType, resourceId, authorId, editVersion, body, mentionParts(mentions)])).digest('hex');
    return { comment, editToken };
  }

  get(commentId: string, actorId: string): CommentEditSnapshot {
    const { comment, generation } = this.ownedComment(commentId, actorId);
    return this.snapshot(comment, generation);
  }

  update({ commentId, actorId, body: input }: EditRequest, hooks: EditHooks): CommentEditResult {
    const { editToken, requestId, body: rawBody, mentions: rawMentions } = parseInput(input);
    const body = hooks.validateBody(rawBody);
    const mentions = parseCommentMentions(body, rawMentions);
    const fingerprint = creationRequestFingerprint({ editToken, body, mentions });
    return this.store.transaction(() => {
      const { comment: previous, generation } = this.ownedComment(commentId, actorId);
      const current = this.snapshot(previous, generation);
      const receipt = this.store.db.prepare(`SELECT comment_id AS commentId, actor_id AS actorId, fingerprint
        FROM comment_edit_requests WHERE id=?`).get(requestId) as EditReceipt | undefined;
      if (receipt && (receipt.commentId !== commentId || receipt.actorId !== actorId || receipt.fingerprint !== fingerprint)) {
        throw new CommentEditError(409, '이미 사용한 댓글 수정 요청입니다.', { reason: 'comment_edit_request_reused' });
      }
      if (receipt) return { ...current, duplicate: true };
      if (current.editToken !== editToken) {
        throw new CommentEditError(409, '댓글이 변경되었습니다. 최신 댓글을 확인해 주세요.', { reason: 'comment_edit_conflict' });
      }

      let saved = current;
      const priorMentions = previous.mentions ?? [];
      if (previous.body !== body || JSON.stringify(mentionParts(priorMentions)) !== JSON.stringify(mentionParts(mentions))) {
        const priorTags = new Set(priorMentions.map(mention => mentionKey(previous.body, mention)));
        validateCurrentMentionNames(this.store, body, mentions.filter(mention => !priorTags.has(mentionKey(body, mention))));
        const editVersion = (previous.editVersion ?? 0) + 1;
        if (!Number.isSafeInteger(editVersion)) throw new CommentEditError(409, '댓글 수정 버전이 한도에 도달했습니다.');
        const timestamp = new Date().toISOString();
        const editedAt = previous.editedAt && previous.editedAt > timestamp ? previous.editedAt : timestamp;
        const updated: EditedComment = { ...previous, body, editVersion, editedAt };
        if (mentions.length) updated.mentions = mentions;
        else delete updated.mentions;
        this.store.put('comments', updated);

        const priorRecipients = new Set(priorMentions.map(mention => mention.userId));
        const newRecipients = [...new Set(mentions.map(mention => mention.userId))].filter(id => !priorRecipients.has(id));
        hooks.onEdited(updated, newRecipients);
        saved = this.snapshot(updated, generation);
      }
      this.store.db.prepare('INSERT INTO comment_edit_requests(id,comment_id,actor_id,fingerprint) VALUES(?,?,?,?)')
        .run(requestId, commentId, actorId, fingerprint);
      return { ...saved, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new CommentEditError(500, '댓글 수정 요청 초기화에는 트랜잭션이 필요합니다.');
    this.store.setSetting(COMMENT_EDIT_GENERATION, randomUUID());
    this.store.db.exec('DELETE FROM comment_edit_requests');
  }
}
