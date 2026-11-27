import { decodeCommentDraft, emptyCommentDraft, encodeCommentDraft, type CommentDraft } from './CommentMentions';

export type IssueCommentComposer = {
  draft: CommentDraft;
  requestId: string | null;
  stored: boolean;
};

export function issueCommentDraftKey(actorId: string, issueId: string, generation: string | undefined) {
  return generation ? `donefac:issue-comment-draft:1:${JSON.stringify([actorId, issueId, generation])}` : null;
}

export function readIssueCommentDraft(key: string | null): IssueCommentComposer {
  const empty = { draft: emptyCommentDraft(), requestId: null, stored: false };
  if (!key) return empty;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { ...empty, stored: true };
    const value = JSON.parse(raw) as { draft?: unknown; requestId?: unknown } | null;
    if (!value || typeof value.draft !== 'string') return empty;
    const draft = decodeCommentDraft(value.draft);
    const requestId = draft.body.trim() && typeof value.requestId === 'string' && /^[\da-f-]{36}$/iu.test(value.requestId)
      ? value.requestId : null;
    return { draft, requestId, stored: true };
  } catch { return empty; }
}

export function writeIssueCommentDraft(key: string | null, draft: CommentDraft, requestId: string | null): boolean {
  if (!key) return false;
  try {
    if (draft.body) window.sessionStorage.setItem(key, JSON.stringify({ draft: encodeCommentDraft(draft), requestId }));
    else window.sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
