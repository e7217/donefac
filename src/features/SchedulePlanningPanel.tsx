'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Flag, History, LoaderCircle, Plus, Save, Trash2, X } from 'lucide-react';
import type { FeatureProps, Milestone, ScheduleBaseline } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation, areGanttDateDraftsPreservedByNavigation, dispatchWorkspaceNavigation, isGanttIssueOverlayNavigation, isGanttPreservedByNavigation } from '../lib/navigation';
import { ScheduleMilestoneIssuePicker } from './ScheduleMilestoneIssuePicker';
import { ScheduleMilestoneReview, SCHEDULE_MILESTONE_REVIEW_ID } from './ScheduleMilestoneReview';
import './schedule-planning.css';

type Props = FeatureProps & {
  selectedBaselineId: string | null;
  onSelectBaseline: (id: string | null) => void;
  milestoneReviewId: string | null;
  onOpenMilestoneReview: (id: string, opener: HTMLButtonElement) => void;
  onCloseMilestoneReview: () => void;
  onLocateMilestoneIssue: (id: string) => boolean;
  onOpenMilestoneIssue: (id: string, opener: HTMLButtonElement) => void;
  onOpenMilestoneCandidateIssue: (id: string, opener: HTMLButtonElement, issueIds: readonly string[]) => void;
};
type MilestoneFields = Pick<Milestone, 'title' | 'description' | 'date' | 'status' | 'ownerId' | 'issueIds'>;
type MilestoneDraft = { generation: number; id: string | null; expectedVersion: number | null; fields: MilestoneFields; original: string };
type CaptureDraft = { name: string; description: string; expectedIssueVersions: Record<string, number>; expectedMilestoneVersions: Record<string, number>; expectedCalendarVersion: number };
const fieldsOf = (item?: Milestone): MilestoneFields => item ? { title: item.title, description: item.description, date: item.date, status: item.status, ownerId: item.ownerId, issueIds: [...item.issueIds] } : { title: '', description: '', date: new Date().toISOString().slice(0, 10), status: 'open', ownerId: null, issueIds: [] };
const messageOf = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';

export function SchedulePlanningPanel(props: Props) {
  return <ProjectSchedulePlanning key={`${props.projectId}:${props.actorId}`} {...props} />;
}
function ProjectSchedulePlanning({ data, projectId, actorId, refresh, notify, selectedBaselineId, onSelectBaseline,
  milestoneReviewId, onOpenMilestoneReview, onCloseMilestoneReview, onLocateMilestoneIssue, onOpenMilestoneIssue, onOpenMilestoneCandidateIssue }: Props) {
  const milestones = (data.milestones || []).filter(item => item.projectId === projectId).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const baselines = (data.baselines || []).filter(item => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const issues = useMemo(() => data.issues.filter(item => item.projectId === projectId), [data.issues, projectId]);
  const calendar = data.calendars?.find(item => item.projectId === projectId);
  const selected = baselines.find(item => item.id === selectedBaselineId);
  const reviewedMilestone = milestones.find(item => item.id === milestoneReviewId);
  const [draft, setDraft] = useState<MilestoneDraft | null>(null);
  const [capture, setCapture] = useState<CaptureDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  const draftGeneration = useRef(0);
  const dirty = !!draft && JSON.stringify(draft.fields) !== draft.original || !!capture && !!(capture.name || capture.description);
  const current = draft?.id ? milestones.find(item => item.id === draft.id) : null;
  const reset = useCallback(() => { setDraft(null); setCapture(null); setError(''); }, [setDraft, setCapture, setError]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) { event.preventDefault(); notify('일정 정보를 저장하고 있습니다. 잠시 기다려주세요.', 'error'); return; }
      if (isGanttPreservedByNavigation(event) || isGanttIssueOverlayNavigation(event) || !dirty) return;
      if (!window.confirm('작성 중인 일정 정보를 버리고 이동할까요?')) {
        event.preventDefault();
        return;
      }
      // Local actions replace or clear the form themselves after all listeners accept the event.
      if (!areGanttDateDraftsPreservedByNavigation(event)) afterAcceptedNavigation(event, reset);
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirty || pending.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', unload); };
  }, [dirty, notify, reset]);
  const canNavigate = () => dispatchWorkspaceNavigation({ preserveGantt: 'dateDrafts' });
  const source = () => calendar ? { expectedIssueVersions: Object.fromEntries(issues.map(item => [item.id, item.version])), expectedMilestoneVersions: Object.fromEntries(milestones.map(item => [item.id, item.version])), expectedCalendarVersion: calendar.version } : null;
  const openMilestone = (item?: Milestone) => {
    if (!canNavigate()) return;
    const fields = fieldsOf(item);
    draftGeneration.current += 1;
    setCapture(null);
    setError('');
    setDraft({ generation: draftGeneration.current, id: item?.id ?? null, expectedVersion: item?.version ?? null, fields, original: JSON.stringify(fields) });
  };
  const openCapture = () => {
    const versions = source(); if (!versions || !canNavigate()) return;
    setDraft(null); setError(''); setCapture({ name: '', description: '', ...versions });
  };
  const cancel = () => { if (canNavigate()) reset(); };
  const selectBaseline = (id: string | null) => {
    if (!canNavigate()) return;
    if (dirty) reset();
    onSelectBaseline(id);
  };
  const update = <K extends keyof MilestoneFields>(key: K, value: MilestoneFields[K]) => setDraft(previous => previous ? { ...previous, fields: { ...previous.fields, [key]: value } } : previous);
  const mutate = async (operation: () => Promise<unknown>, success: string, after?: (value: unknown) => void) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await operation();
      if (!active.current) return;
      reset(); after?.(value); notify(success);
      try { await refresh(); } catch { notify('저장은 완료됐지만 화면을 새로고침하지 못했습니다.', 'error'); }
    } catch (failure) {
      if (!active.current) return;
      setError(messageOf(failure));
      if (failure instanceof ApiError && [400, 409].includes(failure.status)) {
        try { await refresh(); } catch { /* Keep the draft even when refresh is unavailable. */ }
      }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const request = <T,>(path: string, method: string, body?: unknown) => api<T>(path, { method, headers: { 'X-Actor-Id': actorId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const saveMilestone = (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    const captured = draft;
    void mutate(() => request(captured.id ? `/milestones/${captured.id}` : '/milestones', captured.id ? 'PATCH' : 'POST', { projectId, ...captured.fields, ...(captured.id ? { expectedVersion: captured.expectedVersion } : {}) }), '이정표를 저장했습니다.');
  };
  const saveBaseline = (event: FormEvent) => {
    event.preventDefault(); if (!capture) return;
    const captured = capture;
    void mutate(() => request<ScheduleBaseline>('/baselines', 'POST', { projectId, ...captured }), '일정 기준선을 저장했습니다.', value => onSelectBaseline((value as ScheduleBaseline).id));
  };
  const deleteMilestone = (item: Milestone) => {
    if (pending.current || !window.confirm(`'${item.title}' 이정표를 삭제할까요? 저장된 기준선은 보존됩니다.`) || !canNavigate()) return;
    void mutate(() => request(`/milestones/${item.id}?expectedVersion=${item.version}`, 'DELETE'), '이정표를 삭제했습니다.');
  };
  const deleteBaseline = () => {
    if (!selected || pending.current || !window.confirm(`'${selected.name}' 기준선을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`) || !canNavigate()) return;
    const captured = selected;
    void mutate(() => request(`/baselines/${captured.id}?expectedVersion=${captured.version}`, 'DELETE'), '기준선을 삭제했습니다.', () => onSelectBaseline(null));
  };
  const captureStale = capture && calendar && (JSON.stringify(capture.expectedIssueVersions) !== JSON.stringify(Object.fromEntries(issues.map(item => [item.id, item.version]))) || JSON.stringify(capture.expectedMilestoneVersions) !== JSON.stringify(Object.fromEntries(milestones.map(item => [item.id, item.version]))) || capture.expectedCalendarVersion !== calendar.version);

  return <section className="schedule-planning" aria-label="이정표와 일정 기준선">
    <div className="schedule-planning-toolbar">
      <span className="schedule-planning-title"><Flag size={16} />이정표 · 기준선</span>
      <label className="schedule-baseline-label"><History size={14} /><select aria-label="비교 기준선" value={selected?.id || ''} disabled={busy} onChange={event => selectBaseline(event.currentTarget.value || null)}><option value="">기준선 비교 안 함</option>{baselines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button className="btn btn-ghost" disabled={busy || !calendar} title={!calendar ? '근무일 기준을 불러오는 중입니다.' : undefined} onClick={openCapture}><History size={14} />기준선 저장</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => openMilestone()}><Plus size={14} />이정표 만들기</button>
      {busy && <LoaderCircle size={15} className="spin" aria-label="일정 정보 저장 중" />}
    </div>
    {selected && <div className="schedule-baseline-summary"><span><strong>{selected.name}</strong> · {new Date(selected.createdAt).toLocaleString('ko-KR')} · 업무 {selected.issues.length}개 · 이정표 {selected.milestones.length}개 · {selected.calendar.name} v{selected.calendar.version}{selected.description && <small>{selected.description}</small>}</span><button className="btn btn-ghost" aria-label="선택한 기준선 삭제" disabled={busy} onClick={deleteBaseline}><Trash2 size={13} />삭제</button></div>}
    <details className="schedule-milestone-list">
      <summary>이정표 {milestones.length}개</summary>
      {milestones.length === 0 && <p className="muted">출시와 검토 등 중요한 날짜를 이정표로 표시하세요.</p>}
      {milestones.map(item => <div className="schedule-milestone-row" key={item.id}>
        <span className={`schedule-milestone-dot ${item.status}`} />
        <button className="schedule-milestone-name" onClick={() => openMilestone(item)} disabled={busy}>
          <strong>{item.title}</strong>
          <small>{item.date} · {item.status === 'reached' ? '달성' : '예정'} · {data.users.find(user => user.id === item.ownerId)?.name || '담당자 없음'}</small>
        </button>
        <button className="btn btn-ghost schedule-milestone-review-action" type="button" disabled={busy}
          aria-label={`${item.title} 연결 업무 확인`} aria-expanded={milestoneReviewId === item.id}
          aria-controls={milestoneReviewId === item.id ? SCHEDULE_MILESTONE_REVIEW_ID : undefined}
          onClick={event => onOpenMilestoneReview(item.id, event.currentTarget)}>
          연결 업무 {item.issueIds.length}개
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => deleteMilestone(item)} aria-label={`${item.title} 이정표 삭제`}><Trash2 size={14} /></button>
      </div>)}
    </details>
    {milestoneReviewId && <ScheduleMilestoneReview key={milestoneReviewId} milestone={reviewedMilestone} issues={issues}
      workflows={data.workflows} busy={busy} onClose={onCloseMilestoneReview} onLocateIssue={onLocateMilestoneIssue} onOpenIssue={onOpenMilestoneIssue} />}
    {draft && <form className="schedule-artifact-form" aria-label="이정표 편집" onSubmit={saveMilestone}>
      <div className="schedule-artifact-form-title"><strong>{draft.id ? '이정표 편집' : '새 이정표'}</strong><button type="button" className="btn btn-ghost" aria-label="일정 양식 닫기" disabled={busy} onClick={cancel}><X size={15} /></button></div>
      {draft.id && (!current || current.version !== draft.expectedVersion) && <div className="schedule-artifact-warning">다른 변경사항이 있습니다. 입력은 유지됩니다. 취소 후 이정표를 다시 열어 최신 내용을 확인하세요.</div>}
      <fieldset disabled={busy}>
        <label>제목<input className="field" aria-label="이정표 제목" maxLength={300} required value={draft.fields.title} onChange={event => update('title', event.target.value)} /></label>
        <label>날짜<input className="field" aria-label="이정표 날짜" type="date" required value={draft.fields.date} onChange={event => update('date', event.target.value)} /></label>
        <label>상태<select className="field" aria-label="이정표 상태" value={draft.fields.status} onChange={event => update('status', event.target.value as Milestone['status'])}><option value="open">예정</option><option value="reached">달성</option></select></label>
        <label>책임자<select className="field" aria-label="이정표 책임자" value={draft.fields.ownerId || ''} onChange={event => update('ownerId', event.target.value || null)}><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label className="schedule-form-wide">설명<textarea className="field" aria-label="이정표 설명" value={draft.fields.description} onChange={event => update('description', event.target.value)} /></label>
        <ScheduleMilestoneIssuePicker key={draft.generation} issues={issues} issueAliases={data.issueAliases}
          selectedIds={draft.fields.issueIds} onChange={ids => update('issueIds', ids)} onOpenIssue={onOpenMilestoneCandidateIssue} />
      </fieldset>
      <div className="schedule-artifact-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={cancel}>취소</button><button className="btn btn-primary" disabled={busy || !draft.fields.title.trim() || !draft.fields.date || !!draft.id && !dirty}><Save size={14} />이정표 저장</button></div>
    </form>}
    {capture && <form className="schedule-artifact-form" aria-label="일정 기준선 저장" onSubmit={saveBaseline}><div className="schedule-artifact-form-title"><strong>현재 일정을 기준선으로 저장</strong><button type="button" className="btn btn-ghost" aria-label="일정 양식 닫기" disabled={busy} onClick={cancel}><X size={15} /></button></div><p className="muted">프로젝트 전체 업무 {Object.keys(capture.expectedIssueVersions).length}개와 이정표 {Object.keys(capture.expectedMilestoneVersions).length}개, 근무일 기준 v{capture.expectedCalendarVersion}를 변경할 수 없는 기록으로 남깁니다. 화면의 필터와 관계없이 전체 일정을 포함합니다.</p><fieldset disabled={busy}><label className="schedule-form-wide">이름<input className="field" aria-label="기준선 이름" maxLength={300} required value={capture.name} onChange={event => setCapture(previous => previous ? { ...previous, name: event.target.value } : previous)} /></label><label className="schedule-form-wide">설명<textarea className="field" aria-label="기준선 설명" value={capture.description} onChange={event => setCapture(previous => previous ? { ...previous, description: event.target.value } : previous)} /></label></fieldset>{captureStale && <p className="schedule-artifact-warning">양식을 연 뒤 일정이 변경되었습니다. 입력을 유지한 채 최신 자료를 다시 확인해주세요.</p>}<div className="schedule-artifact-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={cancel}>취소</button><button type="button" className="btn btn-ghost" disabled={busy || !calendar} onClick={() => { const versions = source(); if (versions) { setCapture(previous => previous ? { ...previous, ...versions } : previous); setError(''); } }}>최신 자료로 다시 확인</button><button className="btn btn-primary" disabled={busy || !capture.name.trim()}><Save size={14} />기준선 확정 저장</button></div></form>}
    {error && <p className="schedule-artifact-error" role="alert">{error} {draft || capture ? '작성한 입력은 유지됩니다.' : ''}</p>}
  </section>;
}
