'use client';

import { useId, useState, type RefObject } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { FeatureProps, Issue, WorkflowStatus } from '../../shared/types';
import './issue-board-capacity.css';

export interface BoardStatusCapacity {
  status: WorkflowStatus;
  limit: number;
  issues: Issue[];
}

type OpenCapacity = (statusId: string, opener: HTMLButtonElement) => void;

export function BoardCapacitySummary({ columns, open }: { columns: BoardStatusCapacity[]; open: OpenCapacity }) {
  const over = columns.filter(column => column.issues.length > column.limit);
  if (!over.length) return null;
  return <div className="board-capacity-summary" role="region" aria-label="보드 한도 초과">
    <span><TriangleAlert size={15} aria-hidden="true" />한도 초과</span>
    {over.map(({ status, issues, limit }) => <button type="button" key={status.id} className="btn btn-ghost"
      aria-label={`${status.label} 한도 초과 업무 보기`} onClick={event => open(status.id, event.currentTarget)}>
      <strong>{status.label}</strong> {`${(issues.length - limit).toLocaleString()}개 초과`}
    </button>)}
  </div>;
}

export function BoardCapacityNote({ value, visible, open }: { value: BoardStatusCapacity; visible: number; open: OpenCapacity }) {
  const { status, issues, limit } = value;
  const excess = issues.length - limit;
  if (excess < 0 && visible >= issues.length) return null;
  return <div className="board-capacity-note" data-limit-state={excess > 0 ? 'over' : excess === 0 ? 'at' : 'under'}>
    {excess >= 0 && <strong>{excess === 0 ? '한도 도달' : `${excess.toLocaleString()}개 초과`}</strong>}
    {visible < issues.length && <>
      <span>표시 {visible.toLocaleString()}개</span>
      <button type="button" className="btn btn-ghost" aria-label={`${status.label} 전체 업무 보기`}
        onClick={event => open(status.id, event.currentTarget)}>전체 업무 보기</button>
    </>}
  </div>;
}

const pageSize = 25;

export function BoardCapacityDetails({ value, visibleIds, users, heading, openIssue, close }: {
  value: BoardStatusCapacity;
  visibleIds: ReadonlySet<string>;
  users: FeatureProps['data']['users'];
  heading: RefObject<HTMLHeadingElement | null>;
  openIssue: (id: string, source: { opener: HTMLElement; fallback: HTMLElement | null }) => void;
  close: () => void;
}) {
  const headingId = useId();
  const { status, issues, limit } = value;
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((issues.length - 1) / pageSize) * pageSize));
  const end = Math.min(start + pageSize, issues.length);
  const visible = issues.reduce((count, issue) => count + Number(visibleIds.has(issue.id)), 0);
  const names = new Map(users.map(user => [user.id, user.name]));

  return <section className="card board-capacity-details" aria-labelledby={headingId}>
    <header>
      <div>
        <h2 tabIndex={-1} id={headingId} ref={heading}>{status.label} 한도 업무</h2>
        <p>프로젝트 전체 {issues.length.toLocaleString()}개 · 한도 {limit.toLocaleString()}개
          {visible < issues.length && ` · 현재 보드 필터 밖 ${(issues.length - visible).toLocaleString()}개`}</p>
      </div>
      <button type="button" className="btn btn-ghost" aria-label="한도 업무 닫기" onClick={close}><X size={16} aria-hidden="true" />닫기</button>
    </header>
    {issues.length ? <ul className="board-capacity-issues" aria-label={`${status.label} 프로젝트 전체 업무`}>
      {issues.slice(start, end).map(issue => <li key={issue.id}>
        <button type="button" aria-label={`${issue.key} ${issue.title}`}
          onClick={event => openIssue(issue.id, { opener: event.currentTarget, fallback: heading.current })}>
          <small>{issue.key}</small><strong>{issue.title}</strong>
        </button>
        <span>{issue.assigneeId ? names.get(issue.assigneeId) || '담당자 확인 불가' : '미배정'}</span>
        {!visibleIds.has(issue.id) && <span className="board-capacity-filtered">필터 밖</span>}
      </li>)}
    </ul> : <p className="board-capacity-empty">이 상태의 업무가 없습니다.</p>}
    {issues.length > pageSize && <div className="board-capacity-pagination">
      <small>{start + 1}–{end} / {issues.length}</small>
      <button type="button" className="btn btn-ghost" aria-label="한도 업무 이전 페이지" disabled={start === 0} onClick={() => setOffset(start - pageSize)}>이전</button>
      <button type="button" className="btn btn-ghost" aria-label="한도 업무 다음 페이지" disabled={end >= issues.length} onClick={() => setOffset(end)}>다음</button>
    </div>}
  </section>;
}
