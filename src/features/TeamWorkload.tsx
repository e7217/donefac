'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, Layers3, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { calendarDate, calendarDay, isCalendarDate, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from '../../shared/calendar';
import { defaultTeamWorkloadCapacity } from '../../shared/team-workload-capacity';
import type { FeatureProps, TeamWorkloadCapacity, TeamWorkloadResult } from '../../shared/types';
import { api } from '../lib/api';
import { formatWorklogMinutes } from '../lib/worklogs';
import { WORKLOAD_INCOMPLETE_REASONS, WorkloadIssueLink, WorkloadTable, type WorkloadSelection } from './ProjectWorkload';
import { WorkloadCapacityEditor } from './WorkloadCapacityEditor';
import { errorMessage } from './schedule-utils';
import './project-workload.css';

const PERIOD_DAYS = 14;
const INCOMPLETE_PER_PAGE = 12;
const FIRST_DAY = calendarDay(MIN_CALENDAR_DATE);
const LAST_DAY = calendarDay(MAX_CALENDAR_DATE);
const CAPACITY_ROUTE = '/workload-capacity';

type TeamWorkloadProps = Pick<FeatureProps, 'data' | 'refresh' | 'notify' | 'openIssue'> & {
  initialStartDate: string;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
};

type LoadResponse = {
  route: string;
  snapshot: FeatureProps['data'];
  revision: number;
  result: TeamWorkloadResult | null;
  error: string;
};

function availabilitySource(capacity: TeamWorkloadCapacity, userId: string, date: string, working: boolean) {
  if (capacity.exceptions.some(value => value.userId === userId && value.date === date)) return '개인 날짜 예외';
  const exception = capacity.calendarExceptions.find(value => value.date === date);
  if (!working) return exception?.label ? `팀 휴무일 · ${exception.label}` : '팀 휴무일';
  const daily = capacity.members.some(value => value.userId === userId) ? '담당자별 기본 가용 시간' : '팀 기본 가용 시간';
  return exception ? [daily, '팀 달력 근무일', exception.label].filter(Boolean).join(' · ') : daily;
}

function groupByProject<T extends { projectId: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.projectId);
    if (group) group.push(item);
    else groups.set(item.projectId, [item]);
  }
  return [...groups];
}

export function TeamWorkload({ data, initialStartDate, refresh, notify, openIssue, onDraftChange }: TeamWorkloadProps) {
  const [startOverride, setStartOverride] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<Set<string> | null>(null);
  const [userFilter, setUserFilter] = useState('');
  const [selected, setSelected] = useState<WorkloadSelection | null>(null);
  const [missingPage, setMissingPage] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [localCapacity, setLocalCapacity] = useState<{ source: FeatureProps['data']; value: TeamWorkloadCapacity } | null>(null);
  const [revision, setRevision] = useState(0);
  const [received, setReceived] = useState<LoadResponse | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const usersById = useMemo(() => new Map(data.users.map(user => [user.id, user])), [data.users]);
  const issuesById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const capacity = (localCapacity?.source === data ? localCapacity.value : data.teamWorkloadCapacity) ?? defaultTeamWorkloadCapacity();
  const startDate = startOverride ?? initialStartDate;
  const startDay = calendarDay(startDate);
  const endDate = calendarDate(Math.min(LAST_DAY, startDay + PERIOD_DAYS - 1));
  const chosenProjects = data.projects.filter(project => !projectFilter || projectFilter.has(project.id));
  const member = usersById.get(userFilter);
  const query = new URLSearchParams({ startDate, endDate });
  if (projectFilter) for (const project of chosenProjects) query.append('projectId', project.id);
  const route = chosenProjects.length > 0 ? `/workload?${query.toString()}` : null;

  useEffect(() => {
    if (!route) return;
    const controller = new AbortController();
    api<TeamWorkloadResult>(route, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReceived({ route, snapshot: data, revision, result, error: '' });
    }).catch(cause => {
      if (!controller.signal.aborted) setReceived({ route, snapshot: data, revision, result: null, error: errorMessage(cause) });
    });
    return () => controller.abort();
  }, [route, data, revision]);

  const current = received?.route === route && received.snapshot === data && received.revision === revision ? received : null;
  const workload = current?.result;
  const workspaceChanged = workload && (workload.projectIds.some(id => !projectsById.has(id)) ||
    workload.rows.some(row => !usersById.has(row.userId)) || workload.capacityVersion !== capacity.version);
  const rows = workload?.rows.filter(row => !member || row.userId === member.id) ?? [];
  const incomplete = workload?.incomplete.filter(value => !member || issuesById.get(value.issueId)?.assigneeId === member.id) ?? [];
  const firstMissing = Math.min(missingPage, Math.max(0, Math.ceil(incomplete.length / INCOMPLETE_PER_PAGE) - 1)) * INCOMPLETE_PER_PAGE;
  const missingGroups = groupByProject(incomplete.slice(firstMissing, firstMissing + INCOMPLETE_PER_PAGE));
  const focusedUser = selected ? usersById.get(selected.userId) : undefined;
  const focusedDay = selected && rows.find(row => row.userId === selected.userId)?.days.find(day => day.date === selected.date);
  const cellGroups = groupByProject(focusedDay?.allocations ?? []);
  const focusedCalendarDay = focusedDay && workload?.days.find(day => day.date === focusedDay.date);
  const source = focusedUser && focusedDay && focusedCalendarDay && workload?.capacityVersion === capacity.version
    ? availabilitySource(capacity, focusedUser.id, focusedDay.date, focusedCalendarDay.working) : '';
  const overloaded = rows.reduce((total, row) => total + row.overloadedDays, 0);
  const projectTitle = (id: string) => projectsById.get(id)?.name ?? '프로젝트 정보가 갱신되었습니다';

  function clearSelection() {
    setSelected(null);
    setMissingPage(0);
  }
  function changePeriod(date: string) {
    if (!isCalendarDate(date)) return;
    setStartOverride(date);
    clearSelection();
  }
  function movePeriod(amount: number) {
    changePeriod(calendarDate(Math.max(FIRST_DAY, Math.min(LAST_DAY, startDay + amount))));
  }
  function changeProjects(next: Set<string> | null) {
    setProjectFilter(next);
    clearSelection();
  }
  function closeEditor() {
    setEditorOpen(false);
    requestAnimationFrame(() => settingsButton.current?.focus());
  }
  function updateCapacity(value: TeamWorkloadCapacity) {
    setLocalCapacity({ source: data, value });
    setRevision(value => value + 1);
  }
  async function refreshData() {
    try { await refresh(); }
    catch (cause) { notify(errorMessage(cause), 'error'); }
  }
  function issueLink(id: string) {
    const issue = issuesById.get(id);
    return issue ? <WorkloadIssueLink issue={issue} openIssue={openIssue} /> :
      <button className="workload-issue" type="button" onClick={() => void refreshData()}>업무 정보 새로고침</button>;
  }

  return <section className="project-workload team-workload card" aria-label="프로젝트 간 작업량">
    <header className="workload-heading">
      <div><h2><Layers3 size={17} />프로젝트 간 작업량</h2><p>업무의 계획 시간은 각 프로젝트의 근무일에 나눕니다. 가용 시간은 팀원 한 명당 하루에 한 번 계산합니다.</p></div>
      <button ref={settingsButton} className="btn" type="button" aria-expanded={editorOpen} disabled={editorOpen} onClick={() => setEditorOpen(true)}>
        <SlidersHorizontal size={15} />팀 가용 시간 설정
      </button>
    </header>
    {editorOpen && <WorkloadCapacityEditor route={CAPACITY_ROUTE} users={data.users} current={capacity} defaultDate={startDate}
      onSnapshot={updateCapacity} onClose={closeEditor} onDraftChange={onDraftChange} refresh={refresh} notify={notify} />}
    <div className="team-workload-filters">
      <details className="team-workload-projects">
        <summary><span>프로젝트 선택</span><span className="team-workload-count">{chosenProjects.length.toLocaleString('ko-KR')}개</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="team-workload-project-actions">
          <button className="btn btn-ghost" type="button" disabled={chosenProjects.length === data.projects.length} onClick={() => changeProjects(null)}>전체 선택</button>
          <button className="btn btn-ghost" type="button" disabled={!chosenProjects.length} onClick={() => changeProjects(new Set())}>전체 해제</button>
        </div>
        <div className="workload-choices" role="group" aria-label="포함할 프로젝트">
          {data.projects.map(project => <label className="gantt-checkbox-label" key={project.id}>
            <input type="checkbox" checked={!projectFilter || projectFilter.has(project.id)} onChange={event => {
              const next = new Set(chosenProjects.map(value => value.id));
              if (event.target.checked) next.add(project.id);
              else next.delete(project.id);
              changeProjects(next.size === data.projects.length ? null : next);
            }} />{project.name}
          </label>)}
        </div>
      </details>
      <label className="workload-label">담당자 필터<select className="field" value={member?.id ?? ''} onChange={event => {
        setUserFilter(event.target.value);
        clearSelection();
      }}>
        <option value="">모든 팀원</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select></label>
      <div className="workload-period team-workload-period">
        <div>
          <button className="btn btn-ghost" type="button" aria-label="프로젝트 간 작업량 이전 14일" disabled={startDay === FIRST_DAY} onClick={() => movePeriod(-PERIOD_DAYS)}><ArrowLeft size={15} /></button>
          <input className="field" type="date" aria-label="프로젝트 간 작업량 시작일" min={MIN_CALENDAR_DATE} max={MAX_CALENDAR_DATE} value={startDate} onChange={event => changePeriod(event.target.value)} />
          <button className="btn btn-ghost" type="button" aria-label="프로젝트 간 작업량 다음 14일" disabled={endDate === MAX_CALENDAR_DATE} onClick={() => movePeriod(PERIOD_DAYS)}><ArrowRight size={15} /></button>
        </div>
        <small>~ {endDate}</small>
      </div>
    </div>
    {!route && <p className="workload-empty">{data.projects.length ? '작업량에 포함할 프로젝트를 하나 이상 선택해 주세요.' : '등록된 프로젝트가 없습니다.'}</p>}
    {route && !current && <p className="workload-empty" role="status">프로젝트 간 작업량을 불러오는 중…</p>}
    {current?.error && <div className="team-workload-error">
      <p className="workload-error" role="alert">{current.error}</p>
      <button className="btn" type="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />다시 불러오기</button>
    </div>}
    {workload && <>
      {workspaceChanged && <div className="team-workload-error">
        <p className="workload-empty" role="status">팀원, 프로젝트 또는 가용 시간 설정이 갱신되었습니다.</p>
        <button className="btn" type="button" onClick={() => void refreshData()}><RefreshCw size={14} />워크스페이스 새로고침</button>
      </div>}
      <div className="workload-summary" aria-label="선택한 기간의 프로젝트 간 작업량 요약">
        <div><small>계획 작업 시간</small><strong>{formatWorklogMinutes(member ? rows[0]?.scheduledMinutes ?? 0 : workload.totalScheduledMinutes)}</strong></div>
        <div><small>가용 시간</small><strong>{formatWorklogMinutes(member ? rows[0]?.availableMinutes ?? 0 : workload.totalAvailableMinutes)}</strong></div>
        <div className={overloaded ? 'has-overload' : ''}><small>초과한 담당자·일</small><strong>{overloaded.toLocaleString('ko-KR')}</strong></div>
        <div><small>입력 확인</small><strong>{incomplete.length.toLocaleString('ko-KR')}개</strong></div>
      </div>
      <WorkloadTable days={workload.days} rows={rows} users={usersById} selected={selected} onSelect={setSelected} />
      {focusedUser && focusedDay && <section className="workload-detail" aria-label="프로젝트별 업무 배분">
        <div className="workload-section-heading">
          <div><h3>{focusedUser.name} · {focusedDay.date}</h3><p>계획 {formatWorklogMinutes(focusedDay.scheduledMinutes)} · 가용 {formatWorklogMinutes(focusedDay.availableMinutes)}{source ? ` · ${source}` : ''}</p></div>
          <button className="issue-icon-button" type="button" aria-label="업무 배분 닫기" onClick={() => setSelected(null)}><X size={16} /></button>
        </div>
        {cellGroups.length === 0 && <p className="workload-empty">배분된 작업 시간이 없습니다.</p>}
        {cellGroups.map(([id, allocations]) => <div className="team-workload-breakdown" key={id}>
          <h4>{projectTitle(id)} <small>{formatWorklogMinutes(allocations.reduce((sum, allocation) => sum + allocation.minutes, 0))}</small></h4>
          <ul className="workload-items">{allocations.map(allocation => <li key={allocation.issueId}>
            {issueLink(allocation.issueId)}<span>{formatWorklogMinutes(allocation.minutes)}</span>
          </li>)}</ul>
        </div>)}
      </section>}
      {incomplete.length > 0 && <section className="workload-incomplete" aria-label="프로젝트 간 작업량 입력 확인">
        <div className="workload-section-heading"><div><h3>입력 확인</h3><p>담당자, 일정 또는 계획 작업 시간을 확인할 업무 {incomplete.length.toLocaleString('ko-KR')}개</p></div></div>
        {missingGroups.map(([id, items]) => <div className="team-workload-breakdown" key={id}>
          <h4>{projectTitle(id)}</h4>
          <ul className="workload-items">{items.map(value => <li key={value.issueId}>
            {issueLink(value.issueId)}<span>{value.reasons.map(reason => WORKLOAD_INCOMPLETE_REASONS[reason]).join(' · ')}</span>
          </li>)}</ul>
        </div>)}
        {incomplete.length > INCOMPLETE_PER_PAGE && <div className="workload-page-actions">
          <span>{firstMissing + 1}~{Math.min(firstMissing + INCOMPLETE_PER_PAGE, incomplete.length)} / {incomplete.length.toLocaleString('ko-KR')}</span>
          <button className="btn btn-ghost" type="button" disabled={firstMissing === 0} onClick={() => setMissingPage(firstMissing / INCOMPLETE_PER_PAGE - 1)}>이전 업무</button>
          <button className="btn btn-ghost" type="button" disabled={firstMissing + INCOMPLETE_PER_PAGE >= incomplete.length} onClick={() => setMissingPage(firstMissing / INCOMPLETE_PER_PAGE + 1)}>다음 업무</button>
        </div>}
      </section>}
    </>}
  </section>;
}
