'use client';

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { ArrowRight, CalendarRange, Check, ChevronLeft, ChevronRight, Clock3, Copy, Eye, FileText, Flag, FolderInput, Link2, MessageSquare, Pencil, Plus, Save, SquareChartGantt, Trash2, Undo2, X } from 'lucide-react';
import { PRIORITY, type AutomationRun, type Comment, type Dependency, type DocPage, type FeatureProps, type GitlabStatusSuggestion, type Issue, type IssueCommentView, type IssueRelation, type LinkedDocumentCreationResult, type ResourceLink, type ScheduleBulkDateChanges, type SchedulePasteApplyResult, type ScheduleUndoScope, type WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError, patch, post, relativeTime, remove } from '../lib/api';
import { allowedNextStatuses, projectWorkflow, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { IssueTypeIcon } from './Issues';
import { PlanningSelect } from './PlanningSelectors';
import { issueTypeMeta, requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { findIssueDocumentReferences } from '../../shared/document-references';
import { issueSearchAliasLabel, issueSearchAliases } from '../../shared/workspace-search';
import type { IssueRelationScheduleMode } from '../../shared/issue-relations';
import { CustomFields, IssueTypeSelect } from './CustomFields';
import { NewIssueModal, type ScheduleIssueLink } from './NewIssueModal';
import { SourceOrigins } from './SourceOrigins';
import { JiraDeadlineRecovery } from './JiraDeadlineRecovery';
import { JiraOriginalCommentLinks } from './JiraOriginalCommentLinks';
import { IssueRelations, type IssueRelationsHandle } from './IssueRelations';
import { Attachments } from './Attachments';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { CommentMentionInput, commentDraftPayload, emptyCommentDraft } from './CommentMentions';
import { CommentEditBody, CommentEditButton, CommentEditedMark, useCommentEditing } from './CommentEdit';
import { IssueWorklogs } from './IssueWorklogs';
import { TimeReservations } from './TimeReservations';
import { IssueGitlabActivity } from './IssueGitlabActivity';
import { IssueDescriptionEditor } from './IssueDescriptionEditor';
import { IssueAutomationHistory } from './IssueAutomationHistory';
import { IssueChangeHistory } from './IssueChangeHistory';
import { IssueJiraStatusHistory } from './IssueJiraStatusHistory';
import { IssueDocumentPreview } from './IssueDocumentPreview';
import { IssueLinkedDocumentCreate } from './IssueLinkedDocumentCreate';
import { IssueProjectMove } from './IssueProjectMove';
import { IssueReporterSelect } from './IssueReporterSelect';
import { ResourceLinkPicker } from './ResourceLinkPicker';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { FavoriteAction } from './FavoritesState';
import { AtlassianLinks } from './AtlassianLinks';
import type { IssueReviewDirection, IssueReviewPosition } from '../lib/issue-review';
import { afterAcceptedNavigation } from '../lib/navigation';
import { useScheduleUndo } from './schedule-undo';
import { dependencyLabel, errorMessage } from './schedule-utils';
import { GanttDependencyModal, type DependencyInput, type RelatedIssueDirection } from './GanttDependencyModal';
import { GanttRowScheduleEdit } from './GanttRowScheduleEdit';
import type { GanttIssueDateDrafts, StoredGanttDateDraft } from './gantt-date-draft-storage';
import { GanttCascadeDialog, type TeamFollowUpSelection } from './GanttCascadeDialog';
import { GanttTeamFollowUpChooser, type TeamFollowUpChoice } from './GanttTeamFollowUpChooser';
import { groupActiveTeamBlockers } from './team-follow-up-choices';
import type { ScheduleApplyResult } from './AutomaticScheduleDialog';
import './issues.css';
import './issue-decision-source.css';
import './issue-review.css';

const DocumentDecisionRevision = lazy(() => import('./DocumentBlocks').then(module => ({ default: module.DocumentDecisionRevision })));
type RelationScheduleReview = { relation: IssueRelation; mode: IssueRelationScheduleMode; reload: () => Promise<void> };
type IssueDependencyEditor =
  | { otherRole: RelatedIssueDirection; dependency?: Dependency; review?: never }
  | { otherRole?: never; dependency?: never; review: RelationScheduleReview };
type ChildDraft = { dirty: boolean; pending: boolean; discard: () => void; label?: string };
type IssueEditError = { message: string; openBlockers?: boolean };
const scheduleDateFields = ['startDate', 'endDate', 'dueDate'] as const;
type ScheduleDraftFields = 'none' | 'due-date' | 'all';
type TicketTeamFollowUp = Omit<TeamFollowUpSelection, 'source'> & { source: Issue; choosing: boolean };
type IssuePanelProps = FeatureProps & {
  issueId: string;
  documentOverlay?: boolean;
  modalFocus?: boolean;
  previewDocumentId: string | null;
  commentFocus?: { commentId: string; activation: number };
  reviewPosition?: IssueReviewPosition;
  ganttDateDraftsRef?: RefObject<GanttIssueDateDrafts | null>;
  onAdvanceReview?: (direction: IssueReviewDirection) => void;
  onClose: () => void;
  onOpenIssueSchedule: (id: string) => boolean;
  onOpenMilestone: (id: string) => boolean;
  onPreviewDocument: (id: string) => boolean;
  onCloseDocumentPreview: () => boolean;
};

function editableIssue(issue: Issue, labels: string) {
  return { title: issue.title.trim(), description: issue.description, descriptionFormat: issue.descriptionFormat ?? 'plain', type: issue.type, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId, reporterId: issue.reporterId, collaboratorIds: issue.collaboratorIds, parentId: issue.parentId, labels: [...new Set(labels.split(',').map(value => value.trim()).filter(Boolean))], startDate: issue.startDate, endDate: issue.endDate, dueDate: issue.dueDate, estimate: issue.estimate, plannedEffortMinutes: issue.plannedEffortMinutes ?? null, cycleId: issue.cycleId ?? null, moduleId: issue.moduleId ?? null, releaseId: issue.releaseId ?? null, customFields: issue.customFields || {} };
}

type IssueInputField = keyof ReturnType<typeof editableIssue>;
const pairedIssueInputFields = [
  ['description', 'descriptionFormat'],
  ['type', 'status', 'customFields'],
] as const satisfies readonly (readonly IssueInputField[])[];
const groupedIssueInputFields = new Set<IssueInputField>([...scheduleDateFields, ...pairedIssueInputFields.flat()]);

function equalIssueInput(left: unknown, right: unknown) {
  // Custom fields contain a map of scalar or list values. The map's key order carries no edit intent.
  const comparable = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : value;
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function mergeIssueFieldsAfterSchedule(base: Issue, draft: Issue, labels: string, saved: Issue) {
  const before = editableIssue(base, base.labels.join(', '));
  const local = editableIssue(draft, labels);
  const latest = editableIssue(saved, saved.labels.join(', '));
  const fields = Object.keys(before) as IssueInputField[];
  const groups = [...pairedIssueInputFields, ...fields.filter(field => !groupedIssueInputFields.has(field)).map(field => [field])];
  const next: Issue = { ...saved };
  let nextLabels = saved.labels.join(', ');
  function keepLocal<K extends IssueInputField>(field: K) {
    next[field] = draft[field];
    if (field === 'labels') nextLabels = labels;
    if (field === 'cycleId') next.cycle = draft.cycle;
    if (field === 'moduleId') next.module = draft.module;
    if (field === 'releaseId') next.release = draft.release;
  }
  for (const group of groups) {
    if (group.every(field => equalIssueInput(before[field], local[field]))) continue;
    if (group.every(field => equalIssueInput(local[field], latest[field]))) continue;
    if (group.some(field => !equalIssueInput(before[field], latest[field]))) return null;
    for (const field of group) keepLocal(field);
  }
  return { draft: next, labels: nextLabels };
}

function isOpenBlockerError(cause: unknown) {
  return cause instanceof ApiError && cause.status === 422 && cause.details !== null &&
    typeof cause.details === 'object' && 'reason' in cause.details && cause.details.reason === 'open_issue_blockers';
}

function isStaleGitlabStatusSuggestion(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 409 && cause.details !== null &&
    typeof cause.details === 'object' && 'reason' in cause.details && cause.details.reason === 'gitlab_status_suggestion_stale';
}

export function IssuePanel(props: IssuePanelProps) {
  const panel = <IssuePanelContent key={JSON.stringify([props.issueId, props.actorId, props.data.restoreGeneration])} {...props} />;
  return props.documentOverlay ? <div className="issue-panel-document-layer">{panel}</div> : panel;
}

function IssuePanelContent(props: IssuePanelProps) {
  const { data, issueId, documentOverlay, modalFocus, previewDocumentId, commentFocus, onClose, onOpenIssueSchedule, onOpenMilestone, onPreviewDocument, onCloseDocumentPreview,
    reviewPosition, onAdvanceReview, refresh, notify, openIssue, openDocument } = props;
  const manageFocus = Boolean(documentOverlay || modalFocus);
  const issue = data.issues.find(i => i.id === issueId);
  const linkedMilestones = useMemo(() => (data.milestones ?? [])
    .filter(item => item.projectId === issue?.projectId && item.issueIds.includes(issueId))
    .sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, 'ko')),
  [data.milestones, issue?.projectId, issueId]);
  const previewDocument = previewDocumentId ? data.documents.find(doc => doc.id === previewDocumentId) : undefined;
  const bodyReferences = useMemo(() => new Map(findIssueDocumentReferences(data.documents, issueId)
    .map(reference => [reference.document.id, reference])), [data.documents, issueId]);
  const { linkedDocuments, linkedDocumentIds, availableDocuments } = useMemo(() => {
    const linkedDocuments = data.resourceLinks.filter(link => link.issueId === issueId);
    const linkedDocumentIds = new Set(linkedDocuments.map(link => link.documentId));
    const documentsById = new Map(data.documents.map(doc => [doc.id, doc]));
    const availableDocuments = data.documents.filter(doc => !linkedDocumentIds.has(doc.id)).map(doc => {
      const ancestors: string[] = [];
      const visited = new Set([doc.id]);
      let parentId = doc.parentId;
      while (parentId && !visited.has(parentId)) {
        const parent = documentsById.get(parentId);
        if (!parent) break;
        visited.add(parentId);
        ancestors.push(parent.title || '제목 없는 문서');
        parentId = parent.parentId;
      }
      return { id: doc.id, title: doc.title || '제목 없는 문서', projectId: doc.projectId, context: ancestors.reverse().join(' / ') };
    });
    return { linkedDocuments, linkedDocumentIds, availableDocuments };
  }, [data.documents, data.resourceLinks, issueId]);
  const [draft, setDraft] = useState<Issue | undefined>(issue);
  const [baseDraft, setBaseDraft] = useState<Issue | undefined>(issue);
  const [stagedGitlabStatus, setStagedGitlabStatus] = useState<GitlabStatusSuggestion | null>(null);
  const [rejectedGitlabStatusToken, setRejectedGitlabStatusToken] = useState<string | null>(null);
  const [labels, setLabels] = useState(issue?.labels.join(', ') || '');
  const [comments, setComments] = useState<IssueCommentView[]>([]);
  const commentEditing = useCommentEditing({
    actorId: props.actorId, resourceId: issueId, refresh, notify,
    onSaved: saved => setComments(previous => previous.map(item => item.id === saved.id
      ? { ...saved, ...(item.jiraOriginalLinksAvailable ? { jiraOriginalLinksAvailable: item.jiraOriginalLinksAvailable } : {}) } : item)),
  });
  const { discard: discardCommentEdit, hasDraft: hasCommentEditDraft, isPending: isCommentEditPending } = commentEditing;
  const [commentDraft, setCommentDraft] = useState(emptyCommentDraft);
  const [loadingComments, setLoadingComments] = useState(true);
  const [loadedCommentActivation, setLoadedCommentActivation] = useState<number>();
  const handledCommentActivation = useRef<number>(undefined);
  const commentsHeading = useRef<HTMLHeadingElement>(null);
  const commentActivation = commentFocus?.activation;
  const [commentError, setCommentError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [commenting, setCommenting] = useState(false);
  const commentingRef = useRef(false);
  const [error, setError] = useState<IssueEditError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [childCreation, setChildCreation] = useState<Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'version'> | null>(null);
  const childCreationTrigger = useRef<HTMLButtonElement>(null);
  const closeChildCreation = useCallback(() => {
    setChildCreation(null);
    requestAnimationFrame(() => childCreationTrigger.current?.focus({ preventScroll: true }));
  }, []);
  const [cloneCreation, setCloneCreation] = useState<Issue | null>(null);
  const [createdClone, setCreatedClone] = useState<Pick<Issue, 'id' | 'key'> | null>(null);
  const [relationsRefreshKey, setRelationsRefreshKey] = useState(0);
  const relationControls = useRef<IssueRelationsHandle>(null);
  const cloneCreationTrigger = useRef<HTMLButtonElement>(null);
  const createdCloneLink = useRef<HTMLButtonElement>(null);
  const cloneReturnFocus = useRef<'trigger' | 'receipt' | null>(null);
  const closeCloneCreation = useCallback(() => {
    cloneReturnFocus.current ??= 'trigger';
    setCloneCreation(null);
  }, []);
  const showCreatedClone = useCallback(({ id, key }: Issue) => {
    cloneReturnFocus.current = 'receipt';
    setCreatedClone({ id, key });
  }, []);
  useLayoutEffect(() => {
    if (cloneCreation || !cloneReturnFocus.current) return;
    const target = cloneReturnFocus.current === 'receipt' ? createdCloneLink.current : cloneCreationTrigger.current;
    cloneReturnFocus.current = null;
    (target ?? cloneCreationTrigger.current)?.focus({ preventScroll: true });
  }, [cloneCreation, createdClone]);
  const refreshIssueRelations = useCallback(async () => {
    await refresh();
    setRelationsRefreshKey(key => key + 1);
  }, [refresh]);
  const [scheduleIssueCreation, setScheduleIssueCreation] = useState<{ link: ScheduleIssueLink; opener: HTMLButtonElement } | null>(null);
  const [blockedIssueCreation, setBlockedIssueCreation] = useState<{ issue: Issue; opener: HTMLButtonElement } | null>(null);
  function closeBlockedIssueCreation() {
    const opener = blockedIssueCreation?.opener;
    setBlockedIssueCreation(null);
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== opener) return;
      if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    });
  }
  function closeScheduleIssueCreation() {
    const opener = scheduleIssueCreation?.opener;
    setScheduleIssueCreation(null);
    requestAnimationFrame(() => opener?.focus({ preventScroll: true }));
  }
  function focusCreatedScheduleIssue(linkedIssue: Issue) {
    requestAnimationFrame(() => {
      const button = issuePanel.current?.querySelector<HTMLButtonElement>(`[data-related-schedule-issue="${CSS.escape(linkedIssue.id)}"]`);
      button?.focus();
    });
  }
  const [dependencyEditor, setDependencyEditor] = useState<IssueDependencyEditor | null>(null);
  const [rowScheduleEdit, setRowScheduleEdit] = useState<{
    issue: Issue;
    initialDates: ScheduleBulkDateChanges;
    initialDateDraft?: Pick<Issue, 'version' | 'startDate' | 'endDate' | 'dueDate'>;
    ganttDateDraft?: StoredGanttDateDraft;
  } | null>(null);
  const [teamFollowUp, setTeamFollowUp] = useState<TicketTeamFollowUp | null>(null);
  const teamBlockers = useMemo(() => groupActiveTeamBlockers(data,
    new Map(data.projects.map(project => [project.id, project]))), [data]);
  const teamFollowUpChoices = teamBlockers.outgoing.get(issueId) ?? [];
  const [scheduleReflection, setScheduleReflection] = useState<{ anchorVersion: number | null; draftFields: ScheduleDraftFields } | null>(null);
  const scheduleUndoScope: ScheduleUndoScope | null = issue ? { kind: 'issue', id: issue.id } : null;
  const { undoId: scheduleUndoId, remember: rememberScheduleUndo, undo: undoSchedule } = useScheduleUndo(
    scheduleUndoScope, props.actorId, data.restoreGeneration,
  );
  const [scheduleWarnings, setScheduleWarnings] = useState<string[]>([]);
  const rowScheduleOpener = useRef<HTMLButtonElement>(null);
  const teamFollowUpOpener = useRef<HTMLButtonElement>(null);
  const rowScheduleUndoButton = useRef<HTMLButtonElement>(null);
  const scheduleReturnFocus = useRef<'edit' | 'undo' | 'team-follow-up' | null>(null);
  const rowScheduleGuard = useRef({ dirty: false, pending: false });
  const teamFollowUpGuard = useRef({ dirty: false, pending: false, outcomeUnknown: false });
  const trackRowScheduleDraft = useCallback((_id: string, dirty: boolean, pending = false) => {
    rowScheduleGuard.current = { dirty, pending };
  }, []);
  const closeRowScheduleEdit = useCallback((restoreFocus = true) => {
    rowScheduleGuard.current = { dirty: false, pending: false };
    scheduleReturnFocus.current = restoreFocus ? 'edit' : null;
    setRowScheduleEdit(null);
  }, []);
  const trackTeamFollowUpBusy = useCallback((pending: boolean) => {
    teamFollowUpGuard.current.pending = pending;
  }, []);
  const trackTeamFollowUpDirty = useCallback((dirty: boolean) => {
    teamFollowUpGuard.current.dirty = dirty;
  }, []);
  const trackTeamFollowUpOutcome = useCallback((outcomeUnknown: boolean) => {
    teamFollowUpGuard.current.outcomeUnknown = outcomeUnknown;
  }, []);
  const closeTeamFollowUp = useCallback((restoreFocus = true) => {
    const outcomeUnknown = teamFollowUpGuard.current.outcomeUnknown;
    teamFollowUpGuard.current = { dirty: false, pending: false, outcomeUnknown: false };
    scheduleReturnFocus.current = restoreFocus ? 'team-follow-up' : null;
    setTeamFollowUp(null);
    if (restoreFocus && outcomeUnknown) void refresh().catch(cause => notify(errorMessage(cause), 'error'));
  }, [refresh, notify]);
  const [projectMove, setProjectMove] = useState<{ draftMessage: string | null } | null>(null);
  const projectMoveTrigger = useRef<HTMLButtonElement>(null);
  const projectMoveGuard = useRef({ dirty: false, pending: false, uncertain: false });
  const trackProjectMoveDraft = useCallback((dirty: boolean, pending: boolean, uncertain = false) => { projectMoveGuard.current = { dirty, pending, uncertain }; }, []);
  const closeProjectMove = useCallback((restoreFocus = true) => {
    trackProjectMoveDraft(false, false);
    setProjectMove(null);
    if (restoreFocus) requestAnimationFrame(() => projectMoveTrigger.current?.focus({ preventScroll: true }));
  }, [trackProjectMoveDraft]);
  const [linkedDocumentCreation, setLinkedDocumentCreation] = useState(false);
  const linkedDocumentOpener = useRef<HTMLButtonElement>(null);
  const linkedDocumentGuard = useRef({ dirty: false, pending: false, uncertain: false });
  const trackLinkedDocumentDraft = useCallback((dirty: boolean, pending: boolean, uncertain: boolean) => {
    linkedDocumentGuard.current = { dirty, pending, uncertain };
  }, []);
  const closeLinkedDocumentCreation = useCallback((restoreFocus = true) => {
    trackLinkedDocumentDraft(false, false, false);
    setLinkedDocumentCreation(false);
    if (restoreFocus) requestAnimationFrame(() => linkedDocumentOpener.current?.focus({ preventScroll: true }));
  }, [trackLinkedDocumentDraft]);
  const nestedModalOpen = Boolean(childCreation || cloneCreation || scheduleIssueCreation || blockedIssueCreation || dependencyEditor || rowScheduleEdit || teamFollowUp || projectMove || linkedDocumentCreation);
  const [dependencyBusy, setDependencyBusy] = useState(false);
  const [jiraDeadlinePending, setJiraDeadlinePending] = useState(false);
  const jiraDeadlinePendingRef = useRef(false);
  const trackJiraDeadlinePending = useCallback((pending: boolean) => {
    jiraDeadlinePendingRef.current = pending;
    setJiraDeadlinePending(pending);
  }, []);
  // Restore focus after the nested dialog is removed and the ticket becomes interactive.
  useLayoutEffect(() => {
    if (dependencyBusy || nestedModalOpen || previewDocumentId || !scheduleReturnFocus.current) return;
    const returnButton = scheduleReturnFocus.current === 'undo' ? rowScheduleUndoButton.current
      : scheduleReturnFocus.current === 'team-follow-up' ? teamFollowUpOpener.current : null;
    scheduleReturnFocus.current = null;
    const target = returnButton ?? rowScheduleOpener.current;
    if (target && !target.disabled && !target.closest('[inert]')) target.focus({ preventScroll: true });
  }, [dependencyBusy, nestedModalOpen, previewDocumentId]);
  const statusField = useRef<HTMLSelectElement>(null);
  const dependencyBusyRef = useRef(false);
  const dependencyDraftRef = useRef(false);
  const dependencyOpener = useRef<HTMLButtonElement | null>(null);
  const addPredecessorButton = useRef<HTMLButtonElement>(null);
  const trackDependencyDraft = useCallback((_id: string, dirty: boolean) => { dependencyDraftRef.current = dirty; }, []);
  const closeDependencyEditor = useCallback(() => {
    const opener = dependencyOpener.current;
    dependencyOpener.current = null;
    setDependencyEditor(null);
    requestAnimationFrame(() => (opener?.isConnected && !opener.disabled ? opener : addPredecessorButton.current)?.focus({ preventScroll: true }));
  }, []);
  const [tab, setTab] = useState<'details' | 'activity' | 'source' | 'worklogs' | 'reservations'>('details');
  const [linking, setLinking] = useState(false);
  const [linkNotice, setLinkNotice] = useState<{ message: string; reload?: boolean } | null>(null);
  const linkingRef = useRef(false);
  const [loadedVersion, setLoadedVersion] = useState(issue?.version);
  const dirty = Boolean(draft && baseDraft && JSON.stringify(editableIssue(draft, labels)) !== JSON.stringify(editableIssue(baseDraft, baseDraft.labels.join(', '))));
  const dirtyRef = useRef(false);
  const childDraft = useRef<ChildDraft | null>(null);
  const gitlabDraft = useRef<ChildDraft | null>(null);
  const gitlabLinks = useMemo(() => data.gitlabLinks.filter(link => link.issueId === issueId), [data.gitlabLinks, issueId]);
  const trackChildDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    childDraft.current = dirty || pending ? {dirty,pending,discard} : null;
  }, []);
  const trackRelationDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    childDraft.current = dirty || pending ? { dirty, pending, discard, label: '업무 관계 입력' } : null;
  }, []);
  const trackGitlabDraft = useCallback((dirty: boolean, pending: boolean, discard: () => void) => {
    gitlabDraft.current = dirty || pending ? { dirty, pending, discard, label: 'GitLab 연결 입력' } : null;
  }, []);
  const switchTab = useCallback((next: typeof tab) => {
    if (next === tab) return true;
    if (jiraDeadlinePendingRef.current) { notify('마감일 복구 확인이 끝난 뒤 이동해 주세요.', 'error'); return false; }
    if (isCommentEditPending()) { notify('댓글 수정 요청이 끝난 뒤 이동해 주세요.', 'error'); return false; }
    const editingReservations = tab === 'reservations';
    const drafts = [childDraft.current, gitlabDraft.current];
    const pending = drafts.find(value => value?.pending);
    if (pending) {
      const name = pending === gitlabDraft.current ? 'GitLab 연결' : pending.label ? '업무 관계' : editingReservations ? '시간 배정' : '작업 시간';
      notify(`${name} 저장이 끝난 뒤 이동해 주세요.`, 'error');
      return false;
    }
    const changed = drafts.flatMap(value => value?.dirty ? [value.label ?? (editingReservations ? '시간 배정 입력' : '작업 시간 기록')] : []);
    if (changed.length && !window.confirm(`작성 중인 ${changed.join('·')}을 버리고 이동할까요?`)) return false;
    for (const value of drafts) value?.discard();
    setTab(next);
    return true;
  }, [isCommentEditPending, notify, tab]);
  useEffect(() => {
    const focusCommentTab = (event: Event) => {
      const target = (event as CustomEvent<{ issueId: string }>).detail;
      if (!event.defaultPrevented && target?.issueId === issueId && !switchTab('details')) event.preventDefault();
    };
    window.addEventListener('teamspace:focus-issue-comment', focusCommentTab);
    return () => window.removeEventListener('teamspace:focus-issue-comment', focusCommentTab);
  }, [issueId, switchTab]);
  useEffect(() => { dirtyRef.current = dirty || Boolean(commentDraft.body.trim()); }, [dirty, commentDraft.body]);
  if (loadedVersion !== issue?.version) {
    setLoadedVersion(issue?.version);
    if (!dirty) { setDraft(issue); setBaseDraft(issue); setStagedGitlabStatus(null); setLabels(issue?.labels.join(', ') || ''); setError(null); setConflict(false); setDeleteConfirm(false); }
  }
  if (scheduleReflection) {
    setScheduleReflection(null);
    if (issue && draft && baseDraft && issue.projectId === baseDraft.projectId && draft.version === baseDraft.version) {
      const { anchorVersion, draftFields } = scheduleReflection;
      // The receipt proves the saved anchor version. Leave newer workspace changes for an explicit review.
      if (issue.version >= baseDraft.version && issue.version === (anchorVersion ?? baseDraft.version)) {
        const previousDue = baseDraft.dueDate ?? null;
        const localDue = draft.dueDate ?? null;
        const savedDue = issue.dueDate ?? null;
        // A later undo must not clear a known due-date conflict from the follow-up apply.
        const reviewLocalDue = draftFields === 'due-date' || (draftFields === 'all' && conflict);
        const dueDateConflict = reviewLocalDue && localDue !== previousDue && savedDue !== previousDue && localDue !== savedDue;
        const merged = dueDateConflict ? null : mergeIssueFieldsAfterSchedule(baseDraft, draft, labels, issue);
        const nextDraft = merged?.draft ?? { ...draft };
        for (const field of scheduleDateFields) {
          const keepLocal = draftFields === 'all' || (draftFields === 'due-date' && field === 'dueDate');
          nextDraft[field] = keepLocal && draft[field] !== baseDraft[field] ? draft[field] : issue[field];
        }
        setDraft(nextDraft);
        setBaseDraft(merged ? issue : { ...baseDraft, startDate: issue.startDate, endDate: issue.endDate,
          dueDate: dueDateConflict ? baseDraft.dueDate : issue.dueDate });
        if (merged) {
          setLabels(merged.labels);
          setConflict(false);
          if (conflict) setError(null);
        } else setConflict(true);
      }
    }
  }
  const confirmDiscard = useCallback(() => {
    if (savingRef.current) { notify('저장이 끝난 후 이동해주세요.', 'error'); return false; }
    if (!dirtyRef.current) return true;
    if (!window.confirm('저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?')) return false;
    dirtyRef.current = false;
    return true;
  }, [notify]);
  const closePanel = useCallback(() => { onClose(); }, [onClose]);
  const navigateIssue = (id: string) => { if (id !== issueId) openIssue(id); };
  const navigateDocument = (id: string) => { openDocument(id); };
  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      const childDrafts = [childDraft.current, gitlabDraft.current];
      const documentGuard = linkedDocumentGuard.current;
      const followUpGuard = teamFollowUpGuard.current;
      if (savingRef.current || commentingRef.current || linkingRef.current || isCommentEditPending() ||
          childDrafts.some(value => value?.pending) || dependencyBusyRef.current || rowScheduleGuard.current.pending ||
          followUpGuard.pending || projectMoveGuard.current.pending || documentGuard.pending || jiraDeadlinePendingRef.current) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
        return;
      }
      const childNames = childDrafts.flatMap(value => value?.dirty ? [value.label ?? (tab === 'reservations' ? '시간 배정 입력' : '작업 시간 기록')] : []);
      if (dependencyDraftRef.current) childNames.push('업무 연결 입력');
      if (rowScheduleGuard.current.dirty) childNames.push('일정과 연결 입력');
      if (followUpGuard.dirty) childNames.push('프로젝트 간 일정 입력');
      if (documentGuard.dirty && !documentGuard.uncertain) childNames.push('연결 문서 입력');
      if (hasCommentEditDraft()) childNames.push('댓글 수정 입력');
      const moveGuard = projectMoveGuard.current;
      const moveDiscard = moveGuard.uncertain ? '이동 결과를 아직 확인하지 못했습니다. 다른 화면으로 이동할까요?' : '작성 중인 프로젝트 이동 설정을 버릴까요?';
      if (moveGuard.dirty && !dirtyRef.current && !childNames.length && !window.confirm(moveDiscard)) {
        event.preventDefault();
        return;
      }
      if (moveGuard.dirty && (dirtyRef.current || childNames.length)) childNames.push(moveGuard.uncertain ? '프로젝트 이동 결과 확인' : '프로젝트 이동 설정');
      if (dirtyRef.current || childNames.length || documentGuard.uncertain || followUpGuard.outcomeUnknown) {
        const hasUnsavedInput = dirtyRef.current || childNames.length > 0;
        const draftMessage = childNames.length ? `저장하지 않은 업무·댓글·${childNames.join('·')}을 버리고 이동할까요?`
          : '저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?';
        const unconfirmedSave = documentGuard.uncertain ? '연결 문서가 이미 저장됐을 수 있습니다.'
          : followUpGuard.outcomeUnknown ? '프로젝트 간 일정이 이미 저장됐을 수 있습니다.' : '';
        const message = unconfirmedSave ? `${unconfirmedSave} ${hasUnsavedInput ? draftMessage : '저장 결과 확인을 닫고 이동할까요?'}` : draftMessage;
        if (!window.confirm(message)) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          for (const value of childDrafts) value?.discard();
          setDependencyEditor(null);
          dirtyRef.current = false;
          setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || '');
          setStagedGitlabStatus(null);
          setCommentDraft(emptyCommentDraft()); setError(null); setConflict(false);
        });
      }
      if (rowScheduleEdit) afterAcceptedNavigation(event, () => closeRowScheduleEdit(false));
      if (teamFollowUp) afterAcceptedNavigation(event, () => closeTeamFollowUp(false));
      if (projectMove) afterAcceptedNavigation(event, () => closeProjectMove(false));
      if (linkedDocumentCreation) afterAcceptedNavigation(event, () => closeLinkedDocumentCreation(false));
      afterAcceptedNavigation(event, discardCommentEdit);
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !commentingRef.current && !linkingRef.current && !jiraDeadlinePendingRef.current &&
          !isCommentEditPending() && !hasCommentEditDraft() && !childDraft.current && !gitlabDraft.current && !dependencyDraftRef.current && !dependencyBusyRef.current &&
          !rowScheduleGuard.current.dirty && !rowScheduleGuard.current.pending && !teamFollowUpGuard.current.dirty && !teamFollowUpGuard.current.pending &&
          !teamFollowUpGuard.current.outcomeUnknown && !projectMoveGuard.current.dirty && !projectMoveGuard.current.pending &&
          !linkedDocumentGuard.current.dirty && !linkedDocumentGuard.current.pending && !linkedDocumentGuard.current.uncertain) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', leave); };
  }, [issue, notify, tab, projectMove, rowScheduleEdit, teamFollowUp, linkedDocumentCreation, closeProjectMove, closeRowScheduleEdit, closeTeamFollowUp,
    closeLinkedDocumentCreation, discardCommentEdit, hasCommentEditDraft, isCommentEditPending]);
  useEffect(() => {
    let activeRequest: AbortController | undefined;
    const loadComments = () => {
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      void api<IssueCommentView[]>(`/comments?resourceType=issue&resourceId=${encodeURIComponent(issueId)}`, {
        signal: request.signal, headers: { 'X-Actor-Id': props.actorId },
      }).then(value => { if (!request.signal.aborted) { setComments(value); setCommentError(''); } })
        .catch(err => { if (!request.signal.aborted) setCommentError(errorMessage(err)); })
        .finally(() => {
          if (!request.signal.aborted) {
            setLoadingComments(false);
            setLoadedCommentActivation(commentActivation);
          }
        });
    };
    loadComments();
    window.addEventListener(COMMENT_LIST_CHANGED, loadComments);
    window.addEventListener('teamspace:trash-changed', loadComments);
    window.addEventListener('teamspace:workspace-imported', loadComments);
    return () => {
      activeRequest?.abort();
      window.removeEventListener(COMMENT_LIST_CHANGED, loadComments);
      window.removeEventListener('teamspace:trash-changed', loadComments);
      window.removeEventListener('teamspace:workspace-imported', loadComments);
    };
  }, [issueId, props.actorId, commentActivation]);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousReviewButton = useRef<HTMLButtonElement>(null);
  const nextReviewButton = useRef<HTMLButtonElement>(null);
  const reviewFocusDirection = reviewPosition?.focusDirection;
  const issuePanel = useRef<HTMLElement>(null);
  const previewOpener = useRef<HTMLButtonElement | null>(null);
  const previousPreview = useRef<string | null>(null);
  useLayoutEffect(() => {
    const closedDocumentId = previousPreview.current;
    previousPreview.current = previewDocumentId;
    if (previewDocumentId || !closedDocumentId) return;
    const opener = previewOpener.current;
    previewOpener.current = null;
    const frame = requestAnimationFrame(() => {
      const trigger = opener?.isConnected && opener.dataset.previewDocumentId === closedDocumentId
        ? opener
        : issuePanel.current?.querySelector<HTMLButtonElement>(`[data-preview-document-id="${CSS.escape(closedDocumentId)}"]`);
      (trigger && !trigger.disabled ? trigger : closeButton.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [previewDocumentId]);
  useEffect(() => {
    const reviewButton = reviewFocusDirection === 'previous' ? previousReviewButton.current
      : reviewFocusDirection === 'next' ? nextReviewButton.current : null;
    if (reviewButton && !reviewButton.disabled) reviewButton.focus({ preventScroll: true });
    else if (manageFocus || reviewFocusDirection) closeButton.current?.focus({ preventScroll: true });
  }, [manageFocus, reviewFocusDirection]);
  useEffect(() => {
    if (!commentFocus || loadedCommentActivation !== commentFocus.activation || handledCommentActivation.current === commentFocus.activation
      || previewDocumentId || nestedModalOpen) return;
    if (tab !== 'details') {
      if (!switchTab('details')) handledCommentActivation.current = commentFocus.activation;
      return;
    }
    const target = document.getElementById(`issue-comment-${commentFocus.commentId}`) ?? commentsHeading.current;
    if (!target) return;
    handledCommentActivation.current = commentFocus.activation;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [commentFocus, loadedCommentActivation, previewDocumentId, nestedModalOpen, tab, switchTab]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || nestedModalOpen || previewDocumentId) return;
      if (manageFocus) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!saving && !dependencyBusyRef.current && !jiraDeadlinePendingRef.current) closePanel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [closePanel, saving, nestedModalOpen, manageFocus, previewDocumentId]);

  function keepIssuePanelFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const panel = event.currentTarget;
    const focusable = [...panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"], [contenteditable="true"]',
    )].filter(element => element.tabIndex >= 0 && !element.closest('[inert]') && element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (!first || active === panel || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last ?? panel : first ?? panel).focus({ preventScroll: true });
    }
  }

  if (!issue || !draft) return <div className="issue-panel-backdrop"><aside className="issue-detail-panel"><button className="issue-icon-button" onClick={closePanel} aria-label="닫기"><X /></button><div className="issue-empty">업무를 찾을 수 없습니다.</div></aside></div>;
  const savedRelationIssue = baseDraft && baseDraft.version > issue.version ? baseDraft : issue;
  const bodyOnlyReferences = [...bodyReferences.values()].filter(({ document }) => !linkedDocumentIds.has(document.id));
  const activities = data.activities.filter(a => a.resourceId === issueId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const children = data.issues.filter(i => i.parentId === issueId).map(child => ({
    child, status: statusMeta(data, child.projectId, child.status),
  }));
  const completedChildren = children.filter(({ status }) => status.category === 'done').length;
  const nextStatuses = allowedNextStatuses(data, {projectId:draft.projectId,status:baseDraft?.status || draft.status,type:draft.type});
  const requiredFields = requiredFieldsFor(data,draft.projectId,draft.type,draft.status,baseDraft?.status);
  const dependencies = data.dependencies.filter(d => d.predecessorId === issueId || d.successorId === issueId);
  const hasOtherIssueInProject = data.issues.some(value => value.projectId === issue.projectId && value.id !== issueId);
  const editingDependency = dependencyEditor?.dependency;
  const relationScheduleReview = dependencyEditor?.review;
  const latestDependency = editingDependency && dependencies.find(value => value.id === editingDependency.id);
  const staleDependencyMessage = editingDependency && (!latestDependency
    ? '이 연결이 더 이상 존재하지 않습니다. 편집을 닫고 현재 목록을 확인하세요.'
    : (latestDependency.version ?? 1) !== (editingDependency.version ?? 1)
      ? '다른 작업자가 이 연결을 변경했습니다. 편집을 닫고 다시 열어 최신 연결을 확인하세요.' : undefined);
  function openRowScheduleEdit() {
    if (!issue || !draft || !baseDraft) return;
    if (savingRef.current || dependencyBusyRef.current || commenting || isCommentEditPending() ||
      linkingRef.current || childDraft.current?.pending || gitlabDraft.current?.pending) {
      notify('현재 요청이 끝난 뒤 일정과 연결을 편집해 주세요.', 'error');
      return;
    }
    if (baseDraft.projectId !== issue.projectId) {
      notify('업무가 다른 프로젝트로 이동했습니다. 최신 업무를 확인한 뒤 일정을 편집해 주세요.', 'error');
      return;
    }
    const initialDates: ScheduleBulkDateChanges = {};
    for (const field of scheduleDateFields) {
      if (draft[field] !== baseDraft[field]) initialDates[field] = draft[field] ?? null;
    }
    if (Object.keys(initialDates).length) {
      setRowScheduleEdit({ issue: savedRelationIssue, initialDates, initialDateDraft: baseDraft });
      return;
    }
    const ganttDateDraft = props.ganttDateDraftsRef?.current?.read(savedRelationIssue);
    if (ganttDateDraft) {
      const { version, startDate, endDate, draftStart, draftEnd } = ganttDateDraft;
      if (draftStart !== startDate) initialDates.startDate = draftStart;
      if (draftEnd !== endDate) initialDates.endDate = draftEnd;
      if (Object.keys(initialDates).length) {
        setRowScheduleEdit({ issue: savedRelationIssue, initialDates, ganttDateDraft,
          initialDateDraft: { version, startDate, endDate, dueDate: savedRelationIssue.dueDate } });
        return;
      }
    }
    setRowScheduleEdit({ issue: savedRelationIssue, initialDates });
  }
  function openTeamFollowUp() {
    if (!issue || !draft || !baseDraft || !teamFollowUpChoices.length) return;
    if (savingRef.current || commentingRef.current || linkingRef.current || dependencyBusyRef.current || isCommentEditPending() ||
        childDraft.current?.pending || gitlabDraft.current?.pending || jiraDeadlinePendingRef.current) {
      notify('현재 요청이 끝난 뒤 프로젝트 간 일정을 검토해 주세요.', 'error');
      return;
    }
    if (baseDraft.projectId !== issue.projectId) {
      notify('업무가 다른 프로젝트로 이동했습니다. 최신 업무를 확인한 뒤 일정을 편집해 주세요.', 'error');
      return;
    }
    const hasDateDraft = draft.startDate !== baseDraft.startDate || draft.endDate !== baseDraft.endDate;
    // The original dates let the review retain just the edited endpoint if the other endpoint changed on the server.
    const source = hasDateDraft ? baseDraft : savedRelationIssue;
    const initialChange = hasDateDraft ? { id: source.id, expectedVersion: source.version, startDate: draft.startDate, endDate: draft.endDate } : undefined;
    setTeamFollowUp({ source, initialChange, choices: teamFollowUpChoices, choosing: teamFollowUpChoices.length > 1 });
  }
  function chooseTeamFollowUps(choices: readonly TeamFollowUpChoice[]) {
    setTeamFollowUp(current => current && { ...current, choices, choosing: false });
  }
  async function reflectIssueSchedule(anchorVersion: number | null, draftFields: ScheduleDraftFields) {
    await refresh();
    setScheduleReflection({ anchorVersion, draftFields });
  }
  async function reflectScheduleChange(result: Pick<ScheduleApplyResult, 'updated' | 'warnings'>, draftFields: ScheduleDraftFields, reviewedAnchorVersion?: number) {
    await reflectIssueSchedule(result.updated.find(value => value.id === issueId)?.version ?? reviewedAnchorVersion ?? null, draftFields);
    setScheduleWarnings(result.warnings ?? []);
  }
  async function reflectRowScheduleEdit(result: SchedulePasteApplyResult, reviewedAnchorVersion: number) {
    rememberScheduleUndo(result.undoId);
    const ganttDateDraft = rowScheduleEdit?.ganttDateDraft;
    const saved = result.updated.find(value => value.id === issueId);
    if (ganttDateDraft && saved) props.ganttDateDraftsRef?.current?.acceptSaved(ganttDateDraft, saved);
    await reflectScheduleChange(result, 'none', reviewedAnchorVersion);
    closeRowScheduleEdit();
    const datesChanged = result.updated.length > 0;
    const linksChanged = Boolean(result.dependencyChanges);
    notify(datesChanged && linksChanged ? '업무 일정과 선후행 연결을 변경했습니다.'
      : datesChanged ? '업무 일정을 변경했습니다.' : '선후행 연결을 변경했습니다.');
  }
  async function reflectTeamFollowUp(result: ScheduleApplyResult, reviewedSource?: Pick<Issue, 'version'>) {
    rememberScheduleUndo(result.undoId);
    await reflectScheduleChange(result, 'due-date', reviewedSource?.version);
    closeTeamFollowUp();
    notify(`${result.updated.length}개 업무의 일정을 변경했습니다.`);
  }
  async function undoRowScheduleEdit() {
    if (!scheduleUndoId || dependencyBusyRef.current || savingRef.current || rowScheduleGuard.current.pending) return;
    dependencyBusyRef.current = true;
    setDependencyBusy(true);
    try {
      const result = await undoSchedule();
      if (!result) return;
      try {
        await reflectScheduleChange(result, 'all');
        notify('일정과 연결 변경을 되돌렸습니다.');
      } catch (cause) {
        notify(`일정과 연결 변경을 되돌렸습니다. 최신 업무를 불러오지 못했습니다. ${errorMessage(cause)}`, 'error');
      }
      scheduleReturnFocus.current = 'edit';
    } catch (cause) {
      scheduleReturnFocus.current = 'undo';
      notify(errorMessage(cause), 'error');
    } finally {
      dependencyBusyRef.current = false;
      setDependencyBusy(false);
    }
  }
  function projectMoveDraftMessage() {
    const childDrafts = [childDraft.current, gitlabDraft.current];
    if (savingRef.current || commenting || isCommentEditPending() || linkingRef.current || dependencyBusyRef.current || childDrafts.some(value => value?.pending)) {
      return '현재 작업을 저장한 뒤 프로젝트를 이동해 주세요.';
    }
    if (dirty || commentDraft.body.trim() || hasCommentEditDraft() || dependencyDraftRef.current || childDrafts.some(value => value?.dirty)) {
      return '이동을 적용하려면 창을 닫고 저장하지 않은 업무 변경사항이나 작성 중인 댓글·연결을 먼저 정리해 주세요.';
    }
    return null;
  }
  function update<K extends keyof Issue>(key: K, value: Issue[K]) {
    if ((key === 'status' || key === 'type') && draft?.[key] !== value && error?.openBlockers) setError(null);
    const discardedSuggestion = key === 'type' && draft?.type !== value ? stagedGitlabStatus : null;
    if (key === 'status' || discardedSuggestion) setStagedGitlabStatus(null);
    setDraft(previous => previous ? {
      ...previous, ...(discardedSuggestion && previous.status === discardedSuggestion.toStatus ? { status: discardedSuggestion.fromStatus } : {}), [key]: value,
    } : previous);
  }
  function canPrepareStatus(fromStatus: string, toStatus: string) {
    return Boolean(issue && draft && baseDraft && !conflict && !saving && !dependencyBusy && !commenting &&
      draft.version === issue.version && baseDraft.status === issue.status && draft.status === baseDraft.status &&
      fromStatus === issue.status && toStatus !== issue.status && nextStatuses.some(status => status.id === toStatus));
  }
  function canPrepareAutomationStatus(run: AutomationRun) {
    return Boolean(issue && run.issueId === issue.id && run.projectId === issue.projectId && run.outcome === 'blocked' &&
      canPrepareStatus(run.fromStatus, run.toStatus));
  }
  function prepareStatus(toStatus: Issue['status']) {
    if (savingRef.current || dependencyBusyRef.current || gitlabDraft.current?.pending || childDraft.current?.pending) {
      notify('현재 작업을 저장한 뒤 상태를 편집해 주세요.', 'error');
      return false;
    }
    update('status', toStatus);
    setError(null);
    statusField.current?.focus();
    return true;
  }
  function prepareAutomationStatus(run: AutomationRun) {
    if (canPrepareAutomationStatus(run)) prepareStatus(run.toStatus);
  }
  function isCurrentGitlabStatusSuggestion(suggestion: GitlabStatusSuggestion) {
    if (!issue || suggestion.issueId !== issue.id || suggestion.projectId !== issue.projectId ||
        suggestion.issueVersion !== issue.version || suggestion.fromStatus !== issue.status ||
        suggestion.workflowVersion !== projectWorkflow(data, issue.projectId).version || suggestion.token === rejectedGitlabStatusToken) return false;
    const currentLink = gitlabLinks.find(link => link.id === suggestion.evidence.link.id);
    return JSON.stringify(currentLink) === JSON.stringify(suggestion.evidence.link);
  }
  function canPrepareGitlabStatusSuggestion(suggestion: GitlabStatusSuggestion) {
    return draft?.type === issue?.type && canPrepareStatus(suggestion.fromStatus, suggestion.toStatus);
  }
  function prepareGitlabStatusSuggestion(suggestion: GitlabStatusSuggestion) {
    if (!isCurrentGitlabStatusSuggestion(suggestion)) {
      notify('GitLab에서 상태를 다시 확인해 주세요.', 'error');
      return;
    }
    if (canPrepareGitlabStatusSuggestion(suggestion) && prepareStatus(suggestion.toStatus)) setStagedGitlabStatus(suggestion);
  }
  function updatePlanning(kind: 'cycle' | 'module' | 'release', id: string | null) { setDraft(previous => previous ? { ...previous, [`${kind}Id`]: id, [kind]: data.planningItems?.find(item => item.id === id)?.name || null } : previous); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !issue || savingRef.current || dependencyBusyRef.current || childDraft.current?.pending) return; savingRef.current = true; setSaving(true); setError(null);
    const suggestion = stagedGitlabStatus?.toStatus === draft.status ? stagedGitlabStatus : null;
    try {
      const { descriptionFormat, reporterId, dueDate, ...fields } = editableIssue(draft, labels);
      const changedFormat = descriptionFormat !== (baseDraft?.descriptionFormat ?? 'plain');
      const changedDueDate = (dueDate ?? null) !== (baseDraft?.dueDate ?? null);
      const updated = await patch<Issue>(`/issues/${issueId}`, { expectedVersion: draft.version, ...fields,
        ...(suggestion ? { gitlabStatusSuggestionToken: suggestion.token } : {}),
        ...(reporterId !== undefined && reporterId !== baseDraft?.reporterId ? { reporterId } : {}),
        ...(changedDueDate ? { dueDate: dueDate ?? null } : {}),
        ...(changedFormat ? { descriptionFormat } : {}) });
      setDraft(updated); setBaseDraft(updated); setLabels(updated.labels.join(', ')); setConflict(false); dirtyRef.current = false;
      setStagedGitlabStatus(null);
      await refresh(); notify(`${issue.key} 변경사항을 저장했습니다.`);
    } catch (err) {
      if (suggestion && isStaleGitlabStatusSuggestion(err)) {
        setStagedGitlabStatus(null);
        setRejectedGitlabStatusToken(suggestion.token);
        setDraft(current => current?.status === suggestion.toStatus ? { ...current, status: suggestion.fromStatus } : current);
        setError({ message: err.message });
        await refresh().catch(() => undefined);
        return;
      }
      const openBlockers = isOpenBlockerError(err);
      setError({ message: errorMessage(err), openBlockers });
      if (openBlockers) {
        setRelationsRefreshKey(key => key + 1);
        void refresh().catch(() => undefined);
      }
      if (err instanceof ApiError && err.status === 409) { setConflict(true); await refresh().catch(() => undefined); }
    } finally { savingRef.current = false; setSaving(false); }
  }
  function reflectDuplicateClosure(updated: Issue, observed = false) {
    if (!baseDraft || updated.version <= baseDraft.version) return;
    if (observed) {
      const comparableFields = (value: ReturnType<typeof editableIssue>) => Object.entries(value)
        .filter(([field]) => field !== 'status' && field !== 'assigneeId' && field !== 'dueDate');
      const before = editableIssue(baseDraft, baseDraft.labels.join(', '));
      const after = editableIssue(updated, updated.labels.join(', '));
      const changedOutsideClosure = JSON.stringify(comparableFields(before)) !== JSON.stringify(comparableFields(after));
      const overlappingDraft = (['assigneeId', 'dueDate'] as const)
        .some(field => after[field] !== before[field] && draft?.[field] !== baseDraft[field]);
      if (dirty && (updated.version !== baseDraft.version + 1 || changedOutsideClosure || overlappingDraft)) {
        setConflict(true);
        setError({ message: '최신 업무에 다른 변경이 있습니다. 현재 초안과 최신 업무를 확인해 주세요.' });
        return;
      }
    }
    if (baseDraft.version + 1 !== updated.version) return;
    setDraft(current => current?.version === baseDraft.version ? {
      ...current,
      version: updated.version,
      updatedAt: updated.updatedAt,
      status: updated.status,
      completedAt: updated.completedAt,
      assigneeId: current.assigneeId === baseDraft.assigneeId ? updated.assigneeId : current.assigneeId,
      dueDate: current.dueDate === baseDraft.dueDate ? updated.dueDate : current.dueDate,
    } : current);
    setBaseDraft(current => current?.version === baseDraft.version ? updated : current);
    setError(null);
    setConflict(false);
  }
  async function reloadLatest() {
    const hadUnsaved = dirtyRef.current;
    if (!confirmDiscard()) return;
    savingRef.current = true; setSaving(true);
    try { const snapshot = await api<WorkspaceSnapshot>('/workspace'); const latest = snapshot.issues.find(value => value.id === issueId); if (!latest) throw new Error('업무가 삭제되었거나 더 이상 존재하지 않습니다.'); setDraft(latest); setBaseDraft(latest); setStagedGitlabStatus(null); setLabels(latest.labels.join(', ')); setCommentDraft(emptyCommentDraft()); setConflict(false); setError(null); dirtyRef.current = false; await refresh(); }
    catch (err) { dirtyRef.current = hadUnsaved; setError({ message: errorMessage(err) }); } finally { savingRef.current = false; setSaving(false); }
  }
  async function deleteIssue() {
    if (gitlabDraft.current?.pending) { notify('GitLab 연결 변경이 끝난 뒤 업무를 휴지통으로 옮겨 주세요.', 'error'); return; }
    if (!issue || savingRef.current || commenting || isCommentEditPending() || dependencyBusyRef.current || childDraft.current?.pending) return;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      await remove(`/issues/${issueId}?expectedVersion=${draft?.version ?? issue.version}`);
      window.dispatchEvent(new Event('teamspace:trash-changed'));
      dirtyRef.current = false;
      discardCommentEdit();
      try {
        await refresh();
        notify(`${issue.key} 업무를 휴지통으로 옮겼습니다.`);
      } catch {
        notify(`${issue.key} 업무를 휴지통으로 옮겼습니다. 업무 목록을 불러오지 못했습니다.`, 'error');
      }
      savingRef.current = false;
      onClose();
    } catch (err) { setError({ message: errorMessage(err) }); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function addComment(event: FormEvent) {
    event.preventDefault();
    const payload = commentDraftPayload(commentDraft);
    if (!payload.body || commentingRef.current) return;
    commentingRef.current = true;
    setCommenting(true); setCommentError('');
    try {
      const value = await api<Comment>('/comments', { method: 'POST', headers: { 'X-Actor-Id': props.actorId },
        body: JSON.stringify({ resourceType: 'issue', resourceId: issueId, ...payload }) });
      setComments(previous => previous.some(item => item.id === value.id) ? previous : [...previous, value]);
      setCommentDraft(emptyCommentDraft());
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      await refresh();
    }
    catch (err) { setCommentError(errorMessage(err)); }
    finally { commentingRef.current = false; setCommenting(false); }
  }
  async function linkDocument(documentId: string) {
    if (linkingRef.current) return false;
    linkingRef.current = true;
    setLinking(true);
    setLinkNotice(null);
    let linked = false;
    try {
      await post('/resource-links', { issueId, documentId, kind: 'related' });
      linked = true;
      await refresh();
      notify('문서를 연결했습니다.');
      return true;
    } catch (err) {
      notify(linked ? '문서를 연결했습니다. 연결 목록을 다시 확인해 주세요.' : errorMessage(err), 'error');
      return false;
    } finally {
      linkingRef.current = false;
      setLinking(false);
    }
  }
  function showCreatedLinkedDocument({ document }: LinkedDocumentCreationResult) {
    closeLinkedDocumentCreation(false);
    notify('새 문서를 만들고 이 업무에 연결했습니다.');
    requestAnimationFrame(() => {
      const link = issuePanel.current?.querySelector<HTMLButtonElement>(`[data-linked-document-id="${CSS.escape(document.id)}"]`);
      if (link) link.focus();
      else linkedDocumentOpener.current?.focus({ preventScroll: true });
    });
  }
  function restoreLinkedDocumentFocus(opener: HTMLButtonElement) {
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== opener) return;
      const target = opener.isConnected && !opener.disabled ? opener : linkedDocumentOpener.current;
      if (target && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
  }
  async function reloadLinkedDocuments(opener: HTMLButtonElement) {
    if (linkingRef.current) return;
    linkingRef.current = true;
    setLinking(true);
    try {
      await refresh();
      setLinkNotice(null);
    } catch {
      setLinkNotice({ message: '최신 문서 연결을 불러오지 못했습니다.', reload: true });
    } finally {
      linkingRef.current = false;
      setLinking(false);
      restoreLinkedDocumentFocus(opener);
    }
  }
  async function unlinkDocument(link: ResourceLink, title: string, opener: HTMLButtonElement) {
    if (linkingRef.current || savingRef.current) return;
    const source = link.documentSource;
    if (source && !window.confirm(`‘${title}’ 문서 연결과 결정 근거를 해제할까요?`)) return;
    const expected = source && new URLSearchParams({ expectedDecisionRevisionId: source.revisionId,
      expectedDecisionFrom: String(source.from), expectedDecisionTo: String(source.to) });
    const path = `/resource-links/${encodeURIComponent(link.id)}${expected ? `?${expected}` : ''}`;
    linkingRef.current = true;
    setLinking(true);
    setLinkNotice(null);
    try {
      let failure: string | undefined;
      try { await remove(path); }
      catch (cause) {
        if (cause instanceof ApiError && cause.status === 409) failure = errorMessage(cause);
        else if (cause instanceof ApiError && cause.status === 404) failure = '이미 해제된 문서 연결입니다.';
        else if (cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status)) {
          setLinkNotice({ message: errorMessage(cause) });
          return;
        } else {
          try {
            const state = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
            const current = state.resourceLinks.find(candidate => candidate.id === link.id);
            if (current) {
              const actual = current.documentSource;
              const same = actual?.revisionId === source?.revisionId && actual?.from === source?.from && actual?.to === source?.to;
              failure = same ? '문서 연결이 남아 있습니다. 확인한 뒤 다시 해제할 수 있습니다.'
                : '결정 근거가 바뀌었습니다. 최신 연결을 확인해 주세요.';
            }
          } catch {
            setLinkNotice({ message: '문서 연결 해제 결과를 확인하지 못했습니다.', reload: true });
            return;
          }
        }
      }
      try { await refresh(); }
      catch {
        setLinkNotice({ message: failure ?? '문서 연결을 해제했습니다. 최신 목록을 불러오지 못했습니다.', reload: true });
        return;
      }
      if (failure) setLinkNotice({ message: failure });
      else notify('문서 연결을 해제했습니다.');
    } finally {
      linkingRef.current = false;
      setLinking(false);
      restoreLinkedDocumentFocus(opener);
    }
  }
  function openDependencyEditor(opener: HTMLButtonElement, otherRole: RelatedIssueDirection, dependency?: Dependency) {
    if (savingRef.current || dependencyBusyRef.current) return;
    dependencyOpener.current = opener;
    setDependencyEditor({ otherRole, dependency });
  }
  function openRelationScheduleReview(opener: HTMLButtonElement, relation: IssueRelation, mode: IssueRelationScheduleMode, reload: () => Promise<void>) {
    if (savingRef.current || dependencyBusyRef.current || childDraft.current?.pending) return;
    dependencyOpener.current = opener;
    setDependencyEditor({ review: { relation, mode, reload } });
  }
  async function changeDependency(change: () => Promise<unknown>, message: string) {
    if (dependencyBusyRef.current || savingRef.current) return false;
    dependencyBusyRef.current = true;
    setDependencyBusy(true);
    try {
      await change();
      try {
        await refresh();
        notify(message);
      } catch (err) {
        notify(`${message} 최신 목록을 불러오지 못했습니다. ${errorMessage(err)}`, 'error');
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) await refresh().catch(() => undefined);
      throw err;
    } finally {
      dependencyBusyRef.current = false;
      setDependencyBusy(false);
    }
  }
  async function saveDependency(input: DependencyInput) {
    const changed = await changeDependency(async () => {
      if (relationScheduleReview) {
        const { relation, reload } = relationScheduleReview;
        try {
          await post(`/issues/${encodeURIComponent(issueId)}/relations/${encodeURIComponent(relation.id)}/schedule-dependency`,
            { ...input, expectedVersion: relation.version });
        } catch (err) {
          if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void reload();
          throw err;
        }
        return;
      }
      if (!editingDependency) return post('/dependencies', input);
      const { type, lagDays } = input;
      const reverse = input.predecessorId !== editingDependency.predecessorId;
      return patch(`/dependencies/${encodeURIComponent(editingDependency.id)}`, {
        expectedVersion: editingDependency.version ?? 1, type, lagDays, ...(reverse ? { reverse: true } : {}),
      });
    }, editingDependency ? '업무 연결을 수정했습니다.' : '선행·후행 업무를 연결했습니다.');
    if (changed) closeDependencyEditor();
  }
  async function unlinkDependency(dependency: Dependency, opener: HTMLButtonElement) {
    try {
      await changeDependency(() => remove(`/dependencies/${encodeURIComponent(dependency.id)}?expectedVersion=${dependency.version ?? 1}`),
        '선행·후행 연결을 해제했습니다.');
    } catch (err) { notify(errorMessage(err), 'error'); }
    requestAnimationFrame(() => (opener.isConnected ? opener : addPredecessorButton.current)?.focus({ preventScroll: true }));
  }
  function linkedDocumentRow(doc: DocPage, link?: ResourceLink) {
    const count = bodyReferences.get(doc.id)?.count;
    const space = !link || doc.projectId !== issue?.projectId
      ? data.projects.find(project => project.id === doc.projectId)?.name ?? '팀 공통' : undefined;
    const title = doc.title || '제목 없는 문서';
    return <div className="issue-related-row">
      <FileText size={15} aria-hidden="true" />
      <div className="issue-document-entry">
        <button type="button" onClick={() => navigateDocument(doc.id)} className="issue-document-link"
          data-linked-document-id={link ? doc.id : undefined}>{title}</button>
        {(space || count) && <small className="issue-document-entry-meta">
          {space && <span>{space}</span>}
          {count && <span>본문 참조 {count}곳</span>}
        </small>}
      </div>
      <button type="button" className="issue-document-preview-trigger" aria-label={`${title} 미리보기`} data-preview-document-id={doc.id}
        onClick={event => {
          if (onPreviewDocument(doc.id)) previewOpener.current = event.currentTarget;
        }}><Eye size={14} aria-hidden="true" />미리보기</button>
      {link && <button type="button" className="issue-icon-button" disabled={linking || saving}
        onClick={event => void unlinkDocument(link, title, event.currentTarget)}
        aria-label={`${title} 연결 해제`} title="연결 해제"><X size={14} /></button>}
    </div>;
  }
  const parent = data.issues.find(i => i.id === issue.parentId);
  const previousKeys = issueSearchAliases(data, issue.id);
  const reviewBusy = saving || commenting || linking || dependencyBusy || jiraDeadlinePending || Boolean(commentEditing.operation);
  const deadlineRecoveryBlocked = baseDraft && scheduleDateFields.some(field => draft[field] !== baseDraft[field])
    ? '저장하지 않은 날짜가 있습니다. 날짜 입력을 저장하거나 취소한 뒤 복구해 주세요.'
    : reviewBusy && !jiraDeadlinePending ? '현재 업무 저장이 끝난 뒤 복구해 주세요.' : null;
  return <>
    <div className="issue-panel-backdrop" inert={nestedModalOpen || Boolean(previewDocument)} onMouseDown={event => {
      if (event.target === event.currentTarget && !saving && !nestedModalOpen && !dependencyBusyRef.current && !jiraDeadlinePendingRef.current) closePanel();
    }}><aside ref={issuePanel} className="issue-detail-panel" role="dialog" aria-modal="true" aria-labelledby="issue-panel-heading"
      tabIndex={manageFocus ? -1 : undefined} onKeyDown={manageFocus ? keepIssuePanelFocus : undefined}>
    <header className="issue-panel-header">
      <div className="issue-panel-breadcrumb"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span>{data.projects.find(p => p.id === issue.projectId)?.name}</span><ChevronRight size={13} /><strong>{issue.key}</strong></div>
      <div className="issue-panel-header-actions">
        {data.projects.some(project => project.id !== issue.projectId) && <button ref={projectMoveTrigger}
          className="btn btn-ghost issue-move-trigger" type="button" aria-haspopup="dialog" aria-label="프로젝트 이동" title="프로젝트 이동"
          disabled={saving || commenting || dependencyBusy || linking || jiraDeadlinePending} onClick={() => setProjectMove({ draftMessage: projectMoveDraftMessage() })}>
          <FolderInput size={14} aria-hidden="true" /><span>프로젝트 이동</span>
        </button>}
        <button ref={cloneCreationTrigger} className="btn btn-ghost issue-clone-trigger" type="button" aria-haspopup="dialog"
          aria-label="업무 복제" title="업무 복제" disabled={saving || dependencyBusy || jiraDeadlinePending} onClick={() => setCloneCreation(issue)}>
          <Copy size={14} aria-hidden="true" /><span>업무 복제</span>
        </button>
        <FavoriteAction type="issue" id={issue.id} />
        <NotificationSubscriptionButton actorId={props.actorId} targetType="issue" targetId={issue.id} notify={notify} />
        <button ref={closeButton} className="issue-icon-button" onClick={closePanel} disabled={saving || dependencyBusy || commenting || linking || jiraDeadlinePending} aria-label="업무 상세 닫기"><X size={20} /></button>
      </div>
    </header>
    {reviewPosition && onAdvanceReview && <nav className="issue-review-navigation" aria-label="업무 검토 순서">
      <button ref={previousReviewButton} className="btn" type="button" aria-label="이전 업무" title={reviewPosition.previous?.key}
        disabled={reviewBusy || !reviewPosition.previous} onClick={() => onAdvanceReview('previous')}>
        <ChevronLeft size={15} aria-hidden="true" />이전 업무
      </button>
      <span role="status">{reviewPosition.total.toLocaleString('ko-KR')}개 중 {reviewPosition.position.toLocaleString('ko-KR')}번째</span>
      <button ref={nextReviewButton} className="btn" type="button" aria-label="다음 업무" title={reviewPosition.next?.key}
        disabled={reviewBusy || !reviewPosition.next} onClick={() => onAdvanceReview('next')}>
        다음 업무<ChevronRight size={15} aria-hidden="true" />
      </button>
    </nav>}
    <div className="issue-panel-title">
      <span className="issue-type-label">
        <IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issueTypeMeta(data, issue.projectId, issue.type).name}
      </span>
      <h2 id="issue-panel-heading">{issue.title}</h2>
      {previousKeys.length > 0 && <div className="issue-panel-key-history">
        <span>이전 티켓 번호</span>
        <ul aria-label="이전 티켓 번호" role="list">
          {previousKeys.map(alias => <li key={`${alias.source}:${alias.key}`}>{issueSearchAliasLabel(alias)}</li>)}
        </ul>
      </div>}
      {parent && <button className="issue-parent-link" onClick={() => navigateIssue(parent.id)}>
        상위 업무 · {parent.key} {parent.title}<ArrowRight size={13} />
      </button>}
      {createdClone && data.issues.some(value => value.id === createdClone.id) && <button ref={createdCloneLink} className="btn" type="button"
        onClick={() => navigateIssue(createdClone.id)}>{createdClone.key} 복제 업무 열기<ArrowRight size={14} aria-hidden="true" /></button>}
      <div className="issue-panel-tabs">
        <button className={tab === 'details' ? 'active' : ''} onClick={() => switchTab('details')}>상세 정보</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => switchTab('activity')}><Clock3 size={14} /> 변경 이력</button>
        <button className={tab === 'worklogs' ? 'active' : ''} onClick={() => switchTab('worklogs')}>작업 시간</button>
        <button className={tab === 'reservations' ? 'active' : ''} onClick={() => switchTab('reservations')}>시간 배정</button>
        <button className={tab === 'source' ? 'active' : ''} onClick={() => switchTab('source')}>원본 기록</button>
      </div>
    </div>
    <div className="issue-panel-content">{tab === 'details' ? <>
      {(conflict || issue.version > draft.version) && <div className="issue-conflict-banner" role="alert"><div><strong>다른 변경사항이 있습니다</strong><p>작성 중인 내용은 유지됩니다. 편집 시작 버전은 {draft.version}, 현재 버전은 {issue.version}입니다. 최신 내용을 확인한 뒤 다시 편집하세요.</p></div><button className="btn" onClick={reloadLatest} disabled={saving}>최신 버전 불러오기</button></div>}
      <form className="issue-detail-form" onSubmit={save} aria-busy={saving}><fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <label className="issue-form-label">제목<input aria-label="제목" className="field issue-title-input" value={draft.title} onChange={e => update('title', e.target.value)} maxLength={300} required /></label>
        <IssueDescriptionEditor value={draft.description} format={draft.descriptionFormat ?? 'plain'} disabled={saving} initialPreview
          onChange={value => update('description', value)} onFormatChange={format => update('descriptionFormat', format)} />
        <div className="issue-properties"><div className="issue-section-caption">속성</div><div className="issue-form-grid">
          <label className="issue-form-label">상태<select ref={statusField} aria-label="상태" className="field" value={draft.status} onChange={e => update('status', e.target.value as Issue['status'])}>{!nextStatuses.some(status => status.id === draft.status) && <option value={draft.status} disabled>{statusMeta(data,draft.projectId,draft.status).label} (현재 허용되지 않음)</option>}{nextStatuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
          <label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={draft.projectId} value={draft.type} existingType={baseDraft?.type} onChange={value => update('type', value)} /></label>
          <label className="issue-form-label">우선순위<select aria-label="우선순위" className="field" value={draft.priority} onChange={e => update('priority', e.target.value as Issue['priority'])}>{Object.entries(PRIORITY).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label className="issue-form-label">담당자<select aria-label="담당자" className="field" value={draft.assigneeId || ''} onChange={e => update('assigneeId', e.target.value || null)}><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
          <label className="issue-form-label">시작일<input aria-label="시작일" type="date" className="field" value={draft.startDate || ''} onChange={e => update('startDate', e.target.value || null)} /></label>
          <label className="issue-form-label">종료일<input aria-label="종료일" type="date" className="field" value={draft.endDate || ''} onChange={e => update('endDate', e.target.value || null)} /></label>
          <label className="issue-form-label">목표 마감일<input aria-label="목표 마감일" type="date" className="field" value={draft.dueDate || ''} onChange={e => update('dueDate', e.target.value || null)} /></label>
          <label className="issue-form-label">요청자<IssueReporterSelect value={draft.reporterId} users={data.users} onChange={value => update('reporterId', value)} /></label>
          <div className="issue-grid-wide issue-date-actions">
            <button ref={rowScheduleOpener} className="btn" type="button" aria-haspopup="dialog" disabled={dependencyBusy || commenting}
              onClick={openRowScheduleEdit}><CalendarRange size={15} aria-hidden="true" />일정과 연결 편집</button>
            {teamFollowUpChoices.length > 0 && <button ref={teamFollowUpOpener} className="btn" type="button" aria-haspopup="dialog"
              disabled={reviewBusy} onClick={openTeamFollowUp}><CalendarRange size={15} aria-hidden="true" />프로젝트 간 일정 검토</button>}
            <button className="btn btn-ghost" type="button" disabled={dependencyBusy || commenting}
              onClick={() => onOpenIssueSchedule(issue.id)}><SquareChartGantt size={15} aria-hidden="true" />간트에서 일정 보기</button>
            {scheduleUndoId && <button ref={rowScheduleUndoButton} className="btn btn-ghost" type="button" disabled={dependencyBusy || commenting}
              onClick={() => void undoRowScheduleEdit()}><Undo2 size={15} aria-hidden="true" />일정과 연결 되돌리기</button>}
          </div>
          {scheduleWarnings.length > 0 && <div className="issue-grid-wide issue-schedule-warnings" role="status">
            <ul>{scheduleWarnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
            <button className="issue-icon-button" type="button" onClick={() => setScheduleWarnings([])} aria-label="일정 경고 닫기"><X size={14} aria-hidden="true" /></button>
          </div>}
          <label className="issue-form-label">예상 소요 (포인트)<input aria-label="예상 소요 (포인트)" className="field" type="number" min="0" step="0.5" placeholder="미정" value={draft.estimate ?? ''} onChange={e => update('estimate', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label className="issue-form-label">계획 작업 시간 (분)<input aria-label="계획 작업 시간 (분)" className="field" type="number" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} placeholder="미정" value={draft.plannedEffortMinutes ?? ''} onChange={e => update('plannedEffortMinutes', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label className="issue-form-label issue-grid-wide">상위 업무<select aria-label="상위 업무" className="field" value={draft.parentId || ''} onChange={e => update('parentId', e.target.value || null)}><option value="">없음</option>{data.issues.filter(i => i.projectId === draft.projectId && i.id !== issueId).map(i => <option key={i.id} value={i.id}>{i.key} · {i.title}</option>)}</select></label>
          <label className="issue-form-label">사이클<PlanningSelect data={data} projectId={draft.projectId} kind="cycle" value={draft.cycleId ?? null} legacyLabel={draft.cycle} onChange={id => updatePlanning('cycle', id)} /></label>
          <label className="issue-form-label">모듈<PlanningSelect data={data} projectId={draft.projectId} kind="module" value={draft.moduleId ?? null} legacyLabel={draft.module} onChange={id => updatePlanning('module', id)} /></label>
          <label className="issue-form-label">릴리스<PlanningSelect data={data} projectId={draft.projectId} kind="release" value={draft.releaseId ?? null} legacyLabel={draft.release} onChange={id => updatePlanning('release', id)} /></label>
          <label className="issue-form-label">라벨<input aria-label="라벨" className="field" placeholder="쉼표로 구분" value={labels} onChange={e => setLabels(e.target.value)} /></label>
          <label className="issue-form-label issue-grid-wide">참여자<select multiple className="field issue-collaborator-select" aria-label="참여자 선택 (Ctrl 또는 Cmd로 여러 명 선택)" value={draft.collaboratorIds} onChange={e => update('collaboratorIds', Array.from(e.target.selectedOptions).map(o => o.value))}>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select><small className="muted">Ctrl 또는 ⌘를 누르고 여러 명을 선택하세요.</small></label>
        </div></div>
        <CustomFields data={data} projectId={draft.projectId} issueType={draft.type} status={draft.status} values={draft.customFields || {}} existingValues={baseDraft?.customFields || {}} onChange={value => update('customFields', value)} disabled={saving} requiredFields={requiredFields} />
        {requiredFields.length > 0 && <p className="issue-section-empty">이 유형·상태의 필수 속성: {requiredFieldLabels(data, draft.projectId, requiredFields).join(', ')}</p>}
        {error && <div className="issue-form-error">
          <div role="alert">{error.message}</div>
          {error.openBlockers && <button className="btn issue-transition-blocker-action" type="button"
            onClick={() => relationControls.current?.focusBlockers()}>차단 업무 보기</button>}
        </div>}
        <div className="issue-save-row"><span className="muted">편집 버전 {draft.version}{dirty ? ' · 저장하지 않은 변경사항' : ` · ${relativeTime(issue.updatedAt)} 수정`}</span><button className="btn btn-primary" type="submit" disabled={saving || dependencyBusy || !dirty}><Save size={15} />{saving ? '저장 중…' : '변경사항 저장'}</button></div>
      </fieldset></form>
      {linkedMilestones.length > 0 && <section className="issue-related-section" aria-label="연결된 이정표">
        <h3><Flag size={16} aria-hidden="true" />연결된 이정표 <span>{linkedMilestones.length}</span></h3>
        <ul className="issue-milestone-list" role="list">
          {linkedMilestones.map(item => <li key={item.id}>
            <div><strong>{item.title}</strong><small><time dateTime={item.date}>{item.date}</time> · {item.status === 'reached' ? '달성' : '예정'}</small></div>
            <a className="btn btn-ghost" href={`#/${encodeURIComponent(item.projectId)}/gantt?${new URLSearchParams({ milestone: item.id })}`}
              aria-label={`${item.title} 간트에서 보기`} onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); onOpenMilestone(item.id);
              }}><SquareChartGantt size={15} aria-hidden="true" />간트에서 보기</a>
          </li>)}
        </ul>
      </section>}
      <section className="issue-related-section" aria-label="업무 의존성">
        <div className="issue-schedule-heading">
          <h3><Link2 size={16} aria-hidden="true" />업무 의존성 <span>{dependencies.length}</span></h3>
          <div className="issue-schedule-actions">
            <button ref={addPredecessorButton} className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'predecessor')}><Plus size={14} aria-hidden="true" />선행 업무 추가</button>
            <button className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'successor')}><Link2 size={14} aria-hidden="true" />기존 후행 업무 연결</button>
            {(['predecessor', 'successor'] as const).map(direction => (
              <button key={direction} className="btn" type="button" disabled={saving || dependencyBusy}
                onClick={event => setScheduleIssueCreation({ link: { direction, issue }, opener: event.currentTarget })}>
                <Plus size={14} aria-hidden="true" />새 {direction === 'predecessor' ? '선행' : '후행'} 업무 추가
              </button>
            ))}
          </div>
        </div>
        {!dependencies.length && <p className="issue-section-empty">연결된 선행·후행 업무가 없습니다.</p>}
        {dependencies.map(dependency => {
          const otherIsSuccessor = dependency.predecessorId === issueId;
          const related = data.issues.find(value => value.id === (otherIsSuccessor ? dependency.successorId : dependency.predecessorId));
          if (!related) return null;
          return <div className="issue-schedule-relation" key={dependency.id}>
            <button type="button" className="issue-related-row" data-related-schedule-issue={related.id} onClick={() => navigateIssue(related.id)}>
              <span className="muted">{otherIsSuccessor ? '후행' : '선행'}</span>
              <span className="issue-key">{related.key}</span>
              <span className="issue-dependency-description"><span>{related.title}</span><small>{dependencyLabel(dependency)}</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <div className="issue-schedule-row-actions">
              <button type="button" className="issue-icon-button" aria-label={`${related.key} 연결 수정`} title="연결 수정" disabled={saving || dependencyBusy}
                onClick={event => openDependencyEditor(event.currentTarget, otherIsSuccessor ? 'successor' : 'predecessor', dependency)}><Pencil size={15} aria-hidden="true" /></button>
              <button type="button" className="issue-icon-button" aria-label={`${related.key} 연결 해제`} title="연결 해제" disabled={saving || dependencyBusy}
                onClick={event => void unlinkDependency(dependency, event.currentTarget)}><X size={15} aria-hidden="true" /></button>
            </div>
          </div>;
        })}
      </section>
      <section className="issue-related-section" aria-label="하위 업무">
        <div className="issue-children-heading">
          <h3><LayersIcon />하위 업무 <span>{children.length}</span></h3>
          {children.length > 0 && <span className="issue-children-completed">완료 {completedChildren}개</span>}
          <button ref={childCreationTrigger} className="btn" type="button" disabled={saving} onClick={() => setChildCreation(issue)}>
            <Plus size={14} aria-hidden="true" />하위 업무 추가
          </button>
        </div>
        {children.map(({ child, status }) => <button type="button" className="issue-related-row" key={child.id} onClick={() => navigateIssue(child.id)}>
          <IssueTypeIcon type={child.type} data={data} projectId={child.projectId} /><span className="issue-key">{child.key}</span><span>{child.title}</span>
          <span className="issue-related-status" style={{ color: status.color }}>{status.label}</span><ChevronRight size={14} aria-hidden="true" />
        </button>)}
      </section>
      <IssueRelations issue={savedRelationIssue} data={data} openIssue={navigateIssue} refresh={refresh} notify={notify}
        refreshKey={relationsRefreshKey} disabled={saving || dependencyBusy} controlsRef={relationControls} highlightOpenBlockers={Boolean(error?.openBlockers)}
        duplicateCloseDisabled={conflict || baseDraft?.version !== savedRelationIssue.version}
        hasUnsavedStatus={draft.status !== baseDraft?.status} onDuplicateClosed={reflectDuplicateClosure}
        onCreateBlockedIssue={opener => setBlockedIssueCreation({ issue: savedRelationIssue, opener })}
        onDraftChange={trackRelationDraft} onReviewSchedule={openRelationScheduleReview} />
      <section className="issue-related-section issue-linked-documents" aria-label="연결된 문서">
        <div className="issue-linked-documents-heading">
          <h3><FileText size={16} aria-hidden="true" /> 연결된 문서 <span>{linkedDocuments.length}</span></h3>
          <button ref={linkedDocumentOpener} className="btn" type="button" aria-haspopup="dialog"
            disabled={saving || dependencyBusy || linking || commenting || Boolean(commentEditing.operation)} onClick={() => setLinkedDocumentCreation(true)}>
            <Plus size={14} aria-hidden="true" />새 연결 문서 만들기
          </button>
        </div>
        {linkNotice && <div className="issue-link-notice">
          <p className="issue-form-error" role="alert">{linkNotice.message}</p>
          {linkNotice.reload && <button className="btn" type="button" disabled={linking}
            onClick={event => void reloadLinkedDocuments(event.currentTarget)}>문서 연결 다시 불러오기</button>}
        </div>}
        {linkedDocuments.map(link => {
          const doc = data.documents.find(d => d.id === link.documentId);
          if (!doc) return null;
          const source = link.documentSource;
          return <div key={link.id}>
            {linkedDocumentRow(doc, link)}
            {source && <section className="issue-decision-source" aria-label="결정 근거">
              <h4>결정 근거</h4>
              <blockquote>{source.text}</blockquote>
              <Suspense fallback={<p className="issue-section-empty" role="status">원문 저장본 열기를 준비하는 중…</p>}>
                <DocumentDecisionRevision key={source.revisionId} data={data} documentId={doc.id} revisionId={source.revisionId} label={doc.title}
                  selection={source} />
              </Suspense>
            </section>}
          </div>;
        })}
        <ResourceLinkPicker kind="document" items={availableDocuments} projects={data.projects} busy={linking} onLink={linkDocument} />
      </section>
      {bodyOnlyReferences.length > 0 && <section className="issue-related-section issue-linked-documents" aria-label="본문에서 이 업무를 참조한 문서">
        <h3><Link2 size={16} aria-hidden="true" /> 본문에서 이 업무를 참조한 문서 <span>{bodyOnlyReferences.length}</span></h3>
        {bodyOnlyReferences.map(({ document }) => <div key={document.id}>{linkedDocumentRow(document)}</div>)}
      </section>}
      <AtlassianLinks targetType="issue" targetId={issue.id} actorId={props.actorId} notify={notify} />
      <IssueGitlabActivity issueId={issue.id} issueKey={issue.key} issueVersion={issue.version} links={gitlabLinks} refresh={refresh} notify={notify}
        disabled={saving || dependencyBusy} onDraftChange={trackGitlabDraft} isCurrentStatusSuggestion={isCurrentGitlabStatusSuggestion}
        canPrepareStatusSuggestion={canPrepareGitlabStatusSuggestion} onPrepareStatusSuggestion={prepareGitlabStatusSuggestion} />
      <IssueAutomationHistory issueId={issue.id} issueVersion={issue.version} links={gitlabLinks} users={data.users} refresh={refresh}
        canPrepareStatus={canPrepareAutomationStatus} onPrepareStatus={prepareAutomationStatus} />
      <section className="issue-related-section"><Attachments resourceType="issue" resourceId={issueId} actorId={props.actorId} notify={notify} onChanged={refresh}/></section>
      <section className="issue-related-section issue-comments">
        <h3 ref={commentsHeading} tabIndex={-1}><MessageSquare size={16} /> 댓글 <span>{comments.length}</span></h3>
        {loadingComments ? <p className="issue-section-empty">댓글을 불러오는 중…</p> : comments.length === 0 ? <p className="issue-section-empty">논의와 결정사항을 남겨주세요.</p> : comments.map(comment => {
          const user = data.users.find(value => value.id === comment.authorId);
          return <article id={`issue-comment-${comment.id}`} key={comment.id} className="issue-comment" tabIndex={-1}>
            <span className="issue-avatar" style={{ background: user?.color || '#8996a4' }}>{user?.name.slice(0, 1) || '?'}</span>
            <div>
              <header><strong>{user?.name || '알 수 없는 사용자'}</strong><time title={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
                <CommentEditedMark comment={comment} />
                <CommentEditButton comment={comment} editing={commentEditing} disabled={commenting || saving} />
                <CommentTrashButton comment={comment} actorId={props.actorId} notify={notify} refresh={refresh}
                  disabled={commenting || saving || commentEditing.current?.base.id === comment.id}
                  onArchived={removed => setComments(previous => previous.filter(value => value.id !== removed.id))} />
              </header>
              <CommentEditBody comment={comment} editing={commentEditing} users={data.users} />
              {comment.jiraOriginalLinksAvailable && <JiraOriginalCommentLinks key={props.actorId} commentId={comment.id} actorId={props.actorId} />}
            </div>
          </article>;
        })}
        {commentEditing.current && !comments.some(comment => comment.id === commentEditing.current?.base.id) &&
          <CommentEditBody comment={commentEditing.current.base} editing={commentEditing} users={data.users} />}
        {commentError && <div className="issue-form-error" role="alert">{commentError}</div>}
        <form onSubmit={addComment}>
          <CommentMentionInput className="field" placeholder="댓글을 작성하세요…" aria-label="댓글 내용" draft={commentDraft}
            onChange={setCommentDraft} users={data.users} rows={3} required maxLength={10000} readOnly={commenting} />
          <div className="issue-comment-submit"><button className="btn" disabled={!commentDraft.body.trim() || commenting} type="submit"><Plus size={14} />{commenting ? '등록 중…' : '댓글 등록'}</button></div>
        </form>
      </section>
      <section className="issue-danger-zone">{deleteConfirm ? <><p><strong>{issue.key} 업무를 휴지통으로 옮길까요?</strong><br /><span>휴지통에서 업무를 복원할 수 있습니다. 이미 기록한 작업 시간은 프로젝트 보고서에 남습니다.{(dirty || commentDraft.body.trim() || commentEditing.dirty) && ' 저장하지 않은 편집과 보내지 않은 댓글은 사라집니다.'}</span></p><div><button className="btn btn-ghost" onClick={() => setDeleteConfirm(false)} disabled={saving}>취소</button><button className="btn issue-btn-danger" onClick={deleteIssue} disabled={saving || commenting || Boolean(commentEditing.operation)}>휴지통으로 이동</button></div></> : <button className="btn btn-ghost" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> 업무 삭제</button>}</section>
    </> : tab === 'worklogs' ? <IssueWorklogs issueId={issue.id} actorId={props.actorId} users={data.users}
      notify={notify} onChanged={refresh} onDraftChange={trackChildDraft}/>
    : tab === 'reservations' ? <TimeReservations issue={issue} actorId={props.actorId} users={data.users} notify={notify} onDraftChange={trackChildDraft} onChanged={refresh} />
    : tab === 'source' ? <>
      <JiraDeadlineRecovery issueId={issue.id} issueVersion={issue.version} actorId={props.actorId}
        blockedReason={deadlineRecoveryBlocked} onPendingChange={trackJiraDeadlinePending}
        onObserved={version => reflectIssueSchedule(version, 'all')} />
      <SourceOrigins resourceType="issue" resourceId={issue.id} />
    </> : <>
      <IssueChangeHistory issueId={issue.id} issueVersion={issue.version} />
      <section className="issue-activity-list" aria-label="Teamspace 변경 이력">
        <h3 className="issue-history-heading">Teamspace 변경 이력</h3>
        {activities.length ? activities.map(activity => {
          const user = data.users.find(candidate => candidate.id === activity.actorId);
          return <article key={activity.id}>
            <span className="issue-activity-dot"><Check size={12} aria-hidden="true" /></span>
            <div><p><strong>{user?.name || '시스템'}</strong> · {activity.detail || activity.action}</p>
              <time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString('ko-KR')}</time></div>
          </article>;
        }) : <p>아직 Teamspace 변경 이력이 없습니다.</p>}
      </section>
      <IssueJiraStatusHistory issueId={issue.id} />
    </>}</div>
    </aside></div>
    {previewDocument && <IssueDocumentPreview key={previewDocument.id} data={data} document={previewDocument}
      referenceIssueId={bodyReferences.has(previewDocument.id) ? issueId : undefined}
      onClose={onCloseDocumentPreview} onOpenDocument={() => navigateDocument(previewDocument.id)}
      openIssue={id => { if (id === issueId) onCloseDocumentPreview(); else navigateIssue(id); }} openDocument={navigateDocument} />}
    {childCreation && <NewIssueModal {...props} parentIssue={childCreation} onClose={closeChildCreation} />}
    {cloneCreation && <NewIssueModal {...props} cloneIssue={cloneCreation} onClose={closeCloneCreation}
      onCloneCreated={showCreatedClone} refresh={refreshIssueRelations} />}
    {projectMove && <IssueProjectMove data={data} issue={issue} draftMessage={projectMove.draftMessage} beforeApply={projectMoveDraftMessage}
      onDraftChange={trackProjectMoveDraft} onClose={closeProjectMove} refresh={refreshIssueRelations} />}
    {linkedDocumentCreation && <IssueLinkedDocumentCreate data={data} issue={issue} actorId={props.actorId} refresh={refresh}
      onDraftChange={trackLinkedDocumentDraft} onClose={closeLinkedDocumentCreation} onCreated={showCreatedLinkedDocument} />}
    {scheduleIssueCreation && <NewIssueModal {...props} scheduleLink={scheduleIssueCreation.link}
      onClose={closeScheduleIssueCreation} onScheduleIssueCreated={focusCreatedScheduleIssue} />}
    {blockedIssueCreation && <NewIssueModal {...props} blockedByIssue={blockedIssueCreation.issue}
      onClose={closeBlockedIssueCreation} refresh={refreshIssueRelations} />}
    {rowScheduleEdit && <GanttRowScheduleEdit issue={rowScheduleEdit.issue} initialDates={rowScheduleEdit.initialDates}
      initialDateDraft={rowScheduleEdit.initialDateDraft} datesFromGantt={Boolean(rowScheduleEdit.ganttDateDraft)}
      issues={data.issues} issueAliases={data.issueAliases}
      incomingTeamBlockers={teamBlockers.incoming.get(rowScheduleEdit.issue.id)}
      outgoingTeamBlockers={teamBlockers.outgoing.get(rowScheduleEdit.issue.id)}
      dependencies={data.dependencies} calendar={data.calendars?.find(value => value.projectId === rowScheduleEdit.issue.projectId)}
      actorId={props.actorId} undoScope={scheduleUndoScope ?? undefined} notify={notify} refresh={refresh} onDraftChange={trackRowScheduleDraft}
      onClose={closeRowScheduleEdit} onApplied={reflectRowScheduleEdit} />}
    {teamFollowUp && (teamFollowUp.choosing ? <GanttTeamFollowUpChooser source={teamFollowUp.source} choices={teamFollowUp.choices}
      projects={data.projects} onChoose={chooseTeamFollowUps} onClose={closeTeamFollowUp} />
      : scheduleUndoScope && <GanttCascadeDialog teamFollowUp={teamFollowUp} projects={data.projects} actorId={props.actorId} undoScope={scheduleUndoScope}
        onClose={closeTeamFollowUp} onApplied={reflectTeamFollowUp} onBusyChange={trackTeamFollowUpBusy}
        onInputDirtyChange={trackTeamFollowUpDirty} onOutcomeUnknownChange={trackTeamFollowUpOutcome} />)}
    {dependencyEditor && <GanttDependencyModal issues={data.issues} issueAliases={data.issueAliases} dependency={editingDependency}
      anchor={dependencyEditor.otherRole ? { issueId, otherRole: dependencyEditor.otherRole } : undefined}
      relationReview={relationScheduleReview && { sourceIssueId: relationScheduleReview.relation.sourceIssueId,
        targetIssueId: relationScheduleReview.relation.targetIssueId, mode: relationScheduleReview.mode }}
      staleMessage={staleDependencyMessage} busy={dependencyBusy}
      onClose={closeDependencyEditor} onSubmit={saveDependency} onDraftChange={trackDependencyDraft} />}
  </>;
}

function LayersIcon() { return <span className="issue-subtask-icon">↳</span>; }
