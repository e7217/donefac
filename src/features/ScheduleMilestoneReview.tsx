'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ListTodo, X } from 'lucide-react';
import {
  MILESTONE_READINESS_KINDS, MILESTONE_READINESS_LABELS, milestoneReadiness,
  type MilestoneReadinessKind,
} from '../../shared/milestone-readiness';
import type { Issue, Milestone, Project, WorkspaceSnapshot } from '../../shared/types';
import { dayNumber } from './schedule-utils';
import './schedule-milestone-review.css';

export const SCHEDULE_MILESTONE_REVIEW_ID = 'schedule-milestone-review';
const REVIEW_PAGE_SIZE = 8;
type ReadinessFilter = 'all' | MilestoneReadinessKind;

interface ScheduleMilestoneReviewProps {
  milestone: Milestone | undefined;
  project?: Project;
  issues: readonly Issue[];
  workflows: WorkspaceSnapshot['workflows'];
  busy: boolean;
  onClose: () => void;
  onLocateIssue: (id: string) => boolean;
  onOpenIssue: (id: string, opener: HTMLButtonElement) => void;
}

export function ScheduleMilestoneReview({ milestone, project, issues, workflows, busy, onClose, onLocateIssue, onOpenIssue }: ScheduleMilestoneReviewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [filter, setFilter] = useState<ReadinessFilter>('all');
  const [page, setPage] = useState(0);
  const readiness = useMemo(() => milestone && milestoneReadiness(milestone, new Map(issues.map(issue => [issue.id, issue])), { workflows }),
    [milestone, issues, workflows]);

  useEffect(() => { heading.current?.focus(); }, []);

  const rows = readiness?.rows ?? [];
  const filtered = filter === 'all' ? rows : rows.filter(row => row.kind === filter);
  const lastPage = Math.max(0, Math.ceil(filtered.length / REVIEW_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * REVIEW_PAGE_SIZE;
  const unavailableCount = readiness?.counts.unavailable ?? 0;
  const total = rows.length + unavailableCount;
  const visibleFilters = readiness ? MILESTONE_READINESS_KINDS.filter(kind => readiness.counts[kind] || filter === kind) : [];

  function selectFilter(value: ReadinessFilter) {
    setFilter(value);
    setPage(0);
  }

  return <section id={SCHEDULE_MILESTONE_REVIEW_ID} className="schedule-milestone-review" aria-label="이정표 연결 업무">
    <header className="schedule-milestone-review-header">
      <div>
        <h2 tabIndex={-1} ref={heading}>{milestone?.title ?? '이정표를 찾을 수 없습니다.'}</h2>
        {milestone && <p>{project && `${project.key} · ${project.name} · `}이정표 날짜 <time dateTime={milestone.date}>{milestone.date}</time>
          {' · '}{milestone.status === 'reached' ? '달성' : '예정'}</p>}
      </div>
      <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="연결 업무 닫기"><X size={16} aria-hidden="true" /></button>
    </header>
    {milestone && readiness && <>
      {total > 0 && <div className="schedule-milestone-review-filters" role="group" aria-label="연결 업무 일정 조건">
        <button type="button" className="btn btn-ghost" aria-pressed={filter === 'all'} onClick={() => selectFilter('all')}>전체 {total.toLocaleString('ko-KR')}개</button>
        {visibleFilters.map(kind => <button type="button" key={kind} className="btn btn-ghost" data-kind={kind}
          aria-pressed={filter === kind} onClick={() => selectFilter(kind)}>
          {MILESTONE_READINESS_LABELS[kind]} {readiness.counts[kind].toLocaleString('ko-KR')}개
        </button>)}
      </div>}
      {filtered.length > 0 && <ul className="schedule-milestone-review-list" aria-label="이정표 업무 목록" role="list">
        {filtered.slice(offset, offset + REVIEW_PAGE_SIZE).map(({ issue, kind, status }) => <li key={issue.id} data-kind={kind}>
          <div className="schedule-milestone-review-item">
            <h3><span className="issue-key">{issue.key}</span>{' '}{issue.title}</h3>
            <span className="schedule-milestone-review-kind">{MILESTONE_READINESS_LABELS[kind]}</span>
          </div>
          <dl className="schedule-milestone-review-data">
            {status.label !== MILESTONE_READINESS_LABELS[kind] && <div><dt>업무 상태</dt><dd>{status.label}</dd></div>}
            <div><dt>계획 종료일</dt><dd>{issue.endDate ? <time dateTime={issue.endDate}>{issue.endDate}</time> : '미정'}</dd></div>
            {kind === 'late' && issue.endDate && <div><dt>이정표와 차이</dt><dd>{(dayNumber(issue.endDate) - dayNumber(milestone.date)).toLocaleString('ko-KR')}일 초과 · 달력일</dd></div>}
          </dl>
          <div className="schedule-milestone-review-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} aria-label={`${issue.key} 상세 열기`}
              onClick={event => onOpenIssue(issue.id, event.currentTarget)}><ListTodo size={14} aria-hidden="true" />상세 열기</button>
            <button type="button" className="btn btn-ghost" disabled={busy} aria-label={`${issue.key} 간트 위치`}
              onClick={() => onLocateIssue(issue.id)}><CalendarDays size={14} aria-hidden="true" />간트 위치</button>
          </div>
        </li>)}
      </ul>}
      {!total && <p className="schedule-milestone-review-note" role="status">연결된 업무가 없습니다.</p>}
      {unavailableCount > 0 && (filter === 'all' || filter === 'unavailable') && <p className="schedule-milestone-review-note" role="status">
        현재 프로젝트에서 확인할 수 없는 연결 업무가 {unavailableCount.toLocaleString('ko-KR')}개 있습니다.
      </p>}
      {total > 0 && !filtered.length && filter !== 'all' && (filter !== 'unavailable' || !unavailableCount) &&
        <p className="schedule-milestone-review-note" role="status">선택한 조건의 업무가 없습니다.</p>}
      {lastPage > 0 && <nav className="schedule-milestone-review-pagination" aria-label="이정표 업무 페이지">
        <span aria-live="polite">{offset + 1}–{Math.min(offset + REVIEW_PAGE_SIZE, filtered.length)} / {filtered.length.toLocaleString('ko-KR')}</span>
        <button type="button" className="btn btn-ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button>
        <button type="button" className="btn btn-ghost" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>다음</button>
      </nav>}
    </>}
  </section>;
}
