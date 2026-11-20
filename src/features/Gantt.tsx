'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { AlertCircle, ArrowRight, BarChart3, CalendarClock, CalendarDays, CalendarRange, ChartNoAxesCombined, Check, ClipboardPaste, Diamond, Layers3, Link2, MoveHorizontal, Pencil, Plus, Search, Sparkles, Undo2, X } from 'lucide-react';
import type { CustomFieldValue, Dependency, FeatureProps, Issue, PlanningItem, PlanningKind, Project, SchedulePreview, User } from '../../shared/types';
import { isTerminalStatus, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS, statusMeta } from '../../shared/workflow-helpers';
import { createCalendarMath, defaultWorkCalendar } from '../../shared/calendar';
import { analyzeProjectSchedule } from '../../shared/schedule-analysis';
import { DEPENDENCY_ENDPOINTS, DEPENDENCY_TYPES, dependencyScheduleWarning, SCHEDULE_DATE_LABELS } from '../../shared/schedule-dependencies';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { afterAcceptedNavigation } from '../lib/navigation';
import { ApiError, patch, post, remove } from '../lib/api';
import { issueSearchText, projectIssueSchema, requiredFieldLabels } from '../../shared/issue-schema';
import { createIssueViewMatcher } from '../../shared/issue-view';
import { planningFields } from '../../shared/planning-helpers';
import { issuePlanningFilterLabels } from './issue-planning-filter-labels';
import { CustomFields, initialIssueType, IssueTypeName, IssueTypeSelect } from './CustomFields';
import { PlanningSelect, PLAN_LABELS } from './PlanningSelectors';
import { IssueTypeIcon } from './Issues';
import { buildIssueHierarchy, IssueHierarchyContext } from './IssueHierarchyContext';
import { dayNumber, dependencyLabel, errorMessage, isoDay, moveDate, todayDate } from './schedule-utils';
import { AutomaticScheduleDialog } from './AutomaticScheduleDialog';
import { SchedulePlanningPanel } from './SchedulePlanningPanel';
import { ScheduleAnalysis } from './ScheduleAnalysis';
import { SchedulePasteDialog } from './SchedulePasteDialog';
import { GanttPlanningControls } from './GanttPlanningControls';
import { GanttPlanAssignment } from './GanttPlanAssignment';
import { PlanScheduleShiftDialog } from './PlanScheduleShiftDialog';
import { ProjectWorkload, WorkloadPreviewSummary } from './ProjectWorkload';
import { TeamWorkload } from './TeamWorkload';
import { TimeReservations } from './TimeReservations';
import { PROJECT_CAPACITY_DRAFT, TEAM_CAPACITY_DRAFT } from './WorkloadCapacityEditor';
import { GanttDependencyModal, type DependencyInput, type DependencyPrefill } from './GanttDependencyModal';
import { GanttLinkEndpoints, GanttLinkPrompt, type GanttLinkEndpoint } from './GanttLinkPicker';
import './issues.css';
import './gantt.css';

type ApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
type DragMode = 'move' | 'start' | 'end';
type DragState = { issue: Issue; initialX: number; delta: number; mode: DragMode };
type TrackDraft = (id: string, dirty: boolean, pending?: boolean) => void;
type GanttProps = FeatureProps & {
  initialPlanningId?: string | null;
  onOpenPlanning?: (id: string) => void;
  ganttViewId?: string | null;
  onChangeGanttView?: (id: string | null) => boolean;
  focusIssueId?: string | null;
  issueFocusActivation?: number;
  issueOverlayOpen?: boolean;
  onClearIssueFocus?: () => boolean;
};
type PlanAssignmentInput = { item: PlanningItem; issues: Issue[] };
type DependencyEditor = { dependency?: Dependency; prefill?: DependencyPrefill; opener: HTMLButtonElement };
type LinkPick = { issueId: string; endpoint: GanttLinkEndpoint; explicit: boolean };
type TimelineRange = { start: number; end: number };
type IssueRow = { issue: Issue; index: number };
const PLANNING_KINDS: PlanningKind[] = ['cycle', 'module', 'release'];
const LEFT_WIDTH = 538;
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 62;
const BAR_EDGE_INSET = 2;
const MAX_TIMELINE_DAYS = 180;
const ANALYSIS_PANEL_ID = 'gantt-schedule-analysis';
const TIME_RESERVATIONS_DRAFT = 'time-reservations';
const MIN_TIMELINE_DAY = dayNumber('0000-01-01'), MAX_TIMELINE_DAY = dayNumber('9999-12-31');

const clampWindowStart = (day: number) => Math.max(MIN_TIMELINE_DAY, Math.min(MAX_TIMELINE_DAY - MAX_TIMELINE_DAYS + 1, day));
const windowForDate = (date: string) => isoDay(clampWindowStart(dayNumber(date) - 7));

function scrollTimelineDate(scroll: HTMLDivElement, offset: number, behavior: ScrollBehavior = 'auto') {
  const header = scroll.querySelector('.gantt-left-header');
  if (!header) return;
  const pinned = getComputedStyle(header).position === 'sticky';
  scroll.scrollTo({ left: Math.max(0, offset + (pinned ? -72 : LEFT_WIDTH - 44)), behavior });
}

function focusGanttDate(chart: Element | null, issueId: string, edge: 'start' | 'end', block: ScrollLogicalPosition = 'center') {
  const input = chart?.querySelector<HTMLInputElement>(`input[data-schedule-owner="${CSS.escape(issueId)}"][data-schedule-edge="${edge}"]`);
  if (!input || input.disabled) return;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block, inline: 'nearest' });
}

function focusDateFromControl(control: HTMLButtonElement, issue: Issue, edge: 'start' | 'end' = issue.startDate ? 'end' : 'start') {
  focusGanttDate(control.closest('.gantt-feature'), issue.id, edge);
}

export function Gantt(props: GanttProps) {
  return <ProjectGantt key={`${props.projectId}:${props.actorId}:${props.initialPlanningId ?? ''}`} {...props} />;
}

function ProjectGantt(props: GanttProps) {
  const { data, projectId, refresh, notify, openIssue, initialPlanningId, ganttViewId = null, onChangeGanttView,
    focusIssueId, issueFocusActivation = 0, issueOverlayOpen, onClearIssueFocus } = props;
  const focusedIssue = focusIssueId ? data.issues.find(issue => issue.id === focusIssueId && issue.projectId === projectId) : undefined;
  const focusedDate = focusedIssue?.startDate || focusedIssue?.endDate;
  const focusRequest = focusIssueId ? JSON.stringify([focusIssueId, issueFocusActivation]) : null;
  const projectPlans = useMemo(() => (data.planningItems ?? []).filter(item => item.projectId === projectId), [data.planningItems, projectId]);
  const initialPlan = projectPlans.find(item => item.id === initialPlanningId);
  const [planningExpanded, setPlanningExpanded] = useState(Boolean(initialPlan));
  const [selectedPlanningId, setSelectedPlanningId] = useState<string | null>(initialPlan?.id ?? null);
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [planAssignment, setPlanAssignment] = useState<PlanAssignmentInput | null>(null);
  const [planShift, setPlanShift] = useState<PlanningItem | null>(null);
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState<'day' | 'week' | 'month'>('day');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionViewId, setSelectionViewId] = useState(ganttViewId);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduleWarnings, setScheduleWarnings] = useState<string[]>([]);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [days, setDays] = useState(5);
  const [workingDays, setWorkingDays] = useState(true);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [linkEditor, setLinkEditor] = useState<DependencyEditor | null>(null);
  const [linkPicker, setLinkPicker] = useState<{ source: LinkPick | null } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [workloadView, setWorkloadView] = useState<'project' | 'team' | null>(null);
  const [reservationsOpen, setReservationsOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [selectedBaselineId, setSelectedBaselineId] = useState<string | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [previousFocusRequest, setPreviousFocusRequest] = useState(focusRequest);
  const [windowStart, setWindowStart] = useState<string | null>(() => {
    const date = focusedDate || (initialPlan && (initialPlan.startDate || initialPlan.targetDate || initialPlan.endDate));
    return date ? windowForDate(date) : null;
  });
  if (previousFocusRequest !== focusRequest) {
    setPreviousFocusRequest(focusRequest);
    if (focusedIssue) {
      setQuery('');
      setHideDone(false);
      setLinkedOnly(false);
      setLinkPicker(null);
      setDrag(null);
      setWindowStart(focusedDate ? windowForDate(focusedDate) : null);
    }
  }
  if (selectionViewId !== ganttViewId) {
    setSelectionViewId(ganttViewId);
    if (selected.size) setSelected(new Set());
    if (shiftOpen) setShiftOpen(false);
    if (autoOpen) setAutoOpen(false);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledFocusRequest = useRef<string | null>(null);
  const analysisTrigger = useRef<HTMLButtonElement>(null);
  const linkPickerTrigger = useRef<HTMLButtonElement>(null);
  const linkEditorFocusTarget = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(false), previewRef = useRef<SchedulePreview | null>(null);
  const draftsRef = useRef(new Map<string, { dirty: boolean; pending: boolean }>());
  useEffect(() => { previewRef.current = preview; }, [preview]);
  useEffect(() => {
    if (busy || linkEditor || !linkEditorFocusTarget.current) return;
    const opener = linkEditorFocusTarget.current;
    linkEditorFocusTarget.current = null;
    if (opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    else scrollRef.current?.focus({ preventScroll: true });
  }, [busy, linkEditor]);
  const trackDraft = useCallback((id: string, dirty: boolean, pending = false) => { if (dirty || pending) draftsRef.current.set(id, { dirty, pending }); else draftsRef.current.delete(id); }, []);
  const trackReservationDraft = useCallback((dirty: boolean, pending: boolean) => trackDraft(TIME_RESERVATIONS_DRAFT, dirty, pending), [trackDraft]);
  function markBusy(value: boolean) { busyRef.current = value; setBusy(value); }
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current || [...draftsRef.current.values()].some(value => value.pending)) { event.preventDefault(); notify('일정 변경이 끝난 뒤 이동해 주세요.', 'error'); }
      else if (previewRef.current || [...draftsRef.current.values()].some(value => value.dirty)) {
        if (!window.confirm('저장하지 않은 간트 입력과 미리보기를 버리고 이동할까요?')) event.preventDefault();
        else {
          const discardPaste = draftsRef.current.has('schedule-paste');
          const discardPlanShift = draftsRef.current.has('plan-schedule-shift');
          afterAcceptedNavigation(event, () => {
            previewRef.current = null;
            draftsRef.current.clear();
            setPreview(null); setPreviewError(''); setCreateOpen(false); setLinkEditor(null); setLinkPicker(null); setShiftOpen(false); setDrag(null); setPlanAssignment(null);
            if (discardPaste) setPasteOpen(false);
            if (discardPlanShift) setPlanShift(null);
            setDraftEpoch(value => value + 1);
          });
        }
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (busyRef.current || previewRef.current || draftsRef.current.size) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [notify]);
  function canLeave() { return window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })); }
  function toggleWorkload(view: 'project' | 'team') {
    const activeDraft = workloadView === 'team' ? TEAM_CAPACITY_DRAFT : PROJECT_CAPACITY_DRAFT;
    if (workloadView && (draftsRef.current.has(activeDraft) || draftsRef.current.has('workload-level')) && !canLeave()) return;
    setWorkloadView(workloadView === view ? null : view);
  }
  function canOpenWorkloadLevel() {
    if (!busyRef.current && ![...draftsRef.current.values()].some(value => value.pending)) return true;
    notify('일정 변경이 끝난 뒤 다시 시도해 주세요.', 'error');
    return false;
  }
  async function onWorkloadLevelApplied(result: ApplyResult) {
    setUndoId(result.undoId);
    setScheduleWarnings(result.warnings || []);
    await refresh();
    notify(`과부하를 줄이는 ${result.updated.length}개 업무의 일정을 적용했습니다.`);
  }
  const projectIssues = useMemo(() => data.issues.filter(i => (!projectId || projectId === 'all' || i.projectId === projectId)), [data.issues, projectId]);
  const hierarchy = useMemo(() => buildIssueHierarchy(projectIssues), [projectIssues]);
  const projectDependencyCount = useMemo(() => {
    const issueIds = new Set(projectIssues.map(issue => issue.id));
    return data.dependencies.reduce((count, dependency) =>
      count + Number(issueIds.has(dependency.predecessorId) && issueIds.has(dependency.successorId)), 0);
  }, [data.dependencies, projectIssues]);
  const hasProject = data.projects.some(project => project.id === projectId);
  const sharedViews = useMemo(() => (data.savedViews ?? []).filter(view => view.projectId === projectId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko')), [data.savedViews, projectId]);
  const sharedView = sharedViews.find(view => view.id === ganttViewId);
  const sharedViewUnavailable = ganttViewId !== null && !sharedView;
  const sharedPlanningFilter = sharedView?.filters.planning;
  const sharedPlanningLabels = issuePlanningFilterLabels(sharedPlanningFilter, projectPlans);
  const sharedDateFilter = sharedPlanningFilter?.dates;
  const overlapAnchor = sharedDateFilter?.mode === 'overlap' ? sharedDateFilter.from ?? sharedDateFilter.to : undefined;
  const matchSharedView = sharedView ? createIssueViewMatcher(sharedView.filters, data, projectIssueSchema(data, projectId)) : null;
  const selectedPlan = projectPlans.find(item => item.id === selectedPlanningId);
  const shiftPlan = planShift && (projectPlans.find(item => item.id === planShift.id) ?? planShift);
  const planningScope = planningExpanded && linkedOnly ? selectedPlan : undefined;
  const planningRows = planningExpanded ? projectPlans.filter(item => planningScope ? item.id === planningScope.id : item.status !== 'archived' || item.id === selectedPlanningId) : [];
  const planStats = useMemo(() => planMembershipStats(projectPlans, projectIssues), [projectPlans, projectIssues]);
  function locallyVisibleIssues(text: string, hideTerminal: boolean, scope?: PlanningItem) {
    const search = text.toLowerCase();
    return projectIssues.filter(issue => (!scope || issue[planningFields(scope.kind).idField] === scope.id) &&
      (!hideTerminal || !isTerminalStatus(data, issue.projectId, issue.status)) &&
      (!search || issueSearchText(data, issue).toLowerCase().includes(search)));
  }
  function sharedViewRows(rows: Issue[]) {
    if (sharedViewUnavailable) return [];
    return matchSharedView ? rows.filter(matchSharedView) : rows;
  }
  const issues = sharedViewRows(locallyVisibleIssues(query, hideDone, planningScope));
  const baseline = data.baselines?.find(value => value.id === selectedBaselineId && value.projectId === projectId);
  const milestones = useMemo(() => (data.milestones || []).filter(value => value.projectId === projectId), [data.milestones, projectId]);
  const historicalIssues = planningScope || ganttViewId !== null ? [] : baseline?.issues.filter(value => !projectIssues.some(issue => issue.id === value.issueId)) || [];
  const historicalMilestones = baseline?.milestones.filter(value => !milestones.some(milestone => milestone.id === value.milestoneId)) || [];
  const calendar = useMemo(() => data.calendars?.find(value => value.projectId === projectId) ?? defaultWorkCalendar(projectId), [data.calendars, projectId]);
  const calendarMath = useMemo(() => createCalendarMath(calendar), [calendar]);
  const analysisResult = useMemo(() => {
    if (!analysisOpen || !hasProject) return null;
    try {
      const analysis = analyzeProjectSchedule({
        projectId, issues: projectIssues, dependencies: data.dependencies,
        calendar, workflow: projectWorkflow({ workflows: data.workflows }, projectId),
      });
      return {
        analysis, error: '',
        criticalIssueIds: new Set(analysis.tasks.filter(task => task.critical).map(task => task.issueId)),
        criticalDependencyIds: new Set(analysis.criticalDependencyIds),
      };
    } catch (cause) {
      return { analysis: null, error: errorMessage(cause) };
    }
  }, [analysisOpen, hasProject, projectId, projectIssues, data.dependencies, calendar, data.workflows]);
  const extent = (() => {
    const today = dayNumber(todayDate());
    const dates = [...projectIssues.flatMap(value => [value.startDate, value.endDate]), ...planningRows.flatMap(value => [value.startDate, value.endDate, value.targetDate]), ...milestones.map(value => value.date), ...(baseline?.issues.flatMap(value => [value.startDate, value.endDate]) || []), ...(baseline?.milestones.map(value => value.date) || [])].filter((value): value is string => Boolean(value)).map(dayNumber).filter(Number.isFinite);
    const start = Math.min(today - 7, ...dates) - 2, end = Math.max(today + 35, ...dates) + 3;
    return { start, end, days: end - start + 1 };
  })();
  const defaultRangeStart = overlapAnchor
    ? dayNumber(windowForDate(overlapAnchor))
    : clampWindowStart(extent.days <= MAX_TIMELINE_DAYS ? extent.start : dayNumber(todayDate()) - 9);
  const requestedStart = windowStart ? dayNumber(windowStart) : defaultRangeStart;
  const rangeStart = Number.isFinite(requestedStart) ? clampWindowStart(requestedStart) : defaultRangeStart;
  const rangeDays = windowStart || overlapAnchor || extent.days > MAX_TIMELINE_DAYS ? MAX_TIMELINE_DAYS : extent.days;
  const range = { start: rangeStart, end: rangeStart + rangeDays - 1, days: rangeDays };
  const dayWidth = zoom === 'day' ? 32 : zoom === 'week' ? 15 : 6;
  const timelineWidth = range.days * dayWidth;
  useLayoutEffect(() => {
    if (handledFocusRequest.current === focusRequest) return;
    const frame = requestAnimationFrame(() => {
      handledFocusRequest.current = focusRequest;
      const scroll = scrollRef.current;
      const row = scroll?.querySelector<HTMLDivElement>('[data-focused-issue="true"]');
      if (!focusedIssue || !scroll || !row) return;

      const { id, startDate, endDate } = focusedIssue;
      if (!issueOverlayOpen) scroll.scrollIntoView({ block: 'start', inline: 'nearest' });
      scroll.scrollTop = row.offsetTop - HEADER_HEIGHT;
      if (startDate && endDate) {
        scrollTimelineDate(scroll, (dayNumber(startDate) - range.start) * dayWidth);
        if (!issueOverlayOpen) row.querySelector<HTMLButtonElement>('.gantt-bar')?.focus({ preventScroll: true });
      } else if (!issueOverlayOpen) {
        focusGanttDate(scroll, id, startDate ? 'end' : 'start', 'nearest');
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [dayWidth, focusRequest, focusedIssue, issueOverlayOpen, range.start]);
  const selectedIssues = issues.filter(i => selected.has(i.id));
  const automaticScheduleIssues = selectedIssues.length ? selectedIssues : planningScope ? issues : [];
  const issueRows = new Map(issues.map((issue, index) => [issue.id, { issue, index }]));
  const visibleProjectCounts = new Map<string, number>();
  for (const issue of issues) visibleProjectCounts.set(issue.projectId, (visibleProjectCounts.get(issue.projectId) ?? 0) + 1);
  const hasLinkPair = (id: string) => (visibleProjectCounts.get(id) ?? 0) >= 2;
  const candidateSource = linkPicker?.source;
  const candidateRow = candidateSource ? issueRows.get(candidateSource.issueId) : undefined;
  const sourceRow = candidateRow && hasLinkPair(candidateRow.issue.projectId) ? candidateRow : undefined;
  const pickedSource = sourceRow ? candidateSource : undefined;
  if (candidateSource && !sourceRow) setLinkPicker({ source: null });
  const linkStep = pickedSource ? '후행' : '선행';
  const hasVisibleLinkPair = [...visibleProjectCounts.values()].some(count => count >= 2);
  const canPickLink = !busy && hasVisibleLinkPair;
  const dependencies = data.dependencies.flatMap(dependency => {
    const predecessor = issueRows.get(dependency.predecessorId);
    const successor = issueRows.get(dependency.successorId);
    return predecessor && successor ? [{ dependency, predecessor, successor }] : [];
  });
  const unscheduled = issues.filter(i => !i.startDate || !i.endDate);
  const ticks = Array.from({ length: rangeDays }, (_, index) => {
    const day = rangeStart + index;
    const date = new Date(day * 86_400_000);
    return { day, date, iso: isoDay(day), index, weekday: date.getUTCDay() };
  });
  const todayPosition = (dayNumber(todayDate()) - range.start) * dayWidth;
  const chartRowCount = planningRows.length + issues.length + historicalIssues.length + milestones.length + historicalMilestones.length;
  function canHideRows(nextIssues: Issue[]) {
    const visibleIds = new Set(nextIssues.map(issue => issue.id));
    return ![...draftsRef.current.keys()].some(id => id.startsWith('dates:') && !visibleIds.has(id.slice(6))) || canLeave();
  }
  function changeVisibility(nextQuery: string, nextHideDone: boolean) {
    if (!canHideRows(sharedViewRows(locallyVisibleIssues(nextQuery, nextHideDone, planningScope)))) return;
    setQuery(nextQuery); setHideDone(nextHideDone);
  }
  function setPlanningFilter(only: boolean) {
    if (canHideRows(sharedViewRows(locallyVisibleIssues(query, hideDone, only ? selectedPlan : undefined)))) setLinkedOnly(only);
  }
  function scrollToDate(date: number, start: number, behavior: ScrollBehavior = 'auto') {
    const offset = (date - start) * dayWidth;
    requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      if (scroll) scrollTimelineDate(scroll, offset, behavior);
    });
  }
  function showDate(date: string) {
    const start = windowForDate(date);
    setWindowStart(start);
    scrollToDate(dayNumber(date), dayNumber(start));
  }
  function locateAnalysisDate(date: string, rowIndex?: number) {
    showDate(date);
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollIntoView({ block: 'start', inline: 'nearest' });
    scroll.focus({ preventScroll: true });
    if (rowIndex !== undefined) scroll.scrollTop = (planningRows.length + rowIndex) * ROW_HEIGHT;
  }
  function locateAnalysisIssue(issueId: string) {
    const row = issueRows.get(issueId);
    if (row?.issue.startDate) locateAnalysisDate(row.issue.startDate, row.index);
  }
  function choosePlan(id: string | null) {
    setSelectedPlanningId(id);
    if (!id) { setLinkedOnly(false); return; }
    const item = projectPlans.find(plan => plan.id === id);
    const date = item && (item.startDate || item.targetDate || item.endDate);
    if (date && outside(date)) showDate(date);
  }
  function outside(date: string) { const day = dayNumber(date); return day < range.start || day > range.end; }
  function capturedStyle(startDate: string, endDate: string): CSSProperties { const start = Math.max(range.start, dayNumber(startDate)), end = Math.min(range.end, dayNumber(endDate)); return end < start ? { display: 'none' } : { left: (start - range.start) * dayWidth + 2, width: Math.max(3, (end - start + 1) * dayWidth - 4) }; }

  function toggleSelected(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function requestPreview(ids: string[], offset: number, skipWeekends: boolean) {
    if (!ids.length) { notify('이동할 업무를 먼저 선택하세요.', 'error'); return; }
    if (!Number.isInteger(offset) || offset === 0) { notify('0이 아닌 정수 일수를 입력하세요.', 'error'); return; }
    markBusy(true);
    try { const result = await post<SchedulePreview>('/schedule/preview', { issueIds: ids, days: offset, workingDays: skipWeekends }); setPreview(result); setPreviewError(''); setShiftOpen(false); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); }
  }
  async function applyChanges(value: SchedulePreview) {
    if (!value.changes.length || busyRef.current) return null; markBusy(true); setPreviewError('');
    try {
      const result = await post<ApplyResult>('/schedule/apply', { changes: value.changes.map(change => ({ id: change.id, expectedVersion: change.version, startDate: change.toStart, endDate: change.toEnd })), ...(value.calendarVersions ? { calendarVersions: value.calendarVersions } : {}) });
      setUndoId(result.undoId); setPreview(null); setScheduleWarnings(result.warnings || []); await refresh(); notify(`${value.changes.length}개 업무의 일정을 변경했습니다.${result.warnings?.length ? ' 의존성 경고를 확인하세요.' : ''}`);
      return result;
    } catch (err) { if (preview) setPreviewError(errorMessage(err)); notify(errorMessage(err), 'error'); return null; } finally { markBusy(false); }
  }
  async function saveDates(issue: Issue, startDate: string | null, endDate: string | null) {
    if (startDate === issue.startDate && endDate === issue.endDate) return issue;
    if (startDate && endDate && startDate > endDate) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return null; }
    if (busyRef.current) { notify('진행 중인 일정 변경이 끝난 뒤 다시 시도하세요.', 'error'); return null; }
    const result = await applyChanges({ changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version, fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate }], warnings: [] });
    return result?.updated.find(value => value.id === issue.id) || null;
  }
  async function undo() {
    if (!undoId) return; markBusy(true);
    try {
      const result = await post<{ updated: Issue[]; warnings?: string[]; plan?:PlanningItem; dependencyChanges?:number }>('/schedule/undo', { undoId });
      setUndoId(null); setScheduleWarnings(result.warnings || []);
      await refresh();
      const date = result.plan && (result.plan.startDate ?? result.plan.targetDate ?? result.plan.endDate);
      if (date && result.plan?.id === selectedPlanningId && outside(date)) showDate(date);
      if (result.plan) notify('계획과 연결 업무의 일정 변경을 되돌렸습니다.');
      else if (result.dependencyChanges) notify(result.updated.length ? '일정과 업무 연결 변경을 되돌렸습니다.' : '업무 연결 변경을 되돌렸습니다.');
      else notify('마지막 일정 변경을 되돌렸습니다.');
    }
    catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); }
  }
  function showLinkEditor(opener: HTMLButtonElement, dependency?: Dependency, prefill?: DependencyPrefill) {
    if (!canLeave()) return;
    // An accepted draft discard is queued by the navigation guard first.
    queueMicrotask(() => {
      setLinkPicker(null);
      setLinkEditor({ dependency, prefill, opener });
    });
  }
  function cancelLinkPicking() {
    setLinkPicker(null);
    requestAnimationFrame(() => {
      const trigger = linkPickerTrigger.current;
      if (trigger && !trigger.disabled) trigger.focus({ preventScroll: true });
      else scrollRef.current?.focus({ preventScroll: true });
    });
  }
  function toggleLinkPicking() {
    if (linkPicker) { cancelLinkPicking(); return; }
    if (!canPickLink || !canLeave()) return;
    queueMicrotask(() => {
      setDrag(null);
      setLinkEditor(null);
      setLinkPicker({ source: null });
    });
  }
  function pickLink(issueId: string, endpoint: GanttLinkEndpoint, explicit: boolean) {
    const target = issueRows.get(issueId)?.issue;
    if (!linkPicker || !canPickLink || !target || !hasLinkPair(target.projectId)) return;
    if (!pickedSource) {
      setLinkPicker({ source: { issueId, endpoint, explicit } });
      const previousFocus = document.activeElement;
      if (scrollRef.current?.contains(previousFocus)) requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement === previousFocus) {
          scrollRef.current?.querySelector<HTMLButtonElement>('.gantt-link-pick-row .gantt-issue-name:not(:disabled)')?.focus({ preventScroll: true });
        }
      });
      return;
    }
    const opener = linkPickerTrigger.current;
    if (!opener || pickedSource.issueId === issueId || target.projectId !== sourceRow?.issue.projectId) return;
    const predecessorId = pickedSource.issueId;
    const dependency = data.dependencies.find(link => link.predecessorId === predecessorId && link.successorId === issueId);
    const type = DEPENDENCY_TYPES.find(value => DEPENDENCY_ENDPOINTS[value].predecessor === pickedSource.endpoint &&
      DEPENDENCY_ENDPOINTS[value].successor === endpoint);
    showLinkEditor(opener, dependency, { predecessorId, successorId: issueId, type: !dependency || pickedSource.explicit || explicit ? type : undefined });
  }
  function closeLinkEditor() {
    linkEditorFocusTarget.current = linkEditor?.opener ?? null;
    setLinkEditor(null);
  }
  async function refreshAfterDependencyChange(message: string) {
    try {
      await refresh();
      notify(message);
    } catch (err) {
      notify(`${message} 최신 목록을 불러오지 못했습니다. ${errorMessage(err)}`, 'error');
    }
  }
  async function saveDependency(input: DependencyInput) {
    if (busyRef.current) return;
    const dependency = linkEditor?.dependency;
    markBusy(true);
    try {
      if (dependency) {
        const { type, lagDays } = input;
        await patch(`/dependencies/${encodeURIComponent(dependency.id)}`, { expectedVersion: dependency.version ?? 1, type, lagDays });
      } else {
        await post('/dependencies', input);
      }
      await refreshAfterDependencyChange(dependency ? '업무 연결을 수정했습니다.' : '선행·후행 업무를 연결했습니다.');
      closeLinkEditor();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) await refresh().catch(() => {});
      throw err;
    } finally {
      markBusy(false);
    }
  }
  async function unlink(dependency: Dependency) {
    if (busyRef.current) return;
    markBusy(true);
    try {
      await remove(`/dependencies/${encodeURIComponent(dependency.id)}?expectedVersion=${dependency.version ?? 1}`);
      await refreshAfterDependencyChange('선행·후행 연결을 해제했습니다.');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) await refresh().catch(() => {});
      notify(errorMessage(err), 'error');
    } finally {
      markBusy(false);
    }
  }
  function goToToday() {
    const date = todayDate();
    if (outside(date)) showDate(date);
    else scrollToDate(dayNumber(date), range.start, 'smooth');
  }
  function previewResize(issue: Issue, edge: 'start' | 'end', delta: number) {
    if (!issue.startDate || !issue.endDate || !delta) return;
    const toStart = edge === 'start' ? moveDate(issue.startDate, delta) : issue.startDate;
    const toEnd = edge === 'end' ? moveDate(issue.endDate, delta) : issue.endDate;
    if (toStart > toEnd) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    const warnings: string[] = [];
    const changed = { ...issue, startDate: toStart, endDate: toEnd };
    const issueMath = issue.projectId === projectId ? calendarMath
      : createCalendarMath(data.calendars?.find(value => value.projectId === issue.projectId) ?? defaultWorkCalendar(issue.projectId));
    for (const dependency of data.dependencies.filter(value => value.predecessorId === issue.id || value.successorId === issue.id)) {
      const predecessor = dependency.predecessorId === issue.id ? changed : data.issues.find(value => value.id === dependency.predecessorId);
      const successor = dependency.successorId === issue.id ? changed : data.issues.find(value => value.id === dependency.successorId);
      if (!predecessor || !successor) continue;
      const warning = dependencyScheduleWarning(dependency, predecessor, successor, issueMath);
      if (warning) warnings.push(warning);
    }
    setPreview({ changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version, fromStart: issue.startDate, fromEnd: issue.endDate, toStart, toEnd }], warnings }); setPreviewError('');
  }
  function beginDrag(event: PointerEvent<HTMLButtonElement>, issue: Issue, mode: DragMode) {
    if (event.button !== 0 || busy) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ issue, initialX: event.clientX, delta: 0, mode });
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    let delta = Math.round((event.clientX - drag.initialX) / dayWidth);
    const duration = dayNumber(drag.issue.endDate!) - dayNumber(drag.issue.startDate!);
    if (drag.mode === 'start') delta = Math.min(delta, duration);
    if (drag.mode === 'end') delta = Math.max(delta, -duration);
    setDrag({ ...drag, delta });
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return; const current = drag; setDrag(null);
    if (current.delta) { if (current.mode === 'move') void requestPreview([current.issue.id], current.delta, false); else previewResize(current.issue, current.mode, current.delta); }
    else if (current.mode === 'move') openIssue(current.issue.id);
    else focusDateFromControl(event.currentTarget, current.issue, current.mode);
  }
  const months = ticks.filter(t => t.date.getUTCDate() === 1 || t.index === 0);

  return <div className="gantt-feature" onKeyDown={event => {
    if (linkPicker && !event.defaultPrevented && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelLinkPicking();
    }
  }}>
    <div className="feature-heading"><div><div className="feature-eyebrow">PLAN WITH CLARITY</div><h1>일정 · 간트</h1><p>업무와 일정이 하나로. 직접 입력하고, 연결하고, 함께 조정하세요.</p></div><div className="gantt-heading-actions">
      <button className="btn" type="button" aria-expanded={workloadView === 'project'} disabled={!hasProject} onClick={() => toggleWorkload('project')}><BarChart3 size={15} />담당자 작업량</button>
      <button className="btn" type="button" aria-expanded={workloadView === 'team'} disabled={!data.projects.length} onClick={() => toggleWorkload('team')}><Layers3 size={15} />프로젝트 간 작업량</button>
      <button className="btn" type="button" aria-expanded={reservationsOpen} disabled={!hasProject || busy} onClick={() => {
        if (reservationsOpen && draftsRef.current.has(TIME_RESERVATIONS_DRAFT) && !canLeave()) return;
        setReservationsOpen(!reservationsOpen);
      }}><CalendarClock size={15} aria-hidden="true" />시간 배정</button>
      <button className="btn" disabled={busy || !hasProject} onClick={() => { if (canLeave()) setPasteOpen(true); }}><ClipboardPaste size={15} />일정 붙여넣기</button><button className="btn" disabled={busy || sharedViewUnavailable || Boolean(planningScope && !automaticScheduleIssues.length)} onClick={() => { if (canLeave()) setAutoOpen(true); }}><Sparkles size={15} />자동 일정</button><button className="btn" type="button" disabled={busy} onClick={event => showLinkEditor(event.currentTarget)}><Link2 size={16} /> 업무 연결</button><button className="btn btn-primary" onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={16} /> 업무 추가</button></div></div>
    {reservationsOpen && hasProject && <TimeReservations key={draftEpoch} projectId={projectId} issues={projectIssues}
      initialIssue={selectedIssues.length === 1 ? selectedIssues[0] : undefined} actorId={props.actorId} users={data.users}
      notify={notify} openIssue={openIssue} onDraftChange={trackReservationDraft} onChanged={refresh} />}
    <div className="gantt-stats"><div><span className="gantt-stat-dot" /><strong>{projectIssues.filter(i => i.startDate && i.endDate).length}</strong><span>일정이 잡힌 업무</span></div><div><span className="gantt-stat-dot is-empty" /><strong>{projectIssues.filter(i => !i.startDate || !i.endDate).length}</strong><span>일정 미정</span></div><div><Link2 size={13} /><strong>{projectDependencyCount}</strong><span>업무 연결</span></div><span className="gantt-manual-badge">직접 계획 · 자동 제안</span></div>
    {hasProject && onChangeGanttView && (sharedViews.length > 0 || sharedViewUnavailable) && <div className="gantt-shared-view">
      <label className="gantt-shared-view-select">간트 공유 보기
        <select className="field" value={ganttViewId ?? ''} disabled={busy} onChange={event => onChangeGanttView(event.target.value || null)}>
          <option value="">공유 보기 없이 표시</option>
          {sharedViewUnavailable && <option value={ganttViewId ?? ''}>열 수 없는 공유 보기</option>}
          {sharedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
      </label>
      {sharedView && <span role="status" aria-label="간트에 표시된 업무">{projectIssues.length}개 중 {issues.length}개 업무</span>}
      {sharedPlanningLabels.length > 0 && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 계획·일정 조건">
        {sharedPlanningLabels.map(label => <li key={label}>{label}</li>)}
      </ul>}
    </div>}
    {sharedViewUnavailable && <div className="gantt-shared-view-warning">
      <p role="status">이 프로젝트에서 공유 보기를 열 수 없습니다.</p>
      {onChangeGanttView && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChangeGanttView(null)}>공유 보기 해제</button>}
    </div>}
    {focusIssueId && <div className="gantt-issue-focus" data-missing={!focusedIssue || undefined}>
      <p role="status">{focusedIssue ? <><strong>{focusedIssue.key}</strong> {focusedIssue.title}</> : '이 프로젝트에서 대상 업무를 찾을 수 없습니다.'}</p>
      {onClearIssueFocus && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
        if (onClearIssueFocus()) scrollRef.current?.focus({ preventScroll: true });
      }}>업무 위치 해제</button>}
    </div>}
    <div className="issue-toolbar gantt-toolbar"><div className="issue-search"><Search size={15} /><input placeholder="업무 검색" aria-label="간트 업무 검색" value={query} disabled={busy} onChange={e => changeVisibility(e.target.value, hideDone)} /></div><label className="gantt-checkbox-label"><input type="checkbox" checked={hideDone} disabled={busy} onChange={e => changeVisibility(query, e.target.checked)} />완료 업무 숨기기</label><div className="gantt-toolbar-spacer" /><button className="btn" onClick={goToToday}><CalendarDays size={14} /> 오늘</button><div className="issue-view-switch gantt-zoom">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([key, label]) => <button key={key} className={zoom === key ? 'active' : ''} onClick={() => setZoom(key)}>{label}</button>)}</div><button className="btn" onClick={() => { if (shiftOpen || canLeave()) setShiftOpen(!shiftOpen); }} disabled={!selectedIssues.length || busy}><MoveHorizontal size={15} />{selectedIssues.length ? `${selectedIssues.length}개 ` : ''}일정 이동</button><button className="btn btn-ghost" onClick={undo} disabled={!undoId || busy} aria-label="되돌리기" title="마지막 일정 변경 되돌리기"><Undo2 size={16} /><span className="gantt-undo-label">되돌리기</span></button>
      <button ref={analysisTrigger} className="btn" type="button" aria-expanded={analysisOpen} aria-controls={analysisOpen ? ANALYSIS_PANEL_ID : undefined} disabled={!hasProject} onClick={() => setAnalysisOpen(open => !open)}>
        <ChartNoAxesCombined size={15} aria-hidden="true" />일정 여유 분석
      </button>
      <button ref={linkPickerTrigger} className="btn gantt-link-picker-trigger" type="button" aria-pressed={Boolean(linkPicker)}
        disabled={busy || (!linkPicker && !canPickLink)} onClick={toggleLinkPicking}>
        <Link2 size={15} aria-hidden="true" />차트에서 연결
      </button>
    </div>
    {linkPicker && <GanttLinkPrompt source={sourceRow && pickedSource ? { key: sourceRow.issue.key, endpoint: pickedSource.endpoint } : null}
      canPick={hasVisibleLinkPair} onReset={() => {
        setLinkPicker({ source: null });
        linkPickerTrigger.current?.focus({ preventScroll: true });
      }} onCancel={cancelLinkPicking} />}
    {analysisResult && <ScheduleAnalysis id={ANALYSIS_PANEL_ID} analysis={analysisResult.analysis} error={analysisResult.error}
      onClose={() => { setAnalysisOpen(false); analysisTrigger.current?.focus(); }} openIssue={openIssue}
      canLocateIssue={issueId => Boolean(issueRows.get(issueId)?.issue.startDate)} onLocateIssue={locateAnalysisIssue} onLocateFinish={locateAnalysisDate} />}
    {shiftOpen && <form className="gantt-shift-form" onSubmit={e => { e.preventDefault(); void requestPreview(selectedIssues.map(i => i.id), days, workingDays); }}><span><strong>{selectedIssues.length}개</strong> 업무를</span><input className="field" aria-label="이동 일수" type="number" step="1" min="-3650" max="3650" value={days} onChange={e => setDays(Number(e.target.value))} required /><span>일 이동</span><label className="gantt-checkbox-label"><input type="checkbox" checked={workingDays} onChange={e => setWorkingDays(e.target.checked)} />근무일 기준</label><small>음수는 앞당기기 · 프로젝트 달력의 근무 요일·예외 적용</small><button className="btn btn-primary" type="submit" disabled={busy}>변경 미리보기</button><button className="issue-icon-button" type="button" onClick={() => setShiftOpen(false)} aria-label="일정 이동 닫기"><X size={16} /></button></form>}
    {createOpen && <InlineIssueForm key={`${projectId}:${draftEpoch}`} data={data} projectId={projectId} projects={data.projects} users={data.users} sharedViewActive={ganttViewId !== null} initialPlan={planningExpanded && selectedPlan?.status !== 'archived' ? selectedPlan : undefined} onDraftChange={trackDraft} onClose={() => { if (canLeave()) setCreateOpen(false); }} onCreated={async issue => {
      await refresh(); setCreateOpen(false);
      if (sharedViewUnavailable || matchSharedView && !matchSharedView(issue)) {
        notify(`${issue.key} 업무를 간트에 추가했습니다. 새 업무는 현재 공유 보기의 범위 밖에 있습니다.`);
      } else {
        setQuery(''); setHideDone(false);
        if (planningScope && issue[planningFields(planningScope.kind).idField] !== planningScope.id) setLinkedOnly(false);
        notify(`${issue.key} 업무를 간트에 추가했습니다.`);
      }
    }} />}
    <GanttPlanningControls {...props} expanded={planningExpanded} onExpandedChange={expanded => {
      setPlanningExpanded(expanded);
      if (!expanded) setLinkedOnly(false);
    }} selectedPlanningId={selectedPlanningId} onSelectPlanning={choosePlan} onDraftChange={trackDraft} draftEpoch={draftEpoch} />
    {planningExpanded && selectedPlan && <div className="gantt-planning-actions">
      <label className="gantt-checkbox-label"><input type="checkbox" checked={linkedOnly} disabled={busy} onChange={event => setPlanningFilter(event.target.checked)} />연결된 업무만</label>
      <button className="btn" disabled={busy} onClick={() => {
        if (canLeave()) setPlanShift(selectedPlan);
      }}><MoveHorizontal size={14} />계획 일정 함께 이동</button>
      <button className="btn" disabled={busy || !selectedIssues.length || selectedIssues.length > 1000} onClick={() => {
        if (canLeave()) setPlanAssignment({ item:selectedPlan, issues:selectedIssues });
      }}><Link2 size={14} />선택 업무 연결</button>
      {selectedIssues.length > 1000 && <span>한 번에 최대 1,000개 업무를 연결하거나 해제할 수 있습니다.</span>}
      {!selectedIssues.length && <span>간트에서 업무를 선택해 계획에 연결하거나 해제할 수 있습니다.</span>}
    </div>}
    <SchedulePlanningPanel {...props} selectedBaselineId={selectedBaselineId} onSelectBaseline={setSelectedBaselineId} />
    {baseline && <div className="gantt-baseline-caption"><span className="gantt-baseline-key" />비교 기준선 <strong>{baseline.name}</strong><span>회색은 캡처된 계획 · 종료 차이는 달력일 · 삭제된 업무와 마일스톤 기록도 보존됩니다.</span></div>}
    <div className="gantt-hint" id="gantt-editing-help" hidden={Boolean(linkPicker)}><span><span className="gantt-mini-bar" />막대 가운데는 이동, 양 끝은 기간 조정 · 변경 후 미리보기</span><span>날짜 입력 후 Enter로 저장 · Esc로 최신 날짜 · 핸들은 ← → 키도 지원해요.</span></div>
    <div className="gantt-window-controls">
      <span>표시 범위</span>
      <button type="button" className="btn btn-ghost" aria-label="간트 이전 60일" onClick={() => setWindowStart(isoDay(clampWindowStart(range.start - 60)))}>←</button>
      <input className="field" type="date" aria-label="간트 표시 시작일" min="0000-01-01" max="9999-12-31" value={isoDay(range.start)}
        onChange={event => { if (event.target.value) setWindowStart(event.target.value); }} />
      <span>— {isoDay(range.end)}</span>
      <button type="button" className="btn btn-ghost" aria-label="간트 다음 60일" onClick={() => setWindowStart(isoDay(clampWindowStart(range.start + 60)))}>→</button>
      <button type="button" className="btn btn-ghost" onClick={() => {
        if (overlapAnchor) showDate(todayDate());
        else {
          setWindowStart(null);
          scrollToDate(dayNumber(todayDate()), defaultRangeStart, 'smooth');
        }
      }}>오늘 중심</button>
      {overlapAnchor && <button type="button" className="btn btn-ghost" onClick={() => {
        setWindowStart(null);
        scrollToDate(dayNumber(overlapAnchor), defaultRangeStart);
      }}>보기 기간으로 이동</button>}
      <small>최대 {MAX_TIMELINE_DAYS}일 표시 · 범위 밖 기록은 행의 날짜로 이동하세요.</small>
    </div>
    {workloadView === 'project' && <ProjectWorkload key={draftEpoch} {...props} startDate={isoDay(range.start)} endDate={isoDay(range.end)}
      onDraftChange={trackDraft} onBeforeLevel={canOpenWorkloadLevel} scheduleBusy={busy} onScheduleApplied={onWorkloadLevelApplied}
      levelIssueIds={selectedIssues.map(issue=>issue.id)} />}
    {workloadView === 'team' && <TeamWorkload key={draftEpoch} {...props} initialStartDate={isoDay(range.start)}
      onDraftChange={trackDraft} onBeforeLevel={canOpenWorkloadLevel} scheduleBusy={busy} onScheduleApplied={onWorkloadLevelApplied} />}
    <div className="gantt-scroll" ref={scrollRef} tabIndex={-1} role="region" aria-label="간트 차트"><div className="gantt-canvas" style={{ width: LEFT_WIDTH + timelineWidth, '--gantt-day-width': `${dayWidth}px` } as CSSProperties}>
      <div className="gantt-chart-header"><div className="gantt-left gantt-left-header"><label><input type="checkbox" aria-label="표시된 업무 전체 선택" checked={issues.length > 0 && issues.every(i => selected.has(i.id))} onChange={e => setSelected(e.target.checked ? new Set(issues.map(i => i.id)) : new Set())} /></label><span>업무 <small>{issues.length}</small></span><span>시작일</span><span>종료일</span></div><div className="gantt-date-header" style={{ width: timelineWidth }}><div className="gantt-months">{months.map((tick, index) => <span key={tick.iso} style={{ left: tick.index * dayWidth, width: ((months[index + 1]?.index ?? range.days) - tick.index) * dayWidth }}>{tick.date.getUTCFullYear()}년 {tick.date.getUTCMonth() + 1}월</span>)}</div><div className="gantt-days">{ticks.map(tick => <span key={tick.iso} data-date={tick.iso} className={`${!calendarMath.isWorking(tick.iso) ? 'weekend' : ''} ${tick.iso === todayDate() ? 'today' : ''}`} style={{ width: dayWidth }}>{zoom === 'day' ? <>{tick.date.getUTCDate()}<small>{['일', '월', '화', '수', '목', '금', '토'][tick.weekday]}</small></> : zoom === 'week' && (tick.weekday === 1 || tick.index === 0) ? tick.date.getUTCDate() : zoom === 'month' && tick.date.getUTCDate() === 15 ? '15' : ''}</span>)}</div></div></div>
      {ticks.filter(t => !calendarMath.isWorking(t.iso)).map(tick => <div key={tick.iso} className="gantt-weekend-band" style={{ left: LEFT_WIDTH + tick.index * dayWidth, width: dayWidth, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />)}
      {todayPosition >= 0 && todayPosition < timelineWidth && <div className="gantt-today-line" style={{ left: LEFT_WIDTH + todayPosition + dayWidth / 2, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />}
      <svg className="gantt-dependency-lines" width={timelineWidth} height={issues.length * ROW_HEIGHT} style={{ left: LEFT_WIDTH, top: HEADER_HEIGHT + planningRows.length * ROW_HEIGHT }} aria-hidden="true">
        <defs>
          <marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="#8a9b9b" /></marker>
          {analysisResult?.analysis && <marker id="gantt-arrow-analysis" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="var(--gantt-analysis-accent)" /></marker>}
        </defs>
        {dependencies.map(link => <GanttConnector key={link.dependency.id} {...link} range={range} dayWidth={dayWidth} drag={drag}
          critical={analysisResult?.criticalDependencyIds?.has(link.dependency.id) ?? false} />)}
      </svg>
      {planningRows.map(item => <PlanningTimelineRow key={item.id} item={item} selected={item.id === selectedPlanningId}
        stats={planStats.get(item.id)} range={range} dayWidth={dayWidth} showDate={showDate} capturedStyle={capturedStyle}
        onSelect={() => { if (item.id !== selectedPlanningId && canLeave()) choosePlan(item.id); }} />)}
      {issues.map(issue => {
        const critical = analysisResult?.criticalIssueIds?.has(issue.id);
        const user = data.users.find(u => u.id === issue.assigneeId);
        const start = issue.startDate ? dayNumber(issue.startDate) : null;
        const end = issue.endDate ? dayNumber(issue.endDate) : null;
        const dragging = drag?.issue.id === issue.id;
        const offset = dragging ? drag.delta : 0;
        const startOffset = dragging && drag.mode !== 'end' ? offset : 0;
        const endOffset = dragging && drag.mode !== 'start' ? offset : 0;
        const hasSchedule = start !== null && end !== null;
        const visibleStart = hasSchedule ? Math.max(range.start, start + startOffset) : 0;
        const visibleEnd = hasSchedule ? Math.min(range.end, end + endOffset) : -1;
        const visibleSchedule = hasSchedule && visibleStart <= visibleEnd;
        const status = statusMeta(data, issue.projectId, issue.status);
        const captured = baseline?.issues.find(value => value.issueId === issue.id);
        const endDelta = captured?.endDate && issue.endDate ? dayNumber(issue.endDate) - dayNumber(captured.endDate) : null;
        const isSource = pickedSource?.issueId === issue.id;
        const canPickRow = canPickLink && hasLinkPair(issue.projectId) && (!sourceRow || !isSource && sourceRow.issue.projectId === issue.projectId);
        const startPosition = start !== null && start >= range.start && start <= range.end ? (start - range.start) * dayWidth + BAR_EDGE_INSET : null;
        const endPosition = end !== null && end >= range.start && end <= range.end ? (end - range.start + 1) * dayWidth - BAR_EDGE_INSET : null;
        const barClass = `gantt-bar ${dragging ? 'is-dragging' : ''} ${status.category === 'done' ? 'is-done' : ''}`;
        const isFocused = focusedIssue?.id === issue.id;
        return <div data-issue-id={issue.id} data-focused-issue={isFocused || undefined} className={`gantt-row ${selected.has(issue.id) ? 'is-selected' : ''}${linkPicker ? ' gantt-link-pick-row' : ''}${isSource ? ' gantt-link-source-row' : ''}`} key={issue.id}>
          <div className="gantt-left">
            <label><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected.has(issue.id)} onChange={() => toggleSelected(issue.id)} /></label>
            <div className="gantt-issue-cell">
              <button type="button" className="gantt-issue-name" disabled={Boolean(linkPicker && !canPickRow)}
                aria-label={linkPicker ? `${issue.key} ${linkStep} 업무 선택` : undefined}
                onClick={() => linkPicker ? pickLink(issue.id, pickedSource ? 'startDate' : 'endDate', false) : openIssue(issue.id)}>
                <IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />
                <span><small>{issue.key} · <IssueTypeName data={data} issue={issue} /></small><strong title={issue.title}>{issue.title}</strong>
                  {endDelta !== null && <small className="gantt-baseline-delta" title="현재 계획 종료일 − 기준선 종료일 (달력일)">종료 {endDelta > 0 ? '+' : ''}{endDelta}일 · 달력일</small>}</span>
                {user && <span className="issue-avatar" style={{ background: user.color }} title={user.name}>{user.name.slice(0, 1)}</span>}
              </button>
              <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} disabled={busy || Boolean(linkPicker)} />
            </div>
            <DateCells key={`${issue.id}:${draftEpoch}`} issue={issue} onDraftChange={trackDraft} disabled={busy || Boolean(linkPicker)} onSave={(source, startDate, endDate) => saveDates(source, startDate, endDate)} />
          </div>
          <div className="gantt-row-timeline" style={{ width: timelineWidth }}>
          {captured?.startDate && captured.endDate && <div className="gantt-baseline-bar" role="img" aria-label={`${captured.key} 기준선 ${captured.startDate} ~ ${captured.endDate}`} title={`${baseline!.name}: ${captured.title} · ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}
          {visibleSchedule ? <div className={`gantt-task-range ${dragging ? 'is-dragging' : ''}`} style={{ left: (visibleStart - range.start) * dayWidth + BAR_EDGE_INSET, width: (visibleEnd - visibleStart + 1) * dayWidth - 2 * BAR_EDGE_INSET, '--bar-color': status.color } as CSSProperties}>
            {linkPicker ? <span className={`${barClass} gantt-link-bar`} data-analysis-critical={critical || undefined} aria-hidden="true"><span>{zoom !== 'month' && issue.title}</span></span>
              : <button className={barClass} disabled={busy} data-analysis-critical={critical || undefined} aria-label={`${issue.key} 일정 이동`} aria-describedby={critical ? 'gantt-editing-help gantt-analysis-critical-help' : 'gantt-editing-help'} title={`${issue.key}: ${issue.startDate} ~ ${issue.endDate} · 끌어서 이동, 선택해서 상세 보기`} onPointerDown={event => beginDrag(event, issue, 'move')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIssue(issue.id); } }}><span>{zoom !== 'month' && issue.title}</span></button>}
            {!linkPicker && (['start', 'end'] as const).filter(edge => edge === 'start' ? !outside(isoDay(start! + startOffset)) : !outside(isoDay(end! + endOffset))).map(edge => <button key={edge} type="button" className={`gantt-resize-handle is-${edge}`} aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'} 조정`} aria-describedby="gantt-editing-help" title={`${edge === 'start' ? '시작일' : '종료일'} 조정 · 드래그 또는 좌우 방향키 · Enter로 날짜 입력`} disabled={busy} onPointerDown={event => beginDrag(event, issue, edge)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); previewResize(issue, edge, event.key === 'ArrowRight' ? 1 : -1); } }} onClick={event => { if (event.detail === 0) focusDateFromControl(event.currentTarget, issue, edge); }}><span /></button>)}
            {dragging && offset !== 0 && <small className="gantt-drag-label">{drag.mode === 'move' ? `${offset > 0 ? '+' : ''}${offset}일` : `${moveDate(issue.startDate!, startOffset)} ~ ${moveDate(issue.endDate!, endOffset)}`}</small>}
          </div> : hasSchedule ? <button className="gantt-jump-date" onClick={() => showDate(issue.startDate!)}>{issue.startDate} — {issue.endDate} · 일정으로 이동 →</button> : !linkPicker && <button
            type="button" className="gantt-no-schedule gantt-missing-date-action" aria-label={`${issue.key} 날짜 입력`} data-schedule-owner={issue.id}
            disabled={busy} onClick={event => focusDateFromControl(event.currentTarget, issue)}><Plus size={12} aria-hidden="true" />날짜 입력</button>}
          {linkPicker && <GanttLinkEndpoints issueKey={issue.key} step={linkStep} startPosition={startPosition} endPosition={endPosition}
            timelineWidth={timelineWidth} disabled={!canPickRow} onPick={endpoint => pickLink(issue.id, endpoint, true)} />}
        </div></div>;
      })}
      {historicalIssues.map(captured => <div key={`historical:${captured.issueId}`} className="gantt-row gantt-history-row" data-baseline-issue-id={captured.issueId}><div className="gantt-left"><span /><div className="gantt-history-name"><small>{captured.key} · 삭제된 업무 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button><button className="gantt-history-date" disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{captured.startDate && captured.endDate && <div className="gantt-baseline-bar is-historical" role="img" aria-label={`${captured.key} 삭제된 업무 기준선 ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}</div></div>)}
      {milestones.map(milestone => { const captured = baseline?.milestones.find(value => value.milestoneId === milestone.id); const delta = captured ? dayNumber(milestone.date) - dayNumber(captured.date) : null; return <div key={milestone.id} className="gantt-row gantt-milestone-row" data-milestone-id={milestone.id}><div className="gantt-left"><Diamond size={13} /><div className="gantt-milestone-name"><small>{milestone.status === 'reached' ? '달성' : '예정'} · 마일스톤</small><strong>{milestone.title}</strong>{delta !== null && <small>기준선 대비 {delta > 0 ? '+' : ''}{delta}일 · 달력일</small>}</div><button className="gantt-history-date" onClick={() => showDate(milestone.date)}>{milestone.date}</button>{captured ? <button className="gantt-history-date" onClick={() => showDate(captured.date)}>기준 {captured.date}</button> : <span />}</div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{captured && !outside(captured.date) && <span className="gantt-milestone-diamond is-baseline" role="img" aria-label={`${captured.title} 마일스톤 기준선 ${captured.date}`} title={`기준선: ${captured.title} · ${captured.date}`} style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} />}{!outside(milestone.date) ? <span className={`gantt-milestone-diamond ${milestone.status === 'reached' ? 'is-reached' : ''}`} role="img" aria-label={`${milestone.title} 마일스톤 ${milestone.date}`} title={`${milestone.title} · ${milestone.date}`} style={{ left: (dayNumber(milestone.date) - range.start + .5) * dayWidth }}><span>{milestone.title}</span></span> : <button className="gantt-jump-date" onClick={() => showDate(milestone.date)}>{milestone.date} · 마일스톤으로 이동 →</button>}</div></div>; })}
      {historicalMilestones.map(captured => <div key={`historical-milestone:${captured.milestoneId}`} className="gantt-row gantt-history-row"><div className="gantt-left"><Diamond size={12} /><div className="gantt-history-name"><small>삭제된 마일스톤 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" onClick={() => showDate(captured.date)}>{captured.date}</button><span /></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{!outside(captured.date) ? <span className="gantt-milestone-diamond is-baseline is-historical" role="img" aria-label={`${captured.title} 삭제된 마일스톤 기준선 ${captured.date}`} style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} /> : <button className="gantt-jump-date" onClick={() => showDate(captured.date)}>{captured.date} · 기준선 기록으로 이동 →</button>}</div></div>)}
      <button className="gantt-add-inline-row" style={{ width: LEFT_WIDTH }} onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={14} /> 이 간트에 업무 추가</button>
      {issues.length === 0 && <div className="gantt-no-issues" style={{ width: LEFT_WIDTH }}><CalendarDays size={28} /><strong>표시할 업무가 없습니다</strong><span>{ganttViewId === null ? '업무를 만들거나 검색 조건을 변경하세요.' : '공유 보기나 검색 조건을 변경하세요.'}</span></div>}
    </div></div>
    {baseline && <details className="gantt-baseline-records"><summary>기준선 업무 기록 {baseline.issues.length}개 · 캡처된 이름과 날짜 확인</summary><div><table><thead><tr><th>기준선 업무</th><th>시작일</th><th>종료일</th><th>현재 상태</th></tr></thead><tbody>{baseline.issues.map(captured => <tr key={captured.issueId}><td><small>{captured.key}</small><strong>{captured.title}</strong></td><td><button disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button></td><td><button disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></td><td>{projectIssues.some(issue => issue.id === captured.issueId) ? '현재 업무 있음' : '삭제된 업무 기록'}</td></tr>)}</tbody></table></div></details>}
    {scheduleWarnings.length > 0 && <div className="gantt-current-warnings" role="status"><AlertCircle size={16} /><div><strong>일정 의존성 확인</strong>{scheduleWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="issue-icon-button" onClick={() => setScheduleWarnings([])} aria-label="경고 닫기"><X size={14} /></button></div>}
    <div className="gantt-legend"><span><span className="gantt-mini-bar" />계획 일정</span><span><span className="gantt-legend-line" />선행 → 후행</span><span><span className="gantt-legend-today" />오늘</span><span><Diamond size={12} />마일스톤</span><span><span className="gantt-nonworking-key" />비근무일</span>{baseline && <span><span className="gantt-baseline-key" />기준선</span>}{analysisResult?.analysis && <span className="gantt-analysis-legend" id="gantt-analysis-critical-help"><span className="gantt-analysis-key" />여유 0근무일</span>}<span className="muted">수기 계획에서는 의존성을 연결해도 날짜가 자동으로 바뀌지 않습니다.</span></div>
    <div className="gantt-bottom-grid"><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><CalendarDays size={16} />일정 미정 <span>{unscheduled.length}</span></h3><span className="muted">시작일과 종료일을 정해주세요</span></div>{unscheduled.length ? unscheduled.map(issue => <div key={issue.id} className="gantt-unscheduled-row">
      <button type="button" onClick={() => openIssue(issue.id)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><strong>{issue.title}</strong></button>
      <button type="button" className="btn gantt-missing-date-action" aria-label={`${issue.key} 날짜 입력`} data-schedule-owner={issue.id}
        disabled={busy || Boolean(linkPicker)} onClick={event => focusDateFromControl(event.currentTarget, issue)}>날짜 입력</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => saveDates(issue, issue.startDate || (issue.endDate ? moveDate(issue.endDate, -2) : todayDate()), issue.endDate || (issue.startDate ? moveDate(issue.startDate, 2) : moveDate(todayDate(), 2)))}><Plus size={13} />{issue.startDate || issue.endDate ? '일정 완성' : '오늘부터 3일'}</button>
    </div>) : <div className="gantt-bottom-empty">{issues.length ? <><Check size={17} />표시된 업무의 일정이 모두 잡혀 있습니다.</> : '현재 보기에 표시할 업무가 없습니다.'}</div>}</section>
      <section className="gantt-bottom-card" aria-label="업무 연결 목록">
        <div className="gantt-bottom-heading">
          <h3><Link2 size={16} />업무 연결 <span>{dependencies.length}</span></h3>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={event => showLinkEditor(event.currentTarget)}><Plus size={13} /> 연결 추가</button>
        </div>
        {dependencies.length ? dependencies.map(({ dependency, predecessor: { issue: predecessor }, successor: { issue: successor } }) => (
          <div key={dependency.id} className="gantt-dependency-row">
            <div className="gantt-dependency-issues">
              <button type="button" title={predecessor.title} onClick={() => openIssue(predecessor.id)}>{predecessor.key}</button>
              <ArrowRight size={13} aria-hidden="true" />
              <button type="button" title={successor.title} onClick={() => openIssue(successor.id)}>{successor.key}</button>
            </div>
            <span>{dependencyLabel(dependency)}</span>
            <div className="gantt-dependency-actions">
              <button className="issue-icon-button" type="button" onClick={event => showLinkEditor(event.currentTarget, dependency)} disabled={busy} aria-label={`${predecessor.key}와 ${successor.key} 연결 수정`} title="연결 수정"><Pencil size={14} /></button>
              <button className="issue-icon-button" type="button" onClick={() => unlink(dependency)} disabled={busy} aria-label={`${predecessor.key}와 ${successor.key} 연결 해제`} title="연결 해제"><X size={14} /></button>
            </div>
          </div>
        )) : <div className="gantt-bottom-empty">선행 업무를 연결해 일정의 흐름을 확인하세요.</div>}
      </section>
    </div>
    {preview && <div className="issue-modal-overlay"><section className="gantt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-preview-title"><header><div><span className="feature-eyebrow">REVIEW CHANGES</span><h2 id="schedule-preview-title">일정 변경 미리보기</h2><p>{preview.changes.length}개 업무의 변경 내용을 확인하세요.</p></div><button className="issue-icon-button" onClick={() => setPreview(null)} disabled={busy} aria-label="미리보기 닫기"><X size={20} /></button></header>
      <WorkloadPreviewSummary data={data} projectId={projectId} startDate={isoDay(range.start)} endDate={isoDay(range.end)} preview={preview} />
      {preview.warnings.length > 0 && <div className="gantt-preview-warnings"><AlertCircle size={17} /><div><strong>적용 전에 확인하세요</strong>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}{previewError && <div className="issue-form-error gantt-preview-error" role="alert">{previewError}<br />미리보기와 입력 내용은 유지됩니다. 취소 후 최신 일정을 확인하고 다시 조정하세요.</div>}<div className="gantt-preview-table"><table><thead><tr><th>업무</th><th>현재 일정</th><th /><th>변경할 일정</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.id}><td><span className="issue-key">{change.key}</span><strong>{change.title}</strong></td><td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td><td><ArrowRight size={16} /></td><td className="gantt-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td></tr>)}</tbody></table>{preview.changes.length === 0 && <div className="issue-empty">이동할 일정이 없습니다. 날짜를 먼저 입력하세요.</div>}</div><footer><span className="muted">적용 후 마지막 변경을 되돌릴 수 있습니다.</span><button className="btn btn-ghost" onClick={() => setPreview(null)} disabled={busy}>취소</button><button className="btn btn-primary" disabled={busy || !preview.changes.length} onClick={() => applyChanges(preview)}><Check size={16} />{busy ? '적용 중…' : '변경 적용'}</button></footer></section></div>}
    {autoOpen && <AutomaticScheduleDialog {...props} selectedIssueIds={automaticScheduleIssues.map(issue => issue.id)} onClose={() => setAutoOpen(false)} onApplied={async result => { setUndoId(result.undoId); setScheduleWarnings(result.warnings || []); await refresh(); setAutoOpen(false); notify(`${result.updated.length}개 업무에 자동 일정 제안을 적용했습니다.`); }} />}
    {pasteOpen && <SchedulePasteDialog
      projectId={projectId} notify={notify} onDraftChange={trackDraft} onClose={() => setPasteOpen(false)}
      onApplied={async result => {
        setUndoId(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        setPasteOpen(false);
        const changes = [];
        if (result.updated.length) changes.push(`업무 일정 ${result.updated.length}건`);
        if (result.dependencyChanges) changes.push(`선후행 연결 ${result.dependencyChanges}건`);
        notify(`${changes.join(' · ')}을 변경했습니다.`);
      }}
    />}
    {linkEditor && <GanttDependencyModal key={linkEditor.dependency?.id ?? draftEpoch} issues={projectIssues} dependency={linkEditor.dependency} prefill={linkEditor.prefill} busy={busy}
      onDraftChange={trackDraft} onClose={() => { if (canLeave()) closeLinkEditor(); }} onSubmit={saveDependency} />}
    {planAssignment && <GanttPlanAssignment {...planAssignment} data={data} actorId={props.actorId} refresh={refresh} onDraftChange={trackDraft}
      onClose={() => { if (canLeave()) setPlanAssignment(null); }}
      onApplied={updated => setSelected(previous => {
        const next = new Set(previous);
        updated.forEach(issue => next.delete(issue.id));
        return next;
      })} />}
    {shiftPlan && <PlanScheduleShiftDialog plan={shiftPlan} actorId={props.actorId} refresh={refresh} notify={notify} onDraftChange={trackDraft}
      onClose={() => setPlanShift(null)} onApplied={async result => {
        setUndoId(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        const date = result.plan.startDate ?? result.plan.targetDate ?? result.plan.endDate;
        if (date && outside(date)) showDate(date);
        setPlanShift(null);
        notify(result.updated.length ? `계획과 ${result.updated.length}개 업무의 일정을 이동했습니다.` : '계획 일정을 이동했습니다.');
      }} />}
  </div>;
}

function GanttConnector({ dependency, predecessor, successor, range, dayWidth, drag, critical }: {
  dependency: Dependency; predecessor: IssueRow; successor: IssueRow;
  range: TimelineRange; dayWidth: number; drag: DragState | null; critical: boolean;
}) {
  const type = dependency.type ?? 'FS';
  const endpoints = DEPENDENCY_ENDPOINTS[type];
  function anchor({ issue, index }: IssueRow, dateField: keyof typeof SCHEDULE_DATE_LABELS) {
    if (!issue.startDate || !issue.endDate) return null;
    const end = dateField === 'endDate';
    const edge = end ? 'end' : 'start';
    const offset = drag?.issue.id === issue.id && (drag.mode === 'move' || drag.mode === edge) ? drag.delta : 0;
    const day = dayNumber(issue[dateField]!) + offset;
    if (day < range.start || day > range.end) return null;
    const x = (day - range.start + Number(end)) * dayWidth + (end ? -BAR_EDGE_INSET : BAR_EDGE_INSET);
    const side = end ? 1 : -1;
    const bend = Math.max(0, Math.min((range.end - range.start + 1) * dayWidth, x + side * 12));
    return { x, y: (index + .5) * ROW_HEIGHT, bend };
  }
  const from = anchor(predecessor, endpoints.predecessor);
  const to = anchor(successor, endpoints.successor);
  if (!from || !to) return null;
  const middleY = (from.y + to.y) / 2;
  return <path
    data-dependency-id={dependency.id}
    data-analysis-critical={critical || undefined}
    data-dependency-type={type}
    data-predecessor-anchor={endpoints.predecessor}
    data-successor-anchor={endpoints.successor}
    d={`M${from.x},${from.y} H${from.bend} V${middleY} H${to.bend} V${to.y} H${to.x}`}
    fill="none" stroke={critical ? 'var(--gantt-analysis-accent)' : '#8a9b9b'} strokeWidth={critical ? '2' : '1.3'}
    strokeDasharray={critical ? undefined : '3 3'} markerEnd={critical ? 'url(#gantt-arrow-analysis)' : 'url(#gantt-arrow)'}
  />;
}

type PlanMembership = { total: number; outside: number };
function planMembershipStats(plans: PlanningItem[], issues: Issue[]) {
  const items = new Map(plans.map(item => [item.id, item]));
  const results = new Map(plans.map(item => [item.id, { total: 0, outside: 0 }]));
  for (const issue of issues) {
    for (const kind of PLANNING_KINDS) {
      const id = issue[planningFields(kind).idField];
      const item = id ? items.get(id) : undefined;
      if (!item) continue;
      const counts = results.get(item.id)!;
      counts.total++;
      const first = issue.startDate ?? issue.endDate;
      const last = issue.endDate ?? issue.startDate;
      if ((item.startDate && first && first < item.startDate) || (item.endDate && last && last > item.endDate)) counts.outside++;
    }
  }
  return results;
}

function PlanningTimelineRow({ item, selected, stats, range, dayWidth, showDate, capturedStyle, onSelect }: {
  item: PlanningItem; selected: boolean; stats?: PlanMembership; range: {start:number; end:number}; dayWidth: number;
  showDate: (date:string) => void; capturedStyle: (start:string,end:string) => CSSProperties; onSelect: () => void;
}) {
  const { name, kind, startDate, endDate, targetDate } = item;
  const hasPeriod = Boolean(startDate && endDate);
  const periodInView = startDate && endDate && dayNumber(startDate) <= range.end && dayNumber(endDate) >= range.start;
  const inView = (date: string) => dayNumber(date) >= range.start && dayNumber(date) <= range.end;
  const pointX = (date: string) => (dayNumber(date) - range.start + .5) * dayWidth;
  const partial = hasPeriod ? null : startDate ?? endDate;
  const jump = !periodInView && (startDate || endDate || targetDate) && !(partial && inView(partial)) && !(targetDate && inView(targetDate));
  const firstDate = startDate ?? targetDate ?? endDate;
  return <div data-planning-id={item.id} className={`gantt-row gantt-plan-row is-${kind}${selected ? ' is-focused-plan' : ''}`}>
    <div className="gantt-left">
      <CalendarRange size={14} />
      <div className="gantt-plan-name">
        <button type="button" aria-pressed={selected} aria-label={`${name} 계획 일정 편집`} title={name} onClick={onSelect}>{name}</button>
        <div className="gantt-plan-row-meta">
          <span>{PLAN_LABELS[kind]}{item.status === 'archived' ? ' · 보관됨' : ''} · 업무 {stats?.total ?? 0}개</span>
          {Boolean(stats?.outside) && <span className="gantt-plan-outside">기간 밖 {stats!.outside}개</span>}
          {targetDate && <button type="button" className="gantt-history-date" onClick={() => showDate(targetDate)} title="목표일로 이동">목표 {targetDate}</button>}
        </div>
      </div>
      {[['시작일', startDate], ['종료일', endDate]].map(([label,date]) => <button key={label} type="button" className="gantt-history-date" disabled={!date} onClick={() => date && showDate(date)} aria-label={`${name} 계획 ${label}${date ? ` ${date}` : ' 미정'}`}>{date ?? '미정'}</button>)}
    </div>
    <div className="gantt-row-timeline">
      {startDate && endDate && periodInView && <span role="img" className="gantt-plan-period" style={capturedStyle(startDate,endDate)} aria-label={`${name} 계획 기간 ${startDate} ~ ${endDate}`} title={`${name} · ${startDate} ~ ${endDate}`} />}
      {partial && inView(partial) && <span role="img" className="gantt-plan-partial" style={{ left:pointX(partial) }} aria-label={`${name} 계획 ${startDate ? '시작일' : '종료일'} ${partial}`} title={partial} />}
      {targetDate && inView(targetDate) && <span role="img" className="gantt-plan-target" style={{ left:pointX(targetDate) }} aria-label={`${name} 계획 목표일 ${targetDate}`} title={`${name} 목표 ${targetDate}`} />}
      {jump && firstDate && <button type="button" className="gantt-jump-date" onClick={() => showDate(firstDate)}>{firstDate} · 계획 일정으로 이동 →</button>}
      {!firstDate && <span className="gantt-no-schedule">계획 날짜 미정</span>}
    </div>
  </div>;
}

function InlineIssueForm({ data, projectId, projects, users, sharedViewActive, initialPlan, onClose, onCreated, onDraftChange }: { data:FeatureProps['data']; projectId: string; projects: Project[]; users: User[]; sharedViewActive: boolean; initialPlan?: PlanningItem; onClose: () => void; onCreated: (issue: Issue) => Promise<void>; onDraftChange: TrackDraft }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState(() => initialIssueType(data, projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || ''));
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const [assigneeId, setAssigneeId] = useState('');
  const [selectedProject, setSelectedProject] = useState(projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || '');
  const [plansByProject, setPlansByProject] = useState<Record<string, Partial<Record<PlanningKind, string | null>>>>(() =>
    initialPlan ? { [initialPlan.projectId]: { [initialPlan.kind]:initialPlan.id } } : {});
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => { onDraftChange('create', touched, saving); return () => onDraftChange('create', false); }, [onDraftChange, touched, saving]);
  const customFields = valuesByProject[selectedProject] || {};
  const initialStatus = projectWorkflow(data,selectedProject).initialStatusId;
  const required = requiredFieldsFor(data,selectedProject,type,initialStatus);
  const extraFields = required.filter(field => !field.startsWith('custom:') && !['title','assigneeId','startDate','endDate','cycle','module','release'].includes(field));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget as HTMLFormElement);
    if (startDate && endDate && startDate > endDate) { setError('종료일은 시작일보다 빠를 수 없습니다. 입력한 날짜를 확인하세요.'); return; }
    if (!title.trim()) { setError('업무 제목을 입력하세요.'); return; }
    setSaving(true);
    try { const issue = await post<Issue>('/issues', { projectId: selectedProject, title: title.trim(), type, status: initialStatus, assigneeId: assigneeId || null, startDate: startDate || null, endDate: endDate || null, description:form.get('description') || '',collaboratorIds:form.getAll('collaboratorIds'),dueDate:form.get('dueDate')||null,estimate:form.get('estimate') ? Number(form.get('estimate')) : null,plannedEffortMinutes:form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null,labels:String(form.get('labels')||'').split(',').map(value=>value.trim()).filter(Boolean),parentId:form.get('parentId')||null,cycleId:form.get('cycleId')||null,moduleId:form.get('moduleId')||null,releaseId:form.get('releaseId')||null, customFields }); await onCreated(issue); }
    catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return <form className="gantt-inline-create" aria-label="간트에서 업무 만들기" onSubmit={submit} onChange={() => setTouched(true)}>
    <div className="gantt-inline-create-heading"><div><strong><Plus size={15} /> 간트에 업무 추가</strong><span>{sharedViewActive ? '공유 보기 조건에 맞는 업무가 이 간트에 표시됩니다.' : '날짜는 나중에 정해도 괜찮아요. 저장하면 같은 간트에 표시됩니다.'}</span></div><button className="issue-icon-button" type="button" onClick={onClose} disabled={saving} aria-label="간트 업무 추가 닫기"><X size={17} /></button></div>
    <div className="gantt-create-fields"><label className="issue-form-label gantt-create-title">업무 제목<input autoFocus aria-label="추가할 업무 제목" className="field" placeholder="해야 할 일을 입력하세요" value={title} onChange={event => setTitle(event.target.value)} required maxLength={300} disabled={saving} /></label><label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={type} onChange={setType} disabled={saving} ariaLabel="추가할 업무 유형" /></label><label className="issue-form-label">담당자<select aria-label="추가할 업무 담당자" className="field" value={assigneeId} onChange={event => setAssigneeId(event.target.value)} disabled={saving}><option value="">미지정</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="issue-form-label">시작일<input aria-label="추가할 업무 시작일" className="field" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={saving} /></label><label className="issue-form-label">종료일<input aria-label="추가할 업무 종료일" className="field" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} disabled={saving} /></label>{(!projectId || projectId === 'all') && <label className="issue-form-label">프로젝트<select aria-label="추가할 업무 프로젝트" className="field" value={selectedProject} onChange={event => { setSelectedProject(event.target.value); setType(initialIssueType(data, event.target.value)); }} disabled={saving} required>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}</div>
    <div className="issue-form-grid">
      <label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} disabled={saving} /></label>
      {PLANNING_KINDS.map(kind => <label key={kind} className="issue-form-label">{PLAN_LABELS[kind]}
      <PlanningSelect data={data} projectId={selectedProject} kind={kind} ariaLabel={`추가할 업무 ${PLAN_LABELS[kind]}`} disabled={saving}
        value={plansByProject[selectedProject]?.[kind] ?? null} onChange={id => setPlansByProject(previous => ({ ...previous, [selectedProject]:{ ...previous[selectedProject], [kind]:id } }))} />
    </label>)}</div>
    <CustomFields data={data} projectId={selectedProject} issueType={type} status={initialStatus} values={customFields} onChange={next => { setTouched(true); setValuesByProject(previous => ({ ...previous, [selectedProject]: next })); }} disabled={saving} requiredFields={required} labelPrefix="추가할 업무 " />
    {required.length > 0 && <p className="issue-section-empty">기본 상태의 필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
    {extraFields.length > 0 && <div className="issue-form-grid">{extraFields.map(field=><label key={field} className="issue-form-label">{REQUIRED_FIELD_LABELS[field]}{field === 'description' ? <textarea className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} disabled={saving} rows={3}/> : field === 'parentId' ? <select className="field" name={field} aria-label="추가할 업무 상위 업무" disabled={saving}><option value="">없음</option>{data.issues.filter(issue=>issue.projectId===selectedProject).map(issue=><option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select> : field === 'collaboratorIds' ? <select className="field" name={field} aria-label="추가할 업무 참여자" multiple disabled={saving}>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select> : <input className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} disabled={saving} type={field === 'dueDate'?'date':field==='estimate'?'number':'text'} min={field==='estimate'?0:undefined} step={field==='estimate'?'0.5':undefined} placeholder={field==='labels'?'쉼표로 구분':undefined}/>}</label>)}</div>}
    {error && <div className="issue-form-error" role="alert">{error}</div>}
    <div className="gantt-inline-create-footer"><small>시작일·종료일은 선택 사항입니다.</small><button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>취소</button><button className="btn btn-primary" type="submit" disabled={saving || !selectedProject}><Plus size={14} />{saving ? '추가 중…' : '간트에 추가'}</button></div>
  </form>;
}

function DateCells({ issue, onSave, disabled, onDraftChange }: { issue: Issue; onSave: (source: Issue, start: string | null, end: string | null) => Promise<Issue | null>; disabled: boolean; onDraftChange: TrackDraft }) {
  const [source, setSource] = useState(issue);
  const [start, setStart] = useState(issue.startDate || '');
  const [end, setEnd] = useState(issue.endDate || '');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const dirty = start !== (source.startDate || '') || end !== (source.endDate || '');
  const conflict = issue.version !== source.version && dirty;
  if (issue.version !== source.version && !dirty && !pending) { setSource(issue); setStart(issue.startDate || ''); setEnd(issue.endDate || ''); }
  useEffect(() => { onDraftChange(`dates:${issue.id}`, dirty, pending); return () => onDraftChange(`dates:${issue.id}`, false); }, [onDraftChange, issue.id, dirty, pending]);
  function reset() { if (pendingRef.current) return; setSource(issue); setStart(issue.startDate || ''); setEnd(issue.endDate || ''); }
  async function commit(nextFocus: EventTarget | null) {
    if (pendingRef.current || !dirty || (nextFocus instanceof HTMLElement && nextFocus.dataset.scheduleOwner === issue.id)) return;
    pendingRef.current = true; setPending(true); onDraftChange(`dates:${issue.id}`, dirty, true);
    try { const saved = await onSave(source, start || null, end || null); if (saved) { setSource(saved); setStart(saved.startDate || ''); setEnd(saved.endDate || ''); } }
    finally { pendingRef.current = false; setPending(false); }
  }
  const title = conflict ? '다른 변경이 있습니다. 입력은 보존됩니다. Esc로 최신 날짜 불러오기' : 'Enter로 저장 · Esc로 최신 날짜 불러오기';
  return <>{(['start', 'end'] as const).map(edge => <input key={edge} className={`gantt-inline-date ${conflict ? 'has-conflict' : ''}`} title={title} aria-describedby="gantt-editing-help" type="date" data-schedule-owner={issue.id} data-schedule-edge={edge} aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'}`} aria-invalid={conflict || undefined} value={edge === 'start' ? start : end} onChange={event => edge === 'start' ? setStart(event.target.value) : setEnd(event.target.value)} disabled={disabled || pending} onBlur={event => void commit(event.relatedTarget)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); reset(); } else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />)}</>;
}
