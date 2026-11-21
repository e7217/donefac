import { MAX_COMMENT_MENTIONS, type CommentMention, type User } from '../shared/types.js';
import type { Store } from './store.js';

export class CommentMentionError extends Error {
  readonly status = 400;
}

export function parseCommentMentions(body: unknown, raw: unknown): CommentMention[] {
  if (raw === undefined) return [];
  const invalid = (): never => { throw new CommentMentionError('댓글에서 선택한 팀원과 이름의 위치를 확인해 주세요.'); };
  if (!Array.isArray(raw) || raw.length > MAX_COMMENT_MENTIONS) return invalid();
  if (!raw.length) return [];
  if (typeof body !== 'string' || body.trim() !== body) return invalid();

  let previousEnd = 0;
  const mentions: CommentMention[] = [];
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3) return invalid();
    const { userId, from, to } = row as Record<string, unknown>;
    if (typeof userId !== 'string' || !userId || typeof from !== 'number' || !Number.isSafeInteger(from) ||
        typeof to !== 'number' || !Number.isSafeInteger(to) || from < previousEnd || to <= from || to > body.length) return invalid();
    const displayName = body.slice(from + 1, to);
    if (body[from] !== '@' || !displayName || displayName !== displayName.trim() || displayName.length > 80) return invalid();
    mentions.push({ userId, from, to });
    previousEnd = to;
  }
  return mentions;
}

export function validateCurrentMentionNames(store: Store, body: string, mentions: CommentMention[]): void {
  for (const { userId, from, to } of mentions) {
    const member = store.get<User>('users', userId);
    if (!member || body.slice(from, to) !== `@${member.name}`) {
      throw new CommentMentionError('댓글에서 멘션할 팀원을 다시 선택해 주세요.');
    }
  }
}
