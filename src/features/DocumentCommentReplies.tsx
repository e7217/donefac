'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link2, Send } from 'lucide-react';
import type { Comment, DocumentCommentReplyResult, FeatureProps, User } from '../../shared/types';
import { ApiError, api, relativeTime } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { CommentEditBody, CommentEditButton, CommentEditedMark, type CommentEditing } from './CommentEdit';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { CommentMentionInput, commentDraftPayload, decodeCommentDraft, emptyCommentDraft,
  encodeCommentDraft, sameCommentDraft, type CommentDraft } from './CommentMentions';

type Scope = { actorId: string; documentId: string; parentId: string };
type ReplyAttempt = { requestId: string; expectedResolutionVersion: number };
type CachedReply = { draft: CommentDraft; attempt?: ReplyAttempt; rejected?: true };
type ReplyEditor = Scope & CachedReply & { error: string };
const CACHE_PREFIX = 'donefac:document-selection-comment-draft:reply:';
const UNKNOWN_RESULT = '답글 등록 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const REJECTED_REPLAY = '현재 답글을 확인한 뒤 새로 등록할 내용을 수정해 주세요.';
const cachePrefix = (actorId: string, documentId: string) => `${CACHE_PREFIX}${encodeURIComponent(actorId)}:${encodeURIComponent(documentId)}:`;
const cacheKey = ({ actorId, documentId, parentId }: Scope) => `${cachePrefix(actorId, documentId)}${encodeURIComponent(parentId)}`;
const scopeMatches = (scope: Scope | null, actorId: string, documentId?: string) => scope?.actorId === actorId && scope.documentId === documentId;

function decodedReply(value: string | null): CachedReply {
  if (!value) return { draft: emptyCommentDraft() };
  const { draft, attempt, rejected } = JSON.parse(value) as { draft?: unknown; attempt?: Partial<ReplyAttempt>; rejected?: unknown };
  const cached = decodeCommentDraft(typeof draft === 'string' ? draft : null);
  if (cached.body.trim() && typeof attempt?.requestId === 'string' &&
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(attempt.requestId) &&
    typeof attempt.expectedResolutionVersion === 'number' && Number.isSafeInteger(attempt.expectedResolutionVersion) &&
    attempt.expectedResolutionVersion >= 0) {
    return { draft: cached, attempt: { requestId: attempt.requestId, expectedResolutionVersion: attempt.expectedResolutionVersion } };
  }
  return { draft: cached, rejected: rejected === true ? true : undefined };
}

function savedReplyKeys(prefix: string): string[] {
  return Object.keys(localStorage).filter(key => key.startsWith(prefix));
}

export function useDocumentCommentReply(actorId: string, documentId: string | undefined, reportStorageProblem: () => void) {
  const [editor, setEditor] = useState<ReplyEditor | null>(null);
  const editorRef = useRef<ReplyEditor | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<symbol | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoredAttempts, setRestoredAttempts] = useState<{ prefix: string; parentIds: string[] } | null>(null);
  const prefix = documentId && actorId ? cachePrefix(actorId, documentId) : '';
  const current = editor && scopeMatches(editor, actorId, documentId) ? editor : null;

  const assignEditor = useCallback((value: ReplyEditor | null) => {
    editorRef.current = value;
    setEditor(value);
  }, []);

  useEffect(() => {
    if (!prefix) return;
    const timer = setTimeout(() => {
      try {
        const parentIds = savedReplyKeys(prefix).filter(key => decodedReply(localStorage.getItem(key)).attempt)
          .map(key => decodeURIComponent(key.slice(prefix.length)));
        setRestoredAttempts({ prefix, parentIds });
      } catch { reportStorageProblem(); }
    }, 0);
    function clear() {
      pending.current = null;
      openerRef.current = null;
      assignEditor(null);
      setBusy(false);
      setRestoredAttempts(null);
    }
    window.addEventListener('donefac:workspace-imported', clear);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('donefac:workspace-imported', clear);
    };
  }, [prefix, assignEditor, reportStorageProblem]);

  const remember = useCallback((scope: Scope, saved: CachedReply) => {
    const key = cacheKey(scope);
    try {
      if (saved.draft.body || saved.attempt) localStorage.setItem(key, JSON.stringify({
        draft: encodeCommentDraft(saved.draft), attempt: saved.attempt, rejected: saved.rejected,
      }));
      else localStorage.removeItem(key);
    } catch { reportStorageProblem(); }
    const prefix = cachePrefix(scope.actorId, scope.documentId);
    setRestoredAttempts(previous => {
      const parentIds = previous?.prefix === prefix ? previous.parentIds : [];
      if (parentIds.includes(scope.parentId) === Boolean(saved.attempt)) return previous;
      return { prefix, parentIds: saved.attempt ? [...parentIds, scope.parentId] : parentIds.filter(id => id !== scope.parentId) };
    });
  }, [reportStorageProblem]);

  function open(parent: Comment, opener: HTMLButtonElement) {
    if (!documentId || !actorId || pending.current || parent.resourceId !== documentId) return;
    if (current?.parentId === parent.id) return;
    const scope = { actorId, documentId, parentId: parent.id };
    let cached: CachedReply = { draft: emptyCommentDraft() };
    try { cached = decodedReply(localStorage.getItem(cacheKey(scope))); } catch { reportStorageProblem(); }
    if (parent.resolution?.state === 'resolved' && !cached.attempt) return;
    openerRef.current = opener;
    assignEditor({ ...scope, ...cached, error: cached.attempt ? UNKNOWN_RESULT : cached.rejected ? REJECTED_REPLAY : '' });
  }

  function close() {
    if (pending.current) return;
    const opener = openerRef.current;
    const parent = current?.parentId && document.getElementById(`document-comment-${current.parentId}`);
    openerRef.current = null;
    assignEditor(null);
    if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    else if (parent) parent.focus({ preventScroll: true });
  }

  function edit(draft: CommentDraft) {
    if (!current || current.attempt || pending.current) return;
    const next = { ...current, draft, error: '', rejected: undefined };
    assignEditor(next);
    remember(next, next);
  }

  async function submit(parent: Comment, onSaved: (comment: Comment) => void) {
    if (!current || current.rejected || pending.current || current.parentId !== parent.id ||
      (parent.resolution?.state === 'resolved' && !current.attempt)) return;
    const submitted = commentDraftPayload(current.draft);
    if (!submitted.body) return;
    const attempt = current.attempt ?? { requestId: newRequestId(), expectedResolutionVersion: parent.resolution?.version ?? 0 };
    const replay = Boolean(current.attempt);
    const active = { ...current, attempt, error: '' };
    const token = Symbol();
    pending.current = token;
    setBusy(true);
    assignEditor(active);
    remember(active, active);
    try {
      const result = await api<DocumentCommentReplyResult>(
        `/documents/${encodeURIComponent(active.documentId)}/selection-comments/${encodeURIComponent(active.parentId)}/replies`, {
          method: 'POST', headers: { 'X-Actor-Id': active.actorId }, body: JSON.stringify({ ...attempt, ...submitted }),
        });
      if (pending.current !== token) return;
      const saved = result?.comment;
      if (typeof result?.duplicate !== 'boolean' || !saved?.id || saved.resourceType !== 'document' || saved.resourceId !== active.documentId ||
        saved.parentCommentId !== active.parentId || saved.authorId !== active.actorId || !sameCommentDraft(saved, submitted)) throw new Error(UNKNOWN_RESULT);
      remember(active, { draft: emptyCommentDraft() });
      openerRef.current = null;
      assignEditor(null);
      onSaved(saved);
    } catch (cause) {
      if (pending.current !== token) return;
      const reason = cause instanceof ApiError && cause.details && typeof cause.details === 'object' && 'reason' in cause.details
        ? cause.details.reason : undefined;
      const rejected = reason === 'receipt_unavailable' || reason === 'request_reused';
      const knownRejection = rejected || reason === 'thread_resolved' || reason === 'thread_changed' || reason === 'thread_missing';
      const knownFailure = cause instanceof ApiError && (knownRejection ||
        (!replay && [400, 401, 403, 422].includes(cause.status)));
      const next: ReplyEditor = {
        ...active, attempt: knownFailure ? undefined : attempt, rejected: rejected ? true : undefined,
        error: rejected ? REJECTED_REPLAY : knownFailure ? cause.message : UNKNOWN_RESULT,
      };
      assignEditor(next);
      remember(next, next);
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
    } finally {
      if (pending.current === token) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  const isSending = useCallback(() => pending.current !== null, []);
  const hasDraft = useCallback((scopeActor: string, scopeDocument?: string) => {
    const value = editorRef.current;
    if (value && scopeMatches(value, scopeActor, scopeDocument) && (value.draft.body.trim() || value.attempt)) return true;
    if (!scopeDocument || !scopeActor) return false;
    try {
      return savedReplyKeys(cachePrefix(scopeActor, scopeDocument)).some(key => {
        const cached = decodedReply(localStorage.getItem(key));
        return Boolean(cached.draft.body.trim() || cached.attempt);
      });
    } catch { reportStorageProblem(); return false; }
  }, [reportStorageProblem]);

  const clearDocument = useCallback((scopeActor: string, scopeDocument: string) => {
    const prefix = cachePrefix(scopeActor, scopeDocument);
    try { for (const key of savedReplyKeys(prefix)) localStorage.removeItem(key); } catch { reportStorageProblem(); }
    if (scopeMatches(editorRef.current, scopeActor, scopeDocument)) {
      openerRef.current = null;
      assignEditor(null);
    }
    setRestoredAttempts(previous => previous?.prefix === prefix ? null : previous);
  }, [assignEditor, reportStorageProblem]);

  return {
    current, busy, open, close, edit, submit, isSending, hasDraft, clearDocument,
    canRecover: (parentId: string) => Boolean(current?.parentId === parentId && current.attempt ||
      prefix && restoredAttempts?.prefix === prefix && restoredAttempts.parentIds.includes(parentId)),
  };
}

export function DocumentReplyComposer({ editor, resolved, busy, users, onChange, onClose, onSubmit }: {
  editor: ReplyEditor; resolved: boolean; busy: boolean; users: readonly User[];
  onChange: (draft: CommentDraft) => void; onClose: () => void; onSubmit: () => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const recovering = Boolean(editor.attempt);
  useLayoutEffect(() => {
    if (busy || !inputRef.current) return;
    // Initial opening and an uncertain send both put the next action within keyboard reach.
    const active = document.activeElement;
    if (active !== document.body && !(active instanceof HTMLButtonElement &&
      (active.getAttribute('aria-label') === '답글 쓰기' || active.getAttribute('aria-label') === '답글 결과 확인 열기'))) return;
    (recovering ? submitRef.current : inputRef.current)?.focus();
  }, [busy, recovering]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return <form className="docs-comment-reply-form" aria-label="문장 댓글 답글 작성" onSubmit={submit} aria-busy={busy}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <label htmlFor={inputId}>답글 내용</label>
    <CommentMentionInput id={inputId} textareaRef={inputRef} className="field" rows={3} users={users}
      draft={editor.draft} disabled={busy} readOnly={recovering || resolved} onChange={onChange} />
    {editor.error && <p className="docs-panel-error" role="alert">{editor.error}</p>}
    {resolved && !recovering && <p className="docs-panel-muted" role="status">답글을 남기려면 문장 댓글을 다시 열어 주세요.</p>}
    <div className="docs-comment-reply-actions">
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>답글 닫기</button>
      <button ref={submitRef} className="btn btn-primary" type="submit" disabled={busy || editor.rejected || (!recovering && (resolved || !editor.draft.body.trim()))}>
        <Send size={14} aria-hidden="true" />{busy ? '등록 중…' : recovering ? '답글 결과 다시 확인' : '답글 등록'}
      </button>
    </div>
  </form>;
}

export function DocumentReplyList({ replies, users, actorId, notify, refresh, editing, disabled, onArchived, onCopyCommentLink }: Pick<FeatureProps, 'actorId' | 'notify' | 'refresh'> & {
  replies: readonly Comment[]; users: readonly User[]; editing: CommentEditing; disabled?: boolean;
  onArchived: (comment: Comment) => void; onCopyCommentLink?: (id: string) => void;
}) {
  if (!replies.length) return null;
  return <section className="docs-comment-replies" aria-label="문장 댓글 답글">
    {replies.map(reply => {
      const user = users.find(item => item.id === reply.authorId);
      return <article className="docs-comment-reply" key={reply.id} id={`document-comment-${reply.id}`} aria-label="답글" tabIndex={-1}>
        <div className="docs-comment-head">
          <span className="docs-avatar" aria-hidden="true" style={{ background: user?.color ?? 'var(--chart-7)' }}>{user?.name.slice(0, 1) ?? '팀'}</span>
          <strong>{user?.name ?? '팀원'}</strong>
          <time dateTime={reply.createdAt} title={new Date(reply.createdAt).toLocaleString('ko-KR')}>{relativeTime(reply.createdAt)}</time>
          <CommentEditedMark comment={reply} />
          <CommentEditButton comment={reply} editing={editing} disabled={disabled} />
          {onCopyCommentLink && <button type="button" className="btn btn-ghost docs-comment-reply-link"
            aria-label="답글 링크 복사" title="답글 링크 복사" onClick={() => onCopyCommentLink(reply.id)}>
            <Link2 size={13} aria-hidden="true" />
          </button>}
          <CommentTrashButton comment={reply} actorId={actorId} notify={notify} refresh={refresh}
            disabled={disabled || editing.current?.base.id === reply.id} onArchived={onArchived} />
        </div>
        <CommentEditBody comment={reply} editing={editing} users={users} />
      </article>;
    })}
  </section>;
}
