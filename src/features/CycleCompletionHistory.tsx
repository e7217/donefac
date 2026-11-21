'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, History, RefreshCw } from 'lucide-react';
import type { CycleCompletionRecord, CycleCompletionRecordsPage, FeatureProps, PlanningItem } from '../../shared/types';
import { api } from '../lib/api';
import { errorMessage } from './schedule-utils';
import './cycle-completion-history.css';

type HistoryProps = Pick<FeatureProps, 'projectId' | 'actorId' | 'openIssue'> & {
  cycle?: Pick<PlanningItem, 'id' | 'version'>;
  issues: FeatureProps['data']['issues'];
};
type RequestResult<T> = { key: string; data: T } | { key: string; error: string };
type RecordedIssue = CycleCompletionRecord['issues'][number];
type Disposition = RecordedIssue['disposition'];

const RECORD_PAGE_SIZE = 12;
const ISSUE_PAGE_SIZE = 25;
const GROUP_NAMES: Record<Disposition, string> = { done: '완료 업무', cancelled: '취소 업무', carry: '이월 업무' };
const DISPOSITIONS = ['done', 'cancelled', 'carry'] as const satisfies readonly Disposition[];
const timestamp = (value: string) => new Date(value).toLocaleString('ko-KR');
const size = (value: number) => `${value.toLocaleString('ko-KR')}건`;

function useHistoryRequest<T>(path: string | null, key: string, actorId: string) {
  const [response, setResponse] = useState<RequestResult<T> | null>(null);
  useEffect(() => {
    if (!path) return;
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

function HistoryBody({ cycle, projectId, actorId, issues, openIssue }: HistoryProps) {
  const [scope, setScope] = useState<'cycle' | 'project'>(cycle ? 'cycle' : 'project');
  const [cursors, setCursors] = useState<string[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [recordRetry, setRecordRetry] = useState(0);
  const liveIds = useMemo(() => new Set(issues.filter(issue => issue.projectId === projectId).map(issue => issue.id)), [issues, projectId]);
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
  const recordPath = selected ? `${path}/${encodeURIComponent(selected.id)}` : null;
  const record = useHistoryRequest<CycleCompletionRecord>(recordPath, JSON.stringify([recordPath, recordRetry]), actorId);

  function changePage(next: string[]) {
    setCursors(next);
    setRecordId(null);
  }

  return <div className="cycle-history-body" aria-busy={!list || Boolean(selected && !record)}>
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
    {selected && !record && <p role="status">당시 업무를 불러오는 중입니다.</p>}
    {record && 'error' in record && <HistoryError message={record.error} onRetry={() => setRecordRetry(attempt => attempt + 1)} />}
    {record && 'data' in record && <RecordDetails key={record.data.id} record={record.data} liveIds={liveIds} openIssue={openIssue} />}
  </div>;
}

function HistoryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="cycle-history-error">
    <p className="issue-form-error" role="alert">{message}</p>
    <button className="btn btn-ghost" type="button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />기록 다시 읽기</button>
  </div>;
}

function RecordDetails({ record, liveIds, openIssue }: { record: CycleCompletionRecord; liveIds: ReadonlySet<string>; openIssue: HistoryProps['openIssue'] }) {
  const groups = useMemo(() => {
    const result: Record<Disposition, RecordedIssue[]> = { done: [], cancelled: [], carry: [] };
    for (const issue of record.issues) result[issue.disposition].push(issue);
    return result;
  }, [record.issues]);
  const { cycle, completedAt, actorName, destination, counts } = record;
  return <article className="cycle-history-record" aria-label="선택한 사이클 완료 기록">
    <h4>{cycle.name}</h4>
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
