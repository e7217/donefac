'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AutomaticSchedulePreview, FeatureProps, Issue, ScheduleUndoScope } from '../../shared/types';
import { api, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import { isUncertainScheduleResponse, scheduleUndoHeaders } from './schedule-undo';
import './automatic-schedule.css';

export type ScheduleApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
type Receipt = ScheduleApplyResult | { applied: false };
type ApplyState = { kind: 'uncertain' | 'rejected' } | { kind: 'applied'; result: ScheduleApplyResult };

function isApplyResult(value: Receipt): value is ScheduleApplyResult {
  return Boolean(value && 'undoId' in value && typeof value.undoId === 'string' && value.undoId && Array.isArray(value.updated));
}

export function AutomaticScheduleDialog({ data, projectId, actorId, undoScope, selectedIssueIds, conflictReview, notify, onClose, onApplied }: FeatureProps & {
  undoScope: ScheduleUndoScope;
  selectedIssueIds: string[];
  conflictReview?: { predecessorKey: string; successorKey: string };
  onClose: () => void;
  onApplied: (result: ScheduleApplyResult) => Promise<void>;
}) {
  const [initialProject] = useState(conflictReview || data.projects.some(value => value.id === projectId) ? projectId : data.projects[0]?.id || '');
  const [selectedProject, setSelectedProject] = useState(initialProject);
  const [anchorDate, setAnchorDate] = useState('');
  const [fillUnscheduled, setFillUnscheduled] = useState(false);
  const [duration, setDuration] = useState(1);
  const [preview, setPreview] = useState<AutomaticSchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [applyState, setApplyState] = useState<ApplyState | null>(null);
  const busyRef = useRef(false), dirtyRef = useRef(false);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const conflictTarget = conflictReview?.successorKey;
  const selectedIds = selectedIssueIds.filter(id => data.issues.some(issue => issue.id === id && issue.projectId === selectedProject));
  const scopeCount = data.issues.filter(issue => issue.projectId === selectedProject && (!selectedIssueIds.length || selectedIds.includes(issue.id))).length;
  const dirty = applyState?.kind !== 'applied' && Boolean(preview || anchorDate || fillUnscheduled || duration !== 1 || selectedProject !== initialProject);
  const discardPrompt = applyState?.kind === 'uncertain' ? '자동 일정 적용 결과를 확인하지 못했습니다. 확인을 닫을까요?' : '자동 일정 입력과 미리보기를 버릴까요?';
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { if (conflictTarget) previewButton.current?.focus(); }, [conflictTarget]);
  useEffect(() => {
    if (!busy && (applyState?.kind === 'uncertain' || applyState?.kind === 'applied')) recoveryButton.current?.focus();
  }, [applyState, busy]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current) { event.preventDefault(); notify('일정 제안 처리가 끝난 뒤 이동해 주세요.', 'error'); }
      else if (dirtyRef.current && !window.confirm(discardPrompt)) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('donefac:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('donefac:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [discardPrompt, notify, onClose]);

  function close() {
    if (!busyRef.current && (!dirtyRef.current || window.confirm(discardPrompt))) onClose();
  }

  async function runRequest(run: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try { await run(); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function requestPreview(event: FormEvent) {
    event.preventDefault();
    if (!scopeCount || preview) return;
    await runRequest(async () => {
      try {
        setPreview(await post<AutomaticSchedulePreview>('/schedule/auto-preview', {
          projectId: selectedProject, ...(selectedIssueIds.length ? { issueIds: selectedIds } : {}),
          ...(anchorDate ? { anchorDate } : {}), ...(fillUnscheduled ? { defaultDuration: duration } : {}),
        }));
      } catch (cause) { setError(errorMessage(cause)); }
    });
  }

  async function reflect(result: ScheduleApplyResult) {
    setApplyState({ kind: 'applied', result });
    dirtyRef.current = false;
    try { await onApplied(result); }
    catch { setError('자동 일정을 저장했습니다. 간트에 저장 결과를 다시 불러와 주세요.'); }
  }

  async function apply(recovering: boolean) {
    if (!preview || preview.blocking.length || !preview.changes.length ||
        (recovering ? applyState?.kind !== 'uncertain' : Boolean(applyState))) return;
    await runRequest(async () => {
      let result: Receipt;
      try {
        result = recovering
          ? await api<Receipt>(`/schedule/auto-result/${encodeURIComponent(preview.previewId)}`, {
            cache: 'no-store', headers: scheduleUndoHeaders(null, actorId),
          })
          : await api<Receipt>('/schedule/auto-apply', {
            method: 'POST', headers: scheduleUndoHeaders(undoScope, actorId), body: JSON.stringify({ previewId: preview.previewId }),
          });
        if (!isApplyResult(result)) {
          if (!recovering || result?.applied !== false) throw new Error('자동 일정 적용 응답을 확인하지 못했습니다.');
          setApplyState(null);
          setStatus('아직 저장된 결과가 없습니다. 같은 제안을 다시 적용할 수 있습니다.');
          return;
        }
      } catch (cause) {
        if (recovering) setError(`저장 결과를 확인하지 못했습니다. ${errorMessage(cause)}`);
        else if (isUncertainScheduleResponse(cause)) {
          setApplyState({ kind: 'uncertain' });
          setError('자동 일정 적용 응답을 받지 못했습니다. 같은 제안의 적용 결과를 다시 확인해 주세요.');
        } else {
          setApplyState({ kind: 'rejected' });
          setError(`${errorMessage(cause)} 입력과 제안을 유지했습니다. 최신 조건으로 새 제안을 만들어 다시 시도하세요.`);
        }
        return;
      }
      await reflect(result);
    });
  }
  return <div className="issue-modal-overlay"><section className="automatic-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="automatic-schedule-title">
    <header><div><span className="feature-eyebrow">DEPENDENCIES · WORK CALENDAR</span><h2 id="automatic-schedule-title"><Sparkles size={19} />자동 일정 제안</h2><p>업무 연결과 업무 달력으로 제안합니다. 적용 전에는 날짜가 바뀌지 않습니다.</p></div><button className="issue-icon-button" aria-label="자동 일정 닫기" disabled={busy} onClick={close}><X size={20} /></button></header>
    <form onSubmit={requestPreview}><fieldset disabled={busy || Boolean(preview)}>
      <div className="automatic-schedule-fields">
        <label className="issue-form-label">프로젝트<select className="field" aria-label="자동 일정 프로젝트" value={selectedProject}
          onChange={event => setSelectedProject(event.target.value)} disabled={Boolean(conflictReview)} required>
          {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></label>
        <label className="issue-form-label">미정 업무 기준일<input className="field" type="date" aria-label="자동 일정 기준 시작일" value={anchorDate}
          required={fillUnscheduled} onChange={event => setAnchorDate(event.target.value)} /></label>
      </div>
      <div className="automatic-schedule-scope">
        <strong>{conflictReview ? `${conflictReview.predecessorKey} → ${conflictReview.successorKey}`
          : selectedIssueIds.length ? `선택한 업무 ${selectedIds.length}개` : `프로젝트 전체 업무 ${scopeCount}개`}</strong>
        <span>{conflictReview ? '이 연결의 저장 일정부터 검토합니다. 작성 중인 날짜는 간트에 유지됩니다.'
          : '선택한 범위에서 이어지는 후행 업무도 포함합니다. 필요한 만큼 뒤로 조정하며 기간은 근무일 수로 유지합니다.'}</span>
        {conflictReview && !scopeCount && <p role="alert">선택한 후행 업무를 이 프로젝트에서 확인할 수 없습니다.</p>}
      </div>
      <label className="automatic-schedule-fill"><input type="checkbox" checked={fillUnscheduled} onChange={event => setFillUnscheduled(event.target.checked)} />날짜가 없는 업무에 명시한 기간 사용</label>
      {fillUnscheduled && <label className="issue-form-label automatic-duration">기본 기간 (근무일)<input className="field" type="number" min={1} max={3650} step={1}
        required aria-label="자동 일정 기본 기간" value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>}
      <p className="automatic-schedule-note">기간을 추정하지 않습니다. 미정 업무 기준일은 날짜가 없는 업무에만 적용하며 기본 기간도 함께 입력해야 합니다. 이미 날짜가 있는 업무는 선후행 조건과 근무일에 맞춰 필요한 만큼 뒤로 조정합니다.</p>
      <button ref={previewButton} className="btn btn-primary" type="submit" disabled={!scopeCount}><Sparkles size={14} />{busy ? '제안 계산 중…' : '자동 일정 미리보기'}</button>
    </fieldset></form>
    {preview && <div className="automatic-schedule-result"><div className="automatic-result-heading"><div><h3>{preview.changes.length}개 업무 변경 제안</h3><span>유효 시간 {new Date(preview.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지 · 업무·연결·달력 버전 검증</span></div>
      <button className="btn btn-ghost" disabled={busy || applyState?.kind === 'uncertain' || applyState?.kind === 'applied'}
        onClick={() => { setPreview(null); setApplyState(null); setError(''); setStatus(''); }}><RefreshCw size={13} />조건 다시 입력</button></div>
      {preview.blocking.length > 0 && <div className="automatic-blocking" role="alert"><AlertCircle size={17} /><div><strong>적용할 수 없는 조건을 해결하세요</strong>{preview.blocking.map((message, index) => <p key={index}>{message}</p>)}</div></div>}{preview.warnings.length > 0 && <div className="automatic-warnings">{preview.warnings.map((message, index) => <p key={index}>{message}</p>)}</div>}<div className="automatic-proposal-table"><table><thead><tr><th>업무</th><th>현재 일정</th><th /><th>제안 일정</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.id}><td><small>{change.key}</small><strong>{change.title}</strong></td><td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td><td><ArrowRight size={14} /></td><td className="automatic-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td></tr>)}</tbody></table>{!preview.changes.length && <p className="automatic-schedule-note">변경할 일정이 없습니다. 진단 내용을 확인하세요.</p>}</div></div>}
    {error && <div className="issue-form-error automatic-schedule-error" role="alert">{error}</div>}
    {status && <p className="automatic-schedule-note" role="status">{status}</p>}
    <footer><span>적용 후 간트의 되돌리기를 사용할 수 있습니다.</span><button className="btn btn-ghost" disabled={busy} onClick={close}>닫기</button>
      {applyState?.kind === 'applied' ? <button ref={recoveryButton} className="btn btn-primary" disabled={busy}
        onClick={() => void runRequest(() => reflect(applyState.result))}><RefreshCw size={15} />간트 다시 불러오기</button>
        : applyState?.kind === 'uncertain' ? <button ref={recoveryButton} className="btn btn-primary" disabled={busy}
          onClick={() => void apply(true)}><RefreshCw size={15} />적용 결과 다시 확인</button>
          : preview && <button className="btn btn-primary" disabled={busy || Boolean(applyState) || !preview.changes.length || preview.blocking.length > 0}
            onClick={() => void apply(false)}><Check size={15} />{busy ? '적용 중…' : '자동 일정 적용'}</button>}
    </footer>
  </section></div>;
}
