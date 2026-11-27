'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Clock3, RefreshCw } from 'lucide-react';
import type { FeatureProps, ProjectWorklogReport } from '../../shared/types';
import { isCalendarDate } from '../../shared/calendar';
import { api } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { formatWorklogMinutes } from '../lib/worklogs';
import './worklog-report.css';

type WorklogQuery = Pick<ProjectWorklogReport, 'startDate' | 'endDate' | 'authorId'>;

function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function thisWeek(): WorklogQuery {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7);
  return { startDate: localDate(monday), endDate: localDate(today), authorId: null };
}

function sameQuery(left: WorklogQuery, right: WorklogQuery): boolean {
  return left.startDate === right.startDate && left.endDate === right.endDate && left.authorId === right.authorId;
}

function queryError(query: WorklogQuery): string {
  if (!isCalendarDate(query.startDate) || !isCalendarDate(query.endDate)) {
    return '올바른 시작일과 종료일을 입력하세요.';
  }
  const days = (Date.parse(`${query.endDate}T00:00:00Z`) - Date.parse(`${query.startDate}T00:00:00Z`)) / 86_400_000 + 1;
  return days < 1 || days > 92 ? '기간은 시작일과 종료일을 포함해 1~92일로 지정하세요.' : '';
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('ko-KR', { weekday: 'short', timeZone: 'UTC' });
}

export function WorklogReport(props: FeatureProps) {
  return <ProjectWorklogReportView key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectWorklogReportView({ data, projectId, actorId, openIssue }: FeatureProps) {
  const [initial] = useState(thisWeek);
  const [query, setQuery] = useState<WorklogQuery>(initial);
  const [baselineQuery, setBaselineQuery] = useState<WorklogQuery>(initial);
  const [report, setReport] = useState<ProjectWorklogReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const dirtyRef = useRef(false);
  const validProject = data.projects.some(project => project.id === projectId);
  const dirty = !sameQuery(query, baselineQuery);
  const validation = queryError(query);
  const authorName = (id: string) => data.users.find(user => user.id === id)?.name || `알 수 없는 작성자 (${id})`;

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const load = useCallback(async (input: WorklogQuery) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const currentSequence = ++sequence.current;
    setLoading(true);
    setError('');
    const parameters = new URLSearchParams({ startDate: input.startDate, endDate: input.endDate });
    if (input.authorId) parameters.set('authorId', input.authorId);
    try {
      const result = await api<ProjectWorklogReport>(
        `/projects/${encodeURIComponent(projectId)}/worklog-report?${parameters}`,
        { signal: controller.signal, headers: { 'X-Actor-Id': actorId } },
      );
      if (active.current && !controller.signal.aborted && sequence.current === currentSequence) {
        setReport(result);
        setBaselineQuery({ startDate: result.startDate, endDate: result.endDate, authorId: result.authorId });
      }
    } catch (cause) {
      if (active.current && !controller.signal.aborted && sequence.current === currentSequence) {
        const message = cause instanceof Error ? cause.message : '작업 시간 보고서를 불러오지 못했습니다.';
        setError(`${message} 입력한 조건과 이전 조회 결과는 유지됩니다.`);
      }
    } finally {
      if (active.current && !controller.signal.aborted && sequence.current === currentSequence) setLoading(false);
    }
  }, [projectId, actorId]);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    if (validProject) queueMicrotask(() => { if (!cancelled) void load(initial); });
    return () => {
      cancelled = true;
      active.current = false;
      request.current?.abort();
    };
  }, [validProject, initial, load]);

  const resetDraft = useCallback(() => {
    // Accepted navigation may leave this component mounted. Cancel its old query too.
    sequence.current++;
    request.current?.abort();
    setLoading(false);
    setQuery({ ...baselineQuery });
    setError('');
    dirtyRef.current = false;
  }, [baselineQuery]);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented || !dirtyRef.current) return;
      if (!window.confirm('입력 중인 작업 시간 조회 조건을 버리고 이동할까요?')) event.preventDefault();
      else afterAcceptedNavigation(event, resetDraft);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('donefac:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('donefac:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [resetDraft]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (validProject && !validation) void load({ ...query });
  }

  if (!validProject) {
    return <section className="worklog-report"><p>프로젝트를 선택하면 기록된 작업 시간을 확인할 수 있습니다.</p></section>;
  }

  const changedSinceDisplay = report && !sameQuery(query, report);
  const peakMinutes = report ? Math.max(0, ...report.days.map(day => day.minutes)) : 0;

  return (
    <section className="worklog-report" aria-label="작업 시간 보고서">
      <form className="card worklog-report-query" aria-label="작업 시간 조회 조건" onSubmit={submit}>
        <div className="worklog-report-heading">
          <h2><Clock3 size={19} />기록된 작업 시간</h2>
          <button type="button" className="btn btn-ghost" onClick={() => setQuery(previous => ({ ...thisWeek(), authorId: previous.authorId }))}>
            <CalendarDays size={15} />이번 주
          </button>
        </div>
        <p>작업 기록에 입력한 날짜를 기준으로 합산합니다. 시작일과 종료일을 포함해 최대 92일까지 조회할 수 있습니다.</p>
        <div className="worklog-report-filters">
          <label>시작일<input className="field" type="date" required aria-label="작업 시간 시작일" value={query.startDate} onChange={event => setQuery(previous => ({ ...previous, startDate: event.target.value }))} /></label>
          <label>종료일<input className="field" type="date" required aria-label="작업 시간 종료일" value={query.endDate} onChange={event => setQuery(previous => ({ ...previous, endDate: event.target.value }))} /></label>
          <label>작성자<select className="field" aria-label="작업 시간 작성자" value={query.authorId ?? ''} onChange={event => setQuery(previous => ({ ...previous, authorId: event.target.value || null }))}>
            <option value="">모든 작성자</option>
            {query.authorId && !data.users.some(user => user.id === query.authorId) && <option value={query.authorId}>{authorName(query.authorId)}</option>}
            {data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select></label>
        </div>
        <div className="worklog-report-query-actions">
          <span className={validation ? 'worklog-report-validation' : ''} aria-live="polite">
            {validation || (changedSinceDisplay ? '조건이 변경되었습니다. 조회하면 아래 결과를 갱신합니다.' : '최신 작업 기록은 조회 버튼을 눌러 갱신하세요.')}
          </span>
          <button type="submit" className="btn btn-primary" disabled={Boolean(validation)} aria-label="작업 시간 조회">
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />작업 시간 조회
          </button>
        </div>
      </form>
      {error && <p className="worklog-report-error" role="alert">{error}</p>}
      <div className="worklog-report-loading" role="status" aria-live="polite">{loading ? '작업 시간을 집계하는 중…' : ''}</div>

      {report && <section aria-label="작업 시간 조회 결과" aria-busy={loading}>
        <div className="worklog-report-result-heading">
          <div><h2>조회 결과</h2><p><time dateTime={report.startDate}>{report.startDate}</time> ~ <time dateTime={report.endDate}>{report.endDate}</time> · {report.authorId ? authorName(report.authorId) : '모든 작성자'}</p></div>
          {changedSinceDisplay && <span className="worklog-report-old-result">이전 조건의 결과</span>}
        </div>
        <div className="worklog-report-stats">
          <article className="card"><span>기록된 시간</span><strong>{formatWorklogMinutes(report.minutes)}</strong></article>
          <article className="card"><span>작업 기록</span><strong>{report.entryCount.toLocaleString('ko-KR')}<small>건</small></strong><small>선택한 기간의 기록</small></article>
          <article className="card"><span>작성자</span><strong>{report.byAuthor.length.toLocaleString('ko-KR')}<small>명</small></strong><small>시간을 기록한 작성자</small></article>
          <article className="card"><span>업무</span><strong>{report.byIssue.length.toLocaleString('ko-KR')}<small>개</small></strong><small>시간이 기록된 업무</small></article>
        </div>
        {report.entryCount === 0 && <div className="worklog-report-empty"><Clock3 size={20} /><p>선택한 조건에 해당하는 작업 기록이 없습니다.</p></div>}

        <section className="card worklog-report-daily" aria-label="날짜별 작업 시간">
          <div className="worklog-report-heading"><h2>날짜별 작업 시간</h2><span>작업일 기준</span></div>
          <div className="worklog-report-table-scroll">
            <table>
              <caption className="sr-only">조회 기간의 날짜별 기록 시간과 건수</caption>
              <thead><tr><th scope="col">날짜</th><th scope="col">기록된 시간</th><th scope="col">기록 건수</th></tr></thead>
              <tbody>{report.days.map(day => <tr key={day.date}>
                <th scope="row"><time dateTime={day.date}>{day.date}</time><span className="worklog-report-weekday">{weekday(day.date)}</span></th>
                <td><div className="worklog-report-daily-value"><span>{formatWorklogMinutes(day.minutes)}</span><div className="worklog-report-bar" aria-hidden="true"><span style={{ width: `${peakMinutes ? day.minutes / peakMinutes * 100 : 0}%` }} /></div></div></td>
                <td>{day.entries.toLocaleString('ko-KR')}건</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <div className="worklog-report-breakdowns">
          <section className="card" aria-label="작성자별 작업 시간">
            <div className="worklog-report-heading"><h2>작성자별 작업 시간</h2><span>{report.byAuthor.length.toLocaleString('ko-KR')}명</span></div>
            {report.byAuthor.length === 0 ? <p className="worklog-report-no-rows">작성자별 기록이 없습니다.</p> : <div className="worklog-report-table-scroll"><table>
              <caption className="sr-only">작성자별 기록 시간과 건수</caption>
              <thead><tr><th scope="col">작성자</th><th scope="col">기록된 시간</th><th scope="col">기록 건수</th></tr></thead>
              <tbody>{report.byAuthor.map(item => <tr key={item.authorId}><th scope="row">{authorName(item.authorId)}</th><td>{formatWorklogMinutes(item.minutes)}</td><td>{item.entries.toLocaleString('ko-KR')}건</td></tr>)}</tbody>
            </table></div>}
          </section>
          <section className="card" aria-label="업무별 작업 시간">
            <div className="worklog-report-heading"><h2>업무별 작업 시간</h2><span>{report.byIssue.length.toLocaleString('ko-KR')}개</span></div>
            {report.byIssue.length === 0 ? <p className="worklog-report-no-rows">업무별 기록이 없습니다.</p> : <div className="worklog-report-table-scroll"><table>
              <caption className="sr-only">업무별 기록 시간과 건수</caption>
              <thead><tr><th scope="col">업무</th><th scope="col">기록된 시간</th><th scope="col">기록 건수</th></tr></thead>
              <tbody>{report.byIssue.map(item => <tr key={item.issueId}>
                <th scope="row">{item.deleted ? <span className="worklog-report-issue"><span>{item.key}</span><strong>{item.title}</strong><small>삭제된 업무</small></span> : <button type="button" className="worklog-report-issue worklog-report-issue-link" onClick={() => openIssue(item.issueId)} aria-label={`${item.key} ${item.title} 업무 열기`}><span>{item.key}</span><strong>{item.title}</strong></button>}</th>
                <td>{formatWorklogMinutes(item.minutes)}</td><td>{item.entries.toLocaleString('ko-KR')}건</td>
              </tr>)}</tbody>
            </table></div>}
          </section>
        </div>
      </section>}
    </section>
  );
}
