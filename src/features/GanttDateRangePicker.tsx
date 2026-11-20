'use client';

import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent } from 'react';
import { isoDay, todayDate } from './schedule-utils';
import './gantt-date-range-picker.css';

type DateRangePromptProps = {
  issueKey: string;
  issueTitle: string;
  fixedEdge?: { kind: 'start' | 'end'; date: string };
  firstDate: string | null;
  onReset: () => void;
  onCancel: () => void;
};

export function GanttDateRangePrompt({ issueKey, issueTitle, fixedEdge, firstDate, onReset, onCancel }: DateRangePromptProps) {
  const nextDate = fixedEdge ? fixedEdge.kind === 'end' ? '시작일' : '종료일' : firstDate ? '나머지 날짜' : '첫 날짜';
  return (
    <section className="gantt-date-range-prompt" aria-label="차트 날짜 선택">
      <div className="gantt-date-range-instructions">
        <strong>{issueKey} · {issueTitle}</strong>
        <p role="status" aria-atomic="true">
          {fixedEdge ? <>{fixedEdge.kind === 'start' ? '시작일' : '종료일'} {fixedEdge.date} 유지 · </>
            : firstDate && <>첫 날짜 {firstDate} · </>}
          차트에서 {nextDate}{fixedEdge ? '을' : '를'} 선택하세요.
          {!fixedEdge && firstDate && ' 하루 일정은 같은 날짜를 고르세요.'}
        </p>
      </div>
      <div className="gantt-date-range-prompt-actions">
        {!fixedEdge && firstDate && <button className="btn" type="button" onClick={onReset}>시작점 다시 선택</button>}
        <button className="btn btn-ghost" type="button" onClick={onCancel}>날짜 선택 취소</button>
      </div>
    </section>
  );
}

type DateRangeLaneProps = {
  issueKey: string;
  rangeStart: number;
  rangeEnd: number;
  initialDay: number;
  minDay: number;
  maxDay: number;
  selectedDay: number | null;
  onPick: (day: number) => void;
  onFocusDay: (day: number) => void;
};

export function GanttDateRangeLane({ issueKey, rangeStart, rangeEnd, initialDay, minDay, maxDay, selectedDay, onPick, onFocusDay }: DateRangeLaneProps) {
  const lane = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const [focusDay, setFocusDay] = useState(initialDay);
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const firstDay = Math.max(minDay, rangeStart);
  const lastDay = Math.min(maxDay, rangeEnd);
  const tabDay = firstDay <= lastDay ? Math.max(firstDay, Math.min(focusDay, lastDay)) : null;
  const previewDay = hoverDay !== null && hoverDay >= firstDay && hoverDay <= lastDay ? hoverDay : tabDay;
  const today = todayDate();
  const scrollToInitialDay = useEffectEvent(onFocusDay);

  useEffect(() => {
    const button = lane.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]');
    if (!button) return;
    button.focus({ preventScroll: true });
    scrollToInitialDay(Number(button.dataset.epochDay));
  }, []);

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, day: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let nextDay: number;
    switch (event.key) {
      case 'ArrowLeft': nextDay = Math.max(firstDay, day - 1); break;
      case 'ArrowRight': nextDay = Math.min(lastDay, day + 1); break;
      case 'Home': nextDay = firstDay; break;
      case 'End': nextDay = lastDay; break;
      default: return;
    }
    event.preventDefault();
    setHoverDay(null);
    if (nextDay === day) return;
    lane.current?.querySelector<HTMLButtonElement>(`button[data-epoch-day="${nextDay}"]`)?.focus({ preventScroll: true });
    onFocusDay(nextDay);
  }

  return (
    <div ref={lane} className="gantt-date-range-lane" role="group" aria-label={`${issueKey} 일정 날짜 선택`} onPointerLeave={() => setHoverDay(null)}>
      {selectedDay !== null && <span id={descriptionId} className="sr-only">일정 범위의 기준 날짜</span>}
      {Array.from({ length: rangeEnd - rangeStart + 1 }, (_, index) => {
        const day = rangeStart + index;
        const date = isoDay(day);
        const selectable = day >= firstDay && day <= lastDay;
        const selected = day === selectedDay;
        const inPreview = selectedDay !== null && previewDay !== null &&
          day >= Math.min(selectedDay, previewDay) && day <= Math.max(selectedDay, previewDay);
        return (
          <button key={day} type="button" className="gantt-date-range-day" data-epoch-day={day} data-selected={selected || undefined}
            data-in-preview={inPreview || undefined} title={date} aria-label={`${issueKey} ${date} 선택`} aria-current={date === today ? 'date' : undefined}
            aria-describedby={selected ? descriptionId : undefined} disabled={!selectable} tabIndex={day === tabDay ? 0 : -1}
            onFocus={() => setFocusDay(day)} onKeyDown={event => moveFocus(event, day)}
            onPointerEnter={event => { if (event.pointerType === 'mouse') setHoverDay(selectable ? day : null); }} onClick={() => onPick(day)}>
            <span aria-hidden="true">{Number(date.slice(-2))}</span>
          </button>
        );
      })}
    </div>
  );
}
