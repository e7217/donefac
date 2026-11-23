'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChartNoAxesCombined, ChevronDown, RefreshCw } from 'lucide-react';
import { CYCLE_PROGRESS_MAX_DAYS, type CycleProgressReport, type FeatureProps, type PlanningItem } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { dayNumber, errorMessage, isoDay, moveDate } from './schedule-utils';
import './cycle-progress.css';

type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'openIssue'> & { cycle: PlanningItem };
type Metric = 'issues' | 'estimate';
type Day = CycleProgressReport['days'][number];
type DayState = NonNullable<Day['state']>;
type Evidence = NonNullable<CycleProgressReport['evidence']>;
type Change = keyof NonNullable<Day['changes']>;
type QueryResult = { key: string; data: CycleProgressReport } | { key: string; error: string; status?: number };

const DAYS_PER_TABLE_PAGE = 7;
const metricLabels: Record<Metric, string> = { issues: '업무 수', estimate: '스토리 포인트' };
const changes: Record<Change, string> = {
  added: '범위 추가', removed: '범위 제거', completed: '완료', cancelled: '취소', reopened: '다시 열림',
  estimateChanged: '추정치 변경', reclassified: '워크플로 분류 변경',
};
const changeKinds = Object.keys(changes) as Change[];
const formatNumber = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 });
const formatTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const formatTimestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
const measurement = (state: DayState, type: 'remaining' | 'scope', metric: Metric) => metric === 'issues'
  ? type === 'remaining' ? state.remainingIssues : state.scopeIssues
  : type === 'remaining' ? state.remainingEstimate : state.scopeEstimate;
const coverageLabels = { complete: '관측', partial: '부분 관측', unobserved: '미관측' } as const;
const countLabel = (count: number) => `${formatNumber.format(count)}건`;
const pointLabel = (point: number | null) => point === null ? '미입력' : `${formatNumber.format(point)}점`;
const abbreviatedDate = (date: string) => date.slice(5).replace('-', '.');

function useProgressQuery(path: string | null, key: string, actorId: string, projectId: string, cycleId: string) {
  const [response, setResponse] = useState<QueryResult | null>(null);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<CycleProgressReport>(path, { signal: controller.signal, cache: 'no-store', headers: { 'X-Actor-Id': actorId } })
      .then(data => {
        if (controller.signal.aborted) return;
        if (data?.cycle?.id !== cycleId || data.cycle.projectId !== projectId || !Array.isArray(data.days)) {
          throw new Error('선택한 사이클의 진행 추이를 확인할 수 없습니다.');
        }
        setResponse({ key, data });
      }).catch(cause => {
        if (!controller.signal.aborted) setResponse({ key, error: errorMessage(cause), status: cause instanceof ApiError ? cause.status : undefined });
      });
    return () => controller.abort();
  }, [actorId, cycleId, key, path, projectId]);

  return path && response?.key === key ? response : null;
}

export function CycleProgress(props: Props) {
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('teamspace:workspace-imported', close);
    return () => window.removeEventListener('teamspace:workspace-imported', close);
  }, []);

  return <section className="cycle-progress" aria-labelledby={headingId}>
    <h3 id={headingId}>
      <button className="btn btn-ghost cycle-progress-toggle" type="button" aria-expanded={open} aria-controls={bodyId}
        onClick={() => setOpen(expanded => !expanded)}>
        <ChartNoAxesCombined size={16} aria-hidden="true" />사이클 진행 추이<ChevronDown size={15} aria-hidden="true" />
      </button>
    </h3>
    <div id={bodyId} hidden={!open}>
      {open && <ProgressBody key={JSON.stringify([props.projectId, props.actorId, props.cycle.id])} {...props} />}
    </div>
  </section>;
}

function ProgressBody({ cycle, data, projectId, actorId, openIssue }: Props) {
  const [metric, setMetric] = useState<Metric>('issues');
  const [throughDate, setThroughDate] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const source = useMemo(() => {
    const liveIds = new Set<string>();
    const members = [];
    for (const issue of data.issues) {
      if (issue.projectId !== projectId) continue;
      liveIds.add(issue.id);
      if (issue.cycleId === cycle.id) members.push(`${issue.id}:${issue.version}`);
    }
    return { liveIds, memberKey: members.sort().join(',') };
  }, [data.issues, cycle.id, projectId]);
  const route = `/projects/${encodeURIComponent(projectId)}/cycles/${encodeURIComponent(cycle.id)}/progress`;
  const path = throughDate ? `${route}?${new URLSearchParams({ throughDate })}` : route;
  const requestKey = JSON.stringify([path, cycle.version, data.workflows?.find(item => item.projectId === projectId)?.version,
    source.memberKey, refreshCount]);
  const response = useProgressQuery(path, requestKey, actorId, projectId, cycle.id);
  const report = response && 'data' in response ? response.data : null;
  const reportDays = report?.days ?? [];
  const latest = reportDays.findLast(day => day.state !== null);
  const selected = reportDays.find(day => day.date === date) ?? latest;
  const latestState = latest?.state;
  const totalPages = Math.ceil(reportDays.length / DAYS_PER_TABLE_PAGE);
  const page = Math.min(tablePage, Math.max(0, totalPages - 1));
  const visible = reportDays.toReversed().slice(page * DAYS_PER_TABLE_PAGE, (page + 1) * DAYS_PER_TABLE_PAGE);

  function changeWindow(target: string | null) {
    setThroughDate(target);
    setDate(null);
    setTablePage(0);
  }

  function refresh() { setRefreshCount(count => count + 1); }

  return <div className="cycle-progress-body" aria-busy={!response}>
    <div className="cycle-progress-controls">
      <div role="group" aria-label="진행 추이 집계 기준" className="cycle-progress-metrics">
        {(['issues', 'estimate'] as const).map(item => <button key={item} type="button" className="btn" aria-pressed={metric === item}
          onClick={() => setMetric(item)}>{metricLabels[item]}</button>)}
      </div>
      <button className="btn btn-ghost" type="button" disabled={!response} onClick={refresh}>
        <RefreshCw size={14} aria-hidden="true" />진행 추이 새로고침
      </button>
    </div>
    {!response && <p role="status">사이클 진행 추이를 불러오는 중입니다.</p>}
    {response && 'error' in response && <p className="issue-form-error" role="alert">{response.error}</p>}
    {report && <>
      <div className="cycle-progress-window">
        <div>
          {report.windowStart && report.windowEnd && <p className="cycle-progress-period">
            <time dateTime={report.windowStart}>{report.windowStart}</time> ~ <time dateTime={report.windowEnd}>{report.windowEnd}</time> · 서울 기준
          </p>}
          {report.completedAt && <small>당시 사이클 완료 <time dateTime={report.completedAt}>{formatTimestamp.format(new Date(report.completedAt))}</time></small>}
        </div>
        {report.windowStart && report.windowEnd && report.lastDate &&
          (report.windowStart > report.firstDate || report.windowEnd < report.lastDate) && <nav aria-label="진행 추이 날짜 범위" className="cycle-progress-paging">
            <button className="btn btn-ghost" type="button" disabled={report.windowStart <= report.firstDate}
              onClick={() => changeWindow(moveDate(report.windowStart!, -1))}><ArrowLeft size={14} aria-hidden="true" />이전 기간</button>
            <button className="btn btn-ghost" type="button" disabled={report.windowEnd >= report.lastDate} onClick={() => {
              const next = isoDay(Math.min(dayNumber(report.windowEnd!) + CYCLE_PROGRESS_MAX_DAYS, dayNumber(report.lastDate!)));
              changeWindow(next === report.lastDate ? null : next);
            }}>다음 기간<ArrowRight size={14} aria-hidden="true" /></button>
          </nav>}
      </div>
      {latestState && latest ? <>
        <dl className="cycle-progress-summary" aria-label={`${latest.date} 관측 요약`}>
          <div><dt>남은 {metricLabels[metric]}</dt><dd>{formatNumber.format(measurement(latestState, 'remaining', metric))}</dd></div>
          <div><dt>사이클 범위</dt><dd>{formatNumber.format(measurement(latestState, 'scope', metric))}</dd></div>
          <div><dt>관측 기준일</dt><dd><time dateTime={latest.date}>{latest.date}</time></dd><small>{coverageLabels[latest.coverage]}</small></div>
        </dl>
        {metric === 'estimate' && latestState.missingScopeEstimate > 0 && <p className="cycle-progress-note">
          입력한 추정치를 합산합니다. 추정치 미입력은 범위 {countLabel(latestState.missingScopeEstimate)}, 남은 업무 {countLabel(latestState.missingRemainingEstimate)}입니다.
        </p>}
        <ProgressChart days={reportDays} metric={metric} selected={selected?.date ?? null} />
      </> : <p className="cycle-progress-note" role="status">{reportDays.length ? '이 기간에 관측된 업무 기록이 없습니다.' : '아직 집계할 사이클 날짜가 없습니다.'}</p>}
      {reportDays.length > 0 && <>
        <div className="cycle-progress-table-wrap">
          <table className="cycle-progress-table">
            <caption className="sr-only">날짜별 사이클 범위와 남은 {metricLabels[metric]}</caption>
            <thead><tr><th scope="col">날짜</th><th scope="col">관측 상태</th><th scope="col">범위</th><th scope="col">남음</th></tr></thead>
            <tbody>{visible.map(day => <tr key={day.date} data-selected={selected?.date === day.date || undefined}>
              <th scope="row"><button type="button" className="cycle-progress-day" aria-pressed={selected?.date === day.date}
                aria-label={`${day.date} 변경 근거`} onClick={() => setDate(day.date)}><time dateTime={day.date}>{abbreviatedDate(day.date)}</time></button></th>
              <td>{coverageLabels[day.coverage]}</td>
              <td>{day.state ? formatNumber.format(measurement(day.state, 'scope', metric)) : '—'}</td>
              <td>{day.state ? formatNumber.format(measurement(day.state, 'remaining', metric)) : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {totalPages > 1 && <nav aria-label="날짜 표 페이지" className="cycle-progress-paging">
          <button className="btn btn-ghost" type="button" disabled={page === 0} onClick={() => setTablePage(page - 1)}>
            <ArrowLeft size={14} aria-hidden="true" />최근 날짜
          </button>
          <span aria-live="polite">{page + 1} / {totalPages}</span>
          <button className="btn btn-ghost" type="button" disabled={page + 1 >= totalPages} onClick={() => setTablePage(page + 1)}>
            이전 날짜<ArrowRight size={14} aria-hidden="true" />
          </button>
        </nav>}
        {!!selected && <ProgressEvidence key={selected.date} day={selected} report={report} path={path} actorId={actorId}
          openIssue={openIssue} liveIds={source.liveIds} onRefresh={refresh} />}
      </>}
    </>}
  </div>;
}

function ProgressEvidence({ day, report, path, actorId, liveIds, openIssue, onRefresh }: {
  day: Day; report: CycleProgressReport; path: string; actorId: string; liveIds: ReadonlySet<string>;
  openIssue: Props['openIssue']; onRefresh: () => void;
}) {
  const headingId = useId();
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const hasChanges = day.changes !== null && changeKinds.some(kind => day.changes![kind] > 0);
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  query.set('date', day.date);
  query.set('expectedRevision', report.revision);
  if (offset) query.set('offset', String(offset));
  const evidencePath = hasChanges ? `${path.split('?')[0]}?${query}` : null;
  const response = useProgressQuery(evidencePath, JSON.stringify([evidencePath, retry]), actorId, report.cycle.projectId, report.cycle.id);
  const evidence = response && 'data' in response && response.data.revision === report.revision &&
    response.data.evidence?.date === day.date && response.data.evidence.offset === offset ? response.data.evidence : null;
  const error = response && !evidence ? 'error' in response ? response.error : '선택한 날짜의 변경 근거를 확인할 수 없습니다.' : null;
  const stale = response && ('status' in response && response.status === 409 || 'data' in response && response.data.revision !== report.revision);

  return <section className="cycle-progress-evidence" aria-labelledby={headingId} aria-busy={hasChanges && !response}>
    <h4 id={headingId}><time dateTime={day.date}>{day.date}</time> 변경 근거</h4>
    {day.changes && hasChanges && <ul className="cycle-progress-change-counts" aria-label="날짜의 변경 건수">
      {changeKinds.filter(kind => day.changes![kind] > 0).map(kind => <li key={kind}>{changes[kind]} {countLabel(day.changes![kind])}</li>)}
    </ul>}
    {day.coverage === 'unobserved' ? <p>이 날짜에는 관측된 자료가 없습니다.</p>
      : !hasChanges ? <p>관측한 시간에 기록된 변경이 없습니다.</p> : !response && <p role="status">변경 근거를 불러오는 중입니다.</p>}
    {error && <div>
      <p className="issue-form-error" role="alert">{error}</p>
      <button className="btn btn-ghost" type="button" onClick={stale ? onRefresh : () => setRetry(count => count + 1)}>
        <RefreshCw size={14} aria-hidden="true" />{stale ? '최신 진행 추이 불러오기' : '변경 근거 다시 읽기'}
      </button>
    </div>}
    {evidence && <>
      {evidence.items.length > 0 ? <EvidenceItems evidence={evidence} liveIds={liveIds} openIssue={openIssue} />
        : <p>이 페이지에 표시할 변경 근거가 없습니다.</p>}
      {(offset > 0 || evidence.total > evidence.limit) && <nav aria-label="변경 근거 페이지" className="cycle-progress-paging">
        <button className="btn btn-ghost" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - evidence.limit))}>
          <ArrowLeft size={14} aria-hidden="true" />이전 근거
        </button>
        <span aria-live="polite">{evidence.items.length ? offset + 1 : 0}–{offset + evidence.items.length} / {formatNumber.format(evidence.total)}</span>
        <button className="btn btn-ghost" type="button" disabled={offset + evidence.limit >= evidence.total}
          onClick={() => setOffset(offset + evidence.limit)}>다음 근거<ArrowRight size={14} aria-hidden="true" /></button>
      </nav>}
    </>}
  </section>;
}

function EvidenceItems({ evidence, liveIds, openIssue }: { evidence: Evidence; liveIds: ReadonlySet<string>; openIssue: Props['openIssue'] }) {
  return <ol className="cycle-progress-evidence-list">{evidence.items.map(item => {
    const identifier = <><span>{item.key}</span><strong>{item.title}</strong></>;
    return <li key={item.id}>
      <time dateTime={item.occurredAt}>{formatTime.format(new Date(item.occurredAt))}</time>
      <div>
        {liveIds.has(item.issueId) ? <button type="button" className="cycle-progress-issue" onClick={() => openIssue(item.issueId)}>{identifier}</button>
          : <p className="cycle-progress-issue">{identifier}<small>현재 프로젝트에서 열 수 없음</small></p>}
        <p>{item.kinds.map(kind => changes[kind]).join(' · ')}</p>
        {item.kinds.includes('estimateChanged') && <p>이전 {pointLabel(item.beforeEstimate)} → 이후 {pointLabel(item.afterEstimate)}</p>}
      </div>
    </li>;
  })}</ol>;
}

function ProgressChart({ days, metric, selected }: { days: Day[]; metric: Metric; selected: string | null }) {
  const plot = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = plot.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawProgressChart(canvas, days, metric, selected));
    observer.observe(canvas);
    drawProgressChart(canvas, days, metric, selected);
    return () => observer.disconnect();
  }, [days, metric, selected]);

  return <figure className="cycle-progress-figure">
    <canvas role="img" aria-label={`${metricLabels[metric]} 사이클 범위와 남은 업무 그래프`} ref={plot} />
    <figcaption>
      <span><i aria-hidden="true" />남은 {metricLabels[metric]}</span>
      <span><i aria-hidden="true" />사이클 범위</span>
      <small>미관측 구간은 선이 끊깁니다. 부분 관측 날짜는 아래 표에 표시합니다.</small>
    </figcaption>
  </figure>;
}

function drawProgressChart(canvas: HTMLCanvasElement, days: Day[], metric: Metric, selected: string | null) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width < 90 || height < 50) return;
  const density = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(density, density);
  context.font = '11px system-ui, sans-serif';
  const paddingTop = 14, paddingBottom = 24, right = width - 20;
  const highest = days.reduce((maximum, day) => day.state ? Math.max(maximum, measurement(day.state, 'scope', metric),
    measurement(day.state, 'remaining', metric)) : maximum, 0);
  const target = Math.max(1, highest);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const ceiling = Math.ceil(target / magnitude) * magnitude;
  const marks = [ceiling, ceiling / 2, 0];
  const left = Math.max(...marks.map(value => context.measureText(formatNumber.format(value)).width)) + 14;
  const bottom = height - paddingBottom;
  const x = (index: number) => days.length === 1 ? (left + right) / 2 : left + index * (right - left) / (days.length - 1);
  const y = (value: number) => bottom - value / ceiling * (bottom - paddingTop);
  for (const value of marks) {
    const point = y(value);
    context.strokeStyle = '#dce9e1';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, point);
    context.lineTo(right, point);
    context.stroke();
    context.fillStyle = '#526b5f';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.fillText(formatNumber.format(value), left - 7, point);
  }
  const selectedIndex = days.findIndex(day => day.date === selected);
  if (selectedIndex >= 0) {
    const atX = x(selectedIndex);
    context.fillStyle = '#e8f0eb';
    context.fillRect(atX - 2, paddingTop, 4, bottom - paddingTop);
  }

  function drawLine(type: 'scope' | 'remaining', color: string, dashed: boolean) {
    const ctx = context!;
    ctx.lineWidth = type === 'scope' ? 1.5 : 2.25;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath();
    let previous = false;
    days.forEach((day, index) => {
      if (!day.state) { previous = false; return; }
      const px = x(index), py = y(measurement(day.state, type, metric));
      if (previous) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      previous = true;
    });
    ctx.stroke();
    if (type === 'scope') return;
    days.forEach((day, index) => {
      if (!day.state || days.length > 40 && index !== selectedIndex && days[index - 1]?.state && days[index + 1]?.state) return;
      ctx.beginPath();
      ctx.arc(x(index), y(measurement(day.state, type, metric)), selectedIndex === index ? 4 : 2.2, 0, 2 * Math.PI);
      ctx.fill();
    });
  }
  drawLine('scope', '#63796d', true);
  drawLine('remaining', '#236c55', false);
  context.fillStyle = '#526b5f';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const ticks = days.length < 3 ? days.map((_, index) => index) : [0, Math.floor((days.length - 1) / 2), days.length - 1];
  for (const index of ticks) context.fillText(abbreviatedDate(days[index].date), x(index), bottom + 7);
}
