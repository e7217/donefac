'use client';

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Inbox, RefreshCw, Search, Send } from 'lucide-react';
import {
  DOCUMENT_PUBLICATION_MAX_OFFSET, DOCUMENT_PUBLICATION_PAGE_SIZE as PAGE_SIZE, DOCUMENT_PUBLICATION_QUERY_LIMIT,
  normalizeDocumentPublicationQuery, sameDocumentPublicationCriteria,
  type DocumentPublicationCriteria, type DocumentPublicationReturnTarget,
} from '../../shared/document-publication-route';
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
  tab: DocumentPublicationListTab;
  criteria: DocumentPublicationCriteria;
  onTabChange: (tab: DocumentPublicationListTab) => void;
  onCriteriaChange: (criteria: DocumentPublicationCriteria, mode: 'push' | 'replace') => boolean;
  onOpenPublication: (documentId: string, kind: 'review' | 'published', revisionId: string) => void;
  returnFocus?: DocumentPublicationReturnTarget | null;
}

type LoadedList = { result: PublicationList; query: string };
type ListRead = { key: string; loaded: LoadedList | null } & (
  { kind: 'loading' | 'ready' } | { kind: 'error'; message: string }
);

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
  return <PublicationListView key={JSON.stringify([props.projectId, props.actorId, props.tab, props.data.restoreGeneration])} {...props} />;
}

function PublicationListView({
  data,
  actorId,
  tab,
  criteria,
  onTabChange,
  onCriteriaChange,
  onOpenPublication,
  returnFocus,
}: DocumentPublicationLibraryProps) {
  const { scope, projectId: filterProjectId, query, offset } = criteria;
  const readKey = JSON.stringify([tab, actorId, scope, filterProjectId, query, offset]);
  const [search, setSearch] = useState(() => ({ criteria, value: query, composing: false }));
  if (!sameDocumentPublicationCriteria(search.criteria, criteria)) setSearch({ criteria, value: query, composing: false });
  const [read, setRead] = useState<ListRead | null>(null);
  const request = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const consumedFocus = useRef<string | null>(null);
  const focusKey = returnFocus ? JSON.stringify([returnFocus.documentId, returnFocus.kind, returnFocus.revisionId]) : null;
  const loaded = read?.loaded;
  const result = loaded?.result;
  const searchQuery = normalizeDocumentPublicationQuery(search.value);
  const debouncePending = search.composing || searchQuery !== query;
  const currentRead = read?.key === readKey ? read : null;
  const loading = !currentRead || currentRead.kind === 'loading';
  const error = currentRead?.kind === 'error' ? currentRead.message : '';
  const fresh = currentRead?.kind === 'ready' && result;
  const clampedOffset = fresh && offset > 0 && offset >= fresh.total
    ? Math.floor(Math.max(0, fresh.total - 1) / PAGE_SIZE) * PAGE_SIZE : null;
  const usableResult = Boolean(fresh && !debouncePending && clampedOffset === null);
  const selectedProject = data.projects.find((project) => project.id === filterProjectId);
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
    setRead(previous => ({ key: readKey, kind: 'loading', loaded: previous?.loaded ?? null }));
    const params = new URLSearchParams({ tab, scope, offset: String(offset) });
    if (scope === 'project') params.set('projectId', filterProjectId);
    if (query) params.set('q', query);
    try {
      const response = await api<PublicationList>(`/document-publications?${params}`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { 'X-Actor-Id': actorId },
      });
      if (request.current !== controller || controller.signal.aborted) return;
      if (response.tab !== tab || response.scope !== scope || response.offset !== offset ||
          response.projectId !== (scope === 'project' ? filterProjectId : null) ||
          !Number.isSafeInteger(response.total) || response.total < 0 || !Array.isArray(response.items)) {
        throw new Error('현재 조회 조건의 문서 목록인지 확인할 수 없습니다.');
      }
      setRead({ key: readKey, kind: 'ready', loaded: { result: response, query } });
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) {
        setRead(previous => ({ key: readKey, kind: 'error', loaded: previous?.loaded ?? null,
          message: `${messageOf(cause)} 선택한 조건과 이전 조회 결과는 유지됩니다.` }));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [actorId, filterProjectId, offset, query, readKey, scope, tab]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  useEffect(() => {
    const changed = () => {
      void load();
    };
    window.addEventListener('teamspace:publication-changed', changed);
    return () => window.removeEventListener('teamspace:publication-changed', changed);
  }, [load]);
  const applySearch = useEffectEvent((key: string, requestedQuery: string) => {
    if (key === readKey && !search.composing && requestedQuery === searchQuery && requestedQuery !== query) {
      onCriteriaChange({ ...criteria, query: requestedQuery, offset: 0 }, 'replace');
    }
  });
  useEffect(() => {
    if (search.composing || searchQuery === query) return;
    const timer = setTimeout(() => applySearch(readKey, searchQuery), 300);
    return () => clearTimeout(timer);
  }, [query, readKey, search.composing, searchQuery]);

  const clampPage = useEffectEvent(() => {
    if (clampedOffset !== null && !debouncePending) onCriteriaChange({ ...criteria, offset: clampedOffset }, 'replace');
  });
  useEffect(() => {
    if (clampedOffset !== null && !debouncePending) clampPage();
  }, [clampedOffset, debouncePending, readKey]);

  useLayoutEffect(() => {
    if (!focusKey) { consumedFocus.current = null; return; }
    if (!usableResult || consumedFocus.current === focusKey) return;
    consumedFocus.current = focusKey;
    if (document.activeElement === document.body || document.activeElement === document.documentElement) {
      (returnButton.current ?? resultHeading.current)?.focus();
    }
  }, [focusKey, usableResult]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (search.composing) return;
    if (searchQuery === query && offset === 0) void load();
    else onCriteriaChange({ ...criteria, query: searchQuery, offset: 0 }, 'push');
  }

  function changePage(next: number) {
    if (usableResult && next >= 0 && next <= DOCUMENT_PUBLICATION_MAX_OFFSET) {
      onCriteriaChange({ ...criteria, offset: next }, 'push');
    }
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
              onClick={() => { if (value !== tab) onTabChange(value); }}
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
              onChange={event => onCriteriaChange({ ...criteria, scope: event.currentTarget.value as Scope, query: searchQuery, offset: 0 }, 'push')}
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
                onChange={event => onCriteriaChange({ ...criteria, projectId: event.currentTarget.value, query: searchQuery, offset: 0 }, 'push')}
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
                value={search.value}
                onChange={event => setSearch({ ...search, value: event.currentTarget.value })}
                onCompositionStart={() => setSearch({ ...search, composing: true })}
                onCompositionEnd={event => setSearch({ ...search, value: event.currentTarget.value, composing: false })}
                maxLength={DOCUMENT_PUBLICATION_QUERY_LIMIT}
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
            <h2 ref={resultHeading} tabIndex={-1}>{TAB_LABELS[tab]}</h2>
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
            {loading || clampedOffset !== null ? '목록을 불러오는 중…' : debouncePending ? '검색어를 반영하는 중…' : ''}
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
                const restoreRow = returnFocus?.documentId === item.documentId && returnFocus.kind === kind && returnFocus.revisionId === item.revision.id;
                const reviewers = item.reviewerIds?.map(person);
                const reviewerLabel = reviewers ? `${reviewers.slice(0, 2).join(', ')}${reviewers.length > 2 ? ` 외 ${reviewers.length - 2}명` : ''}`
                  : person(item.reviewerId);
                return (
                  <li key={`${item.documentId}:${item.revision.id}`}>
                    <button
                      type="button"
                      ref={restoreRow ? returnButton : undefined}
                      className="publication-library-document"
                      aria-label={`${item.revision.title} ${kindLabel} 열기`}
                      disabled={!usableResult}
                      onClick={() => onOpenPublication(item.documentId, kind, item.revision.id)}
                    >
                      <span className="publication-library-document-title">
                        <span className="publication-library-document-meta">
                          <span className={`publication-library-status is-${item.status}`}>
                            {STATUS_LABELS[item.status]}
                          </span>
                          <span>{projectName(item.projectId)}</span>
                          {reviewers && kind === 'review' && <span>승인 {item.approvedCount ?? 0}/{reviewers.length}</span>}
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
                        <span title={reviewers?.join(', ')}>
                          <small>검토</small>
                          {reviewerLabel}
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
          usableResult && (
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
              disabled={!usableResult || result.offset === 0}
              onClick={() => changePage(Math.max(0, result.offset - PAGE_SIZE))}
            >
              이전
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="검토·발행 다음 페이지"
              disabled={!usableResult || result.offset + PAGE_SIZE >= result.total || result.offset + PAGE_SIZE > DOCUMENT_PUBLICATION_MAX_OFFSET}
              onClick={() => changePage(result.offset + PAGE_SIZE)}
            >
              다음
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
