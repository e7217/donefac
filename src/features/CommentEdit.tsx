'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { Comment, CommentEditResult, CommentEditSnapshot, FeatureProps, User } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { newRequestId } from '../lib/request-id';
import { COMMENT_LIST_CHANGED } from './CommentTrashButton';
import { CommentBodyText, CommentMentionInput, commentDraftPayload, sameCommentDraft, type CommentDraft } from './CommentMentions';
import './comment-edit.css';

type Attempt = ReturnType<typeof commentDraftPayload> & { requestId: string; editToken: string };
type Editor = { base: Comment; draft: CommentDraft; editToken?: string; attempt?: Attempt; error: string; conflict?: boolean; reviewed?: boolean };
type Operation = 'read' | 'save';
type Props = Pick<FeatureProps, 'actorId' | 'notify' | 'refresh'> & {
  resourceId?: string;
  onSaved: (comment: Comment) => void;
};

function fromComment(comment: Comment): CommentDraft {
  return { body: comment.body, mentions: [...(comment.mentions ?? [])] };
}

function hasChanges(editor: Editor) {
  return Boolean(editor.attempt || (!sameCommentDraft(editor.base, editor.draft) &&
    !sameCommentDraft(editor.base, commentDraftPayload(editor.draft))));
}

function validateReply(value: CommentEditSnapshot, base: Comment): void {
  const comment = value?.comment;
  if (!comment || comment.id !== base.id || comment.authorId !== base.authorId || comment.resourceId !== base.resourceId ||
      comment.resourceType !== base.resourceType || comment.parentCommentId !== base.parentCommentId ||
      typeof value.editToken !== 'string' || !value.editToken || typeof comment.body !== 'string') {
    throw new Error('댓글 수정 결과를 읽을 수 없습니다.');
  }
}

function commentPath(comment: Comment) { return `/comments/${encodeURIComponent(comment.id)}`; }
function commentLabel(comment: Comment) { return comment.parentCommentId ? '답글' : '댓글'; }

export function useCommentEditing({ actorId, resourceId, notify, refresh, onSaved }: Props) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const request = useRef<AbortController | null>(null);
  const restoreFocusId = useRef<string | null>(null);
  const current = editor?.base.authorId === actorId && editor.base.resourceId === resourceId ? editor : null;

  const assign = useCallback((next: Editor | null) => {
    editorRef.current = next;
    setEditor(next);
  }, []);

  const clear = useCallback((returnTo: string | null) => {
    request.current?.abort();
    request.current = null;
    restoreFocusId.current = returnTo;
    assign(null);
    setOperation(null);
  }, [assign]);
  const discard = useCallback(() => clear(null), [clear]);
  const restoreFocus = useCallback((id: string, button: HTMLButtonElement | null) => {
    if (restoreFocusId.current !== id || !button?.isConnected || button.disabled || button.closest('[inert]')) return;
    button.focus({ preventScroll: true });
    if (document.activeElement === button) restoreFocusId.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('donefac:workspace-imported', discard);
    return () => {
      window.removeEventListener('donefac:workspace-imported', discard);
      request.current?.abort();
    };
  }, [discard]);

  const isPending = useCallback(() => request.current !== null, []);
  const hasDraft = useCallback(() => Boolean(editorRef.current && hasChanges(editorRef.current)), []);

  function finish() {
    clear(editorRef.current?.base.id ?? null);
  }

  function close() {
    if (isPending()) return;
    if (hasDraft() && !window.confirm('작성 중인 댓글 수정 내용을 버릴까요?')) return;
    finish();
  }

  function startRequest(kind: Operation) {
    const controller = new AbortController();
    request.current = controller;
    setOperation(kind);
    return controller;
  }

  function finishRequest(controller: AbortController) {
    if (request.current !== controller) return;
    request.current = null;
    setOperation(null);
  }

  async function readLatest(value: Editor, preserveDraft: boolean) {
    if (isPending()) return;
    const controller = startRequest('read');
    try {
      const result = await api<CommentEditSnapshot>(`${commentPath(value.base)}/edit`, {
        cache: 'no-store', signal: controller.signal, headers: { 'X-Actor-Id': actorId },
      });
      validateReply(result, value.base);
      if (request.current !== controller) return;
      assign({ base: result.comment, draft: preserveDraft ? value.draft : fromComment(result.comment), editToken: result.editToken,
        error: '', reviewed: preserveDraft });
    } catch (error) {
      if (request.current === controller) assign({ ...value, error: error instanceof ApiError ? error.message : '현재 댓글을 불러오지 못했습니다.' });
    } finally { finishRequest(controller); }
  }

  function open(comment: Comment) {
    if (!actorId || comment.authorId !== actorId || comment.resourceId !== resourceId || isPending()) return;
    if (current?.base.id === comment.id) return;
    if (hasDraft() && !window.confirm('작성 중인 댓글 수정 내용을 버리고 다른 댓글을 수정할까요?')) return;
    const initial = { base: comment, draft: fromComment(comment), error: '' };
    restoreFocusId.current = null;
    assign(initial);
    void readLatest(initial, false);
  }

  async function save() {
    if (!current?.editToken || current.conflict || isPending() || !hasChanges(current)) return;
    const previous = current;
    const attempt = previous.attempt ?? { ...commentDraftPayload(previous.draft), editToken: current.editToken, requestId: newRequestId() };
    if (!attempt.body) return;
    const controller = startRequest('save');
    assign({ ...previous, attempt, error: '' });
    try {
      const result = await api<CommentEditResult>(commentPath(previous.base), {
        method: 'PATCH', signal: controller.signal, headers: { 'X-Actor-Id': actorId }, body: JSON.stringify(attempt),
      });
      validateReply(result, previous.base);
      const matchesAttempt = sameCommentDraft(result.comment, attempt);
      if (typeof result.duplicate !== 'boolean' || (!result.duplicate && !matchesAttempt)) throw new Error('댓글 수정 결과를 확인하지 못했습니다.');
      if (request.current !== controller) return;
      onSaved(result.comment);
      if (result.duplicate && !matchesAttempt) {
        assign({ base: result.comment, draft: previous.draft, editToken: result.editToken, reviewed: true,
          error: `수정은 저장됐습니다. 이후 변경된 현재 ${commentLabel(previous.base)}을 확인해 주세요.` });
        window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
        return;
      }
      finish();
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      notify(`${commentLabel(previous.base)}을 수정했습니다.`);
      void refresh().catch(() => undefined);
    } catch (error) {
      if (request.current !== controller) return;
      const known = error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
      const conflict = known && [404, 409].includes(error.status);
      assign({ ...previous, attempt: known ? undefined : attempt, conflict,
        error: known ? error.message : '수정 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.' });
    } finally { finishRequest(controller); }
  }

  return {
    actorId, current, operation, dirty: Boolean(current && hasChanges(current)), isPending, hasDraft, discard, open, close, save, restoreFocus,
    change: (draft: CommentDraft) => {
      if (current && !current.attempt && !isPending()) assign({ ...current, draft, error: current.conflict || current.reviewed ? current.error : '' });
    },
    review: () => {
      if (current) void readLatest(current, Boolean(current.editToken));
    },
  };
}

export type CommentEditing = ReturnType<typeof useCommentEditing>;

export function CommentEditButton({ comment, editing, disabled }: { comment: Comment; editing: CommentEditing; disabled?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const { restoreFocus } = editing;
  const unavailable = Boolean(disabled || editing.operation || editing.current?.base.id === comment.id);
  useLayoutEffect(() => {
    if (!unavailable) restoreFocus(comment.id, button.current);
  }, [comment.id, restoreFocus, unavailable]);
  if (!editing.actorId || comment.authorId !== editing.actorId) return null;
  const label = `${commentLabel(comment)} 수정`;
  return <button ref={button} type="button" className="comment-edit-button" aria-label={label} title={label}
    disabled={unavailable} onClick={() => editing.open(comment)}>
    <Pencil size={14} aria-hidden="true" />
  </button>;
}

export function CommentEditedMark({ comment }: { comment: Comment }) {
  return comment.editedAt ? <small className="comment-edited" title={new Date(comment.editedAt).toLocaleString('ko-KR')}>수정됨</small> : null;
}

export function CommentEditBody({ comment, editing, users }: { comment: Comment; editing: CommentEditing; users: readonly User[] }) {
  const editor = editing.current?.base.id === comment.id ? editing.current : null;
  return editor ? <CommentEditForm editor={editor} editing={editing} users={users} /> : <p><CommentBodyText comment={comment} /></p>;
}

function CommentEditForm({ editor, editing, users }: { editor: Editor; editing: CommentEditing; users: readonly User[] }) {
  const uid = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const label = commentLabel(editor.base);
  const pending = Boolean(editing.operation);
  const needsReview = editor.conflict || !editor.editToken;
  useLayoutEffect(() => { if (!pending && !needsReview && !editor.attempt) input.current?.focus({ preventScroll: true }); },
    [pending, needsReview, editor.attempt]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void editing.save();
  }

  return <form className="comment-edit-form" aria-label={`${label} 수정`} onSubmit={submit} aria-busy={pending}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || pending) return;
      event.preventDefault();
      event.stopPropagation();
      editing.close();
    }}>
    {editor.reviewed && <div className="comment-edit-latest"><strong>현재 {label}</strong><p><CommentBodyText comment={editor.base} /></p></div>}
    <label htmlFor={uid}>수정할 {label}</label>
    <CommentMentionInput id={uid} textareaRef={input} className="field" draft={editor.draft} onChange={editing.change}
      users={users} rows={4} required readOnly={pending || Boolean(editor.attempt) || !editor.editToken} />
    {editor.error && <p className="comment-edit-error" role="alert">{editor.error}</p>}
    {editing.operation === 'read' && <p role="status">현재 {label}을 확인하고 있습니다.</p>}
    <div className="comment-edit-actions">
      <button className="btn btn-ghost" type="button" disabled={pending} onClick={editing.close}>수정 취소</button>
      {needsReview ? <button className="btn" type="button" disabled={pending} onClick={editing.review}>현재 {label} 확인</button>
        : <button className="btn btn-primary" type="submit" disabled={pending || !editor.draft.body.trim() || !hasChanges(editor)}>
          {editing.operation === 'save' ? '저장 중…' : editor.attempt ? '수정 결과 다시 확인' : '수정 저장'}
        </button>}
    </div>
  </form>;
}
