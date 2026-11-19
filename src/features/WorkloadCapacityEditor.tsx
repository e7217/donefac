'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { CalendarException, FeatureProps, ProjectWorkloadCapacity, TeamWorkloadCapacity, User } from '../../shared/types';
import { MAX_DAILY_WORKLOAD_MINUTES } from '../../shared/project-workload';
import { api, ApiError, patch } from '../lib/api';
import { errorMessage } from './schedule-utils';

export const PROJECT_CAPACITY_DRAFT = 'workload-capacity';
export const TEAM_CAPACITY_DRAFT = 'team-workload-capacity';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

type TrackDraft = (id: string, dirty: boolean, pending?: boolean) => void;

type CapacityDraft = {
  defaultDailyMinutes: string;
  members: { key: string; userId: string; dailyMinutes: string }[];
  exceptions: { key: string; userId: string; date: string; availableMinutes: string }[];
  teamCalendar?: { workingWeekdays: number[]; calendarExceptions: (CalendarException & { key: string })[] };
};

function toDraft(capacity: ProjectWorkloadCapacity | TeamWorkloadCapacity): CapacityDraft {
  return {
    defaultDailyMinutes: String(capacity.defaultDailyMinutes),
    members: capacity.members.map(value => ({ ...value, key: `member-${value.userId}`, dailyMinutes: String(value.dailyMinutes) })),
    exceptions: capacity.exceptions.map(value => ({ ...value, key: `exception-${value.userId}-${value.date}`, availableMinutes: String(value.availableMinutes) })),
    ...('workingWeekdays' in capacity ? { teamCalendar: {
      workingWeekdays: [...capacity.workingWeekdays],
      calendarExceptions: capacity.calendarExceptions.map(value => ({ ...value, key: `calendar-${value.date}` })),
    } } : {}),
  };
}

type CapacityEditorProps<T> = Pick<FeatureProps, 'refresh' | 'notify'> & {
  route: string;
  current: T;
  users: User[];
  defaultDate: string;
  onSnapshot: (value: T) => void;
  onClose: () => void;
  onDraftChange?: TrackDraft;
};

export function WorkloadCapacityEditor<T extends ProjectWorkloadCapacity | TeamWorkloadCapacity>({ current, route, users, defaultDate, onSnapshot, onClose, onDraftChange, refresh, notify }: CapacityEditorProps<T>) {
  const [base, setBase] = useState(current);
  const [draft, setDraft] = useState(() => toDraft(current));
  const [pending, setPending] = useState<'saving' | 'loading' | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const pendingRef = useRef(false);
  const nextKey = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const newest = users.find(user => !draft.members.some(member => member.userId === user.id));
  const teamCalendar = draft.teamCalendar;
  const draftId = teamCalendar ? TEAM_CAPACITY_DRAFT : PROJECT_CAPACITY_DRAFT;

  useEffect(() => { onDraftChange?.(draftId, dirty, Boolean(pending)); }, [dirty, draftId, onDraftChange, pending]);
  useEffect(() => () => onDraftChange?.(draftId, false, false), [draftId, onDraftChange]);

  function canDiscard() {
    return !pendingRef.current && (!dirty || window.confirm('작성 중인 가용 시간 설정을 버릴까요?'));
  }
  function begin(action: typeof pending) {
    pendingRef.current = Boolean(action);
    setPending(action);
    onDraftChange?.(draftId, dirty, Boolean(action));
  }
  async function reload() {
    if (!canDiscard()) return;
    begin('loading');
    try {
      const value = await api<T>(route);
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
    if (teamCalendar && teamCalendar.workingWeekdays.length === 0) {
      setError('팀 근무 요일을 하루 이상 선택해 주세요.');
      return;
    }
    if (teamCalendar && new Set(teamCalendar.calendarExceptions.map(value => value.date)).size !== teamCalendar.calendarExceptions.length) {
      setError('팀 달력에서 같은 날짜의 예외를 한 번만 입력해 주세요.');
      return;
    }
    setError('');
    begin('saving');
    let saved = false;
    try {
      const value = await patch<T>(route, {
        expectedVersion: base.version,
        defaultDailyMinutes: Number(draft.defaultDailyMinutes),
        members: draft.members.map(({ userId, dailyMinutes }) => ({ userId, dailyMinutes: Number(dailyMinutes) })),
        exceptions: draft.exceptions.map(({ userId, date, availableMinutes }) => ({ userId, date, availableMinutes: Number(availableMinutes) })),
        ...(teamCalendar ? {
          workingWeekdays: teamCalendar.workingWeekdays,
          calendarExceptions: teamCalendar.calendarExceptions.map(({ date, isWorking, label }) => ({ date, isWorking, label })),
        } : {}),
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

  function updateCalendar(update: (calendar: NonNullable<CapacityDraft['teamCalendar']>) => NonNullable<CapacityDraft['teamCalendar']>) {
    setDraft(previous => previous.teamCalendar ? { ...previous, teamCalendar: update(previous.teamCalendar) } : previous);
  }

  function changeCalendarException(key: string, changes: Partial<CalendarException>) {
    updateCalendar(previous => ({
      ...previous,
      calendarExceptions: previous.calendarExceptions.map(value => value.key === key ? { ...value, ...changes } : value),
    }));
  }

  return <form className="workload-capacity" aria-label={teamCalendar ? '팀 가용 시간 편집' : '가용 시간 편집'} onSubmit={save}>
    <div className="workload-section-heading"><div><h3>{teamCalendar ? '팀 가용 시간 설정' : '가용 시간 설정'}</h3><p>{teamCalendar
      ? '선택한 프로젝트에서 팀원 한 명의 하루 가용 시간을 한 번만 계산합니다. 개인 날짜 예외는 팀 휴무일에도 적용합니다.'
      : '프로젝트 근무일에 적용합니다. 특정 날짜가 담당자의 일일 설정보다 우선합니다.'}</p></div>
      <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={() => void reload()}><RefreshCw size={14} />최신 설정 불러오기</button>
    </div>
    <fieldset disabled={Boolean(pending)}>
      <MinutesField label="기본 일일 가용 시간 (분)" value={draft.defaultDailyMinutes} onChange={value => setDraft(previous => ({ ...previous, defaultDailyMinutes: value }))} />
      {teamCalendar && <>
        <div className="workload-section-heading"><h4>팀 근무 요일</h4></div>
        <div className="workload-choices" role="group" aria-label="팀 근무 요일">
          {[1, 2, 3, 4, 5, 6, 0].map(day => <label className="gantt-checkbox-label" key={day}>
            <input type="checkbox" checked={teamCalendar.workingWeekdays.includes(day)} onChange={event => {
              const checked = event.target.checked;
              updateCalendar(previous => ({ ...previous, workingWeekdays: checked
                ? [...previous.workingWeekdays, day].sort((a, b) => a - b)
                : previous.workingWeekdays.filter(value => value !== day) }));
            }} />{WEEKDAYS[day]}요일
          </label>)}
        </div>
        <div className="workload-section-heading"><div><h4>팀 달력 예외</h4><p>공휴일이나 별도로 일하는 날을 지정합니다.</p></div>
          <button className="btn" type="button" onClick={() => {
            const key = `new-${++nextKey.current}`;
            const date = teamCalendar.calendarExceptions.some(value => value.date === defaultDate) ? '' : defaultDate;
            updateCalendar(previous => ({ ...previous, calendarExceptions: [...previous.calendarExceptions, { key, date, isWorking: false, label: '' }] }));
          }}><Plus size={14} />팀 달력 예외 추가</button>
        </div>
        {teamCalendar.calendarExceptions.map((exception, index) => <div className="workload-rule-row has-date" key={exception.key}>
          <label className="workload-label">{`팀 달력 예외 ${index + 1} 날짜`}<input className="field" type="date" required value={exception.date}
            onChange={event => changeCalendarException(exception.key, { date: event.target.value })} /></label>
          <label className="workload-label">{`팀 달력 예외 ${index + 1} 유형`}<select className="field" value={exception.isWorking ? 'working' : 'rest'}
            onChange={event => changeCalendarException(exception.key, { isWorking: event.target.value === 'working' })}><option value="rest">휴무일</option><option value="working">근무일</option></select></label>
          <label className="workload-label">{`팀 달력 예외 ${index + 1} 이름`}<input className="field" maxLength={120} value={exception.label}
            onChange={event => changeCalendarException(exception.key, { label: event.target.value })} /></label>
          <button className="issue-icon-button" type="button" aria-label={`팀 달력 예외 ${index + 1} 삭제`} onClick={() => updateCalendar(previous => ({
            ...previous, calendarExceptions: previous.calendarExceptions.filter(value => value.key !== exception.key),
          }))}><Trash2 size={15} /></button>
        </div>)}
      </>}
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
