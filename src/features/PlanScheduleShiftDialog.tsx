'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, CalendarDays, Check, MoveHorizontal, RefreshCw, X } from 'lucide-react';
import type {
  FeatureProps,
  PlanningItem,
  PlanScheduleShiftPreview,
  PlanScheduleShiftResult,
  ScheduleUndoScope,
} from '../../shared/types';
import { PLANNING_META } from '../../shared/planning-helpers';
import { api, ApiError } from '../lib/api';
import { scheduleUndoHeaders } from './schedule-undo';
import './plan-schedule-shift.css';

export interface PlanScheduleShiftDialogProps {
  plan: PlanningItem;
  actorId: string;
  undoScope: ScheduleUndoScope;
  notify: FeatureProps['notify'];
  refresh: FeatureProps['refresh'];
  onClose: () => void;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
  onApplied: (result: PlanScheduleShiftResult) => Promise<void>;
}

type Inputs = { days: string; workingDays: boolean; includeLinked: boolean };
type Review = { inputs: Inputs; result: PlanScheduleShiftPreview };
type Pending = 'preview' | 'apply' | 'recover' | 'reload' | 'reflect';
type Dates = { startDate: string | null; endDate: string | null; targetDate: string | null };
const DRAFT_ID = 'plan-schedule-shift';
const PAGE_SIZE = 50;
const DEFAULT_INPUTS: Inputs = { days: '5', workingDays: false, includeLinked: true };
const sameInputs = (left: Inputs, right: Inputs) =>
  left.days === right.days &&
  left.workingDays === right.workingDays &&
  left.includeLinked === right.includeLinked;
const dateLabel = (date: string | null) => date ?? '미정';
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '계획 일정 이동 요청을 처리하지 못했습니다.';
const isDateChange = (from: Dates, to: Dates) =>
  from.startDate !== to.startDate || from.endDate !== to.endDate || from.targetDate !== to.targetDate;

export function PlanScheduleShiftDialog(props: PlanScheduleShiftDialogProps) {
  return <ShiftDialog key={`${props.plan.id}:${props.actorId}`} {...props} />;
}

function ShiftDialog({
  plan,
  actorId,
  undoScope,
  notify,
  refresh,
  onClose,
  onDraftChange,
  onApplied,
}: PlanScheduleShiftDialogProps) {
  const titleId = useId();
  const [inputs, setInputs] = useState<Inputs>({ ...DEFAULT_INPUTS });
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<{ previewId: string; inputs: Inputs } | null>(null);
  const [applied, setApplied] = useState<PlanScheduleShiftResult | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [issuePage, setIssuePage] = useState(0);
  const [skippedPage, setSkippedPage] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const daysInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const dirty = !applied && (!sameInputs(inputs, DEFAULT_INPUTS) || Boolean(review) || Boolean(retry));
  const numberOfDays = Number(inputs.days);
  const validDays =
    /^-?\d+$/.test(inputs.days) &&
    Number.isInteger(numberOfDays) &&
    numberOfDays !== 0 &&
    Math.abs(numberOfDays) <= 3650;
  const result = review?.result;
  const expiry = result?.expiresAt ? Date.parse(result.expiresAt) : NaN;
  const expired = Boolean(result?.previewId && (!Number.isFinite(expiry) || expiry <= clock));
  const changedInputs = Boolean(review && !sameInputs(inputs, review.inputs));
  const changedPlan = Boolean(result && result.plan.version !== plan.version);
  const hasChanges = Boolean(
    result && (isDateChange(result.plan.from, result.plan.to) || result.changes.length),
  );
  const mayApply = Boolean(
    result?.previewId &&
      approved &&
      !changedInputs &&
      !changedPlan &&
      !expired &&
      !result.blocking.length &&
      hasChanges &&
      !applied,
  );

  useEffect(() => {
    dirtyRef.current = dirty;
    onDraftChange(DRAFT_ID, dirty, Boolean(pending));
  }, [dirty, pending, onDraftChange]);
  useEffect(() => () => onDraftChange(DRAFT_ID, false, false), [onDraftChange]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    daysInput.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const close = useCallback(() => {
    if (busyRef.current) {
      notify('계획 일정 요청 결과를 확인한 뒤 닫아 주세요.', 'error');
      return;
    }
    const confirmation = retry
      ? '적용 결과가 확인되지 않았습니다. 같은 요청의 결과를 다시 확인할 정보를 버리고 닫을까요?'
      : '입력한 계획 이동 조건과 미리보기를 버리고 닫을까요?';
    if (dirtyRef.current && !window.confirm(confirmation)) return;
    dirtyRef.current = false;
    onDraftChange(DRAFT_ID, false, false);
    onClose();
  }, [notify, onClose, onDraftChange, retry]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const elements = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ].filter((element) => !element.matches(':disabled') && element.getClientRects().length > 0);
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.current.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => document.removeEventListener('keydown', keyboard, true);
  }, [close]);

  function update(next: Inputs) {
    if (busyRef.current || applied || retry) return;
    setInputs(next);
    setApproved(false);
    setRetry(null);
    setError('');
    dirtyRef.current = !sameInputs(next, DEFAULT_INPUTS) || Boolean(review);
    onDraftChange(DRAFT_ID, dirtyRef.current, false);
  }

  function begin(kind: Pending) {
    if (busyRef.current) return null;
    const controller = new AbortController();
    request.current = controller;
    busyRef.current = true;
    setPending(kind);
    setError('');
    onDraftChange(DRAFT_ID, dirtyRef.current, true);
    return controller;
  }

  function finish(controller: AbortController) {
    busyRef.current = false;
    if (mounted.current && !controller.signal.aborted) {
      setPending(null);
      onDraftChange(DRAFT_ID, dirtyRef.current, false);
    }
  }

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!validDays || applied || retry) return;
    const controller = begin('preview');
    if (!controller) return;
    setApproved(false);
    setRetry(null);
    const submitted = { ...inputs };
    try {
      const proposal = await api<PlanScheduleShiftPreview>(
        `/planning-items/${encodeURIComponent(plan.id)}/schedule-preview`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'X-Actor-Id': actorId },
          body: JSON.stringify({
            expectedPlanVersion: plan.version,
            days: numberOfDays,
            workingDays: inputs.workingDays,
            includeLinked: inputs.includeLinked,
          }),
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setReview({ inputs: submitted, result: proposal });
      setApproved(Boolean(proposal.previewId && !proposal.blocking.length));
      setIssuePage(0);
      setSkippedPage(0);
      setClock(Date.now());
      dirtyRef.current = true;
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          `${messageOf(cause)} 입력과 이전 미리보기를 유지했습니다. 최신 정보를 확인한 뒤 새 미리보기를 만들어 주세요.`,
        );
    } finally {
      finish(controller);
    }
  }

  async function reload() {
    const controller = begin('reload');
    if (!controller) return;
    setApproved(false);
    try {
      await refresh();
    } catch (cause) {
      if (mounted.current) setError(`${messageOf(cause)} 입력과 이전 미리보기는 유지됩니다.`);
    } finally {
      finish(controller);
    }
  }

  async function reflect(resultToReflect: PlanScheduleShiftResult) {
    try {
      await onApplied(resultToReflect);
    } catch (cause) {
      if (mounted.current)
        setError(`계획 일정은 적용되었습니다. ${messageOf(cause)} 화면 반영을 다시 시도하세요.`);
    }
  }

  async function apply(previewId: string, submitted: Inputs, recovering: boolean) {
    if (applied || !sameInputs(inputs, submitted)) return;
    if (!recovering && (!mayApply || !Number.isFinite(expiry) || expiry <= Date.now())) {
      setClock(Date.now());
      return;
    }
    const controller = begin(recovering ? 'recover' : 'apply');
    if (!controller) return;
    setApproved(false);
    try {
      const response = await api<PlanScheduleShiftResult>(
        `/planning-items/${encodeURIComponent(plan.id)}/schedule-apply`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: scheduleUndoHeaders(undoScope, actorId),
          body: JSON.stringify({ previewId }),
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (
        !response ||
        response.plan?.id !== plan.id ||
        typeof response.undoId !== 'string' ||
        !Array.isArray(response.updated) ||
        !Array.isArray(response.warnings)
      )
        throw new Error('적용 응답 형식을 확인하지 못했습니다.');
      setRetry(null);
      setApplied(response);
      dirtyRef.current = false;
      onDraftChange(DRAFT_ID, false, true);
      await reflect(response);
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      const ambiguous = !(cause instanceof ApiError) || cause.status >= 500 || cause.status === 408;
      if (ambiguous) {
        setRetry({ previewId, inputs: { ...submitted } });
        setError(
          `${messageOf(cause)} 적용 여부를 확인하지 못했습니다. 같은 요청의 적용 결과를 다시 확인해 주세요.`,
        );
      } else {
        setRetry(null);
        setError(
          `${messageOf(cause)} 입력과 미리보기는 유지됩니다. 최신 정보 확인 후 새 미리보기를 만들어 주세요.`,
        );
      }
    } finally {
      finish(controller);
    }
  }

  async function retryReflection() {
    if (!applied) return;
    const controller = begin('reflect');
    if (!controller) return;
    try {
      await reflect(applied);
    } finally {
      finish(controller);
    }
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="plan-shift-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="plan-shift-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="plan-shift-header">
          <div>
            <h2 id={titleId}>
              <MoveHorizontal size={21} aria-hidden="true" />
              계획 일정 함께 이동
            </h2>
            <p>
              {PLANNING_META[plan.kind].label} · {plan.name} · 버전 {plan.version}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="계획 이동 닫기" onClick={close}>
            <X size={20} />
          </button>
        </header>
        <div className="plan-shift-content">
          <form onSubmit={preview} aria-label="계획 일정 이동 조건">
            <fieldset disabled={Boolean(pending) || Boolean(applied) || Boolean(retry)}>
              <label className="plan-shift-days-label">
                이동 일수
                <input
                  ref={daysInput}
                  className="field"
                  type="number"
                  aria-label="계획 이동 일수"
                  value={inputs.days}
                  onChange={(event) => update({ ...inputs, days: event.target.value })}
                  min={-3650}
                  max={3650}
                  step={1}
                  required
                />
              </label>
              <p className="plan-shift-help">
                양수는 뒤로, 음수는 앞으로 이동합니다. 0을 제외한 최대 3,650일을 입력하세요.
              </p>
              <label className="plan-shift-checkbox">
                <input
                  type="checkbox"
                  aria-label="계획 이동에 근무일 사용"
                  checked={inputs.workingDays}
                  onChange={(event) => update({ ...inputs, workingDays: event.target.checked })}
                />
                프로젝트 업무 달력의 근무일로 이동
              </label>
              <label className="plan-shift-checkbox">
                <input
                  type="checkbox"
                  aria-label="연결된 업무도 함께 이동"
                  checked={inputs.includeLinked}
                  onChange={(event) => update({ ...inputs, includeLinked: event.target.checked })}
                />
                연결된 업무도 함께 이동
              </label>
              <div className="plan-shift-condition-actions">
                <span>
                  {inputs.workingDays ? '근무일 기준' : '달력일 기준'} ·{' '}
                  {inputs.includeLinked ? '연결 업무 포함' : '계획 기간만'}
                </span>
                <button type="submit" className="btn btn-primary" disabled={!validDays}>
                  <CalendarDays size={15} aria-hidden="true" />
                  {pending === 'preview' ? '미리보기 계산 중…' : '계획 이동 미리보기'}
                </button>
              </div>
            </fieldset>
          </form>

          {error && (
            <p className="plan-shift-error" role="alert">
              {error}
            </p>
          )}
          {retry && !applied && (
            <div className="plan-shift-recovery">
              <p>
                같은 미리보기의 처리 결과를 확인합니다. 중복 이동하지 않습니다. 적용 결과를 확인할 때까지
                이동 조건과 새 미리보기는 잠시 잠겨 있습니다.
              </p>
              <button
                type="button"
                className="btn"
                disabled={Boolean(pending)}
                onClick={() => void apply(retry.previewId, retry.inputs, true)}
              >
                계획 이동 적용 결과 다시 확인
              </button>
            </div>
          )}
          {applied && (
            <div className="plan-shift-success" role="status">
              <strong>계획 일정이 적용되었습니다.</strong>
              <p>계획 기간과 업무 {applied.updated.length}개의 변경 결과를 받았습니다.</p>
              {error && (
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(pending)}
                  onClick={() => void retryReflection()}
                >
                  계획 이동 화면 반영 다시 시도
                </button>
              )}
              <Messages title="적용 후 일정 경고" messages={applied.warnings} tone="warning" />
            </div>
          )}

          {result && (
            <section className="plan-shift-preview" aria-label="계획 이동 미리보기 결과">
              <header>
                <h3>{result.plan.name} 이동안</h3>
                <span>
                  {review.inputs.workingDays ? '근무일' : '달력일'}{' '}
                  {Number(review.inputs.days) > 0 ? '+' : ''}
                  {Number(review.inputs.days)}일 ·{' '}
                  {review.inputs.includeLinked ? '연결 업무 포함' : '계획 기간만'}
                </span>
              </header>
              {!applied && (changedInputs || !approved || changedPlan || expired) && (
                <p className="plan-shift-warning" role="status">
                  {changedInputs
                    ? '입력 조건이 바뀌어 이전 미리보기를 표시합니다.'
                    : changedPlan
                      ? '계획 버전이 바뀌어 이전 미리보기를 표시합니다.'
                      : expired
                        ? '미리보기 유효 시간이 지났습니다.'
                        : '현재 적용할 수 없는 미리보기입니다.'}{' '}
                  새 미리보기로 변경을 확인하세요.
                </p>
              )}
              <div className="plan-shift-table-scroll">
                <table aria-label="계획 기간 변경 비교">
                  <thead>
                    <tr>
                      <th>날짜</th>
                      <th>현재</th>
                      <th />
                      <th>이동 후</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ['startDate', '시작일'],
                        ['endDate', '종료일'],
                        ['targetDate', '목표일'],
                      ] as const
                    ).map(([field, label]) => (
                      <tr key={field}>
                        <th scope="row">{label}</th>
                        <td>{dateLabel(result.plan.from[field])}</td>
                        <td>
                          <ArrowRight size={14} aria-hidden="true" />
                        </td>
                        <td
                          className={
                            result.plan.from[field] !== result.plan.to[field] ? 'is-changed' : ''
                          }
                        >
                          {dateLabel(result.plan.to[field])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.expiresAt && (
                <p className="plan-shift-help">
                  유효 시간: {new Date(result.expiresAt).toLocaleString('ko-KR')}까지 · 계획 버전{' '}
                  {result.plan.version} 기준
                </p>
              )}
              <Messages title="이동을 막는 조건" messages={result.blocking} tone="error" />
              <Messages title="일정·의존성 경고" messages={result.warnings} tone="warning" />
              {!hasChanges && !result.blocking.length && (
                <p className="plan-shift-help">변경할 날짜가 없습니다. 미정 날짜는 그대로 유지됩니다.</p>
              )}

              <section className="plan-shift-issues" aria-label="함께 이동할 업무">
                <h4>함께 이동할 업무 {result.changes.length}개</h4>
                {result.changes.length ? (
                  <>
                    <div className="plan-shift-table-scroll">
                      <table aria-label="계획 이동 업무 일정 비교">
                        <thead>
                          <tr>
                            <th>업무</th>
                            <th>현재 일정</th>
                            <th>이동 후 일정</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.changes
                            .slice(issuePage * PAGE_SIZE, (issuePage + 1) * PAGE_SIZE)
                            .map((change) => (
                              <tr key={change.id}>
                                <th scope="row">
                                  <small>{change.key}</small>
                                  <strong>{change.title}</strong>
                                </th>
                                <td>
                                  {dateLabel(change.fromStart)}
                                  <br />
                                  {dateLabel(change.fromEnd)}
                                </td>
                                <td className="is-changed">
                                  {dateLabel(change.toStart)}
                                  <br />
                                  {dateLabel(change.toEnd)}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <Pagination
                      label="계획 이동 업무"
                      page={issuePage}
                      total={result.changes.length}
                      size={PAGE_SIZE}
                      onChange={setIssuePage}
                    />
                  </>
                ) : (
                  <p className="plan-shift-help">이동할 연결 업무가 없습니다.</p>
                )}
              </section>
              {result.skipped.length > 0 && (
                <section className="plan-shift-skipped" aria-label="이동에서 제외된 업무">
                  <h4>이동에서 제외된 업무 {result.skipped.length}개</h4>
                  <ul>
                    {result.skipped
                      .slice(skippedPage * PAGE_SIZE, (skippedPage + 1) * PAGE_SIZE)
                      .map((issue) => (
                        <li key={issue.id}>
                          <span>
                            <small>{issue.key}</small>
                            <strong>{issue.title}</strong>
                          </span>
                          <span>{issue.reason === 'terminal' ? '완료·취소 상태' : '일정 미정'}</span>
                        </li>
                      ))}
                  </ul>
                  <Pagination
                    label="계획 이동 제외 업무"
                    page={skippedPage}
                    total={result.skipped.length}
                    size={PAGE_SIZE}
                    onChange={setSkippedPage}
                  />
                </section>
              )}
            </section>
          )}
        </div>
        <footer className="plan-shift-footer">
          <div>
            <span>적용 전에는 날짜가 바뀌지 않습니다.</span>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="계획 이동 최신 정보"
              disabled={Boolean(pending) || Boolean(applied)}
              onClick={() => void reload()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              최신 정보
            </button>
          </div>
          <div>
            <button type="button" className="btn btn-ghost" onClick={close}>
              닫기
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(pending) || !mayApply}
              onClick={() => {
                if (review?.result.previewId) void apply(review.result.previewId, review.inputs, false);
              }}
            >
              <Check size={15} aria-hidden="true" />
              {pending === 'apply' || pending === 'recover' ? '적용 결과 확인 중…' : '계획 이동 적용'}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function Pagination({
  label,
  page,
  total,
  size,
  onChange,
}: {
  label: string;
  page: number;
  total: number;
  size: number;
  onChange: (page: number) => void;
}) {
  if (total <= size) return null;
  return (
    <nav className="plan-shift-pagination" aria-label={`${label} 페이지`}>
      <span>
        {page * size + 1}–{Math.min((page + 1) * size, total)} / {total}
      </span>
      <button
        className="btn btn-ghost"
        type="button"
        aria-label={`${label} 이전 페이지`}
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        이전
      </button>
      <button
        className="btn btn-ghost"
        type="button"
        aria-label={`${label} 다음 페이지`}
        disabled={(page + 1) * size >= total}
        onClick={() => onChange(page + 1)}
      >
        다음
      </button>
    </nav>
  );
}

function Messages({
  title,
  messages,
  tone,
}: {
  title: string;
  messages: string[];
  tone: 'warning' | 'error';
}) {
  const [page, setPage] = useState(0);
  const size = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(messages.length / size) - 1));
  if (!messages.length) return null;
  return (
    <section className={`plan-shift-messages is-${tone}`} aria-label={title}>
      <strong>
        {title} {messages.length}개
      </strong>
      <ul>
        {messages.slice(currentPage * size, (currentPage + 1) * size).map((message, index) => (
          <li key={`${index}:${message}`}>{message}</li>
        ))}
      </ul>
      <Pagination
        label={title}
        page={currentPage}
        total={messages.length}
        size={size}
        onChange={setPage}
      />
    </section>
  );
}
