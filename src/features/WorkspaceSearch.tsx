'use client';

import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleDot, Search } from 'lucide-react';
import type { FeatureProps, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import {
  DEFAULT_WORKSPACE_SEARCH_FILTERS, WORKSPACE_SEARCH_INPUT_LIMIT, issueSearchAliasLabel, normalizeWorkspaceSearchInput,
  searchWorkspace, workspaceSearchLabels, type WorkspaceSearchFilters,
} from '../../shared/workspace-search';

type Props = Pick<FeatureProps, 'openIssue' | 'openDocument'> & {
  data: WorkspaceSnapshot;
  filters: WorkspaceSearchFilters;
  onChange: (next: WorkspaceSearchFilters) => boolean;
};

type Criteria = Omit<WorkspaceSearchFilters, 'page'>;

function criteria({ query, kind, scope, label }: WorkspaceSearchFilters): Criteria {
  return { query, kind, scope, label };
}

function sameCriteria(left: Criteria, right: Criteria): boolean {
  return left.query === right.query && left.kind === right.kind && left.scope === right.scope && left.label === right.label;
}

const sortProjects = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export function WorkspaceSearch({ data, filters, onChange, openIssue, openDocument }: Props) {
  const resultsId = useId();
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const [applied, setApplied] = useState(() => criteria(filters));
  const [draft, setDraft] = useState(applied);
  if (!sameCriteria(applied, filters)) {
    const next = criteria(filters);
    setApplied(next);
    setDraft(next);
  }

  const projects = useMemo(() => [...data.projects].sort((left, right) => sortProjects.compare(left.name, right.name)
    || sortProjects.compare(left.key, right.key)), [data.projects]);
  const projectsById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const labels = useMemo(() => workspaceSearchLabels(data, draft.scope), [data, draft.scope]);
  const results = useMemo(() => searchWorkspace(data, filters), [data, filters]);
  const missingScope = draft.scope && draft.scope !== 'common' && !projects.some(project => draft.scope === `project:${project.id}`);
  const missingLabel = draft.label && !labels.some(label => label.key === draft.label);
  const hasSearchTerm = Boolean(filters.query || filters.label);

  function focusResults() {
    requestAnimationFrame(() => resultsHeading.current?.focus());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = { ...draft, query: normalizeWorkspaceSearchInput(draft.query), page: DEFAULT_WORKSPACE_SEARCH_FILTERS.page };
    if (onChange(next)) {
      setDraft(criteria(next));
      focusResults();
    }
  }

  function changeScope(scope: string) {
    const label = draft.label && workspaceSearchLabels(data, scope).some(entry => entry.key === draft.label) ? draft.label : '';
    setDraft({ ...draft, scope, label });
  }

  function movePage(page: number) {
    if (page < DEFAULT_WORKSPACE_SEARCH_FILTERS.page || page > results.pageCount || page === results.page) return;
    if (onChange({ ...filters, page })) focusResults();
  }

  return <div className="page workspace-search-page">
    <div className="page-heading"><h1>업무·문서 검색</h1></div>
    <form className="card workspace-search-filters" aria-label="업무·문서 검색 조건" onSubmit={submit}>
      <label className="workspace-search-query">검색어
        <input className="field" type="search" value={draft.query} maxLength={WORKSPACE_SEARCH_INPUT_LIMIT}
          placeholder="업무 번호, 제목, 문서 내용, GitLab 링크·참조"
          onChange={event => setDraft({ ...draft, query: event.currentTarget.value })} />
      </label>
      <label>검색 대상
        <select className="field" value={draft.kind} onChange={event => {
          const kind = event.currentTarget.value === 'issue' ? 'issue' : event.currentTarget.value === 'document' ? 'document' : 'all';
          setDraft({ ...draft, kind, label: kind === 'document' ? draft.label : '' });
        }}>
          <option value="all">전체</option>
          <option value="issue">업무</option>
          <option value="document">문서</option>
        </select>
      </label>
      <label>검색 공간
        <select className="field" value={draft.scope} onChange={event => changeScope(event.currentTarget.value)}>
          <option value="">전체 공간</option>
          <option value="common">팀 공통</option>
          {missingScope && <option value={draft.scope} disabled>현재 목록에 없는 공간</option>}
          {projects.map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
        </select>
      </label>
      <label>문서 라벨
        <select className="field" value={draft.label} disabled={draft.kind === 'issue'}
          onChange={event => {
            const label = event.currentTarget.value;
            setDraft({ ...draft, label, kind: label ? 'document' : draft.kind });
          }}>
          <option value="">모든 라벨</option>
          {missingLabel && <option value={draft.label} disabled>{draft.label} (현재 목록에 없음)</option>}
          {labels.map(label => <option key={label.key} value={label.key}>{label.name}</option>)}
        </select>
      </label>
      <button className="btn btn-primary" type="submit"><Search size={16} aria-hidden="true" />검색</button>
    </form>
    <section className="card workspace-search-results" aria-labelledby={resultsId}>
      <header className="workspace-search-results-heading">
        <h2 id={resultsId} tabIndex={-1} ref={resultsHeading}>검색 결과</h2>
        <p role="status">검색 결과 {results.total.toLocaleString('ko-KR')}건</p>
      </header>
      {results.items.length > 0 ? <ul className="workspace-search-result-list" role="list">
        {results.items.map((result, index) => {
          const detailId = `${resultsId}-${index}`;
          if (result.kind === 'issue') {
            const { issue, excerpt, matchedAliases, matchedGitlab } = result;
            const project = projectsById.get(issue.projectId);
            const status = statusMeta(data, issue.projectId, issue.status);
            return <li key={`issue:${issue.id}`}>
              <button type="button" className="workspace-search-result" aria-label={`${issue.key} 업무 열기`} aria-describedby={detailId}
                onClick={() => openIssue(issue.id)}>
                <CircleDot size={18} style={{ color: status.color }} aria-hidden="true" />
                <span className="workspace-search-result-content" id={detailId}>
                  <span className="workspace-search-result-title"><span className="workspace-search-issue-key">{issue.key}</span><strong>{issue.title}</strong></span>
                  <span className="workspace-search-result-path">{project?.name ?? '프로젝트'} · {status.label}</span>
                  {(matchedAliases || matchedGitlab) && <span className="workspace-search-result-labels">
                    {matchedAliases?.map(alias => <span key={`${alias.source}:${alias.key}`} className="workspace-search-label">{issueSearchAliasLabel(alias)}</span>)}
                    {matchedGitlab && <span className="workspace-search-label">{matchedGitlab}</span>}
                  </span>}
                  {excerpt && <span className="workspace-search-excerpt">{excerpt}</span>}
                </span>
                <ChevronRight size={16} aria-hidden="true" className="workspace-search-result-arrow" />
              </button>
            </li>;
          }
          const { document, parentTitles, excerpt } = result;
          const title = document.title || '제목 없는 문서';
          const space = document.projectId === null ? '팀 공통' : projectsById.get(document.projectId)?.name ?? '프로젝트';
          const path = [space, ...parentTitles].join(' › ');
          return <li key={`document:${document.id}`}>
            <button type="button" className="workspace-search-result" aria-label={`${title} 문서 열기 · ${path}`}
              aria-describedby={excerpt ? detailId : undefined} onClick={() => openDocument(document.id)}>
              <BookOpen size={18} aria-hidden="true" />
              <span className="workspace-search-result-content">
                <span className="workspace-search-result-title"><strong>{title}</strong></span>
                <span className="workspace-search-result-path">{path}</span>
                {excerpt && <span className="workspace-search-excerpt" id={detailId}>{excerpt}</span>}
                {document.labels?.length ? <span className="workspace-search-result-labels">
                  {document.labels.map(label => <span key={label} className="workspace-search-label">{label}</span>)}
                </span> : null}
              </span>
              <ChevronRight size={16} aria-hidden="true" className="workspace-search-result-arrow" />
            </button>
          </li>;
        })}
      </ul> : <p className="workspace-search-empty">{hasSearchTerm ? '조건에 맞는 업무나 문서가 없습니다.' : '검색어를 입력하거나 문서 라벨을 선택하세요.'}</p>}
      {results.pageCount > 1 && <nav className="workspace-search-pagination" aria-label="검색 결과 페이지">
        <button className="btn" type="button" disabled={results.page <= DEFAULT_WORKSPACE_SEARCH_FILTERS.page}
          aria-label="검색 결과 이전 페이지" onClick={() => movePage(results.page - 1)}><ChevronLeft size={15} aria-hidden="true" />이전</button>
        <span>{results.page} / {results.pageCount} 페이지</span>
        <button className="btn" type="button" disabled={results.page >= results.pageCount}
          aria-label="검색 결과 다음 페이지" onClick={() => movePage(results.page + 1)}>다음<ChevronRight size={15} aria-hidden="true" /></button>
      </nav>}
    </section>
  </div>;
}
