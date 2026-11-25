'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, FileText, History, Link2, RefreshCw } from 'lucide-react';
import type { CycleCompletionRecord, CycleCompletionRecordsPage, FeatureProps, PlanningItem } from '../../shared/types';
import { cycleCompletionRecordHash } from '../../shared/cycle-completion-address';
import { api } from '../lib/api';
import { errorMessage } from './schedule-utils';
import './cycle-completion-history.css';

type RecordProps = Pick<FeatureProps, 'projectId' | 'actorId' | 'openIssue' | 'refresh'> & {
  onOpenCycleRetrospective: (id: string, recordId: string) => void;
  issues: FeatureProps['data']['issues'];
};
type HistoryProps = RecordProps & { cycle?: Pick<PlanningItem, 'id' | 'version'> };
type RequestResult<T> = { key: string; data: T } | { key: string; error: string };
type RecordedIssue = CycleCompletionRecord['issues'][number];
type Disposition = RecordedIssue['disposition'];
type RecordView = CycleCompletionRecord & { retrospectiveDocumentId?: string };

const RECORD_PAGE_SIZE = 12;
const ISSUE_PAGE_SIZE = 25;
const GROUP_NAMES: Record<Disposition, string> = { done: '완료 업무', cancelled: '취소 업무', carry: '이월 업무' };
const DISPOSITIONS = ['done', 'cancelled', 'carry'] as const satisfies readonly Disposition[];
const timestamp = (value: string) => new Date(value).toLocaleString('ko-KR');
const size = (value: number) => `${value.toLocaleString('ko-KR')}건`;

function useHistoryRequest<T>(path: string, key: string, actorId: string) {
  const [response, setResponse] = useState<RequestResult<T> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal, headers: { 'X-Actor-Id': actorId } }).then(data => {
      if (!controller.signal.aborted) setResponse({ key, data });
    }).catch(cause => {
      if (!controller.signal.aborted) setResponse({ key, error: errorMessage(cause) });
    });
    return () => controller.abort();
  }, [actorId, key, path]);
  return response?.key === key ? response : null;
}

export function CycleCompletionHistory(props: HistoryProps) {
  const headingId = useId();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const close = () => setExpanded(false);
    window.addEventListener('teamspace:workspace-imported', close);
    return () => window.removeEventListener('teamspace:workspace-imported', close);
  }, []);

  return <section className="cycle-history" aria-labelledby={headingId}>
    <h3 id={headingId}>
      <button className="btn btn-ghost cycle-history-toggle" type="button" aria-expanded={expanded} aria-controls={bodyId}
        onClick={() => setExpanded(open => !open)}>
        <History size={16} aria-hidden="true" />사이클 완료 기록<ChevronDown size={14} aria-hidden="true" />
      </button>
    </h3>
    <div id={bodyId} hidden={!expanded}>
      {expanded && <HistoryBody key={`${props.projectId}:${props.actorId}:${props.cycle?.id ?? ''}`} {...props} />}
    </div>
  </section>;
}

export function CycleCompletionRecordView({ id, onClose, ...props }: RecordProps & { id: string; onClose: () => void }) {
  const headingId = useId();
  return <section className="cycle-history-view" aria-labelledby={headingId}>
    <div className="feature-heading">
      <h1 id={headingId}>사이클 완료 기록</h1>
      <button className="btn" type="button" onClick={onClose}><ArrowLeft size={15} aria-hidden="true" />사이클 계획으로</button>
    </div>
    <div className="cycle-history"><div className="cycle-history-body">
      <CompletionRecord {...props} id={id} direct />
    </div></div>
  </section>;
}

function HistoryBody({ cycle, ...props }: HistoryProps) {
  const { projectId, actorId } = props;
  const [scope, setScope] = useState<'cycle' | 'project'>(cycle ? 'cycle' : 'project');
  const [cursors, setCursors] = useState<string[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const path = `/projects/${encodeURIComponent(projectId)}/cycle-completion-records`;
  const query = new URLSearchParams({ limit: String(RECORD_PAGE_SIZE) });
  if (scope === 'cycle' && cycle) query.set('cycleId', cycle.id);
  const cursor = cursors.at(-1);
  if (cursor) query.set('cursor', cursor);
  const listPath = `${path}?${query}`;
  const listKey = JSON.stringify([listPath, cycle?.version, listRetry]);
  const list = useHistoryRequest<CycleCompletionRecordsPage>(listPath, listKey, actorId);
  const page = list && 'data' in list ? list.data : null;
  const selected = page?.items.find(item => item.id === recordId) ?? page?.items[0];

  function changePage(next: string[]) {
    setCursors(next);
    setRecordId(null);
  }

  return <div className="cycle-history-body" aria-busy={!list}>
    <div className="cycle-history-controls">
      {cycle && <label>완료 기록 범위
        <select className="field" value={scope} onChange={event => {
          setScope(event.currentTarget.value === 'project' ? 'project' : 'cycle');
          changePage([]);
        }}>
          <option value="cycle">이 사이클</option>
          <option value="project">프로젝트 전체</option>
        </select>
      </label>}
      {page && selected && <label>완료 기록 선택
        <select className="field" value={selected.id} onChange={event => setRecordId(event.currentTarget.value)}>
          {page.items.map(item => <option value={item.id} key={item.id}>{timestamp(item.completedAt)} · {item.cycle.name}</option>)}
        </select>
      </label>}
    </div>
    {!list && <p role="status">완료 기록을 불러오는 중입니다.</p>}
    {list && 'error' in list && <HistoryError message={list.error} onRetry={() => setListRetry(attempt => attempt + 1)} />}
    {page && !selected && <p role="status">{scope === 'cycle' ? '이 사이클에 저장된 완료 기록이 없습니다.' : '이 프로젝트에 저장된 완료 기록이 없습니다.'}</p>}
    {page && (cursors.length > 0 || page.nextCursor) && <div className="cycle-history-pagination">
      <button className="btn btn-ghost" type="button" disabled={!cursors.length} onClick={() => changePage(cursors.slice(0, -1))}>
        <ArrowLeft size={14} aria-hidden="true" />더 최근 기록
      </button>
      <button className="btn btn-ghost" type="button" disabled={!page.nextCursor} onClick={() => {
        if (page.nextCursor) changePage([...cursors, page.nextCursor]);
      }}>
        더 이전 기록<ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>}
    {selected && <CompletionRecord {...props} id={selected.id} />}
  </div>;
}

function CompletionRecord({ id, direct = false, projectId, actorId, issues, openIssue, refresh, onOpenCycleRetrospective }:
  RecordProps & { id: string; direct?: boolean }) {
  const [retry, setRetry] = useState(0);
  const path = `/projects/${encodeURIComponent(projectId)}/cycle-completion-records/${encodeURIComponent(id)}`;
  const record = useHistoryRequest<RecordView>(path, JSON.stringify([path, actorId, retry]), actorId);
  const liveIds = useMemo(() => new Set(issues.filter(issue => issue.projectId === projectId).map(issue => issue.id)), [issues, projectId]);
  if (!record) return <p role="status">당시 업무를 불러오는 중입니다.</p>;
  if ('error' in record) return <HistoryError message={record.error} onRetry={() => setRetry(attempt => attempt + 1)} />;
  return <RecordDetails key={`${projectId}:${actorId}:${id}`} record={record.data} actorId={actorId} liveIds={liveIds} openIssue={openIssue}
    refresh={refresh} openRetrospective={documentId => onOpenCycleRetrospective(documentId, id)} recordPath={path} direct={direct} />;
}

function HistoryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="cycle-history-error">
    <p className="issue-form-error" role="alert">{message}</p>
    <button className="btn btn-ghost" type="button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />기록 다시 읽기</button>
  </div>;
}

function RecordDetails({ record, liveIds, openIssue, openRetrospective, refresh, actorId, recordPath, direct }:
  Pick<RecordProps, 'openIssue' | 'refresh' | 'actorId'> & { record: RecordView; liveIds: ReadonlySet<string>; recordPath: string;
    direct: boolean; openRetrospective: (id: string) => void }) {
  const groups = useMemo(() => {
    const result: Record<Disposition, RecordedIssue[]> = { done: [], cancelled: [], carry: [] };
    for (const issue of record.issues) result[issue.disposition].push(issue);
    return result;
  }, [record.issues]);
  const { cycle, completedAt, actorName, destination, counts } = record;
  const Title = direct ? 'h2' : 'h4';
  return <article className="cycle-history-record" aria-label="선택한 사이클 완료 기록">
    <Title>{cycle.name}</Title>
    <div className="cycle-history-record-actions">
      <RetrospectiveAction savedDocumentId={record.retrospectiveDocumentId} path={`${recordPath}/retrospective`}
        actorId={actorId} refresh={refresh} openDocument={openRetrospective} />
      {!direct && <a className="btn" href={cycleCompletionRecordHash(record.projectId, record.id)}>
        <Link2 size={15} aria-hidden="true" />이 완료 기록 열기
      </a>}
    </div>
    <p><time dateTime={completedAt}>{timestamp(completedAt)}</time> · {actorName}</p>
    {(cycle.startDate || cycle.endDate || cycle.targetDate) && <p className="cycle-history-dates">
      {(cycle.startDate || cycle.endDate) && <span>당시 일정 {cycle.startDate ?? '미정'} ~ {cycle.endDate ?? '미정'}</span>}
      {cycle.targetDate && <span>목표일 {cycle.targetDate}</span>}
    </p>}
    <p>이월 대상 <strong>{destination?.name ?? '백로그 (사이클 미지정)'}</strong></p>
    <ul className="cycle-history-counts" aria-label="당시 업무 집계">
      {DISPOSITIONS.map(disposition => <li key={disposition} data-disposition={disposition}>{GROUP_NAMES[disposition]} {size(counts[disposition])}</li>)}
    </ul>
    {DISPOSITIONS.map(disposition => groups[disposition].length > 0 && <RecordedIssueGroup key={disposition}
      name={GROUP_NAMES[disposition]} issues={groups[disposition]} liveIds={liveIds} openIssue={openIssue} />)}
    {!record.issues.length && <p>완료 당시 연결된 업무가 없었습니다.</p>}
  </article>;
}

function RetrospectiveAction({ savedDocumentId, path, actorId, refresh, openDocument }:
  Pick<RecordProps, 'actorId' | 'refresh'> & { savedDocumentId?: string; path: string; openDocument: (id: string) => void }) {
  const [createdId, setCreatedId] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const documentId = savedDocumentId ?? createdId;
  useEffect(() => () => request.current?.abort(), []);

  async function act() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      if (documentId) {
        await refresh();
        if (!controller.signal.aborted) openDocument(documentId);
      } else {
        const result = await api<{ id: string }>(path, { method: 'POST', body: '{}', signal: controller.signal,
          headers: { 'X-Actor-Id': actorId } });
        if (typeof result?.id !== 'string' || !result.id) throw new Error('회고 문서를 확인하지 못했습니다.');
        if (!controller.signal.aborted) setCreatedId(result.id);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  return <div>
    <button className="btn" type="button" disabled={busy} aria-busy={busy} onClick={() => void act()}>
      <FileText size={15} aria-hidden="true" />{documentId ? '회고 문서 열기' : '회고 문서 만들기'}
    </button>
    {error && <p className="issue-form-error" role="alert">{error}</p>}
  </div>;
}

function RecordedIssueGroup({ name, issues, liveIds, openIssue }: { name: string; issues: RecordedIssue[]; liveIds: ReadonlySet<string>; openIssue: HistoryProps['openIssue'] }) {
  const heading = useId();
  const [page, setPage] = useState(0);
  const offset = page * ISSUE_PAGE_SIZE;
  return <section className="cycle-history-group" aria-labelledby={heading}>
    <h5 id={heading}>{name}</h5>
    <ul>
      {issues.slice(offset, offset + ISSUE_PAGE_SIZE).map(issue => <li key={issue.id}>
        <div>
          {liveIds.has(issue.id) ? <button className="cycle-history-issue-link" type="button" aria-label={`${issue.key} ${issue.title}`} onClick={() => openIssue(issue.id)}>
            <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong>
          </button> : <p className="cycle-history-static-issue">
            <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong><small>현재 업무 없음</small>
          </p>}
          <small className="cycle-history-assignee">당시 담당 {issue.assigneeName ?? '미지정'}</small>
        </div>
        <span className="cycle-history-status">{issue.statusLabel}</span>
      </li>)}
    </ul>
    {issues.length > ISSUE_PAGE_SIZE && <div className="cycle-history-pagination">
      <span aria-live="polite">{offset + 1}–{Math.min(offset + ISSUE_PAGE_SIZE, issues.length)} / {issues.length.toLocaleString('ko-KR')}</span>
      <button className="btn btn-ghost" type="button" aria-label={`${name} 이전 페이지`} disabled={page === 0} onClick={() => setPage(page - 1)}>
        <ArrowLeft size={14} aria-hidden="true" />
      </button>
      <button className="btn btn-ghost" type="button" aria-label={`${name} 다음 페이지`} disabled={offset + ISSUE_PAGE_SIZE >= issues.length} onClick={() => setPage(page + 1)}>
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>}
  </section>;
}
