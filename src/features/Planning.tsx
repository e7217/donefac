'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Archive, ArrowRight, CalendarRange, Check, CircleDashed, ClipboardCheck, Layers3, LoaderCircle, PackageCheck, Plus, RefreshCw, Save, Search, SquareChartGantt, Trash2 } from 'lucide-react';
import type { FeatureProps, Issue, PlanningItem, PlanningKind, PlanningStatus } from '../../shared/types';
import { isCalendarDate } from '../../shared/calendar';
import { statusMeta } from '../../shared/workflow-helpers';
import { api, dateLabel, patch, post, remove } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { CycleCompletionHistory } from './CycleCompletionHistory';
import { CycleCompletionPanel } from './CycleCompletionPanel';
import { CycleProgress } from './CycleProgress';
import { PLAN_ID_FIELDS, PLAN_LABELS } from './PlanningSelectors';
import { errorMessage } from './schedule-utils';
import './planning.css';

const STATE_LABELS: Record<PlanningStatus, string> = { planned: '계획', active: '진행 중', completed: '완료', archived: '보관됨' };
const KIND_DESCRIPTIONS: Record<PlanningKind, string> = { cycle: '정해진 기간의 업무를 모아 실행에 집중하세요.', module: '기능과 영역별로 업무를 묶고 맥락을 이어가세요.', release: '출시 목표와 포함할 업무를 함께 관리하세요.' };
const KIND_ICONS = { cycle: CalendarRange, module: Layers3, release: PackageCheck };
type PlanDraft = Pick<PlanningItem, 'name' | 'description' | 'status' | 'ownerId' | 'startDate' | 'endDate' | 'targetDate'>;
type Assignment = { issueId: string; expectedVersion: number; assigned: boolean; originallyAssigned: boolean };
function draftOf(item?: PlanningItem): PlanDraft { return item ? { name: item.name, description: item.description, status: item.status, ownerId: item.ownerId, startDate: item.startDate, endDate: item.endDate, targetDate: item.targetDate } : { name: '', description: '', status: 'planned', ownerId: null, startDate: null, endDate: null, targetDate: null }; }
function progress(data: FeatureProps['data'], issues: Issue[]) { const eligible = issues.filter(issue => statusMeta(data, issue.projectId, issue.status).category !== 'cancelled'); const done = eligible.filter(issue => statusMeta(data, issue.projectId, issue.status).category === 'done').length; return { done, total: eligible.length, percent: eligible.length ? Math.round(done / eligible.length * 100) : 0 }; }

type PlanningProps = FeatureProps & {
  initialPlanningId?: string | null;
  onSelectPlanning?: (id: string | null) => boolean;
  onOpenGantt?: (id: string) => void;
  onOpenCycleBoard?: (id?: string) => void;
  onOpenReleaseReadiness?: (id: string) => void;
  onOpenIssueSchedule?: (id: string, planId?: string) => boolean;
};
function defaultPlan(plans: readonly PlanningItem[], kind: PlanningKind) {
  return (kind === 'cycle' ? plans.find(item => item.kind === kind && item.status === 'active') : undefined) ??
    plans.find(item => item.kind === kind && item.status !== 'archived');
}
function followPlanLink(event: MouseEvent<HTMLAnchorElement>, id: string, open?: (id: string) => void) {
  if (!open || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open(id);
}
export function Planning(props: PlanningProps) { return <ProjectPlanning key={props.projectId} {...props} />; }
function ProjectPlanning(props: PlanningProps) {
  const { data, projectId, initialPlanningId, onSelectPlanning, onOpenGantt, onOpenCycleBoard, onOpenReleaseReadiness } = props;
  const plans = (data.planningItems ?? []).filter(item => item.projectId === projectId);
  const routeId = initialPlanningId ?? null;
  const routedItem = plans.find(item => item.id === routeId);
  const [selection, setSelection] = useState<{ routeId: string | null; kind: PlanningKind; id: string | null; creating: boolean }>(() => ({
    routeId, kind: routedItem?.kind ?? 'cycle', id: routedItem?.id ?? defaultPlan(plans, 'cycle')?.id ?? null, creating: false,
  }));
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(routedItem?.status === 'archived');
  const { kind, creating } = selection;
  if (selection.routeId !== routeId) {
    const nextKind = routedItem?.kind ?? 'cycle';
    setSelection({ routeId, kind: nextKind, id: routedItem?.id ?? defaultPlan(plans, nextKind)?.id ?? null, creating: false });
    if (nextKind !== kind) setQuery('');
    if (routedItem?.status === 'archived') setShowArchived(true);
  }
  const items = plans.filter(item => item.kind === kind);
  const visible = items.filter(item => (showArchived || item.status !== 'archived') && (!query || `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())));
  const currentId = creating ? null : selection.id;
  const current = items.find(item => item.id === currentId);
  const canLeave = () => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }));
  function changeSelection(id: string | null, nextKind: PlanningKind) {
    let nextRouteId = routeId;
    if (onSelectPlanning && routeId !== id) {
      if (!onSelectPlanning(id)) return false;
      nextRouteId = id;
    } else if (!canLeave()) return false;
    setSelection({ routeId: nextRouteId, kind: nextKind, id, creating: false });
    return true;
  }
  function changeKind(value: PlanningKind) {
    if (kind !== value && changeSelection(defaultPlan(plans, value)?.id ?? null, value)) setQuery('');
  }
  function select(id: string) {
    if (creating || id !== currentId || (onSelectPlanning && routeId !== id)) changeSelection(id, kind);
  }
  function create() {
    if (canLeave()) setSelection(previous => ({ ...previous, creating: true }));
  }
  function selectCreated(item: PlanningItem) {
    if (changeSelection(item.id, item.kind) && item.status === 'archived') setShowArchived(true);
  }
  const Icon = KIND_ICONS[kind];
  return <div className="planning-feature"><div className="feature-heading"><div><div className="feature-eyebrow">TURN PLANS INTO PROGRESS</div><h1>사이클 · 모듈 · 릴리스</h1><p>기간, 기능, 출시 목표에 맞춰 같은 업무를 함께 계획하세요.</p></div>
    <div className="planning-heading-actions">
      {onOpenCycleBoard && <button className="btn" type="button" onClick={() => onOpenCycleBoard(current?.kind === 'cycle' ? current.id : undefined)}>
        <CalendarRange size={15} aria-hidden="true" />백로그 · 사이클
      </button>}
      <button className="btn btn-primary" onClick={create}><Plus size={15} />{PLAN_LABELS[kind]} 만들기</button>
    </div></div><div className="planning-kind-tabs">{(['cycle', 'module', 'release'] as const).map(value => { const KindIcon = KIND_ICONS[value]; return <button key={value} className={kind === value ? 'active' : ''} onClick={() => changeKind(value)}><KindIcon size={16} />{PLAN_LABELS[value]}<span>{plans.filter(item => item.kind === value && item.status !== 'archived').length}</span></button>; })}</div>
    <div className="planning-layout"><aside className="planning-list"><div className="planning-list-heading"><h2><Icon size={16} />{PLAN_LABELS[kind]}</h2><p>{KIND_DESCRIPTIONS[kind]}</p><div className="planning-search"><Search size={14} /><input aria-label="계획 항목 검색" placeholder="이름 또는 설명 검색" value={query} onChange={event => setQuery(event.target.value)} /></div><label className="planning-archive-toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />보관된 항목 포함</label></div><div className="planning-list-content">{visible.map(item => { const linked = data.issues.filter(issue => issue[PLAN_ID_FIELDS[kind]] === item.id); const stats = progress(data, linked); return <button className={`planning-item-card ${currentId === item.id && !creating ? 'active' : ''}`} key={item.id} onClick={() => select(item.id)}><span className="planning-item-meta"><span className={`planning-status is-${item.status}`}>{STATE_LABELS[item.status]}</span><span>{dateLabel(item.startDate)} — {dateLabel(item.endDate || item.targetDate)}</span></span><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}<span className="planning-progress-track"><i style={{ width: `${stats.percent}%` }} /></span><span className="planning-card-footer"><span>연결 {linked.length}개 · 완료 {stats.done}/{stats.total}</span><strong>{stats.percent}%</strong></span></button>; })}{!visible.length && <div className="planning-list-empty"><CircleDashed size={27} /><p>{query ? '검색 결과가 없습니다.' : `${PLAN_LABELS[kind]}을 만들어 업무를 모아보세요.`}</p><button className="btn btn-ghost" onClick={create}><Plus size={14} />새 {PLAN_LABELS[kind]}</button></div>}</div></aside>
      {creating || currentId ? <div className="planning-detail-column">
        {current && <div className="planning-detail-actions">
          {current.kind === 'release' && <a className="btn" href={`#/${encodeURIComponent(projectId)}/reports/blockers?${new URLSearchParams({ release: current.id })}`}
            onClick={event => followPlanLink(event, current.id, onOpenReleaseReadiness)}>
            <ClipboardCheck size={15} aria-hidden="true" />릴리스 준비 점검
          </a>}
          <a className="btn" href={`#/${encodeURIComponent(projectId)}/gantt/${encodeURIComponent(current.id)}`}
            onClick={event => followPlanLink(event, current.id, onOpenGantt)}><SquareChartGantt size={15} aria-hidden="true" />간트에서 열기</a>
        </div>}
        <PlanningEditor key={`${creating ? `new:${kind}` : currentId}:${props.actorId}`} {...props} kind={kind} item={current} existingId={currentId}
          onCreated={selectCreated} onDeleted={() => changeSelection(null, kind)} />
      </div> : <div className="planning-detail-column">
        {kind === 'cycle' && <CycleCompletionHistory projectId={projectId} actorId={props.actorId} issues={data.issues} openIssue={props.openIssue} />}
        <div className="planning-welcome"><Icon size={35} /><h2>함께 실행할 계획을 세워보세요</h2><p>{KIND_DESCRIPTIONS[kind]}</p><button className="btn btn-primary" onClick={create}><Plus size={15} />{PLAN_LABELS[kind]} 만들기</button></div>
      </div>}
    </div></div>;
}

function PlanningEditor({ data, projectId, actorId, kind, item, existingId, refresh, notify, openIssue, onOpenIssueSchedule, onCreated, onDeleted }: FeatureProps & {
  kind: PlanningKind; item?: PlanningItem; existingId: string | null;
  onOpenIssueSchedule?: PlanningProps['onOpenIssueSchedule']; onCreated: (item: PlanningItem) => void; onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<PlanDraft>(() => draftOf(item));
  const [baseline, setBaseline] = useState<PlanDraft>(() => draftOf(item));
  const [version, setVersion] = useState(item?.version || 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [membershipError, setMembershipError] = useState('');
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [assignmentVersion, setAssignmentVersion] = useState<number | null>(null);
  const [issueQuery, setIssueQuery] = useState('');
  const [showCandidates, setShowCandidates] = useState(false);
  const [completionCycle, setCompletionCycle] = useState<PlanningItem | null>(null);
  const completionButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const pendingRef = useRef(false), dirtyRef = useRef(false);
  const closeCompletion = useCallback(() => setCompletionCycle(null), []);
  const restoreCompletionFocus = useCallback(() => {
    const button = completionButton.current;
    (button && !button.disabled ? button : title.current)?.focus({ preventScroll: true });
  }, []);
  const acceptCycle = useCallback((latest: PlanningItem) => {
    const next = draftOf(latest);
    setDraft(next);
    setBaseline(next);
    setVersion(latest.version);
    setError('');
  }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const selectedAssignments = Object.values(assignments);
  const hasUnsaved = dirty || selectedAssignments.length > 0;
  const remoteChanged = Boolean(item && item.version > version);
  const requiresCycleCompletion = Boolean(item && kind === 'cycle' && baseline.status === 'active');
  function startCompletion() {
    if (item && requiresCycleCompletion && !pendingRef.current && !hasUnsaved && !remoteChanged) {
      setCompletionCycle({ ...item, ...baseline, version });
    }
  }
  if (item && remoteChanged && !hasUnsaved && !busy) { setDraft(draftOf(item)); setBaseline(draftOf(item)); setVersion(item.version); setError(''); }
  useEffect(() => { dirtyRef.current = hasUnsaved; }, [hasUnsaved]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pendingRef.current) { event.preventDefault(); notify('계획 변경이 끝난 뒤 이동해 주세요.', 'error'); }
      else if (dirtyRef.current) {
        if (!window.confirm('저장하지 않은 계획 변경을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          dirtyRef.current = false;
          setDraft({ ...baseline });
          setAssignments({});
          setAssignmentVersion(null);
          setError('');
          setMembershipError('');
        });
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (pendingRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify, baseline]);
  const field = PLAN_ID_FIELDS[kind];
  const linked = data.issues.filter(issue => issue[field] === existingId && issue.projectId === projectId);
  const stats = progress(data, linked);
  const candidates = data.issues.filter(issue => issue.projectId === projectId && (showCandidates || issue[field] === existingId) && (!issueQuery || `${issue.key} ${issue.title}`.toLowerCase().includes(issueQuery.toLowerCase()))).sort((a, b) => Number(b[field] === existingId) - Number(a[field] === existingId));
  function update<K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) { setDraft(previous => ({ ...previous, [key]: value })); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (pendingRef.current) return; pendingRef.current = true; setBusy(true); setError('');
    try {
      const saved = existingId ? await patch<PlanningItem>(`/planning-items/${existingId}`, { ...draft, expectedVersion: version }) : await post<PlanningItem>('/planning-items', { ...draft, projectId, kind });
      setDraft(draftOf(saved)); setBaseline(draftOf(saved)); setVersion(saved.version); dirtyRef.current = false; await refresh(); notify(`${PLAN_LABELS[kind]}을 저장했습니다.`); if (!existingId) { pendingRef.current = false; onCreated(saved); }
    } catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setBusy(false); }
  }
  async function reload() {
    if (pendingRef.current || (dirtyRef.current && !window.confirm('작성 중인 변경을 버리고 최신 계획을 불러올까요?'))) return;
    pendingRef.current = true; setBusy(true);
    try { const latest = await api<PlanningItem>(`/planning-items/${existingId}`); setDraft(draftOf(latest)); setBaseline(draftOf(latest)); setVersion(latest.version); setAssignments({}); setAssignmentVersion(null); dirtyRef.current = false; setError(''); setMembershipError(''); await refresh(); }
    catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setBusy(false); }
  }
  async function deleteItem() {
    if (!existingId || pendingRef.current || !window.confirm(`“${draft.name}” ${PLAN_LABELS[kind]}을 삭제할까요? 저장하지 않은 변경도 사라집니다.`)) return;
    pendingRef.current = true; setBusy(true); setError('');
    try { await remove(`/planning-items/${existingId}?expectedVersion=${version}`); dirtyRef.current = false; await refresh(); pendingRef.current = false; onDeleted(); notify('계획 항목을 삭제했습니다.'); }
    catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setBusy(false); }
  }
  function toggle(issue: Issue, assigned: boolean) {
    if (!existingId) return;
    if (!selectedAssignments.length) setAssignmentVersion(item?.version || version);
    setAssignments(previous => { const next = { ...previous }; const original = next[issue.id]?.originallyAssigned ?? issue[field] === existingId; if (assigned === original) delete next[issue.id]; else next[issue.id] = { issueId: issue.id, expectedVersion: next[issue.id]?.expectedVersion || issue.version, assigned, originallyAssigned: original }; return next; });
  }
  async function applyAssignments() {
    if (!existingId || pendingRef.current || dirty || !selectedAssignments.length) return;
    pendingRef.current = true; setBusy(true); setMembershipError('');
    try { const result = await post<{ item: PlanningItem; updated: Issue[] }>(`/planning-items/${existingId}/issues`, { expectedVersion: assignmentVersion ?? version, assignments: selectedAssignments.map(({ issueId, expectedVersion, assigned }) => ({ issueId, expectedVersion, assigned })) }); setAssignments({}); setAssignmentVersion(null); setDraft(draftOf(result.item)); setBaseline(draftOf(result.item)); setVersion(result.item.version); dirtyRef.current = false; await refresh(); notify(`${selectedAssignments.length}개 업무의 연결을 변경했습니다.`); }
    catch (err) { setMembershipError(errorMessage(err)); await refresh().catch(() => undefined); } finally { pendingRef.current = false; setBusy(false); }
  }
  const Icon = KIND_ICONS[kind];
  return <section className="planning-editor" aria-label={`${PLAN_LABELS[kind]} 상세`}><div className="planning-editor-heading"><div><span className="feature-eyebrow">{existingId ? `PLAN · V${version}` : 'NEW PLAN'}</span><h2 ref={title} tabIndex={-1}><Icon size={21} />{existingId ? baseline.name : `새 ${PLAN_LABELS[kind]}`}</h2></div>{existingId && <button className="btn btn-ghost" disabled={busy} onClick={reload}><RefreshCw size={14} />최신 정보</button>}</div>
    {existingId && !item && <div className="issue-form-error" role="alert">이 항목이 현재 작업공간에 없습니다. 작성 내용은 유지됩니다. 최신 정보를 확인하세요.</div>}{remoteChanged && hasUnsaved && <div className="issue-form-error" role="alert">다른 작업자가 계획을 변경했습니다. 작성 중인 내용은 버전 {version} 기준으로 유지됩니다.</div>}
    {requiresCycleCompletion && <div className="cycle-completion-launch">
      <button ref={completionButton} className="btn btn-primary" type="button" disabled={busy || hasUnsaved || remoteChanged}
        onClick={startCompletion}><Check size={15} />사이클 완료</button>
      {hasUnsaved && <p>계획 정보와 업무 연결 변경을 먼저 저장하거나 초기화해 주세요.</p>}
    </div>}
    {completionCycle && <CycleCompletionPanel cycle={completionCycle} plans={data.planningItems ?? []} actorId={actorId}
      refresh={refresh} notify={notify} onClose={closeCompletion} onSaved={acceptCycle} restoreFocus={restoreCompletionFocus} />}
    {kind === 'cycle' && item && <CycleProgress cycle={{ ...item, version: Math.max(item.version, version) }}
      projectId={projectId} actorId={actorId} data={data} openIssue={openIssue} />}
    {kind === 'cycle' && <CycleCompletionHistory projectId={projectId} actorId={actorId} issues={data.issues} openIssue={openIssue}
      cycle={item && { id: item.id, version: Math.max(item.version, version) }} />}
    <form onSubmit={save} aria-label="계획 정보 편집"><fieldset disabled={busy || selectedAssignments.length > 0}><label className="issue-form-label">이름<input className="field planning-name-input" aria-label="계획 이름" value={draft.name} onChange={event => update('name', event.target.value)} placeholder={`${PLAN_LABELS[kind]} 이름`} required maxLength={120} /></label><label className="issue-form-label">설명<textarea className="field" aria-label="계획 설명" value={draft.description} onChange={event => update('description', event.target.value)} rows={3} placeholder="목표와 범위를 간단히 적어주세요." /></label><div className="planning-form-grid"><label className="issue-form-label">상태<select className="field" aria-label="계획 상태" value={draft.status} onChange={event => {
      const value = event.target.value as PlanningStatus;
      if (value !== 'completed' || !requiresCycleCompletion) update('status', value);
    }}>{Object.entries(STATE_LABELS).map(([value, label]) => <option key={value} value={value} disabled={value === 'completed' && requiresCycleCompletion}>{label}</option>)}</select></label><label className="issue-form-label">책임자<select className="field" aria-label="계획 책임자" value={draft.ownerId || ''} onChange={event => update('ownerId', event.target.value || null)}><option value="">미지정</option>{data.users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label><label className="issue-form-label">시작일<input className="field" type="date" aria-label="계획 시작일" value={draft.startDate || ''} onChange={event => update('startDate', event.target.value || null)} /></label><label className="issue-form-label">종료일<input className="field" type="date" aria-label="계획 종료일" value={draft.endDate || ''} onChange={event => update('endDate', event.target.value || null)} /></label><label className="issue-form-label">목표일<input className="field" type="date" aria-label="계획 목표일" value={draft.targetDate || ''} onChange={event => update('targetDate', event.target.value || null)} /></label></div>{error && <div className="issue-form-error" role="alert">{error} 작성 내용은 유지됩니다.</div>}<div className="planning-save-row"><span>{selectedAssignments.length ? '업무 연결 변경을 적용하거나 초기화한 뒤 계획 정보를 수정하세요.' : '계획 상태와 개별 업무 상태는 별도로 관리됩니다.'}</span><button className="btn btn-primary" type="submit" disabled={busy || (existingId !== null && !dirty)}><Save size={15} />{busy ? '처리 중…' : existingId ? '계획 저장' : '계획 만들기'}</button></div></fieldset></form>
    {existingId && <><div className="planning-issue-summary"><div><strong>{stats.percent}<small>%</small></strong><span>연결 업무 {linked.length}개 · 완료 {stats.done}/{stats.total}</span></div><div className="planning-progress-track"><i style={{ width: `${stats.percent}%` }} /></div><p>취소를 제외한 연결 업무 개수 기준입니다.</p></div><section className="planning-membership"><div className="planning-membership-heading"><h3>연결된 업무 <span>{linked.length}</span></h3><button className="btn btn-ghost" onClick={() => setShowCandidates(!showCandidates)} disabled={busy}><Plus size={14} />{showCandidates ? '연결된 업무만' : '업무 연결·해제'}</button></div><div className="planning-search"><Search size={14} /><input aria-label="연결할 업무 검색" placeholder="업무 번호 또는 제목 검색" value={issueQuery} onChange={event => setIssueQuery(event.target.value)} /></div>{dirty && <p className="planning-membership-note">계획 정보를 먼저 저장한 뒤 업무를 연결해 주세요.</p>}{draft.status === 'archived' && <p className="planning-membership-note">보관된 항목에는 새 업무를 연결할 수 없습니다. 기존 연결은 해제할 수 있습니다.</p>}<div className="planning-membership-list">{candidates.map(issue => {
      const assigned = issue[field] === existingId;
      const assignment = assignments[issue.id];
      const meta = statusMeta(data, issue.projectId, issue.status);
      const currentPlan = (data.planningItems ?? []).find(plan => plan.id === issue[field]);
      const start = isCalendarDate(issue.startDate) ? issue.startDate : null;
      const end = isCalendarDate(issue.endDate) ? issue.endDate : null;
      const scheduleAction = start && end ? '간트에서 일정 보기' : '간트에서 날짜 입력';
      return <div className="planning-membership-row" key={issue.id}>
        <input type="checkbox" aria-label={`${issue.key} 계획 연결`} checked={assignment?.assigned ?? assigned}
          disabled={busy || dirty || (draft.status === 'archived' && !assigned)} onChange={event => toggle(issue, event.target.checked)} />
        <div className="planning-membership-work">
          <button className="planning-linked-issue" type="button" onClick={() => openIssue(issue.id)}>
            <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong>
            {!assigned && currentPlan && <small>현재 {currentPlan.name}</small>}
            {assignment && assignment.expectedVersion !== issue.version && <small className="planning-conflict-text">다른 변경 있음 · 선택 초기화 후 확인</small>}
          </button>
          {assigned && <div className="planning-issue-schedule">
            <span>시작일 {start ? <time dateTime={start}>{dateLabel(start)}</time> : '미정'}</span>
            <span>종료일 {end ? <time dateTime={end}>{dateLabel(end)}</time> : '미정'}</span>
            {onOpenIssueSchedule && <button className="btn btn-ghost" type="button" aria-label={`${issue.key} ${scheduleAction}`}
              onClick={() => onOpenIssueSchedule(issue.id, existingId)}><CalendarRange size={13} aria-hidden="true" />{scheduleAction}</button>}
          </div>}
        </div>
        <span className="planning-issue-status" style={{ color: meta.color }}>{meta.label}</span><ArrowRight size={13} aria-hidden="true" />
      </div>;
    })}{!candidates.length && <div className="planning-membership-empty">{showCandidates ? '조건에 맞는 업무가 없습니다.' : '아직 연결된 업무가 없습니다. 업무 연결·해제에서 선택하세요.'}</div>}</div>{membershipError && <div className="issue-form-error" role="alert">{membershipError} 선택한 변경은 유지됩니다. 최신 상태를 확인하고 선택을 초기화해 주세요.</div>}{selectedAssignments.length > 0 && <div className="planning-assignment-actions"><span>{selectedAssignments.length}개 업무 연결 변경</span><button className="btn btn-ghost" disabled={busy} onClick={() => { setAssignments({}); setAssignmentVersion(null); setMembershipError(''); }}>선택 초기화</button><button className="btn btn-primary" disabled={busy || dirty} onClick={applyAssignments}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}연결 변경 적용</button></div>}</section><div className="planning-danger-zone">{linked.length > 0 && <p>연결된 업무가 있어 삭제할 수 없습니다. 더 사용하지 않는 항목은 보관해 주세요.</p>}<div>{draft.status !== 'archived' && <button className="btn btn-ghost" disabled={busy || selectedAssignments.length > 0} onClick={() => update('status', 'archived')}><Archive size={14} />보관 상태로 변경</button>}<button className="btn btn-ghost" disabled={busy || linked.length > 0 || selectedAssignments.length > 0} title={linked.length ? '연결된 업무를 먼저 해제하세요.' : '계획 항목 삭제'} onClick={deleteItem}><Trash2 size={14} />계획 삭제</button></div></div></>}
  </section>;
}
