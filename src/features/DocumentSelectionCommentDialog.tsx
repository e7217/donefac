'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import type { Comment, DocPage, DocumentSelectionCommentResult, DocumentSourceSelection, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { COMMENT_LIST_CHANGED } from './CommentTrashButton';
import './document-decision-link.css';
import './document-selection-comment.css';

export type SelectionCommentSource = Pick<DocPage, 'id' | 'title' | 'version'> & { sourceSelection: DocumentSourceSelection };
type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & {
  source: SelectionCommentSource;
  initialBody: string;
  onClose: () => void;
  onSaved: (comment: Comment) => void;
  onReselect: (body: string) => void;
};
type Attempt = { actorId: string; body: string; payload: string };

const COMMENT_LIMIT = 20_000;
const UNKNOWN_RESULT = '댓글 등록 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const STALE_SOURCE = '문서의 저장본이 변경됐습니다. 댓글 입력을 유지한 채 본문을 다시 선택할 수 있습니다.';

export function DocumentSelectionCommentDialog({ source, initialBody, actorId, refresh, notify, onClose, onSaved, onReselect }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const reselectButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const bodyRef = useRef(initialBody);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [replayRejected, setReplayRejected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    textarea.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  const confirmDiscard = useCallback(() => {
    if (attempt.current) return window.confirm('댓글이 등록됐을 수 있습니다. 문서의 댓글 목록에서 확인할 수 있습니다. 계속할까요?');
    return !bodyRef.current.trim() || window.confirm('작성 중인 발췌 댓글을 버릴까요?');
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('발췌 댓글 등록 결과를 확인한 뒤 이동해 주세요.', 'error');
      } else if (!confirmDiscard()) {
        event.preventDefault();
      } else {
        afterAcceptedNavigation(event, onClose);
      }
    }
    function unload(event: BeforeUnloadEvent) {
      if (!pending.current && !attempt.current && !bodyRef.current.trim()) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [confirmDiscard, notify, onClose]);

  function close() {
    if (pending.current || !confirmDiscard()) return;
    onClose();
    if (attempt.current) window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = bodyRef.current.trim();
    if (pending.current || sourceConflict || replayRejected || !trimmed) return;
    const replay = Boolean(attempt.current);
    const request = attempt.current ?? { actorId, body: trimmed, payload: JSON.stringify({
      requestId: newRequestId(), expectedDocumentVersion: source.version, sourceSelection: source.sourceSelection, body: trimmed,
    }) };
    attempt.current = request;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<DocumentSelectionCommentResult>(`/documents/${encodeURIComponent(source.id)}/selection-comments`, {
        method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.payload,
      });
      const saved = result?.comment;
      const pinned = saved?.documentSource;
      const { from, to, text } = source.sourceSelection;
      if (typeof result?.duplicate !== 'boolean' || !saved?.id || saved.resourceType !== 'document' || saved.resourceId !== source.id
        || saved.authorId !== request.actorId || saved.body !== request.body || !pinned?.revisionId
        || pinned.from !== from || pinned.to !== to || pinned.text !== text) throw new Error(UNKNOWN_RESULT);
      attempt.current = null;
      bodyRef.current = '';
      onSaved(saved);
    } catch (cause) {
      const knownFailure = cause instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(cause.status);
      if (!knownFailure) {
        setRecovering(true);
        setError(UNKNOWN_RESULT);
        requestAnimationFrame(() => submitButton.current?.focus({ preventScroll: true }));
        return;
      }
      attempt.current = null;
      setRecovering(false);
      const details = cause.details as { currentVersion?: number; reason?: string } | undefined;
      const stale = cause.status === 409 && (Number.isSafeInteger(details?.currentVersion)
        || details?.reason === 'source_selection_changed' || details?.reason === 'source_version_changed');
      if (stale) {
        setSourceConflict(true);
        setError(STALE_SOURCE);
        await refresh().catch(() => {});
        requestAnimationFrame(() => reselectButton.current?.focus({ preventScroll: true }));
      } else {
        if (replay || cause.status === 404) setReplayRejected(true);
        setError(replay ? `${cause.message} 문서의 댓글 목록을 확인해 주세요.` : cause.message);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="document-decision-link-dialog document-selection-comment-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
    }}>
    <form onSubmit={submit}>
      <header className="document-decision-link-header">
        <div><h2 id={titleId}>선택한 본문에 댓글 남기기</h2><p>{source.title} · 버전 {source.version}</p></div>
        <button type="button" className="btn btn-ghost" aria-label="닫기" disabled={busy} onClick={close}><X size={19} aria-hidden="true" /></button>
      </header>
      <section className="document-decision-link-excerpt" aria-label="선택한 본문">
        <blockquote tabIndex={0}>{source.sourceSelection.text}</blockquote>
      </section>
      <label className="document-selection-comment-input">발췌 댓글
        <textarea ref={textarea} className="field" rows={4} maxLength={COMMENT_LIMIT} value={body} disabled={busy}
          readOnly={recovering} onChange={event => { bodyRef.current = event.target.value; setBody(event.target.value); }} />
      </label>
      {error && <p className="document-decision-link-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>취소</button>
        {sourceConflict ? <button ref={reselectButton} className="btn btn-primary" type="button" disabled={busy}
          onClick={() => onReselect(bodyRef.current)}>본문 다시 선택</button>
          : <button ref={submitButton} type="submit" className="btn btn-primary" disabled={busy || replayRejected || !body.trim()}>
            <MessageSquarePlus size={16} aria-hidden="true" />{busy ? '등록 중…' : recovering ? '댓글 결과 다시 확인' : '발췌 댓글 등록'}
          </button>}
      </footer>
    </form>
  </dialog>;
}
