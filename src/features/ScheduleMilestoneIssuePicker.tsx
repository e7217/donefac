'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';
import { issueSearchAliasLabel, searchIssueCandidates, WORKSPACE_SEARCH_QUERY_LIMIT } from '../../shared/workspace-search';

const PAGE_SIZE = 20;

type Props = {
  issues: readonly Issue[];
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  selectedIds: readonly string[];
  onChange: (next: string[]) => void;
  onOpenIssue: (id: string, opener: HTMLButtonElement, issueIds: readonly string[]) => void;
};

export function ScheduleMilestoneIssuePicker({ issues, issueAliases, selectedIds, onChange, onOpenIssue }: Props) {
  const headingId = useId();
  const resultList = useRef<HTMLUListElement>(null);
  const selectionFilter = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const candidateIds = useMemo(() => new Set(issues.map(issue => issue.id)), [issues]);
  const unavailableCount = selectedIds.filter(id => !candidateIds.has(id)).length;
  const matches = useMemo(() => searchIssueCandidates({ issueAliases },
    selectedOnly ? issues.filter(issue => selected.has(issue.id)) : issues, query), [issueAliases, issues, query, selected, selectedOnly]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * PAGE_SIZE;
  const visibleCandidates = matches.slice(offset, offset + PAGE_SIZE);

  function goToPage(next: number) {
    setPage(next);
    if (resultList.current) resultList.current.scrollTop = 0;
  }

  return <section className="schedule-form-wide schedule-milestone-issues" aria-labelledby={headingId}>
    <h3 id={headingId}>이정표 연결 업무 선택</h3>
    <div className="schedule-milestone-picker-controls">
      <label>이정표 연결 업무 검색
        <input className="field" type="search" value={query} maxLength={WORKSPACE_SEARCH_QUERY_LIMIT}
          placeholder="업무 키, 이전 키 또는 제목" onChange={event => { setQuery(event.currentTarget.value); goToPage(0); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} />
      </label>
      <label className="schedule-milestone-selected-filter">
        <input ref={selectionFilter} type="checkbox" checked={selectedOnly}
          onChange={event => { setSelectedOnly(event.currentTarget.checked); goToPage(0); }} />선택한 업무만
      </label>
      <span role="status">선택 {selectedIds.length.toLocaleString('ko-KR')}개</span>
    </div>
    {unavailableCount > 0 && <div className="schedule-milestone-unavailable">
      <p>현재 프로젝트에서 확인할 수 없는 선택 업무 {unavailableCount.toLocaleString('ko-KR')}개</p>
      <button type="button" className="btn btn-ghost" onClick={() => {
        onChange(selectedIds.filter(id => candidateIds.has(id)));
        selectionFilter.current?.focus({ preventScroll: true });
      }}>연결할 수 없는 선택 해제</button>
    </div>}
    {visibleCandidates.length ? <ul className="schedule-milestone-candidates" aria-label="이정표 연결 후보" role="list" ref={resultList}>
      {visibleCandidates.map(({ issue, matchedAliases }) => <li key={issue.id} data-issue-id={issue.id}>
        <label>
          <input type="checkbox" aria-label={`${issue.key} 이정표 연결`} checked={selected.has(issue.id)}
            onChange={event => onChange(event.currentTarget.checked ? [...selectedIds, issue.id] : selectedIds.filter(id => id !== issue.id))} />
          <span>
            <strong>{issue.key}</strong>{' '}{issue.title}
            {matchedAliases.map(alias => <small key={`${alias.source}:${alias.key}`}>{issueSearchAliasLabel(alias)}</small>)}
          </span>
        </label>
        <button type="button" className="btn btn-ghost" aria-label={`${issue.key} 상세`}
          onClick={event => onOpenIssue(issue.id, event.currentTarget, matches.map(match => match.issue.id))}>상세</button>
      </li>)}
    </ul> : <p className="schedule-milestone-picker-empty" role="status">
      {selectedOnly && !selected.size ? '선택한 업무가 없습니다.' : '조건에 맞는 업무가 없습니다.'}
    </p>}
    {lastPage > 0 && <nav className="schedule-milestone-picker-pages" aria-label="이정표 연결 후보 페이지">
      <span aria-live="polite">{offset + 1}–{offset + visibleCandidates.length} / {matches.length.toLocaleString('ko-KR')}개</span>
      <button type="button" className="btn btn-ghost" aria-label="이정표 연결 후보 이전 페이지" disabled={currentPage === 0}
        onClick={() => goToPage(currentPage - 1)}>이전</button>
      <button type="button" className="btn btn-ghost" aria-label="이정표 연결 후보 다음 페이지" disabled={currentPage === lastPage}
        onClick={() => goToPage(currentPage + 1)}>다음</button>
    </nav>}
  </section>;
}
