'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, Plus, RefreshCw, Save, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { FeatureProps, Issue, ProjectWorkloadCapacity, ProjectWorkloadResult, SchedulePreview, User, WorkloadIncompleteReason } from '../../shared/types';
import { calendarDate, calendarDay, defaultWorkCalendar, isCalendarDate } from '../../shared/calendar';
import { calculateProjectWorkload, defaultWorkloadCapacity, MAX_DAILY_WORKLOAD_MINUTES } from '../../shared/project-workload';
import { projectWorkflow } from '../../shared/workflow-helpers';
import { api, ApiError, patch } from '../lib/api';
import { formatWorklogMinutes } from '../lib/worklogs';
import { errorMessage } from './schedule-utils';
import './project-workload.css';

const PAGE_DAYS = 14;
const INPUT_PAGE = 12;
const CAPACITY_DRAFT = 'workload-capacity';
const REASONS: Record<WorkloadIncompleteReason, string> = {
  unassigned: '담당자 미지정',
  'missing-dates': '일정 미정',
  'missing-effort': '계획 작업 시간 미정',
  'no-working-days': '기간에 근무일 없음',
};

type WorkloadRange = { startDate: string; endDate: string };
type TrackDraft = (id: string, dirty: boolean, pending?: boolean) => void;
type WorkloadProps = FeatureProps & WorkloadRange & { onDraftChange?: TrackDraft };
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
const weekday = (value: string) => ['일', '월', '화', '수', '목', '금', '토'][new Date(`${value}T00:00:00Z`).getUTCDay()];
const displayMinutes = formatWorklogMinutes;

export function ProjectWorkload(props: WorkloadProps) {
  return <WorkloadPanel key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function WorkloadPanel({ data, projectId, startDate, endDate, refresh, notify, openIssue, onDraftChange }: WorkloadProps) {
  const input = useWorkloadInput(data, projectId, startDate, endDate);
  const [localCapacity, setLocalCapacity] = useState<ProjectWorkloadCapacity | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pageStart, setPageStart] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ userId: string; date: string } | null>(null);
  const [missingPage, setMissingPage] = useState(0);
  const cellDescription = useId();
  const settingsButton = useRef<HTMLButtonElement>(null);
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

  return <section className="project-workload card" aria-label="담당자별 업무량">
    <header className="workload-heading">
      <div><h2><BarChart3 size={17} />담당자별 업무량</h2><p>프로젝트의 완료·취소 전 업무에 입력한 계획 시간을 근무일에 나누어 표시합니다.</p></div>
      <button ref={settingsButton} className="btn" type="button" onClick={() => setEditorOpen(true)} disabled={editorOpen} aria-expanded={editorOpen}>
        <SlidersHorizontal size={15} />가용 시간 설정
      </button>
    </header>
    {editorOpen && <CapacityEditor projectId={projectId} users={data.users} current={capacity} defaultDate={days[0]?.date ?? startDate}
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
        <div className="workload-scroll" role="region" aria-label="업무량 표 가로 스크롤" tabIndex={0}>
          <table className="workload-table" aria-label="일별 계획 작업 시간과 가용 시간">
            <thead><tr><th scope="col">담당자</th>{days.map(day => <th scope="col" key={day.date} className={day.working ? '' : 'is-nonworking'}>
              <time dateTime={day.date} title={day.date}>{shortDate(day.date)} <span>{weekday(day.date)}</span></time>
            </th>)}</tr></thead>
            <tbody>{workload.rows.map((row, rowIndex) => {
              const user = usersById.get(row.userId);
              if (!user) return null;
              return <tr key={row.userId}><th scope="row"><strong title={user.name}>{user.name}</strong><small>{row.overloadedDays > 0 ? `초과 ${row.overloadedDays}일` : '초과 없음'}</small></th>
                {row.days.slice(first, first + PAGE_DAYS).map((day, index) => {
                  const overload = day.scheduledMinutes > day.availableMinutes;
                  const isSelected = selected?.userId === row.userId && selected?.date === day.date;
                  const label = `${day.date} ${user.name} 업무량`;
                  const descriptionId = `${cellDescription}-${rowIndex}-${index}`;
                  return <td key={day.date} className={days[index].working ? '' : 'is-nonworking'}>
                    <button type="button" className={`workload-cell${overload ? ' is-overloaded' : ''}`} aria-pressed={isSelected} aria-label={label}
                      aria-describedby={`${descriptionId}-planned ${descriptionId}-available`}
                      data-scheduled-minutes={day.scheduledMinutes} data-available-minutes={day.availableMinutes}
                      onClick={() => setSelected(isSelected ? null : { userId: row.userId, date: day.date })}>
                      <strong id={`${descriptionId}-planned`}>{displayMinutes(day.scheduledMinutes)}</strong><small id={`${descriptionId}-available`}>{overload ? '초과 · ' : ''}가용 {displayMinutes(day.availableMinutes)}</small>
                    </button>
                  </td>;
                })}</tr>;
            })}</tbody>
          </table>
          {workload.rows.length === 0 && <p className="workload-empty">등록된 팀원이 없습니다.</p>}
        </div>
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
            return issue && <li key={issue.id}><IssueLink issue={issue} openIssue={openIssue} /><span>{displayMinutes(allocation.minutes)}</span></li>;
          })}
        </ul>
      </section>}
      {incomplete.length > 0 && <section className="workload-incomplete" aria-label="업무량 입력 확인">
        <div className="workload-section-heading"><div><h3>입력 확인</h3><p>일정이나 계획 작업 시간을 확인할 업무 {incomplete.length.toLocaleString('ko-KR')}개</p></div></div>
        <ul className="workload-items">
          {incomplete.slice(missingOffset, missingOffset + INPUT_PAGE).map(value => {
            const issue = issuesById.get(value.issueId);
            return issue && <li key={issue.id}><IssueLink issue={issue} openIssue={openIssue} /><span>{value.reasons.map(reason => REASONS[reason]).join(' · ')}</span></li>;
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

function IssueLink({ issue, openIssue }: { issue: Issue; openIssue: FeatureProps['openIssue'] }) {
  return <button className="workload-issue" type="button" onClick={() => openIssue(issue.id)}><span>{issue.key}</span><strong>{issue.title}</strong></button>;
}

type CapacityDraft = {
  defaultDailyMinutes: string;
  members: { key: string; userId: string; dailyMinutes: string }[];
  exceptions: { key: string; userId: string; date: string; availableMinutes: string }[];
};

function toDraft(capacity: ProjectWorkloadCapacity): CapacityDraft {
  return {
    defaultDailyMinutes: String(capacity.defaultDailyMinutes),
    members: capacity.members.map(value => ({ ...value, key: `member-${value.userId}`, dailyMinutes: String(value.dailyMinutes) })),
    exceptions: capacity.exceptions.map(value => ({ ...value, key: `exception-${value.userId}-${value.date}`, availableMinutes: String(value.availableMinutes) })),
  };
}

type CapacityEditorProps = Pick<FeatureProps, 'refresh' | 'notify' | 'projectId'> & {
  current: ProjectWorkloadCapacity;
  users: User[];
  defaultDate: string;
  onSnapshot: (value: ProjectWorkloadCapacity) => void;
  onClose: () => void;
  onDraftChange?: TrackDraft;
};

function CapacityEditor({ current, projectId, users, defaultDate, onSnapshot, onClose, onDraftChange, refresh, notify }: CapacityEditorProps) {
  const [base, setBase] = useState(current);
  const [draft, setDraft] = useState(() => toDraft(current));
  const [pending, setPending] = useState<'saving' | 'loading' | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const pendingRef = useRef(false);
  const nextKey = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const newest = users.find(user => !draft.members.some(member => member.userId === user.id));
  const route = `/projects/${encodeURIComponent(projectId)}/workload-capacity`;

  useEffect(() => { onDraftChange?.(CAPACITY_DRAFT, dirty, Boolean(pending)); }, [dirty, onDraftChange, pending]);
  useEffect(() => () => onDraftChange?.(CAPACITY_DRAFT, false, false), [onDraftChange]);

  function canDiscard() {
    return !pendingRef.current && (!dirty || window.confirm('작성 중인 가용 시간 설정을 버릴까요?'));
  }
  function begin(action: typeof pending) {
    pendingRef.current = Boolean(action);
    setPending(action);
    onDraftChange?.(CAPACITY_DRAFT, dirty, Boolean(action));
  }
  async function reload() {
    if (!canDiscard()) return;
    begin('loading');
    try {
      const value = await api<ProjectWorkloadCapacity>(route);
      setBase(value);
      setDraft(toDraft(value));
      setConflict(false);
      setError('');
      onSnapshot(value);
      try { await refresh(); }
      catch (cause) { notify(`최신 가용 시간을 불러왔습니다. 워크스페이스를 새로 고쳐 주세요. ${errorMessage(cause)}`, 'error'); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { begin(null); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !dirty) return;
    if (new Set(draft.members.map(value => value.userId)).size !== draft.members.length ||
        new Set(draft.exceptions.map(value => `${value.userId}\0${value.date}`)).size !== draft.exceptions.length) {
      setError('같은 담당자 또는 같은 담당자의 날짜 예외를 한 번만 입력해 주세요.');
      return;
    }
    setError('');
    begin('saving');
    let saved = false;
    try {
      const value = await patch<ProjectWorkloadCapacity>(route, {
        expectedVersion: base.version,
        defaultDailyMinutes: Number(draft.defaultDailyMinutes),
        members: draft.members.map(({ userId, dailyMinutes }) => ({ userId, dailyMinutes: Number(dailyMinutes) })),
        exceptions: draft.exceptions.map(({ userId, date, availableMinutes }) => ({ userId, date, availableMinutes: Number(availableMinutes) })),
      });
      saved = true;
      onSnapshot(value);
      try { await refresh(); notify('가용 시간 설정을 저장했습니다.'); }
      catch (cause) { notify(`가용 시간은 저장했습니다. 워크스페이스를 새로 고쳐 주세요. ${errorMessage(cause)}`, 'error'); }
    } catch (cause) {
      setConflict(cause instanceof ApiError && cause.status === 409);
      setError(errorMessage(cause));
    } finally { begin(null); }
    if (saved) onClose();
  }

  function changeMember(key: string, changes: Partial<CapacityDraft['members'][number]>) {
    setDraft(previous => ({ ...previous, members: previous.members.map(value => value.key === key ? { ...value, ...changes } : value) }));
  }
  function changeException(key: string, changes: Partial<CapacityDraft['exceptions'][number]>) {
    setDraft(previous => ({ ...previous, exceptions: previous.exceptions.map(value => value.key === key ? { ...value, ...changes } : value) }));
  }

  return <form className="workload-capacity" aria-label="가용 시간 편집" onSubmit={save}>
    <div className="workload-section-heading"><div><h3>가용 시간 설정</h3><p>프로젝트 근무일에 적용합니다. 특정 날짜가 담당자의 일일 설정보다 우선합니다.</p></div>
      <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={() => void reload()}><RefreshCw size={14} />최신 설정 불러오기</button>
    </div>
    <fieldset disabled={Boolean(pending)}>
      <MinutesField label="기본 일일 가용 시간 (분)" value={draft.defaultDailyMinutes} onChange={value => setDraft(previous => ({ ...previous, defaultDailyMinutes: value }))} />
      <div className="workload-section-heading"><h4>담당자별 기본 시간</h4>
        <button className="btn" type="button" disabled={!newest} onClick={() => {
          if (!newest) return;
          const key = `new-${++nextKey.current}`;
          setDraft(previous => ({ ...previous, members: [...previous.members, { key, userId: newest.id, dailyMinutes: previous.defaultDailyMinutes }] }));
        }}><Plus size={14} />담당자별 가용 시간 추가</button>
      </div>
      {draft.members.map((member, index) => <div key={member.key} className="workload-rule-row">
        <UserField label={`담당자 ${index + 1}`} users={users} value={member.userId} onChange={userId => changeMember(member.key, { userId })} />
        <MinutesField label={`담당자 ${index + 1} 일일 가용 시간 (분)`} value={member.dailyMinutes} onChange={dailyMinutes => changeMember(member.key, { dailyMinutes })} />
        <button className="issue-icon-button" type="button" aria-label={`담당자 ${index + 1} 설정 삭제`} onClick={() => setDraft(previous => ({ ...previous, members: previous.members.filter(value => value.key !== member.key) }))}><Trash2 size={15} /></button>
      </div>)}
      <div className="workload-section-heading"><div><h4>날짜 예외</h4><p>예를 들어 개인 휴무일은 0분으로 설정합니다.</p></div>
        <button className="btn" type="button" disabled={!users.length} onClick={() => {
          const key = `new-${++nextKey.current}`;
          const userId = users.find(user => !draft.exceptions.some(value => value.userId === user.id && value.date === defaultDate))?.id ?? '';
          setDraft(previous => ({ ...previous, exceptions: [...previous.exceptions, { key, userId, date: defaultDate, availableMinutes: '0' }] }));
        }}><Plus size={14} />날짜 예외 추가</button>
      </div>
      {draft.exceptions.map((exception, index) => <div key={exception.key} className="workload-rule-row has-date">
        <UserField label={`날짜 예외 ${index + 1} 담당자`} users={users} value={exception.userId} onChange={userId => changeException(exception.key, { userId })} />
        <label className="workload-label">{`날짜 예외 ${index + 1} 날짜`}<input className="field" type="date" required value={exception.date}
          onChange={event => changeException(exception.key, { date: event.target.value })} /></label>
        <MinutesField label={`날짜 예외 ${index + 1} 가용 시간 (분)`} value={exception.availableMinutes} onChange={availableMinutes => changeException(exception.key, { availableMinutes })} />
        <button className="issue-icon-button" type="button" aria-label={`날짜 예외 ${index + 1} 삭제`} onClick={() => setDraft(previous => ({ ...previous, exceptions: previous.exceptions.filter(value => value.key !== exception.key) }))}><Trash2 size={15} /></button>
      </div>)}
    </fieldset>
    {error && <p className="workload-error" role="alert">{error} 작성 중인 내용이 유지됩니다.</p>}
    {!error && current.version > base.version && <p className="workload-error" role="alert">최신 설정은 버전 {current.version}입니다. 작성 중인 내용은 버전 {base.version}에 남아 있습니다.</p>}
    <div className="workload-capacity-actions"><small>편집 기준 버전 {base.version}</small>
      <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={() => { if (canDiscard()) onClose(); }}>설정 닫기</button>
      <button className="btn btn-primary" type="submit" disabled={Boolean(pending) || !dirty || conflict || current.version > base.version}>
        <Save size={15} />{pending === 'saving' ? '저장 중…' : '가용 시간 저장'}
      </button>
    </div>
  </form>;
}

function MinutesField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="workload-label">{label}<input className="field" type="number" min={0} max={MAX_DAILY_WORKLOAD_MINUTES} step={1} required
    value={value} onChange={event => onChange(event.target.value)} /></label>;
}

function UserField({ label, value, users, onChange }: { label: string; value: string; users: User[]; onChange: (value: string) => void }) {
  return <label className="workload-label">{label}<select className="field" aria-label={label} value={value} required onChange={event => onChange(event.target.value)}>
    <option value="">담당자 선택</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
  </select></label>;
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
