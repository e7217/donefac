import type { Comment } from '../shared/types.js';
import type { Store } from './store.js';

type UpdateInput = {
  documentId: string;
  commentId: string;
  actorId: string;
  body: unknown;
};

export class DocumentCommentResolutionError extends Error {
  constructor(readonly status: number, message: string, readonly details?: {
    reason: 'resolution_version_changed';
    currentVersion: number;
  }) { super(message); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isResolutionState(value: unknown): value is NonNullable<Comment['resolution']>['state'] {
  return value === 'open' || value === 'resolved';
}

function isResolutionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function validateDocumentCommentResolution(comment: Comment, userIds: ReadonlySet<string>): void {
  if (!Object.hasOwn(comment, 'resolution')) return;
  const resolution: unknown = comment.resolution;
  if (comment.resourceType !== 'document' || !comment.documentSource || !isObject(resolution) || Object.keys(resolution).length !== 4 ||
      !isResolutionState(resolution.state) || !isResolutionVersion(resolution.version) || resolution.version === 0 ||
      !isCanonicalTimestamp(resolution.changedAt) || typeof resolution.actorId !== 'string' || !userIds.has(resolution.actorId)) {
    throw new DocumentCommentResolutionError(400, '백업의 문장 댓글 해결 상태를 확인해 주세요.');
  }
}

function nextResolutionVersion(version: number): number {
  if (version === Number.MAX_SAFE_INTEGER) {
    throw new DocumentCommentResolutionError(409, '문장 댓글의 상태 변경 버전이 한도에 도달했습니다.');
  }
  return version + 1;
}

export function advanceRestoredCommentResolutionVersions(imported: Comment[], previous: Iterable<Comment>): void {
  const versions = new Map<string, number>();
  for (const comment of previous) {
    if (comment.resolution) versions.set(comment.id, comment.resolution.version);
  }
  for (const comment of imported) {
    const previousVersion = versions.get(comment.id);
    if (comment.resolution && previousVersion !== undefined && previousVersion >= comment.resolution.version) {
      comment.resolution = { ...comment.resolution, version: nextResolutionVersion(previousVersion) };
    }
  }
}

export function updateDocumentCommentResolution(store: Store, { documentId, commentId, actorId, body }: UpdateInput): Comment {
  if (!isObject(body) || Object.keys(body).length !== 2 || !isResolutionState(body.state) || !isResolutionVersion(body.expectedVersion)) {
    throw new DocumentCommentResolutionError(400, '문장 댓글 상태와 확인한 버전을 입력해 주세요.');
  }
  const { state, expectedVersion } = body;
  return store.transaction(() => {
    const comment = store.get<Comment>('comments', commentId);
    if (comment?.resourceType !== 'document' || comment.resourceId !== documentId || !comment.documentSource ||
        !store.get('documents', documentId)) {
      throw new DocumentCommentResolutionError(404, '해결 상태를 바꿀 문장 댓글을 찾을 수 없습니다.');
    }
    const currentVersion = comment.resolution?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new DocumentCommentResolutionError(409, '다른 작업자가 댓글 상태를 변경했습니다. 최신 상태를 확인해 주세요.', {
        reason: 'resolution_version_changed', currentVersion,
      });
    }
    if ((comment.resolution?.state ?? 'open') === state) return comment;
    const updated: Comment = {
      ...comment,
      resolution: { state, version: nextResolutionVersion(currentVersion), changedAt: new Date().toISOString(), actorId },
    };
    store.put('comments', updated);
    return updated;
  });
}
