import type { Comment } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store } from './store.js';
import { workspaceRestoreGeneration } from './workspace-revisions.js';

type Draft = Pick<Comment, 'body' | 'mentions'>;
type Receipt = { actorId: string; fingerprint: string; commentId: string | null };

export class CommentCreationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class CommentCreationService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS comment_creation_requests (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      comment_id TEXT
    )`);
  }

  create(input: { requestId: unknown; generation: unknown; actorId: string; resourceId: string; draft: Draft }, save: () => Comment) {
    const { requestId, generation, actorId, resourceId, draft } = input;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId) || typeof generation !== 'string' || !generation) {
      throw new CommentCreationError(400, '댓글 등록 요청 ID와 워크스페이스 세대를 확인해 주세요.');
    }
    const id = requestId.toLowerCase();
    const fingerprint = creationRequestFingerprint({ resourceId, ...draft });
    return this.store.transaction(() => {
      if (generation !== workspaceRestoreGeneration(this.store)) {
        throw new CommentCreationError(409, '워크스페이스가 복원되었습니다. 새로고침한 뒤 현재 티켓의 댓글을 확인해 주세요.');
      }
      const receipt = this.store.db.prepare(`SELECT actor_id AS actorId, fingerprint, comment_id AS commentId
        FROM comment_creation_requests WHERE id=?`).get(id) as Receipt | undefined;
      if (receipt) {
        if (receipt.actorId !== actorId || receipt.fingerprint !== fingerprint) {
          throw new CommentCreationError(409, '이미 사용한 댓글 등록 요청입니다. 현재 티켓의 댓글을 확인해 주세요.');
        }
        const comment = receipt.commentId ? this.store.get<Comment>('comments', receipt.commentId) : undefined;
        if (!comment || comment.resourceType !== 'issue' || comment.resourceId !== resourceId || comment.authorId !== actorId) {
          throw new CommentCreationError(409, '이 요청에서 등록한 댓글을 확인할 수 없습니다. 댓글 목록과 휴지통을 확인해 주세요.');
        }
        return { comment, duplicate: true };
      }
      const comment = save();
      this.store.db.prepare('INSERT INTO comment_creation_requests(id,actor_id,fingerprint,comment_id) VALUES (?,?,?,?)')
        .run(id, actorId, fingerprint, comment.id);
      return { comment, duplicate: false };
    });
  }

  invalidateForImport(): void {
    if (!this.store.db.isTransaction) throw new Error('Comment creation receipts must be invalidated in the import transaction.');
    this.store.db.exec('UPDATE comment_creation_requests SET comment_id=NULL WHERE comment_id IS NOT NULL');
  }
}
