'use client';

import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowRight, Save, X } from 'lucide-react';
import type { Issue, SchedulePreview } from '../../shared/types';

type Props = {
  preview: SchedulePreview;
  issues: readonly Issue[];
  issueId: string;
  busy: boolean;
  staleMessage?: string;
  onClose: () => void;
  onReviewAgain: () => void;
  onSave: () => void;
};

export function IssueScheduleSaveReview({ preview, issues, issueId, busy, staleMessage, onClose, onReviewAgain, onSave }: Props) {
  const headingId = useId();
  const dialog = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const target = staleMessage && !busy ? reviewButton.current : dialog.current;
    target?.focus({ preventScroll: true });
  }, [busy, preview, staleMessage]);

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
    if (!edge || event.target === event.currentTarget || event.target === edge) {
      event.preventDefault();
      (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
    }
  }

  const change = preview.changes.find(row => row.id === issueId);
  const dates = change ? [
    { label: '시작일', from: change.fromStart, to: change.toStart },
    { label: '종료일', from: change.fromEnd, to: change.toEnd },
    { label: '목표 마감일', from: change.fromDue ?? null, to: change.toDue ?? null },
  ].filter(({ from, to }) => from !== to) : [];
  const warnings = [...new Set([...preview.warnings, ...(preview.teamBlockerWarnings ?? [])])];
  const relatedNames = new Map(issues.filter(issue => issue.id !== issueId).map(issue => [issue.key, issue.title]));
  const blocking = preview.blocking ?? [];
  const action = staleMessage ? onReviewAgain : onSave;

  return <div className="issue-modal-overlay">
    <section ref={dialog} className="gantt-preview-modal issue-schedule-save-review" role="dialog" aria-modal="true"
      aria-labelledby={headingId} aria-busy={busy} tabIndex={-1} onKeyDown={handleKeys}>
      <header><h2 id={headingId}>일정 변경 검토</h2>
        <button className="issue-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="일정 검토 닫기"><X size={20} /></button>
      </header>
      <div className="issue-create-fields">
        {staleMessage && <div className="issue-form-error" role="alert">{staleMessage}</div>}
        {dates.length > 0 && <dl className="issue-schedule-save-dates">
          {dates.map(({ label, from, to }) => <div key={label}>
            <dt>{label}</dt>
            <dd><span>{from ?? '미정'}</span><ArrowRight size={14} role="img" aria-label="에서" /><strong>{to ?? '미정'}</strong></dd>
          </div>)}
        </dl>}
        {warnings.length > 0 && <div className="issue-schedule-warnings"><ul>
          {warnings.map(message => {
            const keys = new Set(message.match(/[A-Z][A-Z0-9_]*-\d+/gu));
            const names = [...keys].flatMap(key => {
              const title = relatedNames.get(key);
              return title ? [`${key} ${title}`] : [];
            });
            return <li key={message}>{message}{names.length > 0 && <small>{names.join(' · ')}</small>}</li>;
          })}
        </ul></div>}
        {blocking.length > 0 && <div className="issue-form-error" role="alert">{blocking.map(message => <p key={message}>{message}</p>)}</div>}
        {!staleMessage && !warnings.length && !blocking.length && <p className="issue-section-empty">확인된 일정 충돌이 없습니다.</p>}
      </div>
      <footer>
        <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>날짜 다시 편집</button>
        <button ref={reviewButton} className="btn btn-primary" type="button" onClick={action}
          disabled={busy || !staleMessage && (!preview.previewId || blocking.length > 0)}>
          {!staleMessage && <Save size={15} aria-hidden="true" />}{busy ? '처리 중…' : staleMessage ? '다시 검토' : '검토한 날짜로 저장'}
        </button>
      </footer>
    </section>
  </div>;
}
