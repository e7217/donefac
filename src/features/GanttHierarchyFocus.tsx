'use client';

import { useId, type CSSProperties, type PointerEventHandler } from 'react';
import { ListTree, LocateFixed, X } from 'lucide-react';
import type { GanttHierarchyFocus } from '../../shared/gantt-hierarchy-focus';
import './gantt-hierarchy-focus.css';

interface GanttHierarchyFocusPanelProps {
  trace: GanttHierarchyFocus | null;
  outsideFilterCount: number;
  disabled: boolean;
  onClose: () => void;
  onLocate: () => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
}

const count = (value: number) => `${value.toLocaleString('ko-KR')}개`;

export function GanttHierarchyFocusPanel({ trace, outsideFilterCount, disabled, onClose, onLocate, onPointerDown }: GanttHierarchyFocusPanelProps) {
  const headingId = useId();

  return <section className="gantt-hierarchy-focus" aria-labelledby={headingId}>
    <div className="gantt-hierarchy-focus-summary">
      <h2 id={headingId}><ListTree size={16} aria-hidden="true" />하위 업무 일정</h2>
      {trace ? <div role="status">
        <p className="gantt-hierarchy-focus-work"><strong>{trace.anchor.key}</strong> · {trace.anchor.title}</p>
        {trace.depths.size > 0 ? <>
          <p className="gantt-hierarchy-focus-counts">
            <span>전체 {count(trace.depths.size)}</span>
            <span>완료 {count(trace.doneCount)}</span>
            {trace.canceledCount > 0 && <span>취소 {count(trace.canceledCount)}</span>}
            <span>미정 {count(trace.unscheduledCount)}</span>
            {outsideFilterCount > 0 && <span className="gantt-hierarchy-focus-extra">기존 보기 밖 {count(outsideFilterCount)}</span>}
          </p>
          <dl className="gantt-hierarchy-focus-range">
            <dt>하위 업무 범위</dt>
            <dd>{trace.span ? <>
              <time dateTime={trace.span.startDate}>{trace.span.startDate}</time>
              {' ~ '}
              <time dateTime={trace.span.endDate}>{trace.span.endDate}</time>
            </> : '계획 범위 미정'}</dd>
          </dl>
        </> : <p className="gantt-hierarchy-focus-work">하위 업무가 없습니다.</p>}
      </div> : <p className="gantt-hierarchy-focus-work" role="status">상위 업무를 찾을 수 없습니다.</p>}
    </div>
    <div className="gantt-hierarchy-focus-actions">
      {trace && <button className="btn" type="button" disabled={disabled} data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={onLocate}>
        <LocateFixed size={14} aria-hidden="true" />상위 업무로 이동
      </button>}
      <button className="btn btn-ghost" type="button" disabled={disabled} data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={onClose}>
        <X size={14} aria-hidden="true" />하위 업무 일정 닫기
      </button>
    </div>
  </section>;
}

export function GanttHierarchyFocusLabel({ issueId, trace }: { issueId: string; trace: GanttHierarchyFocus }) {
  if (issueId === trace.anchor.id) return <span className="gantt-hierarchy-focus-label" data-tier="anchor">상위 업무</span>;
  const depth = trace.depths.get(issueId);
  return depth === undefined ? null : <span className="gantt-hierarchy-focus-label">하위 {depth}단계</span>;
}

export function GanttHierarchySpan({ anchorKey, startDate, endDate, style }: {
  anchorKey: string;
  startDate: string;
  endDate: string;
  style: CSSProperties;
}) {
  const label = `${anchorKey} 하위 업무 일정 ${startDate} ~ ${endDate}`;
  return <span className="gantt-hierarchy-span" role="img" aria-label={label} title={label} style={style} />;
}
