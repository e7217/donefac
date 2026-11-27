'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Copy, RefreshCw, X } from 'lucide-react';
import { orderProjectIssues } from '../../shared/issue-view';
import { MAX_CYCLE_COPY_ISSUES, MAX_CYCLE_COPY_SHIFT_DAYS, type CycleCopyInput, type CycleCopyPreview, type CycleCopyResult, type FeatureProps, type PlanningItem } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { dependencyLabel, errorMessage } from './schedule-utils';
import './cycle-copy.css';

type Props = Pick<FeatureProps, 'actorId' | 'data' | 'notify' | 'refresh'> & {
  source: PlanningItem;
  cycle?: PlanningItem;
  onClose: () => void;
  onOpenCycle: (cycle: PlanningItem) => void;
  restoreFocus: () => void;
};
type Operation = 'preview' | 'apply' | 'latest' | 'refresh';
const COPY_NAME_SUFFIX = ' 복사본';
const MAX_NAME_LENGTH = 120;
const date = (value: string | null) => value ?? '미정';
const isStale = (error: unknown) => error instanceof ApiError && [404, 409, 410].includes(error.status);
const hasReason = (error: unknown, reason: string) => error instanceof ApiError &&
  error.details != null && typeof error.details === 'object' && 'reason' in error.details && error.details.reason === reason;

export function CycleCopyDialog({ source, cycle, data, actorId, notify, refresh, onClose, onOpenCycle, restoreFocus }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const { id, projectId } = source;
  const initialName = source.name.slice(0, MAX_NAME_LENGTH - COPY_NAME_SUFFIX.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + COPY_NAME_SUFFIX;
  const members = orderProjectIssues(data.issues.filter(issue => issue.projectId === projectId && issue.cycleId === id),
    data.issueOrders?.find(order => order.projectId === projectId));
  const [initialSelection] = useState(() => members.length <= MAX_CYCLE_COPY_ISSUES ? new Set(members.map(issue => issue.id)) : new Set<string>());
  const [selected, setSelected] = useState(initialSelection);
  const [name, setName] = useState(initialName);
  const [days, setDays] = useState('0');
  const [review, setReview] = useState<{ preview: CycleCopyPreview; fingerprint: string } | null>(null);
  const [result, setResult] = useState<CycleCopyResult | null>(null);
  const [unavailableResult, setUnavailableResult] = useState('');
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [needsLatest, setNeedsLatest] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);

  const issues = members.filter(issue => selected.has(issue.id)).map(({ id, version }) => ({ id, expectedVersion: version }));
  const dateShiftDays = Number(days);
  const validDays = /^[+-]?\d+$/.test(days) && Number.isInteger(dateShiftDays) && Math.abs(dateShiftDays) <= MAX_CYCLE_COPY_SHIFT_DAYS;
  const input: CycleCopyInput | null = cycle ? { expectedVersion: cycle.version, name: name.trim(), dateShiftDays, issues } : null;
  const fingerprint = JSON.stringify(input);
  const preview = review?.preview;
  const expiry = preview?.expiresAt ? Date.parse(preview.expiresAt) : NaN;
  const expired = Boolean(preview?.previewId && (!Number.isFinite(expiry) || expiry <= clock));
  const previewChanged = Boolean(review && review.fingerprint !== fingerprint);
  const resultConfirmed = Boolean(result || unavailableResult);
  const mayPreview = Boolean(input?.name && validDays && issues.length > 0 && issues.length <= MAX_CYCLE_COPY_ISSUES && !needsLatest && !unknown && !resultConfirmed);
  const mayApply = Boolean(preview?.previewId && !preview.errors.length && !needsLatest && !resultConfirmed &&
    (unknown || (cycle && !previewChanged && !expired)));
  const dirty = !resultConfirmed && Boolean(name !== initialName || days !== '0' || selected !== initialSelection || review || unknown);
  const discard = unknown
    ? '복제 요청의 결과를 아직 확인하지 못했습니다. 결과를 다시 확인할 정보를 버리고 닫을까요?'
    : '입력한 사이클 복제 조건과 미리보기를 버리고 닫을까요?';
  const path = `/planning-items/${encodeURIComponent(id)}`;
  const headers = { 'X-Actor-Id': actorId };
  const person = (userId: string | null) => userId ? data.users.find(user => user.id === userId)?.name ?? userId : '미지정';

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    nameInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      restoreFocus();
    };
  }, [restoreFocus]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('사이클 복제 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (dirty && !window.confirm(discard)) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!request.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('donefac:navigate', guard);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('donefac:workspace-imported', onClose);
    return () => {
      window.removeEventListener('donefac:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('donefac:workspace-imported', onClose);
    };
  }, [dirty, discard, notify, onClose]);

  useEffect(() => {
    if (result || unavailableResult) resultHeading.current?.focus();
    else if (review) previewHeading.current?.focus();
  }, [review, result, unavailableResult]);

  function close() {
    if (!request.current && (!dirty || window.confirm(discard))) onClose();
  }

  async function run(kind: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError('');
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  function updateSelection(next: Set<string>) {
    setSelected(next.size === initialSelection.size && [...next].every(id => initialSelection.has(id)) ? initialSelection : next);
    setReview(null);
    setError('');
  }

  function toggleIssue(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    updateSelection(next);
  }

  function reviewCopy(event: FormEvent) {
    event.preventDefault();
    if (!mayPreview) return;
    void run('preview', async signal => {
      setReview(null);
      try {
        const preview = await api<CycleCopyPreview>(`${path}/copy-preview`, {
          method: 'POST', headers, signal, body: fingerprint,
        });
        if (!signal.aborted) {
          setClock(Date.now());
          setReview({ preview, fingerprint });
        }
      } catch (cause) {
        if (!signal.aborted && (hasReason(cause, 'stale_preview') ||
          (cause instanceof ApiError && [404, 410].includes(cause.status)))) setNeedsLatest(true);
        throw cause;
      }
    });
  }

  async function reflectSaved(signal: AbortSignal) {
    try {
      await refresh();
      if (!signal.aborted) setRefreshFailed(false);
    } catch {
      if (!signal.aborted) setRefreshFailed(true);
    }
  }

  function apply() {
    if (!mayApply || !preview?.previewId) return;
    const { previewId } = preview;
    void run('apply', async signal => {
      let saved: CycleCopyResult;
      try {
        saved = await api<CycleCopyResult>(`${path}/copy`, {
          method: 'POST', headers, signal, body: JSON.stringify({ previewId }),
        });
        if (!saved?.cycle?.id || saved.cycle.id === id || saved.cycle.projectId !== projectId ||
          saved.cycle.kind !== 'cycle' || !Array.isArray(saved.issues)) throw new Error('복제 응답을 확인하지 못했습니다.');
      } catch (cause) {
        if (signal.aborted) return;
        if (hasReason(cause, 'result_unavailable')) {
          setUnknown(false);
          setUnavailableResult(errorMessage(cause));
          await reflectSaved(signal);
          return;
        }
        if (isStale(cause)) {
          setNeedsLatest(true);
          setUnknown(false);
          setReview(null);
          throw cause;
        }
        if (!unknown && cause instanceof ApiError && [400, 401, 403, 422].includes(cause.status)) {
          setReview(null);
          throw cause;
        }
        setUnknown(true);
        throw new Error('복제 요청의 결과를 확인하지 못했습니다. 같은 요청의 결과를 다시 확인해 주세요.');
      }
      if (signal.aborted) return;
      setUnknown(false);
      setResult(saved);
      notify(`${saved.cycle.name} 사이클을 만들었습니다.`);
      await reflectSaved(signal);
    });
  }

  function loadLatest() {
    void run('latest', async signal => {
      setReview(null);
      await refresh();
      if (!signal.aborted) setNeedsLatest(false);
    });
  }

  return <dialog ref={dialog} className="cycle-copy-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId}>사이클 업무와 함께 복제</h2>
      <button className="btn btn-ghost" type="button" aria-label="사이클 복제 닫기" disabled={Boolean(busy)} onClick={close}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className="cycle-copy-body" aria-busy={Boolean(busy)}>
      <p id={descriptionId}><strong>{cycle?.name ?? source.name}</strong>의 업무로 같은 프로젝트에 새 계획 사이클을 만듭니다.</p>
      {resultConfirmed ? <>
        <div className="cycle-copy-result">
          <p ref={resultHeading} tabIndex={-1} role="status">
            {result ? <><strong>{result.cycle.name}</strong> 사이클을 만들었습니다.</> : unavailableResult}
          </p>
          {result && <p>새 업무 {result.issues.length}건 · 의존성 {result.dependencies}건</p>}
        </div>
        {refreshFailed && <div className="cycle-copy-feedback">
          <p role="alert">복제를 저장했습니다. 계획 목록의 최신 정보를 불러오지 못했습니다.</p>
          <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void run('refresh', reflectSaved)}>
            <RefreshCw size={14} aria-hidden="true" />새 사이클 정보 다시 불러오기
          </button>
        </div>}
      </> : <>
        <form onSubmit={reviewCopy}>
          <fieldset disabled={Boolean(busy || unknown || !cycle)}>
            <div className="cycle-copy-fields">
              <label>새 사이클 이름
                <input className="field" ref={nameInput} value={name} required maxLength={MAX_NAME_LENGTH}
                  onChange={event => { setName(event.target.value); setReview(null); setError(''); }} />
              </label>
              <label>일정 이동 일수
                <input className="field" type="number" value={days} required min={-MAX_CYCLE_COPY_SHIFT_DAYS} max={MAX_CYCLE_COPY_SHIFT_DAYS} step={1}
                  onChange={event => { setDays(event.target.value); setReview(null); setError(''); }} />
              </label>
            </div>
            <p className="cycle-copy-note">시작일, 종료일, 목표일과 업무 마감일을 같은 일수만큼 옮깁니다. 주말과 공휴일도 셉니다.</p>
            <section className="cycle-copy-selection" aria-label="복제할 업무 선택">
              <div className="cycle-copy-selection-heading">
                <strong>복제할 업무 {issues.length}/{members.length}건</strong>
                <div>
                  {members.length > 0 && members.length <= MAX_CYCLE_COPY_ISSUES && <button className="btn btn-ghost" type="button" disabled={issues.length === members.length}
                    onClick={() => updateSelection(new Set(members.map(issue => issue.id)))}>전체 선택</button>}
                  {members.length > 0 && <button className="btn btn-ghost" type="button" disabled={!selected.size}
                    onClick={() => updateSelection(new Set())}>선택 해제</button>}
                </div>
              </div>
              {members.length > MAX_CYCLE_COPY_ISSUES && <p className="cycle-copy-note">한 번에 업무를 최대 {MAX_CYCLE_COPY_ISSUES}건 복제할 수 있습니다.</p>}
              {selected.size > issues.length && <p className="cycle-copy-note" role="status">현재 사이클에 없는 업무 {selected.size - issues.length}건을 제외했습니다.</p>}
              {members.length ? <ul className="cycle-copy-members">
                {members.map(issue => <li key={issue.id}>
                  <label>
                    <input type="checkbox" checked={selected.has(issue.id)} disabled={!selected.has(issue.id) && issues.length >= MAX_CYCLE_COPY_ISSUES}
                      onChange={event => toggleIssue(issue.id, event.target.checked)} />
                    <span><small className="issue-key">{issue.key}</small> {issue.title}</span>
                  </label>
                </li>)}
              </ul> : <p className="cycle-copy-note">연결된 업무가 없습니다.</p>}
            </section>
            <p className="cycle-copy-note">새 업무는 프로젝트의 기본 상태에서 시작합니다. 모듈·릴리스 연결, 댓글, 파일은 복제하지 않습니다.</p>
            <div className="cycle-copy-review-actions">
              <button className="btn" type="submit" disabled={!mayPreview}>{busy === 'preview' ? '미리보기 생성 중…' : '복제 미리보기'}</button>
            </div>
          </fieldset>
        </form>
        {!cycle && <p className="issue-form-error" role="alert">원본 사이클을 찾을 수 없습니다.</p>}
        {error && <p className="issue-form-error" role="alert">{error}</p>}
        {!unknown && (needsLatest || previewChanged || expired) && <div className="cycle-copy-feedback">
          <p role="status">최신 정보를 불러온 뒤 미리보기를 다시 만들어 주세요. 입력과 업무 선택은 유지됩니다.</p>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={loadLatest}>
            <RefreshCw size={14} aria-hidden="true" />최신 사이클 및 업무 확인
          </button>
        </div>}
        {preview && <section className="cycle-copy-preview" aria-labelledby={`${titleId}-preview`}>
          <h3 ref={previewHeading} id={`${titleId}-preview`} tabIndex={-1}>복제 미리보기 결과</h3>
          <strong>{preview.cycle.name} · 계획</strong>
          <dl className="cycle-copy-dates">
            <div><dt>책임자</dt><dd>{person(preview.cycle.ownerId)}</dd></div>
            <div><dt>시작일</dt><dd>{date(preview.cycle.startDate)}</dd></div>
            <div><dt>종료일</dt><dd>{date(preview.cycle.endDate)}</dd></div>
            <div><dt>목표일</dt><dd>{date(preview.cycle.targetDate)}</dd></div>
          </dl>
          {preview.errors.length > 0 && <section className="cycle-copy-feedback" aria-label="복제할 수 없는 조건">
            <strong>복제할 수 없는 조건 {preview.errors.length}건</strong>
            <ul>{preview.errors.map(({ key, message }, index) => <li key={index}>{key ? `${key} · ` : ''}{message}</li>)}</ul>
          </section>}
          <section aria-label="새 업무">
            <h4>새 업무 {preview.rows.length}건</h4>
            <ul className="cycle-copy-preview-list">{preview.rows.map(row => <li key={row.sourceIssueId}>
              <strong><small className="issue-key">{row.key}</small> {row.title}</strong>
              <p>{statusMeta(data, projectId, row.statusId).label} · 담당자 {person(row.assigneeId)}{row.parentKey && ` · 상위 업무 ${row.parentKey}`}</p>
              <p>시작 {date(row.startDate)} · 종료 {date(row.endDate)} · 마감 {date(row.dueDate)}</p>
            </li>)}</ul>
          </section>
          <section aria-label="새 의존성">
            <h4>새 의존성 {preview.dependencies.length}건</h4>
            {preview.dependencies.length > 0 && <ul className="cycle-copy-preview-list">
              {preview.dependencies.map(link => <li key={`${link.predecessorKey}:${link.successorKey}:${link.type}`}>
                <p>{link.predecessorKey} → {link.successorKey} · {dependencyLabel(link)}</p>
                {link.warning && <p className="cycle-copy-warning">{link.warning}</p>}
              </li>)}
            </ul>}
          </section>
          {(preview.omitted.parents > 0 || preview.omitted.dependencies > 0) && <p className="cycle-copy-note">
            선택한 업무 밖으로 이어지는 상위 업무 연결 {preview.omitted.parents}건과 의존성 {preview.omitted.dependencies}건을 제외합니다.
          </p>}
        </section>}
      </>}
    </div>
    <footer>
      <button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={close}>닫기</button>
      {result ? <button className="btn btn-primary" type="button" disabled={Boolean(busy || refreshFailed)} onClick={() => onOpenCycle(result.cycle)}>
        새 사이클 열기<ArrowRight size={15} aria-hidden="true" />
      </button> : !resultConfirmed && <button className="btn btn-primary" type="button" disabled={Boolean(busy || !mayApply)} onClick={apply}>
        {unknown ? <RefreshCw size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {unknown ? '같은 복제 요청 다시 확인' : '사이클 복제 적용'}
      </button>}
    </footer>
  </dialog>;
}
