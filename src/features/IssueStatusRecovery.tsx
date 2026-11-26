'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { FeatureProps } from '../../shared/types';
import { confirmStatusChange, readStatusChangeAttempts, saveStatusChangeAttempt, statusChangeAttemptEvent, statusChangeAttemptSnapshot,
  type SavedStatusChangeAttempt } from './issue-status-attempt';
import { errorMessage } from './schedule-utils';
import './issue-status-dialog.css';

function subscribe(change: () => void) {
  window.addEventListener(statusChangeAttemptEvent, change);
  return () => window.removeEventListener(statusChangeAttemptEvent, change);
}

export function IssueStatusRecovery({ actorId, data, refresh, notify, openIssue }: Pick<FeatureProps, 'actorId' | 'data' | 'refresh' | 'notify' | 'openIssue'>) {
  const generation = data.restoreGeneration ?? '';
  const raw = useSyncExternalStore(subscribe, () => statusChangeAttemptSnapshot(actorId, generation), () => '[]');
  const attempts = readStatusChangeAttempts(raw, actorId, generation);
  const heading = useId();
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ requestId: string; message: string }>();

  useEffect(() => () => active.current?.abort(), []);

  async function recover(attempt: SavedStatusChangeAttempt) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailure(undefined);
    try {
      if (attempt.phase === 'awaiting') {
        await confirmStatusChange(attempt, controller.signal);
        saveStatusChangeAttempt(attempt, 'confirmed');
      }
      if (controller.signal.aborted) return;
      await refresh();
      saveStatusChangeAttempt(attempt, null);
      if (!controller.signal.aborted) notify(`${attempt.issueKey} · 상태 변경 저장을 확인했습니다.`);
    } catch (cause) {
      if (!controller.signal.aborted) setFailure({ requestId: attempt.input.requestId, message: errorMessage(cause) });
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return attempts.length ? <section className="card issue-status-recovery" role="region" aria-labelledby={heading}>
    <h2 id={heading}>업무 상태 변경 결과</h2>
    <ul>{attempts.map(attempt => {
      const current = data.issues.find(issue => issue.id === attempt.issueId);
      return <li key={attempt.input.requestId}>
        <p><strong>{attempt.issueKey}</strong> · {attempt.statusLabel} · {attempt.phase === 'awaiting' ? '저장 결과 확인 필요' : '저장 확인됨 · 화면 갱신 필요'}</p>
        {attempt.input.comment && <details><summary>작성한 인수인계 댓글</summary><blockquote>{attempt.input.comment.body}</blockquote></details>}
        {failure?.requestId === attempt.input.requestId && <p className="issue-form-error" role="alert">{failure.message}</p>}
        <div>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void recover(attempt)}>
            {attempt.phase === 'awaiting' ? '상태 변경 결과 다시 확인' : '최신 업무 불러오기'}
          </button>
          {current && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => openIssue(current.id)}>현재 업무 열기</button>}
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => {
            if (window.confirm('이 탭에 보관한 상태 변경 확인 항목을 지울까요?')) saveStatusChangeAttempt(attempt, null);
          }}>확인 종료</button>
        </div>
      </li>;
    })}</ul>
  </section> : null;
}
