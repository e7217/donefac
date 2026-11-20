'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link2, X } from 'lucide-react';
import type { Dependency, DependencyType, Issue } from '../../shared/types';
import { DEPENDENCY_ENDPOINTS, DEPENDENCY_LABELS, DEPENDENCY_TYPES, isDependencyLag, isDependencyType, MAX_DEPENDENCY_LAG_DAYS, SCHEDULE_DATE_LABELS } from '../../shared/schedule-dependencies';
import { errorMessage } from './schedule-utils';

export type DependencyInput = Pick<Dependency, 'predecessorId' | 'successorId' | 'type' | 'lagDays'>;
export type DependencyPrefill = { predecessorId: string; successorId: string; type?: DependencyType };

type Props = {
  issues: Issue[];
  dependency?: Dependency;
  prefill?: DependencyPrefill;
  onClose: () => void;
  onSubmit: (input: DependencyInput) => Promise<void>;
  busy: boolean;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
};

export function GanttDependencyModal({ issues, dependency, prefill, onClose, onSubmit, busy, onDraftChange }: Props) {
  const initialPredecessor = dependency?.predecessorId ?? prefill?.predecessorId ?? '';
  const initialSuccessor = dependency?.successorId ?? prefill?.successorId ?? '';
  const initialType = (dependency ? dependency.type : prefill?.type) ?? 'FS';
  const initialLag = String(dependency?.lagDays ?? 0);
  const [predecessorId, setPredecessorId] = useState(initialPredecessor);
  const [successorId, setSuccessorId] = useState(initialSuccessor);
  const [type, setType] = useState<DependencyType>(prefill?.type ?? initialType);
  const [lag, setLag] = useState(initialLag);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const predecessorSelect = useRef<HTMLSelectElement>(null);
  const typeSelect = useRef<HTMLSelectElement>(null);
  const editing = Boolean(dependency);
  const reviewingSelection = Boolean(dependency || prefill);
  const dirty = predecessorId !== initialPredecessor || successorId !== initialSuccessor || type !== initialType || lag !== initialLag;
  const lagDays = lag.trim() === '' ? NaN : Number(lag);
  const endpoints = DEPENDENCY_ENDPOINTS[type];
  const predecessor = issues.find(issue => issue.id === predecessorId);
  const successor = issues.find(issue => issue.id === successorId);
  const ready = Boolean(predecessor && successor && predecessor.id !== successor.id && predecessor.projectId === successor.projectId && isDependencyLag(lagDays));

  useEffect(() => { (reviewingSelection ? typeSelect : predecessorSelect).current?.focus({ preventScroll: true }); }, [reviewingSelection]);
  useEffect(() => { if (busy) dialog.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => {
    onDraftChange('dependency', dirty, busy);
    return () => onDraftChange('dependency', false);
  }, [onDraftChange, dirty, busy]);

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key !== 'Tab') return;
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)');
    const first = focusable[0], last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!first || (event.shiftKey ? active === first || active === event.currentTarget : active === last)) {
      event.preventDefault();
      const target = (event.shiftKey ? last : first) ?? event.currentTarget;
      target.focus();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy || (editing && !dirty)) return;
    setError('');
    try {
      await onSubmit({ predecessorId, successorId, type, lagDays });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return <div className="issue-modal-overlay">
    <section ref={dialog} className="gantt-link-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-title" tabIndex={-1} onKeyDown={handleKeys}>
      <form onSubmit={submit}>
        <header>
          <h2 id="dependency-title">{editing ? '업무 연결 수정' : '선행·후행 업무 연결'}</h2>
          <button className="issue-icon-button" type="button" disabled={busy} onClick={onClose} aria-label="업무 연결 닫기"><X size={20} /></button>
        </header>
        <div className="gantt-link-fields">
          <label className="issue-form-label">선행 업무
            <select ref={predecessorSelect} className="field" aria-label="선행 업무" disabled={busy || editing} value={predecessorId} onChange={event => setPredecessorId(event.target.value)} required>
              <option value="">선행 업무 선택</option>
              {issues.filter(issue => issue.id !== successorId && (!successor || issue.projectId === successor.projectId)).map(issue => (
                <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>
              ))}
            </select>
          </label>
          <label className="issue-form-label">후행 업무
            <select className="field" aria-label="후행 업무" disabled={busy || editing} value={successorId} onChange={event => setSuccessorId(event.target.value)} required>
              <option value="">후행 업무 선택</option>
              {issues.filter(issue => issue.id !== predecessorId && (!predecessor || issue.projectId === predecessor.projectId)).map(issue => (
                <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>
              ))}
            </select>
          </label>
          <label className="issue-form-label">연결 유형
            <select ref={typeSelect} className="field" aria-label="연결 유형" disabled={busy} value={type} aria-describedby="dependency-type-help" onChange={event => {
              if (isDependencyType(event.target.value)) setType(event.target.value);
            }}>
              {DEPENDENCY_TYPES.map(value => <option key={value} value={value}>{DEPENDENCY_LABELS[value]} ({value})</option>)}
            </select>
          </label>
          <label className="issue-form-label">추가 간격 (근무일)
            <input className="field" aria-label="추가 간격 근무일" aria-describedby="dependency-lag-help" disabled={busy} type="number" inputMode="text" value={lag} onChange={event => setLag(event.target.value)} min={-MAX_DEPENDENCY_LAG_DAYS} max={MAX_DEPENDENCY_LAG_DAYS} required step="1" />
          </label>
          <p id="dependency-type-help" className="gantt-link-help">
            {type === 'FS' ? '선행 업무 종료 후 첫 근무일부터 후행 업무의 시작일을 계산합니다.'
              : `선행 업무의 ${SCHEDULE_DATE_LABELS[endpoints.predecessor]}을 기준으로 후행 업무의 ${SCHEDULE_DATE_LABELS[endpoints.successor]}을 계산합니다.`}
          </p>
          <p id="dependency-lag-help" className="gantt-link-help">양수는 늦추고 음수는 앞당깁니다. 일정 미리보기와 자동 일정 제안에 프로젝트 근무일을 적용합니다.</p>
          {error && <div className="issue-form-error" role="alert">{error}</div>}
        </div>
        <footer>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={onClose}>취소</button>
          <button className="btn btn-primary" type="submit" disabled={busy || !ready || (editing && !dirty)}>
            <Link2 size={15} />{busy ? '저장 중…' : editing ? '연결 변경 저장' : '업무 연결'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
