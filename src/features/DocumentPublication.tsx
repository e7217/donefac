'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, FileCheck2, FileText, RefreshCw, Send, X } from 'lucide-react';
import type {
  DocPage,
  DocRevision,
  DocumentPublicationTarget,
  DocumentPublicationView,
  FeatureProps,
  RichContent,
  WorkspaceSnapshot,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { DocumentBlocksProvider, ReadonlyDocumentContent } from './DocumentBlocks';
import './document-publication.css';

export interface DocumentPublicationProps {
  data: WorkspaceSnapshot;
  document: DocPage;
  actorId: string;
  canRequest: boolean;
  onClose: () => void;
  notify: FeatureProps['notify'];
  refreshDocument?: () => Promise<void>;
  initialSnapshot?: DocumentPublicationTarget | null;
}

type Action = 'request' | 'publish' | 'request_changes' | 'withdraw';
type SnapshotKind = DocumentPublicationTarget['kind'];
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '문서 검토 상태를 처리하지 못했습니다.';
const timestamp = (value: string) => new Date(value).toLocaleString('ko-KR');

/** Includes are stored references, not snapshots of their mutable target bodies. */
function snapshotContent(node: RichContent): RichContent {
  if (node.type === 'documentInclude') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : '';
    const id = typeof node.attrs?.documentId === 'string' ? node.attrs.documentId : '';
    return {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `포함 문서: ${label || id || '이름 없음'}${label && id ? ` (${id})` : ''} · 이 저장본에는 포함 대상의 본문이 고정되어 있지 않습니다.`,
        },
      ],
    };
  }
  return node.content ? { ...node, content: node.content.map(snapshotContent) } : node;
}

export function DocumentPublication(props: DocumentPublicationProps) {
  const target = props.initialSnapshot;
  return <PublicationDialog key={`${props.document.id}:${props.actorId}:${target?.kind ?? ''}:${target?.revisionId ?? ''}`} {...props} />;
}

function PublicationDialog({
  data,
  document: page,
  actorId,
  canRequest,
  onClose,
  notify,
  refreshDocument,
  initialSnapshot,
}: DocumentPublicationProps) {
  const titleId = useId();
  const [view, setView] = useState<DocumentPublicationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [reviewerId, setReviewerId] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [resultNote, setResultNote] = useState('');
  const [reviewSnapshot, setReviewSnapshot] = useState<DocRevision | null>(null);
  const [publishedSnapshot, setPublishedSnapshot] = useState<DocRevision | null>(null);
  const [snapshotGenerations, setSnapshotGenerations] = useState<
    Partial<Record<SnapshotKind, string | null>>
  >({});
  const [snapshotKind, setSnapshotKind] = useState<SnapshotKind | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState<SnapshotKind | null>(null);
  const [snapshotError, setSnapshotError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const dirty = useRef(false);
  const summaryRequest = useRef<AbortController | null>(null);
  const snapshotRequest = useRef<AbortController | null>(null);
  const initialSnapshotAttempted = useRef(false);
  const transitionRequest = useRef<AbortController | null>(null);
  const refreshDocumentRef = useRef(refreshDocument);
  const users = data.users.filter((user) => user.id !== actorId);
  const person = (id: string) =>
    data.users.find((user) => user.id === id)?.name ?? '현재 목록에 없는 팀원';

  const resetNotes = useCallback(() => {
    setReviewerId('');
    setRequestNote('');
    setResultNote('');
    dirty.current = false;
  }, []);

  function updateInputs(next: { reviewerId?: string; requestNote?: string; resultNote?: string }) {
    const reviewer = next.reviewerId ?? reviewerId;
    const requestText = next.requestNote ?? requestNote;
    const resultText = next.resultNote ?? resultNote;
    if (next.reviewerId !== undefined) setReviewerId(reviewer);
    if (next.requestNote !== undefined) setRequestNote(requestText);
    if (next.resultNote !== undefined) setResultNote(resultText);
    dirty.current = Boolean(reviewer || requestText || resultText);
  }

  const load = useCallback(
    async (refresh = false) => {
      if (pending.current) return;
      summaryRequest.current?.abort();
      const controller = new AbortController();
      summaryRequest.current = controller;
      setLoading(true);
      try {
        if (refresh && refreshDocumentRef.current) await refreshDocumentRef.current();
        if (!active.current || controller.signal.aborted) return;
        const result = await api<DocumentPublicationView>(
          `/documents/${encodeURIComponent(page.id)}/publication`,
          {
            signal: controller.signal,
            headers: { 'X-Actor-Id': actorId },
          },
        );
        if (!active.current || controller.signal.aborted) return;
        setView(result);
        setError('');
        setNeedsReload(false);
      } catch (cause) {
        if (active.current && !controller.signal.aborted)
          setError(`${messageOf(cause)} 작성한 메모와 이전 상태는 유지됩니다.`);
      } finally {
        if (active.current && !controller.signal.aborted) setLoading(false);
      }
    },
    [actorId, page.id],
  );

  useEffect(() => {
    refreshDocumentRef.current = refreshDocument;
  }, [refreshDocument]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      summaryRequest.current?.abort();
      snapshotRequest.current?.abort();
      transitionRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const previous = window.document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('문서 검토 처리가 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      if (dirty.current && !window.confirm('보내지 않은 검토자 선택과 메모를 버리고 이동할까요?')) {
        event.preventDefault();
        return;
      }
      afterAcceptedNavigation(event, () => {
        resetNotes();
        onClose();
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (pending.current || dirty.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('teamspace:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, onClose, resetNotes]);

  const close = useCallback(() => {
    if (pending.current) {
      notify('문서 검토 처리가 끝난 뒤 닫아 주세요.', 'error');
      return;
    }
    if (dirty.current && !window.confirm('보내지 않은 검토자 선택과 메모를 버리고 닫을까요?')) return;
    resetNotes();
    onClose();
  }, [notify, onClose, resetNotes]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const modal = dialog.current;
      if (!modal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll<HTMLElement>(
        'button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]',
      )].filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      const focused = window.document.activeElement;
      if (!first || !last || focused === modal || !modal.contains(focused) ||
        (event.shiftKey ? focused === first : focused === last)) {
        event.preventDefault();
        (event.shiftKey ? last ?? modal : first ?? modal).focus();
      }
    }
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [close]);

  const fetchSnapshot = useCallback(async ({kind,revisionId}:DocumentPublicationTarget, generation:string|null) => {
    snapshotRequest.current?.abort();
    const controller = new AbortController();
    snapshotRequest.current = controller;
    setSnapshotLoading(kind);
    setSnapshotError('');
    try {
      const result = await api<DocRevision>(
        `/documents/${encodeURIComponent(page.id)}/publication/snapshot?kind=${kind}&revisionId=${encodeURIComponent(revisionId)}`,
        {
          signal: controller.signal,
          headers: { 'X-Actor-Id': actorId },
        },
      );
      if (!active.current || controller.signal.aborted) return;
      if (result.id !== revisionId || result.documentId !== page.id)
        throw new Error('요청한 저장본과 응답이 일치하지 않습니다. 최신 상태를 확인해 주세요.');
      if (kind === 'review') setReviewSnapshot(result);
      else setPublishedSnapshot(result);
      setSnapshotGenerations((previous) => ({ ...previous, [kind]: generation }));
      setSnapshotKind(kind);
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      setSnapshotError(messageOf(cause));
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404))
        setNeedsReload(true);
    } finally {
      if (active.current && !controller.signal.aborted) setSnapshotLoading(null);
    }
  }, [actorId,page.id]);

  function loadSnapshot(kind: SnapshotKind) {
    if (!view || pending.current) return;
    const revisionId = kind === 'review' ? view.review?.revisionId : view.published?.revisionId;
    if (!revisionId) return;
    const cached = kind === 'review' ? reviewSnapshot : publishedSnapshot;
    if (cached?.id === revisionId && snapshotGenerations[kind] === view.workspaceGeneration) {
      setSnapshotKind(kind);
      setSnapshotError('');
      return;
    }
    void fetchSnapshot({kind,revisionId},view.workspaceGeneration);
  }

  useEffect(() => {
    if (!initialSnapshot || !view || loading || initialSnapshotAttempted.current) return;
    const timer = setTimeout(() => {
      initialSnapshotAttempted.current = true;
      const current = initialSnapshot.kind === 'review' ? view.review : view.published;
      if (current?.revisionId !== initialSnapshot.revisionId) {
        setSnapshotError('링크가 가리킨 저장본이 현재 상태에서 변경되었습니다. 필요한 경우 현재 저장본을 선택해 주세요.');
        return;
      }
      void fetchSnapshot(initialSnapshot,view.workspaceGeneration);
    },0);
    return () => clearTimeout(timer);
  }, [initialSnapshot,view,loading,fetchSnapshot]);

  const requestOutdated = Boolean(view && view.documentVersion > page.version);
  const reviewLoaded = Boolean(
    view?.review &&
      reviewSnapshot?.id === view.review.revisionId &&
      snapshotGenerations.review === view.workspaceGeneration,
  );
  const isReviewer = Boolean(view?.review && view.review.reviewerId === actorId);
  const isRequester = Boolean(view?.review && view.review.requestedById === actorId);
  const actionsDisabled = !view || loading || Boolean(busy) || needsReload;

  async function transition(action: Action) {
    if (!view || actionsDisabled || pending.current) return;
    if (
      action === 'request' &&
      (!canRequest || requestOutdated || !reviewerId || reviewerId === actorId)
    )
      return;
    if ((action === 'publish' || action === 'request_changes') && (!isReviewer || !reviewLoaded)) return;
    if (action === 'request_changes' && !resultNote.trim()) return;
    if (action === 'withdraw' && !isRequester) return;
    if (
      action === 'withdraw' &&
      !window.confirm('현재 검토 요청을 철회할까요? 기존 발행본은 유지됩니다.')
    )
      return;
    pending.current = true;
    setBusy(action);
    setError('');
    const controller = new AbortController();
    transitionRequest.current = controller;
    try {
      const result = await api<DocumentPublicationView>(
        `/documents/${encodeURIComponent(page.id)}/publication`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'X-Actor-Id': actorId },
          body: JSON.stringify({
            action,
            expectedVersion: view.version,
            workspaceGeneration: view.workspaceGeneration,
            ...(action === 'request'
              ? { expectedDocumentVersion: page.version, reviewerId, note: requestNote }
              : {}),
            ...(action === 'request_changes' || action === 'publish' ? { note: resultNote } : {}),
          }),
        },
      );
      if (!active.current || controller.signal.aborted) return;
      setView(result);
      setNeedsReload(false);
      resetNotes();
      window.dispatchEvent(new Event('teamspace:publication-changed'));
      notify(
        action === 'request'
          ? '저장된 문서의 검토를 요청했습니다.'
          : action === 'publish'
            ? '검토본을 발행했습니다.'
            : action === 'request_changes'
              ? '수정을 요청했습니다.'
              : '검토 요청을 철회했습니다.',
      );
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      const ambiguous = !(cause instanceof ApiError) || cause.status >= 500;
      if (ambiguous || (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)))
        setNeedsReload(true);
      setError(
        `${messageOf(cause)} ${ambiguous ? '처리 결과를 최신 정보에서 확인해 주세요.' : '작성한 메모는 유지됩니다.'}`,
      );
    } finally {
      if (active.current && !controller.signal.aborted) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  const selectedSnapshot =
    snapshotKind === 'review' ? reviewSnapshot : snapshotKind === 'published' ? publishedSnapshot : null;
  const renderedContent = useMemo(
    () => (selectedSnapshot ? snapshotContent(selectedSnapshot.content) : null),
    [selectedSnapshot],
  );
  const pinnedId = snapshotKind === 'review' ? view?.review?.revisionId : view?.published?.revisionId;
  const previousSnapshot = Boolean(
    selectedSnapshot &&
      (selectedSnapshot.id !== pinnedId ||
        (snapshotKind && snapshotGenerations[snapshotKind] !== view?.workspaceGeneration)),
  );
  const frozenData = useMemo(() => ({ ...data, documents: [], issues: [] }), [data]);
  const noNavigation = useCallback(() => {}, []);
  if (typeof window === 'undefined') return null;

  return createPortal(
    <div
      className="document-publication-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialog}
        className="document-publication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="document-publication-header">
          <div>
            <h2 id={titleId}>
              <FileCheck2 size={21} aria-hidden="true" />
              문서 검토·발행
            </h2>
            <p>{page.title}</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-btn"
            aria-label="검토·발행 닫기"
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <div className="document-publication-content">
          <div className="document-publication-toolbar">
            <span>현재 편집기에 열린 저장 버전 {page.version}</span>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="검토·발행 최신 정보"
              disabled={loading || Boolean(busy)}
              onClick={() => void load(true)}
            >
              <RefreshCw size={14} />
              {loading ? '불러오는 중…' : '최신 정보'}
            </button>
          </div>
          {error && (
            <p className="document-publication-error" role="alert">
              {error}
            </p>
          )}
          {needsReload && (
            <p className="document-publication-warning" role="status">
              상태가 바뀌었거나 처리 결과를 확인해야 합니다. 메모는 유지됩니다. 최신 정보를 불러온 후
              진행하세요.
            </p>
          )}
          {!view && loading && <p role="status">문서 검토 상태를 불러오는 중…</p>}

          {view && (
            <>
              <div className="document-publication-state-grid">
                <section className="document-publication-state" aria-label="현재 검토 요청">
                  <h3>
                    <FileText size={17} aria-hidden="true" />
                    {view.review?.changesRequested
                      ? '수정 요청됨'
                      : view.review
                        ? '검토 대기'
                        : '검토 요청 없음'}
                  </h3>
                  {view.review ? (
                    <>
                      <strong>{view.reviewRevision?.title ?? '검토 요청 당시 저장본'}</strong>
                      <p>저장 버전 {view.reviewRevision?.version ?? '확인 필요'}</p>
                      <dl>
                        <div>
                          <dt>요청자</dt>
                          <dd>{person(view.review.requestedById)}</dd>
                        </div>
                        <div>
                          <dt>검토자</dt>
                          <dd>{person(view.review.reviewerId)}</dd>
                        </div>
                        <div>
                          <dt>요청 시각</dt>
                          <dd>{timestamp(view.review.requestedAt)}</dd>
                        </div>
                      </dl>
                      {view.review.note && (
                        <p className="document-publication-note">{view.review.note}</p>
                      )}
                      {view.review.changesRequested && (
                        <div className="document-publication-changes">
                          <strong>{person(view.review.changesRequested.byId)}의 수정 요청</strong>
                          <time>{timestamp(view.review.changesRequested.at)}</time>
                          <p>{view.review.changesRequested.note}</p>
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn"
                        disabled={Boolean(busy) || Boolean(snapshotLoading) || loading}
                        onClick={() => void loadSnapshot('review')}
                      >
                        검토본 불러오기
                      </button>
                    </>
                  ) : (
                    <p>저장한 문서를 다른 팀원에게 검토 요청할 수 있습니다.</p>
                  )}
                </section>
                <section className="document-publication-state is-published" aria-label="기존 발행본">
                  <h3>
                    <CheckCircle2 size={17} aria-hidden="true" />
                    발행본
                  </h3>
                  {view.published ? (
                    <>
                      <strong>{view.publishedRevision?.title ?? '발행 당시 저장본'}</strong>
                      <p>저장 버전 {view.publishedRevision?.version ?? '확인 필요'}</p>
                      <dl>
                        <div>
                          <dt>발행자</dt>
                          <dd>{person(view.published.publishedById)}</dd>
                        </div>
                        <div>
                          <dt>발행 시각</dt>
                          <dd>{timestamp(view.published.publishedAt)}</dd>
                        </div>
                      </dl>
                      {view.published.note && <p className="document-publication-note">{view.published.note}</p>}
                      <button
                        type="button"
                        className="btn"
                        disabled={Boolean(busy) || Boolean(snapshotLoading) || loading}
                        onClick={() => void loadSnapshot('published')}
                      >
                        발행본 불러오기
                      </button>
                    </>
                  ) : (
                    <p>아직 발행한 저장본이 없습니다.</p>
                  )}
                  <p className="document-publication-help">
                    초안 수정과 새 검토 중에도 기존 발행본은 유지됩니다.
                  </p>
                </section>
              </div>

              {view.review && isReviewer && !view.review.changesRequested && (
                <section className="document-publication-review-actions" aria-label="검토 결과 보내기">
                  <h3>검토 결과</h3>
                  <p>검토 요청 당시 저장본을 불러와 확인한 뒤 결과를 보내세요.</p>
                  <fieldset disabled={actionsDisabled}>
                    <label>
                      검토 결과 메모
                      <textarea
                        className="field"
                        aria-label="검토 결과 메모"
                        value={resultNote}
                        onChange={(event) => updateInputs({ resultNote: event.target.value })}
                        maxLength={2000}
                        rows={3}
                        placeholder="발행 메모를 남기거나 수정할 내용을 적어 주세요."
                      />
                    </label>
                    <div className="document-publication-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={!reviewLoaded || !resultNote.trim()}
                        onClick={() => void transition('request_changes')}
                      >
                        수정 요청 보내기
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!reviewLoaded}
                        onClick={() => void transition('publish')}
                      >
                        <CheckCircle2 size={15} />
                        검토본 발행
                      </button>
                    </div>
                    {!reviewLoaded && (
                      <p className="document-publication-help">
                        먼저 ‘검토본 불러오기’로 이번 검토본을 확인하세요.
                      </p>
                    )}
                  </fieldset>
                </section>
              )}

              {view.review && isRequester && (
                <div className="document-publication-withdraw">
                  <span>본인이 요청한 검토입니다.</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={actionsDisabled}
                    onClick={() => void transition('withdraw')}
                  >
                    검토 요청 철회
                  </button>
                </div>
              )}
              {view.review && !isReviewer && !isRequester && (
                <p className="document-publication-help">
                  지정된 검토자가 검토 결과를 보낼 수 있습니다.
                </p>
              )}

              {(!view.review || Boolean(view.review.changesRequested)) && (
                <section className="document-publication-request" aria-label="문서 검토 요청">
                  <h3>{view.review?.changesRequested ? '수정한 문서 다시 요청' : '새 검토 요청'}</h3>
                  <p>현재 편집기에 열린 저장 버전 {page.version}을 고정해 검토를 요청합니다.</p>
                  {!canRequest && (
                    <p className="document-publication-warning">
                      현재 편집을 저장한 뒤 검토를 요청하세요.
                    </p>
                  )}
                  {requestOutdated && (
                    <p className="document-publication-warning">
                      서버에 더 최신 문서가 있습니다. 최신 정보를 불러와 문서 버전을 확인한 뒤
                      요청하세요.
                    </p>
                  )}
                  <fieldset disabled={actionsDisabled || !canRequest || requestOutdated}>
                    <label>
                      검토자
                      <select
                        className="field"
                        aria-label="검토자"
                        value={reviewerId}
                        onChange={(event) => updateInputs({ reviewerId: event.target.value })}
                      >
                        <option value="">다른 팀원을 선택하세요</option>
                        {reviewerId && !users.some((user) => user.id === reviewerId) && (
                          <option value={reviewerId}>현재 목록에 없는 팀원</option>
                        )}
                        {users.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      검토 요청 메모 <span>(선택)</span>
                      <textarea
                        className="field"
                        aria-label="검토 요청 메모"
                        value={requestNote}
                        onChange={(event) => updateInputs({ requestNote: event.target.value })}
                        maxLength={2000}
                        rows={3}
                        placeholder="검토할 내용이나 확인할 점"
                      />
                    </label>
                    <div className="document-publication-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!reviewerId || !users.some((user) => user.id === reviewerId)}
                        onClick={() => void transition('request')}
                      >
                        <Send size={15} />
                        검토 요청 보내기
                      </button>
                    </div>
                  </fieldset>
                </section>
              )}
            </>
          )}

          {snapshotLoading && (
            <p role="status">{snapshotLoading === 'review' ? '검토본' : '발행본'}을 불러오는 중…</p>
          )}
          {snapshotError && (
            <p className="document-publication-error" role="alert">
              {snapshotError}
            </p>
          )}
          {selectedSnapshot && renderedContent && (
            <section
              className="document-publication-snapshot"
              aria-label={snapshotKind === 'review' ? '검토 고정본 내용' : '발행 고정본 내용'}
            >
              <header>
                <span>
                  {previousSnapshot ? '이전 ' : ''}
                  {snapshotKind === 'review' ? '검토 요청 당시 저장본' : '발행 당시 저장본'} · 읽기 전용
                  · 버전 {selectedSnapshot.version}
                </span>
                <h3>{selectedSnapshot.title}</h3>
                <time>
                  {timestamp(selectedSnapshot.createdAt)} · {person(selectedSnapshot.authorId)}
                </time>
              </header>
              <p className="document-publication-help">
                참조 이름은 저장된 값을 표시합니다. 포함 대상의 현재 본문은 표시하지 않습니다.
              </p>
              <DocumentBlocksProvider
                data={frozenData}
                documentId={page.id}
                content={renderedContent}
                openIssue={noNavigation}
                openDocument={noNavigation}
              >
                <ReadonlyDocumentContent
                  content={renderedContent}
                  documentId={page.id}
                  nodeBudget={30000}
                />
              </DocumentBlocksProvider>
            </section>
          )}
        </div>
        <footer className="document-publication-footer">
          <span>
            {busy ? '검토 상태를 저장하는 중…' : '검토·발행은 저장된 문서 버전을 기준으로 진행합니다.'}
          </span>
          <button type="button" className="btn" onClick={close}>
            닫기
          </button>
        </footer>
      </section>
    </div>,
    window.document.body,
  );
}
