'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Inbox, RefreshCw, Search, Send } from 'lucide-react';
import type {
  DocumentPublicationList as PublicationList,
  DocumentPublicationListItem as ListItem,
  DocumentPublicationListTab,
  DocumentPublicationScope as Scope,
  FeatureProps,
} from '../../shared/types';
import { api } from '../lib/api';
import './document-publication-library.css';

export interface DocumentPublicationLibraryProps extends FeatureProps {
  initialTab?: DocumentPublicationListTab;
  onOpenPublication: (documentId: string, kind: 'review' | 'published', revisionId: string) => void;
  onTabChange?: (tab: DocumentPublicationListTab) => void;
}

type Criteria = { scope: Scope; projectId: string; query: string; offset: number };
type LoadedList = { result: PublicationList; query: string };

const PAGE_SIZE = 30;
const TAB_LABELS: Record<DocumentPublicationListTab, string> = {
  assigned: '내 검토',
  requested: '내 요청',
  published: '발행본',
};
const TAB_DESCRIPTIONS: Record<DocumentPublicationListTab, string> = {
  assigned: '내가 검토할 문서와 수정 요청을 보낸 문서를 확인하세요.',
  requested: '내가 요청한 문서 검토의 진행 상태를 확인하세요.',
  published: '검토를 마친 문서의 발행 당시 저장본을 확인하세요.',
};
const STATUS_LABELS: Record<ListItem['status'], string> = {
  pending: '검토 대기',
  changes_requested: '수정 요청',
  published: '발행됨',
};
const TABS: DocumentPublicationListTab[] = ['assigned', 'requested', 'published'];
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : '문서 목록을 불러오지 못했습니다.';
const timestamp = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function DocumentPublicationLibrary(props: DocumentPublicationLibraryProps) {
  const [localTab, setLocalTab] = useState<DocumentPublicationListTab>('assigned');
  const tab = props.initialTab ?? localTab;
  function selectTab(next: DocumentPublicationListTab) {
    if (next === tab) return;
    if (props.initialTab === undefined) setLocalTab(next);
    props.onTabChange?.(next);
  }
  return (
    <PublicationListView
      key={`${props.projectId}:${props.actorId}:${tab}`}
      {...props}
      tab={tab}
      selectTab={selectTab}
    />
  );
}

function PublicationListView({
  data,
  projectId,
  actorId,
  tab,
  selectTab,
  onOpenPublication,
}: DocumentPublicationLibraryProps & {
  tab: DocumentPublicationListTab;
  selectTab: (tab: DocumentPublicationListTab) => void;
}) {
  const currentProject = data.projects.find((project) => project.id === projectId);
  const [criteria, setCriteria] = useState<Criteria>(() => ({
    scope: tab === 'published' && currentProject ? 'project' : 'workspace',
    projectId: currentProject?.id ?? data.projects[0]?.id ?? '',
    query: '',
    offset: 0,
  }));
  const [searchInput, setSearchInput] = useState('');
  const [loaded, setLoaded] = useState<LoadedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const result = loaded?.result;
  const debouncePending = searchInput.trim() !== criteria.query;
  const selectedProject = data.projects.find((project) => project.id === criteria.projectId);
  const person = (id: string) =>
    data.users.find((user) => user.id === id)?.name ?? '현재 목록에 없는 팀원';
  const projectName = (id: string | null) =>
    id === null
      ? '공통 문서'
      : (data.projects.find((project) => project.id === id)?.name ?? '현재 목록에 없는 프로젝트');

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const ownSequence = ++sequence.current;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ tab, scope: criteria.scope, offset: String(criteria.offset) });
    if (criteria.scope === 'project') query.set('projectId', criteria.projectId);
    if (criteria.query) query.set('q', criteria.query);
    try {
      const response = await api<PublicationList>(`/document-publications?${query}`, {
        signal: controller.signal,
        headers: { 'X-Actor-Id': actorId },
      });
      if (!active.current || controller.signal.aborted || sequence.current !== ownSequence) return;
      setLoaded({ result: response, query: criteria.query });
    } catch (cause) {
      if (active.current && !controller.signal.aborted && sequence.current === ownSequence)
        setError(`${messageOf(cause)} 선택한 조건과 이전 조회 결과는 유지됩니다.`);
    } finally {
      if (active.current && !controller.signal.aborted && sequence.current === ownSequence)
        setLoading(false);
    }
  }, [actorId, tab, criteria]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    const changed = () => {
      void load();
    };
    window.addEventListener('teamspace:publication-changed', changed);
    return () => window.removeEventListener('teamspace:publication-changed', changed);
  }, [load]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const query = searchInput.trim();
      setCriteria((previous) =>
        previous.query === query ? previous : { ...previous, query, offset: 0 },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function invalidate() {
    request.current?.abort();
    sequence.current++;
    setLoading(false);
  }

  function changeScope(scope: Scope) {
    invalidate();
    setCriteria((previous) => ({ ...previous, scope, offset: 0 }));
  }

  function changeProject(id: string) {
    invalidate();
    setCriteria((previous) => ({ ...previous, projectId: id, offset: 0 }));
  }

  function changeSearch(value: string) {
    setSearchInput(value);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchInput.trim();
    if (query === criteria.query && criteria.offset === 0) void load();
    else {
      invalidate();
      setCriteria((previous) => ({ ...previous, query, offset: 0 }));
    }
  }

  function page(offset: number) {
    invalidate();
    setCriteria((previous) => ({ ...previous, offset }));
  }

  const resultScope =
    result?.scope === 'workspace'
      ? '전체 워크스페이스'
      : result?.scope === 'common'
        ? '공통 문서'
        : result
          ? projectName(result.projectId)
          : '';

  return (
    <section className="document-publication-library" aria-label="문서 검토·발행 목록">
      <header className="publication-library-heading">
        <div>
          <h1>
            <BookOpen size={25} aria-hidden="true" />
            검토·발행
          </h1>
          <p>팀의 문서 검토와 발행본을 한곳에서 확인하세요.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="검토·발행 목록 새로고침"
          disabled={loading || debouncePending}
          onClick={() => void load()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          새로고침
        </button>
      </header>

      <div className="publication-library-tabs" role="tablist" aria-label="검토·발행 목록 종류">
        {TABS.map((value) => {
          const Icon = value === 'assigned' ? Inbox : value === 'requested' ? Send : CheckCircle2;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-label={TAB_LABELS[value]}
              aria-description={
                value === 'assigned' && result ? `검토 대기 ${result.pendingAssigned}건` : undefined
              }
              aria-selected={tab === value}
              aria-controls="publication-library-results"
              onClick={() => selectTab(value)}
            >
              <Icon size={16} aria-hidden="true" />
              {TAB_LABELS[value]}
              {value === 'assigned' && result && (
                <span aria-hidden="true">{result.pendingAssigned}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="publication-library-filters">
        <div className="publication-library-scope">
          <label>
            조회 범위
            <select
              className="field"
              aria-label="검토·발행 조회 범위"
              value={criteria.scope}
              onChange={(event) => changeScope(event.target.value as Scope)}
            >
              <option value="workspace">전체 워크스페이스</option>
              <option value="project" disabled={!data.projects.length}>
                프로젝트
              </option>
              <option value="common">공통 문서</option>
            </select>
          </label>
          {criteria.scope === 'project' && (
            <label>
              프로젝트
              <select
                className="field"
                aria-label="검토·발행 프로젝트"
                value={criteria.projectId}
                onChange={(event) => changeProject(event.target.value)}
              >
                {criteria.projectId && !selectedProject && (
                  <option value={criteria.projectId}>현재 목록에 없는 프로젝트</option>
                )}
                {data.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.key} · {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <form className="publication-library-search" role="search" onSubmit={submitSearch}>
          <label>
            문서 제목 검색
            <span>
              <Search size={16} aria-hidden="true" />
              <input
                className="field"
                aria-label="검토·발행 문서 검색"
                value={searchInput}
                onChange={(event) => changeSearch(event.target.value)}
                maxLength={200}
                placeholder="검토본·발행본 제목 검색"
                type="search"
              />
            </span>
          </label>
          <button type="submit" className="btn" aria-label="검토·발행 검색 실행">
            검색
          </button>
        </form>
      </div>

      <div
        id="publication-library-results"
        role="tabpanel"
        aria-label={TAB_LABELS[tab]}
        className="publication-library-results"
      >
        <div className="publication-library-result-heading">
          <div>
            <h2>{TAB_LABELS[tab]}</h2>
            <p>{TAB_DESCRIPTIONS[tab]}</p>
          </div>
          {result && <strong>{result.total.toLocaleString('ko-KR')}개 문서</strong>}
        </div>
        <div className="publication-library-result-scope">
          {result ? (
            <span>
              표시 중: {resultScope}
              {loaded.query ? ` · 검색 ‘${loaded.query}’` : ''}
            </span>
          ) : (
            <span>검토 요청과 발행 기록이 있는 문서를 조회합니다.</span>
          )}
          <span role="status" aria-live="polite">
            {loading ? '목록을 불러오는 중…' : debouncePending ? '검색어를 반영하는 중…' : ''}
          </span>
        </div>
        {error && (
          <p className="publication-library-error" role="alert">
            {error}
          </p>
        )}
        {result && result.items.length > 0 ? (
          <>
            <div className="publication-library-columns" aria-hidden="true">
              <span>문서와 저장 버전</span>
              <span>요청자 · 검토자</span>
              <span>최근 처리</span>
              <span />
            </div>
            <ul className="publication-library-list" aria-label="검토·발행 문서">
              {result.items.map((item) => {
                const kind = item.status === 'published' ? 'published' : 'review';
                const kindLabel = kind === 'published' ? '발행본' : '검토본';
                return (
                  <li key={`${item.documentId}:${item.revision.id}`}>
                    <button
                      type="button"
                      className="publication-library-document"
                      aria-label={`${item.revision.title} ${kindLabel} 열기`}
                      disabled={loading || debouncePending}
                      onClick={() => onOpenPublication(item.documentId, kind, item.revision.id)}
                    >
                      <span className="publication-library-document-title">
                        <span className="publication-library-document-meta">
                          <span className={`publication-library-status is-${item.status}`}>
                            {STATUS_LABELS[item.status]}
                          </span>
                          <span>{projectName(item.projectId)}</span>
                        </span>
                        <strong>{item.revision.title}</strong>
                        <span className="publication-library-revision">
                          {kindLabel} · 버전 {item.revision.version}
                          {item.documentVersion > item.revision.version && <em>이후 편집 있음</em>}
                        </span>
                      </span>
                      <span className="publication-library-people">
                        <span>
                          <small>요청</small>
                          {person(item.requestedById)}
                        </span>
                        <span>
                          <small>검토</small>
                          {person(item.reviewerId)}
                        </span>
                      </span>
                      <time dateTime={item.actionAt}>{timestamp(item.actionAt)}</time>
                      <ArrowUpRight size={17} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          !loading &&
          !error && (
            <div className="publication-library-empty">
              <BookOpen size={30} aria-hidden="true" />
              <h3>
                {criteria.query
                  ? '검색 결과가 없습니다'
                  : tab === 'published'
                    ? '발행한 문서가 없습니다'
                    : tab === 'assigned'
                      ? '내게 요청된 검토가 없습니다'
                      : '요청한 검토가 없습니다'}
              </h3>
              <p>
                {criteria.query
                  ? '다른 제목이나 조회 범위로 찾아보세요.'
                  : '문서에서 검토를 요청하면 이 목록에서 확인할 수 있습니다.'}
              </p>
            </div>
          )
        )}
        {result && (
          <nav className="publication-library-pagination" aria-label="검토·발행 목록 페이지">
            <span>
              {result.items.length ? result.offset + 1 : 0}–
              {result.items.length ? result.offset + result.items.length : 0} /{' '}
              {result.total.toLocaleString('ko-KR')}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="검토·발행 이전 페이지"
              disabled={loading || debouncePending || result.offset === 0}
              onClick={() => page(Math.max(0, result.offset - PAGE_SIZE))}
            >
              이전
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="검토·발행 다음 페이지"
              disabled={loading || debouncePending || result.offset + PAGE_SIZE >= result.total}
              onClick={() => page(result.offset + PAGE_SIZE)}
            >
              다음
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
