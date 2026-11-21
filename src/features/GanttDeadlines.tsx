'use client';

import { useId, useMemo, useState, type PointerEvent } from 'react';
import { CalendarDays, Flag, Pencil, X } from 'lucide-react';
import type { Issue } from '../../shared/types';
import { classifyGanttDeadline, GANTT_DEADLINE_LABELS } from './gantt-deadline';
import './gantt-deadlines.css';

const KIND_ORDER = { late: 0, missing: 1, within: 2 } as const;
const FILTERS = ['all', 'late', 'missing', 'within'] as const;
const PAGE_SIZE = 8;
type Filter = typeof FILTERS[number];

interface GanttDeadlinesProps {
  id: string;
  issues: readonly Issue[];
  onLocate: (issue: Issue, opener: HTMLButtonElement) => void;
  onEdit: (issue: Issue, opener: HTMLButtonElement) => void;
  onClose: () => void;
  disabled: boolean;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
}

export function GanttDeadlines({ id, issues, onLocate, onEdit, onClose, disabled, onPointerDown }: GanttDeadlinesProps) {
  const heading = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const { entries, counts } = useMemo(() => {
    const counts = { all: 0, late: 0, missing: 0, within: 0 };
    const entries = issues.flatMap(issue => {
      const deadline = classifyGanttDeadline(issue);
      if (!deadline) return [];
      counts.all += 1;
      counts[deadline.kind] += 1;
      return [{ issue, deadline }];
    });
    entries.sort((before, after) => KIND_ORDER[before.deadline.kind] - KIND_ORDER[after.deadline.kind]
      || before.deadline.dueDate.localeCompare(after.deadline.dueDate)
      || before.issue.key.localeCompare(after.issue.key, 'ko-KR', { numeric: true })
      || before.issue.id.localeCompare(after.issue.id));
    return { entries, counts };
  }, [issues]);
  const filtered = filter === 'all' ? entries : entries.filter(entry => entry.deadline.kind === filter);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * PAGE_SIZE;

  return <section id={id} className="gantt-deadlines card" aria-labelledby={heading}>
    <header className="gantt-deadlines-header">
      <div>
        <h2 id={heading}><Flag size={17} aria-hidden="true" />목표 마감일 검토</h2>
        <p>현재 간트에 표시된 업무의 목표 마감일과 계획 종료일을 비교합니다.</p>
      </div>
      <button className="issue-icon-button" type="button" aria-label="목표 마감일 검토 닫기" data-gantt-focus-control=""
        onPointerDown={onPointerDown} onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
    <div className="gantt-deadlines-filters" role="group" aria-label="목표 마감일 상태">
      {FILTERS.map(value => <button key={value} className="btn" type="button" aria-pressed={value === filter}
        data-kind={value} data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={() => { setFilter(value); setPage(0); }}>
        <span>{value === 'all' ? '전체' : GANTT_DEADLINE_LABELS[value]}</span>{' '}
        <strong>{counts[value].toLocaleString('ko-KR')}건</strong>
      </button>)}
    </div>
    {filtered.length ? <ul className="gantt-deadlines-list" aria-label="목표 마감일이 있는 업무" role="list">
      {filtered.slice(offset, offset + PAGE_SIZE).map(({ issue, deadline }) => <li key={issue.id}>
        <div className="gantt-deadlines-item-heading">
          <h3>{issue.key} {issue.title}</h3>
          <span className="gantt-deadlines-kind" data-kind={deadline.kind}>{GANTT_DEADLINE_LABELS[deadline.kind]}</span>
        </div>
        <dl className="gantt-deadlines-dates">
          <div><dt>목표 마감일</dt><dd><time dateTime={deadline.dueDate}>{deadline.dueDate}</time></dd></div>
          <div><dt>계획 종료일</dt><dd>{deadline.endDate ? <time dateTime={deadline.endDate}>{deadline.endDate}</time> : '미정'}</dd></div>
          {deadline.kind === 'late' && deadline.delayDays !== null && <div className="gantt-deadlines-delay">
            <dt>차이</dt><dd>{deadline.delayDays.toLocaleString('ko-KR')}일 초과 · 달력일</dd>
          </div>}
        </dl>
        <div className="gantt-deadlines-actions">
          <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`${issue.key} 목표 마감일로 이동`}
            data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={event => onLocate(issue, event.currentTarget)}>
            <CalendarDays size={14} aria-hidden="true" />마감일로 이동
          </button>
          <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`${issue.key} 목표 마감일 수정`}
            data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={event => onEdit(issue, event.currentTarget)}>
            <Pencil size={14} aria-hidden="true" />마감일 수정
          </button>
        </div>
      </li>)}
    </ul> : <p className="gantt-deadlines-empty" role="status">{counts.all ? '선택한 상태의 업무가 없습니다.' : '표시된 업무에 목표 마감일이 없습니다.'}</p>}
    {lastPage > 0 && <nav className="gantt-deadlines-pagination" aria-label="목표 마감일 검토 페이지">
      <span aria-live="polite">{offset + 1}–{Math.min(offset + PAGE_SIZE, filtered.length)} / {filtered.length.toLocaleString('ko-KR')}</span>
      <button type="button" className="btn btn-ghost" aria-label="목표 마감일 이전 페이지" disabled={currentPage === 0}
        data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={() => setPage(currentPage - 1)}>이전</button>
      <button type="button" className="btn btn-ghost" aria-label="목표 마감일 다음 페이지" disabled={currentPage === lastPage}
        data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={() => setPage(currentPage + 1)}>다음</button>
    </nav>}
  </section>;
}
