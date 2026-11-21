'use client';

import { useId, type PointerEventHandler } from 'react';
import { LocateFixed, Network, X } from 'lucide-react';
import type { GanttDependencyFocus } from '../../shared/gantt-dependency-focus';
import './gantt-dependency-focus.css';

interface GanttDependencyFocusPanelProps {
  trace: GanttDependencyFocus | null;
  outsideFilterCount: number;
  disabled: boolean;
  onClose: () => void;
  onLocate: () => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
}

const count = (value: number) => `${value.toLocaleString('ko-KR')}개`;

export function GanttDependencyFocusPanel({ trace, outsideFilterCount, disabled, onClose, onLocate, onPointerDown }: GanttDependencyFocusPanelProps) {
  const headingId = useId();

  return <section className="gantt-dependency-focus" aria-labelledby={headingId}>
    <div className="gantt-dependency-focus-summary">
      <h2 id={headingId}><Network size={16} aria-hidden="true" />선후행 흐름</h2>
      {trace ? <div role="status">
        <p className="gantt-dependency-focus-work"><strong>{trace.anchor.key}</strong> · {trace.anchor.title}</p>
        <p className="gantt-dependency-focus-counts">
          <span>선행 {count(trace.predecessorDepths.size)}</span>
          <span>후행 {count(trace.successorDepths.size)}</span>
          {outsideFilterCount > 0 && <span className="gantt-dependency-focus-extra">기존 보기 밖 {count(outsideFilterCount)}</span>}
        </p>
      </div> : <p className="gantt-dependency-focus-work" role="status">기준 업무를 찾을 수 없습니다.</p>}
    </div>
    <div className="gantt-dependency-focus-actions">
      {trace && <button className="btn" type="button" disabled={disabled} data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={onLocate}>
        <LocateFixed size={14} aria-hidden="true" />기준 업무로 이동
      </button>}
      <button className="btn btn-ghost" type="button" disabled={disabled} data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={onClose}>
        <X size={14} aria-hidden="true" />선후행 흐름 닫기
      </button>
    </div>
  </section>;
}

export function GanttDependencyFocusLabel({ issueId, trace }: { issueId: string; trace: GanttDependencyFocus }) {
  if (issueId === trace.anchor.id) return <span className="gantt-dependency-focus-labels">
    <span data-direction="anchor">기준 업무</span>
  </span>;

  const predecessorDepth = trace.predecessorDepths.get(issueId);
  const successorDepth = trace.successorDepths.get(issueId);
  if (predecessorDepth === undefined && successorDepth === undefined) return null;

  return <span className="gantt-dependency-focus-labels">
    {predecessorDepth !== undefined && <span data-direction="predecessor">선행 {predecessorDepth}단계</span>}
    {successorDepth !== undefined && <span data-direction="successor">후행 {successorDepth}단계</span>}
  </span>;
}
