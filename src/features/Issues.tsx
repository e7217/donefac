'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Bug, Circle, CircleDot, Columns3, Filter, Layers3, List, Plus, Search, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type FeatureProps, type Issue, type IssueFieldFilter, type IssueStatus, type SavedViewState } from '../../shared/types';
import { afterAcceptedNavigation } from '../lib/navigation';
import { dateLabel, patch, post } from '../lib/api';
import { allowedNextStatuses, projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS, statusMeta } from '../../shared/workflow-helpers';
import { issueTypeMeta, projectIssueSchema, projectIssueTypes, requiredFieldLabels } from '../../shared/issue-schema';
import { CustomFields, CustomFieldSummary, initialIssueType, IssueTypeName, IssueTypeSelect } from './CustomFields';
import { PlanningSelect } from './PlanningSelectors';
import { SavedViews } from './SavedViews';
import { IssueFieldFilters } from './IssueFieldFilters';
import { createIssueViewMatcher } from '../../shared/issue-view';
import { errorMessage } from './schedule-utils';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import './issues.css';

const isAll = (id: string) => !id || id === 'all';
export function IssueTypeIcon({ type, size = 15, data, projectId }: { type: string; size?: number; data?: FeatureProps['data']; projectId?: string }) {
  const meta = data && projectId ? issueTypeMeta(data, projectId, type) : null;
  return type === '버그' ? <Bug size={size} color={meta?.color || '#db705e'} aria-label={meta?.name} /> : type === '큰틀' ? <Layers3 size={size} color={meta?.color || '#9173cd'} aria-label={meta?.name} /> : type === '개선' ? <ArrowUpRight size={size} color={meta?.color || '#ca9e4a'} aria-label={meta?.name} /> : <CircleDot size={size} color={meta?.color || '#578ca9'} aria-label={meta?.name} />;
}
export function StatusDot({ color }: { color: string }) { return <span className="issue-status-dot" style={{ background: color }} />; }
function PriorityIcon({ value }: { value: keyof typeof PRIORITY }) { return value === 'urgent' || value === 'high' ? <ArrowUp size={14} className={value === 'urgent' ? 'issue-priority-urgent' : 'issue-priority-high'} /> : value === 'low' ? <ArrowDown size={14} className="muted" /> : <span className="issue-priority-medium">=</span>; }

export function Issues(props: FeatureProps) {
  const { data, projectId, refresh, notify, openIssue } = props;
  const [view, setView] = useState<'list' | 'board'>('list');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [type, setType] = useState('all');
  const [projectFieldFilters, setProjectFieldFilters] = useState(() => new Map<string, IssueFieldFilter>());
  const [fieldEditorEpoch, setFieldEditorEpoch] = useState(0);
  const fieldFilter = projectFieldFilters.get(projectId);
  const schema = useMemo(() => projectIssueSchema({issueSchemas:data.issueSchemas}, projectId), [data.issueSchemas, projectId]);
  const filters = useMemo(() => ({
    query,status,assigneeId:assignee,type,...(fieldFilter ? {fieldFilter} : {}),
  }), [query,status,assignee,type,fieldFilter]);
  const matchesIssue = useMemo(() => createIssueViewMatcher(filters, {
    issueSchemas:data.issueSchemas,users:data.users,
  }, schema), [filters,data.issueSchemas,data.users,schema]);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo');
  const [busy, setBusy] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<string | null>(null);
  const statuses = projectStatuses(data, projectId);
  const workflow = projectWorkflow(data, projectId);
  const projectIssues = useMemo(() => data.issues.filter(i => isAll(projectId) || i.projectId === projectId), [data.issues, projectId]);
  const issues = projectIssues.filter(matchesIssue);
  const issueTypes = isAll(projectId) ? [...new Map(data.projects.flatMap(project => projectIssueTypes(data, project.id, { includeArchived: true })).map(item => [item.id, item])).values()] : projectIssueTypes(data, projectId, { includeArchived: true });
  const beginCreate = (nextStatus: string) => { if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return; setCreateStatus(nextStatus); setCreating(true); };
  const activeFilters = status !== 'all' || assignee !== 'all' || type !== 'all' || query !== '' || Boolean(fieldFilter);
  function updateFieldFilter(value: IssueFieldFilter | undefined) {
    setProjectFieldFilters(previous => {
      const next = new Map(previous);
      if (value) next.set(projectId, value);
      else next.delete(projectId);
      return next;
    });
  }
  function applySavedView(value: SavedViewState) {
    setView(value.layout);
    setQuery(value.filters.query);
    setStatus(value.filters.status);
    setAssignee(value.filters.assigneeId);
    setType(value.filters.type);
    updateFieldFilter(value.filters.fieldFilter);
    setFieldEditorEpoch(epoch => epoch + 1);
  }
  function clearFilters() {
    if (!window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) return;
    setQuery(''); setStatus('all'); setAssignee('all'); setType('all');
    updateFieldFilter(undefined);
    setFieldEditorEpoch(epoch => epoch + 1);
  }
  async function changeStatus(issue: Issue, next: IssueStatus) {
    if (issue.status === next || busy) return;
    if (!allowedNextStatuses(data, issue).some(value => value.id === next)) { notify('이 업무 유형에 허용되지 않은 상태 전이입니다.', 'error'); return; }
    setBusy(issue.id);
    try { await patch(`/issues/${issue.id}`, { expectedVersion: issue.version, status: next }); await refresh(); notify(`${issue.key} · ${statusMeta(data, issue.projectId, next).label}(으)로 변경했습니다.`); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { setBusy(null); }
  }
  return <div className="issues-feature">
    <div className="feature-heading"><div><div className="feature-eyebrow">WORK MANAGEMENT</div><h1>업무</h1><p>해야 할 일을 명확하게, 진행 상황을 한눈에.</p></div><button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={16} /> 업무 만들기</button></div>
    <div className="issue-toolbar">
      <div className="issue-view-switch" aria-label="업무 보기"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={16} /> 목록</button><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={16} /> 보드</button></div>
      <div className="issue-search"><Search size={15} /><input aria-label="업무 검색" placeholder="제목, 번호, 속성 검색" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="issue-filter-select"><Filter size={14} /><select aria-label="상태 필터" value={status} onChange={e => setStatus(e.target.value)}><option value="all">모든 상태</option>{status !== 'all' && !statuses.some(value => value.id === status) && <option value={status}>{status} (저장된 조건)</option>}{statuses.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></div>
      <select className="issue-filter" aria-label="담당자 필터" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="all">모든 담당자</option><option value="none">미지정</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <select className="issue-filter" aria-label="유형 필터" value={type} onChange={e => setType(e.target.value)}><option value="all">모든 유형</option>{type !== 'all' && !issueTypes.some(item => item.id === type) && <option value={type}>{type} (저장된 조건)</option>}{issueTypes.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (보관됨)' : ''}</option>)}</select>
      {activeFilters && <button className="btn btn-ghost issue-clear-filter" onClick={clearFilters}><X size={14} /> 초기화</button>}
    </div>
    {!isAll(projectId) && (schema.fields.length > 0 || fieldFilter) && <IssueFieldFilters
      key={`${projectId}:${fieldEditorEpoch}`} schema={schema} users={data.users} value={fieldFilter}
      onApply={updateFieldFilter} notify={notify}
    />}
    <SavedViews projectId={projectId} actorId={props.actorId}
      current={{layout:view,filters}}
      onApply={applySavedView} notify={notify} />
    <div className="issue-results"><span>{activeFilters ? `${projectIssues.length}개 중 ` : ''}<strong>{issues.length}</strong>개의 업무</span><span className="muted">{view === 'board' ? '카드를 끌어 상태 변경 · 카드에서 업무 상세 확인' : '업무를 선택해 상세 내용을 확인하세요'}</span></div>
    {view === 'list' ? <div className="issue-table-scroll"><table className="issue-table"><thead><tr><th className="issue-title-column">업무</th><th>상태</th><th>우선순위</th><th>담당자</th><th>종료일</th><th>라벨</th></tr></thead><tbody>{issues.map(issue => {
      const user = data.users.find(u => u.id === issue.assigneeId);
      return <tr key={issue.id}><td><button className="issue-title-button" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><span className="issue-title-text">{issue.title}</span><IssueTypeName data={data} issue={issue} />{issue.parentId && <span className="issue-child-mark">하위</span>}</button><CustomFieldSummary data={data} issue={issue} limit={2} /></td><td><span className="issue-status-select"><StatusDot color={statusMeta(data, issue.projectId, issue.status).color} /><select aria-label={`${issue.key} 상태`} value={issue.status} disabled={busy === issue.id} onChange={e => changeStatus(issue, e.target.value as IssueStatus)}>{allowedNextStatuses(data, issue).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></span></td><td><span className="issue-priority"><PriorityIcon value={issue.priority} />{PRIORITY[issue.priority]}</span></td><td>{user ? <span className="issue-assignee"><span className="issue-avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</span> : <span className="muted">미지정</span>}</td><td className="issue-date-cell">{dateLabel(issue.endDate || issue.dueDate)}</td><td><div className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}{issue.labels.length > 2 && <span className="muted">+{issue.labels.length - 2}</span>}</div></td></tr>;
    })}</tbody></table>{issues.length === 0 && <div className="issue-empty"><Circle size={28} /><h3>{activeFilters ? '조건에 맞는 업무가 없습니다' : '첫 업무를 만들어 보세요'}</h3><p>{activeFilters ? '검색어나 필터를 변경해 보세요.' : '계획과 실행의 시작을 이곳에 기록하세요.'}</p><button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={15} /> 업무 만들기</button></div>}</div> : <div className="issue-board">{statuses.map(state => { const key = state.id;
      const column = issues.filter(i => i.status === key);
      return <section key={key} className={`issue-board-column ${dropStatus === key ? 'is-drag-over' : ''}`} onDragOver={event => { event.preventDefault(); setDropStatus(key); }} onDragLeave={() => setDropStatus(null)} onDrop={event => { event.preventDefault(); setDropStatus(null); const issue = data.issues.find(i => i.id === event.dataTransfer.getData('text/issue-id')); if (issue) void changeStatus(issue, key); }}><div className="issue-board-heading"><StatusDot color={state.color} /><strong>{state.label}</strong><span>{column.length}</span><button title={`${state.label} 업무 추가`} aria-label={`${state.label} 업무 추가`} onClick={() => { beginCreate(key); }}><Plus size={15} /></button></div>{column.map(issue => {
        const user = data.users.find(u => u.id === issue.assigneeId);
        return <button className={`issue-board-card ${busy === issue.id ? 'is-saving' : ''}`} key={issue.id} draggable onDragStart={event => { event.dataTransfer.setData('text/issue-id', issue.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropStatus(null)} onClick={() => openIssue(issue.id)}><span className="issue-card-key"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issue.key}<IssueTypeName data={data} issue={issue} /></span><strong>{issue.title}</strong><CustomFieldSummary data={data} issue={issue} /><span className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}</span><span className="issue-card-footer"><span className="issue-priority"><PriorityIcon value={issue.priority} /><span>{dateLabel(issue.endDate)}</span></span>{user && <span className="issue-avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>}</span></button>;
      })}{column.length === 0 && <div className="issue-column-empty">이 상태의 업무가 없습니다</div>}</section>;
    })}</div>}
    {creating && <NewIssueModal {...props} initialStatus={createStatus} onClose={() => setCreating(false)} />}
  </div>;
}

function NewIssueModal({ data, projectId, initialStatus, onClose, refresh, notify, openIssue }: FeatureProps & { initialStatus: IssueStatus; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState(isAll(projectId) ? data.projects[0]?.id || '' : projectId);
  const [selectedType, setSelectedType] = useState(() => initialIssueType(data, selectedProject));
  const [selectedStatus, setSelectedStatus] = useState(() => projectStatuses(data, selectedProject).some(status => status.id === initialStatus) ? initialStatus : projectWorkflow(data, selectedProject).initialStatusId);
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const dirtyRef = useRef(false), pendingRef = useRef(false);
  const values = valuesByProject[selectedProject] || {};
  const states = projectStatuses(data, selectedProject);
  const required = requiredFieldsFor(data, selectedProject, selectedType, selectedStatus);
  function close() { if (pendingRef.current) return false; if (dirtyRef.current && !window.confirm('작성 중인 새 업무를 버리고 닫을까요?')) return false; dirtyRef.current = false; onClose(); return true; }
  useEffect(() => {
    const guard = (event: Event) => { if (event.defaultPrevented) return; if (pendingRef.current) { event.preventDefault(); notify('업무 생성이 끝난 뒤 이동해 주세요.', 'error'); } else if (dirtyRef.current && !window.confirm('작성 중인 새 업무를 버리고 이동할까요?')) event.preventDefault(); else afterAcceptedNavigation(event, () => { dirtyRef.current = false; onClose(); }); };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || pendingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify, onClose]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pendingRef.current) return; const form = new FormData(event.currentTarget); pendingRef.current = true; setBusy(true); setError('');
    try {
      const issue = await post<Issue>('/issues', { projectId: selectedProject, title: String(form.get('title') || '').trim(), description: form.get('description'), type: selectedType, status: selectedStatus, priority: form.get('priority'), assigneeId: form.get('assigneeId') || null, startDate: form.get('startDate') || null, endDate: form.get('endDate') || null, dueDate: form.get('dueDate') || null, estimate: form.get('estimate') ? Number(form.get('estimate')) : null, plannedEffortMinutes: form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null, labels: String(form.get('labels') || '').split(',').map(value => value.trim()).filter(Boolean), parentId: form.get('parentId') || null, collaboratorIds: form.getAll('collaboratorIds'), cycleId: form.get('cycleId') || null, moduleId: form.get('moduleId') || null, releaseId: form.get('releaseId') || null, customFields: values });
      dirtyRef.current = false; await refresh(); notify('새 업무를 만들었습니다.'); pendingRef.current = false; onClose(); openIssue(issue.id);
    } catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setBusy(false); }
  }
  return <div className="issue-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className="issue-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-issue-title"><form onSubmit={submit} onChange={() => { dirtyRef.current = true; }}><header><div><span className="feature-eyebrow">NEW ISSUE</span><h2 id="new-issue-title">새 업무 만들기</h2></div><button className="issue-icon-button" type="button" disabled={busy} onClick={close} aria-label="닫기"><X size={19} /></button></header><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="issue-create-fields"><label className="issue-form-label">프로젝트<select name="projectId" className="field" value={selectedProject} onChange={event => { const next = event.target.value; setSelectedProject(next); setSelectedType(initialIssueType(data, next)); setSelectedStatus(projectWorkflow(data, next).initialStatusId); }} required>{data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="issue-form-label">업무 제목<input autoFocus className="field issue-title-input" name="title" placeholder="무엇을 해야 하나요?" maxLength={300} required /></label><label className="issue-form-label">설명<textarea className="field" name="description" placeholder="배경, 목표, 완료 조건을 적어주세요." rows={4} /></label><div className="issue-form-grid"><label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={selectedType} onChange={setSelectedType} name="type" /></label><label className="issue-form-label">상태<select name="status" aria-label="새 업무 상태" className="field" value={selectedStatus} onChange={event => setSelectedStatus(event.target.value)}>{states.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label><label className="issue-form-label">우선순위<select name="priority" className="field" defaultValue="medium">{Object.entries(PRIORITY).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label className="issue-form-label">담당자<select className="field" name="assigneeId"><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="issue-form-label">시작일<input type="date" name="startDate" className="field" /></label><label className="issue-form-label">종료일<input type="date" name="endDate" className="field" /></label></div><CustomFields data={data} projectId={selectedProject} issueType={selectedType} values={values} onChange={next => { dirtyRef.current = true; setValuesByProject(previous => ({ ...previous, [selectedProject]: next })); }} disabled={busy} requiredFields={required} />{required.length > 0 && <p className="issue-section-empty">필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}<details open={required.some(field => ['dueDate','estimate','labels','parentId','collaboratorIds','cycle','module','release'].includes(field))}><summary className="issue-section-caption">추가 속성</summary><div className="issue-form-grid"><label className="issue-form-label">목표 마감일<input className="field" type="date" name="dueDate" /></label><label className="issue-form-label">예상 소요 (포인트)<input className="field" type="number" name="estimate" min="0" step="0.5" /></label><label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} /></label><label className="issue-form-label">라벨<input className="field" name="labels" placeholder="쉼표로 구분" /></label><label className="issue-form-label">상위 업무<select className="field" name="parentId" key={selectedProject}><option value="">없음</option>{data.issues.filter(issue => issue.projectId === selectedProject).map(issue => <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select></label>{(['cycle','module','release'] as const).map(field => <label className="issue-form-label" key={field}>{REQUIRED_FIELD_LABELS[field]}<PlanningSelect data={data} projectId={selectedProject} kind={field} name={`${field}Id`} /></label>)}<label className="issue-form-label">참여자<select className="field" name="collaboratorIds" multiple>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label></div></details>{error && <div className="issue-form-error" role="alert">{error}</div>}</div></fieldset><footer><span className="muted">상세 속성은 생성 후에도 수정할 수 있어요.</span><button className="btn btn-ghost" type="button" disabled={busy} onClick={close}>취소</button><button className="btn btn-primary" type="submit" disabled={busy || !data.projects.length || !selectedType}>{busy ? '만드는 중…' : <><Plus size={16} /> 업무 만들기</>}</button></footer></form></section></div>;
}
