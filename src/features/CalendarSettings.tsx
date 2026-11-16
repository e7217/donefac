'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { FeatureProps, WorkCalendar } from '../../shared/types';
import { api, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './calendar-settings.css';

const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
type CalendarDraft = Pick<WorkCalendar, 'name' | 'workingWeekdays' | 'exceptions'>;
const draftOf = (calendar: WorkCalendar): CalendarDraft => ({ name: calendar.name, workingWeekdays: [...calendar.workingWeekdays], exceptions: calendar.exceptions.map(value => ({ ...value })) });

export function CalendarSettings(props: FeatureProps) {
  if (!props.data.projects.some(project => project.id === props.projectId)) return <section className="card calendar-settings"><h2>업무 달력</h2><p>프로젝트를 선택하면 근무 요일과 날짜 예외를 관리할 수 있습니다.</p></section>;
  return <ProjectCalendar key={`${props.projectId}:${props.actorId}`} {...props} />;
}

function ProjectCalendar({ data, projectId, refresh, notify }: FeatureProps) {
  const current = useMemo(() => data.calendars?.find(value => value.projectId === projectId) || { id: projectId, projectId, name: '기본 업무 달력', workingWeekdays: [1, 2, 3, 4, 5], exceptions: [], version: 1, updatedAt: '' }, [data.calendars, projectId]);
  const [draft, setDraft] = useState<CalendarDraft>(() => draftOf(current));
  const [baseline, setBaseline] = useState<CalendarDraft>(() => draftOf(current));
  const [version, setVersion] = useState(current.version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false), dirtyRef = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  if (current.version > version && !dirty && !saving) { setDraft(draftOf(current)); setBaseline(draftOf(current)); setVersion(current.version); setError(''); }
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (savingRef.current) { event.preventDefault(); notify('달력 저장이 끝난 뒤 이동해 주세요.', 'error'); }
      else if (dirtyRef.current) {
        if (!window.confirm('저장하지 않은 업무 달력 변경을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, () => { dirtyRef.current = false; setDraft(draftOf({ ...current, ...baseline })); setError(''); });
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (savingRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [baseline, current, notify]);
  function toggleDay(day: number) { setDraft(previous => ({ ...previous, workingWeekdays: previous.workingWeekdays.includes(day) ? previous.workingWeekdays.filter(value => value !== day) : [...previous.workingWeekdays, day].sort() })); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (savingRef.current) return; setError('');
    if (!draft.workingWeekdays.length) { setError('근무 요일을 하나 이상 선택하세요.'); return; }
    if (new Set(draft.exceptions.map(value => value.date)).size !== draft.exceptions.length) { setError('예외 날짜가 중복되었습니다. 날짜당 하나의 규칙을 입력하세요.'); return; }
    savingRef.current = true; setSaving(true);
    try { const saved = await patch<WorkCalendar>(`/projects/${projectId}/calendar`, { ...draft, expectedVersion: version }); setDraft(draftOf(saved)); setBaseline(draftOf(saved)); setVersion(saved.version); dirtyRef.current = false; await refresh(); notify('업무 달력을 저장했습니다. 기존 업무 날짜는 그대로 유지됩니다.'); }
    catch (err) { setError(errorMessage(err)); } finally { savingRef.current = false; setSaving(false); }
  }
  async function reload() {
    if (savingRef.current || (dirtyRef.current && !window.confirm('작성 중인 달력 변경을 버리고 최신 달력을 불러올까요?'))) return;
    savingRef.current = true; setSaving(true);
    try { const latest = await api<WorkCalendar>(`/projects/${projectId}/calendar`); setDraft(draftOf(latest)); setBaseline(draftOf(latest)); setVersion(latest.version); dirtyRef.current = false; setError(''); await refresh(); }
    catch (err) { setError(errorMessage(err)); } finally { savingRef.current = false; setSaving(false); }
  }
  return <section className="card calendar-settings" aria-label="업무 달력 설정">
    <header><div><h2><CalendarDays size={18} />업무 달력</h2><p>근무 요일과 날짜 예외를 일정 이동 및 자동 계획에 적용합니다.</p></div><button className="btn btn-ghost" disabled={saving} onClick={reload}><RefreshCw size={14} />최신 달력</button></header>
    {current.version > version && dirty && <p className="issue-form-error" role="alert">다른 작업자가 달력을 변경했습니다. 작성 중인 내용은 버전 {version} 기준으로 유지됩니다.</p>}
    <form onSubmit={save}><fieldset disabled={saving}>
      <label className="issue-form-label">달력 이름<input className="field" aria-label="업무 달력 이름" value={draft.name} maxLength={120} required onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
      <div className="calendar-weekdays" role="group" aria-label="근무 요일">{WEEKDAYS.map((label, day) => <label key={day} className={draft.workingWeekdays.includes(day) ? 'is-working' : ''}><input type="checkbox" aria-label={`${label} 근무`} checked={draft.workingWeekdays.includes(day)} onChange={() => toggleDay(day)} /><span>{label.slice(0, 1)}</span></label>)}</div>
      <div className="calendar-exceptions-heading"><div><h3>날짜 예외 <span>{draft.exceptions.length}</span></h3><p>지정한 날짜는 위 근무 요일보다 우선합니다. 공휴일은 직접 등록하세요.</p></div><button className="btn" type="button" onClick={() => setDraft(previous => ({ ...previous, exceptions: [...previous.exceptions, { date: '', isWorking: false, label: '' }] }))}><Plus size={14} />예외 날짜 추가</button></div>
      <div className="calendar-exceptions">{draft.exceptions.map((exception, index) => <div className="calendar-exception" key={index}><input className="field" type="date" aria-label={`예외 ${index + 1} 날짜`} value={exception.date} required onChange={event => setDraft(previous => ({ ...previous, exceptions: previous.exceptions.map((value, at) => at === index ? { ...value, date: event.target.value } : value) }))} /><select className="field" aria-label={`예외 ${index + 1} 근무 여부`} value={String(exception.isWorking)} onChange={event => setDraft(previous => ({ ...previous, exceptions: previous.exceptions.map((value, at) => at === index ? { ...value, isWorking: event.target.value === 'true' } : value) }))}><option value="false">쉬는 날</option><option value="true">근무일</option></select><input className="field" aria-label={`예외 ${index + 1} 설명`} placeholder="예: 팀 휴무 · 대체 근무" maxLength={120} value={exception.label} onChange={event => setDraft(previous => ({ ...previous, exceptions: previous.exceptions.map((value, at) => at === index ? { ...value, label: event.target.value } : value) }))} /><button className="issue-icon-button" type="button" aria-label={`예외 ${index + 1} 삭제`} onClick={() => setDraft(previous => ({ ...previous, exceptions: previous.exceptions.filter((_, at) => at !== index) }))}><Trash2 size={15} /></button></div>)}{!draft.exceptions.length && <p className="calendar-empty">등록된 예외가 없습니다. 선택한 근무 요일만 적용됩니다.</p>}</div>
      {error && <div className="issue-form-error" role="alert">{error} 작성 내용은 유지됩니다.</div>}
      <footer><span>버전 {version} · 날짜 변경은 미리보기 후 별도로 적용합니다.</span><button className="btn btn-primary" type="submit" disabled={saving || !dirty}><Save size={15} />{saving ? '저장 중…' : '업무 달력 저장'}</button></footer>
    </fieldset></form>
  </section>;
}
