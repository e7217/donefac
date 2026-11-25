'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Diamond, X } from 'lucide-react';
import type { Issue, Milestone, Project } from '../../shared/types';
import { buildGanttMonthCalendar, ganttCalendarWeekday, shiftGanttCalendarDay, shiftGanttCalendarMonth, type GanttCalendarField } from '../../shared/gantt-month-calendar';
import './gantt-month-calendar.css';

const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
const dayOffsets = new Map([['ArrowLeft', -1], ['ArrowRight', 1], ['ArrowUp', -7], ['ArrowDown', 7]]);
const dateLabels: Record<GanttCalendarField, string> = { startDate: '시작일', endDate: '종료일', dueDate: '목표 마감일' };
const pageSize = 10;
const countLabel = (count: number) => count.toLocaleString('ko-KR');
const monthLabel = (date: string) => `${Number(date.slice(0, 4))}년 ${Number(date.slice(5, 7))}월`;
const dayLabel = (date: string) => `${monthLabel(date)} ${Number(date.slice(8, 10))}일`;

interface Props {
  id: string;
  initialDate: string;
  today: string;
  issues: readonly Issue[];
  milestones: readonly Milestone[];
  projects?: ReadonlyMap<string, Project>;
  disabled: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onClose: () => void;
  onOpenIssue: (id: string, opener: HTMLButtonElement, issueIds: readonly string[]) => void;
  onOpenMilestone: (id: string, opener: HTMLButtonElement) => void;
  onEditDate: (issue: Issue, field: GanttCalendarField, opener: HTMLButtonElement) => void;
}

export function GanttMonthCalendar({ id, initialDate, today, issues, milestones, projects, disabled,
  onPointerDown, onClose, onOpenIssue, onOpenMilestone, onEditDate }: Props) {
  const heading = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [page, setPage] = useState(0);
  const month = selectedDate.slice(0, 7);
  const { days, leading, entries } = useMemo(() => buildGanttMonthCalendar(`${month}-01`, issues, milestones), [month, issues, milestones]);
  const agenda = entries.get(selectedDate) ?? [];
  const lastPage = Math.max(0, Math.ceil(agenda.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * pageSize;
  const shown = agenda.slice(offset, offset + pageSize);
  const previousMonth = shiftGanttCalendarMonth(selectedDate, -1);
  const nextMonth = shiftGanttCalendarMonth(selectedDate, 1);

  useLayoutEffect(() => {
    if (!focusDay.current) return;
    focusDay.current = false;
    viewport.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${selectedDate}"]`)?.focus({ preventScroll: true });
  }, [selectedDate]);

  function select(date: string | null, fromKeyboard = false) {
    if (!date || date === selectedDate) return;
    focusDay.current = fromKeyboard;
    setSelectedDate(date);
    setPage(0);
  }

  function handleDayKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const offset = event.key === 'Home' ? -ganttCalendarWeekday(date)
      : event.key === 'End' ? 6 - ganttCalendarWeekday(date) : dayOffsets.get(event.key);
    if (offset !== undefined) {
      event.preventDefault();
      select(shiftGanttCalendarDay(date, offset), true);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      select(shiftGanttCalendarMonth(date, event.key === 'PageUp' ? -1 : 1), true);
    }
  }

  return <section id={id} className="gantt-month-calendar card" aria-labelledby={heading} data-gantt-focus-control=""
    onPointerDown={onPointerDown} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !disabled) {
        event.preventDefault();
        onClose();
      }
    }}>
    <header className="gantt-month-header">
      <h2 id={heading}><CalendarDays size={17} aria-hidden="true" />월간 일정</h2>
      <button type="button" className="btn btn-ghost issue-icon-button" disabled={disabled}
        aria-label="월간 일정 닫기" onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </header>
    <div className="gantt-month-layout">
      <div className="gantt-month-view">
        <nav className="gantt-month-controls" aria-label="월간 일정 이동">
          <button type="button" className="btn btn-ghost issue-icon-button" aria-label="이전 달"
            disabled={disabled || !previousMonth} onClick={() => select(previousMonth)}><ChevronLeft size={17} aria-hidden="true" /></button>
          <h3 aria-live="polite">{monthLabel(selectedDate)}</h3>
          <button type="button" className="btn btn-ghost issue-icon-button" aria-label="다음 달"
            disabled={disabled || !nextMonth} onClick={() => select(nextMonth)}><ChevronRight size={17} aria-hidden="true" /></button>
          <button type="button" className="btn btn-ghost gantt-month-today" disabled={disabled || selectedDate === today}
            onClick={() => select(today)}>오늘</button>
        </nav>
        <div className="gantt-month-grid" aria-label={`${monthLabel(selectedDate)} 날짜`} role="group" ref={viewport}>
          {dayNames.map(name => <span className="gantt-month-weekday" key={name} aria-hidden="true">{name}</span>)}
          {Array.from({ length: leading }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
          {days.map(date => {
            const count = entries.get(date)?.length ?? 0;
            const selected = date === selectedDate;
            return <button type="button" key={date} className="gantt-month-day" aria-pressed={selected}
              aria-current={date === today ? 'date' : undefined} tabIndex={selected ? 0 : -1}
              aria-label={`${dayLabel(date)} ${dayNames[ganttCalendarWeekday(date)]}요일 일정 ${countLabel(count)}건`}
              data-calendar-date={date} disabled={disabled} onKeyDown={event => handleDayKey(event, date)} onClick={() => select(date)}>
              <span>{Number(date.slice(8, 10))}</span>
              {count > 0 && <span className="gantt-month-count">{countLabel(count)}</span>}
            </button>;
          })}
        </div>
      </div>
      <div className="gantt-month-agenda">
        <h3 aria-live="polite"><time dateTime={selectedDate}>{dayLabel(selectedDate)}</time> <span>{countLabel(agenda.length)}건</span></h3>
        {shown.length ? <ul role="list" className="gantt-month-agenda-list" aria-label="선택한 날의 일정">
          {shown.map(entry => {
            if (entry.kind === 'milestone') {
              const { milestone } = entry;
              return <li key={`milestone:${milestone.id}`} className="gantt-month-agenda-item">
                <button type="button" className="btn btn-ghost gantt-month-item-name" disabled={disabled}
                  onClick={event => onOpenMilestone(milestone.id, event.currentTarget)}>
                  <Diamond size={14} aria-hidden="true" />{milestone.title}
                </button>
                <span className="gantt-month-milestone">마일스톤</span>
              </li>;
            }
            const { issue, fields } = entry;
            const projectKey = projects?.get(issue.projectId)?.key;
            return <li key={`issue:${issue.id}`} className="gantt-month-agenda-item">
              <button type="button" className="btn btn-ghost gantt-month-item-name" disabled={disabled}
                onClick={event => onOpenIssue(issue.id, event.currentTarget,
                  agenda.flatMap(item => item.kind === 'issue' ? [item.issue.id] : []))}>
                <span>{issue.key}</span>{issue.title}
              </button>
              {projectKey && <span className="gantt-month-project">{projectKey}</span>}
              <div className="gantt-month-item-fields">
                {fields.map(field => <button type="button" className="btn btn-ghost gantt-month-field" key={field}
                  data-field={field} disabled={disabled} aria-label={`${issue.key} ${dateLabels[field]} 수정`}
                  onClick={event => onEditDate(issue, field, event.currentTarget)}>{dateLabels[field]}</button>)}
              </div>
            </li>;
          })}
        </ul> : <p className="gantt-month-empty">선택한 날에 표시할 일정이 없습니다.</p>}
        {lastPage > 0 && <nav className="gantt-month-pagination" aria-label="선택한 날의 일정 페이지">
          <span aria-live="polite">{offset + 1}–{offset + shown.length} / {countLabel(agenda.length)}</span>
          <button type="button" className="btn btn-ghost" aria-label="이전 일정 페이지" disabled={disabled || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}>이전</button>
          <button type="button" className="btn btn-ghost" aria-label="다음 일정 페이지" disabled={disabled || currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}>다음</button>
        </nav>}
      </div>
    </div>
  </section>;
}
