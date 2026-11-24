'use client';

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type Ref } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, BarChart3, CalendarClock, CalendarDays, CalendarRange, ChartNoAxesCombined, Check, ClipboardPaste, Diamond, Layers3, Link2, ListTree, MoveHorizontal, Network, Pencil, Plus, RefreshCw, Search, Sparkles, Undo2, X } from 'lucide-react';
import { isIssueViewGitlabFilter, MAX_SCHEDULE_BULK_DATE_ISSUES, MAX_SCHEDULE_BULK_LINK_ISSUES, MAX_SCHEDULE_MANUAL_ISSUES, type CustomFieldValue, type Dependency, type FeatureProps, type Issue, type PlanningItem, type PlanningKind, type Project, type ScheduleAnchorChange, type ScheduleBulkDateChanges, type ScheduleManualPreviewInput, type SchedulePreview, type ScheduleTeamBlockerApplyResult, type ScheduleUndoScope, type TeamGanttScheduleFilters, type User } from '../../shared/types';
import { isTerminalStatus, projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS, statusMeta } from '../../shared/workflow-helpers';
import { createCalendarMath, defaultWorkCalendar } from '../../shared/calendar';
import { analyzeProjectSchedule } from '../../shared/schedule-analysis';
import { checkDependencySchedule, DEPENDENCY_ENDPOINTS, DEPENDENCY_TYPES, isDependencyType, SCHEDULE_DATE_LABELS, type ScheduleDependencyEndpoint } from '../../shared/schedule-dependencies';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { renderGanttExport } from '../../shared/gantt-export';
import { buildGanttExportReport } from '../../shared/gantt-export-model';
import { buildGanttScheduleSheet, buildTeamGanttScheduleSheet } from '../../shared/schedule-paste-format';
import { traceGanttDependencies } from '../../shared/gantt-dependency-focus';
import { traceGanttHierarchy } from '../../shared/gantt-hierarchy-focus';
import { afterAcceptedNavigation, areGanttDateDraftsPreservedByNavigation, isGanttPreservedByNavigation } from '../lib/navigation';
import { api, ApiError, patch, post, remove } from '../lib/api';
import { downloadText } from '../lib/download';
import type { OpenIssueForReview } from '../lib/issue-review';
import { useWorkspaceRefresh, type WorkspaceRefresh } from '../lib/workspace-refresh';
import { createIssueAttempt, isDefiniteIssueCreationFailure, requestIssueCreation, type IssueCreationAttempt } from '../lib/issue-creation';
import { issueSearchText, projectIssueSchema, projectIssueTypes, requiredFieldLabels } from '../../shared/issue-schema';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view';
import { createIssueViewMatcher, createTeamIssueSearchMatcher, issuePriorityLabelFilterLabels, matchesGitlabFilter, orderIssueView } from '../../shared/issue-view';
import { planningFields } from '../../shared/planning-helpers';
import { issueSearchAliasLabel, matchingIssueSearchAliases, normalizeWorkspaceSearchKey } from '../../shared/workspace-search';
import { issuePlanningFilterLabels } from './issue-planning-filter-labels';
import { issueStatusFilterLabel } from './IssueStatusFilter';
import { issueViewSortLabels } from './IssueViewSort';
import { CustomFields, initialIssueType, IssueTypeName, IssueTypeSelect } from './CustomFields';
import { PlanningSelect, PLAN_LABELS } from './PlanningSelectors';
import { IssueTypeIcon } from './Issues';
import { ISSUE_GITLAB_FILTER_LABELS } from './IssueGitlabSummary';
import { buildIssueHierarchy, IssueHierarchyContext } from './IssueHierarchyContext';
import { dayNumber, dependencyLabel, errorMessage, isoDay, moveDate, todayDate } from './schedule-utils';
import { isUncertainScheduleResponse, scheduleUndoHeaders, useScheduleUndo } from './schedule-undo';
import { AutomaticScheduleDialog } from './AutomaticScheduleDialog';
import { GanttCascadeDialog, type CascadeAnchorChange, type TeamFollowUpSelection } from './GanttCascadeDialog';
import { SchedulePlanningPanel } from './SchedulePlanningPanel';
import { SCHEDULE_MILESTONE_REVIEW_ID } from './ScheduleMilestoneReview';
import { ScheduleAnalysis } from './ScheduleAnalysis';
import { bulkDateResultMessage, SCHEDULE_PASTE_DRAFT_ID, SchedulePasteDialog } from './SchedulePasteDialog';
import { GanttRowScheduleEdit, type GanttRowLinkDraft } from './GanttRowScheduleEdit';
import { WorkingDayRangePicker } from './WorkingDayRangePicker';
import { GanttPlanningControls } from './GanttPlanningControls';
import { GanttPlanAssignment } from './GanttPlanAssignment';
import { PlanScheduleShiftDialog } from './PlanScheduleShiftDialog';
import { GanttWorkloadPreviewSummary, ProjectWorkload } from './ProjectWorkload';
import { TeamWorkload } from './TeamWorkload';
import { TimeReservations } from './TimeReservations';
import { PROJECT_CAPACITY_DRAFT, TEAM_CAPACITY_DRAFT } from './WorkloadCapacityEditor';
import { GanttDependencyModal, type DependencyInput, type DependencyPrefill, type RelatedIssueDirection } from './GanttDependencyModal';
import { GanttDependencyFindings, type GanttDependencyFinding } from './GanttDependencyFindings';
import { GanttDeadlines } from './GanttDeadlines';
import { classifyGanttDeadline, GANTT_DEADLINE_LABELS, type GanttDeadline } from './gantt-deadline';
import { GanttDependencyFocusLabel, GanttDependencyFocusPanel } from './GanttDependencyFocus';
import { GanttHierarchyFocusLabel, GanttHierarchyFocusPanel, GanttHierarchySpan } from './GanttHierarchyFocus';
import { GanttTeamBlockers } from './GanttTeamBlockers';
import { GanttTeamBlockerEdit } from './GanttTeamBlockerEdit';
import { GanttTeamFollowUpChooser, type TeamFollowUpChoice } from './GanttTeamFollowUpChooser';
import { groupActiveTeamBlockers } from './team-follow-up-choices';
import { GanttLinkEndpoints, GanttLinkPrompt, type GanttLinkEndpoint } from './GanttLinkPicker';
import { GanttDateRangeLane, GanttDateRangePrompt, type FixedDateEdge } from './GanttDateRangePicker';
import { NewIssueModal, type ScheduleIssueLink } from './NewIssueModal';
import { issueReporterFilterLabel, IssueReporterSelect } from './IssueReporterSelect';
import { ganttDateDraftKey, readGanttDateDrafts, writeGanttDateDrafts, type GanttIssueDateDrafts, type StoredGanttDateDraft } from './gantt-date-draft-storage';
import './issues.css';
import './gantt.css';
import './gantt-deadline-markers.css';

type ApplyResult = { undoId: string; updated: Issue[]; warnings?: string[] };
type InlineDateValues = { source: Issue; startDate: string | null; endDate: string | null };
type InlineDateDraft = InlineDateValues & { accept: (saved: Issue) => void; owner: symbol };
type ChartDateDraft = { source: Issue; changes: ScheduleBulkDateChanges; owner?: symbol; stored?: StoredGanttDateDraft };
type ChartBlockerEdit = { source: Issue; target: Issue; opener: HTMLButtonElement; sourceDraft?: ChartDateDraft; targetDraft?: ChartDateDraft };
type DatePreviewOpener = HTMLButtonElement | HTMLInputElement;
type InlineScheduleOrigin = { issueId: string; accept?: (issue: Issue) => void; returnToMissingRow: boolean; focus: DatePreviewOpener };
type ManualReview = {
  input: ScheduleManualPreviewInput;
  preview: SchedulePreview;
  inline?: InlineScheduleOrigin & InlineDateValues;
  inlineDates?: InlineDateDraft[];
  chartEdge?: InlineDateValues;
};
type ManualReviewProblem = { kind: 'stale' | 'uncertain' | 'unavailable'; message: string };
type ScheduleShiftInput = Extract<ScheduleManualPreviewInput, { days: number }>;
type ShiftMode = 'selection' | 'hierarchy';
function manualDates(issue: Issue, startDate: string | null, endDate: string | null): ScheduleManualPreviewInput {
  return { changes: [{ id: issue.id, expectedVersion: issue.version, startDate, endDate }] };
}
function inlineDateChange(draft: InlineDateValues, issue = draft.source): ScheduleAnchorChange {
  return { id: issue.id, expectedVersion: issue.version,
    startDate: draft.startDate === draft.source.startDate ? issue.startDate : draft.startDate,
    endDate: draft.endDate === draft.source.endDate ? issue.endDate : draft.endDate };
}
function changedInlineDates(draft?: InlineDateValues): ScheduleBulkDateChanges {
  if (!draft) return {};
  const changes: ScheduleBulkDateChanges = {};
  for (const field of ['startDate', 'endDate'] as const) {
    if (draft[field] !== draft.source[field]) changes[field] = draft[field];
  }
  return changes;
}
function recoverableDates(issue: Issue, draft: StoredGanttDateDraft | undefined) {
  if (draft?.projectId !== issue.projectId || draft.version > issue.version) return undefined;
  if (draft.version === issue.version && (draft.startDate !== issue.startDate || draft.endDate !== issue.endDate)) return undefined;
  return draft;
}
function draftDatesAreSaved(issue: Issue, draft: StoredGanttDateDraft) {
  return issue.version > draft.version &&
    (draft.draftStart === draft.startDate || issue.startDate === draft.draftStart) &&
    (draft.draftEnd === draft.endDate || issue.endDate === draft.draftEnd);
}
type DragMode = 'move' | 'start' | 'end';
type DragState = { issue: Issue; initialX: number; delta: number; mode: DragMode };
type TrackDraft = (id: string, dirty: boolean, pending?: boolean, awaitingResult?: boolean) => void;
type GanttProps = FeatureProps & {
  refreshGantt: WorkspaceRefresh;
  allProjects?: boolean;
  teamProjectFilter?: string | null;
  onChangeTeamProjectFilter?: (id: string | null) => boolean;
  teamScheduleFilters?: TeamGanttScheduleFilters;
  onChangeTeamScheduleFilters?: (filters: TeamGanttScheduleFilters) => boolean;
  onOpenProjectGantt?: (id: string) => boolean;
  initialPlanningId?: string | null;
  onOpenPlanning?: (id: string) => void;
  ganttViewId?: string | null;
  onChangeGanttView?: (id: string | null) => boolean;
  onOpenSavedIssueView?: (id: string) => boolean;
  focusIssueId?: string | null;
  focusDateEndpoint?: ScheduleDependencyEndpoint | null;
  milestoneReviewId: string | null;
  onChangeMilestoneReview: (id: string | null) => boolean;
  issueFocusActivation?: number;
  issueOverlayOpen?: boolean;
  issueDateDraftsRef?: Ref<GanttIssueDateDrafts>;
  onClearIssueFocus?: () => boolean;
  onLocateIssueDate: (id: string, endpoint: ScheduleDependencyEndpoint) => boolean;
  onOpenIssueForReview?: OpenIssueForReview;
};
type PlanAssignmentInput = { item: PlanningItem; issues: Issue[] };
type ScheduleProjectScope = Project | 'team';
type BulkLinkSelection = { project: Project; issues: Issue[]; dateDrafts: ChartDateDraft[] };
type DependencyEditor = {
  dependency?: Dependency;
  prefill?: DependencyPrefill;
  anchor?: { issueId: string; otherRole: RelatedIssueDirection };
  opener: HTMLButtonElement;
};
type LinkPick = { issueId: string; endpoint: GanttLinkEndpoint; explicit: boolean };
type DateRangePick = { issue: Issue; fixedEdge?: FixedDateEdge; firstDate: string | null; initialDay: number; opener: HTMLButtonElement };
type CascadeOrigin = { kind: 'preview' } | { kind: 'inline'; opener: HTMLButtonElement; accept: (issue: Issue) => void };
type CascadeReview = { projectId: string; anchorChange: CascadeAnchorChange; origin: CascadeOrigin };
type TeamFollowUpOrigin = { kind: 'blockers'; opener: HTMLButtonElement } | { kind: 'preview' } |
  (Extract<CascadeOrigin, { kind: 'inline' }> & { source: Issue });
type TeamFollowUpReview = TeamFollowUpSelection & { origin: TeamFollowUpOrigin };
type TeamFollowUpHandoff = {
  source: TeamFollowUpSelection['source'] & Pick<Issue, 'title'>;
  initialChange?: ScheduleAnchorChange;
  origin: TeamFollowUpOrigin;
  choices: readonly TeamFollowUpChoice[];
};
type RowScheduleEdit = {
  issue: Issue;
  opener: HTMLButtonElement;
  focusDate?: 'dueDate';
  inlineDraft?: InlineDateDraft;
  relatedInlineDraft?: InlineDateDraft;
  initialDates?: ScheduleBulkDateChanges;
  initialLink?: GanttRowLinkDraft;
  otherDateDrafts?: ReadonlySet<string>;
};
type ScheduleFocus = {
  kind: 'dependencies' | 'hierarchy';
  issueId: string;
  projectId: string;
  opener: HTMLButtonElement;
  teamScope: string | null;
  previousSelection: Set<string>;
  previousWindowStart: string | null;
  scrollTop: number;
  scrollLeft: number;
};
type TimelineRange = { start: number; end: number };
type IssueRow = { issue: Issue; index: number };
type GanttViewport = { data: FeatureProps['data']; context: string; start: number; dayWidth: number };
type GanttViewportAnchor = GanttViewport & { left: number; top: number; timelineVisible: boolean };
const PLANNING_KINDS: PlanningKind[] = ['cycle', 'module', 'release'];
const LEFT_WIDTH = 538;
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 62;
const BAR_EDGE_INSET = 2;
const MAX_TIMELINE_DAYS = 180;
const ANALYSIS_PANEL_ID = 'gantt-schedule-analysis';
const FINDINGS_PANEL_ID = 'gantt-dependency-findings';
const DEADLINES_PANEL_ID = 'gantt-issue-deadlines';
const TEAM_BLOCKERS_PANEL_ID = 'gantt-team-blockers';
const TIME_RESERVATIONS_DRAFT = 'time-reservations';
const RANGE_PICK_DRAFT = 'date-range-pick';
const CREATE_ISSUE_DRAFT = 'create';
const CASCADE_DRAFT = 'successor-schedule';
const BULK_DATES_DRAFT = 'schedule-bulk-dates';
const BULK_LINKS_DRAFT = 'schedule-bulk-links';
const BLOCKER_LINKS_DRAFT = 'schedule-blocker-links';
const TEAM_BLOCKER_DRAFT = 'team-blocker';
const TEAM_BLOCKER_EDIT_DRAFT = 'team-blocker-edit';
const TEAM_FOLLOW_UP_DRAFT = 'team-follow-up';
const REFRESH_FEEDBACK = {
  updated: '간트를 새로고침했습니다.', skipped: '간트 새로고침을 건너뛰었습니다.', failed: '간트를 새로고침하지 못했습니다. 다시 시도해 주세요.',
} as const;
const MIN_TIMELINE_DAY = dayNumber('0000-01-01'), MAX_TIMELINE_DAY = dayNumber('9999-12-31');

const clampWindowStart = (day: number) => Math.max(MIN_TIMELINE_DAY, Math.min(MAX_TIMELINE_DAY - MAX_TIMELINE_DAYS + 1, day));
const windowForDate = (date: string) => isoDay(clampWindowStart(dayNumber(date) - 7));

function keepInlineDateFocus(event: PointerEvent<HTMLElement>) {
  if (event.button === 0 && document.activeElement?.matches('input[data-schedule-edge]')) event.preventDefault();
}

function scrollTimelineDate(scroll: HTMLDivElement, offset: number, behavior: ScrollBehavior = 'auto') {
  const header = scroll.querySelector('.gantt-left-header');
  if (!header) return;
  const pinned = getComputedStyle(header).position === 'sticky';
  scroll.scrollTo({ left: Math.max(0, offset + (pinned ? -72 : LEFT_WIDTH - 44)), behavior });
}

function focusGanttDate(chart: Element | null, issueId: string, edge: 'start' | 'end', block: ScrollLogicalPosition = 'center') {
  const input = chart?.querySelector<HTMLInputElement>(`input[data-schedule-owner="${CSS.escape(issueId)}"][data-schedule-edge="${edge}"]`);
  if (!input || input.disabled) return false;
  input.focus({ preventScroll: true });
  if (document.activeElement !== input) return false;
  input.scrollIntoView({ block, inline: 'nearest' });
  return true;
}

function focusDateFromControl(control: HTMLButtonElement, issue: Issue, edge: 'start' | 'end' = issue.startDate ? 'end' : 'start') {
  focusGanttDate(control.closest('.gantt-feature'), issue.id, edge);
}

function getFixedDateEdge({ startDate, endDate }: Issue): FixedDateEdge | undefined {
  if (startDate && !endDate) return { kind: 'start', date: startDate };
  if (endDate && !startDate) return { kind: 'end', date: endDate };
}

export function Gantt(props: GanttProps) {
  return <ProjectGantt key={JSON.stringify([props.projectId, props.actorId, Boolean(props.allProjects), props.initialPlanningId, props.data.restoreGeneration])} {...props} />;
}

function ProjectGantt(props: GanttProps) {
  const { data, projectId, refresh, refreshGantt, notify, openIssue, allProjects = false, teamProjectFilter = null, onChangeTeamProjectFilter,
    teamScheduleFilters, onChangeTeamScheduleFilters, onOpenProjectGantt, initialPlanningId, ganttViewId = null, onChangeGanttView, onOpenSavedIssueView,
    focusIssueId, focusDateEndpoint, milestoneReviewId, onChangeMilestoneReview,
    issueFocusActivation = 0, issueOverlayOpen, onClearIssueFocus, onLocateIssueDate } = props;
  const teamAssigneeId = allProjects ? teamScheduleFilters?.assigneeId : undefined;
  const teamUnscheduledOnly = allProjects && teamScheduleFilters?.unscheduledOnly === true;
  const teamGitlabFilter = allProjects ? teamScheduleFilters?.gitlab : undefined;
  const teamQuery = allProjects ? teamScheduleFilters?.query ?? '' : '';
  const teamScheduleFilterActive = teamAssigneeId !== undefined || teamUnscheduledOnly || Boolean(teamGitlabFilter || teamQuery.trim());
  const teamFocusScope = allProjects
    ? JSON.stringify([teamProjectFilter, teamAssigneeId !== undefined, teamAssigneeId, teamUnscheduledOnly, teamGitlabFilter, teamQuery]) : null;
  const focusedIssue = focusIssueId ? data.issues.find(issue => issue.id === focusIssueId && (allProjects || issue.projectId === projectId)) : undefined;
  const focusedDate = (focusDateEndpoint && focusedIssue?.[focusDateEndpoint]) || focusedIssue?.startDate || focusedIssue?.endDate;
  const focusRequest = focusIssueId ? JSON.stringify([focusIssueId, focusDateEndpoint ?? null, issueFocusActivation]) : null;
  const projectPlans = useMemo(() => allProjects ? [] : (data.planningItems ?? []).filter(item => item.projectId === projectId),
    [allProjects, data.planningItems, projectId]);
  const initialPlan = projectPlans.find(item => item.id === initialPlanningId);
  const focusInPlan = Boolean(initialPlan && focusedIssue?.[planningFields(initialPlan.kind).idField] === initialPlan.id);
  const [planningExpanded, setPlanningExpanded] = useState(Boolean(initialPlan));
  const [selectedPlanningId, setSelectedPlanningId] = useState<string | null>(initialPlan?.id ?? null);
  const [linkedOnly, setLinkedOnly] = useState(focusInPlan);
  const [planAssignment, setPlanAssignment] = useState<PlanAssignmentInput | null>(null);
  const [planShift, setPlanShift] = useState<PlanningItem | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const milestoneReviewOpener = useRef<HTMLButtonElement | null>(null);
  const query = allProjects ? teamQuery : projectQuery;
  const aliasQuery = normalizeWorkspaceSearchKey(query);
  const [zoom, setZoom] = useState<'day' | 'week' | 'month'>('day');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scheduleFocus, setScheduleFocus] = useState<ScheduleFocus | null>(null);
  const [selectionViewId, setSelectionViewId] = useState(ganttViewId);
  const [manualReview, setManualReview] = useState<ManualReview | null>(null);
  const [manualProblem, setManualProblem] = useState<ManualReviewProblem | null>(null);
  const preview = manualReview?.preview ?? null;
  const [datePreviewFocusTarget, setDatePreviewFocusTarget] = useState<DatePreviewOpener | null>(null);
  const [cascade, setCascade] = useState<CascadeReview | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [scheduleIssueCreation, setScheduleIssueCreation] = useState<{ link: ScheduleIssueLink; opener: HTMLButtonElement } | null>(null);
  const [blockedIssueCreation, setBlockedIssueCreation] = useState<{ issue: Issue; opener: HTMLButtonElement } | null>(null);
  const [createdBlockedIssue, setCreatedBlockedIssue] = useState<Pick<Issue, 'id' | 'key'> | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleWarnings, setScheduleWarnings] = useState<string[]>([]);
  const undoScope = useMemo<ScheduleUndoScope>(() => allProjects ? { kind: 'team' } : { kind: 'project', id: projectId }, [allProjects, projectId]);
  const { undoId, remember: rememberUndo, undo: undoScheduleChange } = useScheduleUndo(undoScope, props.actorId, data.restoreGeneration);
  const [days, setDays] = useState(5);
  const [workingDays, setWorkingDays] = useState(true);
  const [shiftSuccessors, setShiftSuccessors] = useState(false);
  const [shiftMode, setShiftMode] = useState<ShiftMode | null>(null);
  const [linkEditor, setLinkEditor] = useState<DependencyEditor | null>(null);
  const [linkPicker, setLinkPicker] = useState<{ source: LinkPick | null } | null>(null);
  const [datePicker, setDatePicker] = useState<DateRangePick | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [pasteScope, setPasteScope] = useState<ScheduleProjectScope | null>(null);
  const [bulkDateSelection, setBulkDateSelection] = useState<Issue[] | null>(null);
  const [bulkLinkSelection, setBulkLinkSelection] = useState<BulkLinkSelection | null>(null);
  const [blockerLinksScope, setBlockerLinksScope] = useState<ScheduleProjectScope | null>(null);
  const [rowScheduleEdit, setRowScheduleEdit] = useState<RowScheduleEdit | null>(null);
  const [workloadView, setWorkloadView] = useState<'project' | 'team' | null>(null);
  const [reservationsOpen, setReservationsOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [deadlinesOpen, setDeadlinesOpen] = useState(false);
  const [teamBlockersOpen, setTeamBlockersOpen] = useState(false);
  const [teamBlockerChartPair, setTeamBlockerChartPair] = useState<{ sourceId: string; targetId: string; opener: HTMLButtonElement }>();
  const [teamBlockerEdit, setTeamBlockerEdit] = useState<ChartBlockerEdit | null>(null);
  const [teamBlockerListRevision, setTeamBlockerListRevision] = useState(0);
  const [teamFollowUp, setTeamFollowUp] = useState<TeamFollowUpReview | null>(null);
  const [teamFollowUpHandoff, setTeamFollowUpHandoff] = useState<TeamFollowUpHandoff | null>(null);
  const [selectedBaselineId, setSelectedBaselineId] = useState<string | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [previousFocusRequest, setPreviousFocusRequest] = useState(focusRequest);
  const [windowStart, setWindowStart] = useState<string | null>(() => {
    const date = focusedDate || (initialPlan && (initialPlan.startDate || initialPlan.targetDate || initialPlan.endDate));
    return date ? windowForDate(date) : null;
  });
  if (previousFocusRequest !== focusRequest) {
    setPreviousFocusRequest(focusRequest);
    if (scheduleFocus) {
      setScheduleFocus(null);
      setSelected(scheduleFocus.previousSelection);
      setWindowStart(scheduleFocus.previousWindowStart);
      if (shiftMode === 'hierarchy') setShiftMode(null);
    }
    if (focusedIssue) {
      if (!focusDateEndpoint) {
        if (!allProjects) setProjectQuery('');
        setHideDone(false);
        setLinkedOnly(false);
      }
      setLinkPicker(null);
      setDatePicker(null);
      setDrag(null);
      setWindowStart(focusedDate ? windowForDate(focusedDate) : null);
    }
  }
  if (selectionViewId !== ganttViewId) {
    setSelectionViewId(ganttViewId);
    if (scheduleFocus) {
      setScheduleFocus(null);
      setWindowStart(scheduleFocus.previousWindowStart);
    }
    if (selected.size) setSelected(new Set());
    if (shiftMode) setShiftMode(null);
    if (autoOpen) setAutoOpen(false);
    if (bulkDateSelection) setBulkDateSelection(null);
    if (bulkLinkSelection) setBulkLinkSelection(null);
    if (blockerLinksScope) setBlockerLinksScope(null);
    if (rowScheduleEdit) setRowScheduleEdit(null);
  }
  if (scheduleFocus && scheduleFocus.teamScope !== teamFocusScope) {
    setScheduleFocus(null);
    setSelected(scheduleFocus.previousSelection);
    setWindowStart(scheduleFocus.previousWindowStart);
    if (shiftMode === 'hierarchy') setShiftMode(null);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const teamUnscheduledFilter = useRef<HTMLInputElement>(null);
  const teamFilterOrigin = useRef<HTMLInputElement | null>(null);
  const pendingScheduleFocus = useRef<(() => void) | null>(null);
  const handledFocusRequest = useRef<string | null>(null);
  const analysisTrigger = useRef<HTMLButtonElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useRef(false);
  const findingsTrigger = useRef<HTMLButtonElement>(null);
  const deadlinesTrigger = useRef<HTMLButtonElement>(null);
  const teamBlockersTrigger = useRef<HTMLButtonElement>(null);
  const linkPickerTrigger = useRef<HTMLButtonElement>(null);
  const dependencyFocusTrigger = useRef<HTMLButtonElement>(null);
  const hierarchyFocusTrigger = useRef<HTMLButtonElement>(null);
  const selectionShiftTrigger = useRef<HTMLButtonElement>(null);
  const hierarchyShiftTrigger = useRef<HTMLButtonElement>(null);
  const shiftDaysField = useRef<HTMLInputElement>(null);
  const restoringScheduleFocus = useRef<ScheduleFocus | null>(null);
  const bulkDatesTrigger = useRef<HTMLButtonElement>(null);
  const bulkLinksTrigger = useRef<HTMLButtonElement>(null);
  const blockerLinksTrigger = useRef<HTMLButtonElement>(null);
  const pasteTrigger = useRef<HTMLButtonElement>(null);
  const linkEditorFocusTarget = useRef<HTMLButtonElement | null>(null);
  const previewDialog = useRef<HTMLElement>(null);
  const manualReviewAction = useRef<HTMLButtonElement>(null);
  const cascadePreviewButton = useRef<HTMLButtonElement>(null);
  const batchFollowUpOption = useRef<HTMLInputElement>(null);
  const restoreBatchFollowUpFocus = useRef(false);
  const teamFollowUpPreviewButton = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false), previewRef = useRef<SchedulePreview | null>(null);
  const draftsRef = useRef(new Map<string, { dirty: boolean; pending: boolean; awaitingResult: boolean }>());
  const inlineDateDrafts = useRef(new Map<string, InlineDateDraft>());
  const retainedDates = useRef(new Map<string, StoredGanttDateDraft>());
  const storageKey = ganttDateDraftKey(props.actorId, allProjects ? null : projectId, data.restoreGeneration);
  const [dateRecoveryReady, setDateRecoveryReady] = useState(false);
  const [dateStorageError, setDateStorageError] = useState(false);
  const draggingRef = useRef(false);
  const viewport = useRef<GanttViewport>(null);
  const restoreViewport = useRef<GanttViewportAnchor>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const [inlineDateRecords, setInlineDateRecords] = useState<ReadonlyMap<string, StoredGanttDateDraft>>(() => new Map());
  const [inlineDateFocused, setInlineDateFocused] = useState(false);
  const otherScheduleEditorOpen = Boolean(teamFollowUp || teamFollowUpHandoff || drag || datePicker || preview || cascade ||
    shiftMode || autoOpen || pasteScope || bulkDateSelection || bulkLinkSelection || blockerLinksScope || rowScheduleEdit ||
    createOpen || scheduleIssueCreation || blockedIssueCreation || teamBlockerEdit || linkEditor || planAssignment || planShift);
  const scheduleEditorOpen = otherScheduleEditorOpen || Boolean(linkPicker);
  const refreshPaused = Boolean(issueOverlayOpen || busy || hasDraft || inlineDateFocused || scheduleEditorOpen);
  useLayoutEffect(() => {
    const previous = restoringScheduleFocus.current;
    if (scheduleFocus || !previous) return;
    restoringScheduleFocus.current = null;
    const scroll = scrollRef.current;
    const toolbar = previous.kind === 'hierarchy' ? hierarchyFocusTrigger.current : dependencyFocusTrigger.current;
    const target = previous.opener.isConnected && !previous.opener.disabled ? previous.opener : toolbar ?? scroll;
    scroll?.scrollTo(previous.scrollLeft, previous.scrollTop);
    target?.focus({ preventScroll: true });
  }, [scheduleFocus]);
  useLayoutEffect(() => {
    // Wait for the dialog to close and its background controls to become interactive.
    if (busy || issueOverlayOpen || scheduleEditorOpen || !pendingScheduleFocus.current) return;
    const restore = pendingScheduleFocus.current;
    pendingScheduleFocus.current = null;
    restore();
  });
  // Synchronize before the refresh hook rechecks whether it can resume.
  useLayoutEffect(() => {
    draggingRef.current = Boolean(drag);
    previewRef.current = preview;
  }, [drag, preview]);
  const hasRefreshInteraction = useCallback(() => Boolean(busyRef.current || previewRef.current || draftsRef.current.size || draggingRef.current ||
    document.activeElement?.matches('input[data-schedule-edge]')), []);
  const refreshWithViewport = useCallback<WorkspaceRefresh>(async (signal, mode, canApply) => {
    let anchor: GanttViewportAnchor | null = null;
    const result = await refreshGantt(signal, mode, () => {
      if (!canApply()) return false;
      const scroll = scrollRef.current;
      const current = viewport.current;
      const head = scroll?.querySelector('.gantt-left-header');
      if (scroll && current) anchor = { ...current, left: scroll.scrollLeft, top: scroll.scrollTop,
        timelineVisible: Boolean(head && getComputedStyle(head).position === 'sticky') || scroll.scrollLeft + scroll.clientWidth > LEFT_WIDTH };
      return true;
    });
    if (!signal.aborted && result === 'updated') {
      restoreViewport.current = anchor;
      setRefreshCount(count => count + 1);
    }
    return result;
  }, [refreshGantt]);
  const { requestMode, feedback: refreshFeedback, manualRefresh, reconsider } = useWorkspaceRefresh(refreshWithViewport, refreshPaused, hasRefreshInteraction);
  useLayoutEffect(() => {
    if (!inlineDateFocused || document.activeElement?.matches('input[data-schedule-edge]')) return;
    const timer = setTimeout(() => {
      if (!document.activeElement?.matches('input[data-schedule-edge]')) setInlineDateFocused(false);
    }, 0);
    return () => clearTimeout(timer);
  });
  useLayoutEffect(() => {
    if (busy || !restoreBatchFollowUpFocus.current) return;
    restoreBatchFollowUpFocus.current = false;
    batchFollowUpOption.current?.focus({ preventScroll: true });
  }, [busy, preview]);
  useLayoutEffect(() => {
    if (!preview || (batchFollowUpOption.current && document.activeElement === batchFollowUpOption.current)) return;
    previewDialog.current?.focus();
  }, [preview]);
  useLayoutEffect(() => {
    if (shiftMode) shiftDaysField.current?.focus();
  }, [shiftMode]);
  useLayoutEffect(() => {
    if (!busy && (manualProblem?.kind === 'stale' || manualProblem?.kind === 'uncertain')) {
      manualReviewAction.current?.focus({ preventScroll: true });
    }
  }, [busy, manualProblem?.kind]);
  useLayoutEffect(() => {
    if (createOpen || !restoreCreateFocus.current) return;
    restoreCreateFocus.current = false;
    createTrigger.current?.focus({ preventScroll: true });
  }, [createOpen]);
  useEffect(() => {
    if (busy || linkEditor || !linkEditorFocusTarget.current) return;
    const opener = linkEditorFocusTarget.current;
    linkEditorFocusTarget.current = null;
    if (opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    else scrollRef.current?.focus({ preventScroll: true });
  }, [busy, linkEditor]);
  const trackDraft = useCallback<TrackDraft>((id, dirty, pending = false, awaitingResult = false) => {
    const hadDraft = draftsRef.current.size > 0;
    if (dirty || pending || awaitingResult) draftsRef.current.set(id, { dirty, pending, awaitingResult });
    else draftsRef.current.delete(id);
    const next = draftsRef.current.size > 0;
    if (next !== hadDraft) {
      setHasDraft(next);
      reconsider();
    }
  }, [reconsider]);
  const trackReservationDraft = useCallback((dirty: boolean, pending: boolean) => trackDraft(TIME_RESERVATIONS_DRAFT, dirty, pending), [trackDraft]);
  const trackTeamBlockerDraft = useCallback((dirty: boolean, pending: boolean) => trackDraft(TEAM_BLOCKER_DRAFT, dirty, pending), [trackDraft]);
  const trackTeamBlockerEdit = useCallback((dirty: boolean, pending: boolean, awaitingResult?: boolean) =>
    trackDraft(TEAM_BLOCKER_EDIT_DRAFT, dirty, pending, awaitingResult), [trackDraft]);
  const trackTeamFollowUpOutcome = useCallback((unknown: boolean) => trackDraft(TEAM_FOLLOW_UP_DRAFT, true, false, unknown), [trackDraft]);
  useEffect(() => {
    if (dateRecoveryReady) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = readGanttDateDrafts(window.sessionStorage, storageKey);
        const count = stored.size;
        if (count) {
          for (const issue of data.issues) {
            const draft = recoverableDates(issue, stored.get(issue.id));
            if (draft && draftDatesAreSaved(issue, draft)) stored.delete(issue.id);
          }
        }
        retainedDates.current = stored;
        setInlineDateRecords(new Map(stored));
        if (count !== stored.size) writeGanttDateDrafts(window.sessionStorage, storageKey, stored);
      } catch { setDateStorageError(true); }
      setDateRecoveryReady(true);
    });
    return () => { active = false; };
  }, [data.issues, dateRecoveryReady, storageKey]);
  const storeInlineDates = useCallback(() => {
    setInlineDateRecords(new Map(retainedDates.current));
    try {
      writeGanttDateDrafts(window.sessionStorage, storageKey, retainedDates.current);
      setDateStorageError(false);
    } catch { setDateStorageError(true); }
  }, [storageKey]);
  useImperativeHandle(props.issueDateDraftsRef, () => ({
    read(issue) {
      const draft = recoverableDates(issue, retainedDates.current.get(issue.id));
      return draft && !draftDatesAreSaved(issue, draft) ? draft : undefined;
    },
    acceptSaved(draft, saved) {
      if (retainedDates.current.get(draft.id) !== draft || saved.id !== draft.id ||
          saved.projectId !== draft.projectId || !draftDatesAreSaved(saved, draft)) return;
      const live = inlineDateDrafts.current.get(saved.id);
      if (live) live.accept(saved);
      else {
        retainedDates.current.delete(saved.id);
        storeInlineDates();
      }
    },
  }), [storeInlineDates]);
  const clearInlineDates = useCallback(() => {
    inlineDateDrafts.current.clear();
    if (!retainedDates.current.size) return;
    retainedDates.current.clear();
    storeInlineDates();
  }, [storeInlineDates]);
  const trackInlineDates = useCallback((id: string, draft: InlineDateDraft | null, owner: symbol, detached = false) => {
    const drafts = inlineDateDrafts.current;
    if (!draft) {
      if (drafts.get(id)?.owner !== owner) return;
      drafts.delete(id);
      if (!detached && retainedDates.current.delete(id)) storeInlineDates();
      return;
    }
    drafts.set(id, draft);
    const { projectId, version, startDate, endDate } = draft.source;
    const previous = retainedDates.current.get(id);
    if (previous?.projectId === projectId && previous.version === version && previous.startDate === startDate &&
        previous.endDate === endDate && previous.draftStart === draft.startDate && previous.draftEnd === draft.endDate) return;
    retainedDates.current.set(id, { id, projectId, version, startDate, endDate, draftStart: draft.startDate, draftEnd: draft.endDate });
    storeInlineDates();
  }, [storeInlineDates]);
  const markBusy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value); }, []);
  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busyRef.current || [...draftsRef.current.values()].some(value => value.pending)) {
        event.preventDefault(); notify('일정 변경이 끝난 뒤 이동해 주세요.', 'error'); return;
      }
      if (isGanttPreservedByNavigation(event)) return;
      const keepDates = areGanttDateDraftsPreservedByNavigation(event);
      const discardableDrafts = [...draftsRef.current].filter(([id]) => !keepDates || !id.startsWith('dates:'));
      if (previewRef.current || discardableDrafts.some(([, value]) => value.dirty)) {
        const awaitingCreationResult = draftsRef.current.get(CREATE_ISSUE_DRAFT)?.awaitingResult;
        const awaitingLinkResult = draftsRef.current.get(BULK_LINKS_DRAFT)?.awaitingResult || draftsRef.current.get(BLOCKER_LINKS_DRAFT)?.awaitingResult;
        const awaitingPasteResult = draftsRef.current.get(SCHEDULE_PASTE_DRAFT_ID)?.awaitingResult;
        const awaitingFollowUpResult = draftsRef.current.get(TEAM_FOLLOW_UP_DRAFT)?.awaitingResult || draftsRef.current.get(TEAM_BLOCKER_EDIT_DRAFT)?.awaitingResult;
        const awaitingScheduleResult = awaitingPasteResult || awaitingFollowUpResult || manualProblem?.kind === 'uncertain' || manualProblem?.kind === 'unavailable';
        const confirmation = awaitingLinkResult ? '연결이 이미 추가됐을 수 있습니다. 적용 결과 확인을 닫고 이동할까요?'
          : awaitingScheduleResult ? '일정이 이미 저장됐을 수 있습니다. 적용 결과 확인을 닫고 이동할까요?'
          : awaitingCreationResult
          ? '업무가 이미 추가됐을 수 있습니다. 간트 목록에서 결과를 확인할 수 있습니다. 현재 입력을 닫을까요?'
          : keepDates ? '열린 간트 편집과 미리보기를 닫을까요? 행에 입력한 날짜는 유지됩니다.'
          : '저장하지 않은 간트 입력과 미리보기를 버리고 이동할까요?';
        if (!window.confirm(confirmation)) event.preventDefault();
        else {
          const discardPlanShift = draftsRef.current.has('plan-schedule-shift');
          const discardBulkDates = draftsRef.current.has(BULK_DATES_DRAFT);
          afterAcceptedNavigation(event, () => {
            previewRef.current = null;
            setDatePreviewFocusTarget(null);
            for (const [id] of discardableDrafts) draftsRef.current.delete(id);
            if (!keepDates) clearInlineDates();
            setHasDraft(draftsRef.current.size > 0);
            setManualReview(null); setManualProblem(null); setCascade(null); setCreateOpen(false); setLinkEditor(null); setLinkPicker(null); setDatePicker(null); setShiftMode(null); setDrag(null); setPlanAssignment(null);
            setTeamFollowUp(null);
            setTeamFollowUpHandoff(null);
            setTeamBlockerChartPair(undefined);
            setTeamBlockerEdit(null);
            setPasteScope(null);
            setBulkLinkSelection(null);
            setBlockerLinksScope(null);
            if (discardPlanShift) setPlanShift(null);
            if (discardBulkDates) setBulkDateSelection(null);
            setRowScheduleEdit(null);
            setDraftEpoch(value => value + 1);
            if (awaitingCreationResult || awaitingLinkResult || awaitingPasteResult || awaitingFollowUpResult) {
              void refresh().catch(() => notify('간트 목록을 불러오지 못했습니다. 화면을 다시 열어 확인해 주세요.', 'error'));
            }
          });
        }
      } else afterAcceptedNavigation(event, () => {
        setRowScheduleEdit(null);
        setPasteScope(null);
        setBulkLinkSelection(null);
        setBlockerLinksScope(null);
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      const needsConfirmation = [...draftsRef.current].some(([id, draft]) =>
        !id.startsWith('dates:') || draft.pending || draft.awaitingResult || dateStorageError);
      if (busyRef.current || previewRef.current || needsConfirmation) { event.preventDefault(); event.returnValue = ''; }
    };
    const importReset = () => {
      trackDraft(TEAM_FOLLOW_UP_DRAFT, false);
      setTeamFollowUp(null);
      setTeamFollowUpHandoff(null);
      setTeamBlockerChartPair(undefined);
      setTeamBlockerEdit(null);
      setPasteScope(null);
      setBulkLinkSelection(null);
      setBlockerLinksScope(null);
      setManualReview(null); setManualProblem(null); setDatePreviewFocusTarget(null);
      setBlockedIssueCreation(null); setCreatedBlockedIssue(null);
      setRowScheduleEdit(null); setScheduleFocus(null); setShiftMode(null); setSelected(new Set());
      clearInlineDates();
      setDraftEpoch(value => value + 1);
    };
    window.addEventListener('teamspace:navigate', guard); window.addEventListener('beforeunload', unload);
    window.addEventListener('teamspace:workspace-imported', importReset);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('teamspace:workspace-imported', importReset);
    };
  }, [notify, refresh, trackDraft, manualProblem?.kind, clearInlineDates, dateStorageError]);
  function canLeave() { return window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })); }
  function closeTeamBlockers() {
    const draft = draftsRef.current.get(TEAM_BLOCKER_DRAFT);
    if (draft?.pending || (draft?.dirty && !window.confirm('입력한 차단 관계를 취소하시겠습니까?'))) return;
    setTeamBlockersOpen(false);
    setTeamBlockerChartPair(undefined);
    setCreatedBlockedIssue(null);
    teamBlockersTrigger.current?.focus({ preventScroll: true });
  }
  function chartDateDraft(issue: Issue): ChartDateDraft | undefined {
    const live = inlineDateDrafts.current.get(issue.id);
    const stored = recoverableDates(issue, retainedDates.current.get(issue.id));
    if (live?.source.projectId === issue.projectId) {
      const changes = changedInlineDates(live);
      return Object.keys(changes).length ? { source: live.source, changes, owner: live.owner, stored } : undefined;
    }
    if (!stored || draftDatesAreSaved(issue, stored)) return undefined;
    const source = { ...issue, version: stored.version, startDate: stored.startDate, endDate: stored.endDate };
    const changes = changedInlineDates({ source, startDate: stored.draftStart, endDate: stored.draftEnd });
    return Object.keys(changes).length ? { source, changes, stored } : undefined;
  }
  function acceptChartDateDraft(saved: Issue, draft: ChartDateDraft | undefined) {
    if (!draft) return;
    const live = inlineDateDrafts.current.get(saved.id);
    if (live && live.owner === draft.owner) live.accept(saved);
    else if (draft.stored && retainedDates.current.get(saved.id) === draft.stored) {
      if (live) live.accept(saved);
      else { retainedDates.current.delete(saved.id); storeInlineDates(); }
    }
  }
  function reviewTeamBlockerDates(source: Issue, target: Issue, opener: HTMLButtonElement) {
    if (busyRef.current || scheduleEditorOpen || issueOverlayOpen ||
        [...draftsRef.current.values()].some(draft => draft.pending || draft.awaitingResult)) return;
    const sourceDraft = chartDateDraft(source), targetDraft = chartDateDraft(target);
    if (sourceDraft || targetDraft) setTeamBlockerEdit({ source, target, opener, sourceDraft, targetDraft });
  }
  function closeTeamBlockerEdit() {
    const opener = teamBlockerEdit?.opener;
    setTeamBlockerEdit(null);
    requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    });
  }
  async function applyTeamBlockerEdit(result: ScheduleTeamBlockerApplyResult) {
    rememberUndo(result.undoId);
    setScheduleWarnings(result.warnings);
    for (const saved of result.updated) {
      const selected = [teamBlockerEdit?.sourceDraft, teamBlockerEdit?.targetDraft].find(draft => draft?.source.id === saved.id);
      acceptChartDateDraft(saved, selected);
    }
    const opener = teamBlockerChartPair?.opener;
    try {
      await refresh();
      notify(result.updated.length ? '날짜와 차단 관계를 함께 저장했습니다.' : '차단 관계를 저장했습니다.');
    }
    catch { notify('변경을 저장했습니다. 간트 목록을 다시 불러와 주세요.', 'error'); }
    setTeamBlockerEdit(null);
    setTeamBlockerChartPair(undefined);
    setTeamBlockerListRevision(value => value + 1);
    requestAnimationFrame(() => (opener?.isConnected && !opener.disabled ? opener : teamBlockersTrigger.current)?.focus({ preventScroll: true }));
  }
  function openBlockedIssueCreation(issue: Issue, opener: HTMLButtonElement) {
    if (busyRef.current || scheduleEditorOpen || issueOverlayOpen ||
        [...draftsRef.current.values()].some(draft => draft.pending || draft.awaitingResult)) {
      notify('처리 중인 간트 작업을 마친 뒤 새 업무를 만들어 주세요.', 'error');
      return;
    }
    setBlockedIssueCreation({ issue, opener });
  }
  function closeBlockedIssueCreation() {
    const opener = blockedIssueCreation?.opener;
    setBlockedIssueCreation(null);
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== opener) return;
      const target = opener?.isConnected && !opener.disabled ? opener : teamBlockersTrigger.current ?? scrollRef.current;
      target?.focus({ preventScroll: true });
    });
  }
  function reviewTeamBlockerSchedules(source: Issue, choices: readonly TeamFollowUpChoice[], opener: HTMLButtonElement) {
    if (busyRef.current || scheduleEditorOpen || issueOverlayOpen || draftsRef.current.size) {
      notify('작성 중인 간트 변경을 저장하거나 닫은 뒤 프로젝트 간 일정을 검토해 주세요.', 'error');
      return;
    }
    if (choices.length) startTeamFollowUp({ source, choices, origin: { kind: 'blockers', opener } });
  }
  function reviewTeamSuccessors(source: TeamFollowUpHandoff['source'], initialChange: ScheduleAnchorChange,
    origin: Exclude<TeamFollowUpOrigin, { kind: 'blockers' }>) {
    if (busyRef.current || teamFollowUp || teamFollowUpHandoff || issueOverlayOpen || cascade ||
        [...draftsRef.current.values()].some(draft => draft.pending || draft.awaitingResult)) return;
    const choices = teamBlockerChoices.get(source.id);
    if (!choices?.length) return;
    startTeamFollowUp({ source, initialChange, origin, choices });
  }
  function startTeamFollowUp(handoff: TeamFollowUpHandoff) {
    trackDraft(TEAM_FOLLOW_UP_DRAFT, true);
    if (handoff.choices.length === 1) openTeamFollowUpChoices(handoff, handoff.choices);
    else setTeamFollowUpHandoff(handoff);
  }
  function openTeamFollowUpChoices({ source, initialChange, origin }: TeamFollowUpHandoff, choices: readonly TeamFollowUpChoice[]) {
    const { id, key, version, startDate, endDate } = source;
    setTeamFollowUpHandoff(null);
    setTeamFollowUp({ choices, source: { id, key, version, startDate, endDate }, initialChange, origin });
  }
  function restoreTeamFollowUpOrigin(origin: TeamFollowUpOrigin, sourceId: string, updated?: readonly Issue[]) {
    const completed = Boolean(updated && focusAfterCompletingMissingRows(updated));
    if (origin.kind === 'preview') {
      if (updated) restoreDatePreviewFocus(!completed);
      else requestAnimationFrame(() => (teamFollowUpPreviewButton.current ?? previewDialog.current)?.focus({ preventScroll: true }));
      return;
    }
    if (completed) return;
    pendingScheduleFocus.current = () => {
      if (origin.kind === 'inline') restoreInlineCascadeFocus(origin, sourceId);
      else {
        const currentAction = origin.opener.dataset.teamFollowUpSource === sourceId
          ? document.getElementById(TEAM_BLOCKERS_PANEL_ID)?.querySelector<HTMLButtonElement>(`[data-team-follow-up-source="${CSS.escape(sourceId)}"]`)
          : null;
        const target = [origin.opener, currentAction, teamBlockersTrigger.current, scrollRef.current].find(element =>
          element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled'));
        target?.focus({ preventScroll: true });
      }
    };
  }
  function closeTeamFollowUp() {
    const selection = teamFollowUp ?? teamFollowUpHandoff;
    if (!selection) return;
    const awaitingResult = draftsRef.current.get(TEAM_FOLLOW_UP_DRAFT)?.awaitingResult;
    trackDraft(TEAM_FOLLOW_UP_DRAFT, false);
    setTeamFollowUp(null);
    setTeamFollowUpHandoff(null);
    restoreTeamFollowUpOrigin(selection.origin, selection.source.id);
    if (awaitingResult) void refresh().catch(() => notify('간트 목록을 불러오지 못했습니다. 화면을 다시 열어 확인해 주세요.', 'error'));
  }
  async function applyTeamFollowUp(result: ApplyResult, unchangedSource?: Pick<Issue, 'version' | 'startDate' | 'endDate'>) {
    if (!teamFollowUp) return;
    const { origin, source } = teamFollowUp;
    rememberUndo(result.undoId);
    setScheduleWarnings(result.warnings ?? []);
    await refresh();
    const savedSource = result.updated.find(issue => issue.id === source.id);
    const accept = origin.kind === 'inline' ? origin.accept : origin.kind === 'preview' && manualReview?.inline?.issueId === source.id
      ? manualReview.inline.accept : undefined;
    if (savedSource) accept?.(savedSource);
    else if (accept && unchangedSource) {
      const original = origin.kind === 'inline' ? origin.source : data.issues.find(issue => issue.id === source.id);
      if (original) accept({ ...original, ...unchangedSource });
    }
    if (origin.kind === 'preview') {
      setManualReview(null);
      setManualProblem(null);
    }
    trackDraft(TEAM_FOLLOW_UP_DRAFT, false);
    setTeamFollowUp(null);
    restoreTeamFollowUpOrigin(origin, source.id, result.updated);
    const includesSource = Boolean(savedSource);
    notify(`${result.updated.length}개 ${includesSource ? '업무' : '후행 업무'}의 일정을 변경했습니다.`);
  }
  function finishCreating() {
    restoreCreateFocus.current = true;
    setCreateOpen(false);
  }
  function closeCreateForm() {
    if (canLeave()) finishCreating();
  }
  function closeScheduleIssueCreation() {
    const opener = scheduleIssueCreation?.opener;
    setScheduleIssueCreation(null);
    requestAnimationFrame(() => {
      const target = opener?.isConnected && !opener.disabled ? opener : scrollRef.current;
      target?.focus({ preventScroll: true });
    });
  }
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
    rememberUndo(result.undoId);
    setScheduleWarnings(result.warnings || []);
    await refresh();
    notify(`과부하를 줄이는 ${result.updated.length}개 업무의 일정을 적용했습니다.`);
  }
  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const teamGitlabSummaries = useMemo(() => allProjects ? summarizeIssueGitlabLinks(data.gitlabLinks) : null, [allProjects, data.gitlabLinks]);
  const { outgoing: teamBlockerChoices, incoming: incomingTeamBlockers } = useMemo(() => groupActiveTeamBlockers(data, projectsById), [data, projectsById]);
  const projectIssues = useMemo(() => {
    if (!allProjects) return data.issues.filter(issue => issue.projectId === projectId);
    const byProject = new Map(data.projects.map(project => [project.id, [] as Issue[]]));
    for (const issue of data.issues) byProject.get(issue.projectId)?.push(issue);
    return [...byProject.values()].flat();
  }, [allProjects, data.issues, data.projects, projectId]);
  const chartProjectFilter = allProjects ? teamProjectFilter : null;
  const filteredProject = chartProjectFilter ? projectsById.get(chartProjectFilter) : undefined;
  const scopedIssues = useMemo(() => chartProjectFilter ? projectIssues.filter(issue => issue.projectId === chartProjectFilter) : projectIssues,
    [chartProjectFilter, projectIssues]);
  const calendarsByProject = useMemo(() => new Map((data.calendars ?? []).map(calendar => [calendar.projectId, calendar])), [data.calendars]);
  const calendarFor = useCallback((id: string) => calendarsByProject.get(id) ?? defaultWorkCalendar(id), [calendarsByProject]);
  const dependencyTrace = useMemo(() => scheduleFocus?.kind === 'dependencies' ? traceGanttDependencies(scheduleFocus.issueId, projectIssues, data.dependencies) : null,
    [scheduleFocus, projectIssues, data.dependencies]);
  const hierarchyTrace = useMemo(() => {
    if (scheduleFocus?.kind !== 'hierarchy') return null;
    const trace = traceGanttHierarchy(scheduleFocus.issueId, projectIssues, issue => statusMeta({ workflows: data.workflows }, issue.projectId, issue.status).category);
    return trace?.anchor.projectId === scheduleFocus.projectId ? trace : null;
  }, [scheduleFocus, projectIssues, data.workflows]);
  const focusedTrace = dependencyTrace ?? hierarchyTrace;
  const rowEditProjectId = rowScheduleEdit?.issue.projectId;
  const rowEditIssues = useMemo(() => rowEditProjectId ? projectIssues.filter(issue => issue.projectId === rowEditProjectId) : [],
    [projectIssues, rowEditProjectId]);
  const rowEditCalendar = useMemo(() => rowEditProjectId ? calendarFor(rowEditProjectId) : undefined, [calendarFor, rowEditProjectId]);
  const editingDependency = linkEditor?.dependency;
  const latestDependency = editingDependency && data.dependencies.find(link => link.id === editingDependency.id);
  const staleDependencyMessage = editingDependency && (!latestDependency
    ? '이 연결이 더 이상 존재하지 않습니다. 편집을 닫고 현재 목록을 확인하세요.'
    : (latestDependency.version ?? 1) !== (editingDependency.version ?? 1)
      ? '다른 작업자가 이 연결을 변경했습니다. 편집을 닫고 다시 열어 최신 연결을 확인하세요.' : undefined);
  const hierarchy = useMemo(() => buildIssueHierarchy(projectIssues), [projectIssues]);
  const project = allProjects ? undefined : projectsById.get(projectId);
  const hasProject = Boolean(project);
  const sheetScope: ScheduleProjectScope | null = project ?? filteredProject ?? (allProjects && !chartProjectFilter && data.projects.length ? 'team' : null);
  const sharedViews = useMemo(() => allProjects ? [] : (data.savedViews ?? []).filter(view => view.projectId === projectId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko')), [allProjects, data.savedViews, projectId]);
  const { sharedView, matchSharedView } = useMemo(() => {
    const view = data.savedViews?.find(view => view.id === ganttViewId && view.projectId === projectId);
    return { sharedView: view, matchSharedView: view ? createIssueViewMatcher(view.filters, data, projectIssueSchema(data, projectId)) : null };
  }, [data, ganttViewId, projectId]);
  const sharedViewUnavailable = ganttViewId !== null && !sharedView;
  const sharedFilters = sharedView?.filters;
  const sharedSortLabels = issueViewSortLabels(sharedView?.sort);
  const sharedIssueOrder = sharedView && data.issueOrders?.find(order => order.projectId === projectId);
  const sharedStatusLabel = sharedFilters ? issueStatusFilterLabel(sharedFilters, projectStatuses(data, projectId)) : undefined;
  const sharedGitlabFilter = sharedFilters?.gitlab;
  const sharedReporterLabel = sharedFilters?.reporter ? issueReporterFilterLabel(sharedFilters.reporter, data.users) : undefined;
  const sharedPlanningFilter = sharedFilters?.planning;
  const sharedPlanningLabels = issuePlanningFilterLabels(sharedPlanningFilter, projectPlans);
  const sharedPriorityLabelCriteria = sharedFilters ? issuePriorityLabelFilterLabels(sharedFilters) : [];
  const sharedDateFilter = sharedPlanningFilter?.dates;
  const overlapAnchor = sharedDateFilter?.mode === 'overlap' ? sharedDateFilter.from ?? sharedDateFilter.to : undefined;
  const selectedPlan = projectPlans.find(item => item.id === selectedPlanningId);
  const shiftPlan = planShift && (projectPlans.find(item => item.id === planShift.id) ?? planShift);
  const planningScope = planningExpanded && linkedOnly ? selectedPlan : undefined;
  const planningRows = planningExpanded && !scheduleFocus ? projectPlans.filter(item => planningScope ? item.id === planningScope.id : item.status !== 'archived' || item.id === selectedPlanningId) : [];
  const planStats = useMemo(() => planMembershipStats(projectPlans, projectIssues), [projectPlans, projectIssues]);
  function locallyVisibleIssues(text: string, hideTerminal: boolean, scope?: PlanningItem, candidates = scopedIssues,
    scheduleFilters = allProjects ? teamScheduleFilters : undefined) {
    const teamSearch = allProjects && text.trim() ? createTeamIssueSearchMatcher(text) : null;
    const projectSearch = allProjects ? '' : text.toLowerCase();
    const projectAliasSearch = allProjects ? '' : normalizeWorkspaceSearchKey(text);
    return candidates.filter(issue => (!scope || issue[planningFields(scope.kind).idField] === scope.id) &&
      (!hideTerminal || !isTerminalStatus(data, issue.projectId, issue.status)) &&
      (scheduleFilters?.assigneeId === undefined || (issue.assigneeId ?? null) === scheduleFilters.assigneeId) &&
      (!scheduleFilters?.unscheduledOnly || !issue.startDate || !issue.endDate) &&
      (!scheduleFilters?.gitlab || matchesGitlabFilter(scheduleFilters.gitlab, teamGitlabSummaries?.get(issue.id))) &&
      (!teamSearch || teamSearch(data, issue, projectsById.get(issue.projectId), statusMeta(data, issue.projectId, issue.status).label)) &&
      (!projectSearch || issueSearchText(data, issue).toLowerCase().includes(projectSearch) ||
        matchingIssueSearchAliases(data, issue.id, projectAliasSearch).length > 0));
  }
  function sharedViewRows(rows: Issue[]) {
    if (sharedViewUnavailable) return [];
    return matchSharedView ? orderIssueView(rows.filter(matchSharedView), sharedIssueOrder, sharedView?.sort) : rows;
  }
  function chartRows(text: string, hideTerminal: boolean, scope?: PlanningItem, candidates = scopedIssues, scheduleFilters?: TeamGanttScheduleFilters) {
    const rows = sharedViewRows(locallyVisibleIssues(text, hideTerminal, scope, candidates, scheduleFilters));
    const pinnedIssue = focusedIssue && (allProjects || focusDateEndpoint || focusInPlan) && !rows.some(issue => issue.id === focusedIssue.id) ? focusedIssue : undefined;
    return { rows: pinnedIssue ? [pinnedIssue, ...rows] : rows, pinnedIssue };
  }
  const { rows: ordinaryIssues, pinnedIssue } = chartRows(query, hideDone, planningScope);
  const visibleIssues = scheduleFocus ? focusedTrace?.issues ?? [] : ordinaryIssues;
  // A peer edit can put a recovered draft outside the current filters.
  const recoverableRows = inlineDateRecords.size ? projectIssues.filter(issue =>
    recoverableDates(issue, inlineDateRecords.get(issue.id))) : [];
  const recoverableIds = new Set(recoverableRows.map(issue => issue.id));
  const unavailableDateIds = [...inlineDateRecords.keys()].filter(id => !recoverableIds.has(id));
  const visibleIds = inlineDateRecords.size ? new Set(visibleIssues.map(issue => issue.id)) : null;
  const retainedDateRows = visibleIds && !scheduleFocus
    ? recoverableRows.filter(issue => !visibleIds.has(issue.id)) : [];
  const issues = retainedDateRows.length ? [...visibleIssues, ...retainedDateRows] : visibleIssues;
  const inlineDateCount = inlineDateRecords.size ? issues.filter(issue => recoverableIds.has(issue.id)).length : 0;
  const ordinaryIssueIds = focusedTrace ? new Set(ordinaryIssues.map(issue => issue.id)) : null;
  const outsideFilterCount = ordinaryIssueIds ? issues.filter(issue => !ordinaryIssueIds.has(issue.id) && issue.id !== hierarchyTrace?.anchor.id).length : 0;
  const baseline = data.baselines?.find(value => value.id === selectedBaselineId && value.projectId === projectId);
  const milestones = useMemo(() => allProjects || scheduleFocus ? [] : (data.milestones || []).filter(value => value.projectId === projectId),
    [allProjects, data.milestones, projectId, scheduleFocus]);
  const reviewedMilestone = milestones.find(item => item.id === milestoneReviewId);
  const historicalIssues = scheduleFocus || planningScope || ganttViewId !== null ? [] : baseline?.issues.filter(value => !projectIssues.some(issue => issue.id === value.issueId)) || [];
  const historicalMilestones = scheduleFocus ? [] : baseline?.milestones.filter(value => !milestones.some(milestone => milestone.id === value.milestoneId)) || [];
  const onlyTeamProjectId = data.projects.length === 1 ? data.projects[0].id : null;
  const chartProjectId = allProjects ? chartProjectFilter ?? onlyTeamProjectId : projectId;
  const timelineProjectId = focusedTrace?.anchor.projectId ?? (pinnedIssue && pinnedIssue.projectId !== chartProjectId ? null : chartProjectId);
  const findingsProjectId = focusedTrace?.anchor.projectId ?? chartProjectFilter;
  const calendar = useMemo(() => timelineProjectId ? calendarFor(timelineProjectId) : undefined, [calendarFor, timelineProjectId]);
  const calendarMath = useMemo(() => calendar && createCalendarMath(calendar), [calendar]);
  const { projectDependencyCount, findings, conflictingIds, linkedIssueIds, outgoingIssueIds } = useMemo(() => {
    const issuesById = new Map(projectIssues.map(issue => [issue.id, issue]));
    const findings: GanttDependencyFinding[] = [];
    const conflictingIds = new Set<string>();
    const linkedIssueIds = new Set<string>();
    const outgoingIssueIds = new Set<string>();
    const mathByProject = new Map<string, ReturnType<typeof createCalendarMath>>();
    if (timelineProjectId && calendarMath) mathByProject.set(timelineProjectId, calendarMath);
    let projectDependencyCount = 0;
    for (const dependency of data.dependencies) {
      const predecessor = issuesById.get(dependency.predecessorId);
      const successor = issuesById.get(dependency.successorId);
      if (!predecessor || !successor || predecessor.projectId !== successor.projectId) continue;
      const dependencyProjectId = predecessor.projectId;
      linkedIssueIds.add(predecessor.id);
      linkedIssueIds.add(successor.id);
      outgoingIssueIds.add(predecessor.id);
      if (!chartProjectFilter || dependencyProjectId === chartProjectFilter) projectDependencyCount++;
      if (findingsProjectId && dependencyProjectId !== findingsProjectId) continue;
      let dependencyCalendar = mathByProject.get(dependencyProjectId);
      if (!dependencyCalendar) {
        dependencyCalendar = createCalendarMath(calendarFor(dependencyProjectId));
        mathByProject.set(dependencyProjectId, dependencyCalendar);
      }
      const check = checkDependencySchedule(dependency, predecessor, successor, dependencyCalendar);
      if (check.kind === 'valid') continue;
      findings.push({ dependency, predecessor, successor, check });
      if (check.kind === 'conflict') conflictingIds.add(dependency.id);
    }
    return { projectDependencyCount, findings, conflictingIds, linkedIssueIds, outgoingIssueIds };
  }, [projectIssues, data.dependencies, calendarFor, calendarMath, chartProjectFilter, timelineProjectId, findingsProjectId]);
  const singleChange = preview?.changes.length === 1 ? preview.changes[0] : undefined;
  const hierarchyPreview = manualReview && 'hierarchy' in manualReview.input ? manualReview.input.hierarchy : null;
  const missingHierarchyAnchor = Boolean(hierarchyPreview && hierarchyTrace?.anchor.id !== hierarchyPreview.id);
  const previewCascade = !hierarchyPreview && !manualReview?.inlineDates && !manualReview?.input.rescheduleSuccessors &&
    singleChange && outgoingIssueIds.has(singleChange.id) ? singleChange : null;
  const batchDateInput = manualReview?.inlineDates && 'changes' in manualReview.input ? manualReview.input : null;
  const hasInlineDateReview = Boolean(manualReview?.inline || manualReview?.inlineDates);
  const batchFollowUp = batchDateInput?.rescheduleSuccessors === true;
  const canReviewBatchFollowUp = batchDateInput && (batchFollowUp || batchDateInput.changes.some(change => outgoingIssueIds.has(change.id)));
  const batchAnchorIds = batchFollowUp ? new Set(batchDateInput.changes.map(change => change.id)) : null;
  const adjustedShiftSuccessors = preview?.followUpIssueIds ? new Set(preview.followUpIssueIds) : null;
  const previewTeamFollowUp = manualReview && 'changes' in manualReview.input && manualReview.input.changes.length === 1 &&
    singleChange && teamBlockerChoices.has(singleChange.id) ? singleChange : null;
  const analysisResult = useMemo(() => {
    if (!analysisOpen || !hasProject || !calendar) return null;
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
    const extentIssues = hierarchyTrace?.issues ?? (allProjects && dependencyTrace ? dependencyTrace.issues : scopedIssues);
    const dates = [...extentIssues.flatMap(value => [value.startDate, value.endDate, value.dueDate]), ...planningRows.flatMap(value => [value.startDate, value.endDate, value.targetDate]), ...milestones.map(value => value.date), ...(baseline?.issues.flatMap(value => [value.startDate, value.endDate]) || []), ...(baseline?.milestones.map(value => value.date) || [])];
    let first = today - 7;
    let last = today + 35;
    for (const date of dates) {
      if (!date) continue;
      const day = dayNumber(date);
      if (!Number.isFinite(day)) continue;
      first = Math.min(first, day);
      last = Math.max(last, day);
    }
    const start = first - 2, end = last + 3;
    return { start, end, days: end - start + 1 };
  })();
  const defaultRangeStart = overlapAnchor
    ? dayNumber(windowForDate(overlapAnchor))
    : clampWindowStart(extent.days <= MAX_TIMELINE_DAYS ? extent.start : dayNumber(todayDate()) - 9);
  const requestedStart = windowStart ? dayNumber(windowStart) : defaultRangeStart;
  const rangeStart = Number.isFinite(requestedStart) ? clampWindowStart(requestedStart) : defaultRangeStart;
  const rangeDays = windowStart || overlapAnchor || extent.days > MAX_TIMELINE_DAYS ? MAX_TIMELINE_DAYS : extent.days;
  const range = { start: rangeStart, end: rangeStart + rangeDays - 1, days: rangeDays };
  const chartZoom = datePicker ? 'day' : zoom;
  const dayWidth = chartZoom === 'day' ? 32 : chartZoom === 'week' ? 15 : 6;
  const timelineWidth = range.days * dayWidth;
  const viewportContext = JSON.stringify([projectId, allProjects, teamFocusScope, ganttViewId, focusRequest, windowStart, chartZoom,
    selectedPlanningId, planningExpanded, linkedOnly, selectedBaselineId, scheduleFocus?.kind, scheduleFocus?.issueId]);
  useLayoutEffect(() => {
    viewport.current = { data, context: viewportContext, start: rangeStart, dayWidth };
    const anchor = restoreViewport.current;
    if (!anchor || anchor.data === data) return;
    restoreViewport.current = null;
    if (anchor.context !== viewportContext || anchor.dayWidth !== dayWidth) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const left = anchor.timelineVisible ? Math.max(0, anchor.left + (anchor.start - rangeStart) * dayWidth) : anchor.left;
    scroll.scrollTo(left, anchor.top);
  }, [data, viewportContext, rangeStart, dayWidth, refreshCount]);
  useLayoutEffect(() => {
    if (!focusRequest) {
      handledFocusRequest.current = null;
      return;
    }
    if (handledFocusRequest.current === focusRequest) return;
    // Date inputs mount after the saved inline drafts have been recovered.
    if (!issueOverlayOpen && !dateRecoveryReady && (focusDateEndpoint || !focusedIssue?.startDate || !focusedIssue.endDate)) return;
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      const row = scroll?.querySelector<HTMLDivElement>('[data-focused-issue="true"]');
      if (!focusedIssue || !scroll || !row) return;

      const { id, startDate, endDate } = focusedIssue;
      if (!issueOverlayOpen) scroll.scrollIntoView({ block: 'start', inline: 'nearest' });
      scroll.scrollTop = row.offsetTop - HEADER_HEIGHT;
      if (focusDateEndpoint && !issueOverlayOpen) {
        if (!focusGanttDate(scroll, id, focusDateEndpoint === 'startDate' ? 'start' : 'end', 'nearest')) return;
      } else if (startDate && endDate) {
        scrollTimelineDate(scroll, (dayNumber(startDate) - range.start) * dayWidth);
        if (!issueOverlayOpen) row.querySelector<HTMLButtonElement>('.gantt-bar')?.focus({ preventScroll: true });
      } else if (!issueOverlayOpen) {
        if (!focusGanttDate(scroll, id, startDate ? 'end' : 'start', 'nearest')) return;
      }
      handledFocusRequest.current = focusRequest;
    });
    return () => cancelAnimationFrame(frame);
  }, [dateRecoveryReady, dayWidth, focusDateEndpoint, focusRequest, focusedIssue, issueOverlayOpen, range.start]);
  const selectedIssues = issues.filter(i => selected.has(i.id));
  const sheetIssues = (selectedIssues.length ? selectedIssues : issues)
    .filter(issue => sheetScope === 'team' || issue.projectId === sheetScope?.id);
  const firstSelectedProject = selectedIssues[0]?.projectId;
  const selectedProjectId = firstSelectedProject && selectedIssues.every(issue => issue.projectId === firstSelectedProject) ? firstSelectedProject : undefined;
  const bulkLinkProject = selectedProjectId ? projectsById.get(selectedProjectId) : undefined;
  const bulkLinkProblem = selectedIssues.length < 2 ? ''
    : !bulkLinkProject ? '같은 프로젝트의 업무를 선택해 주세요.'
    : selectedIssues.length > MAX_SCHEDULE_BULK_LINK_ISSUES ? `한 번에 ${MAX_SCHEDULE_BULK_LINK_ISSUES}개까지 연결할 수 있습니다.` : '';
  const canEditBulkDates = hasProject || (allProjects && data.projects.length > 0);
  const bulkDatesOverLimit = selectedIssues.length > MAX_SCHEDULE_BULK_DATE_ISSUES;
  const bulkDateIssues = bulkDateSelection?.map(original => projectIssues.find(issue => issue.id === original.id) ?? original);
  const schedulePasteTarget = bulkDateIssues
    ? { projectId: allProjects ? null : projectId, bulkDates: { issues: bulkDateIssues, projects: data.projects, refresh } }
    : pasteScope === 'team' ? { projectId: null, teamPaste: { projects: data.projects } }
      : pasteScope ? { projectId: pasteScope.id, projectLabel: `${pasteScope.key} · ${pasteScope.name}` } : null;
  const selectedAnchor = selectedIssues.length === 1 ? selectedIssues[0] : undefined;
  const linkAnchor = selectedAnchor && projectIssues.some(issue => issue.projectId === selectedAnchor.projectId && issue.id !== selectedAnchor.id)
    ? selectedAnchor : null;
  const automaticScheduleIssues = selectedIssues.length ? selectedIssues : planningScope && !scheduleFocus ? issues : [];
  const automaticProjectId = allProjects ? selectedProjectId ?? (!selectedIssues.length ? chartProjectFilter : null) : projectId;
  const automaticNeedsSelection = teamScheduleFilterActive && !selectedIssues.length;
  const issueRows = new Map(issues.map((issue, index) => [issue.id, { issue, index }]));
  const activeFindings = scheduleFocus ? findings.filter(({ predecessor, successor }) => issueRows.has(predecessor.id) && issueRows.has(successor.id)) : findings;
  const activeConflictCount = activeFindings.filter(finding => finding.check.kind === 'conflict').length;
  const canShowFindings = hasProject || (allProjects && data.projects.length > 0);
  const canShowTeamBlockers = allProjects && data.projects.length > 1;
  const datePickerRow = datePicker ? issueRows.get(datePicker.issue.id) : undefined;
  const activeDatePicker = datePickerRow ? datePicker : null;
  const deadlineActionsDisabled = busy || Boolean(activeDatePicker || linkPicker || issueOverlayOpen || drag);
  const issueDeadlines = new Map<string, GanttDeadline>();
  let lateDeadlineCount = 0;
  for (const issue of issues) {
    const deadline = classifyGanttDeadline(issue);
    if (!deadline) continue;
    issueDeadlines.set(issue.id, deadline);
    if (deadline.kind === 'late') lateDeadlineCount++;
  }
  function focusPickedDay(day: number) {
    const scroll = scrollRef.current;
    if (!scroll || !datePickerRow) return;
    scroll.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scroll.scrollTop = (planningRows.length + datePickerRow.index) * ROW_HEIGHT;
    scrollTimelineDate(scroll, (day - range.start) * dayWidth);
  }
  useLayoutEffect(() => {
    trackDraft(RANGE_PICK_DRAFT, Boolean(activeDatePicker?.firstDate));
    return () => trackDraft(RANGE_PICK_DRAFT, false);
  }, [activeDatePicker?.firstDate, trackDraft]);
  if (datePicker && !datePickerRow) setDatePicker(null);
  const visibleProjectCounts = new Map<string, number>();
  const openLinkIssues = new Set<string>();
  const openLinkProjects = new Set<string>();
  for (const issue of issues) {
    visibleProjectCounts.set(issue.projectId, (visibleProjectCounts.get(issue.projectId) ?? 0) + 1);
    if (canShowTeamBlockers && !isTerminalStatus(data, issue.projectId, issue.status)) {
      openLinkIssues.add(issue.id);
      openLinkProjects.add(issue.projectId);
    }
  }
  const hasCrossProjectPair = openLinkProjects.size > 1;
  const hasLinkPair = (id: string) => (visibleProjectCounts.get(id) ?? 0) >= 2;
  const hasOtherProjectTarget = (issue: Issue) => hasCrossProjectPair && openLinkIssues.has(issue.id);
  const canStartLink = (issue: Issue, endpoint: GanttLinkEndpoint) =>
    hasLinkPair(issue.projectId) || (endpoint === 'endDate' && hasOtherProjectTarget(issue));
  const candidateSource = linkPicker?.source;
  const candidateRow = candidateSource ? issueRows.get(candidateSource.issueId) : undefined;
  const sourceRow = candidateRow && candidateSource && canStartLink(candidateRow.issue, candidateSource.endpoint) ? candidateRow : undefined;
  const pickedSource = sourceRow ? candidateSource : undefined;
  if (candidateSource && !sourceRow) setLinkPicker({ source: null });
  const linkStep = pickedSource ? '후행' : '선행';
  const hasVisibleLinkPair = hasCrossProjectPair || [...visibleProjectCounts.values()].some(count => count >= 2);
  const canPickLink = !busy && hasVisibleLinkPair;
  function canPickLinkEndpoint(issue: Issue, endpoint: GanttLinkEndpoint) {
    if (!canPickLink) return false;
    if (!sourceRow || !pickedSource) return canStartLink(issue, endpoint);
    const source = sourceRow.issue;
    if (source.id === issue.id) return false;
    return source.projectId === issue.projectId || (pickedSource.endpoint === 'endDate' && endpoint === 'startDate' &&
      hasOtherProjectTarget(source) && hasOtherProjectTarget(issue));
  }
  const dependencies = data.dependencies.flatMap(dependency => {
    const predecessor = issueRows.get(dependency.predecessorId);
    const successor = issueRows.get(dependency.successorId);
    return predecessor && successor && predecessor.issue.projectId === successor.issue.projectId ? [{ dependency, predecessor, successor }] : [];
  });
  const unscheduled = issues.filter(i => !i.startDate || !i.endDate);
  const ticks = Array.from({ length: rangeDays }, (_, index) => {
    const day = rangeStart + index;
    const date = new Date(day * 86_400_000);
    const iso = isoDay(day);
    return { day, date, iso, index, weekday: date.getUTCDay(), nonworking: calendarMath ? !calendarMath.isWorking(iso) : false };
  });
  const nonworkingTicks = ticks.filter(tick => tick.nonworking);
  const todayPosition = (dayNumber(todayDate()) - range.start) * dayWidth;
  const chartRowCount = planningRows.length + issues.length + historicalIssues.length + milestones.length + historicalMilestones.length;
  const exportDisabled = (!focusedTrace && sharedViewUnavailable) || chartRowCount === 0;
  function downloadGantt() {
    if (exportDisabled) return;
    const filters: string[] = [];
    if (focusedTrace) {
      filters.push(`${hierarchyTrace ? '하위 업무 일정' : '선후행 흐름'} · ${focusedTrace.anchor.key} ${focusedTrace.anchor.title}`);
      if (hierarchyTrace?.span) filters.push(`하위 업무 범위 · ${hierarchyTrace.span.startDate} ~ ${hierarchyTrace.span.endDate}`);
      if (outsideFilterCount) filters.push(`기존 보기 밖 업무 ${outsideFilterCount}개 포함`);
    } else if (sharedView) {
      const { query: savedQuery, type, assigneeId, fieldFilter } = sharedView.filters;
      filters.push(`공유 보기 · ${sharedView.name}`);
      if (sharedSortLabels.length) filters.push(`업무 정렬 · ${sharedSortLabels.join(' → ')}`);
      if (savedQuery) filters.push(`공유 보기 검색 · ${savedQuery}`);
      if (sharedStatusLabel) filters.push(sharedStatusLabel);
      if (type !== 'all') {
        const label = projectIssueTypes(data, projectId, { includeArchived: true }).find(value => value.id === type)?.name;
        filters.push(`유형 · ${label ?? '현재 유형 없음'}`);
      }
      if (assigneeId !== 'all') {
        const name = assigneeId === 'none' ? '미지정' : data.users.find(value => value.id === assigneeId)?.name;
        filters.push(`담당자 · ${name ?? '현재 담당자 없음'}`);
      }
      if (sharedReporterLabel) filters.push(sharedReporterLabel);
      if (fieldFilter?.rules.length) filters.push(`사용자 정의 필드 조건 ${fieldFilter.rules.length}개`);
      filters.push(...sharedPriorityLabelCriteria);
      filters.push(...sharedPlanningLabels);
      if (sharedGitlabFilter) filters.push(ISSUE_GITLAB_FILTER_LABELS[sharedGitlabFilter]);
    }
    if (!focusedTrace) {
      if (filteredProject) filters.push(`프로젝트 · ${filteredProject.key} ${filteredProject.name}`);
      if (teamAssigneeId !== undefined) filters.push(`담당자 · ${teamAssigneeId === null ? '미배정'
        : data.users.find(user => user.id === teamAssigneeId)?.name ?? '현재 팀원 없음'}`);
      if (teamGitlabFilter) filters.push(ISSUE_GITLAB_FILTER_LABELS[teamGitlabFilter]);
      if (teamUnscheduledOnly) filters.push('일정 미정만');
      if (query) filters.push(`업무 검색 · ${query}`);
      if (hideDone) filters.push('완료 업무 숨기기');
      if (planningScope) filters.push(`연결된 업무만 · ${PLAN_LABELS[planningScope.kind]} ${planningScope.name}`);
      if (pinnedIssue) filters.push(`업무 위치로 추가 표시 · ${pinnedIssue.key}`);
    }
    const visibleDependencies = dependencies.map(({ dependency }) => dependency);
    const visibleDependencyIds = new Set(visibleDependencies.map(dependency => dependency.id));
    const report = buildGanttExportReport({
      title: project ? `${project.key} · ${project.name} 간트` : '전체 프로젝트 간트',
      capturedAt: new Date().toISOString(),
      range: { startDate: isoDay(range.start), endDate: isoDay(range.end) },
      today: todayDate(),
      nonworkingDates: nonworkingTicks.map(tick => tick.iso),
      filters, includeProjectLabel: allProjects,
      data: { projects: data.projects, users: data.users, workflows: data.workflows, issueSchemas: data.issueSchemas },
      issues, planningRows, milestones, baseline, historicalIssues, historicalMilestones,
      dependencies: visibleDependencies,
      findings: new Map(findings.filter(({ dependency }) => visibleDependencyIds.has(dependency.id))
        .map(({ dependency, check }) => [dependency.id, check])),
    });
    downloadText(`teamspace-gantt-${project?.key ?? 'all'}.html`, renderGanttExport(report), 'text/html;charset=utf-8');
  }
  function downloadScheduleSheet() {
    if (!sheetScope || !sheetIssues.length || exportDisabled) return;
    const result = sheetScope === 'team'
      ? buildTeamGanttScheduleSheet(sheetIssues, data.issues, data.dependencies)
      : buildGanttScheduleSheet(sheetIssues, projectIssues, data.dependencies);
    if (!result.ok) { notify(result.error, 'error'); return; }
    downloadText(`teamspace-schedule-${sheetScope === 'team' ? 'all' : sheetScope.key}.tsv`, result.text, 'text/tab-separated-values;charset=utf-8');
  }
  function canHideRows(nextIssues: Issue[]) {
    const visibleIds = new Set(nextIssues.map(issue => issue.id));
    const hidesDatePickerDraft = activeDatePicker?.firstDate && !visibleIds.has(activeDatePicker.issue.id);
    return (!hidesDatePickerDraft && ![...draftsRef.current.keys()].some(id => id.startsWith('dates:') && !visibleIds.has(id.slice(6)))) || canLeave();
  }
  function changeVisibility(nextQuery: string, nextHideDone: boolean) {
    if (allProjects && nextQuery !== query) {
      changeTeamScheduleFilters({ ...teamScheduleFilters, query: nextQuery || undefined });
      return;
    }
    if (!canHideRows(chartRows(nextQuery, nextHideDone, planningScope).rows)) return;
    if (!allProjects) setProjectQuery(nextQuery);
    setHideDone(nextHideDone);
  }
  function changeTeamProjectFilter(id: string | null) {
    if (pasteScope) return;
    const candidates = id ? projectIssues.filter(issue => issue.projectId === id) : projectIssues;
    if (canHideRows(chartRows(query, hideDone, undefined, candidates).rows)) onChangeTeamProjectFilter?.(id);
  }
  function focusTeamFilterSelect(event: PointerEvent<HTMLSelectElement>) {
    const active = document.activeElement;
    teamFilterOrigin.current = null;
    if (event.button !== 0 || !(active instanceof HTMLInputElement) || !active.matches('[data-schedule-edge]')) return;
    // Give the date's blur a known destination while preserving the native select interaction.
    teamFilterOrigin.current = active;
    event.currentTarget.focus({ preventScroll: true });
  }
  function changeTeamScheduleFilters(filters: TeamGanttScheduleFilters) {
    if (pasteScope) return;
    const origin = teamFilterOrigin.current;
    teamFilterOrigin.current = null;
    const accepted = canHideRows(chartRows(filters.query ?? '', hideDone, planningScope, scopedIssues, filters).rows) && onChangeTeamScheduleFilters?.(filters);
    if (!accepted && origin?.isConnected) origin.focus({ preventScroll: true });
  }
  function focusAfterCompletingMissingRows(updated: readonly Issue[], origin = document.activeElement) {
    if (!teamUnscheduledOnly || scheduleFocus) return false;
    const completed = new Set(updated.filter(issue => issue.startDate && issue.endDate).map(issue => issue.id));
    const removedIndex = issues.findIndex(issue => completed.has(issue.id) && issue.id !== focusIssueId && (!issue.startDate || !issue.endDate));
    if (removedIndex < 0) return false;
    const neighbors = [...issues.slice(removedIndex + 1), ...issues.slice(0, removedIndex).reverse()]
      .filter(issue => !completed.has(issue.id) && (!issue.startDate || !issue.endDate));
    pendingScheduleFocus.current = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== origin) return;
      const scroll = scrollRef.current;
      if (!scroll) return;
      for (const issue of neighbors) {
        const start = scroll.querySelector<HTMLInputElement>(`input[data-schedule-owner="${CSS.escape(issue.id)}"][data-schedule-edge="start"]`);
        if (start && focusGanttDate(scroll, issue.id, start.value ? 'end' : 'start', 'nearest')) return;
      }
      const fallback = teamUnscheduledFilter.current;
      (fallback && !fallback.disabled ? fallback : scroll).focus();
    };
    return true;
  }
  function setPlanningFilter(only: boolean) {
    if (canHideRows(chartRows(query, hideDone, only ? selectedPlan : undefined).rows)) setLinkedOnly(only);
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
  function locateScheduleFocusRow(issue: Issue, { endpoint, preferredDate, showIssueNames = false }: {
    endpoint?: ScheduleDependencyEndpoint;
    preferredDate?: string;
    showIssueNames?: boolean;
  } = {}) {
    const date = (endpoint && issue[endpoint]) || preferredDate || issue.startDate || issue.endDate;
    if (date && showIssueNames) setWindowStart(windowForDate(date));
    else if (date) showDate(date);
    requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      const row = scroll?.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issue.id)}"]`);
      if (!scroll || !row) return;
      scroll.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      scroll.scrollTop = row.offsetTop - HEADER_HEIGHT;
      if (showIssueNames || !date) scroll.scrollLeft = 0;
      if (endpoint) focusGanttDate(scroll, issue.id, endpoint === 'startDate' ? 'start' : 'end', 'nearest');
      else scroll.focus({ preventScroll: true });
    });
  }
  function openScheduleFocus(kind: ScheduleFocus['kind'], issue: Issue, opener: HTMLButtonElement) {
    if (scheduleFocus || !canLeave()) return;
    const next: ScheduleFocus = {
      kind, opener, teamScope: teamFocusScope, issueId: issue.id, projectId: issue.projectId,
      previousSelection: selected, previousWindowStart: windowStart,
      scrollLeft: scrollRef.current?.scrollLeft ?? 0, scrollTop: scrollRef.current?.scrollTop ?? 0,
    };
    const preferredDate = kind === 'hierarchy'
      ? traceGanttHierarchy(issue.id, projectIssues, child => statusMeta(data, child.projectId, child.status).category)?.span?.startDate
      : undefined;
    queueMicrotask(() => {
      setScheduleFocus(next);
      setSelected(new Set([issue.id]));
      setLinkPicker(null);
      setDatePicker(null);
      setDrag(null);
      setShiftMode(null);
      locateScheduleFocusRow(issue, { showIssueNames: true, preferredDate });
    });
  }
  function closeScheduleFocus() {
    if (!scheduleFocus || !canLeave()) return;
    queueMicrotask(() => {
      restoringScheduleFocus.current = scheduleFocus;
      setScheduleFocus(null);
      setSelected(scheduleFocus.previousSelection);
      setWindowStart(scheduleFocus.previousWindowStart);
      setLinkPicker(null);
      setDatePicker(null);
      setDrag(null);
      setShiftMode(null);
    });
  }
  function locateFindingDate(issueId: string, endpoint: ScheduleDependencyEndpoint) {
    const row = focusedTrace && issueRows.get(issueId);
    if (!row) return onLocateIssueDate(issueId, endpoint);
    if (!canLeave()) return false;
    locateScheduleFocusRow(row.issue, { endpoint });
    return true;
  }
  function locateTimelineDate(date: string, rowIndex?: number, preserveRange = false) {
    if (preserveRange && !outside(date)) scrollToDate(dayNumber(date), range.start);
    else showDate(date);
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollIntoView({ block: 'start', inline: 'nearest' });
    scroll.focus({ preventScroll: true });
    if (rowIndex !== undefined) scroll.scrollTop = (planningRows.length + rowIndex) * ROW_HEIGHT;
  }
  function locateAnalysisIssue(issueId: string) {
    const row = issueRows.get(issueId);
    if (row?.issue.startDate) locateTimelineDate(row.issue.startDate, row.index);
  }
  function locateDeadline(issue: Issue) {
    const row = issueRows.get(issue.id), deadline = issueDeadlines.get(issue.id);
    if (deadlineActionsDisabled || !row || !deadline) return;
    locateTimelineDate(deadline.dueDate, row.index, true);
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issue.id)}"] .gantt-deadline-marker`)
        ?.focus({ preventScroll: true });
    });
  }
  function closeDeadlines() {
    setDeadlinesOpen(false);
    deadlinesTrigger.current?.focus({ preventScroll: true });
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
  function openSchedulePaste() {
    if (busyRef.current || !sheetScope || !canLeave()) return;
    queueMicrotask(() => {
      setLinkPicker(null);
      setDatePicker(null);
      setPasteScope(sheetScope);
    });
  }
  function closeSchedulePaste(updated?: readonly Issue[]) {
    setPasteScope(null);
    if (updated && focusAfterCompletingMissingRows(updated)) return;
    requestAnimationFrame(() => pasteTrigger.current?.focus({ preventScroll: true }));
  }
  function openBulkDates() {
    if (busyRef.current || !canEditBulkDates || activeDatePicker || !selectedIssues.length || bulkDatesOverLimit || !canLeave()) return;
    queueMicrotask(() => {
      setLinkPicker(null);
      setPasteScope(null);
      setBulkDateSelection(selectedIssues);
    });
  }
  function closeBulkDates(updated?: readonly Issue[]) {
    setBulkDateSelection(null);
    if (updated && focusAfterCompletingMissingRows(updated)) return;
    requestAnimationFrame(() => {
      const trigger = bulkDatesTrigger.current;
      if (trigger && !trigger.disabled) trigger.focus({ preventScroll: true });
      else scrollRef.current?.focus({ preventScroll: true });
    });
  }
  function openBulkLinks() {
    if (busyRef.current || activeDatePicker || selectedIssues.length < 2 || !bulkLinkProject || bulkLinkProblem) return;
    const keepDates = canKeepInlineDateDrafts();
    if (!keepDates && !canLeave()) return;
    const dateDrafts = keepDates ? projectIssues.flatMap(issue => {
      if (issue.projectId !== bulkLinkProject.id) return [];
      const draft = chartDateDraft(issue);
      return draft ? [draft] : [];
    }) : [];
    queueMicrotask(() => {
      setLinkPicker(null);
      setDatePicker(null);
      setBulkLinkSelection({ project: bulkLinkProject, issues: selectedIssues, dateDrafts });
    });
  }
  function closeBulkLinks(updated?: readonly Issue[]) {
    setBulkLinkSelection(null);
    if (updated && focusAfterCompletingMissingRows(updated)) return;
    requestAnimationFrame(() => {
      const trigger = bulkLinksTrigger.current;
      (trigger && !trigger.disabled ? trigger : scrollRef.current)?.focus({ preventScroll: true });
    });
  }
  function openBlockerLinks() {
    if (!sheetScope || scheduleEditorOpen || busyRef.current || issueOverlayOpen || (!canKeepInlineDateDrafts() && !canLeave())) return;
    queueMicrotask(() => setBlockerLinksScope(sheetScope));
  }
  function closeBlockerLinks(awaitingResult = false) {
    setBlockerLinksScope(null);
    pendingScheduleFocus.current = () => {
      const trigger = blockerLinksTrigger.current;
      (trigger?.isConnected && !trigger.disabled ? trigger : scrollRef.current)?.focus({ preventScroll: true });
    };
    if (awaitingResult) void refresh().catch(() => notify('간트 목록을 불러오지 못했습니다. 화면을 다시 열어 확인해 주세요.', 'error'));
  }
  function restoreShiftFocus(opener: HTMLButtonElement | null) {
    pendingScheduleFocus.current = () => {
      const target = opener?.isConnected && !opener.disabled ? opener : scrollRef.current;
      target?.focus({ preventScroll: true });
    };
  }
  function closeShiftForm() {
    if (busyRef.current || !shiftMode) return;
    restoreShiftFocus(shiftMode === 'hierarchy' ? hierarchyShiftTrigger.current : selectionShiftTrigger.current);
    setShiftMode(null);
  }
  function toggleShiftForm(mode: ShiftMode) {
    if (busyRef.current) return;
    if (shiftMode === mode) { closeShiftForm(); return; }
    if (canLeave()) queueMicrotask(() => {
      setShiftSuccessors(false);
      setShiftMode(mode);
    });
  }
  function submitShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const shift = { days, workingDays, ...(shiftSuccessors ? { rescheduleSuccessors: true } : {}) };
    if (shiftMode === 'hierarchy') {
      if (!hierarchyTrace) return;
      const { id, version } = hierarchyTrace.anchor;
      void requestShiftPreview({ ...shift, hierarchy: { id, expectedVersion: version } }, hierarchyShiftTrigger.current);
    } else {
      void requestShiftPreview({ ...shift, issueIds: selectedIssues.map(issue => issue.id) }, selectionShiftTrigger.current);
    }
  }
  async function requestShiftPreview(input: ScheduleShiftInput, opener: HTMLButtonElement | null) {
    if (busyRef.current) return;
    if ('issueIds' in input && !input.issueIds.length) { notify('이동할 업무를 먼저 선택하세요.', 'error'); return; }
    if (!Number.isInteger(input.days) || input.days === 0) { notify('0이 아닌 정수 일수를 입력하세요.', 'error'); return; }
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      setDatePreviewFocusTarget(opener);
      setManualReview({ input, preview });
      setManualProblem(null);
      setShiftMode(null);
    } catch (cause) {
      if ('hierarchy' in input && cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
        setDatePreviewFocusTarget(opener);
        setManualReview({ input, preview: { changes: [], warnings: [] } });
        setManualProblem({ kind: 'stale', message: errorMessage(cause) });
        setShiftMode(null);
        await refresh().catch(() => undefined);
      } else notify(errorMessage(cause), 'error');
    } finally {
      markBusy(false);
    }
  }
  async function openInlineDateReview(opener: HTMLButtonElement) {
    if (busyRef.current || scheduleEditorOpen || issueOverlayOpen ||
        [...draftsRef.current.values()].some(draft => draft.pending || draft.awaitingResult)) return;
    const inlineDates = issues.flatMap(issue => {
      const draft = inlineDateDrafts.current.get(issue.id);
      return draft ? [draft] : [];
    });
    if (inlineDates.length < 2 || inlineDates.length > MAX_SCHEDULE_MANUAL_ISSUES) return;
    const input = { changes: inlineDates.map(draft => inlineDateChange(draft)) };
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      setDatePreviewFocusTarget(opener);
      setManualReview({ input, preview, inlineDates });
      setManualProblem(null);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
        setDatePreviewFocusTarget(opener);
        setManualReview({ input, preview: { changes: [], warnings: [] }, inlineDates });
        setManualProblem({ kind: 'stale', message: errorMessage(cause) });
        await refresh().catch(() => undefined);
      } else {
        notify(errorMessage(cause), 'error');
        focusAfterDatePicking(opener);
      }
    } finally { markBusy(false); }
  }
  function settleInlineDates(review: ManualReview, updated: readonly Issue[]) {
    if (!review.inlineDates || !('changes' in review.input)) return;
    const submitted = new Map(review.input.changes.map(change => [change.id, change]));
    const saved = new Map(updated.map(issue => [issue.id, issue]));
    const latest = new Map(data.issues.map(issue => [issue.id, issue]));
    for (const draft of review.inlineDates) {
      const id = draft.source.id;
      if (inlineDateDrafts.current.get(id) !== draft) continue;
      const change = submitted.get(id);
      const unchanged = latest.get(id);
      const issue = saved.get(id) ?? (change && unchanged?.version === change.expectedVersion &&
        unchanged.startDate === change.startDate && unchanged.endDate === change.endDate ? unchanged : undefined);
      if (issue) draft.accept(issue);
    }
  }
  async function commitManualReview(review: ManualReview, checking = false) {
    const { previewId } = review.preview;
    if (!previewId) return;
    const focusOrigin = review.inline?.focus ?? document.activeElement;
    let result: ApplyResult;
    try {
      result = await api<ApplyResult>('/schedule/manual-apply', {
        method: 'POST', headers: scheduleUndoHeaders(undoScope, props.actorId), body: JSON.stringify({ previewId }),
      });
    } catch (cause) {
      if (review.inline) setDatePreviewFocusTarget(review.inline.focus);
      setManualReview(review);
      if (isUncertainScheduleResponse(cause)) {
        setManualProblem({ kind: 'uncertain', message: '일정 적용 응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인해 주세요.' });
      } else {
        setManualProblem(checking
          ? { kind: 'unavailable', message: '이전 적용 결과를 확인할 수 없습니다. 최신 일정을 확인해 주세요.' }
          : { kind: 'stale', message: errorMessage(cause) });
        await refresh().catch(() => undefined);
      }
      return;
    }
    const inlineIssue = result.updated.find(issue => issue.id === review.inline?.issueId);
    if (inlineIssue) review.inline?.accept?.(inlineIssue);
    settleInlineDates(review, result.updated);
    rememberUndo(result.undoId);
    setManualReview(null);
    setManualProblem(null);
    setScheduleWarnings(result.warnings ?? []);
    let completedFocus = false;
    try {
      await refresh();
      if (review.inline?.returnToMissingRow ?? true) completedFocus = focusAfterCompletingMissingRows(result.updated, focusOrigin);
      notify(`${result.updated.length}개 업무의 일정을 변경했습니다.${result.warnings?.length ? ' 일정 경고를 확인하세요.' : ''}`);
    } catch {
      notify('일정을 저장했습니다. 간트 목록을 다시 불러와 주세요.', 'error');
    } finally { restoreDatePreviewFocus(!completedFocus); }
  }
  async function applyManualReview() {
    if (busyRef.current || !manualReview?.preview.previewId ||
        (manualProblem && manualProblem.kind !== 'uncertain') || (missingHierarchyAnchor && manualProblem?.kind !== 'uncertain')) return;
    markBusy(true);
    try { await commitManualReview(manualReview, manualProblem?.kind === 'uncertain'); }
    finally { markBusy(false); }
  }
  async function reviewBatchFollowUp(rescheduleSuccessors: boolean) {
    if (busyRef.current || !manualReview || !batchDateInput || manualProblem) return;
    const input = { changes: batchDateInput.changes, ...(rescheduleSuccessors ? { rescheduleSuccessors: true } : {}) };
    restoreBatchFollowUpFocus.current = true;
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      setManualReview({ ...manualReview, input, preview });
    } catch (cause) {
      setManualReview({ ...manualReview, input, preview: { changes: [], warnings: [] } });
      setManualProblem({ kind: 'stale', message: errorMessage(cause) });
      await refresh().catch(() => undefined);
    } finally { markBusy(false); }
  }
  async function reviewManualAgain() {
    if (busyRef.current || !manualReview || manualProblem?.kind !== 'stale' || missingHierarchyAnchor) return;
    let input = manualReview.input;
    const singleDateEdit = manualReview.inline ?? manualReview.chartEdge;
    const dateEdits = manualReview.inlineDates ?? (singleDateEdit ? [singleDateEdit] : undefined);
    if (dateEdits && 'changes' in input) {
      const latest = new Map(data.issues.map(issue => [issue.id, issue]));
      const changes: ScheduleAnchorChange[] = [];
      for (const draft of dateEdits) {
        const issue = latest.get(draft.source.id);
        if (!issue || issue.projectId !== draft.source.projectId) {
          setManualProblem({ kind: 'stale', message: `${draft.source.key}: 업무가 이동했거나 삭제되었습니다. 미리보기를 닫고 현재 간트에서 날짜를 다시 확인하세요.` });
          return;
        }
        changes.push(inlineDateChange(draft, issue));
      }
      input = { ...input, changes };
    } else if ('changes' in input) {
      const issues = new Map(data.issues.map(issue => [issue.id, issue]));
      input = { changes: input.changes.map(change => ({ ...change, expectedVersion: issues.get(change.id)?.version ?? change.expectedVersion })) };
    } else if ('hierarchy' in input) {
      const anchor = hierarchyTrace?.anchor;
      if (!anchor || anchor.id !== input.hierarchy.id) return;
      input = { ...input, hierarchy: { id: anchor.id, expectedVersion: anchor.version } };
    }
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      const review = { ...manualReview, input, preview };
      if (dateEdits && !preview.previewId && !preview.blocking?.length) {
        const current = review.inline && data.issues.find(issue => issue.id === review.inline?.issueId);
        if (current) review.inline?.accept?.(current);
        settleInlineDates(review, []);
        setManualReview(null);
        restoreDatePreviewFocus();
        notify('입력한 날짜가 현재 일정에 모두 반영되어 있습니다.');
      } else setManualReview(review);
      setManualProblem(null);
    } catch (cause) {
      setManualProblem({ kind: 'stale', message: errorMessage(cause) });
      await refresh().catch(() => undefined);
    } finally { markBusy(false); }
  }
  async function saveDates(issue: Issue, startDate: string | null, endDate: string | null, inline: InlineScheduleOrigin) {
    if (startDate === issue.startDate && endDate === issue.endDate) return;
    if (startDate && endDate && startDate > endDate) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    if (busyRef.current || manualReview) { notify('진행 중인 일정 변경이 끝난 뒤 다시 시도하세요.', 'error'); return; }
    const input = manualDates(issue, startDate, endDate);
    const dateOrigin = { ...inline, source: issue, startDate, endDate };
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      const review = { input, preview, inline: dateOrigin };
      if (preview.teamBlockerWarnings?.length) {
        setDatePreviewFocusTarget(inline.focus);
        setManualReview(review);
        setManualProblem(null);
        return;
      }
      if (!preview.previewId) {
        notify(preview.blocking?.join(' · ') || '변경할 일정이 없습니다.', 'error');
        return;
      }
      await commitManualReview(review);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
        setDatePreviewFocusTarget(inline.focus);
        setManualReview({ input, preview: { changes: [], warnings: [] }, inline: dateOrigin });
        setManualProblem({ kind: 'stale', message: errorMessage(cause) });
        await refresh().catch(() => undefined);
      } else notify(errorMessage(cause), 'error');
    } finally { markBusy(false); }
  }
  function completeMissingDates(issue: Issue, opener: HTMLButtonElement) {
    const startDate = issue.startDate ?? (issue.endDate ? moveDate(issue.endDate, -2) : todayDate());
    const endDate = issue.endDate ?? moveDate(startDate, 2);
    void saveDates(issue, startDate, endDate, { issueId: issue.id, returnToMissingRow: true, focus: opener });
  }
  function reviewSuccessors(anchorChange: CascadeAnchorChange, origin: CascadeOrigin) {
    const issue = projectIssues.find(value => value.id === anchorChange.id);
    if (busyRef.current || cascade || !issue || !outgoingIssueIds.has(issue.id) ||
        (anchorChange.startDate && anchorChange.endDate && anchorChange.startDate > anchorChange.endDate)) return;
    trackDraft(CASCADE_DRAFT, true);
    setCascade({ projectId: issue.projectId, anchorChange, origin });
  }
  function restoreInlineCascadeFocus(origin: Extract<CascadeOrigin, { kind: 'inline' }>, issueId: string) {
    requestAnimationFrame(() => {
      if (origin.opener.isConnected && !origin.opener.disabled) { origin.opener.focus(); return; }
      const scroll = scrollRef.current;
      const field = scroll?.querySelector<HTMLInputElement>(`input[data-schedule-owner="${CSS.escape(issueId)}"][data-schedule-edge="end"]`);
      (field && !field.disabled ? field : scroll)?.focus();
    });
  }
  function closeCascade() {
    if (!cascade) return;
    const { origin, anchorChange } = cascade;
    trackDraft(CASCADE_DRAFT, false);
    setCascade(null);
    if (origin.kind === 'inline') restoreInlineCascadeFocus(origin, anchorChange.id);
    else if (preview) requestAnimationFrame(() => (cascadePreviewButton.current ?? previewDialog.current)?.focus());
    else restoreDatePreviewFocus();
  }
  async function applyCascade(result: ApplyResult) {
    if (!cascade) return;
    const { origin, anchorChange } = cascade;
    const anchor = result.updated.find(issue => issue.id === anchorChange.id);
    const accept = origin.kind === 'inline' ? origin.accept : manualReview?.inline?.issueId === anchorChange.id
      ? manualReview.inline.accept : undefined;
    if (anchor) accept?.(anchor);
    rememberUndo(result.undoId);
    setScheduleWarnings(result.warnings ?? []);
    setManualReview(null);
    setManualProblem(null);
    await refresh();
    trackDraft(CASCADE_DRAFT, false);
    setCascade(null);
    const completedFocus = focusAfterCompletingMissingRows(result.updated);
    if (origin.kind === 'preview') restoreDatePreviewFocus(!completedFocus);
    else if (!completedFocus) restoreInlineCascadeFocus(origin, anchorChange.id);
    notify(`${result.updated.length}개 업무의 일정을 변경했습니다.`);
  }
  async function undo() {
    if (!undoId || busyRef.current || (scheduleFocus && !canLeave())) return;
    markBusy(true);
    try {
      const result = await undoScheduleChange();
      if (!result) return;
      setScheduleWarnings(result.warnings);
      try { await refresh(); }
      catch {
        notify('일정 변경을 되돌렸습니다. 간트 목록을 다시 불러와 주세요.', 'error');
        return;
      }
      const date = result.plan && (result.plan.startDate ?? result.plan.targetDate ?? result.plan.endDate);
      if (date && result.plan?.id === selectedPlanningId && outside(date)) showDate(date);
      if (result.plan) notify('계획과 연결 업무의 일정 변경을 되돌렸습니다.');
      else if (result.dependencyChanges || result.relationChanges) notify(result.updated.length ? '일정과 업무 연결 변경을 되돌렸습니다.' : '업무 연결 변경을 되돌렸습니다.');
      else notify('마지막 일정 변경을 되돌렸습니다.');
    }
    catch (err) { notify(errorMessage(err), 'error'); } finally { markBusy(false); }
  }
  function showLinkEditor(opener: HTMLButtonElement, options: Omit<DependencyEditor, 'opener'> = {}, fromLinkPicker = false) {
    const keepDates = canKeepLinkDateDrafts(fromLinkPicker);
    if (!keepDates && !canLeave()) return;
    if (keepDates && options.anchor) {
      const { issueId, otherRole } = options.anchor;
      const draft = inlineDateDrafts.current.get(issueId);
      if (draft) {
        openRowScheduleEdit(draft.source, opener, { initialLink: { action: 'add', direction: otherRole } });
        return;
      }
    }
    // An accepted draft discard is queued by the navigation guard first.
    queueMicrotask(() => {
      setLinkPicker(null);
      setDatePicker(null);
      setLinkEditor({ ...options, opener });
    });
  }
  function canKeepInlineDateDrafts(fromLinkPicker = false) {
    return !busyRef.current && !otherScheduleEditorOpen && (!linkPicker || fromLinkPicker) && !issueOverlayOpen &&
      [...draftsRef.current].every(([id, value]) => id.startsWith('dates:') && !value.pending && !value.awaitingResult);
  }
  function canKeepLinkDateDrafts(fromLinkPicker = false) {
    return draftsRef.current.size > 0 && canKeepInlineDateDrafts(fromLinkPicker);
  }
  function openRowScheduleEdit(issue: Issue, opener: HTMLButtonElement,
    { focusDate, initialLink, relatedId, fromLinkPicker = false }: Pick<RowScheduleEdit, 'focusDate' | 'initialLink'> & {
      relatedId?: string; fromLinkPicker?: boolean;
    } = {}) {
    const canKeepDates = canKeepInlineDateDrafts(fromLinkPicker);
    if (!canKeepDates && !canLeave()) return;
    const inlineDraft = canKeepDates ? inlineDateDrafts.current.get(issue.id) : undefined;
    const relatedInlineDraft = canKeepDates && relatedId ? inlineDateDrafts.current.get(relatedId) : undefined;
    const initialDates = changedInlineDates(inlineDraft);
    const otherDateDrafts = initialLink ? new Set([...inlineDateDrafts.current.keys()].filter(id => id !== issue.id)) : undefined;
    queueMicrotask(() => {
      setLinkPicker(null);
      setRowScheduleEdit({ issue, opener, focusDate, inlineDraft, relatedInlineDraft, initialDates, initialLink, otherDateDrafts });
    });
  }
  function closeRowScheduleEdit(updated?: readonly Issue[]) {
    const { opener, focusDate, issue } = rowScheduleEdit ?? {};
    setRowScheduleEdit(null);
    if (updated && focusAfterCompletingMissingRows(updated)) return;
    pendingScheduleFocus.current = () => {
      const rowEdit = issue && scrollRef.current?.querySelector<HTMLButtonElement>(
        `[data-issue-id="${CSS.escape(issue.id)}"] .gantt-row-schedule-trigger`,
      );
      const fallback = focusDate === 'dueDate' && deadlinesOpen ? deadlinesTrigger.current : rowEdit;
      const target = [opener, fallback, scrollRef.current].find(element => element?.isConnected &&
        !element.closest('[inert]') && !element.matches(':disabled'));
      target?.focus({ preventScroll: true });
    };
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
    if (!canPickLink || (!canKeepLinkDateDrafts() && !canLeave())) return;
    queueMicrotask(() => {
      setDrag(null);
      setLinkEditor(null);
      setDatePicker(null);
      setLinkPicker({ source: null });
    });
  }
  function pickLink(issueId: string, endpoint: GanttLinkEndpoint, explicit: boolean) {
    const target = issueRows.get(issueId)?.issue;
    if (!linkPicker || !target || !canPickLinkEndpoint(target, endpoint)) return;
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
    if (!opener || !sourceRow) return;
    const predecessorId = pickedSource.issueId;
    if (target.projectId !== sourceRow.issue.projectId) {
      if (!canKeepLinkDateDrafts(true) && !canLeave()) return;
      queueMicrotask(() => {
        setLinkPicker(null);
        setTeamBlockerChartPair({ sourceId: predecessorId, targetId: issueId, opener });
        setTeamBlockersOpen(true);
      });
      return;
    }
    const dependency = data.dependencies.find(link => link.predecessorId === predecessorId && link.successorId === issueId);
    const type = DEPENDENCY_TYPES.find(value => DEPENDENCY_ENDPOINTS[value].predecessor === pickedSource.endpoint &&
      DEPENDENCY_ENDPOINTS[value].successor === endpoint);
    const prefilledType = !dependency || pickedSource.explicit || explicit ? type : undefined;
    if (canKeepLinkDateDrafts(true)) {
      const anchor = inlineDateDrafts.current.has(target.id) ? target
        : inlineDateDrafts.current.has(predecessorId) ? sourceRow.issue : undefined;
      if (anchor) {
        const initialLink: GanttRowLinkDraft = dependency
          ? { action: 'update', dependencyId: dependency.id, type: prefilledType ?? dependency.type, lag: String(dependency.lagDays) }
          : { action: 'add', direction: anchor.id === target.id ? 'predecessor' : 'successor',
            relatedId: anchor.id === target.id ? predecessorId : target.id, type: prefilledType ?? 'FS' };
        openRowScheduleEdit(anchor, opener, { initialLink, relatedId: anchor.id === target.id ? predecessorId : target.id, fromLinkPicker: true });
        return;
      }
    }
    showLinkEditor(opener, { dependency, prefill: { predecessorId, successorId: issueId, type: prefilledType } }, true);
  }
  function closeLinkEditor() {
    linkEditorFocusTarget.current = linkEditor?.opener ?? null;
    setLinkEditor(null);
  }
  function cancelLinkEditor() {
    if (busyRef.current || (draftsRef.current.get('dependency')?.dirty &&
        !window.confirm('저장하지 않은 업무 연결 변경을 버릴까요?'))) return;
    closeLinkEditor();
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
    if (busyRef.current || staleDependencyMessage) return;
    markBusy(true);
    try {
      if (editingDependency) {
        const { predecessorId, successorId, type, lagDays } = input;
        const reverse = predecessorId === editingDependency.successorId && successorId === editingDependency.predecessorId;
        await patch(`/dependencies/${encodeURIComponent(editingDependency.id)}`, {
          expectedVersion: editingDependency.version ?? 1, type, lagDays, ...(reverse ? { reverse: true } : {}),
        });
      } else {
        await post('/dependencies', input);
      }
      await refreshAfterDependencyChange(editingDependency ? '업무 연결을 수정했습니다.' : '선행·후행 업무를 연결했습니다.');
      closeLinkEditor();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) await refresh().catch(() => {});
      throw err;
    } finally {
      markBusy(false);
    }
  }
  async function unlink(dependency: Dependency) {
    if (busyRef.current || (scheduleFocus && !canLeave())) return;
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
  async function previewIssueDates(issue: Issue, toStart: string, toEnd: string, opener: HTMLButtonElement, singleEdge: boolean) {
    if (busyRef.current) return;
    if (toStart > toEnd) { notify('종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    const input = manualDates(issue, toStart, toEnd);
    const chartEdge = singleEdge ? { source: issue, startDate: toStart, endDate: toEnd } : undefined;
    markBusy(true);
    try {
      const preview = await post<SchedulePreview>('/schedule/manual-preview', input);
      setDatePreviewFocusTarget(opener);
      setManualReview({ input, preview, chartEdge });
      setManualProblem(null);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
        setDatePreviewFocusTarget(opener);
        setManualReview({ input, chartEdge, preview: { changes: [{ id: issue.id, key: issue.key, title: issue.title, version: issue.version,
          fromStart: issue.startDate, fromEnd: issue.endDate, toStart, toEnd }], warnings: [] } });
        setManualProblem({ kind: 'stale', message: errorMessage(cause) });
        await refresh().catch(() => undefined);
      } else {
        notify(errorMessage(cause), 'error');
        focusAfterDatePicking(opener);
      }
    } finally { markBusy(false); }
  }
  function previewResize(issue: Issue, edge: 'start' | 'end', delta: number, opener: HTMLButtonElement) {
    if (!issue.startDate || !issue.endDate || !delta) return;
    const startDate = edge === 'start' ? moveDate(issue.startDate, delta) : issue.startDate;
    const endDate = edge === 'end' ? moveDate(issue.endDate, delta) : issue.endDate;
    void previewIssueDates(issue, startDate, endDate, opener, true);
  }
  function focusAfterDatePicking(opener: DatePreviewOpener) {
    requestAnimationFrame(() => {
      if (opener.isConnected && !opener.disabled) { opener.focus(); return; }
      const scroll = scrollRef.current;
      const issueId = opener.dataset.datePickerIssue ?? opener.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId ?? '';
      const row = scroll?.querySelector(`[data-issue-id="${CSS.escape(issueId)}"]`);
      const control = row?.querySelector<HTMLButtonElement>('button[data-date-picker-issue], .gantt-bar');
      (control && !control.disabled ? control : scroll)?.focus();
    });
  }
  function restoreDatePreviewFocus(restore = true) {
    setDatePreviewFocusTarget(null);
    if (!restore || !datePreviewFocusTarget) return;
    if (datePreviewFocusTarget instanceof HTMLButtonElement &&
      (datePreviewFocusTarget === hierarchyShiftTrigger.current || datePreviewFocusTarget === selectionShiftTrigger.current)) {
      restoreShiftFocus(datePreviewFocusTarget);
    } else focusAfterDatePicking(datePreviewFocusTarget);
  }
  function closePreview() {
    const unresolved = manualProblem?.kind === 'uncertain' || manualProblem?.kind === 'unavailable';
    if (unresolved && !window.confirm('일정이 이미 저장됐을 수 있습니다. 적용 결과 확인을 닫을까요?')) return;
    setManualReview(null);
    setManualProblem(null);
    restoreDatePreviewFocus();
    if (unresolved) void refresh().catch(() => undefined);
  }
  function startDatePicking(issue: Issue, opener: HTMLButtonElement) {
    if (busyRef.current || !canLeave()) return;
    const anchor = issue.startDate || issue.endDate;
    const initialDay = anchor ? dayNumber(anchor) : Math.min(range.end, Math.max(range.start, dayNumber(todayDate())));
    queueMicrotask(() => {
      setDrag(null);
      setLinkPicker(null);
      setShiftMode(null);
      if (anchor && outside(anchor)) setWindowStart(windowForDate(anchor));
      setDatePicker({ issue, fixedEdge: getFixedDateEdge(issue), firstDate: null, initialDay, opener });
    });
  }
  function cancelDatePicking() {
    setDatePicker(null);
    if (activeDatePicker) focusAfterDatePicking(activeDatePicker.opener);
  }
  function resetDatePicking() {
    if (!activeDatePicker) return;
    setDatePicker({ ...activeDatePicker, firstDate: null });
  }
  function chooseIssueDate(day: number) {
    if (!activeDatePicker || busyRef.current) return;
    const { issue, fixedEdge, firstDate, opener } = activeDatePicker;
    const date = isoDay(day);
    if (!fixedEdge && !firstDate) {
      setDatePicker({ ...activeDatePicker, firstDate: date });
      return;
    }
    const toStart = fixedEdge?.kind === 'start' ? fixedEdge.date : firstDate && firstDate < date ? firstDate : date;
    const toEnd = fixedEdge?.kind === 'end' ? fixedEdge.date : firstDate && firstDate > date ? firstDate : date;
    if (toStart > toEnd) return;
    setDatePicker(null);
    if (toStart === issue.startDate && toEnd === issue.endDate) {
      focusAfterDatePicking(opener);
      notify('현재 일정과 같은 날짜입니다.');
      return;
    }
    void previewIssueDates(issue, toStart, toEnd, opener, Boolean(fixedEdge));
  }
  function beginDrag(event: PointerEvent<HTMLButtonElement>, issue: Issue, mode: DragMode) {
    if (event.button !== 0 || busy || activeDatePicker) return;
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
  function openChartIssue(id: string, opener: HTMLElement, issueIds: readonly string[]) {
    if (!props.onOpenIssueForReview) { openIssue(id); return; }
    props.onOpenIssueForReview(id, { issueIds, opener, fallback: scrollRef.current });
  }
  function openIssueRow(id: string, opener: HTMLElement) {
    openChartIssue(id, opener, issues.map(issue => issue.id));
  }
  function openMilestoneReview(id: string, opener: HTMLButtonElement) {
    if (!onChangeMilestoneReview(id)) return;
    milestoneReviewOpener.current = opener;
    if (id === milestoneReviewId) document.getElementById(SCHEDULE_MILESTONE_REVIEW_ID)?.querySelector('h2')?.focus();
  }
  function closeMilestoneReview() {
    if (!onChangeMilestoneReview(null)) return;
    const opener = milestoneReviewOpener.current;
    milestoneReviewOpener.current = null;
    requestAnimationFrame(() => {
      const target = opener?.isConnected && !opener.disabled ? opener : scrollRef.current;
      target?.focus({ preventScroll: true });
    });
  }
  function openMilestoneIssue(id: string, opener: HTMLButtonElement) {
    if (!reviewedMilestone?.issueIds.includes(id)) return;
    openChartIssue(id, opener, reviewedMilestone.issueIds);
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag) return; const current = drag; setDrag(null);
    if (current.delta) { if (current.mode === 'move') void requestShiftPreview({ issueIds: [current.issue.id], days: current.delta, workingDays: false }, event.currentTarget); else previewResize(current.issue, current.mode, current.delta, event.currentTarget); }
    else if (current.mode === 'move') openIssueRow(current.issue.id, event.currentTarget);
    else focusDateFromControl(event.currentTarget, current.issue, current.mode);
  }
  const months = ticks.filter(t => t.date.getUTCDate() === 1 || t.index === 0);

  const datePickingDisabled = busy || Boolean(linkPicker || activeDatePicker);
  return <><div className="gantt-feature" inert={Boolean(scheduleIssueCreation || blockedIssueCreation || teamFollowUp || teamFollowUpHandoff || bulkLinkSelection || blockerLinksScope || rowScheduleEdit)} onFocusCapture={event => {
    if (event.target.matches('input[data-schedule-edge]')) {
      setInlineDateFocused(true);
      reconsider();
    }
  }} onBlurCapture={event => {
    if (event.target.matches('input[data-schedule-edge]')) {
      setInlineDateFocused(Boolean(event.relatedTarget?.matches('input[data-schedule-edge]')));
    }
  }} onKeyDown={event => {
    if (cascade || event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
    if (preview && !busy) closePreview();
    else if (activeDatePicker) cancelDatePicking();
    else if (linkPicker) cancelLinkPicking();
    else if (shiftMode && !busy) closeShiftForm();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }}>
    <div className="feature-heading"><div><div className="feature-eyebrow">PLAN WITH CLARITY</div><h1>{allProjects ? '전체 프로젝트 간트' : '일정 · 간트'}</h1><p>{allProjects ? '프로젝트별 업무의 일정과 선후행 연결을 한 화면에서 확인하고 조정합니다.' : '업무와 일정이 하나로. 직접 입력하고, 연결하고, 함께 조정하세요.'}</p></div><div className="gantt-heading-actions">
      <button type="button" className="btn gantt-refresh-button" aria-disabled={refreshPaused || requestMode !== null} aria-busy={requestMode === 'manual'}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={manualRefresh}>
        <RefreshCw size={16} className={requestMode === 'manual' ? 'spin' : undefined} aria-hidden="true" />간트 새로고침
      </button>
      {hasProject && <button className="btn" type="button" aria-expanded={workloadView === 'project'} onClick={() => toggleWorkload('project')}><BarChart3 size={15} />담당자 작업량</button>}
      <button className="btn" type="button" aria-expanded={workloadView === 'team'} disabled={!data.projects.length} onClick={() => toggleWorkload('team')}><Layers3 size={15} />프로젝트 간 작업량</button>
      {hasProject && <button className="btn" type="button" aria-expanded={reservationsOpen} disabled={busy} onClick={() => {
        if (reservationsOpen && draftsRef.current.has(TIME_RESERVATIONS_DRAFT) && !canLeave()) return;
        setReservationsOpen(!reservationsOpen);
      }}><CalendarClock size={15} aria-hidden="true" />시간 배정</button>}
      {sheetScope && <button ref={pasteTrigger} type="button" className="btn" disabled={busy || Boolean(pasteScope)}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={openSchedulePaste}>
        <ClipboardPaste size={15} aria-hidden="true" />일정 붙여넣기
      </button>}
      {automaticProjectId && <button className="btn" disabled={busy || sharedViewUnavailable || automaticNeedsSelection || Boolean((planningScope || scheduleFocus) && !automaticScheduleIssues.length)}
        title={automaticNeedsSelection ? '현재 보기에서 자동 일정을 검토할 업무를 선택하세요.' : undefined}
        onClick={() => { if (canLeave()) setAutoOpen(true); }}><Sparkles size={15} />자동 일정</button>}
      <button className="btn" type="button" disabled={busy} onClick={event => showLinkEditor(event.currentTarget)}><Link2 size={16} /> 업무 연결</button>
      <button ref={createTrigger} className="btn btn-primary" disabled={createOpen} onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={16} /> 업무 추가</button>
    </div></div>
    {refreshFeedback && <p className={`gantt-refresh-feedback${refreshFeedback === 'failed' ? ' issue-form-error' : ''}`}
      role={refreshFeedback === 'failed' ? 'alert' : 'status'}>{REFRESH_FEEDBACK[refreshFeedback]}</p>}
    {reservationsOpen && hasProject && <TimeReservations key={draftEpoch} projectId={projectId} issues={projectIssues}
      initialIssue={selectedIssues.length === 1 ? selectedIssues[0] : undefined} actorId={props.actorId} users={data.users}
      notify={notify} openIssue={openIssue} onDraftChange={trackReservationDraft} onChanged={refresh} refreshVersion={refreshCount} />}
    <div className="gantt-stats"><div><span className="gantt-stat-dot" /><strong>{scopedIssues.filter(i => i.startDate && i.endDate).length}</strong><span>일정이 잡힌 업무</span></div><div><span className="gantt-stat-dot is-empty" /><strong>{scopedIssues.filter(i => !i.startDate || !i.endDate).length}</strong><span>일정 미정</span></div><div><Link2 size={13} /><strong>{projectDependencyCount}</strong><span>업무 연결</span></div><span className="gantt-manual-badge">직접 계획 · 자동 제안</span></div>
    {allProjects && <div className="gantt-team-scope">
      <label>프로젝트 필터
        <select className="field" value={chartProjectFilter ?? ''} disabled={busy || Boolean(scheduleFocus || pasteScope)}
          data-gantt-focus-control="" onChange={event => changeTeamProjectFilter(event.target.value || null)}>
          <option value="">전체 프로젝트</option>
          {data.projects.map(item => <option key={item.id} value={item.id}>{item.key} · {item.name}</option>)}
        </select>
      </label>
      {onChangeTeamScheduleFilters && <>
        <label>담당자 필터
          <select className="field" value={teamAssigneeId === null ? 'unassigned' : teamAssigneeId === undefined ? '' : `member:${teamAssigneeId}`}
            disabled={busy || Boolean(scheduleFocus || pasteScope)} data-gantt-focus-control="" onPointerDown={focusTeamFilterSelect}
            onBlur={() => { teamFilterOrigin.current = null; }} onChange={event => {
              const value = event.currentTarget.value;
              const assigneeId = value === 'unassigned' ? null : value ? value.slice('member:'.length) : undefined;
              changeTeamScheduleFilters({ ...teamScheduleFilters, assigneeId });
            }}>
            <option value="">전체 담당자</option>
            <option value="unassigned">미배정</option>
            {typeof teamAssigneeId === 'string' && !data.users.some(user => user.id === teamAssigneeId) &&
              <option value={`member:${teamAssigneeId}`} disabled>현재 팀원 없음</option>}
            {data.users.map(user => <option key={user.id} value={`member:${user.id}`}>{user.name}</option>)}
          </select>
        </label>
        <label>GitLab 조건
          <select className="field" value={teamGitlabFilter ?? ''} disabled={busy || Boolean(scheduleFocus || pasteScope)}
            data-gantt-focus-control="" onPointerDown={focusTeamFilterSelect} onBlur={() => { teamFilterOrigin.current = null; }}
            onChange={event => {
              const value = event.currentTarget.value;
              changeTeamScheduleFilters({ ...teamScheduleFilters, gitlab: isIssueViewGitlabFilter(value) ? value : undefined });
            }}>
            <option value="">GitLab 전체</option>
            {Object.entries(ISSUE_GITLAB_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="gantt-checkbox-label gantt-team-unscheduled" onPointerDown={keepInlineDateFocus}>
          <input ref={teamUnscheduledFilter} type="checkbox" checked={teamUnscheduledOnly} disabled={busy || Boolean(scheduleFocus || pasteScope)}
            data-gantt-focus-control="" onChange={event => changeTeamScheduleFilters({ ...teamScheduleFilters, unscheduledOnly: event.currentTarget.checked || undefined })} />일정 미정만
        </label>
      </>}
      {filteredProject && onOpenProjectGantt && <button className="btn btn-ghost" type="button" disabled={busy}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={() => onOpenProjectGantt(filteredProject.id)}>
        프로젝트 간트 열기 <ArrowRight size={14} aria-hidden="true" />
      </button>}
    </div>}
    {hasProject && onChangeGanttView && (sharedViews.length > 0 || sharedViewUnavailable) && <div className="gantt-shared-view">
      <label className="gantt-shared-view-select">간트 공유 보기
        <select className="field" value={ganttViewId ?? ''} disabled={busy || Boolean(scheduleFocus)} onChange={event => onChangeGanttView(event.target.value || null)}>
          <option value="">공유 보기 없이 표시</option>
          {sharedViewUnavailable && <option value={ganttViewId ?? ''}>열 수 없는 공유 보기</option>}
          {sharedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
      </label>
      {sharedView && onOpenSavedIssueView && <button type="button" className="btn btn-ghost" disabled={busy}
        onClick={() => onOpenSavedIssueView(sharedView.id)}>업무 보기에서 열기 <ArrowRight size={14} aria-hidden="true" /></button>}
      {sharedView && <span role="status" aria-label="간트에 표시된 업무">{projectIssues.length}개 중 {issues.length}개 업무</span>}
      {sharedSortLabels.length > 0 && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 업무 정렬">
        {sharedSortLabels.map(label => <li key={label}>{label}</li>)}
      </ul>}
      {sharedStatusLabel && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 상태 조건">
        <li>{sharedStatusLabel}</li>
      </ul>}
      {sharedReporterLabel && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 요청자 조건">
        <li>{sharedReporterLabel}</li>
      </ul>}
      {sharedPriorityLabelCriteria.length > 0 && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 우선순위·라벨 조건">
        {sharedPriorityLabelCriteria.map(label => <li key={label}>{label}</li>)}
      </ul>}
      {sharedPlanningLabels.length > 0 && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 계획·일정 조건">
        {sharedPlanningLabels.map(label => <li key={label}>{label}</li>)}
      </ul>}
      {sharedGitlabFilter && <ul className="gantt-shared-view-criteria" aria-label="간트에 적용된 GitLab 조건">
        <li>{ISSUE_GITLAB_FILTER_LABELS[sharedGitlabFilter]}</li>
      </ul>}
    </div>}
    {sharedViewUnavailable && <div className="gantt-shared-view-warning">
      <p role="status">이 프로젝트에서 공유 보기를 열 수 없습니다.</p>
      {onChangeGanttView && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChangeGanttView(null)}>공유 보기 해제</button>}
    </div>}
    {focusIssueId && <div className="gantt-issue-focus" data-missing={!focusedIssue || undefined}>
      <p role="status">{focusedIssue ? <><strong>{focusedIssue.key}</strong> {focusedIssue.title}</> :
        allProjects ? '간트에서 대상 업무를 찾을 수 없습니다.' : '이 프로젝트에서 대상 업무를 찾을 수 없습니다.'}</p>
      {onClearIssueFocus && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
        if (onClearIssueFocus()) scrollRef.current?.focus({ preventScroll: true });
      }}>업무 위치 해제</button>}
    </div>}
    <div className="issue-toolbar gantt-toolbar">
      <div className="issue-search"><Search size={15} /><input placeholder="업무 검색" aria-label="간트 업무 검색" value={query}
        maxLength={allProjects ? 200 : undefined} disabled={busy || Boolean(scheduleFocus || (allProjects && pasteScope))}
        onChange={event => changeVisibility(event.currentTarget.value, hideDone)} /></div>
      <label className="gantt-checkbox-label"><input type="checkbox" checked={hideDone} disabled={busy || Boolean(scheduleFocus)}
        onChange={event => changeVisibility(query, event.currentTarget.checked)} />완료 업무 숨기기</label>
      <div className="gantt-toolbar-spacer" />
      <button className="btn" onClick={goToToday}><CalendarDays size={14} /> 오늘</button>
      <div className="issue-view-switch gantt-zoom">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([key, label]) =>
        <button key={key} className={chartZoom === key ? 'active' : ''} disabled={Boolean(activeDatePicker)} onClick={() => setZoom(key)}>{label}</button>)}</div>
      <button ref={selectionShiftTrigger} className="btn" type="button" onClick={() => toggleShiftForm('selection')}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} disabled={!selectedIssues.length || busy || Boolean(activeDatePicker)}
        aria-expanded={shiftMode === 'selection'} aria-controls={shiftMode === 'selection' ? 'gantt-shift-form' : undefined}>
        <MoveHorizontal size={15} aria-hidden="true" />{selectedIssues.length ? `${selectedIssues.length}개 ` : ''}일정 이동
      </button>
      <button className="btn btn-ghost" onClick={undo} data-gantt-focus-control={scheduleFocus ? '' : undefined} onPointerDown={scheduleFocus ? keepInlineDateFocus : undefined} disabled={!undoId || busy || Boolean(activeDatePicker)} aria-label="되돌리기" title="마지막 일정 변경 되돌리기"><Undo2 size={16} /><span className="gantt-undo-label">되돌리기</span></button>
      {canEditBulkDates && <button ref={bulkDatesTrigger} className="btn" type="button" onClick={openBulkDates}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus}
        disabled={!selectedIssues.length || bulkDatesOverLimit || busy || Boolean(activeDatePicker)}>
        <CalendarRange size={15} aria-hidden="true" />일정 일괄 편집
      </button>}
      {canEditBulkDates && bulkDatesOverLimit && <span role="status" className="muted">날짜를 한 번에 편집할 업무를 {MAX_SCHEDULE_BULK_DATE_ISSUES}개 이하로 선택하세요.</span>}
      {inlineDateCount >= 2 && <button className="btn" type="button" data-gantt-focus-control=""
        onPointerDown={keepInlineDateFocus} onClick={event => void openInlineDateReview(event.currentTarget)}
        disabled={busy || scheduleEditorOpen || issueOverlayOpen || inlineDateCount > MAX_SCHEDULE_MANUAL_ISSUES}>
        <CalendarRange size={15} aria-hidden="true" />입력한 날짜 {inlineDateCount}건 검토
      </button>}
      {inlineDateCount > MAX_SCHEDULE_MANUAL_ISSUES && <span role="status" className="muted">
        한 번에 최대 {MAX_SCHEDULE_MANUAL_ISSUES.toLocaleString('ko-KR')}개 업무의 날짜를 검토할 수 있습니다.
      </span>}
      <button ref={findingsTrigger} className="btn gantt-findings-trigger" type="button" aria-label="일정 충돌" aria-expanded={findingsOpen}
        aria-controls={findingsOpen ? FINDINGS_PANEL_ID : undefined}
        aria-describedby="gantt-dependency-summary"
        disabled={!canShowFindings} onClick={() => setFindingsOpen(open => !open)}>
        <AlertCircle size={15} aria-hidden="true" />일정 충돌
        {activeFindings.length > 0 && <span className="gantt-findings-count" aria-hidden="true">{activeFindings.length}</span>}
      </button>
      <span id="gantt-dependency-summary" hidden>충돌 {activeConflictCount}건, 전체 점검 항목 {activeFindings.length}건</span>
      <button ref={deadlinesTrigger} className="btn" type="button" aria-label="목표 마감일 검토" aria-expanded={deadlinesOpen}
        aria-controls={deadlinesOpen ? DEADLINES_PANEL_ID : undefined} aria-describedby="gantt-deadline-summary"
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} disabled={deadlineActionsDisabled}
        onClick={() => deadlinesOpen ? closeDeadlines() : setDeadlinesOpen(true)}>
        <CalendarClock size={15} aria-hidden="true" />목표 마감일 검토
        {lateDeadlineCount > 0 && <span className="gantt-findings-count" aria-hidden="true">{lateDeadlineCount}</span>}
      </button>
      <span id="gantt-deadline-summary" hidden>목표 마감일 {issueDeadlines.size}건, 계획 종료일 초과 {lateDeadlineCount}건</span>
      {Object.entries(GANTT_DEADLINE_LABELS).map(([kind, label]) => <span key={kind} id={`gantt-deadline-label-${kind}`} hidden>{label}</span>)}
      {canShowTeamBlockers && <button ref={teamBlockersTrigger} className="btn" type="button" aria-expanded={teamBlockersOpen}
        aria-controls={teamBlockersOpen ? TEAM_BLOCKERS_PANEL_ID : undefined} data-gantt-focus-control="" onPointerDown={keepInlineDateFocus}
        disabled={busy || issueOverlayOpen} onClick={() => teamBlockersOpen ? closeTeamBlockers() : setTeamBlockersOpen(true)}>
        <Network size={15} aria-hidden="true" />프로젝트 간 차단
      </button>}
      {hasProject && <button ref={analysisTrigger} className="btn" type="button" aria-expanded={analysisOpen} aria-controls={analysisOpen ? ANALYSIS_PANEL_ID : undefined} onClick={() => setAnalysisOpen(open => !open)}>
        <ChartNoAxesCombined size={15} aria-hidden="true" />일정 여유 분석
      </button>}
      <button ref={linkPickerTrigger} className="btn gantt-link-picker-trigger" type="button" aria-pressed={Boolean(linkPicker)}
        disabled={busy || (!linkPicker && !canPickLink)} onClick={toggleLinkPicking}>
        <Link2 size={15} aria-hidden="true" />차트에서 연결
      </button>
      {linkAnchor && <button className="btn" type="button" disabled={busy} onClick={event => showLinkEditor(event.currentTarget,
        { anchor: { issueId: linkAnchor.id, otherRole: 'successor' } })}>
        <Link2 size={15} aria-hidden="true" />선택 업무에서 연결
      </button>}
      {sheetScope && <button ref={blockerLinksTrigger} className="btn" type="button"
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={openBlockerLinks}
        disabled={busy || scheduleEditorOpen || issueOverlayOpen}>
        <Network size={15} aria-hidden="true" />차단 관계로 일정 연결
      </button>}
      {selectedIssues.length > 1 && <>
        <button ref={bulkLinksTrigger} className="btn" type="button" onClick={openBulkLinks}
          data-gantt-focus-control="" onPointerDown={keepInlineDateFocus}
          aria-describedby={bulkLinkProblem ? 'gantt-bulk-links-problem' : undefined}
          disabled={busy || Boolean(activeDatePicker || bulkLinkProblem)}>
          <Link2 size={15} aria-hidden="true" />선후행 일괄 연결
        </button>
        {bulkLinkProblem && <span id="gantt-bulk-links-problem" className="muted">{bulkLinkProblem}</span>}
      </>}
      {selectedAnchor && !scheduleFocus && <button ref={dependencyFocusTrigger} className="btn" type="button" disabled={busy}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={event => openScheduleFocus('dependencies', selectedAnchor, event.currentTarget)}>
        <Network size={15} aria-hidden="true" />선후행 흐름 보기
      </button>}
      {selectedAnchor && hierarchy.childCounts.has(selectedAnchor.id) && !scheduleFocus && <button ref={hierarchyFocusTrigger} className="btn" type="button" disabled={busy}
        data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} onClick={event => openScheduleFocus('hierarchy', selectedAnchor, event.currentTarget)}>
        <ListTree size={15} aria-hidden="true" />하위 업무 일정 보기
      </button>}
      {selectedAnchor && (['predecessor', 'successor'] as const).map(direction => (
        <button key={direction} className="btn" type="button" disabled={busy} data-gantt-focus-control=""
          onPointerDown={keepInlineDateFocus} onClick={event => {
            if (canLeave()) setScheduleIssueCreation({ link: { direction, issue: selectedAnchor }, opener: event.currentTarget });
          }}><Plus size={15} aria-hidden="true" />새 {direction === 'predecessor' ? '선행' : '후행'} 업무 추가</button>
      ))}
    </div>
    {scheduleFocus?.kind === 'dependencies' && <GanttDependencyFocusPanel trace={dependencyTrace} outsideFilterCount={outsideFilterCount} disabled={busy}
      onClose={closeScheduleFocus} onLocate={() => { if (dependencyTrace) locateScheduleFocusRow(dependencyTrace.anchor); }}
      onPointerDown={keepInlineDateFocus} />}
    {scheduleFocus?.kind === 'hierarchy' && <GanttHierarchyFocusPanel trace={hierarchyTrace} outsideFilterCount={outsideFilterCount} disabled={busy}
      onClose={closeScheduleFocus} onLocate={() => { if (hierarchyTrace) locateScheduleFocusRow(hierarchyTrace.anchor, { preferredDate: hierarchyTrace.span?.startDate }); }}
      onPointerDown={keepInlineDateFocus} additionalActions={hierarchyTrace && <button ref={hierarchyShiftTrigger} className="btn" type="button"
        onClick={() => toggleShiftForm('hierarchy')} data-gantt-focus-control="" onPointerDown={keepInlineDateFocus}
        disabled={busy || Boolean(activeDatePicker || linkPicker || issueOverlayOpen || drag)}
        aria-expanded={shiftMode === 'hierarchy'} aria-controls={shiftMode === 'hierarchy' ? 'gantt-shift-form' : undefined}>
        <MoveHorizontal size={14} aria-hidden="true" />상위·하위 일정 함께 이동
      </button>} />}
    {linkPicker && <GanttLinkPrompt source={sourceRow && pickedSource ? { key: sourceRow.issue.key, endpoint: pickedSource.endpoint } : null}
      canPick={hasVisibleLinkPair} crossProject={hasCrossProjectPair} onReset={() => {
        setLinkPicker({ source: null });
        linkPickerTrigger.current?.focus({ preventScroll: true });
      }} onCancel={cancelLinkPicking} />}
    {findingsOpen && canShowFindings && <GanttDependencyFindings id={FINDINGS_PANEL_ID} findings={activeFindings} focused={Boolean(scheduleFocus)}
      allProjects={allProjects && !chartProjectFilter}
      disabled={busy || Boolean(issueOverlayOpen)} onLocateDate={locateFindingDate}
      onEditLink={(dependency, opener) => showLinkEditor(opener, { dependency })}
      onClose={() => { setFindingsOpen(false); findingsTrigger.current?.focus({ preventScroll: true }); }} />}
    {deadlinesOpen && <GanttDeadlines id={DEADLINES_PANEL_ID} issues={issues} disabled={deadlineActionsDisabled}
      onClose={closeDeadlines} onLocate={locateDeadline} onEdit={(issue, opener) => openRowScheduleEdit(issue, opener, { focusDate: 'dueDate' })}
      onPointerDown={keepInlineDateFocus} />}
    {teamBlockersOpen && canShowTeamBlockers && <GanttTeamBlockers key={`${draftEpoch}:${teamBlockerListRevision}`} id={TEAM_BLOCKERS_PANEL_ID} data={data}
      visibleIssueIds={new Set(issueRows.keys())} selectedIssueIds={selectedIssues.map(issue => issue.id)}
      busy={busy || Boolean(issueOverlayOpen || linkPicker || teamBlockerEdit)} openIssue={openIssue} onLocateIssueDate={onLocateIssueDate}
      chartPair={teamBlockerChartPair} onChartPairSettled={() => setTeamBlockerChartPair(undefined)}
      hasDateDraft={issue => Boolean(chartDateDraft(issue))} onReviewDates={reviewTeamBlockerDates}
      onReviewSchedule={(relation, source, target, opener) => reviewTeamBlockerSchedules(source, [{ relation, target }], opener)}
      onReviewTogether={reviewTeamBlockerSchedules}
      createdBlockedIssue={createdBlockedIssue} onCreateBlockedIssue={openBlockedIssueCreation}
      onPointerDown={keepInlineDateFocus} refresh={refresh} notify={notify} onClose={closeTeamBlockers}
      onDraftChange={trackTeamBlockerDraft} />}
    {teamBlockerEdit && <GanttTeamBlockerEdit
      source={data.issues.find(issue => issue.id === teamBlockerEdit.source.id) ?? teamBlockerEdit.source}
      target={data.issues.find(issue => issue.id === teamBlockerEdit.target.id) ?? teamBlockerEdit.target}
      sourceDraft={teamBlockerEdit.sourceDraft} targetDraft={teamBlockerEdit.targetDraft}
      actorId={props.actorId} undoScope={undoScope} refresh={refresh} onDraftChange={trackTeamBlockerEdit}
      onClose={closeTeamBlockerEdit} onApplied={applyTeamBlockerEdit} />}
    {analysisResult && <ScheduleAnalysis id={ANALYSIS_PANEL_ID} analysis={analysisResult.analysis} error={analysisResult.error}
      onClose={() => { setAnalysisOpen(false); analysisTrigger.current?.focus(); }} openIssue={openIssue}
      canLocateIssue={issueId => Boolean(issueRows.get(issueId)?.issue.startDate)} onLocateIssue={locateAnalysisIssue} onLocateFinish={locateTimelineDate} />}
    {shiftMode && <form className="gantt-shift-form" id="gantt-shift-form" data-shift-mode={shiftMode} onSubmit={submitShift}>
      {shiftMode === 'hierarchy'
        ? <span>상위 업무와 하위 업무 <strong>{hierarchyTrace?.depths.size ?? 0}개</strong>를</span>
        : <span><strong>{selectedIssues.length}개</strong> 업무를</span>}
      <input ref={shiftDaysField} className="field" aria-label="이동 일수" type="number" step="1" min="-3650" max="3650"
        value={days} disabled={busy} onChange={e => setDays(Number(e.target.value))} required />
      <span>일 이동</span>
      <label className="gantt-checkbox-label"><input type="checkbox" checked={workingDays} disabled={busy} onChange={e => setWorkingDays(e.target.checked)} />근무일 기준</label>
      <label className="gantt-checkbox-label"><input type="checkbox" checked={shiftSuccessors} disabled={busy}
        aria-describedby={shiftSuccessors ? 'gantt-shift-follow-up-help' : undefined}
        onChange={event => setShiftSuccessors(event.target.checked)} />후행 업무도 함께 조정</label>
      <small>{shiftMode === 'hierarchy'
        ? '시작일과 종료일을 같은 일수만큼 옮깁니다. 음수는 앞당기며, 근무일 기준은 프로젝트 달력의 근무 요일과 예외를 적용합니다.'
        : '음수는 앞당기기 · 프로젝트 달력의 근무 요일·예외 적용'}</small>
      {shiftSuccessors && <small id="gantt-shift-follow-up-help">같은 프로젝트에서 선후행 조건을 맞추는 데 필요한 일정만 늦춥니다.</small>}
      <button className="btn btn-primary" type="submit" disabled={busy || (shiftMode === 'hierarchy' ? !hierarchyTrace : !selectedIssues.length)}>변경 미리보기</button>
      <button className="issue-icon-button" type="button" onClick={closeShiftForm} disabled={busy} aria-label="일정 이동 닫기"><X size={16} aria-hidden="true" /></button>
    </form>}
    {createOpen && <InlineIssueForm key={`${projectId}:${draftEpoch}`} data={data} projectId={filteredProject?.id ?? projectId} chooseProject={allProjects} actorId={props.actorId} projects={data.projects} users={data.users} sharedViewActive={ganttViewId !== null} initialPlan={planningExpanded && selectedPlan?.status !== 'archived' ? selectedPlan : undefined} onDraftChange={trackDraft} onClose={closeCreateForm} onCreated={async issue => {
      await refresh();
      finishCreating();
      if (scheduleFocus) {
        const label = scheduleFocus.kind === 'hierarchy' ? '하위 업무 일정' : '선후행 흐름';
        const isDescendant = hierarchyTrace && issue.projectId === hierarchyTrace.anchor.projectId && issue.parentId &&
          (issue.parentId === hierarchyTrace.anchor.id || hierarchyTrace.depths.has(issue.parentId));
        notify(`${issue.key} 업무를 추가했습니다.${isDescendant ? '' : ` 새 업무는 현재 ${label}의 범위 밖에 있습니다.`}`);
      } else if (sharedViewUnavailable || matchSharedView && !matchSharedView(issue)) {
        notify(`${issue.key} 업무를 간트에 추가했습니다. 새 업무는 현재 공유 보기의 범위 밖에 있습니다.`);
      } else if (chartProjectFilter && issue.projectId !== chartProjectFilter) {
        notify(`${issue.key} 업무를 추가했습니다. 프로젝트 필터를 바꾸면 간트에 표시됩니다.`);
      } else if (allProjects && !locallyVisibleIssues(query, false, undefined, [issue]).length) {
        notify(`${issue.key} 업무를 추가했습니다. 현재 간트 필터의 범위 밖에 있습니다.`);
      } else {
        if (!allProjects) setProjectQuery('');
        setHideDone(false);
        if (planningScope && issue[planningFields(planningScope.kind).idField] !== planningScope.id) setLinkedOnly(false);
        notify(`${issue.key} 업무를 간트에 추가했습니다.`);
      }
    }} />}
    {hasProject && <div hidden={Boolean(scheduleFocus)}><GanttPlanningControls {...props} expanded={planningExpanded} onExpandedChange={expanded => {
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
    <SchedulePlanningPanel {...props} selectedBaselineId={selectedBaselineId} onSelectBaseline={setSelectedBaselineId}
      onOpenMilestoneReview={openMilestoneReview} onCloseMilestoneReview={closeMilestoneReview}
      onLocateMilestoneIssue={id => onLocateIssueDate(id, 'endDate')} onOpenMilestoneIssue={openMilestoneIssue}
      onOpenMilestoneCandidateIssue={openChartIssue} />
    {baseline && <div className="gantt-baseline-caption"><span className="gantt-baseline-key" />비교 기준선 <strong>{baseline.name}</strong><span>회색은 캡처된 계획 · 종료 차이는 달력일 · 삭제된 업무와 마일스톤 기록도 보존됩니다.</span></div>}</div>}
    <div className="gantt-hint" id="gantt-editing-help" hidden={Boolean(linkPicker || activeDatePicker)}><span><span className="gantt-mini-bar" />막대 가운데는 이동, 양 끝은 기간 조정 · 핸들은 ← → 키로도 조정</span><span>행의 저장 버튼이나 Enter로 날짜를 저장합니다. 저장 전 날짜는 같은 탭에서 새로고침해도 남습니다. Esc로 날짜 변경을 취소합니다.</span></div>
    {dateStorageError && <p className="gantt-hint" role="status">브라우저의 날짜 초안을 읽거나 보관하지 못했습니다. 화면을 닫기 전에 입력을 저장해 주세요.</p>}
    {unavailableDateIds.length > 0 && <div className="gantt-hint">
      <span role="status">원래 업무와 연결할 수 없는 날짜 초안이 {unavailableDateIds.length}건 있습니다.</span>
      <button className="btn" type="button" disabled={busy || scheduleEditorOpen} onClick={() => {
        for (const id of unavailableDateIds) retainedDates.current.delete(id);
        storeInlineDates();
      }}>연결할 수 없는 초안 지우기</button>
    </div>}
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
      <button type="button" className="btn" data-gantt-export="true" disabled={exportDisabled} title="저장된 일정으로 내려받기"
        onPointerDown={keepInlineDateFocus} onClick={downloadGantt}><ArrowDownToLine size={15} aria-hidden="true" />간트 HTML 내려받기</button>
      {sheetScope && <button type="button" className="btn" data-gantt-export="true" disabled={exportDisabled || !sheetIssues.length}
        title={`${selectedIssues.length ? '선택한' : '표시된'} 업무의 저장된 일정, 목표 마감일, 선행 연결`}
        onPointerDown={keepInlineDateFocus} onClick={downloadScheduleSheet}>
        <ArrowDownToLine size={15} aria-hidden="true" />일정 편집용 TSV 내려받기
      </button>}
      <small>최대 {MAX_TIMELINE_DAYS}일 표시 · 범위 밖 기록은 행의 날짜로 이동하세요.</small>
    </div>
    {workloadView === 'project' && <ProjectWorkload key={draftEpoch} {...props} undoScope={undoScope} startDate={isoDay(range.start)} endDate={isoDay(range.end)}
      onDraftChange={trackDraft} onBeforeLevel={canOpenWorkloadLevel} scheduleBusy={busy} onScheduleApplied={onWorkloadLevelApplied}
      levelIssueIds={selectedIssues.map(issue=>issue.id)} />}
    {workloadView === 'team' && <TeamWorkload key={draftEpoch} {...props} undoScope={undoScope} initialStartDate={isoDay(range.start)}
      onDraftChange={trackDraft} onBeforeLevel={canOpenWorkloadLevel} scheduleBusy={busy} onScheduleApplied={onWorkloadLevelApplied} />}
    {activeDatePicker && <GanttDateRangePrompt issueKey={activeDatePicker.issue.key} issueTitle={activeDatePicker.issue.title}
      fixedEdge={activeDatePicker.fixedEdge} currentRange={activeDatePicker.issue.startDate && activeDatePicker.issue.endDate
        ? { start: activeDatePicker.issue.startDate, end: activeDatePicker.issue.endDate } : undefined}
      firstDate={activeDatePicker.firstDate} onReset={resetDatePicking} onCancel={cancelDatePicking} />}
    <div className="gantt-scroll" data-gantt-focus-control="" ref={scrollRef} tabIndex={-1} role="region" aria-label="간트 차트"
      onPointerDownCapture={event => {
        if (event.button === 0 && event.target instanceof Element && event.target.closest('button:is(.gantt-bar, .gantt-resize-handle):enabled')) {
          draggingRef.current = true;
          reconsider();
        }
      }}><div className="gantt-canvas" style={{ width: LEFT_WIDTH + timelineWidth, '--gantt-day-width': `${dayWidth}px` } as CSSProperties}>
      <div className="gantt-chart-header"><div className="gantt-left gantt-left-header"><label><input type="checkbox" aria-label="표시된 업무 전체 선택" checked={issues.length > 0 && issues.every(i => selected.has(i.id))} onChange={e => setSelected(e.target.checked ? new Set(issues.map(i => i.id)) : new Set())} /></label><span>업무 <small>{issues.length}</small></span><span>시작일</span><span>종료일</span></div><div className="gantt-date-header" style={{ width: timelineWidth }}><div className="gantt-months">{months.map((tick, index) => <span key={tick.iso} style={{ left: tick.index * dayWidth, width: ((months[index + 1]?.index ?? range.days) - tick.index) * dayWidth }}>{tick.date.getUTCFullYear()}년 {tick.date.getUTCMonth() + 1}월</span>)}</div><div className="gantt-days">{ticks.map(tick => <span key={tick.iso} data-date={tick.iso} className={`${tick.nonworking ? 'weekend' : ''} ${tick.iso === todayDate() ? 'today' : ''}`} style={{ width: dayWidth }}>{chartZoom === 'day' ? <>{tick.date.getUTCDate()}<small>{['일', '월', '화', '수', '목', '금', '토'][tick.weekday]}</small></> : chartZoom === 'week' && (tick.weekday === 1 || tick.index === 0) ? tick.date.getUTCDate() : chartZoom === 'month' && tick.date.getUTCDate() === 15 ? '15' : ''}</span>)}</div></div></div>
      {nonworkingTicks.map(tick => <div key={tick.iso} className="gantt-weekend-band" style={{ left: LEFT_WIDTH + tick.index * dayWidth, width: dayWidth, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />)}
      {todayPosition >= 0 && todayPosition < timelineWidth && <div className="gantt-today-line" style={{ left: LEFT_WIDTH + todayPosition + dayWidth / 2, top: HEADER_HEIGHT, height: chartRowCount * ROW_HEIGHT }} />}
      <svg className="gantt-dependency-lines" width={timelineWidth} height={issues.length * ROW_HEIGHT} style={{ left: LEFT_WIDTH, top: HEADER_HEIGHT + planningRows.length * ROW_HEIGHT }} aria-hidden="true">
        <defs>
          <marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="#8a9b9b" /></marker>
          {conflictingIds.size > 0 && <marker id="gantt-arrow-conflict" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="var(--gantt-dependency-conflict)" /></marker>}
          {analysisResult?.analysis && <marker id="gantt-arrow-analysis" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="var(--gantt-analysis-accent)" /></marker>}
        </defs>
        {dependencies.map(link => <GanttConnector key={link.dependency.id} {...link} range={range} dayWidth={dayWidth} drag={drag}
          conflict={conflictingIds.has(link.dependency.id)}
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
        const rowProject = allProjects ? projectsById.get(issue.projectId) : undefined;
        const captured = baseline?.issues.find(value => value.issueId === issue.id);
        const endDelta = captured?.endDate && issue.endDate ? dayNumber(issue.endDate) - dayNumber(captured.endDate) : null;
        const isSource = pickedSource?.issueId === issue.id;
        const rowLinkEndpoint = pickedSource ? 'startDate' : 'endDate';
        const canPickRow = canPickLinkEndpoint(issue, rowLinkEndpoint);
        const startPosition = start !== null && start >= range.start && start <= range.end ? (start - range.start) * dayWidth + BAR_EDGE_INSET : null;
        const endPosition = end !== null && end >= range.start && end <= range.end ? (end - range.start + 1) * dayWidth - BAR_EDGE_INSET : null;
        const barClass = `gantt-bar ${dragging ? 'is-dragging' : ''} ${status.category === 'done' ? 'is-done' : ''}`;
        const isFocused = focusedIssue?.id === issue.id;
        const isTracePredecessor = dependencyTrace?.predecessorDepths.has(issue.id);
        const isTraceSuccessor = dependencyTrace?.successorDepths.has(issue.id);
        const traceRole = issue.id === dependencyTrace?.anchor.id ? 'anchor'
          : isTracePredecessor && isTraceSuccessor ? 'both' : isTracePredecessor ? 'predecessor' : isTraceSuccessor ? 'successor' : undefined;
        const hierarchyRole = hierarchyTrace ? issue.id === hierarchyTrace.anchor.id ? 'anchor' : 'descendant' : undefined;
        const hierarchySpan = hierarchyRole === 'anchor' ? hierarchyTrace?.span : null;
        const rowDatePicker = activeDatePicker?.issue.id === issue.id ? activeDatePicker : null;
        const fixedOrFirst = rowDatePicker && (rowDatePicker.firstDate ?? rowDatePicker.fixedEdge?.date);
        const deadline = issueDeadlines.get(issue.id);
        const deadlineX = deadline && !outside(deadline.dueDate) ? (dayNumber(deadline.dueDate) - range.start + .5) * dayWidth : null;
        const deadlineLabel = deadline && `${issue.key} 목표 마감일 ${deadline.dueDate}`;
        const matchedAliasLabel = matchingIssueSearchAliases(data, issue.id, aliasQuery).map(issueSearchAliasLabel).join(' · ');
        return <div data-issue-id={issue.id} data-focused-issue={isFocused || undefined} data-dependency-focus-row={traceRole} data-hierarchy-focus-row={hierarchyRole}
          className={`gantt-row ${selected.has(issue.id) ? 'is-selected' : ''}${linkPicker ? ' gantt-link-pick-row' : ''}${isSource ? ' gantt-link-source-row' : ''}`} key={issue.id}>
          <div className="gantt-left">
            <label><input type="checkbox" aria-label={`${issue.key} 선택`} checked={selected.has(issue.id)} onChange={() => toggleSelected(issue.id)} /></label>
            <div className="gantt-issue-cell">
              {!linkPicker && <button type="button" className="issue-icon-button gantt-row-schedule-trigger"
                aria-label={`${issue.key} 일정과 연결 편집`} title="일정과 연결 편집" data-schedule-owner={issue.id}
                disabled={busy || Boolean(activeDatePicker)}
                onPointerDown={event => {
                  if (event.button === 0 && document.activeElement?.matches('input[data-schedule-edge]')) event.preventDefault();
                }} onClick={event => openRowScheduleEdit(issue, event.currentTarget)}><Pencil size={15} aria-hidden="true" /></button>}
              {hasSchedule && !linkPicker && <GanttDatePickerButton issue={issue} className="issue-icon-button gantt-row-date-picker"
                disabled={datePickingDisabled} iconOnly onOpen={startDatePicking} />}
              <button type="button" className="gantt-issue-name" disabled={Boolean(linkPicker && !canPickRow)}
                aria-label={linkPicker ? `${issue.key} ${linkStep} 업무 선택` : undefined}
                onClick={event => linkPicker ? pickLink(issue.id, rowLinkEndpoint, false) : openIssueRow(issue.id, event.currentTarget)}>
                <IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />
                <span><small>{rowProject && <><span className="gantt-row-project" title={rowProject.name}>{rowProject.key}</span> · </>}{issue.key} · <IssueTypeName data={data} issue={issue} />
                  {hierarchyTrace && <GanttHierarchyFocusLabel trace={hierarchyTrace} issueId={issue.id} />}</small><strong title={issue.title}>{issue.title}</strong>
                  {matchedAliasLabel && <small className="gantt-issue-search-alias" title={matchedAliasLabel}>{matchedAliasLabel}</small>}
                  {visibleIds && !visibleIds.has(issue.id) && <small>현재 보기 조건 밖 · 날짜 입력 유지</small>}
                  {dependencyTrace && <GanttDependencyFocusLabel trace={dependencyTrace} issueId={issue.id} />}
                  {endDelta !== null && <small className="gantt-baseline-delta" title="현재 계획 종료일 − 기준선 종료일 (달력일)">종료 {endDelta > 0 ? '+' : ''}{endDelta}일 · 달력일</small>}</span>
                {user && <span className="issue-avatar" style={{ background: user.color }} title={user.name}>{user.name.slice(0, 1)}</span>}
              </button>
              {deadline && !linkPicker && <button type="button" className="gantt-row-deadline" data-gantt-deadline={deadline.kind}
                aria-label={`${issue.key} 목표 마감일 수정`} title={`${deadlineLabel} · ${GANTT_DEADLINE_LABELS[deadline.kind]}`}
                data-gantt-focus-control="" onPointerDown={keepInlineDateFocus} disabled={deadlineActionsDisabled}
                onClick={event => openRowScheduleEdit(issue, event.currentTarget, { focusDate: 'dueDate' })}>
                <span>{deadline.dueDate.slice(5)}</span><span>{deadline.kind === 'late' ? '초과' : deadline.kind === 'missing' ? '종료 미정' : '마감'}</span>
              </button>}
              <IssueHierarchyContext issueId={issue.id} hierarchy={hierarchy} openIssue={openIssue} disabled={busy || Boolean(linkPicker)}
                childSchedule={{ label: `${issue.key} 하위 업무 일정 보기`, disabled: Boolean(scheduleFocus),
                  onOpen: opener => openScheduleFocus('hierarchy', issue, opener), onPointerDown: keepInlineDateFocus }} />
            </div>
            {dateRecoveryReady && <DateCells key={`${issue.id}:${issue.projectId}:${draftEpoch}`} issue={issue}
              recovered={recoverableDates(issue, inlineDateRecords.get(issue.id))} onDraftChange={trackDraft} onInlineDraftChange={trackInlineDates}
              disabled={busy || Boolean(preview || cascade || linkPicker || activeDatePicker)}
              onSave={saveDates}
              onReview={outgoingIssueIds.has(issue.id) ? reviewSuccessors : undefined}
              onReviewTeam={teamBlockerChoices.has(issue.id) ? (source, change, origin) =>
                reviewTeamSuccessors(source, change, { ...origin, source }) : undefined} />}
          </div>
          <div className="gantt-row-timeline" style={{ width: timelineWidth }}>
          {captured?.startDate && captured.endDate && <div className="gantt-baseline-bar" role="img" aria-label={`${captured.key} 기준선 ${captured.startDate} ~ ${captured.endDate}`} title={`${baseline!.name}: ${captured.title} · ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}
          {hierarchySpan && <GanttHierarchySpan anchorKey={issue.key} {...hierarchySpan} style={capturedStyle(hierarchySpan.startDate, hierarchySpan.endDate)} />}
          {rowDatePicker ? <GanttDateRangeLane issueKey={issue.key} rangeStart={range.start} rangeEnd={range.end}
            minDay={rowDatePicker.fixedEdge?.kind === 'start' ? dayNumber(rowDatePicker.fixedEdge.date) : range.start}
            maxDay={rowDatePicker.fixedEdge?.kind === 'end' ? dayNumber(rowDatePicker.fixedEdge.date) : range.end}
            initialDay={rowDatePicker.initialDay} selectedDay={fixedOrFirst ? dayNumber(fixedOrFirst) : null}
            onPick={chooseIssueDate} onFocusDay={focusPickedDay} />
          : visibleSchedule ? <div className={`gantt-task-range ${dragging ? 'is-dragging' : ''}`} style={{ left: (visibleStart - range.start) * dayWidth + BAR_EDGE_INSET, width: (visibleEnd - visibleStart + 1) * dayWidth - 2 * BAR_EDGE_INSET, '--bar-color': status.color } as CSSProperties}>
            {linkPicker ? <span className={`${barClass} gantt-link-bar`} data-analysis-critical={critical || undefined} aria-hidden="true"><span>{chartZoom !== 'month' && issue.title}</span></span>
              : <button className={barClass} disabled={busy || Boolean(activeDatePicker)} data-analysis-critical={critical || undefined} aria-label={`${issue.key} 일정 이동`} aria-describedby={critical ? 'gantt-editing-help gantt-analysis-critical-help' : 'gantt-editing-help'} title={`${issue.key}: ${issue.startDate} ~ ${issue.endDate} · 끌어서 이동, 선택해서 상세 보기`} onPointerDown={event => beginDrag(event, issue, 'move')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIssueRow(issue.id, event.currentTarget); } }}><span>{chartZoom !== 'month' && issue.title}</span></button>}
            {!linkPicker && (['start', 'end'] as const).filter(edge => edge === 'start' ? !outside(isoDay(start! + startOffset)) : !outside(isoDay(end! + endOffset))).map(edge =>
              <GanttResizeHandle key={edge} issue={issue} edge={edge} disabled={busy || Boolean(activeDatePicker)}
                onBegin={beginDrag} onMove={moveDrag} onFinish={finishDrag} onCancel={() => setDrag(null)}
                onResize={previewResize} onFocusDate={focusDateFromControl} />)}
            {dragging && offset !== 0 && <small className="gantt-drag-label">{drag.mode === 'move' ? `${offset > 0 ? '+' : ''}${offset}일` : `${moveDate(issue.startDate!, startOffset)} ~ ${moveDate(issue.endDate!, endOffset)}`}</small>}
          </div> : hasSchedule ? <button className="gantt-jump-date" onClick={() => showDate(issue.startDate!)}>{issue.startDate} — {issue.endDate} · 일정으로 이동 →</button> : !linkPicker && <div className="gantt-date-range-actions">
            <button type="button" className="gantt-no-schedule gantt-missing-date-action" aria-label={`${issue.key} 날짜 입력`} data-schedule-owner={issue.id}
              disabled={busy || Boolean(activeDatePicker)} onClick={event => focusDateFromControl(event.currentTarget, issue)}><Plus size={12} aria-hidden="true" />날짜 입력</button>
            <GanttDatePickerButton issue={issue} className="gantt-no-schedule gantt-missing-date-action"
              disabled={datePickingDisabled} onOpen={startDatePicking} />
          </div>}
          {linkPicker && <GanttLinkEndpoints issueKey={issue.key} step={linkStep} startPosition={startPosition} endPosition={endPosition}
            timelineWidth={timelineWidth} canPick={endpoint => canPickLinkEndpoint(issue, endpoint)} onPick={endpoint => pickLink(issue.id, endpoint, true)} />}
          {deadline && deadlineX !== null && !linkPicker && !activeDatePicker && <span className="gantt-deadline-marker"
            data-gantt-deadline={deadline.kind} data-gantt-focus-control="" style={{ left: deadlineX }} role="img"
            aria-label={deadlineLabel || undefined} aria-describedby={`gantt-deadline-label-${deadline.kind}`} tabIndex={-1} />}
        </div></div>;
      })}
      {historicalIssues.map(captured => <div key={`historical:${captured.issueId}`} className="gantt-row gantt-history-row" data-baseline-issue-id={captured.issueId}><div className="gantt-left"><span /><div className="gantt-history-name"><small>{captured.key} · 삭제된 업무 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button><button className="gantt-history-date" disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{captured.startDate && captured.endDate && <div className="gantt-baseline-bar is-historical" role="img" aria-label={`${captured.key} 삭제된 업무 기준선 ${captured.startDate} ~ ${captured.endDate}`} style={capturedStyle(captured.startDate, captured.endDate)} />}</div></div>)}
      {milestones.map(milestone => {
        const captured = baseline?.milestones.find(value => value.milestoneId === milestone.id);
        const delta = captured ? dayNumber(milestone.date) - dayNumber(captured.date) : null;
        const expanded = milestoneReviewId === milestone.id;
        return <div key={milestone.id} className="gantt-row gantt-milestone-row" data-milestone-id={milestone.id}>
          <div className="gantt-left">
            <Diamond size={13} />
            <button type="button" className="gantt-milestone-name gantt-milestone-review-button" disabled={busy || scheduleEditorOpen || issueOverlayOpen}
              aria-label={`${milestone.title} 연결 업무 확인`} aria-expanded={expanded} aria-controls={expanded ? SCHEDULE_MILESTONE_REVIEW_ID : undefined}
              onClick={event => openMilestoneReview(milestone.id, event.currentTarget)}>
              <small>{milestone.status === 'reached' ? '달성' : '예정'} · 마일스톤</small><strong>{milestone.title}</strong>
              {delta !== null && <small>기준선 대비 {delta > 0 ? '+' : ''}{delta}일 · 달력일</small>}
            </button>
            <button className="gantt-history-date" onClick={() => showDate(milestone.date)}>{milestone.date}</button>
            {captured ? <button className="gantt-history-date" onClick={() => showDate(captured.date)}>기준 {captured.date}</button> : <span />}
          </div>
          <div className="gantt-row-timeline" style={{ width: timelineWidth }}>
            {captured && !outside(captured.date) && <span className="gantt-milestone-diamond is-baseline" role="img"
              aria-label={`${captured.title} 마일스톤 기준선 ${captured.date}`} title={`기준선: ${captured.title} · ${captured.date}`}
              style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} />}
            {!outside(milestone.date) ? <span className={`gantt-milestone-diamond ${milestone.status === 'reached' ? 'is-reached' : ''}`}
              role="img" aria-label={`${milestone.title} 마일스톤 ${milestone.date}`} title={`${milestone.title} · ${milestone.date}`}
              style={{ left: (dayNumber(milestone.date) - range.start + .5) * dayWidth }}><span>{milestone.title}</span></span>
              : <button className="gantt-jump-date" onClick={() => showDate(milestone.date)}>{milestone.date} · 마일스톤으로 이동 →</button>}
          </div>
        </div>;
      })}
      {historicalMilestones.map(captured => <div key={`historical-milestone:${captured.milestoneId}`} className="gantt-row gantt-history-row"><div className="gantt-left"><Diamond size={12} /><div className="gantt-history-name"><small>삭제된 마일스톤 기록</small><strong>{captured.title}</strong></div><button className="gantt-history-date" onClick={() => showDate(captured.date)}>{captured.date}</button><span /></div><div className="gantt-row-timeline" style={{ width: timelineWidth }}>{!outside(captured.date) ? <span className="gantt-milestone-diamond is-baseline is-historical" role="img" aria-label={`${captured.title} 삭제된 마일스톤 기준선 ${captured.date}`} style={{ left: (dayNumber(captured.date) - range.start + .5) * dayWidth }} /> : <button className="gantt-jump-date" onClick={() => showDate(captured.date)}>{captured.date} · 기준선 기록으로 이동 →</button>}</div></div>)}
      <button className="gantt-add-inline-row" style={{ width: LEFT_WIDTH }} onClick={() => { if (canLeave()) setCreateOpen(true); }}><Plus size={14} /> 이 간트에 업무 추가</button>
      {issues.length === 0 && <div className="gantt-no-issues" style={{ width: LEFT_WIDTH }}><CalendarDays size={28} /><strong>표시할 업무가 없습니다</strong><span>{ganttViewId === null ? '업무를 만들거나 검색 조건을 변경하세요.' : '공유 보기나 검색 조건을 변경하세요.'}</span></div>}
    </div></div>
    {baseline && <details className="gantt-baseline-records"><summary>기준선 업무 기록 {baseline.issues.length}개 · 캡처된 이름과 날짜 확인</summary><div><table><thead><tr><th>기준선 업무</th><th>시작일</th><th>종료일</th><th>현재 상태</th></tr></thead><tbody>{baseline.issues.map(captured => <tr key={captured.issueId}><td><small>{captured.key}</small><strong>{captured.title}</strong></td><td><button disabled={!captured.startDate} onClick={() => captured.startDate && showDate(captured.startDate)}>{captured.startDate || '미정'}</button></td><td><button disabled={!captured.endDate} onClick={() => captured.endDate && showDate(captured.endDate)}>{captured.endDate || '미정'}</button></td><td>{projectIssues.some(issue => issue.id === captured.issueId) ? '현재 업무 있음' : '삭제된 업무 기록'}</td></tr>)}</tbody></table></div></details>}
    {scheduleWarnings.length > 0 && <div className="gantt-current-warnings" role="status"><AlertCircle size={16} /><div><strong>일정 의존성 확인</strong>{scheduleWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div><button className="issue-icon-button" onClick={() => setScheduleWarnings([])} aria-label="경고 닫기"><X size={14} /></button></div>}
    <div className="gantt-legend"><span><span className="gantt-mini-bar" />계획 일정</span>{hierarchyTrace?.span && <span><span className="gantt-hierarchy-span-key" />하위 업무 범위</span>}<span><span className="gantt-legend-line" />선행 → 후행</span>{conflictingIds.size > 0 && <span><span className="gantt-legend-conflict" />저장 일정 충돌</span>}<span><span className="gantt-legend-today" />오늘</span>{hasProject && <span><Diamond size={12} />마일스톤</span>}{calendarMath && <span><span className="gantt-nonworking-key" />비근무일</span>}{baseline && <span><span className="gantt-baseline-key" />기준선</span>}{analysisResult?.analysis && <span className="gantt-analysis-legend" id="gantt-analysis-critical-help"><span className="gantt-analysis-key" />여유 0근무일</span>}<span className="muted">수기 계획에서는 의존성을 연결해도 날짜가 자동으로 바뀌지 않습니다.</span></div>
    <div className="gantt-bottom-grid"><section className="gantt-bottom-card"><div className="gantt-bottom-heading"><h3><CalendarDays size={16} />일정 미정 <span>{unscheduled.length}</span></h3><span className="muted">시작일과 종료일을 정해주세요</span></div>{unscheduled.length ? unscheduled.map(issue => <div key={issue.id} className="gantt-unscheduled-row">
      <button type="button" onClick={event => openIssueRow(issue.id, event.currentTarget)}><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span className="issue-key">{issue.key}</span><strong>{issue.title}</strong></button>
      <button type="button" className="btn gantt-missing-date-action" aria-label={`${issue.key} 날짜 입력`} data-schedule-owner={issue.id}
        disabled={busy || Boolean(linkPicker || activeDatePicker)} onClick={event => focusDateFromControl(event.currentTarget, issue)}>날짜 입력</button>
      <GanttDatePickerButton issue={issue} className="btn gantt-missing-date-action" disabled={datePickingDisabled} onOpen={startDatePicking} />
      {(linkedIssueIds.has(issue.id) || incomingTeamBlockers.has(issue.id))
        ? <button type="button" className="btn gantt-missing-date-action" disabled={busy || Boolean(linkPicker || activeDatePicker)}
          onClick={event => openRowScheduleEdit(issue, event.currentTarget)}><CalendarRange size={13} aria-hidden="true" />연결 기준으로 일정 제안</button>
        : <button type="button" className="btn btn-ghost" disabled={busy || Boolean(activeDatePicker)}
          onClick={event => completeMissingDates(issue, event.currentTarget)}><Plus size={13} />{issue.startDate || issue.endDate ? '일정 완성' : '오늘부터 3일'}</button>}
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
              <button className="issue-icon-button" type="button" onClick={event => showLinkEditor(event.currentTarget, { dependency })} disabled={busy} aria-label={`${predecessor.key}와 ${successor.key} 연결 수정`} title="연결 수정"><Pencil size={14} /></button>
              <button className="issue-icon-button" type="button" onClick={() => unlink(dependency)} disabled={busy}
                data-gantt-focus-control={scheduleFocus ? '' : undefined} onPointerDown={scheduleFocus ? keepInlineDateFocus : undefined}
                aria-label={`${predecessor.key}와 ${successor.key} 연결 해제`} title="연결 해제"><X size={14} /></button>
            </div>
          </div>
        )) : <div className="gantt-bottom-empty">선행 업무를 연결해 일정의 흐름을 확인하세요.</div>}
      </section>
    </div>
    {preview && !cascade && !teamFollowUp && !teamFollowUpHandoff && <div className="issue-modal-overlay"><section ref={previewDialog} tabIndex={-1} className="gantt-preview-modal" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="schedule-preview-title" onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (hasInlineDateReview && event.key === 'Tab') {
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        const first = controls[0], last = controls[controls.length - 1];
        if (!first || event.target === event.currentTarget || event.target === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
      if ((!hierarchyPreview && !hasInlineDateReview) || busy || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closePreview();
    }}><header><div><span className="feature-eyebrow">REVIEW CHANGES</span><h2 id="schedule-preview-title">일정 변경 미리보기</h2><p>{preview.changes.length}개 업무의 변경 내용을 확인하세요.</p></div><button className="issue-icon-button" onClick={closePreview} disabled={busy} aria-label="미리보기 닫기"><X size={20} /></button></header>
      {canReviewBatchFollowUp && <div className="gantt-batch-follow-up">
        <label><input ref={batchFollowUpOption} type="checkbox" checked={batchFollowUp} disabled={busy || Boolean(manualProblem)}
          aria-describedby="gantt-batch-follow-up-help" onChange={event => void reviewBatchFollowUp(event.currentTarget.checked)} />후행 일정 함께 검토</label>
        <p id="gantt-batch-follow-up-help">입력한 날짜를 기준으로 같은 프로젝트의 후행 일정을 필요한 만큼 늦춥니다.</p>
      </div>}
      <GanttWorkloadPreviewSummary data={data} projectId={projectId} allProjects={allProjects} startDate={isoDay(range.start)} endDate={isoDay(range.end)} preview={preview} />
      {preview.warnings.length > 0 && <div className="gantt-preview-warnings"><AlertCircle size={17} /><div><strong>적용 전에 확인하세요</strong>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
      {(manualProblem || missingHierarchyAnchor || Boolean(preview.blocking?.length)) && <div className="issue-form-error gantt-preview-error" role="alert">
        {missingHierarchyAnchor && (!manualProblem || manualProblem.kind === 'stale') ? '현재 프로젝트에서 상위 업무를 찾을 수 없습니다.'
          : manualProblem ? manualProblem.message : preview.blocking?.map((message, index) => <p key={index}>{message}</p>)}
      </div>}
      <div className="gantt-preview-table">
        <table>
          <thead><tr><th>업무</th><th>현재 일정</th><th /><th>변경할 일정</th></tr></thead>
          <tbody>{preview.changes.map(change => <tr key={change.id}>
            <td>
              <span className="issue-key">{change.key}</span><strong>{change.title}</strong>
              {(adjustedShiftSuccessors?.has(change.id) || batchAnchorIds && !batchAnchorIds.has(change.id)) &&
                <small className="gantt-follow-up-row-label">후행 조정</small>}
            </td>
            <td>{change.fromStart || '미정'}<br />{change.fromEnd || '미정'}</td>
            <td><ArrowRight size={16} /></td>
            <td className="gantt-new-dates">{change.toStart || '미정'}<br />{change.toEnd || '미정'}</td>
          </tr>)}</tbody>
        </table>
        {preview.changes.length === 0 && !manualProblem && !missingHierarchyAnchor && !preview.blocking?.length && <div className="issue-empty">
          {hierarchyPreview ? '이동할 수 있는 일정이 없습니다.' : '이동할 일정이 없습니다. 날짜를 먼저 입력하세요.'}
        </div>}
      </div>
      {Boolean(preview.skipped?.length) && <section className="gantt-preview-skipped" aria-labelledby="gantt-preview-skipped-title">
        <h3 id="gantt-preview-skipped-title">이동에서 제외된 업무</h3>
        <ul>{preview.skipped?.map(issue => <li key={issue.id}>
          <span><span className="issue-key">{issue.key}</span> <strong>{issue.title}</strong></span>
          <span>{issue.reason === 'closed' ? '완료·취소 상태' : '일정 미정'}</span>
        </li>)}</ul>
      </section>}
      <footer><span className="muted">적용 후 마지막 변경을 되돌릴 수 있습니다.</span><button className="btn btn-ghost" onClick={closePreview} disabled={busy}>취소</button>
        {previewCascade && <button ref={cascadePreviewButton} type="button" className="btn" disabled={busy || Boolean(manualProblem) || !preview.previewId} onClick={() => reviewSuccessors({
          id: previewCascade.id, expectedVersion: previewCascade.version, startDate: previewCascade.toStart, endDate: previewCascade.toEnd,
        }, { kind: 'preview' })}>후행 일정 검토</button>}
        {previewTeamFollowUp && <button ref={teamFollowUpPreviewButton} type="button" className="btn"
          disabled={busy || Boolean(manualProblem) || !preview.previewId} onClick={() => {
            const { id, key, title, version, fromStart, fromEnd, toStart, toEnd } = previewTeamFollowUp;
            reviewTeamSuccessors({ id, key, title, version, startDate: fromStart, endDate: fromEnd },
              { id, expectedVersion: version, startDate: toStart, endDate: toEnd }, { kind: 'preview' });
          }}>프로젝트 간 일정 검토</button>}
        {manualProblem?.kind === 'stale' && !missingHierarchyAnchor && <button ref={manualReviewAction} type="button" className="btn" disabled={busy} onClick={() => void reviewManualAgain()}>다시 미리보기</button>}
        {manualProblem?.kind === 'uncertain'
          ? <button ref={manualReviewAction} type="button" className="btn btn-primary" disabled={busy}
            onClick={() => void applyManualReview()}>{busy ? '확인 중…' : '적용 결과 다시 확인'}</button>
          : <button type="button" className="btn btn-primary" disabled={busy || Boolean(manualProblem) || missingHierarchyAnchor || !preview.previewId}
            onClick={() => void applyManualReview()}><Check size={16} />{busy ? '적용 중…' : '변경 적용'}</button>}
      </footer></section></div>}
    {cascade && <GanttCascadeDialog projectId={cascade.projectId} anchorChange={cascade.anchorChange} actorId={props.actorId} undoScope={undoScope}
      onClose={closeCascade} onApplied={applyCascade} onBusyChange={markBusy} />}
    {autoOpen && automaticProjectId && !automaticNeedsSelection && <AutomaticScheduleDialog {...props} undoScope={undoScope}
      projectId={automaticProjectId} selectedIssueIds={automaticScheduleIssues.map(issue => issue.id)} onClose={() => setAutoOpen(false)}
      onApplied={async result => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings || []);
        await refresh();
        setAutoOpen(false);
        focusAfterCompletingMissingRows(result.updated);
        notify(`${result.updated.length}개 업무에 자동 일정 제안을 적용했습니다.`);
      }} />}
    {schedulePasteTarget && <SchedulePasteDialog
      key={bulkDateIssues ? 'bulk-dates' : 'paste'}
      {...schedulePasteTarget}
      actorId={props.actorId} undoScope={undoScope}
      notify={notify} onDraftChange={trackDraft}
      onClose={awaitingResult => {
        if (bulkDateIssues) closeBulkDates();
        else closeSchedulePaste();
        if (awaitingResult) void refresh().catch(() => notify('간트 목록을 불러오지 못했습니다. 화면을 다시 열어 확인해 주세요.', 'error'));
      }}
      onApplied={async result => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        if (bulkDateIssues) {
          closeBulkDates(result.updated);
          notify(bulkDateResultMessage(result.updated, allProjects));
          return;
        }
        closeSchedulePaste(result.updated);
        const changes = [];
        if (result.updated.length) changes.push(`업무 일정 ${result.updated.length}건`);
        if (result.dependencyChanges) changes.push(`선후행 연결 ${result.dependencyChanges}건`);
        notify(`${changes.join(' · ')}을 변경했습니다.`);
      }}
    />}
    {linkEditor && <GanttDependencyModal key={editingDependency?.id ?? draftEpoch}
      issues={editingDependency || linkEditor.prefill || linkEditor.anchor ? projectIssues : scopedIssues} issueAliases={data.issueAliases}
      dependency={editingDependency} prefill={linkEditor.prefill} anchor={linkEditor.anchor} busy={busy}
      staleMessage={staleDependencyMessage} onDraftChange={trackDraft} onClose={cancelLinkEditor} onSubmit={saveDependency} />}
    {planAssignment && <GanttPlanAssignment {...planAssignment} data={data} actorId={props.actorId} refresh={refresh} onDraftChange={trackDraft}
      onClose={() => { if (canLeave()) setPlanAssignment(null); }}
      onApplied={updated => setSelected(previous => {
        const next = new Set(previous);
        updated.forEach(issue => next.delete(issue.id));
        return next;
      })} />}
    {shiftPlan && <PlanScheduleShiftDialog plan={shiftPlan} actorId={props.actorId} undoScope={undoScope} refresh={refresh} notify={notify} onDraftChange={trackDraft}
      onClose={() => setPlanShift(null)} onApplied={async result => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        const date = result.plan.startDate ?? result.plan.targetDate ?? result.plan.endDate;
        if (date && outside(date)) showDate(date);
        setPlanShift(null);
        notify(result.updated.length ? `계획과 ${result.updated.length}개 업무의 일정을 이동했습니다.` : '계획 일정을 이동했습니다.');
      }} />}
  </div>
    {rowScheduleEdit && <GanttRowScheduleEdit key={rowScheduleEdit.issue.id}
      issue={rowScheduleEdit.issue} issues={rowEditIssues} issueAliases={data.issueAliases}
      incomingTeamBlockers={incomingTeamBlockers.get(rowScheduleEdit.issue.id)}
      relatedIncomingTeamBlockers={rowScheduleEdit.relatedInlineDraft && incomingTeamBlockers.get(rowScheduleEdit.relatedInlineDraft.source.id)}
      outgoingTeamBlockers={teamBlockerChoices.get(rowScheduleEdit.issue.id)}
      dependencies={data.dependencies} calendar={rowEditCalendar} focusDate={rowScheduleEdit.focusDate}
      initialDates={rowScheduleEdit.initialDates} initialDateDraft={rowScheduleEdit.inlineDraft?.source}
      initialRelatedDates={rowScheduleEdit.relatedInlineDraft && { source: rowScheduleEdit.relatedInlineDraft.source,
        changes: changedInlineDates(rowScheduleEdit.relatedInlineDraft) }}
      initialLink={rowScheduleEdit.initialLink} otherDateDrafts={rowScheduleEdit.otherDateDrafts}
      actorId={props.actorId} undoScope={undoScope} notify={notify} refresh={refresh} onDraftChange={trackDraft} onClose={closeRowScheduleEdit}
      onApplied={async (result, reviewedAnchorVersion, reviewedRelatedIssue) => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings);
        const reviewedRows = [{ id: rowScheduleEdit.issue.id, expectedVersion: reviewedAnchorVersion }, reviewedRelatedIssue];
        for (const row of reviewedRows) {
          if (!row) continue;
          const draft = inlineDateDrafts.current.get(row.id);
          const original = row.id === rowScheduleEdit.issue.id ? rowScheduleEdit.inlineDraft : rowScheduleEdit.relatedInlineDraft;
          if (!draft || draft.owner !== original?.owner) continue;
          const saved = result.updated.find(issue => issue.id === row.id)
            ?? rowEditIssues.find(issue => issue.id === row.id && issue.version === row.expectedVersion);
          if (saved) draft.accept(saved);
        }
        await refresh();
        closeRowScheduleEdit(result.updated);
        const datesChanged = result.updated.length > 0;
        const linksChanged = Boolean(result.dependencyChanges);
        notify(datesChanged && linksChanged ? '업무 일정과 선후행 연결을 변경했습니다.'
          : datesChanged ? '업무 일정을 변경했습니다.' : '선후행 연결을 변경했습니다.');
      }} />}
    {bulkLinkSelection && <SchedulePasteDialog
      actorId={props.actorId} undoScope={undoScope}
      projectId={bulkLinkSelection.project.id} projectLabel={`${bulkLinkSelection.project.key} · ${bulkLinkSelection.project.name}`}
      bulkLinks={{
        issues: bulkLinkSelection.issues.map(original => projectIssues.find(issue => issue.id === original.id) ?? original),
        candidates: projectIssues.filter(issue => issue.projectId === bulkLinkSelection.project.id),
        dateDrafts: bulkLinkSelection.dateDrafts,
        issueAliases: data.issueAliases,
        refresh,
      }}
      notify={notify} onDraftChange={trackDraft} onClose={() => closeBulkLinks()}
      onApplied={async (result, followUpIssueIds) => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings);
        const adjusted = new Set(followUpIssueIds);
        for (const saved of result.updated) {
          if (adjusted.has(saved.id)) continue;
          const draft = bulkLinkSelection.dateDrafts.find(candidate => candidate.source.id === saved.id);
          const capturedDatesSaved = draft && (['startDate', 'endDate'] as const).every(field =>
            !Object.hasOwn(draft.changes, field) || saved[field] === draft.changes[field]);
          if (capturedDatesSaved) acceptChartDateDraft(saved, draft);
        }
        await refresh();
        closeBulkLinks(result.updated);
        const dates = result.updated.length, links = result.dependencyChanges ?? 0;
        notify(dates && links ? `${dates}개 업무의 날짜와 선후행 연결 ${links}건을 저장했습니다.`
          : dates ? bulkDateResultMessage(result.updated, false) : `선후행 연결 ${links}건을 추가했습니다.`);
      }}
    />}
    {blockerLinksScope && <SchedulePasteDialog
      actorId={props.actorId} undoScope={undoScope}
      projectId={blockerLinksScope === 'team' ? null : blockerLinksScope.id}
      projectLabel={blockerLinksScope === 'team' ? undefined : `${blockerLinksScope.key} · ${blockerLinksScope.name}`}
      blockerLinks={{ issues: blockerLinksScope === 'team' ? projectIssues : projectIssues.filter(issue => issue.projectId === blockerLinksScope.id),
        projects: blockerLinksScope === 'team' ? data.projects : undefined, dependencies: data.dependencies, refresh }}
      notify={notify} onDraftChange={trackDraft} onClose={closeBlockerLinks}
      onApplied={async result => {
        rememberUndo(result.undoId);
        setScheduleWarnings(result.warnings);
        await refresh();
        closeBlockerLinks();
        notify(`선후행 연결 ${result.dependencyChanges ?? 0}건을 추가했습니다.`);
      }}
    />}
    {scheduleIssueCreation && <NewIssueModal {...props} scheduleLink={scheduleIssueCreation.link} onClose={closeScheduleIssueCreation} />}
    {blockedIssueCreation && <NewIssueModal {...props} blockedByIssue={blockedIssueCreation.issue} onClose={closeBlockedIssueCreation}
      onBlockedIssueCreated={({ id, key }) => setCreatedBlockedIssue({ id, key })} />}
    {teamFollowUpHandoff && <GanttTeamFollowUpChooser source={teamFollowUpHandoff.source} choices={teamFollowUpHandoff.choices}
      projects={data.projects} onChoose={choices => openTeamFollowUpChoices(teamFollowUpHandoff, choices)} onClose={closeTeamFollowUp} />}
    {teamFollowUp && <GanttCascadeDialog teamFollowUp={teamFollowUp} projects={data.projects} actorId={props.actorId} undoScope={undoScope}
      onClose={closeTeamFollowUp} onApplied={applyTeamFollowUp} onBusyChange={markBusy} onOutcomeUnknownChange={trackTeamFollowUpOutcome} />}
  </>;
}

function GanttDatePickerButton({ issue, className, iconOnly = false, disabled, onOpen }: {
  issue: Issue;
  className: string;
  iconOnly?: boolean;
  disabled: boolean;
  onOpen: (issue: Issue, opener: HTMLButtonElement) => void;
}) {
  const label = '차트에서 날짜 선택';
  return <button type="button" className={className} aria-label={`${issue.key} ${label}`} title={iconOnly ? label : undefined}
    data-date-picker-issue={issue.id} data-schedule-owner={issue.id} disabled={disabled}
    onPointerDown={event => {
      if (event.button === 0 && document.activeElement?.matches('input[data-schedule-edge]')) event.preventDefault();
    }} onClick={event => onOpen(issue, event.currentTarget)}>
    <CalendarRange size={iconOnly ? 16 : 13} aria-hidden="true" />{!iconOnly && label}
  </button>;
}

function GanttResizeHandle({ issue, edge, disabled, onBegin, onMove, onFinish, onCancel, onResize, onFocusDate }: {
  issue: Issue;
  edge: 'start' | 'end';
  disabled: boolean;
  onBegin: (event: PointerEvent<HTMLButtonElement>, issue: Issue, edge: 'start' | 'end') => void;
  onMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onFinish: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancel: () => void;
  onResize: (issue: Issue, edge: 'start' | 'end', delta: number, opener: HTMLButtonElement) => void;
  onFocusDate: (opener: HTMLButtonElement, issue: Issue, edge: 'start' | 'end') => void;
}) {
  const label = edge === 'start' ? '시작일' : '종료일';
  return <button type="button" className={`gantt-resize-handle is-${edge}`} disabled={disabled}
    aria-label={`${issue.key} ${label} 조정`} aria-describedby="gantt-editing-help"
    title={`${label} 조정 · 드래그 또는 좌우 방향키 · Enter로 날짜 입력`}
    onPointerDown={event => onBegin(event, issue, edge)} onPointerMove={onMove} onPointerUp={onFinish} onPointerCancel={onCancel}
    onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      onResize(issue, edge, event.key === 'ArrowRight' ? 1 : -1, event.currentTarget);
    }} onClick={event => { if (event.detail === 0) onFocusDate(event.currentTarget, issue, edge); }}><span /></button>;
}

function GanttConnector({ dependency, predecessor, successor, range, dayWidth, drag, critical, conflict }: {
  dependency: Dependency; predecessor: IssueRow; successor: IssueRow;
  range: TimelineRange; dayWidth: number; drag: DragState | null; critical: boolean; conflict: boolean;
}) {
  const type = dependency.type ?? 'FS';
  if (!isDependencyType(type)) return null;
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
  const connector = conflict
    ? { color: 'var(--gantt-dependency-conflict)', width: 2, dash: '5 3', marker: 'gantt-arrow-conflict' }
    : critical ? { color: 'var(--gantt-analysis-accent)', width: 2, marker: 'gantt-arrow-analysis' }
      : { color: '#8a9b9b', width: 1.3, dash: '3 3', marker: 'gantt-arrow' };
  return <path
    data-dependency-id={dependency.id}
    data-analysis-critical={critical || undefined}
    data-dependency-conflict={conflict || undefined}
    data-dependency-type={type}
    data-predecessor-anchor={endpoints.predecessor}
    data-successor-anchor={endpoints.successor}
    d={`M${from.x},${from.y} H${from.bend} V${middleY} H${to.bend} V${to.y} H${to.x}`}
    fill="none" stroke={connector.color} strokeWidth={connector.width}
    strokeDasharray={connector.dash} markerEnd={`url(#${connector.marker})`}
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

function InlineIssueForm({ data, projectId, chooseProject, actorId, projects, users, sharedViewActive, initialPlan, onClose, onCreated, onDraftChange }: Pick<FeatureProps, 'data' | 'projectId' | 'actorId'> & {
  chooseProject: boolean; projects: Project[]; users: User[]; sharedViewActive: boolean; initialPlan?: PlanningItem;
  onClose: () => void; onCreated: (issue: Issue) => Promise<void>; onDraftChange: TrackDraft;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState(() => initialIssueType(data, projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || ''));
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>({});
  const [assigneeId, setAssigneeId] = useState('');
  const [reporterId, setReporterId] = useState<Issue['reporterId']>();
  const [selectedProject, setSelectedProject] = useState(projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || '');
  const [plansByProject, setPlansByProject] = useState<Record<string, Partial<Record<PlanningKind, string | null>>>>(() =>
    initialPlan ? { [initialPlan.projectId]: { [initialPlan.kind]:initialPlan.id } } : {});
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [recovery, setRecovery] = useState<'check' | 'refresh' | 'stopped' | null>(null);
  const attempt = useRef<IssueCreationAttempt | null>(null);
  const pending = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => onDraftChange(CREATE_ISSUE_DRAFT, false), [onDraftChange]);
  useEffect(() => {
    if (saving || !recovery) return;
    (recovery === 'stopped' ? cancelButton : submitButton).current?.focus();
  }, [recovery, saving]);
  const customFields = valuesByProject[selectedProject] || {};
  const calendar = data.calendars?.find(value => value.projectId === selectedProject);
  const calendarMath = useMemo(() => selectedProject ? createCalendarMath(calendar ?? defaultWorkCalendar(selectedProject)) : null,
    [calendar, selectedProject]);
  const initialStatus = projectWorkflow(data,selectedProject).initialStatusId;
  const required = requiredFieldsFor(data,selectedProject,type,initialStatus);
  const extraFields = required.filter(field => !field.startsWith('custom:') && !['title','assigneeId','startDate','endDate','cycle','module','release'].includes(field));
  const noteChange = () => { if (!pending.current && !recovery) onDraftChange(CREATE_ISSUE_DRAFT, true); };
  const fieldsLocked = saving || recovery !== null;
  function applyCalculatedDates(dates: { startDate: string; endDate: string }) {
    if (pending.current || fieldsLocked || !selectedProject) return;
    setStartDate(dates.startDate);
    setEndDate(dates.endDate);
    noteChange();
  }
  function creationInput(form: FormData) {
    return {
      projectId: selectedProject, title: title.trim(), type, status: initialStatus, assigneeId: assigneeId || null,
      ...(reporterId !== undefined ? { reporterId } : {}),
      startDate: startDate || null, endDate: endDate || null, description: form.get('description') || '',
      collaboratorIds: form.getAll('collaboratorIds'), dueDate: form.get('dueDate') || null,
      estimate: form.get('estimate') ? Number(form.get('estimate')) : null,
      plannedEffortMinutes: form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null,
      labels: String(form.get('labels') || '').split(',').map(value => value.trim()).filter(Boolean),
      parentId: form.get('parentId') || null, cycleId: form.get('cycleId') || null, moduleId: form.get('moduleId') || null,
      releaseId: form.get('releaseId') || null, customFields,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !selectedProject || recovery === 'stopped') return;
    const previousAttempt = attempt.current;
    if (!previousAttempt && startDate && endDate && startDate > endDate) {
      setError('종료일은 시작일보다 빠를 수 없습니다. 입력한 날짜를 확인하세요.');
      return;
    }
    if (!previousAttempt && !title.trim()) { setError('업무 제목을 입력하세요.'); return; }
    pending.current = true;
    setSaving(true);
    setError('');
    onDraftChange(CREATE_ISSUE_DRAFT, true, true, Boolean(previousAttempt));
    let confirmed: Issue | undefined;
    let completed = false;
    try {
      const request = previousAttempt ?? createIssueAttempt(actorId, creationInput(new FormData(event.currentTarget)));
      attempt.current = request;
      confirmed = await requestIssueCreation(request, selectedProject);
      await onCreated(confirmed);
      completed = true;
      attempt.current = null;
    } catch (cause) {
      if (confirmed) {
        setRecovery('refresh');
        setError(`${confirmed.key} 업무를 추가했습니다. 간트 목록을 다시 불러와 확인해 주세요.`);
      } else if (!attempt.current || isDefiniteIssueCreationFailure(cause, Boolean(previousAttempt))) {
        if (previousAttempt) {
          setRecovery('stopped');
          setError(`${errorMessage(cause)} 간트 목록에서 결과를 확인해 주세요.`);
        } else {
          attempt.current = null;
          setError(errorMessage(cause));
        }
      } else {
        setRecovery('check');
        setError('업무 추가 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
      }
    } finally {
      pending.current = false;
      setSaving(false);
      onDraftChange(CREATE_ISSUE_DRAFT, !completed, false, Boolean(attempt.current));
    }
  }
  return <form className="gantt-inline-create" aria-label="간트에서 업무 만들기" onSubmit={submit} onChange={noteChange} aria-busy={saving}>
    <div className="gantt-inline-create-heading"><div><strong><Plus size={15} /> 간트에 업무 추가</strong><span>{sharedViewActive ? '공유 보기 조건에 맞는 업무가 이 간트에 표시됩니다.' : '날짜는 나중에 정해도 괜찮아요. 저장하면 같은 간트에 표시됩니다.'}</span></div><button className="issue-icon-button" type="button" onClick={onClose} disabled={saving} aria-label="간트 업무 추가 닫기"><X size={17} /></button></div>
    <fieldset disabled={fieldsLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="gantt-create-fields">
        <label className="issue-form-label gantt-create-title">업무 제목<input autoFocus aria-label="추가할 업무 제목" className="field" placeholder="해야 할 일을 입력하세요" value={title} onChange={event => setTitle(event.target.value)} required maxLength={300} /></label>
        <label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={type} onChange={setType} ariaLabel="추가할 업무 유형" /></label>
        <label className="issue-form-label">담당자<select aria-label="추가할 업무 담당자" className="field" value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">미지정</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label className="issue-form-label">시작일<input aria-label="추가할 업무 시작일" className="field" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
        <label className="issue-form-label">종료일<input aria-label="추가할 업무 종료일" className="field" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
        {chooseProject && <label className="issue-form-label">프로젝트<select aria-label="추가할 업무 프로젝트" className="field" value={selectedProject} onChange={event => { setSelectedProject(event.target.value); setType(initialIssueType(data, event.target.value)); }} required>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        <label className="issue-form-label">요청자<IssueReporterSelect value={reporterId === undefined ? actorId || undefined : reporterId}
          users={users} ariaLabel="추가할 업무 요청자" onChange={value => setReporterId(value === actorId ? undefined : value)} /></label>
        {calendarMath && <div className="issue-grid-wide"><WorkingDayRangePicker calendarMath={calendarMath} startDate={startDate || null} endDate={endDate || null}
          onApply={applyCalculatedDates} disabled={fieldsLocked} /></div>}
      </div>
      <div className="issue-form-grid">
        <label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} /></label>
        {PLANNING_KINDS.map(kind => <label key={kind} className="issue-form-label">{PLAN_LABELS[kind]}
        <PlanningSelect data={data} projectId={selectedProject} kind={kind} ariaLabel={`추가할 업무 ${PLAN_LABELS[kind]}`}
          value={plansByProject[selectedProject]?.[kind] ?? null} onChange={id => setPlansByProject(previous => ({ ...previous, [selectedProject]:{ ...previous[selectedProject], [kind]:id } }))} />
      </label>)}</div>
      <CustomFields data={data} projectId={selectedProject} issueType={type} status={initialStatus} values={customFields} onChange={next => { noteChange(); setValuesByProject(previous => ({ ...previous, [selectedProject]: next })); }} requiredFields={required} labelPrefix="추가할 업무 " />
      {required.length > 0 && <p className="issue-section-empty">기본 상태의 필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
      {extraFields.length > 0 && <div className="issue-form-grid">{extraFields.map(field=><label key={field} className="issue-form-label">{REQUIRED_FIELD_LABELS[field]}{field === 'description' ? <textarea className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} rows={3}/> : field === 'parentId' ? <select className="field" name={field} aria-label="추가할 업무 상위 업무"><option value="">없음</option>{data.issues.filter(issue=>issue.projectId===selectedProject).map(issue=><option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select> : field === 'collaboratorIds' ? <select className="field" name={field} aria-label="추가할 업무 참여자" multiple>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select> : <input className="field" name={field} aria-label={`추가할 업무 ${REQUIRED_FIELD_LABELS[field]}`} type={field === 'dueDate'?'date':field==='estimate'?'number':'text'} min={field==='estimate'?0:undefined} step={field==='estimate'?'0.5':undefined} placeholder={field==='labels'?'쉼표로 구분':undefined}/>}</label>)}</div>}
    </fieldset>
    {error && <div className="issue-form-error" role="alert">{error}</div>}
    <div className="gantt-inline-create-footer">
      {!recovery && <small>시작일·종료일은 선택 사항입니다.</small>}
      <button ref={cancelButton} className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>취소</button>
      {recovery !== 'stopped' && <button ref={submitButton} className="btn btn-primary" type="submit" disabled={saving || !selectedProject}>
        {!recovery && <Plus size={14} />}{saving ? recovery ? '확인 중…' : '추가 중…' : recovery === 'refresh' ? '간트 목록 다시 불러오기' : recovery === 'check' ? '업무 추가 결과 다시 확인' : '간트에 추가'}
      </button>}
    </div>
  </form>;
}

function DateCells({ issue, recovered, onSave, onReview, onReviewTeam, disabled, onDraftChange, onInlineDraftChange }: {
  issue: Issue;
  recovered?: StoredGanttDateDraft;
  onSave: (source: Issue, start: string | null, end: string | null, origin: InlineScheduleOrigin) => Promise<void>;
  onReview?: (anchor: CascadeAnchorChange, origin: Extract<CascadeOrigin, { kind: 'inline' }>) => void;
  onReviewTeam?: (source: Issue, anchor: CascadeAnchorChange, origin: Extract<CascadeOrigin, { kind: 'inline' }>) => void;
  disabled: boolean;
  onDraftChange: TrackDraft;
  onInlineDraftChange: (id: string, draft: InlineDateDraft | null, owner: symbol, detached?: boolean) => void;
}) {
  const [source, setSource] = useState(() => recovered
    ? { ...issue, version: recovered.version, startDate: recovered.startDate, endDate: recovered.endDate } : issue);
  const [start, setStart] = useState((recovered ? recovered.draftStart : issue.startDate) ?? '');
  const [end, setEnd] = useState((recovered ? recovered.draftEnd : issue.endDate) ?? '');
  const [owner] = useState(() => Symbol());
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const draftId = `dates:${issue.id}`;
  const dirty = start !== (source.startDate || '') || end !== (source.endDate || '');
  const conflict = issue.version > source.version && dirty;
  if (issue.version > source.version && !dirty && !pending) { setSource(issue); setStart(issue.startDate || ''); setEnd(issue.endDate || ''); }
  const accept = useCallback((saved: Issue) => {
    onInlineDraftChange(issue.id, null, owner);
    setSource(saved);
    setStart(saved.startDate || '');
    setEnd(saved.endDate || '');
  }, [issue.id, onInlineDraftChange, owner]);
  useLayoutEffect(() => {
    onDraftChange(draftId, dirty, pending);
    onInlineDraftChange(issue.id, dirty ? { source, startDate: start || null, endDate: end || null, accept, owner } : null, owner);
  }, [onDraftChange, onInlineDraftChange, draftId, issue.id, dirty, pending, source, start, end, accept, owner]);
  useLayoutEffect(() => () => {
    onDraftChange(draftId, false);
    onInlineDraftChange(issue.id, null, owner, true);
  }, [onDraftChange, onInlineDraftChange, draftId, issue.id, owner]);

  const editedField = start !== (source.startDate || '') ? startField : endField;
  function reset(restoreField = false) {
    if (pendingRef.current) return;
    if (restoreField) editedField.current?.focus({ preventScroll: true });
    accept(issue);
  }
  async function commit(opener: HTMLInputElement | HTMLButtonElement) {
    if (disabled || pendingRef.current || !dirty) return;
    const focusTarget = opener instanceof HTMLInputElement ? opener : editedField.current;
    pendingRef.current = true;
    setPending(true);
    onDraftChange(draftId, true, true);
    try {
      await onSave(source, start || null, end || null, {
        issueId: issue.id, accept, returnToMissingRow: true, focus: opener,
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if ((active === document.body || active === opener) && focusTarget?.isConnected && !focusTarget.disabled) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    }
  }
  const title = conflict ? '일정과 연결 편집에서 저장값과 입력을 비교하세요. Esc로 최신 날짜 불러오기' : 'Enter로 저장 · Esc로 최신 날짜 불러오기';
  function dateInput(edge: 'start' | 'end') {
    return <input ref={edge === 'start' ? startField : endField}
      className={`gantt-inline-date ${conflict ? 'has-conflict' : ''}`} type="date" title={title}
      data-schedule-owner={issue.id} data-schedule-edge={edge}
      aria-describedby="gantt-editing-help" aria-invalid={conflict || undefined}
      aria-label={`${issue.key} ${edge === 'start' ? '시작일' : '종료일'}`}
      value={edge === 'start' ? start : end} disabled={disabled || pending}
      onChange={event => edge === 'start' ? setStart(event.target.value) : setEnd(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); reset(); }
        else if (event.key === 'Enter') { event.preventDefault(); void commit(event.currentTarget); }
      }} />;
  }
  return <div className="gantt-inline-date-controls">
    {dateInput('start')}
    {dateInput('end')}
    {dirty && <div className="gantt-inline-draft-actions">
      <button type="button" className="gantt-inline-save" aria-label={`${issue.key} 날짜 저장`} disabled={disabled || pending}
        onClick={event => void commit(event.currentTarget)}>저장</button>
      <button type="button" aria-label={`${issue.key} 날짜 변경 취소`} disabled={disabled || pending}
        onClick={() => reset(true)}>취소</button>
      {onReview && !conflict && (!start || !end || start <= end) && <button type="button"
        aria-label={`${issue.key} 후행 일정 검토`} title="후행 일정 검토" disabled={disabled || pending}
        onClick={event => onReview({ id: source.id, expectedVersion: source.version, startDate: start || null, endDate: end || null },
          { kind: 'inline', opener: event.currentTarget, accept })}>{onReviewTeam ? '후행 검토' : '후행 일정 검토'}</button>}
      {onReviewTeam && (!start || !end || start <= end) && <button type="button"
        aria-label={`${issue.key} 프로젝트 간 일정 검토`} title="프로젝트 간 일정 검토" disabled={disabled || pending}
        onClick={event => onReviewTeam(source, { id: source.id, expectedVersion: source.version, startDate: start || null, endDate: end || null },
          { kind: 'inline', opener: event.currentTarget, accept })}>{onReview && !conflict ? '프로젝트 간 검토' : '프로젝트 간 일정 검토'}</button>}
    </div>}
  </div>;
}
