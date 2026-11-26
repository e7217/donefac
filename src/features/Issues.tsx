'use client';

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowDownUp, ArrowRightLeft, ArrowUp, ArrowUpRight, Bug, CalendarRange, Circle, CircleDot, ClipboardPaste, Columns3, Layers3, List, ListChecks, Plus, RefreshCw, Search, X } from 'lucide-react';
import { ISSUE_BULK_EDIT_LIMIT, PRIORITY, type FeatureProps, type Issue, type IssueOrderMove, type IssueStatus, type IssueViewAssigneeFilter, type IssueViewGitlabFilter, type SavedView, type SavedViewState, type User, type WorkflowStatus } from '../../shared/types';
import { formatIssueCsv } from '../../shared/issue-csv';
import { ApiError, dateLabel, patch } from '../lib/api';
import { downloadText } from '../lib/download';
import type { OpenIssueForReview } from '../lib/issue-review';
import { useIssueViewDate } from '../lib/use-issue-view-date';
import { useWorkspaceRefresh, type WorkspaceRefresh } from '../lib/workspace-refresh';
import { allowedNextStatuses, projectStatuses, projectWorkflow, statusMeta } from '../../shared/workflow-helpers';
import { issueTypeMeta, projectIssueSchema, projectIssueTypes } from '../../shared/issue-schema';
import { CustomFieldSummary, IssueTypeName } from './CustomFields';
import { IssuePasteDialog } from './IssuePasteDialog';
import { NewIssueModal } from './NewIssueModal';
import { SavedViews, savedViewDefinitionKey } from './SavedViews';
import { IssueFieldFilters } from './IssueFieldFilters';
import { IssueStatusDialog, type IssueStatusEdit } from './IssueStatusDialog';
import { IssueStatusFilter } from './IssueStatusFilter';
import { IssueViewSort } from './IssueViewSort';
import { IssuePlanningFilters } from './IssuePlanningFilters';
import { IssuePriorityLabelFilters } from './IssuePriorityLabelFilters';
import { IssueReporterFilterSelect } from './IssueReporterSelect';
import { buildIssueHierarchy, IssueHierarchyContext } from './IssueHierarchyContext';
import { IssueBulkEdit, IssueBulkSelectVisible, useIssueBulkEdit } from './IssueBulkEdit';
import { BoardCapacityDetails, BoardCapacityNote, BoardCapacitySummary, type BoardStatusCapacity } from './IssueBoardCapacity';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { GitlabActivityRefresh } from './GitlabActivity';
import { ISSUE_GITLAB_FILTER_LABELS, IssueGitlabSummary } from './IssueGitlabSummary';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view';
import { createIssueViewMatcher, issueViewStatusCriteria, issueViewStatusIds, orderIssueView, orderProjectIssues } from '../../shared/issue-view';
import { errorMessage } from './schedule-utils';
import './issues.css';
import './issue-order.css';
import './issue-board-groups.css';

const isAll = (id: string) => !id || id === 'all';
const issueDragType = 'text/issue-id';
type IssuePlacement = Pick<IssueOrderMove, 'anchorId' | 'position'>;
type BoardCell = { status: IssueStatus; targetAssigneeId?: string | null };
type IssueCreation = { status: IssueStatus; assigneeId?: string | null; opener: HTMLButtonElement };
type BoardDrop = IssuePlacement & BoardCell;
type BoardDrag = { issue: Issue; projectId: string; fieldSorted: boolean; orderVersion?: string };
type BoardLane = { id: string | null; name: string; email?: string; color?: string; issues: Issue[] };
type IssueRowAction = 'details' | 'status';
type ProjectStatusEdit = IssueStatusEdit & { opener: HTMLButtonElement };
type OrderNotice = { projectId: string; text: string; error?: boolean; needsRefresh?: boolean };
type ProjectFilters = Pick<SavedViewState['filters'], 'statusIds' | 'fieldFilter' | 'planning' | 'gitlab' | 'priorities' | 'labels' | 'reporter'>;
type ProjectIssueLayout = Pick<SavedViewState, 'layout' | 'boardGrouping'> & { showEmptyAssignees: boolean };
const defaultView: SavedViewState = { layout: 'list', filters: { query: '', status: 'all', assigneeId: 'all', type: 'all' } };
const defaultLayout: ProjectIssueLayout = { layout: 'list', showEmptyAssignees: false };
const assigneeMemberPrefix = 'member:';
const assigneeCollator = new Intl.Collator('ko', { numeric: true });
const refreshMessages = {
  updated: '업무를 새로고침했습니다.',
  skipped: '업무 새로고침을 건너뛰었습니다.',
  failed: '업무를 새로고침하지 못했습니다. 다시 시도해 주세요.',
} as const;

function readProjectIssueLayout(key: string | null): ProjectIssueLayout {
  if (!key) return defaultLayout;
  try {
    const value: Partial<ProjectIssueLayout> | null = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value?.layout === 'list' || value?.layout === 'board') return {
      layout: value.layout,
      boardGrouping: value.boardGrouping === 'assignee' ? 'assignee' : undefined,
      showEmptyAssignees: value.showEmptyAssignees === true,
    };
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
  return defaultLayout;
}

function groupBoardIssues(issues: Issue[], users: readonly User[], showEmpty: boolean) {
  const byAssignee = new Map<string | null, Issue[]>();
  for (const issue of issues) {
    const assigneeId = issue.assigneeId ?? null;
    const group = byAssignee.get(assigneeId);
    if (group) group.push(issue);
    else byAssignee.set(assigneeId, [issue]);
  }
  const names = new Map<string, number>();
  for (const user of users) names.set(user.name, (names.get(user.name) ?? 0) + 1);
  const lanes = users.filter(user => showEmpty || byAssignee.has(user.id))
    .sort((a, b) => assigneeCollator.compare(a.name, b.name) || assigneeCollator.compare(a.email, b.email) || (a.id < b.id ? -1 : Number(a.id > b.id)))
    .map<BoardLane>(user => ({ id: user.id, name: user.name, email: (names.get(user.name) ?? 0) > 1 ? user.email : undefined,
      color: user.color, issues: byAssignee.get(user.id) ?? [] }));
  const known = new Set(users.map(user => user.id));
  for (const id of [...byAssignee.keys()].filter((id): id is string => id !== null && !known.has(id)).sort()) {
    lanes.push({ id, name: `담당자 확인 불가 (${id})`, issues: byAssignee.get(id) ?? [] });
  }
  lanes.push({ id: null, name: '담당자 미지정', issues: byAssignee.get(null) ?? [] });
  return lanes;
}

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

function boardCardControl(board: HTMLDivElement | null, issueId: string, action: IssueRowAction) {
  const value = CSS.escape(issueId);
  const selector = action === 'status' ? `.issue-board-card-status[data-board-status-for="${value}"]` : `.issue-board-card[data-issue-id="${value}"]`;
  return board?.querySelector<HTMLButtonElement>(selector) ?? null;
}
function issueListControl(list: HTMLDivElement | null, issueId: string, action: IssueRowAction) {
  const selector = action === 'status' ? '.issue-list-status-action' : '.issue-title-button';
  return list?.querySelector<HTMLButtonElement>(`tr[data-issue-id="${CSS.escape(issueId)}"] ${selector}`) ?? null;
}
export function IssueTypeIcon({ type, size = 15, data, projectId }: { type: string; size?: number; data?: FeatureProps['data']; projectId?: string }) {
  const meta = data && projectId ? issueTypeMeta(data, projectId, type) : null;
  return type === '버그' ? <Bug size={size} color={meta?.color || '#db705e'} aria-label={meta?.name} /> : type === '큰틀' ? <Layers3 size={size} color={meta?.color || '#9173cd'} aria-label={meta?.name} /> : type === '개선' ? <ArrowUpRight size={size} color={meta?.color || '#ca9e4a'} aria-label={meta?.name} /> : <CircleDot size={size} color={meta?.color || '#578ca9'} aria-label={meta?.name} />;
}
export function StatusDot({ color }: { color: string }) { return <span className="issue-status-dot" style={{ background: color }} />; }
function PriorityIcon({ value }: { value: keyof typeof PRIORITY }) { return value === 'urgent' || value === 'high' ? <ArrowUp size={14} className={value === 'urgent' ? 'issue-priority-urgent' : 'issue-priority-high'} /> : value === 'low' ? <ArrowDown size={14} className="muted" /> : <span className="issue-priority-medium">=</span>; }

export function Issues(props: FeatureProps & {
  refreshIssues: WorkspaceRefresh;
  issueOverlayOpen: boolean;
  savedViewId?: string | null;
  onChangeSavedView?: (id: string | null) => boolean;
  onOpenGantt?: (viewId: string) => void;
  onOpenFieldBreakdown?: (viewId: string) => void;
  onOpenCycleBoard?: () => void;
  onOpenBoardCapacityIssue?: (id: string, source: { opener: HTMLElement; fallback: HTMLElement | null }) => void;
  onOpenIssueForReview?: OpenIssueForReview;
}) {
  const { data, projectId, actorId, refresh, notify, openIssue, savedViewId = null, onChangeSavedView, onOpenGantt, onOpenFieldBreakdown, onOpenBoardCapacityIssue } = props;
  const [loadedViews, setLoadedViews] = useState<{ projectId: string; snapshot: typeof data.savedViews; values: SavedView[] }>();
  const workspaceViews = useMemo(() => (data.savedViews ?? []).filter(view => view.projectId === projectId)
    .sort((left, right) => left.name.localeCompare(right.name, 'ko')), [data.savedViews, projectId]);
  const projectViews = loadedViews?.projectId === projectId && loadedViews.snapshot === data.savedViews ? loadedViews.values : workspaceViews;
  const selectedView = savedViewId ? projectViews.find(value => value.id === savedViewId) : undefined;
  const unavailableView = Boolean(savedViewId && !selectedView);
  const layoutKey = !actorId || isAll(projectId) ? null : `teamspace:project-issue-layout:${JSON.stringify([actorId, projectId, data.restoreGeneration ?? null])}`;
  const [appliedRouteView, setAppliedRouteView] = useState<{ projectId: string; layoutKey: string | null; id: string | null; definition?: string }>();
  const [issueLayout, setIssueLayout] = useState(defaultLayout);
  const { layout: view, boardGrouping, showEmptyAssignees } = issueLayout;
  const [sort, setSort] = useState<SavedViewState['sort']>();
  const groupingInstructions = useId();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [assignee, setAssignee] = useState<string | IssueViewAssigneeFilter>('all');
  const [type, setType] = useState('all');
  const [projectFilters, setProjectFilters] = useState(() => new Map<string, ProjectFilters>());
  const [filterEditorEpoch, setFilterEditorEpoch] = useState(0);
  const { statusIds, fieldFilter, planning, gitlab, priorities, labels, reporter } = projectFilters.get(projectId) ?? {};
  const assigneeId = typeof assignee === 'string' ? assignee : 'all';
  const assigneeFilter = typeof assignee === 'string' ? undefined : assignee;
  const planningItems = data.planningItems ?? [];
  const schema = useMemo(() => projectIssueSchema({issueSchemas:data.issueSchemas}, projectId), [data.issueSchemas, projectId]);
  const filters = useMemo<SavedViewState['filters']>(() => ({
    query, status: statusIds ? 'all' : status, assigneeId, type,
    ...(assigneeFilter ? { assignee: assigneeFilter } : {}), ...(fieldFilter ? { fieldFilter } : {}), ...(planning ? { planning } : {}),
    ...(gitlab ? { gitlab } : {}), ...(priorities ? { priorities } : {}), ...(labels ? { labels } : {}), ...(reporter ? { reporter } : {}),
    ...(statusIds ? { statusIds } : {}),
  }), [query, status, statusIds, assigneeId, assigneeFilter, type, fieldFilter, planning, gitlab, priorities, labels, reporter]);
  const selectedStatuses = issueViewStatusIds(filters);
  const gitlabSummary = useMemo(() => summarizeIssueGitlabLinks(data.gitlabLinks), [data.gitlabLinks]);
  const viewDate = useIssueViewDate(filters.planning?.dates?.mode === 'due_relative');
  const matchesIssue = useMemo(() => createIssueViewMatcher(filters, {
    issueSchemas:data.issueSchemas,users:data.users,gitlabLinks:data.gitlabLinks,
  }, schema, actorId, viewDate), [filters,data.issueSchemas,data.users,data.gitlabLinks,schema,actorId,viewDate]);
  const [creation, setCreation] = useState<IssueCreation | null>(null);
  const [pasteScope, setPasteScope] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [orderEditProject, setOrderEditProject] = useState<string | null>(null);
  const [orderNotice, setOrderNotice] = useState<OrderNotice | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardDrop | null>(null);
  const [statusEdit, setStatusEdit] = useState<ProjectStatusEdit | null>(null);
  const [capacitySelection, setCapacitySelection] = useState<{ projectId: string; statusId: string } | null>(null);
  const pendingMutation = useRef(false);
  const statusChooserOpen = useRef(false);
  const statusFocus = useRef<Pick<ProjectStatusEdit, 'issue' | 'opener'> | null>(null);
  const drag = useRef<BoardDrag | null>(null);
  const bulkToggle = useRef<HTMLButtonElement>(null);
  const boardBulkControls = useRef<HTMLDivElement>(null);
  const boardCanvas = useRef<HTMLDivElement>(null);
  const listCanvas = useRef<HTMLDivElement>(null);
  const filterEditors = useRef<HTMLFieldSetElement>(null);
  const focusedCard = useRef<{ control: HTMLButtonElement; issueId: string; action: IssueRowAction } | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const capacityHeading = useRef<HTMLHeadingElement>(null);
  const capacityOpener = useRef<HTMLButtonElement | null>(null);
  const order = isAll(projectId) ? undefined : data.issueOrders?.find(value => value.projectId === projectId);
  const fieldSorted = Boolean(sort?.length);
  const ordering = !fieldSorted && Boolean(order) && orderEditProject === projectId;
  const notice = orderNotice?.projectId === projectId ? orderNotice : null;
  const rankRefreshRequired = !fieldSorted && Boolean(notice?.needsRefresh);
  const statuses = projectStatuses(data, projectId);
  const workflow = projectWorkflow(data, projectId);
  const createFromFilter = selectedStatuses.length === 1 && statuses.some(value => value.id === selectedStatuses[0])
    ? selectedStatuses[0] : workflow.initialStatusId;
  const projectIssues = useMemo(() => orderProjectIssues(data.issues.filter(i => isAll(projectId) || i.projectId === projectId), order), [data.issues, projectId, order]);
  const showGitlabRefresh = Boolean(gitlab) || projectIssues.some(issue => gitlabSummary.has(issue.id));
  const hierarchy = useMemo(() => buildIssueHierarchy(projectIssues), [projectIssues]);
  const issues = useMemo(() => {
    if (unavailableView) return [];
    // The project rows already carry manual ranks for any ties in a field sort.
    return orderIssueView(projectIssues.filter(matchesIssue), undefined, sort);
  }, [unavailableView, projectIssues, matchesIssue, sort]);
  const bulk = useIssueBulkEdit(props, issues);
  const project = data.projects.find(value => value.id === projectId);
  const projectSelected = Boolean(project);
  const groupedBoard = projectSelected && view === 'board' && boardGrouping === 'assignee';
  const currentPasteScope = JSON.stringify([projectId, props.actorId]);
  const refreshPaused = props.issueOverlayOpen || Boolean(creation) || pasteScope === currentPasteScope || bulk.active || Boolean(busy || statusEdit);
  const hasLocalInteraction = useCallback(() => Boolean(pendingMutation.current || statusChooserOpen.current || drag.current || filterEditors.current?.querySelector('form')), []);
  const { requestMode, feedback, manualRefresh, reconsider } = useWorkspaceRefresh(props.refreshIssues, refreshPaused, hasLocalInteraction);
  useLayoutEffect(() => {
    const focused = focusedCard.current;
    if (!focused || focused.control.isConnected || refreshPaused || document.activeElement !== document.body) return;
    focusedCard.current = null;
    const action = boardCardControl(boardCanvas.current, focused.issueId, focused.action);
    const card = action && !action.disabled ? action : boardCardControl(boardCanvas.current, focused.issueId, 'details');
    const target = card ?? boardCanvas.current ?? reviewHeading.current;
    target?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [data, refreshPaused]);
  useLayoutEffect(() => {
    if (statusEdit || !statusFocus.current) return;
    const { issue, opener } = statusFocus.current;
    statusFocus.current = null;
    if (props.issueOverlayOpen || !isAll(projectId) && issue.projectId !== projectId) return;
    requestAnimationFrame(() => {
      const canvas = view === 'board' ? boardCanvas.current : listCanvas.current;
      const control = view === 'board' ? boardCardControl : issueListControl;
      const action = control(canvas, issue.id, 'status');
      const details = control(canvas, issue.id, 'details');
      const target = [opener, action, details, canvas, reviewHeading.current].find(control =>
        control?.isConnected && !control.closest('[inert]') && !control.matches(':disabled'));
      target?.focus({ preventScroll: true });
      if (target && (target === action || target === details) && target !== opener) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [statusEdit, props.issueOverlayOpen, projectId, view]);
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
  function beginCreate(status: IssueStatus, opener: HTMLButtonElement, assigneeId?: string | null) {
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setCreation({ status, assigneeId, opener });
  }
  function closeCreation() {
    const opener = creation?.opener;
    setCreation(null);
    if (opener) requestAnimationFrame(() => {
      if (document.activeElement === document.body && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    });
  }
  function beginPaste() {
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setPasteScope(currentPasteScope);
  }
  const activeFilters = selectedStatuses.length > 0 || assignee !== 'all' || type !== 'all' || query !== '' || Boolean(fieldFilter || planning || gitlab || priorities || labels || reporter);
  const staticAssignee = assigneeId !== 'all' && assigneeId !== 'none';
  const assigneeSelection = assigneeFilter?.kind ?? (staticAssignee ? `${assigneeMemberPrefix}${assigneeId}` : assigneeId);
  const missingAssignee = staticAssignee && !data.users.some(user => user.id === assigneeId);
  function updateProjectFilters(change: ProjectFilters) {
    setProjectFilters(previous => {
      const next = new Map(previous);
      const filters = { ...previous.get(projectId), ...change };
      if (filters.statusIds || filters.fieldFilter || filters.planning || filters.gitlab || filters.priorities || filters.labels || filters.reporter) next.set(projectId, filters);
      else next.delete(projectId);
      return next;
    });
  }
  function updateStatusFilter(ids: readonly string[]) {
    const criteria = issueViewStatusCriteria(ids);
    setStatus(criteria.status);
    updateProjectFilters({ statusIds: criteria.statusIds });
  }
  function updateAssigneeFilter(value: string) {
    const memberId = value.startsWith(assigneeMemberPrefix) ? value.slice(assigneeMemberPrefix.length) : value;
    setAssignee(value === 'current-user' ? { kind: 'current-user' } : memberId);
  }
  function applySavedView(value: SavedViewState, layout?: ProjectIssueLayout) {
    setIssueLayout(layout ?? { layout: value.layout, boardGrouping: value.layout === 'board' ? value.boardGrouping : undefined, showEmptyAssignees: false });
    setSort(value.sort);
    if (value.sort?.length) setOrderEditProject(null);
    setQuery(value.filters.query);
    setStatus(value.filters.status);
    setAssignee(value.filters.assignee ?? value.filters.assigneeId);
    setType(value.filters.type);
    const { statusIds, fieldFilter, planning, gitlab, priorities, labels, reporter } = value.filters;
    updateProjectFilters({ statusIds, fieldFilter, planning, gitlab, priorities, labels, reporter });
    setFilterEditorEpoch(epoch => epoch + 1);
  }
  const layoutScopeChanged = appliedRouteView?.projectId !== projectId || appliedRouteView.layoutKey !== layoutKey;
  const currentView: SavedViewState = { layout: view, boardGrouping: groupedBoard ? 'assignee' : undefined, sort, filters };
  const selectedDefinition = selectedView && savedViewDefinitionKey(selectedView);
  const latestConditionsPending = Boolean(appliedRouteView?.definition && selectedDefinition && appliedRouteView.definition !== selectedDefinition);
  if (layoutScopeChanged || appliedRouteView.id !== savedViewId || (!appliedRouteView.definition && selectedView)) {
    setAppliedRouteView({ projectId, layoutKey, id: savedViewId, definition: selectedDefinition });
    if (layoutScopeChanged) setSort(undefined);
    if (savedViewId) applySavedView(selectedView ?? defaultView);
    else if (appliedRouteView?.id) applySavedView(defaultView, readProjectIssueLayout(layoutKey));
    else setIssueLayout(readProjectIssueLayout(layoutKey));
  } else if (selectedView && latestConditionsPending && !refreshPaused) {
    const currentDefinition = savedViewDefinitionKey(currentView);
    if (currentDefinition === selectedDefinition || currentDefinition === appliedRouteView.definition) {
      setAppliedRouteView({ ...appliedRouteView, definition: selectedDefinition });
      if (currentDefinition !== selectedDefinition) {
        applySavedView(selectedView, { layout: selectedView.layout, boardGrouping: selectedView.boardGrouping, showEmptyAssignees });
      }
    }
  }
  function applySharedView(value: SavedView) {
    if (value.id === savedViewId) setAppliedRouteView({ projectId, layoutKey, id: value.id, definition: savedViewDefinitionKey(value) });
    applySavedView(value);
  }
  function changeIssueLayout(change: Partial<ProjectIssueLayout>) {
    const next = { ...issueLayout, ...change };
    setIssueLayout(next);
    if (savedViewId || !layoutKey) return;
    try {
      localStorage.setItem(layoutKey, JSON.stringify(next));
    } catch { /* The current view still works without browser storage. */ }
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
    if (drag.current) return;
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setOrderEditProject(null);
    bulk.open();
    if (view === 'board') requestAnimationFrame(() => {
      const controls = boardBulkControls.current;
      (controls?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? controls)?.focus();
    });
  }
  function switchView(next: typeof view) {
    if (next !== view && (!bulk.active || bulk.close())) changeIssueLayout({ layout: next });
  }
  async function changeBoardCell(issue: Issue, status: IssueStatus, assigneeId?: string | null) {
    const statusChanged = status !== issue.status;
    if ((!statusChanged && assigneeId === undefined) || pendingMutation.current) return;
    if (statusChanged && !allowedNextStatuses(data, issue).some(value => value.id === status)) {
      notify('이 업무 유형에 허용되지 않은 상태 전이입니다.', 'error');
      return;
    }
    pendingMutation.current = true;
    setBusy(issue.id);
    try {
      await patch(`/issues/${issue.id}`, {
        expectedVersion: issue.version, expectedWorkflowVersion: projectWorkflow(data, issue.projectId).version, status,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
      });
      await refresh();
      notify(assigneeId === undefined ? `${issue.key} · ${statusMeta(data, issue.projectId, status).label}(으)로 변경했습니다.`
        : `${issue.key} 업무${statusChanged ? '의 상태와 담당자' : ' 담당자'}를 변경했습니다.`);
    }
    catch (error) { notify(errorMessage(error), 'error'); } finally { pendingMutation.current = false; setBusy(null); }
  }

  function openStatusEdit(issue: Issue, current: WorkflowStatus, choices: WorkflowStatus[], opener: HTMLButtonElement) {
    if (!choices.length || pendingMutation.current || statusChooserOpen.current || drag.current) return;
    if (!window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    statusChooserOpen.current = true;
    setStatusEdit({ issue, current, choices, workflowVersion: projectWorkflow(data, issue.projectId).version, opener });
  }

  function closeStatusEdit() {
    if (!statusEdit) return;
    statusFocus.current = statusEdit;
    statusChooserOpen.current = false;
    setStatusEdit(null);
  }

  async function moveIssue(issue: Issue, placement: IssuePlacement, options: Pick<IssueOrderMove, 'status' | 'targetAssigneeId' | 'assigneeId'> & {
    version?: string;
    opener?: HTMLButtonElement;
  } = {}) {
    if (!order || fieldSorted || issue.projectId !== projectId || placement.anchorId === issue.id || notice?.needsRefresh || pendingMutation.current) return;
    const nextStatus = options.status !== issue.status ? options.status : undefined;
    if (nextStatus !== undefined && !allowedNextStatuses(data, issue).some(value => value.id === nextStatus)) {
      setOrderNotice({ projectId, error: true, text: '이 업무 유형에 허용되지 않은 상태 전이입니다.' });
      return;
    }

    const opener = options.opener === document.activeElement ? options.opener : undefined;
    pendingMutation.current = true;
    setBusy(issue.id);
    setOrderNotice({ projectId, text: `${issue.key} 업무 순서를 저장 중입니다.` });
    const movement = options.assigneeId === undefined ? (nextStatus === undefined ? '순서' : '순서와 상태')
      : nextStatus === undefined ? '순서와 담당자' : '순서·상태·담당자';
    let text = `${issue.key} 업무 ${movement}를 변경했습니다.`;
    let error = false;
    try {
      try {
        const move: IssueOrderMove = {
          issueId: issue.id, expectedVersion: options.version ?? order.version, expectedIssueVersion: issue.version,
          ...placement, ...(nextStatus === undefined ? {} : { status: nextStatus }),
          ...(options.targetAssigneeId === undefined ? {} : { targetAssigneeId: options.targetAssigneeId }),
          ...(options.assigneeId === undefined ? {} : { assigneeId: options.assigneeId }),
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
        if (document.activeElement !== document.body) return;
        if (opener.isConnected) opener.focus({ preventScroll: true });
        else boardCanvas.current?.querySelector<HTMLButtonElement>(`.issue-board-card[data-issue-id="${CSS.escape(issue.id)}"]`)?.focus();
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
    if (bulk.active || pendingMutation.current || rankRefreshRequired) { event.preventDefault(); return; }
    event.dataTransfer.setData(issueDragType, issue.id);
    event.dataTransfer.effectAllowed = 'move';
    drag.current = { issue, projectId, fieldSorted, orderVersion: order?.version };
    reconsider();
  }

  function endBoardDrag() {
    const wasDragging = Boolean(drag.current);
    drag.current = null;
    setDropTarget(null);
    if (wasDragging) reconsider();
  }

  function boardDragOver(event: DragEvent<HTMLElement>, cell: BoardCell, column: Issue[]) {
    if (bulk.active || !event.dataTransfer.types.includes(issueDragType) || pendingMutation.current || rankRefreshRequired) return;
    const source = drag.current;
    if (source && (source.projectId !== projectId || source.fieldSorted !== fieldSorted)) return;
    if (fieldSorted && source?.issue.status === cell.status &&
      (cell.targetAssigneeId === undefined || (source.issue.assigneeId ?? null) === cell.targetAssigneeId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const placement = order && !fieldSorted ? boardPlacement(event, column, source?.issue.id) : { anchorId: null, position: 'after' } as const;
    const target = { ...placement, ...cell };
    setDropTarget(current => current?.status === cell.status && current.targetAssigneeId === cell.targetAssigneeId &&
      current.anchorId === target.anchorId && current.position === target.position ? current : target);
  }

  function dropOnBoard(event: DragEvent<HTMLElement>, { status, targetAssigneeId }: BoardCell, column: Issue[]) {
    const id = event.dataTransfer.getData(issueDragType);
    const source = drag.current;
    endBoardDrag();
    if (bulk.active || !id || source && (source.projectId !== projectId || source.fieldSorted !== fieldSorted || source.issue.id !== id)) return;
    event.preventDefault();
    const issue = source?.issue ?? projectIssues.find(value => value.id === id);
    if (!issue) return;
    const changesAssignee = targetAssigneeId !== undefined && (issue.assigneeId ?? null) !== targetAssigneeId;
    if (fieldSorted) {
      void changeBoardCell(issue, status, changesAssignee ? targetAssigneeId : undefined);
      return;
    }
    if (!order) {
      if (changesAssignee) notify('업무 순서를 불러온 뒤 다른 담당자에게 이동하세요.', 'error');
      else void changeBoardCell(issue, status);
      return;
    }
    const placement = boardPlacement(event, column, issue.id);
    if (!changesAssignee && issue.status === status && keepsVisiblePosition(issue, column, placement)) return;
    void moveIssue(issue, placement, { status, version: source?.orderVersion, targetAssigneeId,
      assigneeId: changesAssignee ? targetAssigneeId : undefined });
  }

  const controls = (issue: Issue, visible: Issue[], index: number, targetAssigneeId?: string | null) => ordering && <IssueOrderControls issue={issue}
    previous={visible[index - 1]} next={visible[index + 1]} busy={Boolean(busy || notice?.needsRefresh)}
    move={(source, placement, opener) => void moveIssue(source, placement, { opener, targetAssigneeId })} />;

  function boardHeading(state: WorkflowStatus, visible: number, capacity?: BoardStatusCapacity) {
    return <>
      <div className="issue-board-heading" tabIndex={capacity ? -1 : undefined}>
        <StatusDot color={state.color} /><strong>{capacity?.status.label ?? state.label}</strong>
        {capacity ? <span className="board-capacity-count" title="프로젝트 전체 업무 수 / 한도" role="status"
          aria-label={`프로젝트 전체 업무 ${capacity.issues.length}개, 한도 ${capacity.limit}개`}>{capacity.issues.length.toLocaleString()} / {capacity.limit.toLocaleString()}</span> : <span>{visible}</span>}
        <button title={`${state.label} 업무 추가`} aria-label={`${state.label} 업무 추가`} aria-haspopup="dialog"
          type="button" onClick={event => beginCreate(state.id, event.currentTarget)}><Plus size={15} aria-hidden="true" /></button>
      </div>
      {capacity && <BoardCapacityNote value={capacity} visible={visible} open={openCapacity} />}
    </>;
  }

  function capacityState(capacity?: BoardStatusCapacity) {
    if (!capacity) return undefined;
    const excess = capacity.issues.length - capacity.limit;
    return excess > 0 ? 'over' : excess === 0 ? 'at' : 'under';
  }

  function boardColumn(state: WorkflowStatus, laneIssues: Issue[], lane?: BoardLane) {
    const targetAssigneeId = lane?.id;
    const column = laneIssues.filter(issue => issue.status === state.id);
    const cell: BoardCell = { status: state.id, targetAssigneeId };
    const isCellTarget = (target: BoardDrop | null) => target?.status === state.id && target.targetAssigneeId === targetAssigneeId;
    const target = isCellTarget(dropTarget) ? dropTarget : null;
    const grouped = targetAssigneeId !== undefined;
    const capacity = grouped ? undefined : capacities.get(state.id);
    const statusLabel = capacities.get(state.id)?.status.label ?? state.label;
    const canCreateInLane = lane && (lane.id === null || data.users.some(user => user.id === lane.id));
    const createLabel = lane && [lane.name, lane.email, `${statusLabel} 업무 추가`].filter(Boolean).join(' · ');
    return <section key={state.id} className={`issue-board-column ${target ? 'is-drag-over' : ''}`} data-status-id={state.id}
      aria-label={grouped ? (capacities.get(state.id)?.status.label ?? state.label) : undefined} data-capacity={capacityState(capacity)}
      onDragOver={event => boardDragOver(event, cell, column)}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(current => isCellTarget(current) ? null : current); }}
      onDrop={event => dropOnBoard(event, cell, column)}>
      {lane ? <div className="issue-board-column-leading">
        <div className="issue-board-cell-heading">
          <StatusDot color={state.color} /><span>{statusLabel}</span><span>{column.length}</span>
        </div>
        {canCreateInLane && <button className="btn btn-ghost issue-board-create" type="button" title={createLabel} aria-label={createLabel}
          aria-haspopup="dialog" disabled={Boolean(busy)} onClick={event => beginCreate(state.id, event.currentTarget, lane.id)}>
          <Plus size={16} aria-hidden="true" />
        </button>}
      </div> : boardHeading(state, column.length, capacity)}
      {column.map((issue, index) => {
        const user = data.users.find(user => user.id === issue.assigneeId);
        const destinations = allowedNextStatuses(data, issue).filter(status => status.id !== issue.status);
        const selected = bulk.active && bulk.selectedIds.has(issue.id);
        return <div key={issue.id} className="issue-board-card-row" data-order-card={fieldSorted ? undefined : issue.id} data-bulk-selected={selected || undefined}>
          <button className={`issue-board-card ${busy === issue.id ? 'is-saving' : ''}`} data-issue-id={issue.id} data-order-drop={target?.anchorId === issue.id ? target.position : undefined}
            disabled={bulk.locked} draggable={!bulk.active && !busy && !rankRefreshRequired} onDragStart={event => startBoardDrag(event, issue)} onDragEnd={endBoardDrag}
            onClick={event => openVisibleIssue(issue.id, event.currentTarget)}>
            <span className="issue-card-key"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issue.key}<IssueTypeName data={data} issue={issue} /></span><strong>{issue.title}</strong>
            <CustomFieldSummary data={data} issue={issue} /><span className="issue-labels">{issue.labels.slice(0, 2).map(label => <span className="issue-label" key={label}>{label}</span>)}</span>
            <IssueGitlabSummary summary={gitlabSummary.get(issue.id)} />
            <span className="issue-card-footer"><span className="issue-priority"><PriorityIcon value={issue.priority} /><span>{dateLabel(issue.endDate)}</span></span>{user && <span className="issue-avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>}</span>
          </button>
          {bulk.active ? <label className="issue-bulk-select-control issue-bulk-select-with-label issue-bulk-selection issue-board-card-select">
            <input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected}
              disabled={bulk.locked || (!selected && bulk.selectedCount >= ISSUE_BULK_EDIT_LIMIT)} onChange={() => bulk.toggle(issue)} />
            <span>선택</span>
          </label> : <button className="btn btn-ghost issue-board-card-status" type="button" aria-label={`${issue.key} 상태 변경`}
            aria-haspopup="dialog" data-board-status-for={issue.id} disabled={!destinations.length || Boolean(busy)}
            onClick={event => openStatusEdit(issue, state, destinations, event.currentTarget)}>
            <ArrowRightLeft size={15} aria-hidden="true" />상태 변경
          </button>}
          <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} />
          {controls(issue, column, index, targetAssigneeId)}
        </div>;
      })}
      {column.length === 0 && <div className="issue-column-empty">{grouped ? '업무 없음' : capacity?.issues.length ? '필터에 맞는 업무가 없습니다' : '이 상태의 업무가 없습니다'}</div>}
    </section>;
  }

  const lanes = groupedBoard ? groupBoardIssues(issues, data.users, showEmptyAssignees) : [];
  const csvDisabled = Boolean(busy || bulk.locked || unavailableView || !issues.length);

  function openVisibleIssue(id: string, opener: HTMLElement) {
    if (!props.onOpenIssueForReview) { openIssue(id); return; }
    const boardLanes = groupedBoard ? lanes.map(lane => lane.issues) : [issues];
    const reviewIssues = view === 'list' ? issues : boardLanes.flatMap(lane =>
      statuses.flatMap(state => lane.filter(issue => issue.status === state.id)));
    const fallback = view === 'list' ? reviewHeading.current : boardCanvas.current ?? reviewHeading.current;
    props.onOpenIssueForReview(id, { issueIds: reviewIssues.map(issue => issue.id), opener, fallback });
  }

  function downloadIssuesCsv(selectionOnly: boolean) {
    if (csvDisabled) return;
    const rows = selectionOnly ? issues.filter(issue => bulk.selectedIds.has(issue.id)) : issues;
    if (!rows.length) return;
    const projectKey = data.projects.find(project => project.id === projectId)?.key ?? 'all';
    downloadText(`teamspace-issues-${projectKey}${selectionOnly ? '-selected' : ''}.csv`, formatIssueCsv(data, rows), 'text/csv;charset=utf-8');
  }

  return <div className="issues-feature" onFocusCapture={event => {
    const control = event.target;
    const actionId = control.dataset.boardStatusFor;
    const issueId = actionId ?? (control.matches('.issue-board-card') ? control.dataset.issueId : undefined);
    focusedCard.current = issueId && control instanceof HTMLButtonElement
      ? { control, issueId, action: actionId ? 'status' : 'details' } : null;
  }} onBlurCapture={event => {
    const control = event.target;
    if (control instanceof HTMLButtonElement && control === focusedCard.current?.control && (event.relatedTarget || control.isConnected)) {
      focusedCard.current = null;
    }
  }}>
    <div className="feature-heading"><div><div className="feature-eyebrow">WORK MANAGEMENT</div><h1 ref={reviewHeading} tabIndex={-1}>업무</h1><p>해야 할 일을 명확하게, 진행 상황을 한눈에.</p></div>
      <div className="issue-heading-actions">
        <button className="btn" type="button" aria-disabled={refreshPaused || requestMode !== null} aria-busy={requestMode === 'manual'}
          onClick={manualRefresh}><RefreshCw size={15} aria-hidden="true" className={requestMode === 'manual' ? 'spin' : undefined} />업무 새로고침</button>
        {projectSelected && props.onOpenCycleBoard && <button className="btn" type="button" onClick={props.onOpenCycleBoard}>
          <CalendarRange size={15} aria-hidden="true" />백로그 · 사이클
        </button>}
        {projectSelected && <NotificationSubscriptionButton actorId={props.actorId} targetType="project" targetId={projectId} notify={notify} />}
        {projectSelected && view === 'list' && <button className="btn" type="button" disabled={Boolean(busy) || bulk.busy}
          onClick={beginPaste}><ClipboardPaste size={15} aria-hidden="true" />업무 붙여넣기</button>}
        <button className="btn btn-primary" onClick={event => beginCreate(createFromFilter, event.currentTarget)}><Plus size={16} /> 업무 만들기</button>
      </div>
    </div>
    {feedback && <p className={`issue-refresh-feedback${feedback === 'failed' ? ' issue-form-error' : ''}`}
      role={feedback === 'failed' ? 'alert' : 'status'}>{refreshMessages[feedback]}</p>}
    <div className="issue-toolbar">
      <div className="issue-view-switch" aria-label="업무 보기">
        <button className={view === 'list' ? 'active' : ''} disabled={bulk.busy} onClick={() => switchView('list')}><List size={16} /> 목록</button>
        <button className={view === 'board' ? 'active' : ''} disabled={bulk.busy} onClick={() => switchView('board')}><Columns3 size={16} /> 보드</button>
      </div>
      {projectSelected && view === 'board' && <label className="issue-board-group-picker">보드 그룹
        <select className="issue-filter" aria-label="보드 그룹" value={boardGrouping ?? ''} disabled={Boolean(busy)} onChange={event => {
          endBoardDrag();
          changeIssueLayout({ boardGrouping: event.currentTarget.value === 'assignee' ? 'assignee' : undefined });
        }}><option value="">그룹 없음</option><option value="assignee">담당자별</option></select>
      </label>}
      <div className="issue-search"><Search size={15} /><input aria-label="업무 검색" placeholder="제목, 번호, 속성 검색" value={query} disabled={bulk.locked} onChange={e => setQuery(e.target.value)} /></div>
      <IssueStatusFilter key={`statuses:${projectId}:${filterEditorEpoch}`} selected={selectedStatuses} options={statuses}
        allowMultiple={projectSelected} disabled={bulk.locked} onChange={updateStatusFilter} />
      <select className="issue-filter" aria-label="담당자 필터" value={assigneeSelection} disabled={bulk.locked}
        onChange={event => updateAssigneeFilter(event.currentTarget.value)}>
        <option value="all">모든 담당자</option><option value="current-user">현재 사용자</option><option value="none">미지정</option>
        {missingAssignee && <option value={assigneeSelection} disabled>현재 담당자 없음</option>}
        {data.users.map(user => <option key={user.id} value={`${assigneeMemberPrefix}${user.id}`}>{user.name}</option>)}
      </select>
      <IssueReporterFilterSelect filter={reporter} users={data.users} disabled={bulk.locked}
        onChange={next => updateProjectFilters({ reporter: next })} />
      <select className="issue-filter" aria-label="유형 필터" value={type} disabled={bulk.locked} onChange={e => setType(e.target.value)}><option value="all">모든 유형</option>{type !== 'all' && !issueTypes.some(item => item.id === type) && <option value={type}>{type} (저장된 조건)</option>}{issueTypes.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (보관됨)' : ''}</option>)}</select>
      <select className="issue-filter" aria-label="GitLab 조건" value={gitlab ?? ''} disabled={bulk.locked}
        onChange={event => updateProjectFilters({ gitlab: (event.target.value || undefined) as IssueViewGitlabFilter | undefined })}>
        <option value="">GitLab 전체</option>
        {Object.entries(ISSUE_GITLAB_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {showGitlabRefresh && <GitlabActivityRefresh refresh={refresh} notify={notify} disabled={bulk.locked} />}
      {order && !fieldSorted && !bulk.active && <button type="button" className="btn btn-ghost issue-order-toggle" aria-pressed={ordering} onClick={() => setOrderEditProject(ordering ? null : projectId)}><ArrowDownUp size={15} aria-hidden="true" /> 순서 편집</button>}
      {projectSelected && <button ref={bulkToggle} type="button" className="btn btn-ghost issue-bulk-toggle" aria-pressed={bulk.active}
        disabled={Boolean(busy) || bulk.busy} onClick={toggleBulkEdit}><ListChecks size={16} aria-hidden="true" />일괄 편집</button>}
      {activeFilters && <button className="btn btn-ghost issue-clear-filter" disabled={bulk.locked} onClick={clearFilters}><X size={14} /> 초기화</button>}
    </div>
    {projectSelected && <fieldset ref={filterEditors} className="issue-bulk-filter-controls" disabled={bulk.locked}>
      <IssueViewSort key={`sort:${projectId}:${filterEditorEpoch}`} value={sort} disabled={Boolean(busy || bulk.locked)} onChange={next => {
        if (next?.length) setOrderEditProject(null);
        setSort(next);
      }} />
      <IssuePriorityLabelFilters key={`priority-label:${projectId}:${filterEditorEpoch}`} issues={projectIssues}
        value={{ priorities, labels }} onApply={updateProjectFilters} />
      {(schema.fields.length > 0 || fieldFilter) && <IssueFieldFilters
        key={`fields:${projectId}:${filterEditorEpoch}`} schema={schema} users={data.users} value={fieldFilter}
        onApply={value => updateProjectFilters({ fieldFilter: value })} notify={notify} />}
      <IssuePlanningFilters key={`planning:${projectId}:${filterEditorEpoch}`} projectId={projectId} planningItems={planningItems}
        value={planning} onApply={value => updateProjectFilters({ planning: value })} />
    </fieldset>}
    <SavedViews projectId={projectId} project={project} actorId={props.actorId} planningItems={planningItems} statuses={statuses} users={data.users} views={projectViews} selectedId={savedViewId}
      current={currentView} latestConditionsPending={latestConditionsPending} onSelect={onChangeSavedView} onApply={applySharedView} onOpenGantt={onOpenGantt}
      onOpenFieldBreakdown={onOpenFieldBreakdown}
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
      </div> : !bulk.active && <span className="muted" id={groupedBoard ? groupingInstructions : undefined}>{groupedBoard ? '다른 담당자 행으로 끌면 담당자가 바뀝니다.' : order && !fieldSorted ? '카드를 끌어 순서와 상태 변경' : '카드를 끌어 상태 변경'}</span>}
    </div>
    {order && !fieldSorted && <div className={notice ? 'issue-order-feedback' : 'sr-only'}>
      <p className={notice?.error ? 'is-error' : ''} role="status" aria-label="업무 순서 상태">{notice?.text}</p>
      {notice?.needsRefresh && <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void refreshOrder()}>최신 업무 순서 불러오기</button>}
    </div>}
    {bulk.active && <>
      {view === 'board' && <div className="issue-board-bulk-controls issue-bulk-selection" ref={boardBulkControls} tabIndex={-1}>
        <IssueBulkSelectVisible editor={bulk} label="표시된 업무 전체 선택" />
      </div>}
      <IssueBulkEdit editor={bulk} statuses={statuses} users={data.users} onClose={closeBulkEdit} />
    </>}
    {!unavailableView && (view === 'list' ? <div className="issue-table-scroll" ref={listCanvas} role="region" aria-label="업무 목록" tabIndex={-1}><table className="issue-table"><thead><tr>{bulk.active && <th className="issue-bulk-selection"><IssueBulkSelectVisible editor={bulk} /></th>}<th className="issue-title-column">업무</th><th>상태</th><th>우선순위</th><th>담당자</th><th>종료일</th><th>라벨</th></tr></thead><tbody>{issues.map((issue, index) => {
      const user = data.users.find(u => u.id === issue.assigneeId);
      const current = statusMeta(data, issue.projectId, issue.status);
      const destinations = allowedNextStatuses(data, issue).filter(value => value.id !== issue.status);
      const statusLabelId = `issue-list-status-${encodeURIComponent(issue.id)}`;
      const selected = bulk.active && bulk.selectedIds.has(issue.id);
      return <tr key={issue.id} data-issue-id={issue.id} className={selected ? 'issue-bulk-selected' : undefined}>
        {bulk.active && <td className="issue-bulk-selection"><label className="issue-bulk-select-control"><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected}
          disabled={bulk.locked || (!selected && bulk.selectedCount >= ISSUE_BULK_EDIT_LIMIT)} onChange={() => bulk.toggle(issue)} /></label></td>}
        <td><button className="issue-title-button" onClick={event => openVisibleIssue(issue.id, event.currentTarget)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><span className="issue-title-text">{issue.title}</span><IssueTypeName data={data} issue={issue} /></button>
          <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} />
          <CustomFieldSummary data={data} issue={issue} limit={2} />
          <IssueGitlabSummary summary={gitlabSummary.get(issue.id)} />{controls(issue, issues, index)}</td>
        <td>{destinations.length ? <button className="btn btn-ghost issue-list-status-action" type="button"
          aria-label={`${issue.key} 상태 변경`} aria-describedby={statusLabelId} aria-haspopup="dialog" disabled={Boolean(busy) || bulk.active}
          onClick={event => openStatusEdit(issue, current, destinations, event.currentTarget)}>
          <StatusDot color={current.color} /><span id={statusLabelId}>{current.label}</span><ArrowRightLeft size={13} aria-hidden="true" />
        </button> : <span className="issue-status-select"><StatusDot color={current.color} />{current.label}</span>}</td>
        <td><span className="issue-priority"><PriorityIcon value={issue.priority} />{PRIORITY[issue.priority]}</span></td>
        <td>{user ? <span className="issue-assignee"><span className="issue-avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span>{user.name}</span> : <span className="muted">미지정</span>}</td>
        <td className="issue-date-cell">{dateLabel(issue.endDate || issue.dueDate)}</td>
        <td><div className="issue-labels">{issue.labels.slice(0, 2).map(l => <span className="issue-label" key={l}>{l}</span>)}{issue.labels.length > 2 && <span className="muted">+{issue.labels.length - 2}</span>}</div></td>
      </tr>;
    })}</tbody></table>{issues.length === 0 && <div className="issue-empty"><Circle size={28} /><h3>{activeFilters ? '조건에 맞는 업무가 없습니다' : '첫 업무를 만들어 보세요'}</h3><p>{activeFilters ? '검색어나 필터를 변경해 보세요.' : '계획과 실행의 시작을 이곳에 기록하세요.'}</p><button className="btn btn-primary" onClick={event => beginCreate(createFromFilter, event.currentTarget)}><Plus size={15} /> 업무 만들기</button></div>}</div> : <>
      <BoardCapacitySummary columns={[...capacities.values()]} open={openCapacity} />
      {selectedCapacity && <BoardCapacityDetails key={selectedCapacity.status.id} value={selectedCapacity}
        visibleIds={new Set(issues.map(issue => issue.id))} users={data.users} heading={capacityHeading}
        openIssue={onOpenBoardCapacityIssue ?? openIssue} close={closeCapacity} />}
      {groupedBoard ? <>
        <label className="issue-board-empty-toggle">
          <input type="checkbox" checked={showEmptyAssignees} onChange={event => changeIssueLayout({ showEmptyAssignees: event.currentTarget.checked })} />
          빈 담당자 그룹 표시
        </label>
        <div className="issue-board issue-board-grouped" ref={boardCanvas} role="region" aria-label="담당자별 보드"
          aria-describedby={bulk.active ? undefined : groupingInstructions} tabIndex={0}>
          <div className="issue-board-lane-columns issue-board-project-columns" role="group" aria-label="프로젝트 상태별 업무 수">
            {statuses.map(state => {
              const capacity = capacities.get(state.id);
              return <div key={state.id} className="issue-board-column" data-status-id={state.id} data-capacity={capacityState(capacity)}>
                {boardHeading(state, issues.filter(issue => issue.status === state.id).length, capacity)}
              </div>;
            })}
          </div>
          {lanes.map(lane => <section className="issue-board-lane" key={lane.id === null ? 'unassigned' : `assignee:${lane.id}`}
            aria-label={lane.email ? `${lane.name} · ${lane.email}` : lane.name} data-board-assignee-id={lane.id ?? ''}>
            <h3 className="issue-board-lane-heading">
              {lane.color && <span className="issue-avatar" aria-hidden="true" style={{ background: lane.color }}>{lane.name.slice(0, 1)}</span>}
              <span className="issue-board-lane-person"><strong>{lane.name}</strong>{lane.email && <small>{lane.email}</small>}</span>
              <span className="issue-board-lane-count">{lane.issues.length.toLocaleString()}개</span>
            </h3>
            <div className="issue-board-lane-columns">
              {statuses.map(state => boardColumn(state, lane.issues, lane))}
            </div>
          </section>)}
        </div>
      </> : <div className="issue-board" ref={boardCanvas} role="region" aria-label="업무 보드" tabIndex={-1}>{statuses.map(state => boardColumn(state, issues))}</div>}
    </>)}
    {project && pasteScope === currentPasteScope && <IssuePasteDialog project={project} actorId={props.actorId}
      refresh={refresh} notify={notify} onClose={() => setPasteScope(null)} />}
    {creation && <NewIssueModal {...props} initialStatus={creation.status} initialBoardAssigneeId={creation.assigneeId} onClose={closeCreation} />}
    {statusEdit && <IssueStatusDialog edit={statusEdit} actorId={props.actorId} latest={data} refresh={refresh} notify={notify} onClose={closeStatusEdit}
      onOpenDetails={() => {
        const opener = view === 'board' ? boardCardControl(boardCanvas.current, statusEdit.issue.id, 'details')
          : issueListControl(listCanvas.current, statusEdit.issue.id, 'details');
        openVisibleIssue(statusEdit.issue.id, opener ?? statusEdit.opener);
      }} />}
  </div>;
}
