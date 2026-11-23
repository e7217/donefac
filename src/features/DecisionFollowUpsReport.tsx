'use client';

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ChevronRight, FileText, RefreshCw, Search } from 'lucide-react';
import type { DecisionFollowUpDraftRequest, DecisionFollowUpItem, DecisionFollowUpPage, DecisionFollowUpSource, FeatureProps } from '../../shared/types';
import { issueSearchAliasLabel, matchingIssueSearchAliases, normalizeWorkspaceSearchKey } from '../../shared/workspace-search';
import { api } from '../lib/api';
import {
  decisionFollowUpQuery, MAX_DECISION_FOLLOW_UP_SEARCH_LENGTH, sameDecisionFollowUpScope, type DecisionFollowUpScope,
} from '../lib/decision-follow-up-route';
import { ReportMeetingDraftDialog } from './ReportMeetingDraftDialog';
import './decision-follow-ups-report.css';

const DocumentDecisionRevision = lazy(() => import('./DocumentBlocks').then(module => ({ default: module.DocumentDecisionRevision })));
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'notify' | 'openIssue' | 'openDocument' | 'refresh'> & {
  scope: DecisionFollowUpScope;
  onScopeChange: (scope: DecisionFollowUpScope) => boolean;
  issueOverlayOpen: boolean;
};
type Options = Omit<DecisionFollowUpScope, 'offset'>;
type Result = { scope: DecisionFollowUpScope; page: DecisionFollowUpPage | null; loading: boolean; error?: string };
type DraftSelection = { scope: DecisionFollowUpScope; page: DecisionFollowUpPage };
type Target = 'issue' | 'document';
const targetLabels: Record<Target, string> = { issue: '업무', document: '현재 문서' };
const numberLabel = (count: number) => count.toLocaleString('ko-KR');
const workspacePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/decision-follow-ups`;
const STATUS_LABEL = { open: '미완료', closed: '종료', all: '전체 상태' };
function sameOptions(left: Options, right: Options): boolean {
  return left.projectId === right.projectId && left.status === right.status && left.assigneeId === right.assigneeId && left.q === right.q;
}

export function DecisionFollowUpsReport({ data, projectId, actorId, scope, onScopeChange, issueOverlayOpen, openIssue, openDocument, refresh, notify }: Props) {
  const [applied, setApplied] = useState(scope);
  const [options, setOptions] = useState<Options>(scope);
  const [result, setResult] = useState<Result | null>(null);
  const [draft, setDraft] = useState<DraftSelection | null>(null);
  const [opening, setOpening] = useState<{ scope: DecisionFollowUpScope; token: symbol; target: Target } | null>(null);
  const [lastIssues, setLastIssues] = useState(data.issues);
  const request = useRef<AbortController | null>(null);
  const targetRequest = useRef<symbol | null>(null);
  const issueOpener = useRef<HTMLElement | null>(null);
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
      if (!controller.signal.aborted) {
        setResult({ scope, page, loading: false });
        return page;
      }
    } catch (cause) {
      if (!controller.signal.aborted) setResult(previous => ({
        scope, page: previous?.page ?? null, loading: false,
        error: cause instanceof Error ? cause.message : '결정 후속 업무를 불러오지 못했습니다.',
      }));
    } finally {
      if (request.current === controller) request.current = null;
    }
    return null;
  }, [actorId, projectId, scope]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [lastIssues, load]);

  useEffect(() => () => { targetRequest.current = null; }, [actorId, projectId, scope]);

  const current = result && sameDecisionFollowUpScope(result.scope, scope) ? result : null;
  const page = current?.page;
  const issueKeyQuery = normalizeWorkspaceSearchKey(scope.q);
  const loading = current?.loading ?? true;
  const openingTarget = opening !== null && sameDecisionFollowUpScope(opening.scope, scope) ? opening.target : null;
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

  async function openTarget(target: Target, id: string, opener: HTMLElement) {
    if (targetRequest.current) return;
    if (target === 'issue') issueOpener.current = opener;
    opener.focus({ preventScroll: true });
    const origin = window.location.hash;
    const token = Symbol();
    const isCurrent = () => targetRequest.current === token && window.location.hash === origin;
    targetRequest.current = token;
    setOpening({ scope, token, target });
    try {
      await refresh();
      if (isCurrent()) (target === 'issue' ? openIssue : openDocument)(id);
    } catch (cause) {
      if (isCurrent()) notify(cause instanceof Error ? cause.message : `${targetLabels[target]}를 불러오지 못했습니다.`, 'error');
    } finally {
      setOpening(previous => previous?.token === token ? null : previous);
      if (targetRequest.current === token) targetRequest.current = null;
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
          <input type="search" className="field" aria-label="결정 후속 업무 검색" placeholder="현재·이전 업무 키, 제목, 문서 제목"
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
    {openingTarget && <p role="status">{targetLabels[openingTarget]}를 불러오는 중입니다.</p>}
    {page && <section className="decision-follow-ups-results" aria-label="결정 후속 업무 결과" aria-busy={loading}>
      <header>
        <h3 ref={resultsHeading} tabIndex={-1}>결정 근거 {numberLabel(page.total)}건</h3>
        <button className="btn" type="button" aria-disabled={loading || !page.items.length} onClick={() => {
          if (!loading && page.items.length) setDraft({ scope, page });
        }}><FileText size={15} aria-hidden="true" />회의 초안 만들기</button>
      </header>
      {page.items.length ? <ul className="decision-follow-ups-list" aria-label="결정 후속 업무 목록">
        {page.items.map(item => <li key={item.linkId}><DecisionFollowUpCard key={`${item.source.revisionId}:${item.source.from}:${item.source.to}`}
          item={item} data={data} issueKeyQuery={issueKeyQuery} reportProjectId={projectId} showIssueProject={scope.projectId !== undefined}
          openingTarget={openingTarget} open={openTarget} /></li>)}
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
    {draft && <DecisionMeetingDraftDialog draft={draft} data={data} projectId={projectId} actorId={actorId} refresh={refresh}
      notify={notify} openDocument={openDocument} reloadReport={load} onClose={() => setDraft(null)} />}
  </div>;
}

function DecisionMeetingDraftDialog({ draft, data, projectId, reloadReport, ...actions }:
  Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify' | 'openDocument'> & {
    draft: DraftSelection;
    reloadReport: () => Promise<DecisionFollowUpPage | null>;
    onClose: () => void;
  }) {
  const { page, scope } = draft;
  const reportPath = scope.projectId === undefined ? workspacePath(projectId) : '/decision-follow-ups';
  const destinations = [{ id: null, name: '팀 공통 문서' }, ...data.projects.map(({ id, name }) => ({ id, name }))];
  const projectName = (id: string | null) => id === null ? '전체 프로젝트' : data.projects.find(project => project.id === id)?.name ?? id;
  const assignee = scope.assigneeId === 'unassigned' ? '담당자 미지정'
    : data.users.find(user => user.id === scope.assigneeId)?.name ?? '전체 담당자';
  return <ReportMeetingDraftDialog {...actions} report={page} reloadReport={reloadReport} destinations={destinations}
    initialTitle={`결정 후속 업무 회의 · ${page.generatedAt.slice(0, 10)}`} initialDestinationId={page.projectId}
    savePath={`${reportPath}/meeting-draft`}
    requestFields={(review, destinationProjectId): Omit<DecisionFollowUpDraftRequest, 'requestId' | 'title' | 'revision'> => ({
      destinationProjectId,
      ...(typeof scope.projectId === 'string' ? { projectId: scope.projectId } : {}),
      ...(scope.status !== 'open' ? { status: scope.status } : {}),
      ...(scope.assigneeId ? { assigneeId: scope.assigneeId } : {}),
      ...(scope.q ? { q: scope.q } : {}),
      ...(review.offset ? { offset: review.offset } : {}),
    })}
    emptyNotice={() => '이 페이지에 표시할 결정 근거가 없습니다.'}
    renderReport={review => <>
      <dl aria-label="회의 초안 조건">
        <div><dt>보고서 범위</dt><dd>{projectName(review.projectId)}</dd></div>
        <div><dt>업무 상태</dt><dd>{STATUS_LABEL[scope.status]}</dd></div>
        <div><dt>담당자</dt><dd>{assignee}</dd></div>
        {scope.q && <div><dt>검색</dt><dd>{scope.q}</dd></div>}
        <div><dt>결정 근거</dt><dd>{review.items.length > 0 && `${numberLabel(review.offset + 1)}–${numberLabel(review.offset + review.items.length)} / `}{numberLabel(review.total)}건</dd></div>
      </dl>
      <p>현재 페이지의 결정 근거와 업무 정보를 선택한 문서 공간에 저장합니다.</p>
      {review.items.length > 0 && <details>
        <summary>요약에 포함할 결정 근거 {numberLabel(review.items.length)}건</summary>
        <ol>{review.items.map(item => <li key={item.linkId}>
          <strong>{item.issue.key} · {item.issue.title}</strong>
          <p>{item.source.title} · v{item.source.version}</p>
        </li>)}</ol>
      </details>}
    </>} />;
}

function DecisionFollowUpCard({ item, data, issueKeyQuery, reportProjectId, showIssueProject, openingTarget, open }: {
  item: DecisionFollowUpItem;
  data: Props['data'];
  issueKeyQuery: string;
  reportProjectId: string;
  showIssueProject: boolean;
  openingTarget: Target | null;
  open: (target: Target, id: string, opener: HTMLElement) => Promise<void>;
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
  const aliases = matchingIssueSearchAliases(data, issue.id, issueKeyQuery);
  const issueProject = showIssueProject ? data.projects.find(project => project.id === issue.projectId) : undefined;
  const documentProject = data.projects.find(project => project.id === document.projectId);
  const documentSpace = document.projectId === null ? '팀 공통 문서' : documentProject?.name ?? '프로젝트 정보 없음';
  const documentTitle = document.title || '제목 없는 문서';
  const documentHref = `#/${encodeURIComponent(document.projectId ?? reportProjectId)}/documents/${encodeURIComponent(documentId)}`;

  return <article className="card decision-follow-up" aria-label={`${issue.key} 결정 후속 업무`}>
    <h4><button className="decision-follow-up-issue" type="button" aria-label={`${issue.key} 업무 열기`} aria-disabled={openingTarget !== null}
      onClick={event => { if (!openingTarget) void open('issue', issue.id, event.currentTarget); }}>
      <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong><ChevronRight size={15} aria-hidden="true" />
    </button></h4>
    {aliases.length > 0 && <p className="decision-follow-up-aliases">{aliases.map(issueSearchAliasLabel).join(' · ')}</p>}
    <dl className="decision-follow-up-details" data-show-issue-project={showIssueProject || undefined}>
      {showIssueProject && <div><dt>업무 프로젝트</dt><dd data-decision-issue-project={issue.projectId}>{issueProject?.name ?? '프로젝트 정보 없음'}</dd></div>}
      <div><dt>상태</dt><dd><i style={{ backgroundColor: issue.statusColor }} aria-hidden="true" />{issue.statusLabel}</dd></div>
      <div><dt>담당자</dt><dd>{assignee?.name ?? '미지정'}</dd></div>
      <div><dt>{issue.deadlineSource === 'endDate' ? '계획 종료일' : '목표 마감일'}</dt>
        <dd>{issue.deadline ? <time dateTime={issue.deadline}>{issue.deadline}</time> : '미정'}</dd></div>
    </dl>
    <p className="decision-follow-up-document"><BookOpen size={16} aria-hidden="true" />
      <span><a href={documentHref} className="decision-follow-up-document-link" aria-label={`현재 문서 열기 ${documentTitle}`}
        onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          event.preventDefault();
          if (!openingTarget) void open('document', documentId, event.currentTarget);
        }}>{documentTitle}</a><small data-decision-document-space={document.projectId ?? ''}>
        {showIssueProject && '문서 공간 · '}{documentSpace}</small></span>
    </p>
    <Suspense fallback={<p role="status">결정 근거 보기를 준비하고 있습니다.</p>}>
      <DocumentDecisionRevision data={data} documentId={documentId} revisionId={revisionId} expectedVersion={version}
        label={source.title} loadSelection={loadSelection} actionLabel={`${issue.key} 결정 근거`} />
    </Suspense>
  </article>;
}
