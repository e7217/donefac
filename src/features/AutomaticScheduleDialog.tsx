'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AutomaticSchedulePreview, FeatureProps, Issue } from '../../shared/types';
import { post } from '../lib/api';
import { errorMessage } from './schedule-utils';
import './automatic-schedule.css';

export type ScheduleApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
export function AutomaticScheduleDialog({ data, projectId, selectedIssueIds, notify, onClose, onApplied }: FeatureProps & { selectedIssueIds: string[]; onClose: () => void; onApplied: (result: ScheduleApplyResult) => Promise<void> }) {
  const [initialProject] = useState(data.projects.some(value => value.id === projectId) ? projectId : data.projects[0]?.id || '');
  const [selectedProject, setSelectedProject] = useState(initialProject);
  const [anchorDate, setAnchorDate] = useState('');
  const [fillUnscheduled, setFillUnscheduled] = useState(false);
  const [duration, setDuration] = useState(1);
  const [preview, setPreview] = useState<AutomaticSchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false), dirtyRef = useRef(false);
  const selectedIds = selectedIssueIds.filter(id => data.issues.some(issue => issue.id === id && issue.projectId === selectedProject));
  const scopeCount = data.issues.filter(issue => issue.projectId === selectedProject && (!selectedIssueIds.length || selectedIds.includes(issue.id))).length;
  const dirty = Boolean(preview || anchorDate || fillUnscheduled || duration !== 1 || selectedProject !== initialProject);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current) { event.preventDefault(); notify('일정 제안 처리가 끝난 뒤 이동해 주세요.', 'error'); }
      else if (dirtyRef.current && !window.confirm('자동 일정 입력과 미리보기를 버리고 이동할까요?')) event.preventDefault();
      else { dirtyRef.current = false; onClose(); }
    };
    const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify, onClose]);
  function close() { if (!busyRef.current && (!dirtyRef.current || window.confirm('자동 일정 입력과 미리보기를 버리고 닫을까요?'))) { dirtyRef.current = false; onClose(); } }
  async function requestPreview(event: FormEvent) {
    event.preventDefault(); if (busyRef.current || !scopeCount) return; setError(''); busyRef.current = true; setBusy(true);
    try { const result = await post<AutomaticSchedulePreview>('/schedule/auto-preview', { projectId: selectedProject, ...(selectedIssueIds.length ? { issueIds: selectedIds } : {}), ...(anchorDate ? { anchorDate } : {}), ...(fillUnscheduled ? { defaultDuration: duration } : {}) }); setPreview(result); }
    catch (err) { setError(errorMessage(err)); } finally { busyRef.current = false; setBusy(false); }
  }
  async function apply() {
    if (busyRef.current || !preview || preview.blocking.length || !preview.changes.length) return; setError(''); busyRef.current = true; setBusy(true);
    try { const result = await post<ScheduleApplyResult>('/schedule/auto-apply', { previewId: preview.previewId }); dirtyRef.current = false; await onApplied(result); }
    catch (err) { setError(errorMessage(err)); } finally { busyRef.current = false; setBusy(false); }
  }
  return <div className="issue-modal-overlay"><section className="automatic-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="automatic-schedule-title">
    <header><div><span className="feature-eyebrow">DEPENDENCIES · WORK CALENDAR</span><h2 id="automatic-schedule-title"><Sparkles size={19} />자동 일정 제안</h2><p>업무 연결과 업무 달력으로 제안합니다. 적용 전에는 날짜가 바뀌지 않습니다.</p></div><button className="issue-icon-button" aria-label="자동 일정 닫기" disabled={busy} onClick={close}><X size={20} /></button></header>
    <form onSubmit={requestPreview}><fieldset disabled={busy || Boolean(preview)}><div className="automatic-schedule-fields"><label className="issue-form-label">프로젝트<select className="field" aria-label="자동 일정 프로젝트" value={selectedProject} onChange={event => setSelectedProject(event.target.value)} required>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="issue-form-label">미정 업무 기준일<input className="field" type="date" aria-label="자동 일정 기준 시작일" value={anchorDate} required={fillUnscheduled} onChange={event => setAnchorDate(event.target.value)} /></label></div><div className="automatic-schedule-scope"><strong>{selectedIssueIds.length ? `선택한 업무 ${selectedIds.length}개` : `프로젝트 전체 업무 ${scopeCount}개`}</strong><span>선택한 범위에서 이어지는 후행 업무도 포함합니다. 필요한 만큼 뒤로 조정하며 기간은 근무일 수로 유지합니다.</span></div><label className="automatic-schedule-fill"><input type="checkbox" checked={fillUnscheduled} onChange={event => setFillUnscheduled(event.target.checked)} />날짜가 없는 업무에 명시한 기간 사용</label>{fillUnscheduled && <label className="issue-form-label automatic-duration">기본 기간 (근무일)<input className="field" type="number" min={1} max={3650} step={1} required aria-label="자동 일정 기본 기간" value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>}<p className="automatic-schedule-note">기간을 추정하지 않습니다. 미정 업무 기준일은 날짜가 없는 업무에만 적용하며 기본 기간도 함께 입력해야 합니다. 이미 날짜가 있는 업무는 선후행 조건과 근무일에 맞춰 필요한 만큼 뒤로 조정합니다.</p><button className="btn btn-primary" type="submit" disabled={!scopeCount}><Sparkles size={14} />{busy ? '제안 계산 중…' : '자동 일정 미리보기'}</button></fieldset></form>
    {preview && <div className="automatic-schedule-result"><div className="automatic-result-heading"><div><h3>{preview.changes.length}개 업무 변경 제안</h3><span>유효 시간 {new Date(preview.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지 · 업무·연결·달력 버전 검증</span></div><button className="btn btn-ghost" disabled={busy} onClick={() => { setPreview(null); setError(''); }}><RefreshCw size={13} />조건 다시 입력</button></div>{preview.blocking.length > 0 && <div className="automatic-blocking" role="alert"><AlertCircle size={17} /><div><strong>적용할 수 없는 조건을 해결하세요</strong>{preview.blocking.map((message, index) => <p key={index}>{message}</p>)}</div></div>}{preview.warnings.length > 0 && <div className="automatic-warnings">{preview.warnings.map((message, index) => <p key={index}>{message}</p>)}</div>}<div className="automatic-proposal-table"><table><thead><tr><th>업무</th><th>현재 일정</th><th /><th>제안 일정</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.id}><td><small>{change.key}</small><strong>{change.title}</strong></td><td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td><td><ArrowRight size={14} /></td><td className="automatic-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td></tr>)}</tbody></table>{!preview.changes.length && <p className="automatic-schedule-note">변경할 일정이 없습니다. 진단 내용을 확인하세요.</p>}</div></div>}
    {error && <div className="issue-form-error automatic-schedule-error" role="alert">{error}<br />입력과 제안을 유지했습니다. 최신 조건으로 새 제안을 만들어 다시 시도하세요.</div>}
    <footer><span>적용 후 간트의 되돌리기를 사용할 수 있습니다.</span><button className="btn btn-ghost" disabled={busy} onClick={close}>닫기</button>{preview && <button className="btn btn-primary" disabled={busy || !preview.changes.length || preview.blocking.length > 0} onClick={apply}><Check size={15} />{busy ? '적용 중…' : '자동 일정 적용'}</button>}</footer>
  </section></div>;
}
