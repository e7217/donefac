'use client';

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, Check, ChevronRight, Clock3, Copy, Eye, FileText, FolderInput, Link2, MessageSquare, Pencil, Plus, Save, SquareChartGantt, Trash2, X } from 'lucide-react';
import { PRIORITY, type AutomationRun, type Comment, type Dependency, type DocPage, type FeatureProps, type Issue, type IssueRelation, type ResourceLink, type WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError, patch, post, relativeTime, remove } from '../lib/api';
import { allowedNextStatuses, requiredFieldsFor, statusMeta } from '../../shared/workflow-helpers';
import { IssueTypeIcon } from './Issues';
import { PlanningSelect } from './PlanningSelectors';
import { issueTypeMeta, requiredFieldLabels } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { findIssueDocumentReferences } from '../../shared/document-references';
import type { IssueRelationScheduleMode } from '../../shared/issue-relations';
import { CustomFields, IssueTypeSelect } from './CustomFields';
import { NewIssueModal, type SchedulePredecessor } from './NewIssueModal';
import { SourceOrigins } from './SourceOrigins';
import { IssueRelations, type IssueRelationsHandle } from './IssueRelations';
import { Attachments } from './Attachments';
import { COMMENT_LIST_CHANGED, CommentTrashButton } from './CommentTrashButton';
import { CommentMentionInput, CommentMentionText, commentDraftPayload, emptyCommentDraft } from './CommentMentions';
import { IssueWorklogs } from './IssueWorklogs';
import { TimeReservations } from './TimeReservations';
import { IssueGitlabActivity } from './IssueGitlabActivity';
import { IssueDescriptionEditor } from './IssueDescriptionEditor';
import { IssueAutomationHistory } from './IssueAutomationHistory';
import { IssueJiraStatusHistory } from './IssueJiraStatusHistory';
import { IssueDocumentPreview } from './IssueDocumentPreview';
import { IssueProjectMove } from './IssueProjectMove';
import { ResourceLinkPicker } from './ResourceLinkPicker';
import { NotificationSubscriptionButton } from './NotificationSubscriptionButton';
import { AtlassianLinks } from './AtlassianLinks';
import { afterAcceptedNavigation } from '../lib/navigation';
import { dependencyLabel, errorMessage } from './schedule-utils';
import { GanttDependencyModal, type DependencyInput, type RelatedIssueDirection } from './GanttDependencyModal';
import './issues.css';
import './issue-decision-source.css';

const DocumentDecisionRevision = lazy(() => import('./DocumentBlocks').then(module => ({ default: module.DocumentDecisionRevision })));
type RelationScheduleReview = { relation: IssueRelation; mode: IssueRelationScheduleMode; reload: () => Promise<void> };
type IssueDependencyEditor =
  | { otherRole: RelatedIssueDirection; dependency?: Dependency; review?: never }
  | { otherRole?: never; dependency?: never; review: RelationScheduleReview };
type ChildDraft = { dirty: boolean; pending: boolean; discard: () => void; label?: string };
type IssueEditError = { message: string; openBlockers?: boolean };
type IssuePanelProps = FeatureProps & {
  issueId: string;
  documentOverlay?: boolean;
  modalFocus?: boolean;
  previewDocumentId: string | null;
  commentFocus?: { commentId: string; activation: number };
  onClose: () => void;
  onOpenIssueSchedule: (id: string) => boolean;
  onPreviewDocument: (id: string) => boolean;
  onCloseDocumentPreview: () => boolean;
};

function editableIssue(issue: Issue, labels: string) {
  return { title: issue.title.trim(), description: issue.description, descriptionFormat: issue.descriptionFormat ?? 'plain', type: issue.type, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId, collaboratorIds: issue.collaboratorIds, parentId: issue.parentId, labels: [...new Set(labels.split(',').map(value => value.trim()).filter(Boolean))], startDate: issue.startDate, endDate: issue.endDate, dueDate: issue.dueDate, estimate: issue.estimate, plannedEffortMinutes: issue.plannedEffortMinutes ?? null, cycleId: issue.cycleId ?? null, moduleId: issue.moduleId ?? null, releaseId: issue.releaseId ?? null, customFields: issue.customFields || {} };
}

function isOpenBlockerError(cause: unknown) {
  return cause instanceof ApiError && cause.status === 422 && cause.details !== null &&
    typeof cause.details === 'object' && 'reason' in cause.details && cause.details.reason === 'open_issue_blockers';
}

export function IssuePanel(props: IssuePanelProps) {
  const panel = <IssuePanelContent key={`${props.issueId}:${props.actorId}`} {...props} />;
  return props.documentOverlay ? <div className="issue-panel-document-layer">{panel}</div> : panel;
}

function IssuePanelContent(props: IssuePanelProps) {
  const { data, issueId, documentOverlay, modalFocus, previewDocumentId, commentFocus, onClose, onOpenIssueSchedule, onPreviewDocument, onCloseDocumentPreview,
    refresh, notify, openIssue, openDocument } = props;
  const manageFocus = Boolean(documentOverlay || modalFocus);
  const issue = data.issues.find(i => i.id === issueId);
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
  const [labels, setLabels] = useState(issue?.labels.join(', ') || '');
  const [comments, setComments] = useState<Comment[]>([]);
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
  const [schedulePredecessor, setSchedulePredecessor] = useState<SchedulePredecessor | null>(null);
  const successorCreationTrigger = useRef<HTMLButtonElement>(null);
  function closeSuccessorCreation() {
    setSchedulePredecessor(null);
    requestAnimationFrame(() => successorCreationTrigger.current?.focus({ preventScroll: true }));
  }
  function focusCreatedSuccessor(successor: Issue) {
    requestAnimationFrame(() => {
      const button = issuePanel.current?.querySelector<HTMLButtonElement>(`[data-related-schedule-issue="${CSS.escape(successor.id)}"]`);
      button?.focus();
    });
  }
  const [dependencyEditor, setDependencyEditor] = useState<IssueDependencyEditor | null>(null);
  const [projectMove, setProjectMove] = useState<{ draftMessage: string | null } | null>(null);
  const projectMoveTrigger = useRef<HTMLButtonElement>(null);
  const projectMoveGuard = useRef({ dirty: false, pending: false, uncertain: false });
  const trackProjectMoveDraft = useCallback((dirty: boolean, pending: boolean, uncertain = false) => { projectMoveGuard.current = { dirty, pending, uncertain }; }, []);
  const closeProjectMove = useCallback((restoreFocus = true) => {
    trackProjectMoveDraft(false, false);
    setProjectMove(null);
    if (restoreFocus) requestAnimationFrame(() => projectMoveTrigger.current?.focus({ preventScroll: true }));
  }, [trackProjectMoveDraft]);
  const nestedModalOpen = Boolean(childCreation || cloneCreation || schedulePredecessor || dependencyEditor || projectMove);
  const [dependencyBusy, setDependencyBusy] = useState(false);
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
  }, [notify, tab]);
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
    if (!dirty) { setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || ''); setError(null); setConflict(false); setDeleteConfirm(false); }
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
      if (savingRef.current || childDrafts.some(value => value?.pending) || dependencyBusyRef.current || projectMoveGuard.current.pending) {
        event.preventDefault();
        notify('저장이 끝난 후 이동해주세요.', 'error');
        return;
      }
      const childNames = childDrafts.flatMap(value => value?.dirty ? [value.label ?? (tab === 'reservations' ? '시간 배정 입력' : '작업 시간 기록')] : []);
      if (dependencyDraftRef.current) childNames.push('업무 연결 입력');
      const moveGuard = projectMoveGuard.current;
      const moveDiscard = moveGuard.uncertain ? '이동 결과를 아직 확인하지 못했습니다. 다른 화면으로 이동할까요?' : '작성 중인 프로젝트 이동 설정을 버릴까요?';
      if (moveGuard.dirty && !dirtyRef.current && !childNames.length && !window.confirm(moveDiscard)) {
        event.preventDefault();
        return;
      }
      if (moveGuard.dirty && (dirtyRef.current || childNames.length)) childNames.push(moveGuard.uncertain ? '프로젝트 이동 결과 확인' : '프로젝트 이동 설정');
      if (dirtyRef.current || childNames.length) {
        const message = childNames.length ? `저장하지 않은 업무·댓글·${childNames.join('·')}을 버리고 이동할까요?`
          : '저장하지 않은 업무 변경사항이나 작성 중인 댓글이 있습니다. 내용을 버리고 이동할까요?';
        if (!window.confirm(message)) event.preventDefault();
        else afterAcceptedNavigation(event, () => {
          for (const value of childDrafts) value?.discard();
          setDependencyEditor(null);
          dirtyRef.current = false;
          setDraft(issue); setBaseDraft(issue); setLabels(issue?.labels.join(', ') || '');
          setCommentDraft(emptyCommentDraft()); setError(null); setConflict(false);
        });
      }
      if (projectMove) afterAcceptedNavigation(event, () => closeProjectMove(false));
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !childDraft.current && !gitlabDraft.current && !dependencyDraftRef.current && !dependencyBusyRef.current &&
          !projectMoveGuard.current.dirty && !projectMoveGuard.current.pending) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', leave); };
  }, [issue, notify, tab, projectMove, closeProjectMove]);
  useEffect(() => {
    let activeRequest: AbortController | undefined;
    const loadComments = () => {
      activeRequest?.abort();
      const request = new AbortController();
      activeRequest = request;
      void api<Comment[]>(`/comments?resourceType=issue&resourceId=${encodeURIComponent(issueId)}`, {
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
    if (manageFocus) closeButton.current?.focus({ preventScroll: true });
  }, [manageFocus]);
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
      if (!saving && !dependencyBusyRef.current) closePanel();
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
  function projectMoveDraftMessage() {
    const childDrafts = [childDraft.current, gitlabDraft.current];
    if (savingRef.current || commenting || linkingRef.current || dependencyBusyRef.current || childDrafts.some(value => value?.pending)) {
      return '현재 작업을 저장한 뒤 프로젝트를 이동해 주세요.';
    }
    if (dirty || commentDraft.body.trim() || dependencyDraftRef.current || childDrafts.some(value => value?.dirty)) {
      return '이동을 적용하려면 창을 닫고 저장하지 않은 업무 변경사항이나 작성 중인 댓글·연결을 먼저 정리해 주세요.';
    }
    return null;
  }
  function update<K extends keyof Issue>(key: K, value: Issue[K]) {
    if ((key === 'status' || key === 'type') && draft?.[key] !== value && error?.openBlockers) setError(null);
    setDraft(previous => previous ? { ...previous, [key]: value } : previous);
  }
  function canPrepareAutomationStatus(run: AutomationRun) {
    return Boolean(issue && draft && baseDraft && !conflict && !saving && !dependencyBusy && !commenting &&
      draft.version === issue.version && baseDraft.status === issue.status && draft.status === baseDraft.status &&
      run.issueId === issue.id && run.projectId === issue.projectId && run.outcome === 'blocked' && run.fromStatus === issue.status &&
      run.toStatus !== issue.status && nextStatuses.some(status => status.id === run.toStatus));
  }
  function prepareAutomationStatus(run: AutomationRun) {
    if (!canPrepareAutomationStatus(run)) return;
    if (savingRef.current || dependencyBusyRef.current || gitlabDraft.current?.pending || childDraft.current?.pending) {
      notify('현재 작업을 저장한 뒤 상태를 편집해 주세요.', 'error');
      return;
    }
    update('status', run.toStatus);
    setError(null);
    statusField.current?.focus();
  }
  function updatePlanning(kind: 'cycle' | 'module' | 'release', id: string | null) { setDraft(previous => previous ? { ...previous, [`${kind}Id`]: id, [kind]: data.planningItems?.find(item => item.id === id)?.name || null } : previous); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !issue || savingRef.current || dependencyBusyRef.current || childDraft.current?.pending) return; savingRef.current = true; setSaving(true); setError(null);
    try {
      const { descriptionFormat, ...fields } = editableIssue(draft, labels);
      const changedFormat = descriptionFormat !== (baseDraft?.descriptionFormat ?? 'plain');
      const updated = await patch<Issue>(`/issues/${issueId}`, { expectedVersion: draft.version, ...fields,
        ...(changedFormat ? { descriptionFormat } : {}) });
      setDraft(updated); setBaseDraft(updated); setLabels(updated.labels.join(', ')); setConflict(false); dirtyRef.current = false;
      await refresh(); notify(`${issue.key} 변경사항을 저장했습니다.`);
    } catch (err) {
      const openBlockers = isOpenBlockerError(err);
      setError({ message: errorMessage(err), openBlockers });
      if (openBlockers) {
        setRelationsRefreshKey(key => key + 1);
        void refresh().catch(() => undefined);
      }
      if (err instanceof ApiError && err.status === 409) { setConflict(true); await refresh().catch(() => undefined); }
    } finally { savingRef.current = false; setSaving(false); }
  }
  async function reloadLatest() {
    const hadUnsaved = dirtyRef.current;
    if (!confirmDiscard()) return;
    savingRef.current = true; setSaving(true);
    try { const snapshot = await api<WorkspaceSnapshot>('/workspace'); const latest = snapshot.issues.find(value => value.id === issueId); if (!latest) throw new Error('업무가 삭제되었거나 더 이상 존재하지 않습니다.'); setDraft(latest); setBaseDraft(latest); setLabels(latest.labels.join(', ')); setCommentDraft(emptyCommentDraft()); setConflict(false); setError(null); dirtyRef.current = false; await refresh(); }
    catch (err) { dirtyRef.current = hadUnsaved; setError({ message: errorMessage(err) }); } finally { savingRef.current = false; setSaving(false); }
  }
  async function deleteIssue() {
    if (gitlabDraft.current?.pending) { notify('GitLab 연결 변경이 끝난 뒤 업무를 휴지통으로 옮겨 주세요.', 'error'); return; }
    if (!issue || savingRef.current || commenting || dependencyBusyRef.current || childDraft.current?.pending) return;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      await remove(`/issues/${issueId}?expectedVersion=${draft?.version ?? issue.version}`);
      window.dispatchEvent(new Event('teamspace:trash-changed'));
      dirtyRef.current = false;
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
    if (!payload.body || commenting) return;
    setCommenting(true); setCommentError('');
    try {
      const value = await api<Comment>('/comments', { method: 'POST', headers: { 'X-Actor-Id': props.actorId },
        body: JSON.stringify({ resourceType: 'issue', resourceId: issueId, ...payload }) });
      setComments(previous => previous.some(item => item.id === value.id) ? previous : [...previous, value]);
      setCommentDraft(emptyCommentDraft());
      window.dispatchEvent(new Event(COMMENT_LIST_CHANGED));
      await refresh();
    }
    catch (err) { setCommentError(errorMessage(err)); } finally { setCommenting(false); }
  }
  async function linkDocument(documentId: string) {
    if (linkingRef.current) return false;
    linkingRef.current = true;
    setLinking(true);
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
  async function unlinkDocument(id: string) { try { await remove(`/resource-links/${id}`); await refresh(); notify('문서 연결을 해제했습니다.'); } catch (err) { notify(errorMessage(err), 'error'); } }
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
    const space = link ? undefined : data.projects.find(project => project.id === doc.projectId)?.name ?? '팀 공통';
    const title = doc.title || '제목 없는 문서';
    return <div className="issue-related-row">
      <FileText size={15} aria-hidden="true" />
      <div className="issue-document-entry">
        <button type="button" onClick={() => navigateDocument(doc.id)} className="issue-document-link">{title}</button>
        {(space || count) && <small className="issue-document-entry-meta">
          {space && <span>{space}</span>}
          {count && <span>본문 참조 {count}곳</span>}
        </small>}
      </div>
      <button type="button" className="issue-document-preview-trigger" aria-label={`${title} 미리보기`} data-preview-document-id={doc.id}
        onClick={event => {
          if (onPreviewDocument(doc.id)) previewOpener.current = event.currentTarget;
        }}><Eye size={14} aria-hidden="true" />미리보기</button>
      {link && <button type="button" className="issue-icon-button" onClick={() => unlinkDocument(link.id)}
        aria-label={`${title} 연결 해제`} title="연결 해제"><X size={14} /></button>}
    </div>;
  }
  const parent = data.issues.find(i => i.id === issue.parentId);
  return <>
    <div className="issue-panel-backdrop" inert={nestedModalOpen || Boolean(previewDocument)} onMouseDown={event => {
      if (event.target === event.currentTarget && !saving && !nestedModalOpen && !dependencyBusyRef.current) closePanel();
    }}><aside ref={issuePanel} className="issue-detail-panel" role="dialog" aria-modal="true" aria-labelledby="issue-panel-heading"
      tabIndex={manageFocus ? -1 : undefined} onKeyDown={manageFocus ? keepIssuePanelFocus : undefined}>
    <header className="issue-panel-header">
      <div className="issue-panel-breadcrumb"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} /><span>{data.projects.find(p => p.id === issue.projectId)?.name}</span><ChevronRight size={13} /><strong>{issue.key}</strong></div>
      <div className="issue-panel-header-actions">
        {data.projects.some(project => project.id !== issue.projectId) && <button ref={projectMoveTrigger}
          className="btn btn-ghost issue-move-trigger" type="button" aria-haspopup="dialog" aria-label="프로젝트 이동" title="프로젝트 이동"
          disabled={saving || commenting || dependencyBusy || linking} onClick={() => setProjectMove({ draftMessage: projectMoveDraftMessage() })}>
          <FolderInput size={14} aria-hidden="true" /><span>프로젝트 이동</span>
        </button>}
        <button ref={cloneCreationTrigger} className="btn btn-ghost issue-clone-trigger" type="button" aria-haspopup="dialog"
          aria-label="업무 복제" title="업무 복제" disabled={saving || dependencyBusy} onClick={() => setCloneCreation(issue)}>
          <Copy size={14} aria-hidden="true" /><span>업무 복제</span>
        </button>
        <NotificationSubscriptionButton actorId={props.actorId} targetType="issue" targetId={issue.id} notify={notify} />
        <button ref={closeButton} className="issue-icon-button" onClick={closePanel} disabled={saving || dependencyBusy} aria-label="업무 상세 닫기"><X size={20} /></button>
      </div>
    </header>
    <div className="issue-panel-title">
      <span className="issue-type-label">
        <IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issueTypeMeta(data, issue.projectId, issue.type).name}
      </span>
      <h2 id="issue-panel-heading">{issue.title}</h2>
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
          <div className="issue-grid-wide"><button className="btn btn-ghost" type="button" disabled={dependencyBusy || commenting}
            onClick={() => onOpenIssueSchedule(issue.id)}><SquareChartGantt size={15} aria-hidden="true" />간트에서 일정 보기</button></div>
          <label className="issue-form-label">목표 마감일<input aria-label="목표 마감일" type="date" className="field" value={draft.dueDate || ''} onChange={e => update('dueDate', e.target.value || null)} /></label>
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
      <section className="issue-related-section" aria-label="업무 의존성">
        <div className="issue-schedule-heading">
          <h3><Link2 size={16} aria-hidden="true" />업무 의존성 <span>{dependencies.length}</span></h3>
          <div className="issue-schedule-actions">
            <button ref={addPredecessorButton} className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'predecessor')}><Plus size={14} aria-hidden="true" />선행 업무 추가</button>
            <button className="btn" type="button" disabled={!hasOtherIssueInProject || saving || dependencyBusy}
              onClick={event => openDependencyEditor(event.currentTarget, 'successor')}><Link2 size={14} aria-hidden="true" />기존 후행 업무 연결</button>
            <button ref={successorCreationTrigger} className="btn" type="button" disabled={saving || dependencyBusy}
              onClick={() => setSchedulePredecessor(issue)}><Plus size={14} aria-hidden="true" />새 후행 업무 추가</button>
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
      <IssueRelations issueId={issue.id} data={data} openIssue={navigateIssue} refresh={refresh} notify={notify}
        refreshKey={relationsRefreshKey} disabled={saving || dependencyBusy} controlsRef={relationControls} highlightOpenBlockers={Boolean(error?.openBlockers)}
        onDraftChange={trackRelationDraft} onReviewSchedule={openRelationScheduleReview} />
      <section className="issue-related-section issue-linked-documents" aria-label="연결된 문서">
        <h3><FileText size={16} /> 연결된 문서 <span>{linkedDocuments.length}</span></h3>
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
      <IssueGitlabActivity issueId={issue.id} issueKey={issue.key} links={gitlabLinks} refresh={refresh} notify={notify}
        disabled={saving || dependencyBusy} onDraftChange={trackGitlabDraft} />
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
                <CommentTrashButton comment={comment} actorId={props.actorId} notify={notify} refresh={refresh} disabled={commenting || saving}
                  onArchived={removed => setComments(previous => previous.filter(value => value.id !== removed.id))} />
              </header>
              <p><CommentMentionText comment={comment} /></p>
            </div>
          </article>;
        })}
        {commentError && <div className="issue-form-error" role="alert">{commentError}</div>}
        <form onSubmit={addComment}>
          <CommentMentionInput className="field" placeholder="댓글을 작성하세요…" aria-label="댓글 내용" draft={commentDraft}
            onChange={setCommentDraft} users={data.users} rows={3} required maxLength={10000} readOnly={commenting} />
          <div className="issue-comment-submit"><button className="btn" disabled={!commentDraft.body.trim() || commenting} type="submit"><Plus size={14} />{commenting ? '등록 중…' : '댓글 등록'}</button></div>
        </form>
      </section>
      <section className="issue-danger-zone">{deleteConfirm ? <><p><strong>{issue.key} 업무를 휴지통으로 옮길까요?</strong><br /><span>휴지통에서 업무를 복원할 수 있습니다. 이미 기록한 작업 시간은 프로젝트 보고서에 남습니다.{(dirty || commentDraft.body.trim()) && ' 저장하지 않은 편집과 보내지 않은 댓글은 사라집니다.'}</span></p><div><button className="btn btn-ghost" onClick={() => setDeleteConfirm(false)} disabled={saving}>취소</button><button className="btn issue-btn-danger" onClick={deleteIssue} disabled={saving || commenting}>휴지통으로 이동</button></div></> : <button className="btn btn-ghost" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> 업무 삭제</button>}</section>
    </> : tab === 'worklogs' ? <IssueWorklogs issueId={issue.id} actorId={props.actorId} users={data.users}
      notify={notify} onChanged={refresh} onDraftChange={trackChildDraft}/>
    : tab === 'reservations' ? <TimeReservations issue={issue} actorId={props.actorId} users={data.users} notify={notify} onDraftChange={trackChildDraft} onChanged={refresh} />
    : tab === "source" ? <SourceOrigins resourceType="issue" resourceId={issue.id}/> : <>
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
    {schedulePredecessor && <NewIssueModal {...props} predecessorIssue={schedulePredecessor}
      onClose={closeSuccessorCreation} onSuccessorCreated={focusCreatedSuccessor} />}
    {dependencyEditor && <GanttDependencyModal issues={data.issues} dependency={editingDependency}
      anchor={dependencyEditor.otherRole ? { issueId, otherRole: dependencyEditor.otherRole } : undefined}
      relationReview={relationScheduleReview && { sourceIssueId: relationScheduleReview.relation.sourceIssueId,
        targetIssueId: relationScheduleReview.relation.targetIssueId, mode: relationScheduleReview.mode }}
      staleMessage={staleDependencyMessage} busy={dependencyBusy}
      onClose={closeDependencyEditor} onSubmit={saveDependency} onDraftChange={trackDependencyDraft} />}
  </>;
}

function LayersIcon() { return <span className="issue-subtask-icon">↳</span>; }
