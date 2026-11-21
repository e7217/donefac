'use client';

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { DecisionFollowUpItem, DecisionFollowUpPage, DecisionFollowUpSource, FeatureProps } from '../../shared/types';
import { api } from '../lib/api';
import {
  decisionFollowUpQuery, MAX_DECISION_FOLLOW_UP_SEARCH_LENGTH, sameDecisionFollowUpScope, type DecisionFollowUpScope,
} from '../lib/decision-follow-up-route';
import './decision-follow-ups-report.css';

const DocumentDecisionRevision = lazy(() => import('./DocumentBlocks').then(module => ({ default: module.DocumentDecisionRevision })));
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'notify' | 'openIssue' | 'refresh'> & {
  scope: DecisionFollowUpScope;
  onScopeChange: (scope: DecisionFollowUpScope) => boolean;
  issueOverlayOpen: boolean;
};
type Options = Omit<DecisionFollowUpScope, 'offset'>;
type Result = { scope: DecisionFollowUpScope; page: DecisionFollowUpPage | null; loading: boolean; error?: string };
const numberLabel = (count: number) => count.toLocaleString('ko-KR');
const workspacePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/decision-follow-ups`;
function sameOptions(left: Options, right: Options): boolean {
  return left.projectId === right.projectId && left.status === right.status && left.assigneeId === right.assigneeId && left.q === right.q;
}

export function DecisionFollowUpsReport({ data, projectId, actorId, scope, onScopeChange, issueOverlayOpen, openIssue, refresh, notify }: Props) {
  const [applied, setApplied] = useState(scope);
  const [options, setOptions] = useState<Options>(scope);
  const [result, setResult] = useState<Result | null>(null);
  const [opening, setOpening] = useState<{ scope: DecisionFollowUpScope; token: symbol } | null>(null);
  const [lastIssues, setLastIssues] = useState(data.issues);
  const request = useRef<AbortController | null>(null);
  const issueRequest = useRef<symbol | null>(null);
  const issueOpener = useRef<HTMLButtonElement | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  if (!sameOptions(applied, scope)) {
    setApplied(scope);
    setOptions(scope);
  }
  // Hold the rows while the issue editor is open so its return-focus target remains mounted.
  if (!issueOverlayOpen && data.issues !== lastIssues) setLastIssues(data.issues);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult(previous => ({ scope, page: sameDecisionFollowUpScope(previous?.scope, scope) ? previous?.page ?? null : null, loading: true }));
    const projectPath = scope.projectId === undefined ? workspacePath(projectId) : '/decision-follow-ups';
    const parameters = decisionFollowUpQuery(scope);
    if (typeof scope.projectId === 'string') parameters.set('projectId', scope.projectId);
    const path = `${projectPath}${parameters.size ? `?${parameters}` : ''}`;
    try {
      const page = await api<DecisionFollowUpPage>(path, { signal: controller.signal, cache: 'no-store', headers: { 'X-Actor-Id': actorId } });
      if (!controller.signal.aborted) setResult({ scope, page, loading: false });
    } catch (cause) {
      if (!controller.signal.aborted) setResult(previous => ({
        scope, page: previous?.page ?? null, loading: false,
        error: cause instanceof Error ? cause.message : '결정 후속 업무를 불러오지 못했습니다.',
      }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [actorId, projectId, scope]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [lastIssues, load]);

  useEffect(() => () => { issueRequest.current = null; }, [actorId, projectId, scope]);

  const current = result && sameDecisionFollowUpScope(result.scope, scope) ? result : null;
  const page = current?.page;
  const loading = current?.loading ?? true;
  const openingIssue = opening !== null && sameDecisionFollowUpScope(opening.scope, scope);
  const projectSelection = options.projectId === undefined ? 'current' : options.projectId === null ? 'team' : `project:${options.projectId}`;
  useLayoutEffect(() => {
    if (!page || loading || issueOverlayOpen) return;
    const removedOpener = issueOpener.current && !issueOpener.current.isConnected;
    if (focusResults.current || (removedOpener && document.activeElement === document.body)) resultsHeading.current?.focus();
    if (removedOpener) issueOpener.current = null;
    focusResults.current = false;
  }, [issueOverlayOpen, loading, page]);

  function apply(event: FormEvent) {
    event.preventDefault();
    onScopeChange({ ...options, q: options.q.trim(), offset: 0 });
  }

  function changePage(offset: number) {
    if (!page || loading || offset === page.offset) return;
    if (onScopeChange({ ...scope, offset })) focusResults.current = true;
  }

  async function showIssue(issue: DecisionFollowUpItem['issue'], opener: HTMLButtonElement) {
    if (issueRequest.current) return;
    const cached = data.issues.find(value => value.id === issue.id);
    issueOpener.current = opener;
    opener.focus({ preventScroll: true });
    if (cached && cached.projectId === issue.projectId && cached.title === issue.title && cached.status === issue.status && cached.assigneeId === issue.assigneeId &&
        (cached.dueDate || cached.endDate || null) === issue.deadline) {
      openIssue(issue.id);
      return;
    }
    const token = Symbol();
    issueRequest.current = token;
    setOpening({ scope, token });
    try {
      await refresh();
      if (issueRequest.current === token) openIssue(issue.id);
    } catch (cause) {
      if (issueRequest.current === token) notify(cause instanceof Error ? cause.message : '업무를 불러오지 못했습니다.', 'error');
    } finally {
      setOpening(previous => previous?.token === token ? null : previous);
      if (issueRequest.current === token) issueRequest.current = null;
    }
  }

  return <div className="decision-follow-ups-report">
    <form className="card decision-follow-ups-query" aria-label="결정 후속 업무 조회 조건" onSubmit={apply}>
      <header>
        <h2>결정 후속 업무</h2>
        <button className="btn" type="button" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />결정 후속 업무 새로고침
        </button>
      </header>
      <div className="decision-follow-ups-controls">
        <label>검색
          <input type="search" className="field" aria-label="결정 후속 업무 검색" placeholder="업무 키, 제목, 문서 제목"
            maxLength={MAX_DECISION_FOLLOW_UP_SEARCH_LENGTH} value={options.q}
            onChange={event => setOptions({ ...options, q: event.target.value })} />
        </label>
        <label className="decision-follow-ups-project">프로젝트
          <select className="field" aria-label="결정 후속 업무 프로젝트" value={projectSelection}
            onChange={event => {
              const selection = event.currentTarget.value;
              const projectId = selection === 'team' ? null : selection.startsWith('project:') ? selection.slice('project:'.length) : undefined;
              setOptions({ ...options, projectId });
            }}>
            <option value="current">현재 프로젝트</option>
            <option value="team">전체 프로젝트</option>
            {data.projects.filter(project => project.id !== projectId || options.projectId === projectId)
              .map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
          </select>
        </label>
        <label>업무 상태
          <select className="field" aria-label="결정 후속 업무 상태" value={options.status}
            onChange={event => setOptions({ ...options, status: event.target.value as Options['status'] })}>
            <option value="open">미완료</option><option value="closed">종료</option><option value="all">전체 상태</option>
          </select>
        </label>
        <label>담당자
          <select className="field" aria-label="결정 후속 업무 담당자" value={options.assigneeId}
            onChange={event => setOptions({ ...options, assigneeId: event.target.value })}>
            <option value="">전체 담당자</option><option value="unassigned">담당자 미지정</option>
            {data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" type="submit"><Search size={15} aria-hidden="true" />조건 적용</button>
      </div>
    </form>

    {current?.error && <p role="alert" className="reports-error">{current.error}</p>}
    {loading && <p role="status">결정 후속 업무를 불러오는 중입니다.</p>}
    {openingIssue && <p role="status">업무를 불러오는 중입니다.</p>}
    {page && <section className="decision-follow-ups-results" aria-label="결정 후속 업무 결과" aria-busy={loading}>
      <h3 ref={resultsHeading} tabIndex={-1}>결정 근거 {numberLabel(page.total)}건</h3>
      {page.items.length ? <ul className="decision-follow-ups-list" aria-label="결정 후속 업무 목록">
        {page.items.map(item => <li key={item.linkId}><DecisionFollowUpCard key={`${item.source.revisionId}:${item.source.from}:${item.source.to}`}
          item={item} data={data} showIssueProject={scope.projectId !== undefined} loading={openingIssue} open={showIssue} /></li>)}
      </ul> : <p className="card decision-follow-ups-empty">{page.total && page.offset ? '이 페이지에 표시할 결정 근거가 없습니다.' : '조건에 맞는 결정 후속 업무가 없습니다.'}</p>}
      {(page.total > page.limit || page.offset > 0) && <nav className="reports-pagination" aria-label="결정 후속 업무 페이지">
        <span>{page.items.length ? `${numberLabel(page.offset + 1)}–${numberLabel(page.offset + page.items.length)} / ` : ''}{numberLabel(page.total)}건</span>
        {page.offset > page.limit && !page.items.length && <button className="btn" type="button" disabled={loading} onClick={() => changePage(0)}>첫 페이지</button>}
        <button className="btn" type="button" disabled={loading || page.offset === 0}
          onClick={() => changePage(Math.max(0, page.offset - page.limit))}>이전 페이지</button>
        <button className="btn" type="button" disabled={loading || page.offset + page.limit >= page.total}
          onClick={() => changePage(page.offset + page.limit)}>다음 페이지</button>
      </nav>}
    </section>}
  </div>;
}

function DecisionFollowUpCard({ item, data, showIssueProject, loading, open }: {
  item: DecisionFollowUpItem;
  data: Props['data'];
  showIssueProject: boolean;
  loading: boolean;
  open: (issue: DecisionFollowUpItem['issue'], opener: HTMLButtonElement) => Promise<void>;
}) {
  const { linkId, issue, document, source } = item;
  const path = `${workspacePath(issue.projectId)}/${encodeURIComponent(linkId)}/source`;
  const { revisionId, version, from, to } = source;
  const documentId = document.id;
  const loadSelection = useCallback(async (signal: AbortSignal) => {
    const value = await api<DecisionFollowUpSource>(path, { signal, cache: 'no-store' });
    if (value.linkId !== linkId || value.documentId !== documentId || value.source.revisionId !== revisionId ||
        value.source.from !== from || value.source.to !== to) throw new Error('결정 근거 위치가 바뀌었습니다. 목록을 다시 조회하세요.');
    return value.source;
  }, [documentId, from, linkId, path, revisionId, to]);
  const assignee = data.users.find(user => user.id === issue.assigneeId);
  const issueProject = showIssueProject ? data.projects.find(project => project.id === issue.projectId) : undefined;
  const documentProject = data.projects.find(project => project.id === document.projectId);
  const documentSpace = document.projectId === null ? '팀 공통 문서' : documentProject?.name ?? '프로젝트 정보 없음';

  return <article className="card decision-follow-up" aria-label={`${issue.key} 결정 후속 업무`}>
    <h4><button className="decision-follow-up-issue" type="button" aria-label={`${issue.key} 업무 열기`} aria-disabled={loading}
      onClick={event => { if (!loading) void open(issue, event.currentTarget); }}>
      <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong><ChevronRight size={15} aria-hidden="true" />
    </button></h4>
    <dl className="decision-follow-up-details" data-show-issue-project={showIssueProject || undefined}>
      {showIssueProject && <div><dt>업무 프로젝트</dt><dd data-decision-issue-project={issue.projectId}>{issueProject?.name ?? '프로젝트 정보 없음'}</dd></div>}
      <div><dt>상태</dt><dd><i style={{ backgroundColor: issue.statusColor }} aria-hidden="true" />{issue.statusLabel}</dd></div>
      <div><dt>담당자</dt><dd>{assignee?.name ?? '미지정'}</dd></div>
      <div><dt>{issue.deadlineSource === 'endDate' ? '계획 종료일' : '목표 마감일'}</dt>
        <dd>{issue.deadline ? <time dateTime={issue.deadline}>{issue.deadline}</time> : '미정'}</dd></div>
    </dl>
    <p className="decision-follow-up-document"><BookOpen size={16} aria-hidden="true" />
      <span>{document.title || '제목 없는 문서'}<small data-decision-document-space={document.projectId ?? ''}>
        {showIssueProject && '문서 공간 · '}{documentSpace}</small></span>
    </p>
    <Suspense fallback={<p role="status">결정 근거 보기를 준비하고 있습니다.</p>}>
      <DocumentDecisionRevision data={data} documentId={documentId} revisionId={revisionId} expectedVersion={version}
        label={source.title} loadSelection={loadSelection} actionLabel={`${issue.key} 결정 근거`} />
    </Suspense>
  </article>;
}
