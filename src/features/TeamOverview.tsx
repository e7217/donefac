'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowUpRight, CalendarClock, CalendarDays, ChevronRight, ClipboardCheck, GitBranch, RefreshCw, SquareChartGantt } from 'lucide-react';
import { DEFAULT_RESERVATION_TIME_ZONE, reservationDayRange, reservationLocalDateTime } from '../../shared/time-reservations';
import {
  PRIORITY, TEAM_OVERVIEW_ISSUE_METRICS, type DocumentPublicationTarget, type FeatureProps, type TeamOverviewDeadline,
  type TeamOverviewFilters, type TeamOverviewIssueMetric, type TeamOverviewIssueQueueItem, type TeamOverviewPage, type TeamOverviewResult,
} from '../../shared/types';
import type { ScheduleDependencyEndpoint } from '../../shared/schedule-dependencies';
import { api } from '../lib/api';
import { gitlabActivityKindLabel, gitlabActivityStateLabel, gitlabActivityUrl } from './GitlabActivity';
import './team-overview.css';

type Props = Pick<FeatureProps, 'data' | 'openIssue'> & {
  filters: TeamOverviewFilters;
  onFiltersChange: (filters: TeamOverviewFilters) => void;
  openPublication: (id: string, kind: DocumentPublicationTarget['kind'], revisionId: string) => void | Promise<void>;
  openProject: (projectId: string, destination: 'overview' | 'gantt' | 'development') => void;
  onOpenIssueSchedule: (issueId: string, endpoint: ScheduleDependencyEndpoint) => boolean;
};
type SectionKey = 'deadlines' | 'reviews' | 'gitlab' | 'reservations';
type Offsets = Partial<Record<SectionKey, number>>;
type LoadResult = { requestKey: string; data: TeamOverviewResult | null; error: string };

const metricLabels = {
  open: '열린 업무', overdue: '마감 초과', dueSoon: '오늘부터 7일 이내', unscheduled: '일정 미정', unassigned: '미배정',
} satisfies Record<TeamOverviewIssueMetric, string>;
const timingLabels = { overdue: '마감 초과', today: '오늘 마감', soon: '7일 이내', later: '마감 예정' };
const issueSectionId = 'team-overview-issue-results';
const offsetKeys = { deadlines: 'deadlineOffset', reviews: 'reviewOffset', gitlab: 'gitlabOffset', reservations: 'reservationOffset' } as const;
const formatCount = (count: number) => count.toLocaleString('ko-KR');
const todayInSeoul = () => reservationLocalDateTime(new Date().toISOString()).slice(0, 10);

function localTime(instant: string, zone: string): string {
  return reservationLocalDateTime(instant, zone).replace('T', ' ');
}

function Section<T>({ id, title, icon, page, busy, empty, onPage, renderItem }: {
  id?: string;
  title: string;
  icon: ReactNode;
  page: TeamOverviewPage<T>;
  busy: boolean;
  empty: string;
  onPage: (offset: number) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const headingId = useId();
  const hasNext = page.offset + page.limit < page.total;
  return <section id={id} className="card team-overview-section" aria-labelledby={headingId} aria-busy={busy}>
    <header className="team-overview-section-heading">
      <h2 id={headingId}>{icon}{title}</h2><span>{formatCount(page.total)}건</span>
    </header>
    {page.items.length > 0
      ? <ul className="team-overview-list">{page.items.map(renderItem)}</ul>
      : <p className="team-overview-empty">{page.offset && page.total ? '이 페이지에 표시할 항목이 없습니다.' : empty}</p>}
    {(page.offset > 0 || hasNext) && <nav className="team-overview-pagination" aria-label={`${title} 페이지`}>
      <button type="button" className="btn btn-ghost" disabled={busy || page.offset === 0}
        onClick={() => onPage(Math.max(0, page.offset - page.limit))}>이전</button>
      <span>{page.items.length ? `${formatCount(page.offset + 1)}–${formatCount(page.offset + page.items.length)}` : '0'} / {formatCount(page.total)}</span>
      <button type="button" className="btn btn-ghost" disabled={busy || !hasNext} onClick={() => onPage(page.offset + page.limit)}>다음</button>
    </nav>}
  </section>;
}

export function TeamOverview(props: Props) {
  const { data, filters, onFiltersChange } = props;
  const [today, setToday] = useState(todayInSeoul);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const date = filters.date || today;
  return <div className="page team-overview-page">
    <header className="page-heading team-overview-heading">
      <div><h1>팀 개요</h1><p>기준일 <time dateTime={date}>{date}</time> · 서울 시간</p></div>
      <button className="btn btn-ghost" type="button" aria-label="팀 개요 새로고침"
        onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />새로고침</button>
    </header>

    <div className="card team-overview-filters">
      <label>프로젝트<select className="field" aria-label="프로젝트 필터" value={filters.projectId}
        onChange={event => onFiltersChange({ ...filters, projectId: event.target.value, issueOffset: undefined })}>
        <option value="">전체 프로젝트</option>
        {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>팀원<select className="field" aria-label="팀원 필터" value={filters.memberId}
        onChange={event => onFiltersChange({ ...filters, memberId: event.target.value, issueOffset: undefined })}>
        <option value="">전체 팀원</option>
        {data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select></label>
      <label>기준일<input className="field" type="date" value={date} min="0001-01-01" max="9999-12-30"
        onChange={event => {
          if (event.target.value && event.target.validity.valid) onFiltersChange({ ...filters, date: event.target.value, issueOffset: undefined });
        }} /></label>
      {filters.date && <button className="btn btn-ghost team-overview-today" type="button" onClick={() => {
        setToday(todayInSeoul());
        onFiltersChange({ ...filters, date: '', issueOffset: undefined });
      }}>오늘</button>}
      {filters.memberId && <p className="team-overview-scope-note">업무와 GitLab은 담당·협력, 문서는 검토자, 시간 배정은 배정된 팀원을 기준으로 조회합니다.</p>}
    </div>
    <OverviewContent key={JSON.stringify([filters.projectId, filters.memberId, filters.date])}
      {...props} refreshVersion={refreshVersion} onDefaultDate={setToday} />
  </div>;
}

function OverviewContent({ data, filters, openIssue, openPublication, openProject, onFiltersChange, onOpenIssueSchedule, refreshVersion, onDefaultDate }: Props & {
  refreshVersion: number;
  onDefaultDate: (date: string) => void;
}) {
  const [offsets, setOffsets] = useState<Offsets>({});
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadResult | null>(null);
  const projectNames = new Map(data.projects.map(project => [project.id, project.name]));
  const memberNames = new Map(data.users.map(user => [user.id, user.name]));
  const query = new URLSearchParams();
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.memberId) query.set('memberId', filters.memberId);
  if (filters.date) query.set('date', filters.date);
  const issueMetric = filters.issueMetric;
  if (issueMetric) {
    query.set('issueMetric', issueMetric);
    if (filters.issueOffset) query.set('issueOffset', String(filters.issueOffset));
  }
  for (const section of Object.keys(offsetKeys) as SectionKey[]) {
    const offset = offsets[section];
    if (offset) query.set(offsetKeys[section], String(offset));
  }
  const path = `/team-overview?${query}`;
  const requestKey = `${path}#${refreshVersion}:${revision}`;
  const busy = loaded?.requestKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    void api<TeamOverviewResult>(path, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setLoaded({ requestKey, data: result, error: '' });
      if (!filters.date) onDefaultDate(result.date);
    }, cause => {
      if (!controller.signal.aborted) setLoaded(previous => ({
        requestKey, data: previous?.data ?? null,
        error: cause instanceof Error ? cause.message : '팀 개요를 불러오지 못했습니다.',
      }));
    });
    return () => controller.abort();
  }, [path, requestKey, data, filters.date, onDefaultDate]);

  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    const events = ['focus', 'teamspace:trash-changed', 'teamspace:workspace-imported', 'teamspace:time-reservations-changed'];
    for (const event of events) window.addEventListener(event, changed);
    return () => { for (const event of events) window.removeEventListener(event, changed); };
  }, []);

  const result = loaded?.data;
  const queue = result?.issueQueue?.metric === issueMetric ? result?.issueQueue : undefined;
  const zone = result?.timeZone ?? DEFAULT_RESERVATION_TIME_ZONE;
  useEffect(() => {
    if (filters.date || !result?.date || result.date !== todayInSeoul()) return;
    const end = reservationDayRange(result.date, zone)?.endAt;
    if (!end) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), Math.max(1000, Date.parse(end) - Date.now() + 25));
    return () => window.clearTimeout(timer);
  }, [filters.date, result?.date, zone]);
  const pageTo = (key: SectionKey, offset: number) => setOffsets(previous => ({ ...previous, [key]: offset }));
  const projectName = (id: string | null) => id === null ? '팀 공통 문서' : projectNames.get(id) ?? '프로젝트';
  const memberName = (id: string | null) => id === null ? '미배정' : memberNames.get(id) ?? '팀원';

  function issueRow(issue: TeamOverviewDeadline | TeamOverviewIssueQueueItem) {
    const isQueueItem = 'startDate' in issue;
    const missingStart = isQueueItem && !issue.startDate;
    const missingEnd = isQueueItem && !issue.endDate;
    const missingLabel = missingStart && missingEnd ? '시작일·종료일 미정' : missingStart ? '시작일 미정' : missingEnd ? '종료일 미정' : null;
    const endpoint = missingStart ? 'startDate' : missingEnd ? 'endDate' : null;
    const action = missingStart ? '시작일 입력' : '종료일 입력';
    return <li key={issue.id} className={isQueueItem ? 'team-overview-queue-row' : undefined}>
      <button type="button" className="team-overview-row-button" onClick={() => openIssue(issue.id)}>
        <span className="team-overview-row-main">
          <strong><span className="issue-key">{issue.key}</span> {issue.title}</strong>
          <span className="team-overview-row-detail">{projectName(issue.projectId)} · {memberName(issue.assigneeId)} · <span className="status-dot"
            style={{ background: issue.statusColor }} aria-hidden="true" />{issue.statusLabel}
            {isQueueItem && ` · ${PRIORITY[issue.priority]}`}
          </span>
        </span>
        <span className="team-overview-row-side" data-timing={issue.timing ?? undefined}>
          {issue.deadline && issue.timing
            ? <><span>{timingLabels[issue.timing]} · {issue.deadlineSource === 'dueDate' ? '목표 마감일' : '계획 종료일'}</span>
                <time dateTime={issue.deadline}>{issue.deadline}</time></>
            : <span>마감일 미정</span>}
          {missingLabel && <span>{missingLabel}</span>}
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      {endpoint && <div className="team-overview-queue-actions">
        <button type="button" className="btn" aria-label={`${issue.key} ${action}`} onClick={() => onOpenIssueSchedule(issue.id, endpoint)}>
          <SquareChartGantt size={15} aria-hidden="true" />{action}
        </button>
      </div>}
    </li>;
  }

  return <>
    {!result && busy && <p className="card team-overview-message" role="status">팀 개요를 불러오는 중입니다.</p>}
    {loaded?.error && !busy && <div className="card team-overview-message team-overview-error">
      <p role="alert">{loaded.error}</p>
      <button className="btn" type="button" onClick={() => setRevision(value => value + 1)}>다시 불러오기</button>
    </div>}
    {result && <>
      <div className="team-overview-metrics" role="group" aria-label="업무 현황" aria-busy={busy}>
        {TEAM_OVERVIEW_ISSUE_METRICS.map(metric => <button className="card team-overview-metric" type="button" key={metric}
          data-metric={metric} aria-label={metricLabels[metric]} aria-pressed={metric === issueMetric} aria-controls={issueSectionId}
          aria-describedby={`team-overview-metric-${metric}`} onClick={() => onFiltersChange({
            ...filters, issueMetric: metric === issueMetric ? undefined : metric, issueOffset: undefined,
          })}>
          <span className="team-overview-metric-label">{metricLabels[metric]}</span>
          <span id={`team-overview-metric-${metric}`} className="team-overview-metric-value">{formatCount(result.totals[metric])}<span>건</span></span>
        </button>)}
      </div>

      <div className="team-overview-grid">
        {issueMetric
          ? <Section id={issueSectionId} title={metricLabels[issueMetric]} icon={<CalendarDays size={18} aria-hidden="true" />}
              page={queue ?? { items: [], total: 0, offset: 0, limit: 10 }} busy={busy}
              onPage={offset => onFiltersChange({ ...filters, issueOffset: offset || undefined })}
              empty={busy ? '업무 목록을 불러오는 중입니다.' : loaded?.error ? '업무 목록을 불러오지 못했습니다.' : '조건에 맞는 열린 업무가 없습니다.'}
              renderItem={issueRow} />
          : <Section id={issueSectionId} title="마감 확인" icon={<CalendarDays size={18} aria-hidden="true" />} page={result.deadlines}
              busy={busy} onPage={offset => pageTo('deadlines', offset)} empty="마감이 지났거나 7일 이내인 열린 업무가 없습니다."
              renderItem={issueRow} />}

        <Section title="검토 대기 문서" icon={<ClipboardCheck size={18} aria-hidden="true" />} page={result.reviews}
          busy={busy} onPage={offset => pageTo('reviews', offset)} empty="검토를 기다리는 문서가 없습니다."
          renderItem={review => <li key={review.documentId}>
            <button type="button" className="team-overview-row-button"
              onClick={() => { void openPublication(review.documentId, 'review', review.revision.id); }}>
              <span className="team-overview-row-main">
                <strong>{review.revision.title}</strong>
                <span className="team-overview-row-detail">{projectName(review.projectId)} · 검토자 {memberName(review.reviewerId)}</span>
              </span>
              <span className="team-overview-row-side">
                <span>저장본 v{review.revision.version}</span><time dateTime={review.actionAt}>{localTime(review.actionAt, zone)}</time>
              </span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </li>} />

        <Section title="최근 GitLab 활동" icon={<GitBranch size={18} aria-hidden="true" />} page={result.gitlab}
          busy={busy} onPage={offset => pageTo('gitlab', offset)} empty="기준일을 포함한 최근 7일간 연결된 GitLab 활동이 없습니다."
          renderItem={({ link, issueId, issueKey, issueTitle, projectId }) => {
            const url = link.kind === 'branch' && link.state === 'deleted' ? null : gitlabActivityUrl(link.webUrl, link.kind);
            const title = link.kind === 'branch' ? link.sourceBranch || link.title : link.title;
            const kind = gitlabActivityKindLabel(link.kind);
            return <li key={link.id} className="team-overview-gitlab-row">
              <div className="team-overview-row-main">
                {url ? <a href={url.href} target="_blank" rel="noreferrer" className="team-overview-gitlab-link">
                  <strong>{title}</strong><ArrowUpRight size={15} aria-hidden="true" />
                </a> : <strong>{title}</strong>}
                <span className="team-overview-row-detail">{projectName(projectId)} · {kind} · {gitlabActivityStateLabel(link.state)}</span>
              </div>
              <div className="team-overview-row-side">
                <button type="button" className="text-link team-overview-issue-link" aria-label={`${issueKey} ${issueTitle} 업무 열기`}
                  onClick={() => openIssue(issueId)}>{issueKey}</button>
                <time dateTime={link.updatedAt}>{localTime(link.updatedAt, zone)}</time>
              </div>
            </li>;
          }} />

        <Section title="당일 시간 배정" icon={<CalendarClock size={18} aria-hidden="true" />} page={result.reservations}
          busy={busy} onPage={offset => pageTo('reservations', offset)} empty="해당 일자의 확정 시간 배정이 없습니다."
          renderItem={reservation => {
            const start = localTime(reservation.startAt, zone);
            const end = localTime(reservation.endAt, zone);
            const endLabel = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end;
            return <li key={reservation.id}>
              <button type="button" className="team-overview-row-button" onClick={() => openIssue(reservation.issueId)}>
                <span className="team-overview-row-main">
                  <strong><span className="issue-key">{reservation.issueKey}</span> {reservation.issueTitle}</strong>
                  <span className="team-overview-row-detail">{projectName(reservation.projectId)} · {memberName(reservation.userId)}</span>
                </span>
                <span className="team-overview-row-side team-overview-time-range">
                  <time dateTime={reservation.startAt}>{start.slice(0, 10) === result.date ? start.slice(11) : start}</time>
                  <span aria-hidden="true">–</span><time dateTime={reservation.endAt}>{endLabel}</time>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </li>;
          }} />
      </div>

      <section className="card team-overview-projects" aria-labelledby="team-overview-projects-heading" aria-busy={busy}>
        <header className="team-overview-section-heading"><h2 id="team-overview-projects-heading">프로젝트 바로 가기</h2></header>
        {result.projects.length ? <div className="team-overview-project-list">
          {result.projects.map(project => <article className="team-overview-project-row" key={project.projectId} aria-label={projectName(project.projectId)}>
            <div className="team-overview-row-main">
              <button className="text-link team-overview-project-title" type="button" onClick={() => openProject(project.projectId, 'overview')}>{projectName(project.projectId)}</button>
              <span className="team-overview-row-detail">열린 업무 {formatCount(project.open)}건 · 마감 초과 {formatCount(project.overdue)}건 · 일정 미정 {formatCount(project.unscheduled)}건</span>
            </div>
            <div className="team-overview-project-actions">
              <button className="btn" type="button" onClick={() => openProject(project.projectId, 'gantt')}><SquareChartGantt size={15} aria-hidden="true" />간트 열기</button>
              <button className="btn" type="button" onClick={() => openProject(project.projectId, 'development')}><GitBranch size={15} aria-hidden="true" />GitLab 활동 열기</button>
            </div>
          </article>)}
        </div> : <p className="team-overview-empty">표시할 프로젝트가 없습니다.</p>}
      </section>
    </>}
  </>;
}
