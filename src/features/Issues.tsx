'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, ArrowUpRight, Bug, Circle, CircleDot, Columns3, Filter, Layers3, List, Plus, Search, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type FeatureProps, type Issue, type IssueFieldFilter, type IssueOrderMove, type IssueStatus, type SavedViewState } from '../../shared/types';
import { afterAcceptedNavigation } from '../lib/navigation';
import { ApiError, dateLabel, patch, post } from '../lib/api';
import { allowedNextStatuses, projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS, statusMeta } from '../../shared/workflow-helpers';
import { issueTypeMeta, projectIssueSchema, projectIssueTypes, requiredFieldLabels } from '../../shared/issue-schema';
import { CustomFields, CustomFieldSummary, initialIssueType, IssueTypeName, IssueTypeSelect } from './CustomFields';
import { PlanningSelect } from './PlanningSelectors';
import { SavedViews } from './SavedViews';
import { IssueFieldFilters } from './IssueFieldFilters';
import { createIssueViewMatcher, orderProjectIssues } from '../../shared/issue-view';
import { errorMessage } from './schedule-utils';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import './issues.css';
import './issue-order.css';

const isAll = (id: string) => !id || id === 'all';
const issueDragType = 'text/issue-id';
type IssuePlacement = Pick<IssueOrderMove, 'anchorId' | 'position'>;
type BoardDrop = IssuePlacement & { status: IssueStatus };
type BoardDrag = { issue: Issue; projectId: string; orderVersion?: string };
type OrderNotice = { projectId: string; text: string; error?: boolean; needsRefresh?: boolean };

function IssueOrderControls({ issue, previous, next, busy, move }: {
  issue: Issue; previous?: Issue; next?: Issue; busy: boolean;
  move: (issue: Issue, placement: IssuePlacement, opener: HTMLButtonElement) => void;
}) {
  return <div className="issue-order-controls" role="group" aria-label={`${issue.key} 업무 순서`}>
    <button className="btn btn-ghost" type="button" aria-label={`${issue.key} 위로 이동`} title="위로 이동"
      aria-disabled={busy || !previous} onClick={event => { if (!busy && previous) move(issue, { anchorId: previous.id, position: 'before' }, event.currentTarget); }}><ArrowUp size={15} aria-hidden="true" /></button>
    <button className="btn btn-ghost" type="button" aria-label={`${issue.key} 아래로 이동`} title="아래로 이동"
      aria-disabled={busy || !next} onClick={event => { if (!busy && next) move(issue, { anchorId: next.id, position: 'after' }, event.currentTarget); }}><ArrowDown size={15} aria-hidden="true" /></button>
  </div>;
}

function boardPlacement(event: DragEvent<HTMLElement>, column: Issue[], sourceId: string | undefined): IssuePlacement {
  const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-order-card]') : null;
  if (card?.dataset.orderCard) {
    const { top, height } = card.getBoundingClientRect();
    return { anchorId: card.dataset.orderCard, position: event.clientY < top + height / 2 ? 'before' : 'after' };
  }
  const last = column[column.length - 1];
  const end = last?.id === sourceId ? column[column.length - 2] : last;
  return { anchorId: end?.id ?? null, position: 'after' };
}

function keepsVisiblePosition(issue: Issue, column: Issue[], placement: IssuePlacement) {
  const currentIndex = column.findIndex(item => item.id === issue.id);
  if (currentIndex < 0) return false;
  if (placement.anchorId === issue.id) return true;
  if (placement.anchorId === null) return currentIndex === (placement.position === 'before' ? 0 : column.length - 1);

  const anchorIndex = column.findIndex(item => item.id === placement.anchorId);
  if (anchorIndex < 0) return false;
  const destinationIndex = anchorIndex - Number(currentIndex < anchorIndex) + Number(placement.position === 'after');
  return destinationIndex === currentIndex;
}
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
  const [orderEditProject, setOrderEditProject] = useState<string | null>(null);
  const [orderNotice, setOrderNotice] = useState<OrderNotice | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardDrop | null>(null);
  const pendingMutation = useRef(false);
  const drag = useRef<BoardDrag | null>(null);
  const order = isAll(projectId) ? undefined : data.issueOrders?.find(value => value.projectId === projectId);
  const ordering = Boolean(order) && orderEditProject === projectId;
  const notice = orderNotice?.projectId === projectId ? orderNotice : null;
  const statuses = projectStatuses(data, projectId);
  const workflow = projectWorkflow(data, projectId);
  const projectIssues = useMemo(() => orderProjectIssues(data.issues.filter(i => isAll(projectId) || i.projectId === projectId), order), [data.issues, projectId, order]);
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
    if (issue.status === next || pendingMutation.current) return;
    if (!allowedNextStatuses(data, issue).some(value => value.id === next)) { notify('이 업무 유형에 허용되지 않은 상태 전이입니다.', 'error'); return; }
    pendingMutation.current = true;
    setBusy(issue.id);
    try { await patch(`/issues/${issue.id}`, { expectedVersion: issue.version, status: next }); await refresh(); notify(`${issue.key} · ${statusMeta(data, issue.projectId, next).label}(으)로 변경했습니다.`); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { pendingMutation.current = false; setBusy(null); }
  }

  async function moveIssue(issue: Issue, placement: IssuePlacement, options: { status?: IssueStatus; version?: string; opener?: HTMLButtonElement } = {}) {
    if (!order || issue.projectId !== projectId || placement.anchorId === issue.id || notice?.needsRefresh || pendingMutation.current) return;
    const nextStatus = options.status !== issue.status ? options.status : undefined;
    if (nextStatus !== undefined && !allowedNextStatuses(data, issue).some(value => value.id === nextStatus)) {
      setOrderNotice({ projectId, error: true, text: '이 업무 유형에 허용되지 않은 상태 전이입니다.' });
      return;
    }

    const opener = options.opener === document.activeElement ? options.opener : undefined;
    pendingMutation.current = true;
    setBusy(issue.id);
    setOrderNotice({ projectId, text: `${issue.key} 업무 순서를 저장 중입니다.` });
    let text = nextStatus === undefined ? `${issue.key} 업무 순서를 변경했습니다.` : `${issue.key} 업무 순서와 상태를 변경했습니다.`;
    let error = false;
    try {
      try {
        const move: IssueOrderMove = {
          issueId: issue.id, expectedVersion: options.version ?? order.version, expectedIssueVersion: issue.version,
          ...placement, ...(nextStatus === undefined ? {} : { status: nextStatus }),
        };
        await patch(`/projects/${encodeURIComponent(projectId)}/issue-order`, move);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status < 500 && cause.status !== 409 && cause.status !== 404) {
          setOrderNotice({ projectId, text: errorMessage(cause), error: true });
          return;
        }
        text = cause instanceof ApiError && cause.status < 500 ? errorMessage(cause) : '업무 순서 저장 응답을 확인하지 못했습니다.';
        error = true;
      }
      try {
        await refresh();
        setOrderNotice({ projectId, text: error ? `${text} 최신 업무 순서를 확인한 뒤 다시 이동하세요.` : text, error });
      } catch {
        setOrderNotice({ projectId, text: `${text} 최신 업무 순서를 불러오지 못했습니다.`, error: true, needsRefresh: true });
      }
    } finally {
      pendingMutation.current = false;
      setBusy(null);
      if (opener) requestAnimationFrame(() => {
        if (opener.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true });
      });
    }
  }

  async function refreshOrder() {
    if (pendingMutation.current || !notice?.needsRefresh) return;
    pendingMutation.current = true;
    setBusy('issue-order-refresh');
    try {
      await refresh();
      setOrderNotice({ projectId, text: '최신 업무 순서를 불러왔습니다.' });
    } catch {
      setOrderNotice({ projectId, text: '최신 업무 순서를 불러오지 못했습니다.', error: true, needsRefresh: true });
    } finally {
      pendingMutation.current = false;
      setBusy(null);
    }
  }

  function startBoardDrag(event: DragEvent<HTMLElement>, issue: Issue) {
    if (pendingMutation.current || notice?.needsRefresh) { event.preventDefault(); return; }
    event.dataTransfer.setData(issueDragType, issue.id);
    event.dataTransfer.effectAllowed = 'move';
    drag.current = { issue, projectId, orderVersion: order?.version };
  }

  function endBoardDrag() {
    drag.current = null;
    setDropTarget(null);
  }

  function boardDragOver(event: DragEvent<HTMLElement>, status: IssueStatus, column: Issue[]) {
    if (!event.dataTransfer.types.includes(issueDragType) || pendingMutation.current || notice?.needsRefresh) return;
    if (drag.current && drag.current.projectId !== projectId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const placement = order ? boardPlacement(event, column, drag.current?.issue.id) : { anchorId: null, position: 'after' } as const;
    const target = { ...placement, status };
    setDropTarget(current => current?.status === status && current.anchorId === target.anchorId && current.position === target.position ? current : target);
  }

  function dropOnBoard(event: DragEvent<HTMLElement>, status: IssueStatus, column: Issue[]) {
    const id = event.dataTransfer.getData(issueDragType);
    const source = drag.current;
    endBoardDrag();
    if (!id || source && (source.projectId !== projectId || source.issue.id !== id)) return;
    event.preventDefault();
    const issue = source?.issue ?? projectIssues.find(value => value.id === id);
    if (!issue) return;
    if (!order) { void changeStatus(issue, status); return; }
    const placement = boardPlacement(event, column, issue.id);
    if (issue.status === status && keepsVisiblePosition(issue, column, placement)) return;
    void moveIssue(issue, placement, { status, version: source?.orderVersion });
  }

  const controls = (issue: Issue, visible: Issue[], index: number) => ordering && <IssueOrderControls issue={issue}
    previous={visible[index - 1]} next={visible[index + 1]} busy={Boolean(busy || notice?.needsRefresh)}
    move={(source, placement, opener) => void moveIssue(source, placement, { opener })} />;

  return <div className="issues-feature">
    <div className="feature-heading"><div><div className="feature-eyebrow">WORK MANAGEMENT</div><h1>업무</h1><p>해야 할 일을 명확하게, 진행 상황을 한눈에.</p></div><button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={16} /> 업무 만들기</button></div>
    <div className="issue-toolbar">
      <div className="issue-view-switch" aria-label="업무 보기"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={16} /> 목록</button><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={16} /> 보드</button></div>
      <div className="issue-search"><Search size={15} /><input aria-label="업무 검색" placeholder="제목, 번호, 속성 검색" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="issue-filter-select"><Filter size={14} /><select aria-label="상태 필터" value={status} onChange={e => setStatus(e.target.value)}><option value="all">모든 상태</option>{status !== 'all' && !statuses.some(value => value.id === status) && <option value={status}>{status} (저장된 조건)</option>}{statuses.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></div>
      <select className="issue-filter" aria-label="담당자 필터" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="all">모든 담당자</option><option value="none">미지정</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <select className="issue-filter" aria-label="유형 필터" value={type} onChange={e => setType(e.target.value)}><option value="all">모든 유형</option>{type !== 'all' && !issueTypes.some(item => item.id === type) && <option value={type}>{type} (저장된 조건)</option>}{issueTypes.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (보관됨)' : ''}</option>)}</select>
      {order && <button type="button" className="btn btn-ghost issue-order-toggle" aria-pressed={ordering} onClick={() => setOrderEditProject(ordering ? null : projectId)}><ArrowDownUp size={15} aria-hidden="true" /> 순서 편집</button>}
      {activeFilters && <button className="btn btn-ghost issue-clear-filter" onClick={clearFilters}><X size={14} /> 초기화</button>}
    </div>
    {!isAll(projectId) && (schema.fields.length > 0 || fieldFilter) && <IssueFieldFilters
      key={`${projectId}:${fieldEditorEpoch}`} schema={schema} users={data.users} value={fieldFilter}
      onApply={updateFieldFilter} notify={notify}
    />}
    <SavedViews projectId={projectId} actorId={props.actorId}
      current={{layout:view,filters}}
      onApply={applySavedView} notify={notify} />
    <div className="issue-results"><span>{activeFilters ? `${projectIssues.length}개 중 ` : ''}<strong>{issues.length}</strong>개의 업무</span><span className="muted">{view === 'board' ? order ? '카드를 끌어 순서와 상태 변경' : '카드를 끌어 상태 변경' : '업무를 선택해 상세 내용을 확인하세요'}</span></div>
    {order && <div className={notice ? 'issue-order-feedback' : 'sr-only'}>
      <p className={notice?.error ? 'is-error' : ''} role="status" aria-label="업무 순서 상태">{notice?.text}</p>
      {notice?.needsRefresh && <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void refreshOrder()}>최신 업무 순서 불러오기</button>}
    </div>}
    {view === 'list' ? <div className="issue-table-scroll"><table className="issue-table"><thead><tr><th className="issue-title-column">업무</th><th>상태</th><th>우선순위</th><th>담당자</th><th>종료일</th><th>라벨</th></tr></thead><tbody>{issues.map((issue, index) => {
      const user = data.users.find(u => u.id === issue.assigneeId);
      return <tr key={issue.id} data-issue-id={issue.id}>
        <td><button className="issue-title-button" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><span className="issue-title-text">{issue.title}</span><IssueTypeName data={data} issue={issue} />{issue.parentId && <span className="issue-child-mark">하위</span>}</button>
          <CustomFieldSummary data={data} issue={issue} limit={2} />{controls(issue, issues, index)}</td>
        <td><span className="issue-status-select"><StatusDot color={statusMeta(data, issue.projectId, issue.status).color} /><select aria-label={`${issue.key} 상태`} value={issue.status} disabled={Boolean(busy)} onChange={e => changeStatus(issue, e.target.value as IssueStatus)}>{allowedNextStatuses(data, issue).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></span></td>
        <td><span className="issue-priority"><PriorityIcon value={issue.priority} />{PRIORITY[issue.priority]}</span></td>
        <td>{user ? <span className="issue-assignee"><span className="issue-avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</span> : <span className="muted">미지정</span>}</td>
        <td className="issue-date-cell">{dateLabel(issue.endDate || issue.dueDate)}</td>
        <td><div className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}{issue.labels.length > 2 && <span className="muted">+{issue.labels.length - 2}</span>}</div></td>
      </tr>;
    })}</tbody></table>{issues.length === 0 && <div className="issue-empty"><Circle size={28} /><h3>{activeFilters ? '조건에 맞는 업무가 없습니다' : '첫 업무를 만들어 보세요'}</h3><p>{activeFilters ? '검색어나 필터를 변경해 보세요.' : '계획과 실행의 시작을 이곳에 기록하세요.'}</p><button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={15} /> 업무 만들기</button></div>}</div> : <div className="issue-board">{statuses.map(state => {
      const key = state.id;
      const column = issues.filter(i => i.status === key);
      const target = dropTarget?.status === key ? dropTarget : null;
      return <section key={key} className={`issue-board-column ${target ? 'is-drag-over' : ''}`} data-status-id={key}
        onDragOver={event => boardDragOver(event, key, column)}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(current => current?.status === key ? null : current); }}
        onDrop={event => dropOnBoard(event, key, column)}>
        <div className="issue-board-heading"><StatusDot color={state.color} /><strong>{state.label}</strong><span>{column.length}</span><button title={`${state.label} 업무 추가`} aria-label={`${state.label} 업무 추가`} onClick={() => { beginCreate(key); }}><Plus size={15} /></button></div>
        {column.map((issue, index) => {
          const user = data.users.find(u => u.id === issue.assigneeId);
          return <div key={issue.id} className="issue-board-card-row" data-order-card={issue.id}>
            <button className={`issue-board-card ${busy === issue.id ? 'is-saving' : ''}`} data-issue-id={issue.id} data-order-drop={target?.anchorId === issue.id ? target.position : undefined}
              draggable={!busy && !notice?.needsRefresh} onDragStart={event => startBoardDrag(event, issue)} onDragEnd={endBoardDrag} onClick={() => openIssue(issue.id)}>
              <span className="issue-card-key"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issue.key}<IssueTypeName data={data} issue={issue} /></span><strong>{issue.title}</strong>
              <CustomFieldSummary data={data} issue={issue} /><span className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}</span>
              <span className="issue-card-footer"><span className="issue-priority"><PriorityIcon value={issue.priority} /><span>{dateLabel(issue.endDate)}</span></span>{user && <span className="issue-avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>}</span>
            </button>{controls(issue, column, index)}
          </div>;
        })}{column.length === 0 && <div className="issue-column-empty">이 상태의 업무가 없습니다</div>}
      </section>;
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
