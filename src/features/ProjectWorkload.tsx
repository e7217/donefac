'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, CalendarClock, SlidersHorizontal, X } from 'lucide-react';
import type { FeatureProps, Issue, ProjectWorkloadCapacity, ProjectWorkloadResult, SchedulePreview, User, WorkloadIncompleteReason } from '../../shared/types';
import { calendarDate, calendarDay, defaultWorkCalendar, isCalendarDate } from '../../shared/calendar';
import { calculateProjectWorkload, defaultWorkloadCapacity } from '../../shared/project-workload';
import { projectWorkflow } from '../../shared/workflow-helpers';
import { formatWorklogMinutes } from '../lib/worklogs';
import { errorMessage } from './schedule-utils';
import { WorkloadCapacityEditor } from './WorkloadCapacityEditor';
import type { ScheduleApplyResult } from './AutomaticScheduleDialog';
import { WorkloadLevelDialog } from './WorkloadLevelDialog';
import './project-workload.css';

const PAGE_DAYS = 14;
const INPUT_PAGE = 12;
export const WORKLOAD_INCOMPLETE_REASONS: Record<WorkloadIncompleteReason, string> = {
  unassigned: '담당자 미지정',
  'missing-dates': '일정 미정',
  'missing-effort': '계획 작업 시간 미정',
  'no-working-days': '기간에 근무일 없음',
};

type WorkloadRange = { startDate: string; endDate: string };
type TrackDraft = (id: string, dirty: boolean, pending?: boolean) => void;
export type WorkloadSelection = { userId: string; date: string };
type WorkloadProps = FeatureProps & WorkloadRange & {
  onDraftChange?: TrackDraft;
  onBeforeLevel?: () => boolean;
  scheduleBusy?: boolean;
  onScheduleApplied?: (result: ScheduleApplyResult) => Promise<void> | void;
  levelIssueIds?: string[];
};
type SummaryProps = Pick<FeatureProps, 'data' | 'projectId'> & WorkloadRange & { preview: SchedulePreview };

function useWorkloadInput(data: FeatureProps['data'], projectId: string, startDate: string, endDate: string) {
  return useMemo(() => {
    const project = data.projects.find(value => value.id === projectId);
    const calendar = data.calendars?.find(value => value.projectId === projectId) ?? defaultWorkCalendar(projectId, project?.createdAt);
    const capacity = data.workloadCapacities?.find(value => value.projectId === projectId) ?? defaultWorkloadCapacity(projectId, project?.createdAt);
    const issues = data.issues.filter(issue => issue.projectId === projectId);
    const terminalStatusIds = projectWorkflow(data, projectId).statuses.filter(value => value.category === 'done' || value.category === 'cancelled').map(value => value.id);
    return { startDate, endDate, calendar, capacity, issues, userIds: data.users.map(user => user.id), terminalStatusIds };
  }, [data, projectId, startDate, endDate]);
}

const shortDate = (value: string) => `${Number(value.slice(5, 7))}.${Number(value.slice(8))}`;
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const weekday = (value: string) => weekdays[new Date(`${value}T00:00:00Z`).getUTCDay()];
const displayMinutes = formatWorklogMinutes;

export function ProjectWorkload(props: WorkloadProps) {
  return <WorkloadPanel key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function WorkloadPanel({ data, projectId, actorId, startDate, endDate, refresh, notify, openIssue,
  onDraftChange, onBeforeLevel, scheduleBusy, onScheduleApplied, levelIssueIds }: WorkloadProps) {
  const input = useWorkloadInput(data, projectId, startDate, endDate);
  const [localCapacity, setLocalCapacity] = useState<ProjectWorkloadCapacity | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [pageStart, setPageStart] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkloadSelection | null>(null);
  const [missingPage, setMissingPage] = useState(0);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const levelButton = useRef<HTMLButtonElement>(null);
  const capacity = localCapacity && localCapacity.version > input.capacity.version ? localCapacity : input.capacity;
  const result = useMemo(() => {
    try { return { workload: calculateProjectWorkload({ ...input, capacity }), error: '' }; }
    catch (cause) { return { workload: null, error: errorMessage(cause) }; }
  }, [input, capacity]);
  const workload = result.workload;
  const usersById = useMemo(() => new Map(data.users.map(user => [user.id, user])), [data.users]);
  const issuesById = useMemo(() => new Map(input.issues.map(issue => [issue.id, issue])), [input.issues]);
  const first = pageStart && pageStart >= startDate && pageStart <= endDate ? calendarDay(pageStart) - calendarDay(startDate) : 0;
  const days = workload?.days.slice(first, first + PAGE_DAYS) ?? [];
  const focusedRow = selected && workload?.rows.find(row => row.userId === selected.userId);
  const focusedDay = selected && days.some(day => day.date === selected.date) && focusedRow?.days.find(day => day.date === selected.date);
  const incomplete = workload?.incomplete ?? [];
  const missingOffset = Math.min(missingPage, Math.max(0, Math.ceil(incomplete.length / INPUT_PAGE) - 1)) * INPUT_PAGE;

  function movePage(amount: number) {
    const start = Math.min(calendarDay(endDate), Math.max(calendarDay(startDate), calendarDay(startDate) + first + amount));
    setPageStart(calendarDate(start));
    setSelected(null);
  }
  function closeEditor() {
    setEditorOpen(false);
    requestAnimationFrame(() => settingsButton.current?.focus());
  }
  function closeLevel() {
    setLevelOpen(false);
    requestAnimationFrame(() => (levelButton.current ?? settingsButton.current)?.focus());
  }

  return <section className="project-workload card" aria-label="담당자별 업무량">
    <header className="workload-heading">
      <div><h2><BarChart3 size={17} />담당자별 업무량</h2><p>프로젝트의 완료·취소 전 업무에 입력한 계획 시간을 근무일에 나누어 표시합니다.</p></div>
      <div className="workload-heading-actions">
        {Boolean(workload?.overloadedCells) && onScheduleApplied && <button ref={levelButton} className="btn" type="button"
          aria-haspopup="dialog" disabled={!actorId || editorOpen || scheduleBusy || levelOpen}
          onClick={() => { if (!onBeforeLevel || onBeforeLevel()) setLevelOpen(true); }}>
          <CalendarClock size={15} aria-hidden="true" />과부하 일정 조정
        </button>}
        <button ref={settingsButton} className="btn" type="button" onClick={() => setEditorOpen(true)} disabled={editorOpen} aria-expanded={editorOpen}>
          <SlidersHorizontal size={15} aria-hidden="true" />가용 시간 설정
        </button>
      </div>
    </header>
    {levelOpen && onScheduleApplied && <WorkloadLevelDialog projectId={projectId} actorId={actorId} startDate={startDate} endDate={endDate}
      projectName={data.projects.find(project => project.id === projectId)?.name ?? projectId}
      availableUserIds={workload?.rows.filter(row => row.overloadedDays > 0).map(row => row.userId) ?? []}
      selectedIssueIds={levelIssueIds} users={usersById} issues={issuesById}
      onDraftChange={onDraftChange} onClose={closeLevel} onApplied={onScheduleApplied} />}
    {editorOpen && <WorkloadCapacityEditor route={`/projects/${encodeURIComponent(projectId)}/workload-capacity`} users={data.users} current={capacity} defaultDate={days[0]?.date ?? startDate}
      onSnapshot={setLocalCapacity} onClose={closeEditor} onDraftChange={onDraftChange} refresh={refresh} notify={notify} />}
    {result.error && <p className="workload-error" role="alert">{result.error}</p>}
    {workload && <>
      <div className="workload-summary" aria-label="간트 표시 기간 업무량 요약">
        <div><small>계획 작업 시간</small><strong>{displayMinutes(workload.totalScheduledMinutes)}</strong></div>
        <div><small>가용 시간</small><strong>{displayMinutes(workload.totalAvailableMinutes)}</strong></div>
        <div className={workload.overloadedCells ? 'has-overload' : ''}><small>초과한 담당자·일</small><strong>{workload.overloadedCells.toLocaleString('ko-KR')}</strong></div>
        <div><small>입력 확인</small><strong>{incomplete.length.toLocaleString('ko-KR')}개</strong></div>
      </div>
      {days.length > 0 && <>
        <div className="workload-period">
          <small>{startDate} ~ {endDate} · 하루 기본 {displayMinutes(capacity.defaultDailyMinutes)}</small>
          <div>
            <button className="btn btn-ghost" aria-label="이전 업무량 기간" disabled={first === 0} type="button" onClick={() => movePage(-PAGE_DAYS)}><ArrowLeft size={15} /></button>
            <input className="field" type="date" aria-label="업무량 시작일" min={startDate} max={endDate} value={days[0].date} onChange={event => {
              const date = event.target.value;
              if (isCalendarDate(date) && date >= startDate && date <= endDate) { setPageStart(date); setSelected(null); }
            }} />
            <button className="btn btn-ghost" aria-label="다음 업무량 기간" disabled={first + PAGE_DAYS >= workload.days.length} type="button" onClick={() => movePage(PAGE_DAYS)}><ArrowRight size={15} /></button>
          </div>
        </div>
        <WorkloadTable days={days} rows={workload.rows} first={first} users={usersById} selected={selected} onSelect={setSelected} />
      </>}
      {selected && focusedDay && <section className="workload-detail" aria-label="날짜별 업무 배분">
        <div className="workload-section-heading">
          <div><h3>{usersById.get(selected.userId)?.name} · {selected.date}</h3><p>계획 {displayMinutes(focusedDay.scheduledMinutes)} · 가용 {displayMinutes(focusedDay.availableMinutes)}</p></div>
          <button className="issue-icon-button" type="button" aria-label="업무 배분 닫기" onClick={() => setSelected(null)}><X size={16} /></button>
        </div>
        {focusedDay.allocations.length === 0 && <p className="workload-empty">배분된 작업 시간이 없습니다.</p>}
        <ul className="workload-items">
          {focusedDay.allocations.map(allocation => {
            const issue = issuesById.get(allocation.issueId);
            return issue && <li key={issue.id}><WorkloadIssueLink issue={issue} openIssue={openIssue} /><span>{displayMinutes(allocation.minutes)}</span></li>;
          })}
        </ul>
      </section>}
      {incomplete.length > 0 && <section className="workload-incomplete" aria-label="업무량 입력 확인">
        <div className="workload-section-heading"><div><h3>입력 확인</h3><p>일정이나 계획 작업 시간을 확인할 업무 {incomplete.length.toLocaleString('ko-KR')}개</p></div></div>
        <ul className="workload-items">
          {incomplete.slice(missingOffset, missingOffset + INPUT_PAGE).map(value => {
            const issue = issuesById.get(value.issueId);
            return issue && <li key={issue.id}><WorkloadIssueLink issue={issue} openIssue={openIssue} /><span>{value.reasons.map(reason => WORKLOAD_INCOMPLETE_REASONS[reason]).join(' · ')}</span></li>;
          })}
        </ul>
        {incomplete.length > INPUT_PAGE && <div className="workload-page-actions">
          <span>{missingOffset + 1}~{Math.min(missingOffset + INPUT_PAGE, incomplete.length)} / {incomplete.length.toLocaleString('ko-KR')}</span>
          <button className="btn btn-ghost" type="button" disabled={missingOffset === 0} onClick={() => setMissingPage(missingOffset / INPUT_PAGE - 1)}>이전 업무</button>
          <button className="btn btn-ghost" type="button" disabled={missingOffset + INPUT_PAGE >= incomplete.length} onClick={() => setMissingPage(missingOffset / INPUT_PAGE + 1)}>다음 업무</button>
        </div>}
      </section>}
    </>}
  </section>;
}

export function WorkloadTable({ days, rows, first = 0, users, selected, onSelect }: {
  days: ProjectWorkloadResult['days'];
  rows: ProjectWorkloadResult['rows'];
  first?: number;
  users: ReadonlyMap<string, User>;
  selected: WorkloadSelection | null;
  onSelect: (selection: WorkloadSelection | null) => void;
}) {
  const cellDescription = useId();
  return <div className="workload-scroll" role="region" aria-label="업무량 표 가로 스크롤" tabIndex={0}>
    <table className="workload-table" aria-label="일별 계획 작업 시간과 가용 시간">
      <thead><tr><th scope="col">담당자</th>{days.map(day => <th scope="col" key={day.date} className={day.working ? '' : 'is-nonworking'}>
        <time dateTime={day.date} title={day.date}>{shortDate(day.date)} <span>{weekday(day.date)}</span></time>
      </th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => {
        const user = users.get(row.userId);
        if (!user) return null;
        return <tr key={row.userId}><th scope="row"><strong title={user.name}>{user.name}</strong><small>{row.overloadedDays > 0 ? `초과 ${row.overloadedDays}일` : '초과 없음'}</small></th>
          {row.days.slice(first, first + days.length).map((day, index) => {
            const overload = day.scheduledMinutes > day.availableMinutes;
            const isSelected = selected?.userId === row.userId && selected?.date === day.date;
            const label = `${day.date} ${user.name} 업무량`;
            const descriptionId = `${cellDescription}-${rowIndex}-${index}`;
            return <td key={day.date} className={days[index].working ? '' : 'is-nonworking'}>
              <button type="button" className={`workload-cell${overload ? ' is-overloaded' : ''}`} aria-pressed={isSelected} aria-label={label}
                aria-describedby={`${descriptionId}-planned ${descriptionId}-available`}
                data-scheduled-minutes={day.scheduledMinutes} data-available-minutes={day.availableMinutes}
                onClick={() => onSelect(isSelected ? null : { userId: row.userId, date: day.date })}>
                <strong id={`${descriptionId}-planned`}>{displayMinutes(day.scheduledMinutes)}</strong><small id={`${descriptionId}-available`}>{overload ? '초과 · ' : ''}가용 {displayMinutes(day.availableMinutes)}</small>
              </button>
            </td>;
          })}</tr>;
      })}</tbody>
    </table>
    {rows.length === 0 && <p className="workload-empty">등록된 팀원이 없습니다.</p>}
  </div>;
}

export function WorkloadIssueLink({ issue, openIssue }: { issue: Pick<Issue, 'id' | 'key' | 'title'>; openIssue: FeatureProps['openIssue'] }) {
  return <button className="workload-issue" type="button" onClick={() => openIssue(issue.id)}><span>{issue.key}</span><strong>{issue.title}</strong></button>;
}

type Day = ProjectWorkloadResult['rows'][number]['days'][number];

function compareDays(before: ProjectWorkloadResult, after: ProjectWorkloadResult) {
  return after.rows.flatMap((row, rowIndex) => row.days.flatMap((day, dayIndex) => {
    const previous = before.rows[rowIndex].days[dayIndex];
    if (previous.scheduledMinutes === day.scheduledMinutes) return [];
    return [{ userId: row.userId, previous, day }];
  }));
}

function projection(input: ReturnType<typeof useWorkloadInput>, preview: SchedulePreview) {
  const changes = new Map(preview.changes.map(change => [change.id, change]));
  const issues = input.issues.filter(issue => changes.has(issue.id));
  const calendarVersion = preview.calendarVersions?.[input.calendar.projectId];
  if (issues.length !== changes.size || (calendarVersion !== undefined && calendarVersion !== input.calendar.version) || issues.some(issue => {
    const change = changes.get(issue.id)!;
    return change.version !== issue.version || change.fromStart !== issue.startDate || change.fromEnd !== issue.endDate;
  })) return { stale: true } as const;
  const current = calculateProjectWorkload(input);
  const projected = calculateProjectWorkload({ ...input, issues: input.issues.map(issue => {
    const change = changes.get(issue.id);
    return change ? { ...issue, startDate: change.toStart, endDate: change.toEnd } : issue;
  }) });
  return { stale: false, current, projected, days: compareDays(current, projected) } as const;
}

const showDay = (day: Day) => `${displayMinutes(day.scheduledMinutes)} / ${displayMinutes(day.availableMinutes)}`;

export function WorkloadPreviewSummary({ data, projectId, startDate, endDate, preview }: SummaryProps) {
  const input = useWorkloadInput(data, projectId, startDate, endDate);
  const estimate = useMemo(() => {
    try { return projection(input, preview); }
    catch (cause) { return { error: errorMessage(cause) } as const; }
  }, [input, preview]);
  return <section className="workload-preview" aria-label="일정 미리보기 업무량 비교">
    {'error' in estimate ? <p>업무량 미리보기를 표시할 수 없습니다. {estimate.error}</p> : estimate.stale ? <p>업무나 달력이 변경되었습니다. 일정을 다시 미리 보면 업무량을 비교할 수 있습니다.</p> : <>
      <strong>일정 미리보기 · 초과 {estimate.current.overloadedCells} → {estimate.projected.overloadedCells} 담당자·일</strong>
      <p>{startDate} ~ {endDate} · 계획 / 가용 시간</p>
      {estimate.days.length === 0 && <p>표시 기간에 담당자별 계획 시간 변경이 없습니다.</p>}
      {estimate.days.length > 0 && <ul>{estimate.days.slice(0, 6).map(({ userId, previous, day }) => <li key={`${userId}:${day.date}`}>
        <span>{data.users.find(user => user.id === userId)?.name ?? userId} · {day.date}</span><strong>{showDay(previous)} → {showDay(day)}</strong>
      </li>)}</ul>}
      {estimate.days.length > 6 && <small>변경된 담당자·일 {estimate.days.length}개 중 6개 표시</small>}
    </>}
  </section>;
}
