'use client';

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { isCalendarDate } from '../../shared/calendar';
import type {
  Issue, ScheduleTeamBlockerApplyResult, ScheduleTeamBlockerInput, ScheduleTeamBlockerPreview, ScheduleUndoScope,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { isUncertainScheduleResponse, scheduleUndoHeaders } from './schedule-undo';
import { errorMessage } from './schedule-utils';
import './schedule-paste.css';
import './gantt-team-blocker-edit.css';

type Dates = Pick<Issue, 'startDate' | 'endDate'>;
export type TeamBlockerDateDraft = {
  source: Pick<Issue, 'id' | 'version'> & Dates;
  changes: Partial<Dates>;
};

type Props = {
  source: Issue;
  target: Issue;
  sourceDraft?: TeamBlockerDateDraft;
  targetDraft?: TeamBlockerDateDraft;
  actorId: string;
  undoScope: ScheduleUndoScope;
  refresh: () => Promise<void>;
  onDraftChange: (dirty: boolean, pending: boolean, awaitingResult?: boolean) => void;
  onClose: () => void;
  onApplied: (result: ScheduleTeamBlockerApplyResult) => Promise<void>;
};

type Pending = 'preview' | 'apply' | 'recover' | 'refresh' | 'reflect';
type Review = { key: string; result: ScheduleTeamBlockerPreview };
const endpoint = '/schedule/team-blocker-edit';
const fields = [
  { field: 'startDate', label: '시작일' },
  { field: 'endDate', label: '종료일' },
] as const;
const pendingLabel: Record<Pending, string> = {
  preview: '날짜와 차단 관계를 검토하는 중입니다.',
  apply: '검토한 날짜와 차단 관계를 적용하는 중입니다.',
  recover: '이전 적용 요청의 결과를 확인하는 중입니다.',
  refresh: '최신 업무와 날짜를 불러오는 중입니다.',
  reflect: '적용 결과를 화면에 반영하는 중입니다.',
};

function dateChange(issue: Issue, draft: TeamBlockerDateDraft | undefined, include: boolean) {
  const dates: Partial<Dates> = {};
  if (!include || draft?.source.id !== issue.id) return dates;
  for (const { field } of fields) {
    const value = draft.changes[field];
    if (value !== undefined && value !== issue[field]) dates[field] = value;
  }
  return dates;
}

function versionedIssue(issue: Issue, dates: Partial<Dates>): ScheduleTeamBlockerInput['source'] {
  return { id: issue.id, expectedVersion: issue.version, ...(Object.keys(dates).length ? { dates } : {}) };
}

function dateProblem(issue: Issue, changes: Partial<Dates>) {
  if (Object.values(changes).some(value => value !== null && !isCalendarDate(value))) {
    return `${issue.key}의 날짜 형식을 확인해 주세요.`;
  }
  const { startDate, endDate } = { ...issue, ...changes };
  return startDate && endDate && startDate > endDate ? `${issue.key}의 시작일이 종료일보다 늦습니다.` : '';
}

export function GanttTeamBlockerEdit({
  source, target, sourceDraft, targetDraft, actorId, undoScope, refresh, onDraftChange, onClose, onApplied,
}: Props) {
  const titleId = useId();
  const reviewId = useId();
  const [includeSource, setIncludeSource] = useState(true);
  const [includeTarget, setIncludeTarget] = useState(true);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ScheduleTeamBlockerApplyResult | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(() => Date.now());
  const modal = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'review' | 'error' | 'retry' | 'preview' | null>(null);
  const request = useRef<AbortController | null>(null);

  const sourceDates = dateChange(source, sourceDraft, includeSource);
  const targetDates = dateChange(target, targetDraft, includeTarget);
  const input: ScheduleTeamBlockerInput = { source: versionedIssue(source, sourceDates), target: versionedIssue(target, targetDates) };
  const key = JSON.stringify([source.projectId, target.projectId, input]);
  const problem = source.projectId === target.projectId ? '서로 다른 프로젝트의 업무를 선택해 주세요.'
    : dateProblem(source, sourceDates) || dateProblem(target, targetDates);
  const expiresAt = review?.result.expiresAt;
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  const locked = Boolean(pending || retryId || receipt);
  const canPreview = Boolean(actorId && !locked && !problem && !reloadNeeded);
  const applyId = canPreview && review?.key === key && expiry > clock ? review.result.previewId : null;

  const reportDraft = useEffectEvent(onDraftChange);
  useLayoutEffect(() => {
    reportDraft(!receipt, Boolean(pending), Boolean(retryId));
  }, [pending, receipt, retryId]);
  useLayoutEffect(() => {
    const dialog = modal.current;
    dialog?.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      dialog?.close();
      reportDraft(false, false, false);
    };
  }, []);

  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, expiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiry]);

  useLayoutEffect(() => {
    if (pending) {
      heading.current?.focus({ preventScroll: true });
      return;
    }
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === 'review') reviewHeading.current?.focus();
    else if (target === 'error') errorNotice.current?.focus();
    else if (target === 'retry') retryButton.current?.focus();
    else if (target === 'preview') previewButton.current?.focus();
  }, [pending]);

  function begin(kind: Pending) {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    focusAfter.current = null;
    setPending(kind);
    setError('');
    setNotice('');
    onDraftChange(!receipt, true, Boolean(retryId));
    return controller;
  }

  function finish(controller: AbortController) {
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = null;
    setPending(null);
  }

  function close() {
    if (request.current || retryId && !window.confirm('날짜와 차단 관계가 이미 적용됐을 수 있습니다. 적용 결과 확인을 닫을까요?')) return;
    onDraftChange(false, false, false);
    onClose();
  }

  function changeIncluded(row: 'source' | 'target', value: boolean) {
    if (row === 'source') setIncludeSource(value);
    else setIncludeTarget(value);
    setReview(null);
    setError('');
    setNotice('');
  }

  async function preview() {
    if (!canPreview) return;
    const controller = begin('preview');
    if (!controller) return;
    setReview(null);
    try {
      const result = await api<ScheduleTeamBlockerPreview>(`${endpoint}/preview`, {
        method: 'POST', headers: { 'X-Actor-Id': actorId }, body: JSON.stringify(input), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result?.sourceId !== input.source.id || result.targetId !== input.target.id ||
          !Array.isArray(result.changes) || !Array.isArray(result.warnings)) throw new Error('검토할 날짜와 차단 관계를 확인하지 못했습니다.');
      setClock(Date.now());
      setReview({ key, result });
      focusAfter.current = 'review';
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [404, 409, 410].includes(cause.status)) setReloadNeeded(true);
      setError(`${errorMessage(cause)} 날짜 입력을 유지했습니다.`);
      focusAfter.current = 'error';
    } finally { finish(controller); }
  }

  async function reload() {
    const controller = begin('refresh');
    if (!controller) return;
    setReview(null);
    try {
      await refresh();
      if (controller.signal.aborted) return;
      setReloadNeeded(false);
      setNotice('입력한 날짜를 유지했습니다. 현재 저장값을 비교한 뒤 미리보기를 만들어 주세요.');
      focusAfter.current = 'preview';
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(`${errorMessage(cause)} 날짜 입력을 유지했습니다.`);
      focusAfter.current = 'error';
    } finally { finish(controller); }
  }

  async function reflect(result: ScheduleTeamBlockerApplyResult, controller: AbortController) {
    try { await onApplied(result); }
    catch (cause) {
      if (controller.signal.aborted) return;
      setError(`날짜와 차단 관계를 적용했습니다. ${errorMessage(cause)} 화면에 다시 반영할 수 있습니다.`);
      focusAfter.current = 'error';
    }
  }

  async function apply(id: string, recovering: boolean) {
    if (review?.result.previewId !== id || (recovering ? id !== retryId : id !== applyId || Date.now() >= expiry)) {
      setClock(Date.now());
      return;
    }
    const controller = begin(recovering ? 'recover' : 'apply');
    if (!controller) return;
    try {
      const result = await api<ScheduleTeamBlockerApplyResult>(`${endpoint}/apply`, {
        method: 'POST', headers: scheduleUndoHeaders(undoScope, actorId),
        body: JSON.stringify({ previewId: id }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!result?.undoId || !Array.isArray(result.updated) || !Array.isArray(result.warnings) ||
          result.relation?.sourceIssueId !== review.result.sourceId || result.relation.targetIssueId !== review.result.targetId ||
          result.relation.type !== 'blocks') throw new Error('적용 결과를 확인하지 못했습니다.');
      setReceipt(result);
      setRetryId(null);
      onDraftChange(false, true, false);
      await reflect(result, controller);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const errorStatus = cause instanceof ApiError ? cause.status : undefined;
      const uncertain = isUncertainScheduleResponse(cause) || recovering && (errorStatus === 401 || errorStatus === 403);
      setRetryId(uncertain ? id : null);
      if (uncertain) {
        setError('적용 여부를 확인하지 못했습니다. 같은 요청으로 적용 결과를 다시 확인해 주세요.');
        focusAfter.current = 'retry';
      } else {
        setReview(null);
        if (errorStatus === 404 || errorStatus === 409 || errorStatus === 410) setReloadNeeded(true);
        setError(`${errorMessage(cause)} 날짜 입력을 유지했습니다.`);
        focusAfter.current = 'error';
      }
    } finally { finish(controller); }
  }

  async function retryReflection() {
    if (!receipt) return;
    const controller = begin('reflect');
    if (!controller) return;
    try { await reflect(receipt, controller); }
    finally { finish(controller); }
  }

  return <dialog className="schedule-paste-dialog gantt-team-blocker-edit" ref={modal} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId} ref={heading} tabIndex={-1}><Link2 size={20} aria-hidden="true" />프로젝트 간 날짜와 차단 관계 검토</h2>
      <button type="button" className="btn btn-ghost" aria-label="닫기" disabled={Boolean(pending)} onClick={close}>
        <X size={20} aria-hidden="true" />
      </button>
    </header>
    <div className="schedule-paste-input">
      <fieldset disabled={locked}>
        <div className="gantt-team-blocker-edit-rows">
          <PairDates label="차단하는 업무" issue={source} draft={sourceDraft} included={includeSource}
            onInclude={value => changeIncluded('source', value)} />
          <PairDates label="차단되는 업무" issue={target} draft={targetDraft} included={includeTarget}
            onInclude={value => changeIncluded('target', value)} />
        </div>
        {problem && <p className="schedule-paste-error" role="alert">{problem}</p>}
        <div className="gantt-team-blocker-edit-actions">
          <button type="button" className="btn btn-primary" ref={previewButton} disabled={!canPreview} onClick={() => void preview()}>
            날짜와 차단 관계 미리보기
          </button>
          <button type="button" className="btn" onClick={() => void reload()}>
            <RefreshCw size={15} aria-hidden="true" />최신 업무 다시 불러오기
          </button>
        </div>
      </fieldset>
    </div>
    <div className="schedule-paste-results">
      {pending && <p className="schedule-paste-pending" role="status">
        <Loader2 size={16} className="spin" aria-hidden="true" />{pendingLabel[pending]}
      </p>}
      {error && <p ref={errorNotice} tabIndex={-1} className="schedule-paste-error" role="alert">{error}</p>}
      {notice && <p className="schedule-paste-success" role="status">{notice}</p>}
      {review && <section aria-labelledby={reviewId}>
        <h3 id={reviewId} ref={reviewHeading} tabIndex={-1}>날짜와 차단 관계 미리보기</h3>
        <p>{source.key} → {target.key} 차단 관계 추가</p>
        {!pending && !retryId && !receipt && !applyId &&
          <p className="schedule-paste-stale">현재 업무 기준으로 다시 미리보기를 만들어 주세요.</p>}
        {review.result.changes.length > 0 && <ul className="gantt-team-blocker-edit-preview">
          {review.result.changes.map(change => <li key={change.id}>
            <strong>{change.key} · {change.title}</strong>
            <dl>
              <DateComparison label="시작일" before={change.fromStart} after={change.toStart} />
              <DateComparison label="종료일" before={change.fromEnd} after={change.toEnd} />
            </dl>
          </li>)}
        </ul>}
        {review.result.warnings.length > 0 && <section className="schedule-paste-warnings" aria-label="일정 검토 경고">
          <h4>일정 검토 경고</h4>
          <ul>{review.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </section>}
      </section>}
    </div>
    <footer>
      <span>{receipt ? '날짜와 차단 관계를 저장했습니다.' : retryId
        ? '같은 적용 요청의 결과를 다시 확인할 수 있습니다.' : '검토한 날짜와 차단 관계를 한 번에 적용합니다.'}</span>
      {receipt ? <button type="button" className="btn btn-primary" disabled={Boolean(pending)} onClick={() => void retryReflection()}>
        적용 결과 화면에 반영
      </button> : retryId ? <button type="button" className="btn btn-primary" ref={retryButton} disabled={Boolean(pending)}
        onClick={() => void apply(retryId, true)}>적용 결과 다시 확인</button>
        : <button type="button" className="btn btn-primary" disabled={!applyId}
          onClick={() => { if (applyId) void apply(applyId, false); }}>
          <Check size={16} aria-hidden="true" />날짜와 차단 관계 적용
        </button>}
    </footer>
  </dialog>;
}

function PairDates({ label, issue, draft, included, onInclude }: {
  label: string; issue: Issue; draft?: TeamBlockerDateDraft; included: boolean; onInclude: (value: boolean) => void;
}) {
  const headingId = useId();
  const currentDraft = draft?.source.id === issue.id ? draft : undefined;
  const hasInput = currentDraft && fields.some(({ field }) => currentDraft.changes[field] !== undefined);
  const showPeerChange = included && hasInput && currentDraft.source.version !== issue.version &&
    fields.some(({ field }) => currentDraft.changes[field] !== undefined && currentDraft.changes[field] !== issue[field] &&
      currentDraft.source[field] !== issue[field]);

  return <section className="gantt-team-blocker-edit-row" aria-labelledby={headingId}>
    <h3 id={headingId}>{label}</h3>
    <p><strong>{issue.key}</strong> {issue.title}</p>
    <dl>{fields.map(({ field, label: fieldLabel }) => {
      const next = included ? currentDraft?.changes[field] : undefined;
      return <DateComparison key={field} label={fieldLabel} before={issue[field]} after={next} />;
    })}</dl>
    {showPeerChange && <p className="gantt-team-blocker-peer-date">작성 중 저장값이 바뀌었습니다. 현재 저장값과 입력한 날짜를 확인해 주세요.</p>}
    {hasInput && <label className="gantt-team-blocker-include">
      <input type="checkbox" checked={included} onChange={event => onInclude(event.currentTarget.checked)} />
      {issue.key} 날짜 입력 포함
    </label>}
  </section>;
}

function DateComparison({ label, before, after }: { label: string; before: string | null; after?: string | null }) {
  return <div><dt>{label}</dt><dd>
    {before ?? '미정'}{after !== undefined && after !== before && <> → <strong>{after ?? '미정'}</strong></>}
  </dd></div>;
}
