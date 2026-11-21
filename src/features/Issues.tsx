'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowDownUp, ArrowUp, ArrowUpRight, Bug, Circle, CircleDot, ClipboardPaste, Columns3, Filter, Layers3, List, ListChecks, Plus, Search, X } from 'lucide-react';
import { ISSUE_BULK_EDIT_LIMIT, PRIORITY, type FeatureProps, type Issue, type IssueOrderMove, type IssueStatus, type IssueViewGitlabFilter, type SavedView, type SavedViewState } from '../../shared/types';
import { formatIssueCsv } from '../../shared/issue-csv';
import { ApiError, dateLabel, patch } from '../lib/api';
import { downloadText } from '../lib/download';
import { allowedNextStatuses, projectStatuses, projectWorkflow, statusMeta } from '../../shared/workflow-helpers';
import { issueTypeMeta, projectIssueSchema, projectIssueTypes } from '../../shared/issue-schema';
import { CustomFieldSummary, IssueTypeName } from './CustomFields';
import { IssuePasteDialog } from './IssuePasteDialog';
import { NewIssueModal } from './NewIssueModal';
import { SavedViews } from './SavedViews';
import { IssueFieldFilters } from './IssueFieldFilters';
import { IssuePlanningFilters } from './IssuePlanningFilters';
import { IssuePriorityLabelFilters } from './IssuePriorityLabelFilters';
import { buildIssueHierarchy, IssueHierarchyContext } from './IssueHierarchyContext';
import { IssueBulkEdit, IssueBulkSelectVisible, useIssueBulkEdit } from './IssueBulkEdit';
import { BoardCapacityDetails, BoardCapacityNote, BoardCapacitySummary, type BoardStatusCapacity } from './IssueBoardCapacity';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { GitlabActivityRefresh } from './GitlabActivity';
import { ISSUE_GITLAB_FILTER_LABELS, IssueGitlabSummary } from './IssueGitlabSummary';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view';
import { createIssueViewMatcher, orderProjectIssues } from '../../shared/issue-view';
import { errorMessage } from './schedule-utils';
import './issues.css';
import './issue-order.css';

const isAll = (id: string) => !id || id === 'all';
const issueDragType = 'text/issue-id';
type IssuePlacement = Pick<IssueOrderMove, 'anchorId' | 'position'>;
type BoardDrop = IssuePlacement & { status: IssueStatus };
type BoardDrag = { issue: Issue; projectId: string; orderVersion?: string };
type OrderNotice = { projectId: string; text: string; error?: boolean; needsRefresh?: boolean };
type ProjectFilters = Pick<SavedViewState['filters'], 'fieldFilter' | 'planning' | 'gitlab' | 'priorities' | 'labels'>;
const defaultView: SavedViewState = { layout: 'list', filters: { query: '', status: 'all', assigneeId: 'all', type: 'all' } };

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

export function Issues(props: FeatureProps & {
  savedViewId?: string | null;
  onChangeSavedView?: (id: string | null) => boolean;
  onOpenGantt?: (viewId: string) => void;
  onOpenBoardCapacityIssue?: (id: string, source: { opener: HTMLElement; fallback: HTMLElement | null }) => void;
}) {
  const { data, projectId, refresh, notify, openIssue, savedViewId = null, onChangeSavedView, onOpenGantt, onOpenBoardCapacityIssue } = props;
  const [loadedViews, setLoadedViews] = useState<{ projectId: string; snapshot: typeof data.savedViews; values: SavedView[] }>();
  const workspaceViews = useMemo(() => (data.savedViews ?? []).filter(view => view.projectId === projectId)
    .sort((left, right) => left.name.localeCompare(right.name, 'ko')), [data.savedViews, projectId]);
  const projectViews = loadedViews?.projectId === projectId && loadedViews.snapshot === data.savedViews ? loadedViews.values : workspaceViews;
  const selectedView = savedViewId ? projectViews.find(value => value.id === savedViewId) : undefined;
  const unavailableView = Boolean(savedViewId && !selectedView);
  const [appliedRouteView, setAppliedRouteView] = useState<{ projectId: string; id: string | null; applied: boolean }>();
  const [view, setView] = useState<'list' | 'board'>('list');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [type, setType] = useState('all');
  const [projectFilters, setProjectFilters] = useState(() => new Map<string, ProjectFilters>());
  const [filterEditorEpoch, setFilterEditorEpoch] = useState(0);
  const { fieldFilter, planning, gitlab, priorities, labels } = projectFilters.get(projectId) ?? {};
  const planningItems = data.planningItems ?? [];
  const schema = useMemo(() => projectIssueSchema({issueSchemas:data.issueSchemas}, projectId), [data.issueSchemas, projectId]);
  const filters = useMemo(() => ({
    query, status, assigneeId: assignee, type, ...(fieldFilter ? { fieldFilter } : {}), ...(planning ? { planning } : {}),
    ...(gitlab ? { gitlab } : {}), ...(priorities ? { priorities } : {}), ...(labels ? { labels } : {}),
  }), [query, status, assignee, type, fieldFilter, planning, gitlab, priorities, labels]);
  const gitlabSummary = useMemo(() => summarizeIssueGitlabLinks(data.gitlabLinks), [data.gitlabLinks]);
  const matchesIssue = useMemo(() => createIssueViewMatcher(filters, {
    issueSchemas:data.issueSchemas,users:data.users,gitlabLinks:data.gitlabLinks,
  }, schema), [filters,data.issueSchemas,data.users,data.gitlabLinks,schema]);
  const [creating, setCreating] = useState(false);
  const [pasteScope, setPasteScope] = useState<string | null>(null);
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo');
  const [busy, setBusy] = useState<string | null>(null);
  const [orderEditProject, setOrderEditProject] = useState<string | null>(null);
  const [orderNotice, setOrderNotice] = useState<OrderNotice | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardDrop | null>(null);
  const [capacitySelection, setCapacitySelection] = useState<{ projectId: string; statusId: string } | null>(null);
  const pendingMutation = useRef(false);
  const drag = useRef<BoardDrag | null>(null);
  const bulkToggle = useRef<HTMLButtonElement>(null);
  const boardCanvas = useRef<HTMLDivElement>(null);
  const capacityHeading = useRef<HTMLHeadingElement>(null);
  const capacityOpener = useRef<HTMLButtonElement | null>(null);
  const order = isAll(projectId) ? undefined : data.issueOrders?.find(value => value.projectId === projectId);
  const ordering = Boolean(order) && orderEditProject === projectId;
  const notice = orderNotice?.projectId === projectId ? orderNotice : null;
  const statuses = projectStatuses(data, projectId);
  const workflow = projectWorkflow(data, projectId);
  const projectIssues = useMemo(() => orderProjectIssues(data.issues.filter(i => isAll(projectId) || i.projectId === projectId), order), [data.issues, projectId, order]);
  const showGitlabRefresh = Boolean(gitlab) || projectIssues.some(issue => gitlabSummary.has(issue.id));
  const hierarchy = useMemo(() => buildIssueHierarchy(projectIssues), [projectIssues]);
  const issues = unavailableView ? [] : projectIssues.filter(matchesIssue);
  const bulk = useIssueBulkEdit(props, issues);
  const project = data.projects.find(value => value.id === projectId);
  const projectSelected = Boolean(project);
  const currentPasteScope = JSON.stringify([projectId, props.actorId]);
  if (pasteScope !== null && pasteScope !== currentPasteScope) setPasteScope(null);
  const capacities = useMemo(() => {
    const byStatus = new Map<string, BoardStatusCapacity>();
    if (projectSelected && view === 'board') {
      const labelCounts = new Map<string, number>();
      for (const status of statuses) labelCounts.set(status.label, (labelCounts.get(status.label) ?? 0) + 1);
      for (const status of statuses) {
        if (typeof status.wipLimit !== 'number') continue;
        const label = (labelCounts.get(status.label) ?? 0) > 1 ? `${status.label} (${status.id})` : status.label;
        byStatus.set(status.id, { status: { ...status, label }, limit: status.wipLimit, issues: [] });
      }
      if (byStatus.size) for (const issue of projectIssues) byStatus.get(issue.status)?.issues.push(issue);
    }
    return byStatus;
  }, [projectSelected, view, statuses, projectIssues]);
  const selectedCapacity = capacitySelection?.projectId === projectId ? capacities.get(capacitySelection.statusId) : undefined;
  const issueTypes = isAll(projectId) ? [...new Map(data.projects.flatMap(project => projectIssueTypes(data, project.id, { includeArchived: true })).map(item => [item.id, item])).values()] : projectIssueTypes(data, projectId, { includeArchived: true });
  const beginCreate = (nextStatus: string) => { if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return; setCreateStatus(nextStatus); setCreating(true); };
  function beginPaste() {
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setPasteScope(currentPasteScope);
  }
  const activeFilters = status !== 'all' || assignee !== 'all' || type !== 'all' || query !== '' || Boolean(fieldFilter || planning || gitlab || priorities || labels);
  function updateProjectFilters(change: ProjectFilters) {
    setProjectFilters(previous => {
      const next = new Map(previous);
      const filters = { ...previous.get(projectId), ...change };
      if (filters.fieldFilter || filters.planning || filters.gitlab || filters.priorities || filters.labels) next.set(projectId, filters);
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
    const { fieldFilter, planning, gitlab, priorities, labels } = value.filters;
    updateProjectFilters({ fieldFilter, planning, gitlab, priorities, labels });
    setFilterEditorEpoch(epoch => epoch + 1);
  }
  if (appliedRouteView?.projectId !== projectId || appliedRouteView.id !== savedViewId || (!appliedRouteView.applied && selectedView)) {
    setAppliedRouteView({ projectId, id: savedViewId, applied: Boolean(selectedView) });
    if (selectedView || savedViewId || appliedRouteView?.id) applySavedView(selectedView ?? defaultView);
  }
  function clearFilters() {
    if (!window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) return;
    setQuery(''); setStatus('all'); setAssignee('all'); setType('all');
    setProjectFilters(previous => {
      const next = new Map(previous);
      next.delete(projectId);
      return next;
    });
    setFilterEditorEpoch(epoch => epoch + 1);
  }
  function closeBulkEdit() {
    if (bulk.close()) bulkToggle.current?.focus({ preventScroll: true });
  }
  function openCapacity(statusId: string, opener: HTMLButtonElement) {
    capacityOpener.current = opener;
    setCapacitySelection({ projectId, statusId });
    requestAnimationFrame(() => capacityHeading.current?.focus());
  }
  function closeCapacity() {
    const opener = capacityOpener.current;
    const id = capacitySelection?.statusId;
    setCapacitySelection(null);
    capacityOpener.current = null;
    requestAnimationFrame(() => {
      const columnHeading = id && boardCanvas.current?.querySelector<HTMLElement>(`[data-status-id="${CSS.escape(id)}"] .issue-board-heading`);
      if (opener?.isConnected) opener.focus();
      else if (columnHeading) columnHeading.focus();
    });
  }
  function toggleBulkEdit() {
    if (bulk.active) { closeBulkEdit(); return; }
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setOrderEditProject(null);
    bulk.open();
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
  const csvDisabled = Boolean(busy || bulk.locked || unavailableView || !issues.length);

  function downloadIssuesCsv(selectionOnly: boolean) {
    if (csvDisabled) return;
    const rows = selectionOnly ? issues.filter(issue => bulk.selectedIds.has(issue.id)) : issues;
    if (!rows.length) return;
    const projectKey = data.projects.find(project => project.id === projectId)?.key ?? 'all';
    downloadText(`teamspace-issues-${projectKey}${selectionOnly ? '-selected' : ''}.csv`, formatIssueCsv(data, rows), 'text/csv;charset=utf-8');
  }

  return <div className="issues-feature">
    <div className="feature-heading"><div><div className="feature-eyebrow">WORK MANAGEMENT</div><h1>업무</h1><p>해야 할 일을 명확하게, 진행 상황을 한눈에.</p></div>
      <div className="issue-heading-actions">
        {projectSelected && <NotificationSubscriptionButton actorId={props.actorId} targetType="project" targetId={projectId} notify={notify} />}
        {projectSelected && view === 'list' && <button className="btn" type="button" disabled={Boolean(busy) || bulk.busy}
          onClick={beginPaste}><ClipboardPaste size={15} aria-hidden="true" />업무 붙여넣기</button>}
        <button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={16} /> 업무 만들기</button>
      </div>
    </div>
    <div className="issue-toolbar">
      <div className="issue-view-switch" aria-label="업무 보기"><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={16} /> 목록</button><button className={view === 'board' ? 'active' : ''} disabled={bulk.busy} onClick={() => { if (!bulk.active || bulk.close()) setView('board'); }}><Columns3 size={16} /> 보드</button></div>
      <div className="issue-search"><Search size={15} /><input aria-label="업무 검색" placeholder="제목, 번호, 속성 검색" value={query} disabled={bulk.locked} onChange={e => setQuery(e.target.value)} /></div>
      <div className="issue-filter-select"><Filter size={14} /><select aria-label="상태 필터" value={status} disabled={bulk.locked} onChange={e => setStatus(e.target.value)}><option value="all">모든 상태</option>{status !== 'all' && !statuses.some(value => value.id === status) && <option value={status}>{status} (저장된 조건)</option>}{statuses.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></div>
      <select className="issue-filter" aria-label="담당자 필터" value={assignee} disabled={bulk.locked} onChange={e => setAssignee(e.target.value)}><option value="all">모든 담당자</option><option value="none">미지정</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <select className="issue-filter" aria-label="유형 필터" value={type} disabled={bulk.locked} onChange={e => setType(e.target.value)}><option value="all">모든 유형</option>{type !== 'all' && !issueTypes.some(item => item.id === type) && <option value={type}>{type} (저장된 조건)</option>}{issueTypes.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (보관됨)' : ''}</option>)}</select>
      <select className="issue-filter" aria-label="GitLab 조건" value={gitlab ?? ''} disabled={bulk.locked}
        onChange={event => updateProjectFilters({ gitlab: (event.target.value || undefined) as IssueViewGitlabFilter | undefined })}>
        <option value="">GitLab 전체</option>
        {Object.entries(ISSUE_GITLAB_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {showGitlabRefresh && <GitlabActivityRefresh refresh={refresh} notify={notify} disabled={bulk.locked} />}
      {order && !bulk.active && <button type="button" className="btn btn-ghost issue-order-toggle" aria-pressed={ordering} onClick={() => setOrderEditProject(ordering ? null : projectId)}><ArrowDownUp size={15} aria-hidden="true" /> 순서 편집</button>}
      {projectSelected && view === 'list' && <button ref={bulkToggle} type="button" className="btn btn-ghost issue-bulk-toggle" aria-pressed={bulk.active}
        disabled={Boolean(busy) || bulk.busy} onClick={toggleBulkEdit}><ListChecks size={16} aria-hidden="true" />일괄 편집</button>}
      {activeFilters && <button className="btn btn-ghost issue-clear-filter" disabled={bulk.locked} onClick={clearFilters}><X size={14} /> 초기화</button>}
    </div>
    {projectSelected && <fieldset className="issue-bulk-filter-controls" disabled={bulk.locked}>
      <IssuePriorityLabelFilters key={`priority-label:${projectId}:${filterEditorEpoch}`} issues={projectIssues}
        value={{ priorities, labels }} onApply={updateProjectFilters} />
      {(schema.fields.length > 0 || fieldFilter) && <IssueFieldFilters
        key={`fields:${projectId}:${filterEditorEpoch}`} schema={schema} users={data.users} value={fieldFilter}
        onApply={value => updateProjectFilters({ fieldFilter: value })} notify={notify} />}
      <IssuePlanningFilters key={`planning:${projectId}:${filterEditorEpoch}`} projectId={projectId} planningItems={planningItems}
        value={planning} onApply={value => updateProjectFilters({ planning: value })} />
    </fieldset>}
    <SavedViews projectId={projectId} planningItems={planningItems} views={projectViews} selectedId={savedViewId}
      current={{layout:view,filters}} onSelect={onChangeSavedView} onApply={applySavedView} onOpenGantt={onOpenGantt}
      onViewsLoaded={values => setLoadedViews({ projectId, snapshot: data.savedViews, values })} onViewsChanged={refresh} notify={notify} />
    <div className="issue-results">
      <span>{activeFilters ? `${projectIssues.length}개 중 ` : ''}<strong>{issues.length}</strong>개의 업무</span>
      {view === 'list' ? <div className="issue-export-actions">
        <button className="btn btn-ghost" type="button" disabled={csvDisabled} onClick={() => downloadIssuesCsv(false)}>
          <ArrowDownToLine size={14} aria-hidden="true" />현재 목록 CSV
        </button>
        {bulk.active && <button className="btn btn-ghost" type="button" disabled={csvDisabled || !bulk.selectedCount} onClick={() => downloadIssuesCsv(true)}>
          <ArrowDownToLine size={14} aria-hidden="true" />선택 업무 CSV
        </button>}
      </div> : <span className="muted">{order ? '카드를 끌어 순서와 상태 변경' : '카드를 끌어 상태 변경'}</span>}
    </div>
    {order && <div className={notice ? 'issue-order-feedback' : 'sr-only'}>
      <p className={notice?.error ? 'is-error' : ''} role="status" aria-label="업무 순서 상태">{notice?.text}</p>
      {notice?.needsRefresh && <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void refreshOrder()}>최신 업무 순서 불러오기</button>}
    </div>}
    {bulk.active && <IssueBulkEdit editor={bulk} statuses={statuses} users={data.users} onClose={closeBulkEdit} />}
    {!unavailableView && (view === 'list' ? <div className="issue-table-scroll"><table className="issue-table"><thead><tr>{bulk.active && <th className="issue-bulk-selection"><IssueBulkSelectVisible editor={bulk} /></th>}<th className="issue-title-column">업무</th><th>상태</th><th>우선순위</th><th>담당자</th><th>종료일</th><th>라벨</th></tr></thead><tbody>{issues.map((issue, index) => {
      const user = data.users.find(u => u.id === issue.assigneeId);
      const selected = bulk.active && bulk.selectedIds.has(issue.id);
      return <tr key={issue.id} data-issue-id={issue.id} className={selected ? 'issue-bulk-selected' : undefined}>
        {bulk.active && <td className="issue-bulk-selection"><label className="issue-bulk-select-control"><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected}
          disabled={bulk.locked || (!selected && bulk.selectedCount >= ISSUE_BULK_EDIT_LIMIT)} onChange={() => bulk.toggle(issue)} /></label></td>}
        <td><button className="issue-title-button" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><span className="issue-title-text">{issue.title}</span><IssueTypeName data={data} issue={issue} /></button>
          <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} />
          <CustomFieldSummary data={data} issue={issue} limit={2} />
          <IssueGitlabSummary summary={gitlabSummary.get(issue.id)} />{controls(issue, issues, index)}</td>
        <td><span className="issue-status-select"><StatusDot color={statusMeta(data, issue.projectId, issue.status).color} /><select aria-label={`${issue.key} 상태`} value={issue.status} disabled={Boolean(busy) || bulk.active} onChange={e => changeStatus(issue, e.target.value as IssueStatus)}>{allowedNextStatuses(data, issue).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></span></td>
        <td><span className="issue-priority"><PriorityIcon value={issue.priority} />{PRIORITY[issue.priority]}</span></td>
        <td>{user ? <span className="issue-assignee"><span className="issue-avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</span> : <span className="muted">미지정</span>}</td>
        <td className="issue-date-cell">{dateLabel(issue.endDate || issue.dueDate)}</td>
        <td><div className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}{issue.labels.length > 2 && <span className="muted">+{issue.labels.length - 2}</span>}</div></td>
      </tr>;
    })}</tbody></table>{issues.length === 0 && <div className="issue-empty"><Circle size={28} /><h3>{activeFilters ? '조건에 맞는 업무가 없습니다' : '첫 업무를 만들어 보세요'}</h3><p>{activeFilters ? '검색어나 필터를 변경해 보세요.' : '계획과 실행의 시작을 이곳에 기록하세요.'}</p><button className="btn btn-primary" onClick={() => { beginCreate(statuses.some(value => value.id === status) ? status : workflow.initialStatusId); }}><Plus size={15} /> 업무 만들기</button></div>}</div> : <>
      <BoardCapacitySummary columns={[...capacities.values()]} open={openCapacity} />
      {selectedCapacity && <BoardCapacityDetails key={selectedCapacity.status.id} value={selectedCapacity}
        visibleIds={new Set(issues.map(issue => issue.id))} users={data.users} heading={capacityHeading}
        openIssue={onOpenBoardCapacityIssue ?? openIssue} close={closeCapacity} />}
      <div className="issue-board" ref={boardCanvas}>{statuses.map(state => {
      const key = state.id;
      const column = issues.filter(i => i.status === key);
      const capacity = capacities.get(key);
      const target = dropTarget?.status === key ? dropTarget : null;
      return <section key={key} className={`issue-board-column ${target ? 'is-drag-over' : ''}`} data-status-id={key}
        data-capacity={capacity && (capacity.issues.length > capacity.limit ? 'over' : capacity.issues.length === capacity.limit ? 'at' : 'under')}
        onDragOver={event => boardDragOver(event, key, column)}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(current => current?.status === key ? null : current); }}
        onDrop={event => dropOnBoard(event, key, column)}>
        <div className="issue-board-heading" tabIndex={capacity ? -1 : undefined}><StatusDot color={state.color} /><strong>{capacity?.status.label ?? state.label}</strong>
          {capacity ? <span className="board-capacity-count" title="프로젝트 전체 업무 수 / 한도" role="status"
            aria-label={`프로젝트 전체 업무 ${capacity.issues.length}개, 한도 ${capacity.limit}개`}>{capacity.issues.length.toLocaleString()} / {capacity.limit.toLocaleString()}</span> : <span>{column.length}</span>}
          <button title={`${state.label} 업무 추가`} aria-label={`${state.label} 업무 추가`} onClick={() => { beginCreate(key); }}><Plus size={15} /></button></div>
        {capacity && <BoardCapacityNote value={capacity} visible={column.length} open={openCapacity} />}
        {column.map((issue, index) => {
          const user = data.users.find(u => u.id === issue.assigneeId);
          return <div key={issue.id} className="issue-board-card-row" data-order-card={issue.id}>
            <button className={`issue-board-card ${busy === issue.id ? 'is-saving' : ''}`} data-issue-id={issue.id} data-order-drop={target?.anchorId === issue.id ? target.position : undefined}
              draggable={!busy && !notice?.needsRefresh} onDragStart={event => startBoardDrag(event, issue)} onDragEnd={endBoardDrag} onClick={() => openIssue(issue.id)}>
              <span className="issue-card-key"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issue.key}<IssueTypeName data={data} issue={issue} /></span><strong>{issue.title}</strong>
              <CustomFieldSummary data={data} issue={issue} /><span className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}</span>
              <IssueGitlabSummary summary={gitlabSummary.get(issue.id)} />
              <span className="issue-card-footer"><span className="issue-priority"><PriorityIcon value={issue.priority} /><span>{dateLabel(issue.endDate)}</span></span>{user && <span className="issue-avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>}</span>
            </button>
            <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} />
            {controls(issue, column, index)}
          </div>;
        })}{column.length === 0 && <div className="issue-column-empty">{capacity?.issues.length ? '필터에 맞는 업무가 없습니다' : '이 상태의 업무가 없습니다'}</div>}
      </section>;
    })}</div></>)}
    {project && pasteScope === currentPasteScope && <IssuePasteDialog project={project} actorId={props.actorId}
      refresh={refresh} notify={notify} onClose={() => setPasteScope(null)} />}
    {creating && <NewIssueModal {...props} initialStatus={createStatus} onClose={() => setCreating(false)} />}
  </div>;
}
