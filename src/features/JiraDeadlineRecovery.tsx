'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Issue, JiraDeadlineRecoveryReview } from '../../shared/types';
import { api } from '../lib/api';
import { isUncertainScheduleResponse } from './schedule-undo';
import { errorMessage } from './schedule-utils';
import './jira-deadline-recovery.css';

type Feedback =
  | { kind: 'notice' | 'review'; message: string }
  | { kind: 'verify'; message: string; attempted: JiraDeadlineRecoveryReview }
  | { kind: 'refresh'; message: string; version: number };

const currentMessage = '현재 마감일이 Jira 원본과 같습니다.';
const statusMessages: Record<Extract<JiraDeadlineRecoveryReview['status'], 'local-change' | 'history-unverified'>, string> = {
  'local-change': '이관 이후 팀에서 마감일을 수정했습니다. 현재 값을 유지합니다.',
  'history-unverified': '마감일 변경 이력을 확인할 수 없어 현재 값을 유지합니다.',
};

function reviewMessage(review: JiraDeadlineRecoveryReview | null) {
  if (!review) return '현재 비교할 수 있는 Jira 원본 마감일이 없습니다.';
  if (review.status === 'ready') return null;
  if (review.status === 'current-value') return review.currentDueDate === review.sourceDueDate
    ? currentMessage : '현재 마감일이 지정되어 있어 저장한 값을 유지합니다.';
  return statusMessages[review.status];
}

function timedSignal(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
}

export function JiraDeadlineRecovery({ issueId, issueVersion, actorId, blockedReason, onPendingChange, onObserved }: {
  issueId: string;
  issueVersion: number;
  actorId: string;
  blockedReason: string | null;
  onPendingChange: (pending: boolean) => void;
  onObserved: (version: number) => Promise<void>;
}) {
  const id = useId();
  const [review, setReview] = useState<JiraDeadlineRecoveryReview | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef<'open' | 'message' | null>(null);
  const path = `/issues/${encodeURIComponent(issueId)}/jira-deadline-recovery`;
  const confirming = Boolean(review && confirmation === review.revision && review.status === 'ready');

  const load = useCallback(async (signal: AbortSignal) => {
    const response = await api<{ review: JiraDeadlineRecoveryReview | null }>(path, {
      cache: 'no-store', signal: timedSignal(signal), headers: { 'X-Actor-Id': actorId },
    });
    return response.review;
  }, [actorId, path]);

  useEffect(() => {
    if (action.current) return;
    const controller = new AbortController();
    read.current = controller;
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) setReview(value);
    }).catch(() => {
      if (!controller.signal.aborted) setFeedback(previous => previous ?? {
        kind: 'review', message: 'Jira 원본 마감일을 불러오지 못했습니다.',
      });
    });
    return () => controller.abort();
  }, [issueVersion, load]);
  useEffect(() => () => action.current?.abort(), []);
  useLayoutEffect(() => {
    if (busy) return;
    if (returnFocus.current) {
      const target = returnFocus.current === 'open' ? openButton.current : message.current;
      returnFocus.current = null;
      target?.focus({ preventScroll: true });
    } else if (confirming) applyButton.current?.focus({ preventScroll: true });
  }, [busy, confirming]);

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (action.current) return;
    read.current?.abort();
    const controller = new AbortController();
    action.current = controller;
    onPendingChange(true);
    setBusy(true);
    try { await task(controller.signal); }
    finally {
      action.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        onPendingChange(false);
      }
    }
  }

  async function reflect(version: number, text: string, signal: AbortSignal) {
    try {
      await onObserved(version);
      if (!signal.aborted) setFeedback({ kind: 'notice', message: text });
    } catch {
      if (!signal.aborted) setFeedback({ kind: 'refresh', version, message: `${text} 티켓 표시를 다시 불러와 주세요.` });
    }
  }

  async function verify(attempted: JiraDeadlineRecoveryReview, signal: AbortSignal) {
    try {
      const current = await load(signal);
      if (signal.aborted) return;
      setReview(current);
      if (current?.sourceImportId === attempted.sourceImportId && current.sourceRecordId === attempted.sourceRecordId &&
          current.sourceDueDate === attempted.sourceDueDate && current.currentDueDate === attempted.sourceDueDate) {
        await reflect(current.issueVersion, currentMessage, signal);
      } else {
        setFeedback({ kind: 'notice', message: reviewMessage(current) ??
          '현재 저장한 마감일을 확인했습니다. 날짜를 다시 검토한 뒤 복구할 수 있습니다.' });
      }
    } catch {
      if (!signal.aborted) setFeedback({ kind: 'verify', attempted, message: '복구 결과를 아직 확인하지 못했습니다.' });
    }
  }

  async function apply() {
    if (!review || !confirming || blockedReason) return;
    const attempted = review;
    await run(async signal => {
      setConfirmation(null);
      setFeedback(null);
      returnFocus.current = 'message';
      try {
        const { issue } = await api<{ issue: Issue }>(path, {
          method: 'POST', body: JSON.stringify({ revision: attempted.revision }),
          signal: timedSignal(signal), headers: { 'X-Actor-Id': actorId },
        });
        if (signal.aborted) return;
        if (issue?.id !== issueId || issue.dueDate !== attempted.sourceDueDate || !Number.isSafeInteger(issue.version) ||
            issue.version <= attempted.issueVersion) throw new Error('복구한 마감일을 확인할 수 없습니다.');
        setReview({ ...attempted, currentDueDate: issue.dueDate, issueVersion: issue.version, status: 'current-value' });
        await reflect(issue.version, 'Jira 원본 마감일을 복구했습니다.', signal);
      } catch (cause) {
        if (signal.aborted) return;
        if (isUncertainScheduleResponse(cause)) await verify(attempted, signal);
        else setFeedback({ kind: 'review', message: errorMessage(cause) });
      }
    });
  }

  function cancel() {
    returnFocus.current = 'open';
    setConfirmation(null);
  }

  function reread() {
    return run(async signal => {
      returnFocus.current = 'message';
      try {
        const current = await load(signal);
        if (signal.aborted) return;
        setReview(current);
        setFeedback(current ? { kind: 'notice', message: reviewMessage(current) ?? '최신 날짜를 확인했습니다.' } : null);
      } catch (cause) {
        if (!signal.aborted) setFeedback({ kind: 'review', message: errorMessage(cause) });
      }
    });
  }

  if (!review && !feedback) return null;
  const canReview = review?.status === 'ready' && feedback?.kind !== 'verify' && feedback?.kind !== 'review';
  const status = feedback?.message ?? (review ? reviewMessage(review) : null);
  return <section className="jira-deadline-recovery" aria-labelledby={`${id}-heading`} aria-busy={busy}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !confirming || busy) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }}>
    <h3 id={`${id}-heading`}>Jira 마감일 복구</h3>
    {review && <>
      <p>원래 업무 키 <strong>{review.sourceKey}</strong></p>
      <dl>
        <dt>현재 마감일</dt><dd>{review.currentDueDate ? <time dateTime={review.currentDueDate}>{review.currentDueDate}</time> : '미지정'}</dd>
        <dt>Jira 원본 마감일</dt><dd><time dateTime={review.sourceDueDate}>{review.sourceDueDate}</time></dd>
      </dl>
    </>}
    {status && <p ref={message} className={feedback?.kind === 'review' || feedback?.kind === 'verify' ? 'source-origin-error' : undefined}
      tabIndex={-1} role={feedback?.kind === 'review' || feedback?.kind === 'verify' ? 'alert' : 'status'}>{status}</p>}
    {canReview && blockedReason && <p id={`${id}-blocked`}>{blockedReason}</p>}
    {busy && <p role="status">마감일을 확인하고 있습니다.</p>}
    {canReview && !confirming && <button type="button" className="btn" ref={openButton} disabled={busy || Boolean(blockedReason)}
      aria-describedby={blockedReason ? `${id}-blocked` : undefined} onClick={() => setConfirmation(review.revision)}>Jira 마감일 복구</button>}
    {canReview && confirming && <div className="jira-deadline-confirm" role="group" aria-label="마감일 복구 확인">
      <p>현재 티켓의 마감일을 {review.sourceDueDate}로 저장할까요?</p>
      <div>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancel}>취소</button>
        <button type="button" className="btn btn-primary" ref={applyButton} disabled={busy || Boolean(blockedReason)}
          onClick={() => void apply()}>복구 적용</button>
      </div>
    </div>}
    {feedback?.kind === 'review' && <button type="button" className="btn" disabled={busy} onClick={() => void reread()}>마감일 다시 확인</button>}
    {feedback?.kind === 'verify' && <button type="button" className="btn" disabled={busy} onClick={() => void run(signal => {
      returnFocus.current = 'message';
      return verify(feedback.attempted, signal);
    })}>복구 결과 다시 확인</button>}
    {feedback?.kind === 'refresh' && <button type="button" className="btn" disabled={busy} onClick={() => void run(signal => {
      returnFocus.current = 'message';
      return reflect(feedback.version, currentMessage, signal);
    })}>업무 다시 불러오기</button>}
  </section>;
}
