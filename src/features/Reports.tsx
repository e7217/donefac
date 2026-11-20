'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BarChart3, CalendarDays, FileText, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import type {
  DeliveryBlockerDraftScope,
  FeatureProps,
  ProjectReport,
  ReportDay,
  ReportIssueMetric,
  ReportQuery,
  ReportSnapshot,
  ReportSnapshotSummary,
  StatusCategory,
} from '../../shared/types';
import { projectIssueTypes } from '../../shared/issue-schema';
import { isCalendarDate } from '../../shared/calendar';
import { api } from '../lib/api';
import { afterAcceptedNavigation, isReportPreservedByNavigation } from '../lib/navigation';
import { WorklogReport } from './WorklogReport';
import { FieldBreakdownReport } from './FieldBreakdownReport';
import { DeliveryBlockersReport } from './DeliveryBlockersReport';
import { reportDuration, StatusDurationReport } from './ReportStatusDuration';
import './reports.css';

type Props = FeatureProps & { snapshotId?: string | null; initialBlockerScope?: DeliveryBlockerDraftScope | null };
const CATEGORIES: StatusCategory[] = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'];
const META: Record<StatusCategory, { label: string; color: string }> = {
  backlog: { label: '백로그', color: '#8a98a7' },
  todo: { label: '할 일', color: '#647b93' },
  in_progress: { label: '진행', color: '#557fe0' },
  review: { label: '검토', color: '#9b73b6' },
  done: { label: '완료', color: '#177c72' },
  cancelled: { label: '취소', color: '#c0c6c9' },
};
const COVERAGE = { complete: '관측', partial: '일부 관측', unobserved: '미관측' };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '보고서를 불러오지 못했습니다.';
function localDay(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function defaultQuery(projectId: string): ReportQuery {
  const today = new Date(),
    monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return {
    projectId,
    startDate: localDay(monday),
    endDate: localDay(today),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    issueType: null,
    assigneeId: null,
  };
}
const defaultTitle = (query: ReportQuery) => `주간 공유 · ${query.startDate}–${query.endDate}`;
const sameQuery = (a: ReportQuery, b: ReportQuery) => JSON.stringify(a) === JSON.stringify(b);
function queryError(query: ReportQuery): string {
  if (!isCalendarDate(query.startDate) || !isCalendarDate(query.endDate))
    return '올바른 시작일과 종료일을 입력하세요.';
  const count =
    (Date.parse(`${query.endDate}T00:00:00Z`) - Date.parse(`${query.startDate}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (count < 1 || count > 92) return '기간은 시작일을 포함해 1~92일로 지정하세요.';
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone: query.timeZone }).format();
  } catch {
    return '올바른 IANA 시간대를 입력하세요. 예: Asia/Seoul';
  }
  return '';
}
function time(value: string | null, zone?: string) {
  if (!value) return '관측 없음';
  try {
    return new Date(value).toLocaleString('ko-KR', zone ? { timeZone: zone } : undefined);
  } catch {
    return value;
  }
}
function summary(snapshot: ReportSnapshot): ReportSnapshotSummary {
  const { report, ...rest } = snapshot;
  return { ...rest, query: report.query };
}
function remember(cache: Map<string, ReportSnapshot>, value: ReportSnapshot) {
  cache.delete(value.id);
  cache.set(value.id, value);
  while (cache.size > 6) cache.delete(cache.keys().next().value!);
}

export function Reports(props: Props) {
  return <ProjectReports key={JSON.stringify([props.projectId, props.actorId, props.initialBlockerScope ?? null])} {...props} />;
}
function ProjectReports(props: Props) {
  const { data, projectId, actorId, notify } = props;
  const [initial] = useState(() => defaultQuery(projectId)),
    [query, setQuery] = useState<ReportQuery>(initial),
    [baselineQuery, setBaselineQuery] = useState<ReportQuery>(initial);
  const [title, setTitle] = useState<string | null>(null),
    [baselineTitle, setBaselineTitle] = useState<string | null>(null);
  const [report, setReport] = useState<ProjectReport | null>(null),
    [reportLoading, setReportLoading] = useState(false),
    [reportError, setReportError] = useState('');
  const [snapshots, setSnapshots] = useState<ReportSnapshotSummary[]>([]),
    [listLoading, setListLoading] = useState(true),
    [listError, setListError] = useState('');
  const [selected, setSelected] = useState<ReportSnapshot | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState('');
  const [view, setView] = useState<'live' | 'saved' | 'worklogs' | 'fields' | 'blockers'>(props.snapshotId ? 'saved' : props.initialBlockerScope ? 'blockers' : 'live'),
    [snapshotSearch, setSnapshotSearch] = useState(''),
    [snapshotOffset, setSnapshotOffset] = useState(0);
  const [creating, setCreating] = useState(false),
    [createError, setCreateError] = useState('');
  const active = useRef(true),
    busyRef = useRef(false),
    dirtyRef = useRef(false),
    reportRequest = useRef<AbortController | null>(null),
    detailRequest = useRef<AbortController | null>(null),
    listSequence = useRef(0),
    cache = useRef(new Map<string, ReportSnapshot>());
  const dirty = !sameQuery(query, baselineQuery) || title !== baselineTitle,
    validation = queryError(query),
    requestedTitle = title ?? defaultTitle(query);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const validProject = data.projects.some((item) => item.id === projectId);
  const resetDraft = useCallback(() => {
    setQuery(structuredClone(baselineQuery));
    setTitle(baselineTitle);
    setCreateError('');
    dirtyRef.current = false;
  }, [baselineQuery, baselineTitle]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current) {
        event.preventDefault();
        notify('공유 초안 저장 결과를 확인한 뒤 이동해 주세요.', 'error');
      } else if (dirtyRef.current && !isReportPreservedByNavigation(event)) {
        if (!window.confirm('입력 중인 보고서 조건과 공유 초안 제목을 버리고 이동할까요?'))
          event.preventDefault();
        else afterAcceptedNavigation(event, resetDraft);
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (busyRef.current || dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [notify, resetDraft]);
  const loadReport = useCallback(
    async (input: ReportQuery) => {
      reportRequest.current?.abort();
      const controller = new AbortController();
      reportRequest.current = controller;
      setReportLoading(true);
      setReportError('');
      const params = new URLSearchParams({
        startDate: input.startDate,
        endDate: input.endDate,
        timeZone: input.timeZone,
      });
      if (input.issueType !== null) params.set('issueType', input.issueType);
      if (input.assigneeId !== null) params.set('assigneeId', input.assigneeId);
      try {
        const result = await api<ProjectReport>(
          `/projects/${encodeURIComponent(projectId)}/report?${params}`,
          { signal: controller.signal, headers: { 'X-Actor-Id': actorId } },
        );
        if (active.current && !controller.signal.aborted) {
          setReport(result);
          setBaselineQuery(structuredClone(input));
        }
      } catch (cause) {
        if (active.current && !controller.signal.aborted)
          setReportError(`${errorMessage(cause)} 이전 조회 결과와 입력은 유지됩니다.`);
      } finally {
        if (active.current && !controller.signal.aborted) setReportLoading(false);
      }
    },
    [projectId, actorId],
  );
  const loadList = useCallback(async () => {
    const sequence = ++listSequence.current;
    setListLoading(true);
    try {
      const values = await api<ReportSnapshotSummary[]>(
        `/projects/${encodeURIComponent(projectId)}/report-snapshots`,
      );
      if (active.current && sequence === listSequence.current) {
        setSnapshots(values);
        setListError('');
      }
    } catch (cause) {
      if (active.current && sequence === listSequence.current) setListError(errorMessage(cause));
    } finally {
      if (active.current && sequence === listSequence.current) setListLoading(false);
    }
  }, [projectId]);
  const loadSnapshot = useCallback(
    async (id: string) => {
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      setView('saved');
      setDetailError('');
      const existing = cache.current.get(id);
      if (existing) {
        remember(cache.current, existing);
        setSelected(existing);
        setDetailLoading(false);
        return;
      }
      setDetailLoading(true);
      try {
        const value = await api<ReportSnapshot>(
          `/projects/${encodeURIComponent(projectId)}/report-snapshots/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        if (active.current && !controller.signal.aborted) {
          remember(cache.current, value);
          setSelected(value);
        }
      } catch (cause) {
        if (active.current && !controller.signal.aborted)
          setDetailError(`${errorMessage(cause)} 이전 저장 보고서가 있으면 그대로 유지합니다.`);
      } finally {
        if (active.current && !controller.signal.aborted) setDetailLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    active.current = true;
    const timer = setTimeout(() => {
      if (validProject) {
        void loadList();
        if (!props.snapshotId) void loadReport(initial);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      active.current = false;
      reportRequest.current?.abort();
      detailRequest.current?.abort();
    };
  }, [initial, loadList, loadReport, validProject, props.snapshotId]);
  useEffect(() => {
    if (!props.snapshotId || !validProject) return;
    const timer = setTimeout(() => void loadSnapshot(props.snapshotId!), 0);
    return () => clearTimeout(timer);
  }, [props.snapshotId, loadSnapshot, validProject]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || validation || !requestedTitle.trim()) return;
    busyRef.current = true;
    setCreating(true);
    setCreateError('');
    detailRequest.current?.abort();
    setDetailLoading(false);
    setDetailError('');
    listSequence.current++;
    setListLoading(false);
    try {
      const value = await api<ReportSnapshot>(
        `/projects/${encodeURIComponent(projectId)}/report-snapshots`,
        {
          method: 'POST',
          headers: { 'X-Actor-Id': actorId },
          body: JSON.stringify({ query, title: requestedTitle.trim() }),
        },
      );
      if (!active.current) return;
      remember(cache.current, value);
      setSnapshots((previous) => [summary(value), ...previous.filter((item) => item.id !== value.id)]);
      setSelected(value);
      setView('saved');
      setReport(value.report);
      setQuery(structuredClone(value.report.query));
      setBaselineQuery(structuredClone(value.report.query));
      setBaselineTitle(title);
      dirtyRef.current = false;
      notify('보고서를 고정해 공유용 문서 초안을 만들었습니다.');
      try {
        await props.refresh();
      } catch {
        notify('초안은 저장했습니다. 문서 목록을 다시 새로고침하세요.', 'error');
      }
    } catch (cause) {
      if (active.current)
        setCreateError(`${errorMessage(cause)} 제목·조회 조건과 기존 결과는 유지됩니다.`);
    } finally {
      busyRef.current = false;
      if (active.current) setCreating(false);
    }
  }
  function submitQuery(event: FormEvent) {
    event.preventDefault();
    if (!validation && !busyRef.current) void loadReport(structuredClone(query));
  }
  if (!validProject)
    return (
      <div className="reports-feature">
        <h1>보고서</h1>
        <p>프로젝트를 선택하면 업무 현황과 관측한 기간 지표를 확인할 수 있습니다.</p>
      </div>
    );
  const types = projectIssueTypes(data, projectId, { includeArchived: true }),
    visibleSnapshots = snapshots.filter((value) =>
      `${value.title} ${value.query.startDate} ${value.query.endDate}`
        .toLocaleLowerCase()
        .includes(snapshotSearch.toLocaleLowerCase()),
    ),
    listStart = Math.min(
      snapshotOffset,
      Math.max(0, Math.floor((visibleSnapshots.length - 1) / 25) * 25),
    );
  function showView(next: typeof view) {
    if (next === view) return;
    if ([view, next].some(item => item === 'worklogs' || item === 'fields') &&
        !window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) return;
    setView(next);
  }
  return (
    <div className="reports-feature">
      <header className="reports-page-heading">
        <div>
          <h1>
            <BarChart3 size={25} />
            보고서
          </h1>
          <p>현재 업무와 관측한 흐름을 확인하고 팀 공유 초안으로 남기세요.</p>
        </div>
      </header>
      <div className="reports-tabs" role="tablist" aria-label="보고서 보기">
        <button
          role="tab"
          id="report-live-tab"
          aria-controls="report-live-panel"
          aria-selected={view === 'live'}
          disabled={creating}
          onClick={() => showView('live')}
        >
          현재 조회
        </button>
        <button
          role="tab"
          id="report-saved-tab"
          aria-controls="report-saved-panel"
          aria-selected={view === 'saved'}
          disabled={creating}
          onClick={() => showView('saved')}
        >
          저장한 보고서 <span>{snapshots.length}</span>
        </button>
        <button
          role="tab"
          id="report-worklogs-tab"
          aria-controls="report-worklogs-panel"
          aria-selected={view === 'worklogs'}
          disabled={creating}
          onClick={() => showView('worklogs')}
        >
          작업 시간
        </button>
        <button
          role="tab"
          id="report-fields-tab"
          aria-controls="report-fields-panel"
          aria-selected={view === 'fields'}
          disabled={creating}
          onClick={() => showView('fields')}
        >
          필드 집계
        </button>
        <button
          role="tab"
          id="report-blockers-tab"
          aria-controls="report-blockers-panel"
          aria-selected={view === 'blockers'}
          disabled={creating}
          onClick={() => showView('blockers')}
        >
          진행 차단
        </button>
      </div>
      {view === 'live' ? (
        <section role="tabpanel" id="report-live-panel" aria-labelledby="report-live-tab">
          <form className="card reports-query" aria-label="보고서 조회 조건" onSubmit={submitQuery}>
            <fieldset disabled={creating || reportLoading}>
              <div className="reports-query-heading">
                <h2>
                  <SlidersHorizontal size={18} />
                  조회 조건
                </h2>
                <span>최대 92일 · 양 끝 날짜 포함</span>
              </div>
              <div className="reports-query-grid">
                <label>
                  시작일
                  <input
                    type="date"
                    className="field"
                    aria-label="보고서 시작일"
                    value={query.startDate}
                    onChange={(event) => setQuery({ ...query, startDate: event.target.value })}
                  />
                </label>
                <label>
                  종료일
                  <input
                    type="date"
                    className="field"
                    aria-label="보고서 종료일"
                    value={query.endDate}
                    onChange={(event) => setQuery({ ...query, endDate: event.target.value })}
                  />
                </label>
                <label>
                  집계 시간대
                  <input
                    className="field"
                    aria-label="보고서 시간대"
                    value={query.timeZone}
                    maxLength={100}
                    list="report-timezones"
                    onChange={(event) => setQuery({ ...query, timeZone: event.target.value })}
                  />
                  <datalist id="report-timezones">
                    <option value="Asia/Seoul" />
                    <option value="UTC" />
                    <option value="America/New_York" />
                    <option value="Europe/London" />
                  </datalist>
                </label>
                <label>
                  업무 유형
                  <select
                    className="field"
                    aria-label="보고서 업무 유형"
                    value={query.issueType ?? ''}
                    onChange={(event) => setQuery({ ...query, issueType: event.target.value || null })}
                  >
                    <option value="">모든 유형</option>
                    {query.issueType && !types.some((item) => item.id === query.issueType) && (
                      <option value={query.issueType}>{query.issueType} · 현재 양식에 없음</option>
                    )}
                    {types.map((type) => (
                      <option value={type.id} key={type.id}>
                        {type.name}
                        {type.archived ? ' · 보관됨' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  담당자
                  <select
                    className="field"
                    aria-label="보고서 담당자"
                    value={query.assigneeId ?? ''}
                    onChange={(event) => setQuery({ ...query, assigneeId: event.target.value || null })}
                  >
                    <option value="">모든 담당자</option>
                    {query.assigneeId && !data.users.some((user) => user.id === query.assigneeId) && (
                      <option value={query.assigneeId}>{query.assigneeId} · 현재 목록에 없음</option>
                    )}
                    {data.users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="reports-form-actions">
                <span>
                  {validation ||
                    (!sameQuery(query, report?.query || initial) && report
                      ? '조건이 변경되었습니다. 조회하면 아래 결과를 갱신합니다.'
                      : '')}
                </span>
                <button className="btn btn-primary" type="submit" disabled={Boolean(validation)}>
                  <RefreshCw size={16} />
                  {reportLoading ? '조회 중…' : '보고서 조회'}
                </button>
              </div>
            </fieldset>
          </form>
          {reportError && (
            <p className="reports-error" role="alert">
              {reportError}
            </p>
          )}
          {reportLoading && !report && <p role="status">업무와 관측 기록을 집계하는 중…</p>}
          {report && (
            <ReportBody report={report} data={data} openIssue={props.openIssue} frozen={false} />
          )}
          <form className="card reports-create" aria-label="공유 보고서 초안 만들기" onSubmit={create}>
            <fieldset disabled={creating || reportLoading}>
              <div>
                <h2>
                  <FileText size={19} />팀 공유 초안
                </h2>
                <p>
                  저장할 때 서버가 현재 입력한 조건으로 다시 집계하고, 고정한 보고서와 문서 초안을 함께
                  만듭니다.
                </p>
              </div>
              <label>
                공유 초안 제목
                <input
                  className="field"
                  aria-label="공유 보고서 제목"
                  value={requestedTitle}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </label>
              {createError && (
                <p role="alert" className="reports-error">
                  {createError}
                </p>
              )}
              <button
                className="btn btn-primary"
                disabled={!requestedTitle.trim() || Boolean(validation)}
                type="submit"
              >
                <FileText size={16} />
                {creating ? '공유 초안 저장 중…' : '공유 초안 저장'}
              </button>
            </fieldset>
          </form>
        </section>
      ) : view === 'worklogs' ? (
        <section role="tabpanel" id="report-worklogs-panel" aria-labelledby="report-worklogs-tab">
          <WorklogReport {...props} />
        </section>
      ) : view === 'fields' ? (
        <section role="tabpanel" id="report-fields-panel" aria-labelledby="report-fields-tab">
          <FieldBreakdownReport {...props} />
        </section>
      ) : view === 'blockers' ? (
        <section role="tabpanel" id="report-blockers-panel" aria-labelledby="report-blockers-tab">
          <DeliveryBlockersReport {...props} initialScope={props.initialBlockerScope ?? undefined} />
        </section>
      ) : (
        <section role="tabpanel" id="report-saved-panel" aria-labelledby="report-saved-tab">
          <div className="reports-saved-layout">
            <aside className="card reports-snapshot-list" aria-label="저장한 보고서 목록">
              <header>
                <h2>저장한 보고서</h2>
                <button
                  className="btn btn-ghost"
                  disabled={listLoading || creating}
                  onClick={() => void loadList()}
                  aria-label="저장한 보고서 새로고침"
                >
                  <RefreshCw size={16} />
                </button>
              </header>
              <label className="reports-search">
                <Search size={16} />
                <input
                  className="field"
                  aria-label="저장한 보고서 검색"
                  value={snapshotSearch}
                  onChange={(event) => {
                    setSnapshotSearch(event.target.value);
                    setSnapshotOffset(0);
                  }}
                  placeholder="제목·기간 검색"
                  disabled={creating}
                />
              </label>
              {listError && (
                <p role="alert" className="reports-error">
                  {listError} 기존 목록은 유지됩니다.
                </p>
              )}
              {listLoading && <p role="status">저장 목록을 불러오는 중…</p>}
              {visibleSnapshots.slice(listStart, listStart + 25).map((value) => (
                <button
                  className={`reports-snapshot-row ${value.id === selected?.id ? 'is-selected' : ''}`}
                  key={value.id}
                  onClick={() => void loadSnapshot(value.id)}
                  disabled={creating}
                >
                  <strong>{value.title}</strong>
                  <span>
                    {value.query.startDate} – {value.query.endDate}
                  </span>
                  <small>{time(value.createdAt)}</small>
                </button>
              ))}
              {!listLoading && !visibleSnapshots.length && (
                <p>아직 조건에 맞는 저장 보고서가 없습니다.</p>
              )}
              {visibleSnapshots.length > 25 && (
                <div className="reports-pagination">
                  <span>
                    {listStart + 1}–{Math.min(listStart + 25, visibleSnapshots.length)} /{' '}
                    {visibleSnapshots.length}
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={listStart === 0}
                    onClick={() => setSnapshotOffset(Math.max(0, listStart - 25))}
                  >
                    이전
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={listStart + 25 >= visibleSnapshots.length}
                    onClick={() => setSnapshotOffset(listStart + 25)}
                  >
                    다음
                  </button>
                </div>
              )}
            </aside>
            <div className="reports-snapshot-detail">
              {detailLoading && <p role="status">저장한 보고서를 불러오는 중…</p>}
              {detailError && (
                <p className="reports-error" role="alert">
                  {detailError}
                </p>
              )}
              {selected ? (
                <>
                  <header className="card reports-saved-heading">
                    <span className="reports-fixed-badge">저장한 시점의 보고서</span>
                    <h2>{selected.title}</h2>
                    <p>
                      {time(selected.createdAt)} 저장 ·{' '}
                      {data.users.find((user) => user.id === selected.actorId)?.name || selected.actorId}
                    </p>
                    <div>
                      <button
                        className="btn btn-primary"
                        disabled={
                          creating ||
                          !data.documents.some((document) => document.id === selected.documentId)
                        }
                        onClick={() => props.openDocument(selected.documentId)}
                      >
                        <FileText size={16} />
                        공유 문서 초안 열기
                      </button>
                      <a
                        className="btn btn-ghost"
                        href={`#/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(selected.id)}`}
                      >
                        보고서 고정 링크
                      </a>
                    </div>
                    {!data.documents.some((document) => document.id === selected.documentId) && (
                      <small>공유 문서가 현재 목록에 없습니다. 보고서는 그대로 보존됩니다.</small>
                    )}
                  </header>
                  <ReportBody
                    key={selected.id}
                    report={selected.report}
                    data={data}
                    openIssue={props.openIssue}
                    frozen
                  />
                </>
              ) : (
                !detailLoading && (
                  <div className="card reports-empty">
                    <CalendarDays size={30} />
                    <h2>저장한 보고서를 선택하세요</h2>
                    <p>저장 이후 업무가 바뀌어도 당시 집계와 조건을 확인할 수 있습니다.</p>
                  </div>
                )
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ReportBody({
  report,
  data,
  openIssue,
  frozen,
}: {
  report: ProjectReport;
  data: FeatureProps['data'];
  openIssue: FeatureProps['openIssue'];
  frozen: boolean;
}) {
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [offset, setOffset] = useState(0),
    [showTable, setShowTable] = useState(false);
  const rows = report.issues.filter(
      (row) =>
        (filter === 'all' ||
          (filter === 'completed' && row.completed > 0) ||
          (filter === 'reopened' && row.reopened > 0) ||
          (filter === 'deleted' && row.deleted)) &&
        `${row.issue.key} ${row.issue.title} ${row.issue.statusLabel}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    ),
    start = Math.min(offset, Math.max(0, Math.floor((rows.length - 1) / 50) * 50));
  const partial = report.days.filter((day) => day.coverage === 'partial').length,
    unknown = report.days.filter((day) => day.coverage === 'unobserved').length;
  return (
    <section className="reports-result" aria-label={frozen ? '저장 보고서 집계' : '현재 보고서 집계'}>
      <header className="reports-asof">
        <div>
          <strong>
            {report.query.startDate} – {report.query.endDate}
          </strong>
          <span>
            {report.query.timeZone} · 유형 {report.query.issueType || '전체'} · 담당자{' '}
            {report.query.assigneeId
              ? data.users.find((user) => user.id === report.query.assigneeId)?.name ||
                report.query.assigneeId
              : '전체'}
          </span>
        </div>
        <span>
          {frozen ? '고정 집계' : '표시 중인 집계'} · {time(report.generatedAt, report.query.timeZone)}
        </span>
      </header>
      <div className="reports-section-heading">
        <h2>현재 현황</h2>
        <span>{time(report.generatedAt, report.query.timeZone)} 기준</span>
      </div>
      <div className="reports-stat-grid">
        <Stat label="현재 업무" value={report.current.total} />
        <Stat label="진행 중" value={report.current.state.in_progress} />
        <Stat label="기한 초과" value={report.current.overdue} />
        <Stat label="다가오는 기한" value={report.current.dueSoon} detail="오늘부터 7일 후까지" />
      </div>
      <p className="reports-method">
        기한 초과·다가오는 기한은 미완료 업무의 목표 마감일을 우선하며, 없으면 종료일을 사용합니다.
      </p>
      <div className="reports-state-summary" aria-label="현재 상태 분포">
        {CATEGORIES.map((category) => (
          <span key={category}>
            <i style={{ background: META[category].color }} />
            {META[category].label} <strong>{report.current.state[category]}</strong>
          </span>
        ))}
      </div>
      <div className="reports-section-heading">
        <h2>선택 기간의 관측 기록</h2>
        <span>관측 시점 담당자·유형으로 집계</span>
      </div>
      <p className="reports-coverage-note">
        관측 완료 {report.days.length - partial - unknown}일 · 일부 관측 {partial}일 · 미관측 {unknown}
        일. 일별 상태는 관측한 시점까지 표시합니다.
        {report.observedThrough &&
          ` 마지막 관측 ${time(report.observedThrough, report.query.timeZone)}.`}
      </p>
      <div className="reports-stat-grid">
        <Stat label="생성" value={report.period.created} />
        <Stat label="완료한 업무" value={report.period.completedIssues} />
        <Stat label="재오픈 전이" value={report.period.reopened} />
        <Stat
          label="관측 진행→완료 중앙값"
          value={reportDuration(report.period.medianCycleHours)}
          detail={`실제 관측 ${report.period.cycleSamples}개 표본`}
        />
      </div>
      <div className="reports-period-details">
        <span>완료 전이 {report.period.completionTransitions}</span>
        <span>같은 업무의 추가 완료 {report.period.repeatedCompletions}</span>
        <span>삭제 {report.period.deleted}</span>
        <span>워크플로 재분류 {report.period.reclassified}</span>
      </div>
      <p className="reports-method">
        진행→완료 시간은 같은 관측 구간의 실제 진입·완료를 모두 확인한 표본만 사용합니다. 최초 상태에서
        시간을 역산하지 않습니다.
      </p>
      <DailyCharts days={report.days} />
      <details
        className="card reports-daily-table"
        onToggle={(event) => setShowTable(event.currentTarget.open)}
      >
        <summary>일별 수치 표로 보기</summary>
        {showTable && (
          <div className="reports-table-scroll">
            <table aria-label="일별 보고서 수치">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>관측</th>
                  {CATEGORIES.map((category) => (
                    <th key={category}>{META[category].label}</th>
                  ))}
                  <th>생성</th>
                  <th>완료 전이</th>
                  <th>재오픈</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{day.date}</th>
                    <td>{COVERAGE[day.coverage]}</td>
                    {CATEGORIES.map((category) => (
                      <td key={category}>{day.state === null ? '값 없음' : day.state[category]}</td>
                    ))}
                    <td>{day.coverage === 'unobserved' ? '값 없음' : day.created}</td>
                    <td>{day.coverage === 'unobserved' ? '값 없음' : day.completed}</td>
                    <td>{day.coverage === 'unobserved' ? '값 없음' : day.reopened}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      {report.statusDuration ? <StatusDurationReport key={`${frozen ? report.generatedAt : ''}:${JSON.stringify(report.query)}`}
        data={data} report={report.statusDuration} projectId={report.query.projectId} frozen={frozen}
        openIssue={openIssue} formatTime={value => time(value, report.query.timeZone)} />
        : frozen && <p className="reports-method">이 보관본에는 상태별 체류 시간 기록이 없습니다.</p>}
      <section className="card reports-drilldown" aria-label="보고서 업무 상세">
        <header>
          <div>
            <h2>업무별 관측 내역</h2>
            <p>
              기간에 관측된 업무와 현재 조건에 맞는 업무를 함께 표시합니다. 상태·제목은 해당 관측 내역을
              따릅니다.
            </p>
          </div>
          <span>{rows.length.toLocaleString()}개</span>
        </header>
        <div className="reports-row-filters">
          <input
            className="field"
            aria-label="보고서 업무 검색"
            placeholder="업무 번호·제목·상태 검색"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
          <select
            className="field"
            aria-label="보고서 업무 관측 필터"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setOffset(0);
            }}
          >
            <option value="all">모든 업무</option>
            <option value="completed">완료 관측</option>
            <option value="reopened">재오픈 관측</option>
            <option value="deleted">삭제된 업무</option>
          </select>
        </div>
        <div className="reports-table-scroll">
          <table>
            <thead>
              <tr>
                <th>업무</th>
                <th>관측 상태</th>
                <th>완료 / 재오픈</th>
                <th>마지막 관측 완료</th>
                <th>해당 완료의 진행→완료</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(start, start + 50).map((row) => (
                <IssueRow
                  key={row.issue.issueId}
                  row={row}
                  data={data}
                  openIssue={openIssue}
                  timeZone={report.query.timeZone}
                />
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="reports-no-rows">조건에 맞는 업무가 없습니다.</p>}
        </div>
        <div className="reports-pagination">
          <span>
            {rows.length ? start + 1 : 0}–{Math.min(start + 50, rows.length)} / {rows.length}
          </span>
          <button
            className="btn btn-ghost"
            aria-label="보고서 업무 이전 페이지"
            disabled={start === 0}
            onClick={() => setOffset(Math.max(0, start - 50))}
          >
            이전
          </button>
          <button
            className="btn btn-ghost"
            aria-label="보고서 업무 다음 페이지"
            disabled={start + 50 >= rows.length}
            onClick={() => setOffset(start + 50)}
          >
            다음
          </button>
        </div>
      </section>
    </section>
  );
}
function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="card reports-stat" aria-label={label}>
      <span>{label}</span>
      <strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
function IssueRow({
  row,
  data,
  openIssue,
  timeZone,
}: {
  row: ReportIssueMetric;
  data: FeatureProps['data'];
  openIssue: FeatureProps['openIssue'];
  timeZone: string;
}) {
  const available = !row.deleted && data.issues.some((issue) => issue.id === row.issue.issueId);
  return (
    <tr>
      <td>
        {available ? (
          <button className="reports-issue-link" onClick={() => openIssue(row.issue.issueId)}>
            <strong>{row.issue.key}</strong>
            <span>{row.issue.title}</span>
          </button>
        ) : (
          <span className="reports-missing-issue">
            <strong>{row.issue.key}</strong>
            {row.issue.title}
            <small>현재 업무를 열 수 없음</small>
          </span>
        )}
        {row.deleted && <small>삭제됨</small>}
      </td>
      <td>
        <span className="reports-status">
          <i style={{ background: META[row.issue.category].color }} />
          {row.issue.statusLabel}
        </span>
      </td>
      <td>
        {row.completed} / {row.reopened}
      </td>
      <td>{time(row.lastCompletedAt, timeZone)}</td>
      <td>{reportDuration(row.cycleHours)}</td>
    </tr>
  );
}
function DailyCharts({ days }: { days: ReportDay[] }) {
  const maxState = Math.max(
      1,
      ...days.map((day) =>
        day.state ? CATEGORIES.reduce((sum, category) => sum + day.state![category], 0) : 0,
      ),
    ),
    maxFlow = Math.max(1, ...days.flatMap((day) => [day.created, day.completed, day.reopened]));
  return (
    <div className="reports-charts">
      <section className="card reports-chart" aria-label="일별 상태 흐름">
        <header>
          <h2>일별 상태 흐름</h2>
          <p>각 날짜 종료 직전의 관측 상태 · 오늘은 집계 시점까지</p>
        </header>
        <div className="reports-chart-legend">
          {CATEGORIES.map((category) => (
            <span key={category}>
              <i style={{ background: META[category].color }} />
              {META[category].label}
            </span>
          ))}
        </div>
        <div className="reports-chart-scroll">
          <div className="reports-chart-plot" style={{ minWidth: Math.max(420, days.length * 38) }}>
            {days.map((day) => (
              <div className={`reports-chart-day is-${day.coverage}`} key={day.date}>
                <div
                  className="reports-stack"
                  role="img"
                  aria-label={`${day.date} ${COVERAGE[day.coverage]} · ${day.state ? CATEGORIES.map((category) => `${META[category].label} ${day.state![category]}`).join(', ') : '상태 값 없음'}`}
                >
                  {day.state ? (
                    CATEGORIES.map((category) => (
                      <i
                        key={category}
                        style={{
                          height: `${(day.state![category] / maxState) * 100}%`,
                          background: META[category].color,
                        }}
                      />
                    ))
                  ) : (
                    <span>미관측</span>
                  )}
                </div>
                <small>{day.date.slice(5)}</small>
                {day.coverage !== 'complete' && (
                  <span className="reports-day-coverage">
                    {day.coverage === 'partial' ? '일부' : '미관측'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="card reports-chart" aria-label="일별 생성 완료 재오픈">
        <header>
          <h2>생성 · 완료 · 재오픈</h2>
          <p>관측된 전이 수 · 같은 업무의 반복 완료 포함</p>
        </header>
        <div className="reports-chart-legend">
          <span>
            <i style={{ background: '#557fe0' }} />
            생성
          </span>
          <span>
            <i style={{ background: '#177c72' }} />
            완료 전이
          </span>
          <span>
            <i style={{ background: '#b5733d' }} />
            재오픈
          </span>
        </div>
        <div className="reports-chart-scroll">
          <div className="reports-chart-plot" style={{ minWidth: Math.max(420, days.length * 38) }}>
            {days.map((day) => (
              <div className={`reports-chart-day is-${day.coverage}`} key={day.date}>
                <div
                  className="reports-flow"
                  role="img"
                  aria-label={
                    day.coverage === 'unobserved'
                      ? `${day.date} 미관측 · 수치 없음`
                      : `${day.date} ${COVERAGE[day.coverage]} · 생성 ${day.created}, 완료 전이 ${day.completed}, 재오픈 ${day.reopened}`
                  }
                >
                  {day.coverage !== 'unobserved' &&
                    [
                      [day.created, '#557fe0'],
                      [day.completed, '#177c72'],
                      [day.reopened, '#b5733d'],
                    ].map(([count, color], index) => (
                      <i
                        key={index}
                        style={{
                          height: `${(Number(count) / maxFlow) * 100}%`,
                          background: String(color),
                        }}
                      />
                    ))}
                  {day.coverage === 'unobserved' && <span>미관측</span>}
                </div>
                <small>{day.date.slice(5)}</small>
                {day.coverage !== 'complete' && (
                  <span className="reports-day-coverage">
                    {day.coverage === 'partial' ? '일부' : '미관측'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
