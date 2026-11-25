'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ISSUE_VIEW_SORT_LABELS, issueViewUsesCurrentUser } from '../../shared/issue-view';
import { JIRA_SAVED_VIEW_QUERY_LIMIT, type FeatureProps, type JiraSavedViewPreview, type Project, type SavedView, type SavedViewState } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import './saved-views.css';

type Props = Pick<FeatureProps, 'actorId' | 'notify'> & {
  project: Pick<Project, 'id' | 'key' | 'name'>;
  currentLayout: SavedViewState['layout'];
  initialQuery?: string;
  onClose: () => void;
  onSaved: (view: SavedView) => void;
};

type Operation = 'preview' | 'save' | 'verify';
const REQUEST_TIMEOUT = 25_000;
const nameKey = (name: string) => name.replace(/[A-Z]/g, letter => letter.toLowerCase());

function viewSignature({ filters, sort }: Pick<SavedViewState, 'filters' | 'sort'>) {
  return JSON.stringify({ filters, sort }, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function JiraSavedViewDialog({ actorId, project, notify, currentLayout, initialQuery = '', onClose, onSaved }: Props) {
  const titleId = useId();
  const queryId = `${titleId}-query`;
  const queryErrorId = `${queryId}-error`;
  const dialog = useRef<HTMLDialogElement>(null);
  const queryInput = useRef<HTMLTextAreaElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const verifyButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const saved = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [name, setName] = useState('');
  const [layout, setLayout] = useState(currentLayout);
  const [review, setReview] = useState<JiraSavedViewPreview | null>(null);
  const [acceptProjectOrder, setAcceptProjectOrder] = useState(false);
  const [pending, setPending] = useState<Operation | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const dirty = Boolean(query !== initialQuery || name || layout !== currentLayout);
  const locked = Boolean(pending || uncertain);
  const queryTooLong = query.length > JIRA_SAVED_VIEW_QUERY_LIMIT;
  const canPreview = Boolean(query.trim()) && !queryTooLong && !locked;
  const requiresProjectOrder = review?.requiresProjectOrderAcceptance === true;
  const canSave = Boolean(review && name.trim() && (!requiresProjectOrder || acceptProjectOrder));
  const criteria = review?.criteria.filter(({ field }) => field !== 'project') ?? [];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    queryInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      if (!saved.current && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented || saved.current) return;
      if (request.current) {
        event.preventDefault();
        notify('Jira 필터 요청이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      if (dirty && !window.confirm(uncertain
        ? '공유 보기가 저장됐을 수 있습니다. 확인을 닫고 이동할까요?'
        : '입력한 Jira 검색식과 보기 설정을 버리고 이동할까요?')) {
        event.preventDefault();
        return;
      }
      afterAcceptedNavigation(event, onClose);
    }
    function unload(event: BeforeUnloadEvent) {
      if (saved.current || (!dirty && !request.current)) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, notify, onClose, uncertain]);

  useEffect(() => {
    if (pending) return;
    if (uncertain) {
      alert.current?.scrollIntoView({ block: 'nearest' });
      verifyButton.current?.focus({ preventScroll: true });
    } else if (error) alert.current?.focus();
    else if (review) previewHeading.current?.focus();
  }, [error, pending, review, uncertain]);

  function close() {
    if (request.current) return;
    if (dirty && !window.confirm(uncertain
      ? '공유 보기가 저장됐을 수 있습니다. 결과 확인을 닫을까요?'
      : '입력한 Jira 검색식과 보기 설정을 버릴까요?')) return;
    onClose();
  }

  function changeQuery(value: string) {
    setQuery(value);
    setReview(null);
    setAcceptProjectOrder(false);
    setError('');
  }

  function timedSignal(signal: AbortSignal) {
    return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
  }

  async function run(kind: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(kind);
    setError('');
    try {
      await action(timedSignal(controller.signal));
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (kind === 'save' && (!(cause instanceof ApiError) || cause.status === 408 || cause.status >= 500) && review) {
        setPending('verify');
        setUncertain(true);
        try {
          await verifySavedResult(review, timedSignal(controller.signal));
        } catch {
          if (!controller.signal.aborted) {
            setError('공유 보기 저장 결과를 확인하지 못했습니다. 저장 결과를 다시 확인해 주세요.');
          }
        }
        return;
      }
      if (kind === 'save' && cause instanceof ApiError && cause.status === 409 &&
          (cause.details as { code?: string } | undefined)?.code === 'stale_jira_view_preview') {
        setReview(null);
        setAcceptProjectOrder(false);
      }
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      setError(timedOut ? '요청 응답 시간이 지났습니다. 다시 시도해 주세요.'
        : cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  function preview() {
    if (!canPreview) return;
    void run('preview', async signal => {
      setReview(null);
      setAcceptProjectOrder(false);
      const updated = await api<JiraSavedViewPreview>('/views/jira/preview', {
        method: 'POST', signal, headers: { 'X-Actor-Id': actorId }, body: JSON.stringify({ projectId: project.id, jql: query }),
      });
      if (!signal.aborted) setReview(updated);
    });
  }

  function complete(view: SavedView) {
    saved.current = true;
    onSaved(view);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!review || !canSave || locked) return;
    void run('save', async signal => {
      const view = await api<SavedView>('/views/jira/import', {
        method: 'POST', signal, headers: { 'X-Actor-Id': actorId }, body: JSON.stringify({ projectId: project.id, jql: query,
          name: name.trim(), layout, revision: review.revision, acceptProjectOrder }),
      });
      if (typeof view?.id !== 'string' || view.projectId !== project.id) throw new Error('저장 응답을 확인할 수 없습니다.');
      if (!signal.aborted) complete(view);
    });
  }

  async function verifySavedResult(reviewed: JiraSavedViewPreview, signal: AbortSignal) {
    const views = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(project.id)}`, {
      signal, cache: 'no-store', headers: { 'X-Actor-Id': actorId },
    });
    if (signal.aborted) return;
    const named = views.find(view => nameKey(view.name) === nameKey(name.trim()));
    if (named && named.name === name.trim() && named.projectId === project.id && named.authorId === actorId &&
        named.layout === layout && !named.boardGrouping && viewSignature(named) === viewSignature(reviewed)) {
      complete(named);
      return;
    }
    setUncertain(false);
    setReview(null);
    setAcceptProjectOrder(false);
    setError(named ? '같은 이름의 공유 보기가 있습니다. 다른 이름을 쓰고 조건을 다시 미리보기해 주세요.'
      : '저장된 보기를 찾지 못했습니다. 조건을 다시 미리보기한 뒤 저장해 주세요.');
  }

  function verify() {
    if (uncertain && review) void run('verify', signal => verifySavedResult(review, signal));
  }

  return <dialog ref={dialog} className="jira-saved-view-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={save}>
      <header>
        <h2 id={titleId}>Jira 필터 옮기기</h2>
        <p>대상 프로젝트 <strong>{project.key} · {project.name}</strong></p>
      </header>
      <div className="jira-saved-view-content">
        <label className="form-label" htmlFor={queryId}>Jira 검색식 (JQL)</label>
        <textarea id={queryId} ref={queryInput} className="field" rows={4} spellCheck={false}
          aria-invalid={queryTooLong || undefined} aria-describedby={queryTooLong ? queryErrorId : undefined}
          value={query} onChange={event => changeQuery(event.currentTarget.value)} disabled={locked} />
        {queryTooLong && <p id={queryErrorId} className="issue-form-error" role="alert">
          Jira 검색식은 최대 {JIRA_SAVED_VIEW_QUERY_LIMIT.toLocaleString('ko-KR')}자까지 검토할 수 있습니다. 검색식을 줄여 주세요.
        </p>}
        <button type="button" className="btn jira-saved-view-preview-button" onClick={preview}
          disabled={!canPreview}>조건 미리보기</button>
        {pending && <p role="status">{pending === 'preview' ? 'Jira 조건을 확인 중입니다.'
          : pending === 'verify' ? '저장 결과를 확인 중입니다.' : '공유 보기를 저장 중입니다.'}</p>}
        {error && <p ref={alert} className="issue-form-error" role="alert" tabIndex={-1}>{error}</p>}
        {review && <section className="jira-saved-view-review" aria-label="Jira 필터 미리보기">
          <h3 ref={previewHeading} tabIndex={-1}>일치 업무 {review.total.toLocaleString('ko-KR')}개</h3>
          {issueViewUsesCurrentUser(review.filters) &&
            <p>미리보기는 지금 선택한 작업자를 기준으로 계산합니다. 저장한 보기는 열어 본 작업자의 업무를 표시합니다.</p>}
          {criteria.length ? <ul className="jira-saved-view-criteria" aria-label="적용할 검색 조건">
            {criteria.map(({ field, label }, index) => <li key={`${field}-${index}`}>{label}</li>)}
          </ul> : <p>이 프로젝트의 모든 업무가 조건에 해당합니다.</p>}
          {review.issues.length > 0 && <ol aria-label="일치 업무 예시">{review.issues.map(issue => <li key={issue.id}>
            <strong>{issue.key}</strong> {issue.title}
          </li>)}</ol>}
          {review.total > review.issues.length && <p>처음 {review.issues.length.toLocaleString('ko-KR')}개 업무를 표시합니다.</p>}
          {review.orderBy.length > 0 && <div className="jira-saved-view-sort">
            <p><code>ORDER BY {review.orderBy.map(({ field, direction }) => [field, direction?.toUpperCase()].filter(Boolean).join(' ')).join(', ')}</code></p>
            {review.sort?.length ? <>
              <p>저장할 정렬 · {review.sort.map(({ field, direction }) => `${ISSUE_VIEW_SORT_LABELS[field]} ${direction === 'asc' ? '오름차순' : '내림차순'}`).join(', ')}</p>
              <p>현재 Teamspace 업무 값으로 정렬합니다. {review.sort.some(({ field }) => field === 'dueDate') && '목표 마감일이 비어 있으면 뒤에 표시합니다.'}</p>
            </> : null}
            {requiresProjectOrder && <>
              <p>공유 보기에서는 대상 프로젝트에 저장된 업무 순서를 사용합니다.</p>
              <label><input type="checkbox" checked={acceptProjectOrder} disabled={locked}
                onChange={event => setAcceptProjectOrder(event.currentTarget.checked)} />프로젝트 정렬 사용</label>
            </>}
          </div>}
        </section>}
        <div className="jira-saved-view-details">
          <label className="form-label">보기 이름<input className="field" value={name} maxLength={80} required disabled={locked}
            onChange={event => setName(event.currentTarget.value)} /></label>
          <label className="form-label">보기 형식<select className="field" value={layout} disabled={locked}
            onChange={event => setLayout(event.currentTarget.value === 'board' ? 'board' : 'list')}>
            <option value="list">목록</option><option value="board">보드</option>
          </select></label>
        </div>
      </div>
      <footer>
        <button type="button" className="btn" onClick={close} disabled={Boolean(pending)}>취소</button>
        {uncertain ? <button type="button" ref={verifyButton} className="btn btn-primary" onClick={verify}
          disabled={Boolean(pending)}>저장 결과 다시 확인</button> : <button type="submit" className="btn btn-primary"
          disabled={Boolean(pending) || !canSave}>공유 보기 저장</button>}
      </footer>
    </form>
  </dialog>;
}
