'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, ListTodo, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { FeatureProps, TrashEntrySummary, TrashPage, TrashResourceType, TrashRestoreResult } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import './trash.css';

type Criteria = {
  resourceType: TrashResourceType | 'all';
  scope: 'all' | 'project' | 'common';
  projectId: string;
  offset: number;
};
type Result = { entry: TrashEntrySummary; restored: TrashRestoreResult | null };
const timestamp = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function Trash(props: FeatureProps) {
  return <TrashList key={`${props.actorId}:${props.projectId}`} {...props} />;
}

function TrashList({ data, projectId, actorId, refresh, openIssue, openDocument }: FeatureProps) {
  const [criteria, setCriteria] = useState<Criteria>({ resourceType: 'all', scope: 'all', projectId, offset: 0 });
  const [page, setPage] = useState<TrashPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [pending, setPending] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const announcement = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    setLoading(true);
    setListError('');
    const query = new URLSearchParams({ scope: criteria.scope, offset: String(criteria.offset) });
    if (criteria.resourceType !== 'all') query.set('resourceType', criteria.resourceType);
    if (criteria.scope === 'project') query.set('projectId', criteria.projectId);
    try {
      const next = await api<TrashPage>(`/trash?${query}`, { signal: request.signal, headers: { 'X-Actor-Id': actorId } });
      if (request.signal.aborted) return;
      if (criteria.offset && criteria.offset >= next.total) {
        const offset = Math.max(0, Math.floor((next.total - 1) / next.limit) * next.limit);
        setCriteria(value => ({ ...value, offset }));
      } else setPage(next);
    } catch (error) {
      if (!request.signal.aborted) setListError(message(error, '휴지통을 불러오지 못했습니다.'));
    } finally {
      if (!request.signal.aborted) setLoading(false);
      if (listRequest.current === request) listRequest.current = null;
    }
  }, [actorId, criteria]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => { clearTimeout(timer); listRequest.current?.abort(); };
  }, [load]);
  useEffect(() => {
    const changed = () => void load();
    window.addEventListener('teamspace:trash-changed', changed);
    return () => window.removeEventListener('teamspace:trash-changed', changed);
  }, [load]);
  useEffect(() => () => actionRequest.current?.abort(), []);
  useEffect(() => { if (result) announcement.current?.focus(); }, [result]);

  function filter(next: Partial<Criteria>) {
    listRequest.current?.abort();
    setPage(null);
    setLoading(true);
    setListError('');
    setActionError('');
    setCriteria(previous => ({ ...previous, offset: 0, ...next }));
  }

  async function refreshWorkspace(request: AbortController) {
    try { await refresh(); }
    catch (error) {
      if (!request.signal.aborted) setRefreshError(message(error, '워크스페이스를 불러오지 못했습니다.'));
    }
  }

  async function retryRefresh() {
    if (actionRequest.current) return;
    const request = new AbortController();
    actionRequest.current = request;
    setPending(true);
    setRefreshError('');
    await refreshWorkspace(request);
    actionRequest.current = null;
    if (!request.signal.aborted) setPending(false);
  }

  async function change(entry: TrashEntrySummary, action: 'restore' | 'purge') {
    if (actionRequest.current) return;
    if (action === 'purge' && !window.confirm(`“${entry.title}” 항목을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    const request = new AbortController();
    actionRequest.current = request;
    setPending(true);
    setResult(null);
    setRefreshError('');
    setActionError('');
    const path = `/trash/${encodeURIComponent(entry.id)}`;
    const options = { signal: request.signal, headers: { 'X-Actor-Id': actorId } };
    try {
      let restored: TrashRestoreResult | null = null;
      if (action === 'restore') restored = await api<TrashRestoreResult>(`${path}/restore`, { ...options, method: 'POST', body: '{}' });
      else await api(path, { ...options, method: 'DELETE' });
      if (request.signal.aborted) return;
      setPage(previous => previous && { ...previous, total: Math.max(0, previous.total - 1), items: previous.items.filter(item => item.id !== entry.id) });
      setResult({ entry, restored });
      const reloading = load();
      if (restored) await refreshWorkspace(request);
      await reloading;
    } catch (error) {
      if (request.signal.aborted) return;
      setActionError(message(error, '휴지통 항목을 처리하지 못했습니다.'));
      if (error instanceof ApiError && error.status === 404) await load();
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
      if (!request.signal.aborted) setPending(false);
    }
  }

  const restored = result?.restored;
  const ready = restored && (restored.resourceType === 'issue' ? data.issues : data.documents)
    .some(item => item.id === restored.resourceId);
  const label = result?.entry.resourceType === 'issue' ? '업무' : '문서';
  const count = page ? `${page.total.toLocaleString('ko-KR')}개` : '';

  return (
    <section className="page trash-page" aria-labelledby="trash-heading">
      <header className="page-heading trash-heading">
        <h1 id="trash-heading">휴지통</h1>
        <button className="btn btn-ghost" type="button" disabled={pending || loading} onClick={() => void load()} aria-label="휴지통 새로고침">
          <RefreshCw size={16} aria-hidden="true" /> 새로고침
        </button>
      </header>

      <div className="trash-filters">
        <label>항목 종류
          <select className="field" value={criteria.resourceType} disabled={pending}
            onChange={event => filter({ resourceType: event.target.value as Criteria['resourceType'] })}>
            <option value="all">전체</option><option value="issue">업무</option><option value="document">문서</option>
          </select>
        </label>
        <label>휴지통 범위
          <select className="field" value={criteria.scope} disabled={pending}
            onChange={event => filter({ scope: event.target.value as Criteria['scope'], projectId: criteria.projectId || data.projects[0]?.id || '' })}>
            <option value="all">전체 워크스페이스</option>
            <option value="project" disabled={!data.projects.length}>프로젝트</option>
            <option value="common">공통 문서</option>
          </select>
        </label>
        {criteria.scope === 'project' && <label>프로젝트
          <select className="field" value={criteria.projectId} disabled={pending}
            onChange={event => filter({ projectId: event.target.value })}>
            {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>}
      </div>

      {actionError && <p className="trash-error" role="alert">{actionError}</p>}
      {result && <div className="trash-result" tabIndex={-1} ref={announcement}>
        <div role="status">{result.restored ? `${label}를 복원했습니다.` : `${label}를 영구 삭제했습니다.`} <strong>{result.entry.title}</strong></div>
        {!!restored?.warnings.length && <ul className="trash-warnings">{restored.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {restored && <button className="btn btn-secondary" type="button" disabled={pending || !ready}
          onClick={() => restored.resourceType === 'issue' ? openIssue(restored.resourceId) : openDocument(restored.resourceId)}>
          복원한 {label} 열기 <ArrowUpRight size={15} aria-hidden="true" />
        </button>}
        {refreshError && <><p className="trash-error" role="alert">{refreshError}</p><button className="btn" type="button" disabled={pending} onClick={() => void retryRefresh()}>워크스페이스 다시 불러오기</button></>}
      </div>}

      <div className="trash-list" aria-busy={loading || pending}>
        {listError && <p className="trash-error" role="alert">{listError}</p>}
        {!page && loading && <p className="trash-empty">휴지통을 불러오는 중입니다.</p>}
        {page && <>
          {page.items.length === 0 && !loading && <div className="trash-empty"><p>이 범위의 휴지통이 비어 있습니다.</p></div>}
          <ul className="trash-entries" aria-label="휴지통 항목">
            {page.items.map(entry => {
              const Icon = entry.resourceType === 'issue' ? ListTodo : FileText;
              const project = entry.projectId === null ? '공통 문서' : data.projects.find(item => item.id === entry.projectId)?.name ?? '프로젝트';
              const person = data.users.find(user => user.id === entry.deletedById)?.name ?? '팀원';
              return <li key={entry.id} className="trash-entry">
                <span className="trash-entry-icon"><Icon size={18} aria-hidden="true" /></span>
                <div className="trash-entry-content">
                  <h2>{entry.issueKey && <span className="trash-entry-key">{entry.issueKey} </span>}{entry.title}</h2>
                  <p><span>{entry.resourceType === 'issue' ? '업무' : '문서'} · {project}</span><span>{person} · <time dateTime={entry.deletedAt}>{timestamp.format(new Date(entry.deletedAt))}</time></span></p>
                </div>
                <div className="trash-entry-actions">
                  <button className="btn btn-secondary" type="button" disabled={pending || loading} onClick={() => void change(entry, 'restore')}><RotateCcw size={15} aria-hidden="true" />복원</button>
                  <button className="btn btn-ghost trash-purge" type="button" disabled={pending || loading} onClick={() => void change(entry, 'purge')}><Trash2 size={15} aria-hidden="true" />영구 삭제</button>
                </div>
              </li>;
            })}
          </ul>
          {page.items.length > 0 && <nav className="trash-pagination" aria-label="휴지통 페이지">
            <span>{page.offset + 1}–{page.offset + page.items.length} / {count}</span>
            <div>
              <button className="btn btn-ghost" type="button" aria-label="휴지통 이전 페이지" disabled={pending || loading || page.offset === 0}
                onClick={() => filter({ offset: Math.max(0, page.offset - page.limit) })}><ChevronLeft size={16} aria-hidden="true" />이전</button>
              <button className="btn btn-ghost" type="button" aria-label="휴지통 다음 페이지" disabled={pending || loading || page.offset + page.limit >= page.total}
                onClick={() => filter({ offset: page.offset + page.limit })}>다음<ChevronRight size={16} aria-hidden="true" /></button>
            </div>
          </nav>}
        </>}
      </div>
    </section>
  );
}
