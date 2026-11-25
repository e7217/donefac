'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarRange, Check, ChevronDown, ChevronRight, CircleDot, ClipboardList, Columns3, Command, FolderPlus, GitBranch, Inbox, KeyRound, LayoutDashboard, ListTodo, LoaderCircle, Plus, Search, Settings2, Sparkles, SquareChartGantt, Star, Trash2, Users, X } from 'lucide-react';
import type { DeliveryBlockerDraftScope, DocumentPublicationListTab, DocumentPublicationTarget, FeatureProps, TeamBoardFilters, TeamGanttScheduleFilters, TeamNotification, TeamOverviewFilters, WorkspaceSnapshot } from '../shared/types';
import { DELIVERY_BLOCKER_REASONS, RELEASE_BLOCKER_REASONS, isIssueViewGitlabFilter, isTeamOverviewIssueMetric } from '../shared/types';
import { reservationDayRange } from '../shared/time-reservations';
import { isCalendarDate } from '../shared/calendar';
import { planningFields } from '../shared/planning-helpers';
import { appendGitlabActivityFilters, DEFAULT_GITLAB_ACTIVITY_FILTERS, readGitlabActivityFilters, type GitlabActivityFilters } from '../shared/gitlab-activity-filter';
import { NATIVE_BACKUP_SCHEMA_VERSION, supportsNativeBackupVersion } from '../shared/native-backup';
import { projectStatuses, statusMeta, isTerminalStatus } from '../shared/workflow-helpers';
import { countActiveMyWork } from '../shared/my-work';
import { isDocumentReading, isDocumentSectionId } from '../shared/document-sections';
import { countIssueDocumentReferences } from '../shared/document-references';
import { normalizeDocumentLabelKey } from '../shared/document-labels';
import { appendDocumentPublicationCriteria, defaultDocumentPublicationCriteria, readDocumentPublicationCriteria,
  sameDocumentPublicationCriteria, type DocumentPublicationCriteria, type DocumentPublicationReturnTarget } from '../shared/document-publication-route';
import { DEFAULT_WORKSPACE_SEARCH_FILTERS, WORKSPACE_SEARCH_INPUT_LIMIT, issueSearchAliasLabel, normalizeWorkspaceSearchInput, searchQuickDocuments, searchQuickIssues, type WorkspaceSearchFilters } from '../shared/workspace-search';
import type { ScheduleDependencyEndpoint } from '../shared/schedule-dependencies';
import { isRelationId } from '../shared/issue-relations';
import { cycleCompletionRecordParameter, readCycleCompletionRecordId } from '../shared/cycle-completion-address';
import { api, apiResponse, patch, post, relativeTime, setActor } from './lib/api';
import { useAtlassianSearch } from './lib/use-atlassian-search';
import { useIssueSubscriptions } from './lib/use-issue-subscriptions';
import { DEFAULT_DECISION_FOLLOW_UP_SCOPE, decisionFollowUpParameters, readDecisionFollowUpScope, sameDecisionFollowUpScope, type DecisionFollowUpScope } from './lib/decision-follow-up-route';
import { fieldBreakdownParameters, readFieldBreakdownScope, sameFieldBreakdownScope, type FieldBreakdownScope } from './lib/field-breakdown-route';
import { appendWorkspaceSearchFilters, readWorkspaceSearchFilters, sameWorkspaceSearchFilters } from './lib/workspace-search-route';
import { appendGitlabDeploymentView, DEFAULT_GITLAB_DEPLOYMENT_VIEW, readGitlabDeploymentView, sameGitlabDeploymentView,
  type ChangeGitlabDeploymentView, type GitlabDeploymentView } from './lib/gitlab-deployment-route';
import { appendGanttTimelineLink, ganttTimelineLinkKey, readGanttTimelineLink, type GanttTimelineLink } from './lib/gantt-timeline-link';
import { dispatchWorkspaceNavigation } from './lib/navigation';
import { issueReviewPosition, type GitlabIssueReviewSelection, type IssueReviewDirection, type OpenIssueForReview } from './lib/issue-review';
import type { WorkspaceRefresh } from './lib/workspace-refresh';
import { Issues } from './features/Issues';
import { Gantt } from './features/Gantt';
import { clearGanttDateDrafts, type GanttIssueDateDrafts } from './features/gantt-date-draft-storage';
import { IssuePanel } from './features/IssuePanel';
import { MyWork } from './features/MyWork';
import { ProjectCreationDialog } from './features/ProjectCreationDialog';
import { FavoritesPage, FavoritesProvider } from './features/FavoritesState';
import type { PrepareMigration } from './features/MigrationApplySettings';
import TeamNotifications from './features/TeamNotifications';
import './features/workspace-search.css';
const WorkflowSettings = lazy(() => import('./features/WorkflowSettings').then(module => ({default: module.WorkflowSettings})));
const IssueAssignmentRules = lazy(() => import('./features/IssueAssignmentRules').then(module => ({default: module.IssueAssignmentRules})));
const IssueSchemaSettings = lazy(() => import('./features/IssueSchemaSettings').then(module => ({default: module.IssueSchemaSettings})));
const IssueTemplateSettings = lazy(() => import('./features/IssueTemplateSettings').then(module => ({default: module.IssueTemplateSettings})));
const RecurringIssueSettings = lazy(() => import('./features/RecurringIssueSettings').then(module => ({default: module.RecurringIssueSettings})));
const CalendarSettings = lazy(() => import('./features/CalendarSettings').then(module => ({default: module.CalendarSettings})));
const DeadlineReminderSettings = lazy(() => import('./features/DeadlineReminderSettings').then(module => ({default: module.DeadlineReminderSettings})));
const MigrationApplySettings = lazy(() => import('./features/MigrationApplySettings').then(module => ({default:module.MigrationApplySettings})));
const LegacyImportSettings = lazy(() => import('./features/LegacyImportSettings').then(module => ({default:module.LegacyImportSettings})));
const ApiKeysSettings = lazy(() => import('./features/ApiKeysSettings').then(module => ({default: module.ApiKeysSettings})));
const Development = lazy(() => import('./features/Development').then(module => ({default:module.Development})));
const Planning = lazy(() => import('./features/Planning').then(module => ({default: module.Planning})));
const CycleBoard = lazy(() => import('./features/CycleBoard').then(module => ({default: module.CycleBoard})));
const Reports = lazy(() => import('./features/Reports').then(module => ({default: module.Reports})));
const IssueIntake = lazy(() => import('./features/IssueIntake').then(module => ({ default: module.IssueIntake })));
const Documents = lazy(() => import('./features/Documents').then(module => ({default: module.Documents})));
const DocumentPublicationLibrary = lazy(() => import('./features/DocumentPublicationLibrary').then(module => ({default: module.DocumentPublicationLibrary})));
const TeamOverview = lazy(() => import('./features/TeamOverview').then(module => ({default: module.TeamOverview})));
const TeamBoard = lazy(() => import('./features/TeamBoard'));
const Trash = lazy(() => import('./features/Trash').then(module => ({default: module.Trash})));
const WorkspaceSearch = lazy(() => import('./features/WorkspaceSearch').then(module => ({default: module.WorkspaceSearch})));

type View = 'overview' | 'issues' | 'intake' | 'backlog' | 'gantt' | 'planning' | 'reports' | 'documents' | 'publication' | 'development' | 'settings' | 'mywork' | 'favorites' | 'trash' | 'teamoverview' | 'teamboard' | 'search';
const navigation = [
  { id: 'overview', label: '프로젝트 개요', icon: LayoutDashboard },
  { id: 'issues', label: '업무', icon: ListTodo },
  { id: 'intake', label: '업무 접수', icon: ClipboardList },
  { id: 'backlog', label: '백로그 · 사이클', icon: CalendarRange },
  { id: 'gantt', label: '간트 · 일정', icon: SquareChartGantt },
  { id: 'planning', label: '사이클 · 모듈 · 릴리스', icon: FolderPlus },
  { id: 'reports', label: '보고서', icon: BarChart3 },
  { id: 'documents', label: '문서', icon: BookOpen },
  { id: 'publication', label: '검토함 · 발행본', icon: Inbox },
  { id: 'development', label: '개발 · GitLab', icon: GitBranch },
] as const;

type WorkspaceRoute = {
  projectId: string; view: View; documentId: string | null; reportId?: string | null; planningId?: string | null; issueId: string | null;
  completionRecordId?: string | null;
  issueCommentId?: string | null;
  intakeRequestId?: string | null;
  intakeCompose?: boolean;
  gitlabActivityId?: string | null;
  documentPreviewId?: string | null;
  savedViewId?: string | null; ganttScope?: 'team'; ganttProject?: string | null;
  ganttScheduleFilters?: TeamGanttScheduleFilters;
  ganttTimelineLink?: GanttTimelineLink;
  ganttFocusIssueId?: string | null; ganttFocusDate?: ScheduleDependencyEndpoint | null;
  ganttMilestoneId?: string | null;
  blockerScope?: DeliveryBlockerDraftScope | null;
  decisionFollowUpScope?: DecisionFollowUpScope | null;
  fieldBreakdownScope?: FieldBreakdownScope | null;
  publicationTab?: DocumentPublicationListTab; publicationCriteria?: DocumentPublicationCriteria; publication?: DocumentPublicationTarget | null;
  documentReading?: boolean;
  sectionId?: string | null;
  documentCommentId?: string | null;
  documentLabel?: string | null;
  teamOverviewFilters?: TeamOverviewFilters;
  teamBoardFilters?: TeamBoardFilters;
  cycleQuery?: string;
  gitlabActivityFilters?: GitlabActivityFilters;
  gitlabDeploymentView?: GitlabDeploymentView;
  searchFilters?: WorkspaceSearchFilters;
};
type WorkspaceCommentFocus = {
  targetType: 'issue' | 'document';
  targetId: string;
  actorId: string | null;
  commentId: string;
  activation: number;
};
type PublicationHistoryFocus = { hash: string; index: number; actorId: string; target: DocumentPublicationReturnTarget };

function publicationHistoryFocus(value: unknown, hash: string, index: number): PublicationHistoryFocus | null {
  if (!value || typeof value !== 'object') return null;
  const { hash: storedHash, index: storedIndex, actorId, target } = value as Partial<PublicationHistoryFocus>;
  if (storedHash !== hash || storedIndex !== index || !isRelationId(actorId) || !target ||
      !isRelationId(target.documentId) || !isRelationId(target.revisionId) || (target.kind !== 'review' && target.kind !== 'published')) return null;
  return { hash, index, actorId, target };
}
const ganttRevisionScope = { query: 'ganttSince', header: 'X-Teamspace-Gantt-Revision' } as const;
const refreshScopes = {
  issues: ganttRevisionScope,
  teamboard: { query: 'teamBoardSince', header: 'X-Teamspace-Board-Revision' },
  gantt: ganttRevisionScope,
} as const;
type RefreshScope = keyof typeof refreshScopes;
type WorkspaceRevisions = Record<RefreshScope, string | null>;
type WorkspaceRead = { request: number; snapshot: WorkspaceSnapshot | null; revisions: WorkspaceRevisions };
const validViews: View[] = ['overview','issues','intake','backlog','gantt','planning','reports','documents','publication','development','settings','mywork','favorites','trash','teamoverview','teamboard','search'];
const emptyTeamOverviewFilters: TeamOverviewFilters = { projectId: '', memberId: '', date: '' };
const emptyTeamBoardFilters: TeamBoardFilters = {};
const emptyTeamGanttScheduleFilters: TeamGanttScheduleFilters = {};
function readIssueFilterQuery(value?: string | null) {
  return value?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || undefined;
}

function teamGanttRouteFromBoard({projectId, teamBoardFilters}: WorkspaceRoute): WorkspaceRoute {
  return { projectId, view: 'gantt', documentId: null, issueId: null, ganttScope: 'team',
    ganttProject: teamBoardFilters?.projectId ?? null,
    ganttScheduleFilters: { assigneeId: teamBoardFilters?.memberId, query: teamBoardFilters?.query, gitlab: teamBoardFilters?.gitlab } };
}

function keepGanttDateFocus(event: PointerEvent<HTMLButtonElement>) {
  if (event.button === 0 && document.activeElement?.matches('input[data-schedule-edge]')) event.preventDefault();
}

function routeHash(route: WorkspaceRoute) {
  const reportDetail = route.decisionFollowUpScope ? 'decision-follow-ups' : route.blockerScope ? 'blockers' :
    route.fieldBreakdownScope ? 'fields' : route.reportId;
  const teamGantt = route.view === 'gantt' && route.ganttScope === 'team';
  const detail = route.view === 'documents' ? route.documentId : route.view === 'publication' ? route.publicationTab ?? 'assigned' : route.view === 'reports' ? reportDetail :
    (route.view === 'gantt' && !teamGantt || route.view === 'planning' || route.view === 'backlog') ? route.planningId : null;
  const query = new URLSearchParams();
  if (teamGantt) {
    query.set('scope', 'team');
    if (route.ganttProject) query.set('ganttProject', route.ganttProject);
    const filters = route.ganttScheduleFilters;
    if (filters?.assigneeId !== undefined) query.set('ganttAssignee', filters.assigneeId ?? '');
    if (filters?.unscheduledOnly) query.set('ganttUnscheduled', '1');
    if (filters?.query) query.set('ganttQ', filters.query);
    if (filters?.gitlab) query.set('ganttGitlab', filters.gitlab);
  }
  if (route.issueId) {
    query.set('issue', route.issueId);
    if (route.issueCommentId) query.set('issueComment', route.issueCommentId);
    else if (route.view === 'issues' && route.gitlabActivityId) query.set('gitlabActivity', route.gitlabActivityId);
  }
  if (route.view === 'backlog' && route.cycleQuery) query.set('cycleQ', route.cycleQuery);
  if (route.view === 'intake') {
    if (route.intakeRequestId) query.set('request', route.intakeRequestId);
    else if (route.intakeCompose) query.set('compose', '1');
  }
  if (route.view === 'planning' && route.completionRecordId) query.set(cycleCompletionRecordParameter, route.completionRecordId);
  if (route.view === 'development' && route.gitlabActivityFilters) appendGitlabActivityFilters(query, route.gitlabActivityFilters);
  if (route.view === 'development' && route.gitlabDeploymentView) appendGitlabDeploymentView(query, route.gitlabDeploymentView);
  if (route.view === 'publication' && route.publicationCriteria) {
    appendDocumentPublicationCriteria(query, route.publicationCriteria, route.publicationTab ?? 'assigned', route.projectId);
  }
  if ((route.view === 'issues' || route.view === 'gantt' && !teamGantt) && route.savedViewId) query.set('savedView', route.savedViewId);
  if (route.view === 'gantt' && route.ganttTimelineLink) appendGanttTimelineLink(query, route.ganttTimelineLink);
  if (route.view === 'gantt' && !teamGantt && route.ganttMilestoneId) query.set('milestone', route.ganttMilestoneId);
  if (route.view === 'reports' && route.blockerScope) {
    if (route.blockerScope.releaseId) query.set('release', route.blockerScope.releaseId);
    if (route.blockerScope.savedViewId) query.set('savedView', route.blockerScope.savedViewId);
    if (route.blockerScope.reason) query.set('reason', route.blockerScope.reason);
  }
  if (route.view === 'reports' && route.decisionFollowUpScope) {
    for (const [name, value] of decisionFollowUpParameters(route.decisionFollowUpScope)) query.set(name, value);
  }
  if (route.view === 'reports' && route.fieldBreakdownScope) {
    for (const [name, value] of fieldBreakdownParameters(route.fieldBreakdownScope)) query.set(name, value);
  }
  if (route.view === 'gantt' && route.ganttFocusIssueId) {
    query.set('focusIssue', route.ganttFocusIssueId);
    if (route.ganttFocusDate) query.set('focusDate', route.ganttFocusDate);
  }
  if (route.view === 'documents' && route.documentId && route.publication) {
    query.set('publication', route.publication.kind);
    query.set('revision', route.publication.revisionId);
  }
  if (route.view === 'documents' && route.documentId) {
    if (route.documentReading && !route.publication) query.set('mode', 'read');
    if (route.documentCommentId && !route.publication) query.set('comment', route.documentCommentId);
    else if (route.sectionId) query.set('section', route.sectionId);
  }
  if (route.view === 'documents' && route.documentLabel) query.set('label', route.documentLabel);
  if (route.view === 'teamoverview' && route.teamOverviewFilters) {
    const { projectId, memberId, date, issueMetric, issueOffset } = route.teamOverviewFilters;
    if (projectId) query.set('teamProject', projectId);
    if (memberId) query.set('teamMember', memberId);
    if (date) query.set('teamDate', date);
    if (issueMetric) {
      query.set('teamQueue', issueMetric);
      if (issueOffset) query.set('teamQueueOffset', String(issueOffset));
    }
  }
  if (route.view === 'teamboard' && route.teamBoardFilters) {
    const { projectId, memberId, query: search, gitlab } = route.teamBoardFilters;
    if (projectId) query.set('boardProject', projectId);
    if (memberId !== undefined) query.set('boardMember', memberId ?? '');
    if (search) query.set('boardQuery', search);
    if (gitlab) query.set('boardGitlab', gitlab);
  }
  if (route.view === 'search' && route.searchFilters) appendWorkspaceSearchFilters(query, route.searchFilters);
  if (route.issueId && route.documentPreviewId) query.set('documentPreview', route.documentPreviewId);
  return `#/${encodeURIComponent(route.projectId)}/${route.view}${detail ? '/' + encodeURIComponent(detail) : ''}${query.size ? '?' + query.toString() : ''}`;
}
function isPublicationPageClamp(previous: WorkspaceRoute | null, next: WorkspaceRoute): boolean {
  if (previous?.view !== 'publication' || next.view !== 'publication' || previous.issueId || next.issueId ||
      previous.projectId !== next.projectId || previous.publicationTab !== next.publicationTab) return false;
  const before = previous.publicationCriteria, after = next.publicationCriteria;
  return Boolean(before && after && after.offset < before.offset && sameDocumentPublicationCriteria({ ...before, offset: after.offset }, after));
}
function hasSameDocumentContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'documents' && next.view === 'documents' && previous.documentId !== null &&
    previous.documentId === next.documentId &&
    previous.publication?.kind === next.publication?.kind && previous.publication?.revisionId === next.publication?.revisionId;
}
function hasDocumentIssueOverlay(route: WorkspaceRoute | null): boolean {
  return Boolean(route?.view === 'documents' && route.documentId && route.issueId);
}
function sameBlockerScope(a?: DeliveryBlockerDraftScope | null, b?: DeliveryBlockerDraftScope | null): boolean {
  return Boolean(a) === Boolean(b) && a?.savedViewId === b?.savedViewId && a?.releaseId === b?.releaseId && a?.reason === b?.reason;
}
function hasSameReportContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'reports' && next.view === 'reports' && previous.projectId === next.projectId &&
    (previous.reportId ?? null) === (next.reportId ?? null) && sameBlockerScope(previous.blockerScope, next.blockerScope) &&
    sameDecisionFollowUpScope(previous.decisionFollowUpScope, next.decisionFollowUpScope) &&
    sameFieldBreakdownScope(previous.fieldBreakdownScope, next.fieldBreakdownScope);
}
function sameTeamBoardFilters(a?: TeamBoardFilters, b?: TeamBoardFilters): boolean {
  return a?.projectId === b?.projectId && a?.memberId === b?.memberId && a?.query === b?.query && a?.gitlab === b?.gitlab;
}
function hasSameTeamBoardContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'teamboard' && next.view === 'teamboard' && previous.projectId === next.projectId &&
    sameTeamBoardFilters(previous.teamBoardFilters, next.teamBoardFilters);
}
function hasSameBoardContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return hasSameTeamBoardContext(previous, next) || (previous.view === 'issues' && next.view === 'issues' && previous.projectId === next.projectId &&
    (previous.savedViewId ?? null) === (next.savedViewId ?? null));
}
function issueReviewContext(route: WorkspaceRoute) {
  return routeHash({ ...route, issueId: null, documentPreviewId: null, gitlabDeploymentView: undefined });
}
type IssueReview = {
  context: string;
  actorId: string;
  projectScope: string | null;
  issueIds: readonly string[];
  gitlabActivity?: GitlabIssueReviewSelection;
  gitlabOpener?: { linkId: string; action: 'issue' | 'activity' };
  openerIssueId?: string;
  focusDirection?: IssueReviewDirection;
};
type IssueReviewHistory = { index: number; issueId: string; review: IssueReview };

function isDocumentLinkedWorkRoute(route: WorkspaceRoute): boolean {
  return route.view === 'documents' && Boolean(route.documentId) && !route.publication;
}

function issueReviewHistoryKey(route: WorkspaceRoute) {
  if (route.view === 'mywork') return 'teamspaceMyWorkReview';
  if (route.view === 'backlog') return 'teamspaceCycleBoardIssueReview';
  if (route.view === 'development') return 'teamspaceDevelopmentIssueReview';
  if (isDocumentLinkedWorkRoute(route)) return 'teamspaceDocumentIssueReview';
}

function readIssueReviewHistory(value: unknown, route: WorkspaceRoute, index: number, actorId: string): IssueReviewHistory | undefined {
  if (!value || typeof value !== 'object' || !route.issueId) return;
  const entry = value as Partial<IssueReviewHistory>;
  const review = entry.review;
  if (route.view === 'development' && (review?.projectScope !== route.projectId ||
      typeof review.gitlabOpener?.linkId !== 'string' ||
      (review.gitlabOpener.action !== 'issue' && review.gitlabOpener.action !== 'activity') ||
      (review.gitlabActivity && (review.gitlabActivity.issueId !== route.issueId ||
        review.gitlabActivity.id !== review.gitlabOpener.linkId)))) return;
  if (entry.index === index && entry.issueId === route.issueId && review?.actorId === actorId &&
      review.context === issueReviewContext(route) && Array.isArray(review.issueIds) &&
      review.issueIds.every(id => typeof id === 'string') && review.issueIds.includes(route.issueId) &&
      typeof review.openerIssueId === 'string' && review.issueIds.includes(review.openerIssueId) &&
      (review.projectScope === null || typeof review.projectScope === 'string')) return entry as IssueReviewHistory;
}

function rememberIssueReview(route: WorkspaceRoute, index: number, review: IssueReview) {
  const key = issueReviewHistoryKey(route);
  if (!key || !route.issueId) return;
  const entry: IssueReviewHistory = { index, issueId: route.issueId, review: { ...review, focusDirection: undefined } };
  history.replaceState({ ...history.state, [key]: entry }, '');
}
function sameTeamGanttScheduleFilters(a?: TeamGanttScheduleFilters, b?: TeamGanttScheduleFilters): boolean {
  return a?.assigneeId === b?.assigneeId && Boolean(a?.unscheduledOnly) === Boolean(b?.unscheduledOnly) &&
    a?.query === b?.query && a?.gitlab === b?.gitlab;
}
function hasSameProjectGanttContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'gantt' && next.view === 'gantt' && !previous.ganttScope && !next.ganttScope &&
    previous.projectId === next.projectId && (previous.planningId ?? null) === (next.planningId ?? null) &&
    (previous.savedViewId ?? null) === (next.savedViewId ?? null) &&
    ganttTimelineLinkKey(previous.ganttTimelineLink) === ganttTimelineLinkKey(next.ganttTimelineLink);
}
function hasSameDevelopmentProject(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'development' && next.view === 'development' && previous.projectId === next.projectId;
}
function hasSameIssueOverlayContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  const sameTeamGantt = previous.view === 'gantt' && next.view === 'gantt' && previous.ganttScope === 'team' && next.ganttScope === 'team' &&
    previous.projectId === next.projectId && previous.ganttProject === next.ganttProject &&
    sameTeamGanttScheduleFilters(previous.ganttScheduleFilters, next.ganttScheduleFilters) &&
    previous.ganttFocusIssueId === next.ganttFocusIssueId && previous.ganttFocusDate === next.ganttFocusDate;
  const sameSearch = previous.view === 'search' && next.view === 'search' && previous.projectId === next.projectId &&
    sameWorkspaceSearchFilters(previous.searchFilters, next.searchFilters);
  const sameFavorites = previous.view === 'favorites' && next.view === 'favorites' && previous.projectId === next.projectId;
  const sameMilestone = Boolean(previous.ganttMilestoneId && previous.ganttMilestoneId === next.ganttMilestoneId) &&
    hasSameProjectGanttContext(previous, next);
  const sameDevelopment = hasSameDevelopmentProject(previous, next) && issueReviewContext(previous) === issueReviewContext(next);
  const sameMyWork = previous.view === 'mywork' && next.view === 'mywork' && previous.projectId === next.projectId;
  return sameTeamGantt || sameMilestone || sameSearch || sameFavorites || sameDevelopment || sameMyWork ||
    hasSameDocumentContext(previous, next) || hasSameReportContext(previous, next) || hasSameTeamBoardContext(previous, next);
}
function isContextualIssueView(view: View): boolean {
  return view === 'reports' || view === 'search' || view === 'favorites' || view === 'development' || view === 'mywork';
}
function hasContextualIssueOverlay(route: WorkspaceRoute | null): boolean {
  return Boolean(route?.issueId && isContextualIssueView(route.view));
}
function hasTeamBoardIssueOverlay(route: WorkspaceRoute | null): boolean {
  return Boolean(route?.view === 'teamboard' && route.issueId);
}
function canPreviewIssueDocument(snapshot: WorkspaceSnapshot, issueId: string, documentId: string): boolean {
  const document = snapshot.documents.find(value => value.id === documentId);
  return Boolean(document && (snapshot.resourceLinks.some(link => link.issueId === issueId && link.documentId === documentId) ||
    countIssueDocumentReferences(document.content, issueId) > 0));
}
function requestIssueCommentFocus(issueId: string) {
  return window.dispatchEvent(new CustomEvent('teamspace:focus-issue-comment', { cancelable: true, detail: { issueId } }));
}
function confirmRouteNavigation(previous: WorkspaceRoute | null, next: WorkspaceRoute): boolean {
  if (previous?.issueId && previous.documentPreviewId !== next.documentPreviewId &&
      routeHash({ ...previous, documentPreviewId: null }) === routeHash({ ...next, documentPreviewId: null })) return true;
  if (previous?.issueId && previous.issueId === next.issueId && previous.issueCommentId !== next.issueCommentId &&
      routeHash({ ...previous, issueCommentId: null }) === routeHash({ ...next, issueCommentId: null })) {
    return !next.issueCommentId || requestIssueCommentFocus(next.issueId);
  }
  if (previous && previous.projectId === next.projectId && hasSameDocumentContext(previous, next)) {
    if (previous.issueId === next.issueId && (previous.sectionId !== next.sectionId || previous.documentCommentId !== next.documentCommentId) &&
        previous.documentPreviewId === next.documentPreviewId) return true;
    return dispatchWorkspaceNavigation({ preservedDocumentId: previous.documentId });
  }
  if (previous && hasSameReportContext(previous, next) && previous.issueId !== next.issueId) {
    return dispatchWorkspaceNavigation({ preserveReport: true });
  }
  if (previous && hasSameDevelopmentProject(previous, next)) {
    return dispatchWorkspaceNavigation({ preserveDevelopment: true });
  }
  if (previous?.view === 'gantt' && next.view === 'gantt' && previous.issueId !== next.issueId &&
      issueReviewContext(previous) === issueReviewContext(next)) {
    return dispatchWorkspaceNavigation({ preserveGantt: 'issueOverlay' });
  }
  if (previous && (previous.ganttMilestoneId || next.ganttMilestoneId) && hasSameProjectGanttContext(previous, next)) {
    return dispatchWorkspaceNavigation({ preserveGantt: true });
  }
  if (previous?.view === 'gantt' && next.view === 'gantt' && previous.ganttScope === next.ganttScope && previous.projectId === next.projectId &&
      (previous.planningId ?? null) === (next.planningId ?? null) && (previous.savedViewId ?? null) === (next.savedViewId ?? null) &&
      ganttTimelineLinkKey(previous.ganttTimelineLink) === ganttTimelineLinkKey(next.ganttTimelineLink) &&
      (previous.ganttFocusIssueId ?? null) === (next.ganttFocusIssueId ?? null) && (previous.ganttFocusDate ?? null) === (next.ganttFocusDate ?? null)) {
    return dispatchWorkspaceNavigation({ preserveGantt: 'dateDrafts' });
  }
  if (previous?.view === 'teamboard' && next.view === 'teamboard' && !previous.issueId && !next.issueId &&
      !previous.documentPreviewId && !next.documentPreviewId && previous.projectId === next.projectId) {
    return dispatchWorkspaceNavigation({ preserveTeamBoard: true });
  }
  return dispatchWorkspaceNavigation();
}
function normalizeRoute(snapshot: WorkspaceSnapshot, hash: string): WorkspaceRoute {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  let parts: string[] = [];
  try { parts = path.split('/').slice(1).map(decodeURIComponent); } catch { /* malformed addresses use the default project */ }
  let projectId = snapshot.projects.some(p => p.id === parts[0]) ? parts[0] : snapshot.projects[0]?.id || '';
  let view: View = validViews.includes(parts[1] as View) ? parts[1] as View : 'overview';
  let documentId: string | null = null;
  let issueId: string | null = null;
  if (view === 'documents' && parts[2]) {
    const document = snapshot.documents.find(d => d.id === parts[2]);
    if (document) { documentId = document.id; projectId = document.projectId || projectId; }
  }
  const parameters = new URLSearchParams(query);
  const ganttScope = view === 'gantt' && projectId && parameters.get('scope') === 'team' ? 'team' : undefined;
  const requestedGanttProject = parameters.get('ganttProject');
  const ganttProject = ganttScope && snapshot.projects.some(project => project.id === requestedGanttProject) ? requestedGanttProject : null;
  const requestedGanttAssignee = parameters.get('ganttAssignee');
  const requestedGanttGitlab = parameters.get('ganttGitlab');
  const ganttScheduleFilters: TeamGanttScheduleFilters | undefined = ganttScope ? {
    assigneeId: requestedGanttAssignee === '' ? null : requestedGanttAssignee !== null &&
      snapshot.users.some(user => user.id === requestedGanttAssignee) ? requestedGanttAssignee : undefined,
    unscheduledOnly: parameters.get('ganttUnscheduled') === '1',
    query: readIssueFilterQuery(parameters.get('ganttQ')),
    gitlab: isIssueViewGitlabFilter(requestedGanttGitlab) ? requestedGanttGitlab : undefined,
  } : undefined;
  const requestedIssue = parameters.get('issue');
  const issue = snapshot.issues.find(i => i.id === requestedIssue);
  if (issue) {
    issueId = issue.id;
    if (view !== 'teamoverview' && view !== 'teamboard' && view !== 'reports' && view !== 'search' && view !== 'favorites' && view !== 'intake' &&
        view !== 'mywork' && !ganttScope && !documentId) projectId = issue.projectId;
    if (view === 'settings' || (view === 'documents' && !documentId)) view = 'issues';
  }
  const issueCommentSelectors = parameters.getAll('issueComment');
  const issueCommentId = issueId && issueCommentSelectors.length === 1 && isRelationId(issueCommentSelectors[0])
    ? issueCommentSelectors[0] : null;
  const gitlabActivitySelectors = parameters.getAll('gitlabActivity');
  const gitlabActivityId = view === 'issues' && issueId && !issueCommentId && gitlabActivitySelectors.length === 1 &&
    isRelationId(gitlabActivitySelectors[0]) ? gitlabActivitySelectors[0] : null;
  const requestedDocumentPreview = parameters.get('documentPreview');
  const documentPreviewId = issueId && requestedDocumentPreview &&
    canPreviewIssueDocument(snapshot, issueId, requestedDocumentPreview) ? requestedDocumentPreview : null;
  const reportId = view === 'reports' && projectId === parts[0] && /^[0-9a-f-]{36}$/i.test(parts[2] || '') ? parts[2] : null;
  const blockerView = parameters.get('savedView');
  const requestedRelease = parameters.get('release');
  const blockerRelease = isRelationId(requestedRelease) ? requestedRelease : undefined;
  const requestedBlockerReason = parameters.get('reason');
  const blockerReason = DELIVERY_BLOCKER_REASONS.find(reason => reason === requestedBlockerReason) ??
    (blockerRelease ? RELEASE_BLOCKER_REASONS.find(reason => reason === requestedBlockerReason) : undefined);
  const blockerScope = view === 'reports' && projectId === parts[0] && parts[2] === 'blockers' ? {
    ...(isRelationId(blockerView) ? { savedViewId: blockerView } : {}),
    ...(blockerRelease ? { releaseId: blockerRelease } : {}),
    ...(blockerReason ? { reason: blockerReason } : {}),
  } : null;
  const decisionFollowUpScope = view === 'reports' && parts[2] === 'decision-follow-ups' &&
    (projectId === parts[0] || parameters.get('scope') === 'team')
    ? readDecisionFollowUpScope(parameters, id => snapshot.users.some(user => user.id === id),
      id => snapshot.projects.some(project => project.id === id)) : null;
  const fieldBreakdownScope = view === 'reports' && parts[2] === 'fields'
    ? projectId && projectId === parts[0] ? readFieldBreakdownScope(parameters) : { invalid: true as const }
    : null;
  const requestedFocusIssue = parameters.get('focusIssue');
  const ganttFocusIssueId = view === 'gantt' && requestedFocusIssue && requestedFocusIssue.length <= 200 &&
    requestedFocusIssue.trim() && !/[\u0000-\u001f\u007f]/.test(requestedFocusIssue) ? requestedFocusIssue : null;
  const focusedIssue = ganttFocusIssueId && !ganttScope ? snapshot.issues.find(value => value.id === ganttFocusIssueId) : undefined;
  if (ganttFocusIssueId && !ganttScope) {
    const moveOrigins = snapshot.issueMoveOrigins?.[ganttFocusIssueId];
    if (focusedIssue && (!issue || issue.id === focusedIssue.id) && Array.isArray(moveOrigins) && moveOrigins.includes(parts[0])) {
      projectId = focusedIssue.projectId;
    }
  }
  const requestedFocusDate = parameters.get('focusDate');
  const ganttFocusDate = ganttFocusIssueId && (requestedFocusDate === 'startDate' || requestedFocusDate === 'endDate') ? requestedFocusDate : null;
  const requestedMilestone = parameters.get('milestone');
  const ganttMilestoneId = view === 'gantt' && !ganttScope && projectId === parts[0] && isRelationId(requestedMilestone) ? requestedMilestone : null;
  const keepGanttContext = view === 'gantt' && !ganttScope && (!ganttFocusIssueId || Boolean(ganttMilestoneId || ganttFocusDate));
  const routePlan = projectId === parts[0] && (view === 'planning' || view === 'gantt' && !ganttScope) && parts[2]
    ? snapshot.planningItems?.find(item => item.id === parts[2] && item.projectId === projectId) : undefined;
  const linkedPlanFocus = routePlan && focusedIssue?.projectId === projectId &&
    focusedIssue[planningFields(routePlan.kind).idField] === routePlan.id;
  const planningId = view === 'backlog' && projectId === parts[0] && isRelationId(parts[2]) ? parts[2]
    : view === 'planning' || keepGanttContext || linkedPlanFocus ? routePlan?.id ?? null : null;
  const completionRecordId = view === 'planning' && projectId === parts[0] ? readCycleCompletionRecordId(parameters) : null;
  const savedViewId = (view === 'issues' || keepGanttContext) && (!issue || projectId === parts[0])
    ? parameters.get('savedView') || null : null;
  const ganttTimelineLink = view === 'gantt' && projectId === parts[0]
    ? readGanttTimelineLink(parameters, !ganttScope, Boolean(planningId)) : undefined;
  const publicationTab = view === 'publication' && (parts[2] === 'requested' || parts[2] === 'published') ? parts[2] : 'assigned';
  const publicationCriteria = view === 'publication' ? readDocumentPublicationCriteria(parameters, publicationTab, projectId) : undefined;
  const kind = parameters.get('publication'), revisionId = parameters.get('revision');
  const publication: DocumentPublicationTarget | null = view === 'documents' && documentId && (kind === 'review' || kind === 'published') &&
    revisionId && revisionId.length <= 200 && revisionId.trim() && !/[\u0000-\u001f\u007f]/.test(revisionId) ? {kind,revisionId} : null;
  const requestedComment = parameters.get('comment');
  const intakeRequest = parameters.get('request');
  const intakeRequestId = view === 'intake' && projectId === parts[0] && isRelationId(intakeRequest) ? intakeRequest : null;
  const intakeCompose = view === 'intake' && !intakeRequestId && !issueId && projectId === parts[0] && parameters.get('compose') === '1';
  const documentReading = Boolean(view === 'documents' && documentId && !publication && isDocumentReading(parameters));
  const documentCommentId = view === 'documents' && documentId && !publication && isRelationId(requestedComment) ? requestedComment : null;
  const section = parameters.get('section');
  const sectionId = view === 'documents' && documentId && !documentCommentId && isDocumentSectionId(section) ? section : null;
  const documentLabel = view === 'documents' ? normalizeDocumentLabelKey(parameters.get('label')) : null;
  const teamProject = parameters.get('teamProject'), teamMember = parameters.get('teamMember'), teamDate = parameters.get('teamDate');
  const teamQueue = parameters.get('teamQueue'), teamQueueOffset = parameters.get('teamQueueOffset');
  const issueMetric = isTeamOverviewIssueMetric(teamQueue) ? teamQueue : undefined;
  const issueOffset = issueMetric && teamQueueOffset && /^\d{1,7}$/.test(teamQueueOffset) && Number(teamQueueOffset) <= 1_000_000
    ? Number(teamQueueOffset) || undefined : undefined;
  const teamOverviewFilters: TeamOverviewFilters | undefined = view === 'teamoverview' ? {
    projectId: teamProject && snapshot.projects.some(project => project.id === teamProject) ? teamProject : '',
    memberId: teamMember && snapshot.users.some(member => member.id === teamMember) ? teamMember : '',
    date: teamDate && reservationDayRange(teamDate) ? teamDate : '',
    issueMetric, issueOffset,
  } : undefined;
  const boardProject = parameters.get('boardProject');
  const boardMember = parameters.get('boardMember');
  const boardQuery = readIssueFilterQuery(parameters.get('boardQuery'));
  const boardGitlab = parameters.get('boardGitlab');
  const teamBoardFilters: TeamBoardFilters | undefined = view === 'teamboard' ? {
    projectId: snapshot.projects.some(project => project.id === boardProject) ? boardProject ?? undefined : undefined,
    memberId: boardMember === '' ? null : snapshot.users.some(user => user.id === boardMember) ? boardMember : undefined,
    query: boardQuery,
    gitlab: isIssueViewGitlabFilter(boardGitlab) ? boardGitlab : undefined,
  } : undefined;
  const searchFilters = view === 'search' ? readWorkspaceSearchFilters(parameters) : undefined;
  const activityFilters = view === 'development' ? readGitlabActivityFilters(parameters) : undefined;
  if (activityFilters?.memberId && !snapshot.users.some(user => user.id === activityFilters.memberId)) {
    delete activityFilters.memberId;
    activityFilters.pages = {};
  }
  return { projectId, view, documentId, issueId, issueCommentId, documentPreviewId, reportId, blockerScope, decisionFollowUpScope, fieldBreakdownScope, planningId, savedViewId,
    ganttScope, ganttProject, ganttScheduleFilters, ganttTimelineLink, ganttFocusIssueId, ganttFocusDate, ganttMilestoneId, publicationTab, publicationCriteria, publication, sectionId, documentCommentId,
    documentLabel, documentReading, teamOverviewFilters, teamBoardFilters, searchFilters, completionRecordId, intakeRequestId, intakeCompose,
    cycleQuery: view === 'backlog' ? readIssueFilterQuery(parameters.get('cycleQ')) : undefined,
    gitlabActivityFilters: activityFilters, gitlabActivityId,
    gitlabDeploymentView: view === 'development' ? readGitlabDeploymentView(parameters) : undefined };
}

export default function Workspace({environmentLabel = '로컬 개발 환경', pilotAccess = false}: { environmentLabel?: string; pilotAccess?: boolean } = {}) {
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const dataRef = useRef<WorkspaceSnapshot | null>(null);
  const [failure, setFailure] = useState('');
  const [projectId, setProjectId] = useState('');
  const [actorId, setActorId] = useState('');
  const actorRef = useRef('');
  const issueSubscriptions = useIssueSubscriptions(actorId);
  const [view, setView] = useState<View>('overview');
  const [issueId, setIssueId] = useState<string | null>(null);
  const [gitlabActivityId, setGitlabActivityId] = useState<string | null>(null);
  const [issueReview, setIssueReview] = useState<IssueReview | null>(null);
  const [documentPreviewId, setDocumentPreviewId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentLabel, setDocumentLabel] = useState<string | null>(null);
  const [documentReading, setDocumentReading] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [blockerScope, setBlockerScope] = useState<DeliveryBlockerDraftScope | null>(null);
  const [decisionFollowUpScope, setDecisionFollowUpScope] = useState<DecisionFollowUpScope | null>(null);
  const [fieldBreakdownScope, setFieldBreakdownScope] = useState<FieldBreakdownScope | null>(null);
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [completionRecordId, setCompletionRecordId] = useState<string | null>(null);
  const [savedViewId, setSavedViewId] = useState<string | null>(null);
  const [ganttScope, setGanttScope] = useState<WorkspaceRoute['ganttScope']>();
  const [ganttProject, setGanttProject] = useState<string | null>(null);
  const [ganttScheduleFilters, setGanttScheduleFilters] = useState(emptyTeamGanttScheduleFilters);
  const [ganttTimelineLink, setGanttTimelineLink] = useState<GanttTimelineLink>();
  const [intakeRoute, setIntakeRoute] = useState<{ requestId: string | null; compose: boolean }>({ requestId: null, compose: false });
  const [ganttFocusIssueId, setGanttFocusIssueId] = useState<string | null>(null);
  const [ganttFocusDate, setGanttFocusDate] = useState<ScheduleDependencyEndpoint | null>(null);
  const [ganttMilestoneId, setGanttMilestoneId] = useState<string | null>(null);
  const [issueFocusActivation, setIssueFocusActivation] = useState(0);
  const [commentFocus, setCommentFocus] = useState<WorkspaceCommentFocus | null>(null);
  const [publicationTab, setPublicationTab] = useState<DocumentPublicationListTab>('assigned');
  const [publicationCriteria, setPublicationCriteria] = useState(() => defaultDocumentPublicationCriteria('assigned', ''));
  const [publication, setPublication] = useState<DocumentPublicationTarget | null>(null);
  const [publicationReturnFocus, setPublicationReturnFocus] = useState<PublicationHistoryFocus | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [teamOverviewFilters, setTeamOverviewFilters] = useState(emptyTeamOverviewFilters);
  const [teamBoardFilters, setTeamBoardFilters] = useState(emptyTeamBoardFilters);
  const [cycleQuery, setCycleQuery] = useState('');
  const [gitlabActivityFilters, setGitlabActivityFilters] = useState(DEFAULT_GITLAB_ACTIVITY_FILTERS);
  const [gitlabDeploymentView, setGitlabDeploymentView] = useState(DEFAULT_GITLAB_DEPLOYMENT_VIEW);
  const [searchFilters, setSearchFilters] = useState(DEFAULT_WORKSPACE_SEARCH_FILTERS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [toast, setToast] = useState<{message: string; kind: string} | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const acceptedRouteRef = useRef<WorkspaceRoute | null>(null);
  const workspaceReadSequence = useRef(0);
  const lastAppliedWorkspaceRead = useRef(0);
  const workspaceRevisions = useRef<WorkspaceRevisions>({ issues: null, teamboard: null, gantt: null });
  const refreshContextEpoch = useRef(0);
  const publicationOpenRequest = useRef(0);
  const notificationOpenRequest = useRef(0);
  const commentFocusActivation = useRef(0);
  const routeIndexRef = useRef(0);
  const rollbackHashRef = useRef<string | null>(null);
  const overlayIssueOpener = useRef<HTMLElement | null>(null);
  const workspaceMain = useRef<HTMLElement>(null);
  const ganttDateDraftsRef = useRef<GanttIssueDateDrafts>(null);
  const boardIssueOpener = useRef<{ opener: HTMLElement; fallback: HTMLElement | null; reviewContext?: string; openerIssueId?: string } | null>(null);
  const restoredDevelopmentReview = useRef<IssueReview | null>(null);
  const [boardDialogIssueId, setBoardDialogIssueId] = useState<string | null>(null);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => setToast({ message, kind }), []);
  const readWorkspace = useCallback(async (signal?: AbortSignal, since?: { scope: RefreshScope; revision: string }): Promise<WorkspaceRead> => {
    const request = ++workspaceReadSequence.current;
    const params = since ? `?${new URLSearchParams({ [refreshScopes[since.scope].query]: since.revision })}` : '';
    const response = await apiResponse(`/workspace${params}`, { signal, cache: 'no-store' });
    const ganttRevision = response.headers.get(ganttRevisionScope.header);
    const revisions = {
      issues: ganttRevision,
      teamboard: response.headers.get(refreshScopes.teamboard.header),
      gantt: ganttRevision,
    };
    const snapshot = response.status === 204 ? null : await response.json() as WorkspaceSnapshot;
    return { request, snapshot, revisions };
  }, []);
  const applyWorkspace = useCallback(({ request, snapshot, revisions }: WorkspaceRead) => {
    if (!snapshot || request < lastAppliedWorkspaceRead.current) return false;
    lastAppliedWorkspaceRead.current = request;
    workspaceRevisions.current = revisions;
    dataRef.current = snapshot;
    setData(snapshot);
    setFailure('');
    setProjectId(id => snapshot.projects.some(p => p.id === id) ? id : snapshot.projects[0]?.id || '');
    const storedActor = actorRef.current || localStorage.getItem('teamspace.actor') || '';
    const selectedActor = snapshot.users.some(user => user.id === storedActor) ? storedActor : snapshot.users[0]?.id || '';
    if (selectedActor !== actorRef.current) {
      publicationOpenRequest.current++;
      setPublicationReturnFocus(null);
    }
    actorRef.current = selectedActor;
    setActor(selectedActor);
    setActorId(selectedActor);
    return true;
  }, []);
  const refresh = useCallback(async () => { applyWorkspace(await readWorkspace()); }, [applyWorkspace, readWorkspace]);
  const refreshView = useCallback(async (scope: RefreshScope, ...[signal, mode, canApply]: Parameters<WorkspaceRefresh>): ReturnType<WorkspaceRefresh> => {
    const epoch = refreshContextEpoch.current;
    const isCurrent = () => {
      const route = acceptedRouteRef.current;
      return !signal.aborted && refreshContextEpoch.current === epoch && route?.view === scope && !route.issueId &&
        (mode === 'manual' || document.visibilityState === 'visible') &&
        !document.querySelector('dialog:modal, .modal-backdrop') && canApply();
    };
    const revision = workspaceRevisions.current[scope];
    if (!isCurrent() || (mode === 'automatic' && !revision)) return 'skipped';
    const result = await readWorkspace(signal, mode === 'automatic' && revision ? { scope, revision } : undefined);
    if (!isCurrent()) return 'skipped';
    if (!result.snapshot) return 'unchanged';
    return applyWorkspace(result) ? 'updated' : 'skipped';
  }, [applyWorkspace, readWorkspace]);
  const refreshIssues = useCallback<WorkspaceRefresh>((...args) => refreshView('issues', ...args), [refreshView]);
  const refreshBoard = useCallback<WorkspaceRefresh>((...args) => refreshView('teamboard', ...args), [refreshView]);
  const refreshGantt = useCallback<WorkspaceRefresh>((...args) => refreshView('gantt', ...args), [refreshView]);
  useEffect(() => { refresh().catch(e => setFailure(e.message)); }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!document.querySelector('dialog:modal') && !hasDocumentIssueOverlay(acceptedRouteRef.current) && !hasContextualIssueOverlay(acceptedRouteRef.current) &&
            !hasTeamBoardIssueOverlay(acceptedRouteRef.current) &&
            !acceptedRouteRef.current?.documentPreviewId && !boardIssueOpener.current) {
          setSearchOpen(value => !value);
        }
      }
      if (event.key === 'Escape' && !document.querySelector('.project-creation-dialog:modal')) {
        setSearchOpen(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const writeRoute = useCallback((route: WorkspaceRoute, index: number, mode: 'push' | 'replace', preserveIssueOpener = false) => {
    const previous = acceptedRouteRef.current;
    const reviewHistoryKey = issueReviewHistoryKey(route);
    const sameReviewSource = previous && (route.view === 'mywork' ? previous.view === 'mywork'
      : route.view === 'backlog' ? issueReviewContext(previous) === issueReviewContext(route) : hasSameDocumentContext(previous, route));
    const historyReview = mode === 'replace' && reviewHistoryKey && (route.view === 'development' || sameReviewSource)
      ? readIssueReviewHistory(history.state?.[reviewHistoryKey], route, index, actorRef.current) : undefined;
    const previousDevelopmentReview = restoredDevelopmentReview.current;
    restoredDevelopmentReview.current = route.view === 'development' ? historyReview?.review ?? null : null;
    setIssueReview(review => {
      const id = route.issueId;
      if (review?.actorId === actorRef.current && id && review.context === issueReviewContext(route) && review.issueIds.includes(id)) return review;
      return historyReview?.review ?? null;
    });
    if (previous && (previous.view === 'issues' || previous.view === 'teamboard' || previous.view === 'gantt')) {
      const changedPane = route.view !== previous.view || route.projectId !== previous.projectId || route.issueId !== previous.issueId;
      const changedIssueView = previous.view === 'issues' && route.savedViewId !== previous.savedViewId;
      const changedChart = previous.view === 'gantt' && (route.ganttScope !== previous.ganttScope || route.ganttProject !== previous.ganttProject ||
        !sameTeamGanttScheduleFilters(route.ganttScheduleFilters, previous.ganttScheduleFilters) || route.planningId !== previous.planningId ||
        ganttTimelineLinkKey(route.ganttTimelineLink) !== ganttTimelineLinkKey(previous.ganttTimelineLink) ||
        route.savedViewId !== previous.savedViewId || route.ganttFocusIssueId !== previous.ganttFocusIssueId ||
        route.ganttFocusDate !== previous.ganttFocusDate || route.ganttMilestoneId !== previous.ganttMilestoneId);
      if (changedPane || changedChart || changedIssueView) refreshContextEpoch.current++;
    }
    const { issueId, issueCommentId, documentId, documentCommentId } = route;
    let linkedComment: WorkspaceCommentFocus | null = null;
    if (issueId && issueCommentId && (previous?.issueId !== issueId || previous.issueCommentId !== issueCommentId)) {
      linkedComment = { targetType: 'issue', targetId: issueId, actorId: null, commentId: issueCommentId, activation: ++commentFocusActivation.current };
    } else if (documentId && documentCommentId && (previous?.documentId !== documentId || previous.documentCommentId !== documentCommentId)) {
      linkedComment = { targetType: 'document', targetId: documentId, actorId: null, commentId: documentCommentId, activation: ++commentFocusActivation.current };
    }
    const openerIssueId = historyReview?.review.openerIssueId;
    if (route.view !== 'development' && historyReview && openerIssueId && !boardIssueOpener.current && !previous?.issueId) {
      const [listSelector, fallbackSelector] = route.view === 'documents' ? ['.document-linked-work', '.document-linked-work-header h3']
        : route.view === 'backlog' ? ['.cycle-board', '.cycle-board-search input'] : ['.my-work-page', '.my-work-heading h1'];
      const list = workspaceMain.current?.querySelector(listSelector);
      const fallback = list?.querySelector<HTMLElement>(fallbackSelector);
      if (list && fallback) {
        const opener = list.querySelector<HTMLElement>(`[data-issue-review-id="${CSS.escape(openerIssueId)}"]`);
        boardIssueOpener.current = { opener: opener ?? fallback, fallback, reviewContext: historyReview.review.context, openerIssueId };
      }
    }
    const boardTrigger = boardIssueOpener.current;
    if (boardTrigger) {
      const sameContext = (target: WorkspaceRoute) => boardTrigger.reviewContext !== undefined
        ? issueReviewContext(target) === boardTrigger.reviewContext : previous && hasSameBoardContext(previous, target);
      const sameSource = sameContext(route);
      if (sameSource && route.issueId) {
        if (!boardTrigger.reviewContext || route.view === 'teamboard') setBoardDialogIssueId(route.issueId);
      }
      else {
        boardIssueOpener.current = null;
        setBoardDialogIssueId(null);
        if (sameSource) requestAnimationFrame(() => {
          const current = acceptedRouteRef.current;
          if (!current || current.issueId || !sameContext(current)) return;
          const cycleRow = route.view === 'backlog' && boardTrigger.openerIssueId ? workspaceMain.current?.querySelector<HTMLElement>(
            `.cycle-board [data-issue-review-id="${CSS.escape(boardTrigger.openerIssueId)}"]`) : null;
          const target = [cycleRow, boardTrigger.opener, boardTrigger.fallback].find(element =>
            element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled'));
          if (target) {
            target.focus({ preventScroll: true });
            if (target === cycleRow && target !== boardTrigger.opener) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
          else if (boardTrigger.reviewContext || route.view === 'teamboard') workspaceMain.current?.focus({ preventScroll: true });
        });
      }
    }
    if (!preserveIssueOpener) {
      if (!previous || !hasSameIssueOverlayContext(previous, route)) overlayIssueOpener.current = null;
      else if (!previous.issueId && route.issueId) {
        const active = document.activeElement;
        overlayIssueOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      } else if (previous.issueId && !route.issueId) {
        const opener = overlayIssueOpener.current;
        overlayIssueOpener.current = null;
        const savedDevelopmentOpener = route.view === 'development' && previousDevelopmentReview?.actorId === actorRef.current &&
          previousDevelopmentReview.context === issueReviewContext(route) ? previousDevelopmentReview.gitlabOpener : undefined;
        const focusMain = route.view === 'teamboard' || route.view === 'search' || route.view === 'favorites' ||
          route.view === 'development' || route.view === 'mywork';
        if (!boardTrigger && (opener || focusMain)) requestAnimationFrame(() => {
          const current = acceptedRouteRef.current;
          if (!current || current.issueId || !hasSameIssueOverlayContext(route, current)) return;
          const restoredFeed = savedDevelopmentOpener && workspaceMain.current?.querySelector('.linked-development');
          const restoredOpener = savedDevelopmentOpener && restoredFeed?.querySelector<HTMLElement>(
            `[data-gitlab-link-id="${CSS.escape(savedDevelopmentOpener.linkId)}"] [data-gitlab-review-opener="${savedDevelopmentOpener.action}"]`);
          const target = opener?.isConnected ? opener : restoredOpener ?? restoredFeed?.querySelector<HTMLElement>('h2');
          if (target && !target.closest('[inert]')) target.focus({ preventScroll: true });
          else if (focusMain || opener && route.view === 'documents') workspaceMain.current?.focus({ preventScroll: true });
        });
      }
    }
    if (hasDocumentIssueOverlay(route) || hasContextualIssueOverlay(route) || hasTeamBoardIssueOverlay(route) || route.documentPreviewId) setSearchOpen(false);
    const hash = routeHash(route);
    const state = { ...(history.state && typeof history.state === 'object' ? history.state : {}), teamspaceRouteIndex: index };
    delete state.teamspaceMyWorkReview;
    delete state.teamspaceCycleBoardIssueReview;
    delete state.teamspaceDocumentIssueReview;
    delete state.teamspaceDevelopmentIssueReview;
    if (reviewHistoryKey && historyReview) state[reviewHistoryKey] = historyReview;
    const returnFocus = route.view === 'publication' && !route.issueId && mode === 'replace' && hash === location.hash
      ? publicationHistoryFocus(state.teamspacePublicationReturnFocus, hash, index) : null;
    if (!returnFocus) delete state.teamspacePublicationReturnFocus;
    const previousHash = previous ? routeHash(previous) : null;
    const sameIndex = routeIndexRef.current === index;
    if (!sameIndex || previousHash !== hash) {
      publicationOpenRequest.current++;
      // A removed last-page row can shrink the list before focus is restored.
      const pageClamp = mode === 'replace' && sameIndex && previousHash === location.hash && isPublicationPageClamp(previous, route);
      if (!pageClamp) setPublicationReturnFocus(previous && returnFocus?.actorId === actorRef.current ? returnFocus : null);
    }
    if (mode === 'push') history.pushState(state, '', hash);
    else history.replaceState(state, '', hash);
    acceptedRouteRef.current = route;
    routeIndexRef.current = index;
    setGitlabActivityId(route.gitlabActivityId ?? null);
    setProjectId(route.projectId); setView(route.view);
    setDocumentId(route.documentId); setIssueId(route.issueId); setReportId(route.reportId || null); setPlanningId(route.planningId || null);
    setCompletionRecordId(route.completionRecordId ?? null);
    setCommentFocus(focus => {
      if (linkedComment) return linkedComment;
      if (!focus) return null;
      if (focus.actorId === null) {
        const sameTarget = focus.targetType === 'issue' ? route.issueId === focus.targetId && route.issueCommentId === focus.commentId
          : route.documentId === focus.targetId && route.documentCommentId === focus.commentId;
        return sameTarget ? focus : null;
      }
      if (focus.targetType === 'issue') return route.issueId === focus.targetId ? focus : null;
      return route.view === 'documents' && route.documentId === focus.targetId && !route.issueId && !route.publication ? focus : null;
    });
    setBlockerScope(previousScope => sameBlockerScope(previousScope, route.blockerScope) ? previousScope : route.blockerScope ?? null);
    setDecisionFollowUpScope(scope => sameDecisionFollowUpScope(scope, route.decisionFollowUpScope) ? scope : route.decisionFollowUpScope ?? null);
    setFieldBreakdownScope(scope => sameFieldBreakdownScope(scope, route.fieldBreakdownScope) ? scope : route.fieldBreakdownScope ?? null);
    setDocumentLabel(route.documentLabel ?? null);
    setDocumentReading(Boolean(route.documentReading));
    setDocumentPreviewId(route.documentPreviewId ?? null);
    setSavedViewId(route.savedViewId ?? null);
    setGanttScope(route.ganttScope);
    setGanttProject(route.ganttProject ?? null);
    const scheduleFilters = route.ganttScheduleFilters ?? emptyTeamGanttScheduleFilters;
    setGanttScheduleFilters(previous => sameTeamGanttScheduleFilters(previous, scheduleFilters) ? previous : scheduleFilters);
    setGanttTimelineLink(route.ganttTimelineLink);
    setGanttFocusIssueId(route.ganttFocusIssueId ?? null);
    setGanttFocusDate(route.ganttFocusDate ?? null);
    setGanttMilestoneId(route.ganttMilestoneId ?? null);
    setPublicationTab(route.publicationTab ?? 'assigned');
    const nextPublicationCriteria = route.publicationCriteria ?? defaultDocumentPublicationCriteria('assigned', '');
    setPublicationCriteria(previousCriteria => sameDocumentPublicationCriteria(previousCriteria, nextPublicationCriteria) ? previousCriteria : nextPublicationCriteria);
    setPublication(previous => previous?.kind === route.publication?.kind && previous?.revisionId === route.publication?.revisionId ? previous : route.publication ?? null);
    setSectionId(route.sectionId ?? null);
    const filters = route.teamOverviewFilters ?? emptyTeamOverviewFilters;
    setTeamOverviewFilters(previous => previous.projectId === filters.projectId && previous.memberId === filters.memberId &&
      previous.date === filters.date && previous.issueMetric === filters.issueMetric && previous.issueOffset === filters.issueOffset ? previous : filters);
    const boardFilters = route.teamBoardFilters ?? emptyTeamBoardFilters;
    setTeamBoardFilters(previous => sameTeamBoardFilters(previous, boardFilters) ? previous : boardFilters);
    setCycleQuery(route.cycleQuery ?? '');
    setIntakeRoute(previous => previous.requestId === (route.intakeRequestId ?? null) && previous.compose === Boolean(route.intakeCompose)
      ? previous : { requestId: route.intakeRequestId ?? null, compose: Boolean(route.intakeCompose) });
    setGitlabActivityFilters(route.gitlabActivityFilters ?? DEFAULT_GITLAB_ACTIVITY_FILTERS);
    const deploymentView = route.gitlabDeploymentView ?? DEFAULT_GITLAB_DEPLOYMENT_VIEW;
    setGitlabDeploymentView(previous => sameGitlabDeploymentView(previous, deploymentView) ? previous : deploymentView);
    const search = route.searchFilters ?? DEFAULT_WORKSPACE_SEARCH_FILTERS;
    setSearchFilters(previous => sameWorkspaceSearchFilters(previous, search) ? previous : search);
  }, []);
  const processLocation = useCallback(() => {
    const snapshot = dataRef.current;
    if (!snapshot) return;
    const previous = acceptedRouteRef.current;
    const previousHash = previous ? routeHash(previous) : null;
    if (rollbackHashRef.current) {
      if (location.hash === rollbackHashRef.current) rollbackHashRef.current = null;
      return;
    }
    const incoming = normalizeRoute(snapshot, location.hash);
    const storedIndex = history.state?.teamspaceRouteIndex;
    const index = Number.isInteger(storedIndex) ? storedIndex : previous ? routeIndexRef.current + 1 : 0;
    // A refreshed workspace can update the space of the document already open.
    const movedOpenDocument = previous && location.hash === previousHash && hasSameDocumentContext(previous, incoming) &&
      previous.projectId !== incoming.projectId && routeHash({ ...incoming, projectId: previous.projectId }) === previousHash;
    const movedOpenIssue = previous && location.hash === previousHash && previous.issueId !== null && previous.issueId === incoming.issueId &&
      previous.projectId !== incoming.projectId && previous.view === incoming.view &&
      routeHash({ ...previous, projectId: incoming.projectId, planningId: null, savedViewId: null,
        ganttTimelineLink: incoming.ganttTimelineLink,
        ganttFocusIssueId: incoming.ganttFocusIssueId, ganttFocusDate: incoming.ganttFocusDate }) === routeHash(incoming);
    if (previous && previousHash && routeHash(incoming) !== previousHash && !movedOpenDocument && !movedOpenIssue && !confirmRouteNavigation(previous, incoming)) {
      const delta = routeIndexRef.current - index;
      if (delta) { rollbackHashRef.current = previousHash; history.go(delta); }
      else history.replaceState({...history.state, teamspaceRouteIndex:routeIndexRef.current}, '', previousHash);
      return;
    }
    writeRoute(incoming, index, 'replace');
  }, [writeRoute]);
  useEffect(() => {
    window.addEventListener('hashchange', processLocation);
    window.addEventListener('popstate', processLocation);
    return () => { window.removeEventListener('hashchange', processLocation); window.removeEventListener('popstate', processLocation); };
  }, [processLocation]);
  useEffect(() => { if (data) processLocation(); }, [data, processLocation]);

  const requestRoute = useCallback((route: WorkspaceRoute, mode: 'push' | 'replace' = 'push', keepIssueReview = false, returnRoute?: WorkspaceRoute,
    publicationReturnTarget?: DocumentPublicationReturnTarget) => {
    const snapshot = dataRef.current;
    if (!snapshot) return false;
    const next = normalizeRoute(snapshot, routeHash(route));
    const previous = acceptedRouteRef.current;
    if (previous && routeHash(next) === routeHash(previous)) { setSidebarOpen(false); return true; }
    if (!confirmRouteNavigation(previous, next)) return false;
    if (previous && mode === 'push' && returnRoute) {
      const origin = normalizeRoute(snapshot, routeHash(returnRoute));
      if (routeHash(origin) !== routeHash(previous)) writeRoute(origin, routeIndexRef.current, 'replace');
    }
    if (mode === 'push' && previous?.view === 'publication' && !previous.issueId && publicationReturnTarget &&
        next.view === 'documents' && next.documentId === publicationReturnTarget.documentId &&
        next.publication?.kind === publicationReturnTarget.kind && next.publication.revisionId === publicationReturnTarget.revisionId) {
      const hash = routeHash(previous);
      if (location.hash === hash) {
        const focus: PublicationHistoryFocus = { hash, index: routeIndexRef.current, actorId: actorRef.current, target: publicationReturnTarget };
        history.replaceState({ ...history.state, teamspacePublicationReturnFocus: focus }, '', hash);
      }
    }
    if (!keepIssueReview && previous?.issueId !== next.issueId) setIssueReview(null);
    writeRoute(next, routeIndexRef.current + (mode === 'push' ? 1 : 0), mode); setSidebarOpen(false);
    return true;
  }, [writeRoute]);
  const navigate = (nextView: View, nextProject = projectId, nextDoc?: string) => {
    const sameView = nextView === view && nextProject === projectId && !(nextView === 'gantt' && ganttScope === 'team');
    requestRoute({projectId:nextProject, view:nextView, documentId:nextDoc || null, issueId:null,
      documentLabel: sameView ? documentLabel : null,
      planningId: sameView && (nextView === 'backlog' || nextView === 'planning') ? planningId : null,
      cycleQuery: sameView && nextView === 'backlog' ? cycleQuery : undefined,
      gitlabActivityFilters: sameView && nextView === 'development' ? gitlabActivityFilters : undefined,
      gitlabDeploymentView: sameView && nextView === 'development' ? gitlabDeploymentView : undefined,
      publicationTab: sameView && nextView === 'publication' ? publicationTab : undefined,
      publicationCriteria: sameView && nextView === 'publication' ? publicationCriteria : undefined,
      savedViewId: sameView ? savedViewId : null, ganttFocusIssueId: sameView ? ganttFocusIssueId : null,
      ganttFocusDate: sameView ? ganttFocusDate : null,
      teamOverviewFilters: nextView === 'teamoverview' && view === 'teamoverview' ? teamOverviewFilters : undefined,
      teamBoardFilters: sameView && nextView === 'teamboard' ? teamBoardFilters : undefined});
  };
  const changeCycleQuery = (query: string) => {
    const current = acceptedRouteRef.current;
    const nextQuery = readIssueFilterQuery(query);
    if (current?.view === 'backlog' && current.cycleQuery !== nextQuery) {
      writeRoute({ ...current, cycleQuery: nextQuery }, routeIndexRef.current, 'replace', true);
    }
  };
  const changePublicationTab = (tab: DocumentPublicationListTab) => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'publication' && !current.issueId && current.publicationTab !== tab) {
      return requestRoute({ ...current, publicationTab: tab, publicationCriteria: defaultDocumentPublicationCriteria(tab, current.projectId) });
    }
    return false;
  };
  const changePublicationCriteria = useCallback((criteria: DocumentPublicationCriteria, mode: 'push' | 'replace') => {
    const current = acceptedRouteRef.current;
    return current?.view === 'publication' && !current.issueId ? requestRoute({ ...current, publicationCriteria: criteria }, mode) : false;
  }, [requestRoute]);
  const changeGitlabActivityFilters = (filters: GitlabActivityFilters, mode: 'push' | 'replace' = 'replace') => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'development' || current.issueId) return;
    const parameters = new URLSearchParams();
    appendGitlabActivityFilters(parameters, filters);
    const next = { ...current, gitlabActivityFilters: readGitlabActivityFilters(parameters) };
    if (routeHash(next) !== routeHash(current)) {
      writeRoute(next, routeIndexRef.current + (mode === 'push' ? 1 : 0), mode);
    }
  };
  const changeGitlabDeploymentView = useCallback<ChangeGitlabDeploymentView>((view, mode, expected) => {
    const current = acceptedRouteRef.current;
    const currentView = current?.gitlabDeploymentView ?? DEFAULT_GITLAB_DEPLOYMENT_VIEW;
    if (current?.view !== 'development' || (current.issueId && mode === 'push') ||
        (expected && !sameGitlabDeploymentView(currentView, expected)) || sameGitlabDeploymentView(currentView, view)) return;
    writeRoute({ ...current, gitlabDeploymentView: view }, routeIndexRef.current + (mode === 'push' ? 1 : 0), mode);
  }, [writeRoute]);
  const changeTeamBoardFilters = (filters: TeamBoardFilters) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'teamboard' || current.issueId) return;
    const changesScope = current.teamBoardFilters?.projectId !== filters.projectId || current.teamBoardFilters?.memberId !== filters.memberId ||
      current.teamBoardFilters?.gitlab !== filters.gitlab;
    requestRoute({ ...current, teamBoardFilters: filters }, changesScope ? 'push' : 'replace');
  };
  const openTeamGantt = () => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'gantt' && current.ganttScope === 'team') {
      return requestRoute({ ...current, issueId: null, documentPreviewId: null });
    }
    return requestRoute({ projectId, view: 'gantt', documentId: null, issueId: null, ganttScope: 'team' });
  };
  const openTeamGanttFromBoard = () => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'teamboard' || current.issueId) return;
    requestRoute(teamGanttRouteFromBoard(current));
  };
  const changeTeamGanttProject = (id: string | null) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'gantt' || current.ganttScope !== 'team' ||
      (id !== null && !dataRef.current?.projects.some(project => project.id === id))) return false;
    // The chart has already checked open editors and retained row dates.
    const next = { ...current, ganttProject: id };
    if (routeHash(next) !== routeHash(current)) writeRoute(next, routeIndexRef.current + 1, 'push');
    return true;
  };
  const changeTeamGanttScheduleFilters = (filters: TeamGanttScheduleFilters) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'gantt' || current.ganttScope !== 'team' || current.issueId ||
      (typeof filters.assigneeId === 'string' && !dataRef.current?.users.some(user => user.id === filters.assigneeId))) return false;
    // The chart has already checked open editors and retained row dates.
    const previous = current.ganttScheduleFilters;
    const next = { ...filters, query: readIssueFilterQuery(filters.query) };
    if (!sameTeamGanttScheduleFilters(previous, next)) {
      const scopeChanged = previous?.assigneeId !== next.assigneeId || Boolean(previous?.unscheduledOnly) !== Boolean(next.unscheduledOnly) || previous?.gitlab !== next.gitlab;
      writeRoute({ ...current, ganttScheduleFilters: next }, routeIndexRef.current + (scopeChanged ? 1 : 0), scopeChanged ? 'push' : 'replace');
    }
    return true;
  };
  const openIssue = (id: string, capacityTrigger?: { opener: HTMLElement; fallback: HTMLElement | null }, issueCommentId?: string) => {
    const issue = dataRef.current?.issues.find(i => i.id === id);
    if (!issue || (issueCommentId !== undefined && !isRelationId(issueCommentId))) return;
    const current = acceptedRouteRef.current;
    const retainedPreview = !issueCommentId && current?.issueId === id ? current.documentPreviewId : null;
    const requestIssueRoute = (route: WorkspaceRoute) => {
      const next = { ...route, issueCommentId };
      const repeat = issueCommentId && current && routeHash(current) === routeHash(next);
      if (repeat && !requestIssueCommentFocus(id)) return false;
      if (!requestRoute(next)) return false;
      if (repeat) setCommentFocus({ targetType: 'issue', targetId: id, actorId: null, commentId: issueCommentId,
        activation: ++commentFocusActivation.current });
      return true;
    };
    if (current?.view === 'documents' && current.documentId) {
      return requestIssueRoute({ ...current, issueId: id, documentPreviewId: retainedPreview });
    }
    if (current?.view === 'teamboard') {
      if (requestIssueRoute({ ...current, issueId: id, documentPreviewId: retainedPreview }) && capacityTrigger) {
        boardIssueOpener.current = capacityTrigger;
        setBoardDialogIssueId(id);
      }
      return;
    }
    if (current?.view === 'search' || current?.view === 'favorites' || current?.view === 'mywork' || current?.view === 'intake' || current?.view === 'gantt' && current.ganttScope === 'team' ||
        current?.view === 'development' && current.projectId === issue.projectId) {
      if (requestIssueRoute({ ...current, issueId: id, documentPreviewId: retainedPreview })) setSearchOpen(false);
      return;
    }
    const sameProject = issue.projectId === projectId;
    if (requestIssueRoute({
      projectId:view === 'teamoverview' || view === 'reports' ? projectId : issue.projectId,
      view:view === 'documents' || view === 'settings' ? 'issues' : view, documentId:null,
      reportId:view === 'reports' ? reportId : null, planningId:sameProject ? planningId : null, savedViewId:sameProject ? savedViewId : null,
      completionRecordId: sameProject && view === 'planning' ? current?.completionRecordId : null,
      cycleQuery: view === 'backlog' && sameProject ? current?.cycleQuery : undefined,
      blockerScope:view === 'reports' ? current?.blockerScope : null,
      decisionFollowUpScope:view === 'reports' ? current?.decisionFollowUpScope : null,
      fieldBreakdownScope:view === 'reports' ? current?.fieldBreakdownScope : null,
      ganttFocusIssueId:sameProject ? ganttFocusIssueId : null,
      ganttFocusDate:sameProject ? ganttFocusDate : null,
      ganttMilestoneId:sameProject ? ganttMilestoneId : null,
      ganttTimelineLink: sameProject && view === 'gantt' ? current?.ganttTimelineLink : undefined,
      publicationTab, publicationCriteria: view === 'publication' ? publicationCriteria : undefined,
      issueId:id, documentPreviewId:retainedPreview, teamOverviewFilters,
    })) {
      if (capacityTrigger && sameProject && view === 'issues') {
        boardIssueOpener.current = capacityTrigger;
        setBoardDialogIssueId(id);
      }
      setSearchOpen(false);
    }
  };
  const openSearchIssue = (id: string, commentId?: string) => openIssue(id, undefined, commentId);
  const openMigratedWikiIssue = async (id: string, commentId?: string, opener?: HTMLAnchorElement, signal?: AbortSignal) => {
    const current = acceptedRouteRef.current;
    if (signal?.aborted || current?.view !== 'documents' || !current.documentId || current.issueId) return false;
    if (!dataRef.current?.issues.some(issue => issue.id === id)) {
      const hash = routeHash(current), index = routeIndexRef.current, actor = actorRef.current;
      const update = await readWorkspace(signal);
      const latest = acceptedRouteRef.current;
      if (signal?.aborted || !latest || routeHash(latest) !== hash || routeIndexRef.current !== index || actorRef.current !== actor) return false;
      applyWorkspace(update);
      if (actorRef.current !== actor) return false;
    }
    const opened = openIssue(id, undefined, commentId) === true;
    if (opened && opener?.isConnected) overlayIssueOpener.current = opener;
    return opened;
  };
  const closeIssuePanel = (id: string) => {
    const current = acceptedRouteRef.current;
    if (current?.issueId === id) requestRoute({ ...current, issueId: null, issueCommentId: null, documentPreviewId: null });
  };
  const openIssueForReview: OpenIssueForReview = (id, source) => {
    const current = acceptedRouteRef.current;
    const gitlabActivity = source.gitlabActivity?.link;
    if (!current || current.issueId || !source.issueIds.includes(id) ||
        (current.view !== 'issues' && current.view !== 'backlog' && current.view !== 'teamboard' && current.view !== 'gantt' && current.view !== 'development' &&
          current.view !== 'mywork' && !isDocumentLinkedWorkRoute(current))) {
      if (!gitlabActivity) openIssue(id);
      return;
    }
    const issue = dataRef.current?.issues.find(value => value.id === id);
    if (gitlabActivity && (gitlabActivity.issueId !== id || current.view !== 'development' || issue?.projectId !== current.projectId)) {
      notify('현재 프로젝트에서 이 활동의 티켓을 찾을 수 없습니다. 목록을 새로고침해 주세요.', 'error');
      return;
    }
    if (!issue) return;
    const context = issueReviewContext(current);
    const projectScope = current.view === 'teamboard' ? current.teamBoardFilters?.projectId ?? null
      : current.view === 'gantt' && current.ganttScope === 'team' ? (source.projectScope === undefined ? current.ganttProject ?? null : source.projectScope)
        : current.view === 'mywork' || current.view === 'documents' ? source.projectScope ?? null : current.projectId;
    if (!requestRoute({ ...current, issueId: id, issueCommentId: null, gitlabActivityId: null, documentPreviewId: null })) return;
    const opened = acceptedRouteRef.current;
    if (!opened || opened.issueId !== id || issueReviewContext(opened) !== context) return;
    boardIssueOpener.current = { opener: source.opener, fallback: source.fallback, reviewContext: context, openerIssueId: id };
    const review: IssueReview = { context, actorId, projectScope, issueIds: [...new Set(source.issueIds)],
      ...(gitlabActivity && source.gitlabActivity && {
        gitlabActivity: source.gitlabActivity.selectActivity ? gitlabActivity : undefined,
        gitlabOpener: { linkId: gitlabActivity.id, action: source.gitlabActivity.selectActivity ? 'activity' : 'issue' },
      }),
      ...(issueReviewHistoryKey(opened) && { openerIssueId: id }) };
    setIssueReview(review);
    rememberIssueReview(opened, routeIndexRef.current, review);
    setSearchOpen(false);
  };
  const advanceIssueReview = (direction: IssueReviewDirection) => {
    const current = acceptedRouteRef.current;
    const latest = dataRef.current;
    const review = issueReview;
    if (!review || !latest || !current?.issueId || review.actorId !== actorId || issueReviewContext(current) !== review.context) return;
    const target = issueReviewPosition(review.issueIds, current.issueId, latest.issues, review.projectScope)?.[direction];
    // Replace the drawer's history slot so Back returns to the originating view.
    if (target && requestRoute({ ...current, issueId: target.id, issueCommentId: null, gitlabActivityId: null, documentPreviewId: null }, 'replace', true)) {
      const opened = acceptedRouteRef.current;
      if (opened?.issueId === target.id && issueReviewContext(opened) === review.context) {
        const nextReview = { ...review, gitlabActivity: undefined, focusDirection: direction };
        setIssueReview(nextReview);
        rememberIssueReview(opened, routeIndexRef.current, nextReview);
        if (opened.view === 'development') restoredDevelopmentReview.current = nextReview;
      }
    }
  };
  const showSearchResults = (query: string) => {
    if (requestRoute({ projectId, view: 'search', documentId: null, issueId: null,
      searchFilters: { ...DEFAULT_WORKSPACE_SEARCH_FILTERS, query } })) setSearchOpen(false);
  };
  const changeSearchFilters = (filters: WorkspaceSearchFilters) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'search' && !current.issueId && requestRoute({ ...current, searchFilters: filters });
  };
  const changeBlockerScope = (scope: DeliveryBlockerDraftScope | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'reports' && !current.issueId && requestRoute({ ...current, reportId: null, blockerScope: scope,
      decisionFollowUpScope: null, fieldBreakdownScope: null });
  };
  const changeDecisionFollowUpScope = (scope: DecisionFollowUpScope | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'reports' && requestRoute({ ...current, reportId: null, blockerScope: null,
      decisionFollowUpScope: scope, fieldBreakdownScope: null });
  };
  const changeFieldBreakdownScope = (scope: FieldBreakdownScope | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'reports' && requestRoute({ ...current, reportId: null, blockerScope: null,
      decisionFollowUpScope: null, fieldBreakdownScope: scope });
  };
  const publishFieldBreakdownScope = useCallback((scope: FieldBreakdownScope): boolean => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'reports' || !current.fieldBreakdownScope || current.projectId !== projectId ||
        !sameFieldBreakdownScope(current.fieldBreakdownScope, fieldBreakdownScope) || location.hash !== routeHash(current)) return false;
    if (!sameFieldBreakdownScope(current.fieldBreakdownScope, scope)) {
      writeRoute({ ...current, fieldBreakdownScope: scope }, routeIndexRef.current, 'replace', true);
    }
    return true;
  }, [fieldBreakdownScope, projectId, writeRoute]);
  const openTeamDecisionFollowUps = () => {
    const scope = decisionFollowUpScope?.projectId !== undefined ? decisionFollowUpScope : { ...DEFAULT_DECISION_FOLLOW_UP_SCOPE, projectId: null };
    requestRoute({ projectId, view: 'reports', documentId: null, issueId: null, decisionFollowUpScope: scope });
  };
  const previewIssueDocument = (id: string) => {
    const current = acceptedRouteRef.current;
    const snapshot = dataRef.current;
    if (!current?.issueId || !snapshot || !canPreviewIssueDocument(snapshot, current.issueId, id)) return false;
    return requestRoute({ ...current, documentPreviewId: id });
  };
  const closeIssueDocumentPreview = () => {
    const current = acceptedRouteRef.current;
    return current?.documentPreviewId ? requestRoute({ ...current, documentPreviewId: null }) : false;
  };
  const openIssueSchedule = (id: string, endpoint?: ScheduleDependencyEndpoint) => {
    const issue = dataRef.current?.issues.find(value => value.id === id);
    if (!issue) return false;
    const current = acceptedRouteRef.current;
    const teamRoute = current?.view === 'teamboard' ? teamGanttRouteFromBoard(current)
      : current?.view === 'gantt' && current.ganttScope === 'team' ? current : null;
    const milestoneRoute = current?.view === 'gantt' && !current.ganttScope && current.ganttMilestoneId &&
      current.projectId === issue.projectId ? current : null;
    const target: WorkspaceRoute = {
      projectId: teamRoute?.projectId ?? issue.projectId, view: 'gantt', documentId: null, issueId: null,
      ganttScope: teamRoute?.ganttScope, ganttProject: teamRoute?.ganttProject, ganttScheduleFilters: teamRoute?.ganttScheduleFilters,
      planningId: milestoneRoute?.planningId, savedViewId: milestoneRoute?.savedViewId,
      ganttMilestoneId: milestoneRoute?.ganttMilestoneId, ganttFocusIssueId: id, ganttFocusDate: endpoint,
    };
    if (endpoint && current && routeHash(current) === routeHash(target) && !confirmRouteNavigation(current, target)) return false;
    if (!requestRoute(target)) return false;
    setIssueFocusActivation(value => value + 1);
    return true;
  };
  const changeGanttMilestone = (id: string | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'gantt' && !current.ganttScope ? requestRoute({ ...current, ganttMilestoneId: id }) : false;
  };
  const openIssueMilestone = (id: string) => {
    const current = acceptedRouteRef.current;
    const snapshot = dataRef.current;
    const issue = snapshot?.issues.find(value => value.id === current?.issueId);
    if (!issue) return false;
    const milestone = snapshot?.milestones?.find(value => value.id === id && value.projectId === issue.projectId && value.issueIds.includes(issue.id));
    if (!milestone) return false;
    const sameGantt = current?.view === 'gantt' && !current.ganttScope && current.projectId === milestone.projectId;
    return requestRoute({ ...(sameGantt ? current : {}), projectId: milestone.projectId, view: 'gantt',
      documentId: null, issueId: null, documentPreviewId: null, ganttMilestoneId: id });
  };
  const openFollowUpSchedule = (id: string) => {
    const issue = dataRef.current?.issues.find(value => value.id === id);
    if (!issue) {
      notify('일정을 열 업무를 찾을 수 없습니다.', 'error');
      return false;
    }
    const endpoint = !isCalendarDate(issue.startDate) ? 'startDate' : !isCalendarDate(issue.endDate) ? 'endDate' : undefined;
    return openIssueSchedule(id, endpoint);
  };
  const selectedPlanReturn = (id?: string) => {
    const current = acceptedRouteRef.current;
    if (id && current?.view === 'planning' && current.planningId !== id) return { ...current, planningId: id };
  };
  const selectPlanning = (id: string | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'planning' && requestRoute({ ...current, planningId: id, completionRecordId: null }, 'replace');
  };
  const openCycleCompletionRecord = (id: string, cycleId: string) => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'planning') requestRoute({ ...current, planningId: cycleId, completionRecordId: id, issueId: null },
      'push', false, selectedPlanReturn(cycleId));
  };
  const openPlanIn = (nextView: 'planning' | 'gantt' | 'backlog', id?: string) => {
    const current = acceptedRouteRef.current;
    return requestRoute({ projectId, view: nextView, documentId: null, planningId: id, issueId: null,
      cycleQuery: nextView === 'backlog' && current?.view === 'backlog' ? current.cycleQuery : undefined },
    'push', false, selectedPlanReturn(id));
  };
  const openReleaseReadiness = (id: string) =>
    requestRoute({ projectId, view: 'reports', documentId: null, issueId: null, blockerScope: { releaseId: id } },
      'push', false, selectedPlanReturn(id));
  const openPlannedIssueSchedule = (issueId: string, planId?: string, recordId?: string) => {
    const snapshot = dataRef.current, current = acceptedRouteRef.current;
    if (!snapshot || !current || (current.view !== 'planning' && current.view !== 'backlog')) return false;
    const issue = snapshot.issues.find(item => item.id === issueId && item.projectId === current.projectId);
    const targetPlanId = recordId ? issue?.cycleId : planId;
    const plan = targetPlanId ? snapshot.planningItems?.find(item => item.id === targetPlanId && item.projectId === current.projectId) : undefined;
    if (!issue || (planId && (!plan || issue[planningFields(plan.kind).idField] !== plan.id))) {
      notify('업무나 계획 연결이 바뀌었습니다. 목록에서 다시 확인해 주세요.', 'error');
      return false;
    }
    const returnRoute = recordId ? { ...current, completionRecordId: recordId }
      : plan && current.planningId !== plan.id ? { ...current, planningId: plan.id } : undefined;
    const endpoint = !isCalendarDate(issue.startDate) ? 'startDate' : !isCalendarDate(issue.endDate) ? 'endDate' : undefined;
    return requestRoute({ projectId: issue.projectId, view: 'gantt', documentId: null, issueId: null, planningId: plan?.id,
      ganttFocusIssueId: issue.id, ganttFocusDate: endpoint }, 'push', false, returnRoute);
  };
  const openDocument = (id: string, requestedSectionId?: string, requestedCommentId?: string) => {
    const document = dataRef.current?.documents.find(d => d.id === id);
    if (!document || requestedCommentId !== undefined && !isRelationId(requestedCommentId)) return;
    const targetSectionId = !requestedCommentId && isDocumentSectionId(requestedSectionId) ? requestedSectionId : null;
    const current = acceptedRouteRef.current;
    if (!requestedCommentId && !targetSectionId && current?.view === 'documents' && current.documentId === id && current.issueId) {
      closeIssuePanel(current.issueId);
      return;
    }
    const targetProject = document.projectId || projectId;
    const next: WorkspaceRoute = { projectId: targetProject, view: 'documents', documentId: id, issueId: null,
      sectionId: targetSectionId, documentCommentId: requestedCommentId,
      documentLabel: current?.view === 'documents' && targetProject === current.projectId ? current.documentLabel : null,
      documentReading: current?.view === 'documents' && current.documentReading };
    if (requestRoute(next)) {
      setSearchOpen(false);
      if (requestedCommentId && current && routeHash(current) === routeHash(next)) {
        setCommentFocus({ targetType: 'document', targetId: id, actorId: null, commentId: requestedCommentId, activation: ++commentFocusActivation.current });
      }
    }
  };
  const openCycleRetrospective = (id: string, recordId: string) => {
    const current = acceptedRouteRef.current;
    const document = dataRef.current?.documents.find(value => value.id === id);
    if (current?.view !== 'planning' || !document) return;
    requestRoute({ projectId: document.projectId || current.projectId, view: 'documents', documentId: id, issueId: null },
      'push', false, { ...current, issueId: null, completionRecordId: recordId });
  };
  const openNotification = async (notification: TeamNotification) => {
    const request = ++notificationOpenRequest.current;
    const routeIndex = routeIndexRef.current;
    const active = () => request === notificationOpenRequest.current && routeIndex === routeIndexRef.current;
    try { await refresh(); }
    catch (cause) {
      if (active()) notify((cause as Error).message, 'error');
      return false;
    }
    if (!active()) return false;
    const snapshot = dataRef.current;
    const openTarget = (targetType: WorkspaceCommentFocus['targetType'], route: WorkspaceRoute) => {
      const { targetId, commentId } = notification;
      const previous = acceptedRouteRef.current;
      if (commentId && targetType === 'issue' && previous && routeHash(previous) === routeHash(route) &&
          !requestIssueCommentFocus(targetId)) return false;
      if (!requestRoute(route)) return false;
      setCommentFocus(commentId ? { targetType, targetId, actorId, commentId, activation: ++commentFocusActivation.current } : null);
      return true;
    };
    if (notification.kind.startsWith('issue-')) {
      const issue = snapshot?.issues.find(value => value.id === notification.targetId);
      if (issue) return openTarget('issue', { projectId:issue.projectId, view:'issues', documentId:null, issueId:issue.id,
        savedViewId:view === 'issues' && projectId === issue.projectId ? savedViewId : null });
    } else {
      const doc = snapshot?.documents.find(value => value.id === notification.targetId);
      if (doc) return openTarget('document', { projectId:doc.projectId || projectId, view:'documents', documentId:doc.id, issueId:null });
    }
    notify('알림의 대상이 삭제되었거나 현재 워크스페이스에 없습니다.', 'error');
    return false;
  };
  const openPublication = async (id: string, kind: DocumentPublicationTarget['kind'], revisionId: string, returnToLibrary = false) => {
    const origin = acceptedRouteRef.current;
    if (!origin || routeHash(origin) !== location.hash || (returnToLibrary && origin.view !== 'publication')) return;
    const request = ++publicationOpenRequest.current;
    const from = location.hash;
    const index = routeIndexRef.current;
    const actor = actorRef.current;
    const active = () => request === publicationOpenRequest.current && index === routeIndexRef.current && from === location.hash && actor === actorRef.current;
    let document = dataRef.current?.documents.find(value => value.id === id);
    if (!document) {
      try {
        const read = await readWorkspace();
        if (!active()) return;
        applyWorkspace(read);
      }
      catch (cause) {
        if (active()) notify((cause as Error).message,'error');
        return;
      }
      if (!active()) return;
      document = dataRef.current?.documents.find(value => value.id === id);
    }
    if (!document) {
      notify('문서가 변경되었거나 삭제되었습니다. 목록을 새로 불러와 주세요.', 'error');
      return;
    }
    requestRoute({projectId:document.projectId || origin.projectId,view:'documents',documentId:id,publication:{kind,revisionId},issueId:null},
      'push', false, undefined, returnToLibrary ? { documentId: id, kind, revisionId } : undefined);
  };
  const closePublicationLink = useCallback((id: string, target: DocumentPublicationTarget) => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'documents' && current.documentId === id && current.publication?.kind === target.kind &&
      current.publication.revisionId === target.revisionId) {
      writeRoute({...current, publication:null, sectionId:null},routeIndexRef.current,'replace');
    }
  }, [writeRoute]);
  // The document tree already confirms/cache-preserves its local draft before invoking this callback.
  const selectDocument = (id: string, recovery?: { documentId: string; beforeOpen: () => void }, reading = false) => {
    const snapshot = dataRef.current;
    const previous = acceptedRouteRef.current;
    if (!snapshot || recovery && (previous?.view !== 'documents' || previous.documentId !== recovery.documentId ||
        !snapshot.documents.some(document => document.id === id))) return false;
    const route = normalizeRoute(snapshot, routeHash({projectId,view:'documents',documentId:id,issueId:null,documentLabel,documentReading:reading}));
    if (previous && routeHash(previous) === routeHash(route)) return true;
    const automaticSelection = previous?.view === 'documents' && !previous.documentId;
    recovery?.beforeOpen();
    writeRoute(route, routeIndexRef.current + (automaticSelection ? 0 : 1), automaticSelection ? 'replace' : 'push');
    return true;
  };
  const changeDocumentReading = (reading: boolean) => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'documents' && current.documentId && !current.issueId && !current.publication) {
      requestRoute({ ...current, documentReading: reading });
    }
  };
  const copyDocumentCommentLink = async (commentId: string) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'documents' || !current.documentId || !isRelationId(commentId)) return;
    const url = new URL(location.href);
    url.hash = routeHash({ projectId: current.projectId, view: 'documents', documentId: current.documentId, issueId: null,
      documentCommentId: commentId, documentReading: current.documentReading });
    try {
      await navigator.clipboard.writeText(url.href);
      notify('댓글 링크를 복사했습니다.');
    } catch {
      notify('댓글 링크를 복사하지 못했습니다.', 'error');
    }
  };
  const copyGitlabActivityLink = async (linkId: string) => {
    const currentIssueId = acceptedRouteRef.current?.issueId;
    const issue = dataRef.current?.issues.find(value => value.id === currentIssueId);
    if (!issue || !isRelationId(linkId)) return;
    const url = new URL(location.origin);
    url.pathname = location.pathname;
    url.hash = routeHash({ projectId: issue.projectId, view: 'issues', documentId: null, issueId: issue.id, gitlabActivityId: linkId });
    try {
      await navigator.clipboard.writeText(url.href);
      notify('티켓 활동 링크를 복사했습니다.');
    } catch {
      notify('티켓 활동 링크를 복사하지 못했습니다.', 'error');
    }
  };
  const copyGanttTimelineLink = async (link: GanttTimelineLink, selectedPlanId: string | null) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'gantt') return;
    const team = current.ganttScope === 'team';
    const url = new URL(location.pathname, location.origin);
    url.hash = routeHash({ projectId: current.projectId, view: 'gantt', documentId: null, issueId: null,
      ganttScope: current.ganttScope, ganttProject: current.ganttProject, ganttScheduleFilters: current.ganttScheduleFilters,
      planningId: team ? null : selectedPlanId, savedViewId: current.savedViewId, ganttTimelineLink: link });
    try {
      await navigator.clipboard.writeText(url.href);
      notify(`${link.date} 간트 위치 링크를 복사했습니다.`);
    } catch {
      notify('간트 위치 링크를 복사하지 못했습니다.', 'error');
    }
  };
  const changeIntakeRequest = (id: string | null) => {
    const current = acceptedRouteRef.current;
    return current?.view === 'intake' && !current.issueId && (id === null || isRelationId(id))
      ? requestRoute({ ...current, intakeCompose: false, intakeRequestId: id }) : false;
  };
  const closeIntakeCompose = () => {
    const current = acceptedRouteRef.current;
    return current?.view === 'intake' && current.intakeCompose
      ? requestRoute({ ...current, intakeCompose: false }, 'replace') : false;
  };
  const openIntakeIssue = async (id: string) => {
    const source = acceptedRouteRef.current;
    if (source?.view !== 'intake' || !source.intakeRequestId) return false;
    const context = routeHash(source), actor = actorRef.current;
    await refresh();
    const current = acceptedRouteRef.current;
    return Boolean(current && routeHash(current) === context && actorRef.current === actor &&
      dataRef.current?.issues.some(issue => issue.id === id) && requestRoute({ ...current, issueId: id }));
  };
  const copyIntakeLink = async (id?: string) => {
    const current = acceptedRouteRef.current;
    if (current?.view !== 'intake' || (id && !isRelationId(id))) return false;
    const url = new URL(location.pathname, location.origin);
    url.hash = routeHash({ projectId: current.projectId, view: 'intake', documentId: null, issueId: null,
      intakeRequestId: id, intakeCompose: !id });
    try {
      await navigator.clipboard.writeText(url.href);
      notify(id ? '접수 요청 링크를 복사했습니다.' : '업무 접수 링크를 복사했습니다.');
      return true;
    } catch {
      notify('접수 링크를 복사하지 못했습니다.', 'error');
      return false;
    }
  };

  if (!data) return <div className="loading-screen"><div className="brand-mark"><Command size={26}/></div><h1>Teamspace</h1>{failure ? <><p className="error-text">{failure}</p><button className="btn btn-primary" onClick={() => refresh().catch(e => setFailure(e.message))}>다시 연결</button><p className="muted">API 서버가 실행 중인지 확인해주세요.</p></> : <><LoaderCircle className="spin"/><p className="muted">팀의 업무 공간을 불러오는 중입니다</p></>}</div>;
  const project = data.projects.find(p => p.id === projectId) || data.projects[0];
  const actor = data.users.find(u => u.id === actorId);
  const props: FeatureProps = { data, projectId, actorId, refresh, notify, openIssue, openDocument };
  const projectIssues = data.issues.filter(i => i.projectId === projectId);
  const openedIssue = data.issues.find(issue => issue.id === issueId);
  const reviewPosition = issueReview?.actorId === actorId && openedIssue
    ? issueReviewPosition(issueReview.issueIds, openedIssue.id, data.issues, issueReview.projectScope) : undefined;
  const selectedGitlabActivity = issueReview?.gitlabActivity;
  const gitlabActivitySelection = view === 'development' && reviewPosition && issueReview?.projectScope === projectId &&
    openedIssue?.projectId === projectId && selectedGitlabActivity?.issueId === openedIssue.id ? selectedGitlabActivity : undefined;
  const teamGantt = view === 'gantt' && ganttScope === 'team';
  const teamBoard = view === 'teamboard';
  const teamDecisions = view === 'reports' && decisionFollowUpScope?.projectId !== undefined;
  const teamPageLabel = teamBoard ? '전체 프로젝트 보드' : teamGantt ? '전체 프로젝트 간트' :
    teamDecisions ? '팀 결정 후속 업무' : view === 'teamoverview' ? '팀 개요' : view === 'search' ? '검색 결과' : view === 'favorites' ? '즐겨찾기' : null;
  const documentIssueOpen = view === 'documents' && Boolean(documentId && openedIssue);
  const contextualIssueOpen = Boolean(openedIssue && isContextualIssueView(view));
  const reportIssueOpen = view === 'reports' && contextualIssueOpen;
  const activeDocumentPreviewId = openedIssue && documentPreviewId && canPreviewIssueDocument(data, openedIssue.id, documentPreviewId)
    ? documentPreviewId : null;
  const activeCommentFocus = commentFocus && (commentFocus.actorId === null || commentFocus.actorId === actorId) ? commentFocus : undefined;
  const boardIssueFocus = Boolean(openedIssue && (teamBoard || openedIssue.id === boardDialogIssueId));
  const workspaceObscured = documentIssueOpen || contextualIssueOpen || boardIssueFocus || Boolean(reviewPosition || activeDocumentPreviewId);

  return <FavoritesProvider actorId={actorId} notify={notify}><div className="workspace">
    {sidebarOpen && !workspaceObscured && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)}/>}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} inert={workspaceObscured}>
      <div className="workspace-brand"><div className="brand-mark"><Command size={22}/></div><div><strong>Teamspace</strong><span>함께 만드는 팀의 작업 공간</span></div><button className="icon-btn mobile-only" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기"><X size={18}/></button></div>
      <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16}/><span>업무와 문서 검색</span><kbd>⌘ K</kbd></button>
      <nav className="sidebar-section">
        <button className={`nav-item ${view === 'teamoverview' ? 'active' : ''}`} aria-current={view === 'teamoverview' ? 'page' : undefined} onClick={() => navigate('teamoverview')}><LayoutDashboard size={18}/><span>팀 개요</span></button>
        <button type="button" className={`nav-item ${teamBoard ? 'active' : ''}`} aria-current={teamBoard ? 'page' : undefined}
          disabled={!project} data-gantt-focus-control={view === 'gantt' ? '' : undefined}
          onPointerDown={view === 'gantt' ? keepGanttDateFocus : undefined} onClick={() => navigate('teamboard')}><Columns3 size={18}/><span>전체 프로젝트 보드</span></button>
        <button type="button" className={`nav-item ${teamGantt ? 'active' : ''}`} aria-current={teamGantt ? 'page' : undefined} disabled={!project}
          data-gantt-focus-control="" onPointerDown={keepGanttDateFocus} onClick={openTeamGantt}><SquareChartGantt size={18}/><span>전체 프로젝트 간트</span></button>
        <button type="button" className={`nav-item ${teamDecisions ? 'active' : ''}`} aria-current={teamDecisions ? 'page' : undefined} disabled={!project}
          data-gantt-focus-control={view === 'gantt' ? '' : undefined} onPointerDown={view === 'gantt' ? keepGanttDateFocus : undefined}
          onClick={openTeamDecisionFollowUps}><ClipboardList size={18}/><span>팀 결정 후속 업무</span></button>
        <button className={`nav-item ${view === 'mywork' ? 'active' : ''}`} aria-current={view === 'mywork' ? 'page' : undefined} onClick={() => navigate('mywork')}><CircleDot size={18}/><span>내 업무</span><span className="nav-count">{countActiveMyWork(data, actorId, issueSubscriptions.ids)}</span></button>
        <button type="button" className={`nav-item ${view === 'favorites' ? 'active' : ''}`} aria-current={view === 'favorites' ? 'page' : undefined}
          data-gantt-focus-control={view === 'gantt' ? '' : undefined} onPointerDown={view === 'gantt' ? keepGanttDateFocus : undefined}
          onClick={() => navigate('favorites')}><Star size={18} aria-hidden="true"/><span>즐겨찾기</span></button>
        <button className={`nav-item ${view === 'trash' ? 'active' : ''}`} onClick={() => navigate('trash')}><Trash2 size={17}/><span>휴지통</span></button>
      </nav>
      <div className="sidebar-section-title"><span>프로젝트</span><button className="icon-btn" title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={() => setProjectModal(true)}><Plus size={15}/></button></div>
      <div className="project-list">{data.projects.map(p => <button key={p.id} className={`project-item ${p.id === projectId ? 'selected' : ''}`} onClick={() => navigate('overview', p.id)}><span className="project-symbol" style={{background: p.color + '17', color: p.color}}>{p.key.slice(0,1)}</span><span>{p.name}</span>{p.id === projectId && <ChevronDown size={14}/>}</button>)}</div>
      {project && <nav className="project-navigation">{navigation.map(item => {
        const active = view === item.id && (item.id !== 'gantt' || !teamGantt) && (item.id !== 'reports' || !teamDecisions);
        const exitsTeamGantt = item.id === 'gantt' && teamGantt;
        return <button key={item.id} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}
          data-gantt-focus-control={exitsTeamGantt ? '' : undefined} onPointerDown={exitsTeamGantt ? keepGanttDateFocus : undefined}
          onClick={() => navigate(item.id)}><item.icon size={17}/><span>{item.label}</span>{item.id === 'issues' && <span className="nav-count">{projectIssues.length}</span>}</button>;
      })}</nav>}
      <div className="sidebar-note"><Sparkles size={17}/><strong>업무와 지식을 한곳에</strong><p>계획에서 구현, 그리고 문서까지.<br/>우리 팀의 흐름을 연결하세요.</p></div>
      <div className="sidebar-footer">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={17}/><span>워크스페이스 설정</span></button>
        {pilotAccess && <a className="nav-item" href="/pilot-access" target="_blank" rel="noopener noreferrer"><KeyRound size={17}/><span>팀 접속</span></a>}
        <div className="local-status"><span/>{environmentLabel} <span className="version-label">v0.1</span></div>
      </div>
    </aside>
    <div className="workspace-content" inert={workspaceObscured}>
      <header className="topbar"><button className="icon-btn mobile-only" aria-label="메뉴 열기" data-gantt-focus-control={view === 'gantt' ? '' : undefined}
        onPointerDown={view === 'gantt' ? keepGanttDateFocus : undefined} onClick={() => setSidebarOpen(true)}><ListTodo size={20}/></button><div className="breadcrumbs"><span className="breadcrumb-workspace">워크스페이스</span><ChevronRight size={14}/>{teamPageLabel ? <strong>{teamPageLabel}</strong> : <><span>{project?.name || '새 프로젝트'}</span><ChevronRight size={14}/><strong>{view === 'settings' ? '설정' : view === 'mywork' ? '내 업무' : view === 'trash' ? '휴지통' : navigation.find(n => n.id === view)?.label}</strong></>}</div><div className="topbar-actions">
        <PublicationInboxButton actorId={actorId} onClick={() => navigate('publication')}/>
        {actorId && <TeamNotifications actorId={actorId} users={data.users} onOpen={openNotification}/>}
        <button className="icon-btn" aria-label="통합 검색" title="통합 검색" onClick={() => setSearchOpen(true)}><Search size={18}/></button>
        <div className="actor-picker"><span className="avatar" style={{background: actor?.color}}>{actor?.name.slice(0,1)}</span><label className="sr-only" htmlFor="actor-select">작업자 선택</label><select id="actor-select" value={actorId} onChange={e => {
          if(!dispatchWorkspaceNavigation())return;
          publicationOpenRequest.current++;notificationOpenRequest.current++;
          setPublicationReturnFocus(null);
          setIssueReview(null);
          setCommentFocus(focus => focus?.actorId === null ? focus : null);
          actorRef.current = e.target.value;
          setActorId(e.target.value);setActor(e.target.value);localStorage.setItem('teamspace.actor',e.target.value);
        }}>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      </div></header>
      <main className={`main-content view-${view}`} ref={workspaceMain}
        tabIndex={teamBoard || view === 'issues' || view === 'gantt' || view === 'search' || view === 'favorites' || view === 'mywork' ? -1 : undefined}>
        {view === 'overview' && <Overview {...props} navigate={navigate}/>}
        {view === 'teamoverview' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>팀 개요를 불러오는 중입니다.</p></div>}>
          <TeamOverview {...props} filters={teamOverviewFilters} openPublication={openPublication}
            onFiltersChange={filters => requestRoute({projectId,view,documentId:null,issueId,teamOverviewFilters:filters})}
            openProject={(id, destination) => navigate(destination,id)} onOpenIssueSchedule={openIssueSchedule}
            openGitlabActivity={(id, memberId) => requestRoute({ projectId: id, view: 'development', documentId: null, issueId: null,
              gitlabActivityFilters: { ...DEFAULT_GITLAB_ACTIVITY_FILTERS, memberId: memberId || undefined } })}/>
        </Suspense>}
        {teamBoard && project && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>전체 프로젝트 보드를 불러오는 중입니다.</p></div>}>
          <TeamBoard {...props} filters={teamBoardFilters} onFiltersChange={changeTeamBoardFilters} onOpenGantt={openTeamGanttFromBoard} onOpenBoardIssue={openIssue}
            onOpenIssueForReview={openIssueForReview}
            refreshBoard={refreshBoard} issueOverlayOpen={boardIssueFocus}/>
        </Suspense>}
        {view === 'mywork' && <MyWork key={actorId} data={data} actorId={actorId} openIssue={openIssue} refresh={refresh} notify={notify}
          subscriptions={issueSubscriptions} onOpenIssueForReview={openIssueForReview}/>}
        {view === 'favorites' && <FavoritesPage data={data} openIssue={openIssue} openDocument={openDocument} refresh={refresh}/>}
        {view === 'search' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>검색을 불러오는 중입니다.</p></div>}>
          <WorkspaceSearch data={data} filters={searchFilters} onChange={changeSearchFilters} refresh={refresh} openIssue={openSearchIssue} openDocument={openDocument}/>
        </Suspense>}
        {view === 'issues' && <Issues {...props} savedViewId={savedViewId} refreshIssues={refreshIssues} issueOverlayOpen={Boolean(issueId)}
          onOpenIssueForReview={openIssueForReview}
          onOpenBoardCapacityIssue={openIssue}
          onOpenCycleBoard={() => openPlanIn('backlog')}
          onChangeSavedView={id => requestRoute({projectId,view:'issues',documentId:null,issueId,savedViewId:id})}
          onOpenGantt={id => requestRoute({projectId,view:'gantt',documentId:null,issueId:null,savedViewId:id})}
          onOpenFieldBreakdown={id => requestRoute({projectId,view:'reports',documentId:null,issueId:null,fieldBreakdownScope:{savedViewId:id}})}/>}
        {view === 'intake' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>업무 접수를 불러오는 중입니다.</p></div>}>
          <IssueIntake {...props} composeFromLink={intakeRoute.compose} selectedRequestId={intakeRoute.requestId}
            onChangeRequest={changeIntakeRequest} onCloseCompose={closeIntakeCompose}
            onCopySubmissionLink={() => copyIntakeLink()} onCopyRequestLink={copyIntakeLink}
            issueOverlayOpen={Boolean(issueId)} onOpenLinkedIssue={openIntakeIssue} />
        </Suspense>}
        {view === 'backlog' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>사이클 계획을 불러오는 중입니다.</p></div>}>
          <CycleBoard key={`${projectId}:${actorId}`} {...props} initialCycleId={planningId} onChangeCycle={id => openPlanIn('backlog', id)}
            query={cycleQuery} onQueryChange={changeCycleQuery} onOpenIssueSchedule={openPlannedIssueSchedule}
            onOpenIssueForReview={openIssueForReview}
            onOpenPlanning={id => openPlanIn('planning', id)} onOpenIssues={() => navigate('issues')} />
        </Suspense>}
        {view === 'gantt' && <Gantt {...props} refreshGantt={refreshGantt} allProjects={teamGantt} teamProjectFilter={ganttProject} onChangeTeamProjectFilter={changeTeamGanttProject}
          onOpenIssueForReview={openIssueForReview} issueDateDraftsRef={ganttDateDraftsRef}
          teamScheduleFilters={ganttScheduleFilters} onChangeTeamScheduleFilters={changeTeamGanttScheduleFilters}
          timelineLink={ganttTimelineLink} onCopyTimelineLink={copyGanttTimelineLink}
          onOpenProjectGantt={id => requestRoute({ projectId: id, view: 'gantt', documentId: null, issueId: null })}
          initialPlanningId={planningId} ganttViewId={savedViewId} onOpenPlanning={id => openPlanIn('planning',id)}
          milestoneReviewId={ganttMilestoneId} onChangeMilestoneReview={changeGanttMilestone}
          focusIssueId={ganttFocusIssueId} focusDateEndpoint={ganttFocusDate} issueOverlayOpen={Boolean(openedIssue)} issueFocusActivation={issueFocusActivation}
          onLocateIssueDate={openIssueSchedule}
          onClearIssueFocus={() => {
            const current = acceptedRouteRef.current;
            return current?.view === 'gantt' ? requestRoute({ ...current, ganttFocusIssueId: null, ganttFocusDate: null }) : false;
          }}
          onChangeGanttView={id => requestRoute({projectId,view:'gantt',documentId:null,issueId,planningId,savedViewId:id,ganttMilestoneId,ganttTimelineLink})}
          onOpenSavedIssueView={id => requestRoute({projectId,view:'issues',documentId:null,issueId:null,savedViewId:id})}/>}
        {view === 'planning' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>프로젝트 계획을 불러오는 중입니다.</p></div>}>
          <Planning {...props} initialPlanningId={planningId} onOpenGantt={id => openPlanIn('gantt',id)}
            completionRecordId={completionRecordId} onOpenCycleRetrospective={openCycleRetrospective}
            onOpenCompletionRecord={openCycleCompletionRecord}
            onOpenCarryoverSchedule={(id, recordId) => openPlannedIssueSchedule(id, undefined, recordId)}
            onCloseCompletionRecord={() => openPlanIn('planning', planningId ?? undefined)}
            onSelectPlanning={selectPlanning} onOpenIssueSchedule={openPlannedIssueSchedule}
            onOpenCycleBoard={id => openPlanIn('backlog', id)} onOpenReleaseReadiness={openReleaseReadiness} />
        </Suspense>}
        {view === 'reports' && project && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>보고서를 불러오는 중입니다.</p></div>}>
          <Reports {...props} snapshotId={reportId} initialBlockerScope={blockerScope} decisionFollowUpScope={decisionFollowUpScope}
            onChangeBlockerScope={changeBlockerScope} onOpenReleasePlan={id => openPlanIn('planning', id)} onOpenReleaseGantt={id => openPlanIn('gantt', id)}
            onChangeDecisionFollowUpScope={changeDecisionFollowUpScope} onOpenIssueSchedule={openFollowUpSchedule} fieldBreakdownScope={fieldBreakdownScope}
            onChangeFieldBreakdownScope={changeFieldBreakdownScope} onPublishFieldBreakdownScope={publishFieldBreakdownScope}
            onOpenSavedIssueView={id => requestRoute({projectId,view:'issues',documentId:null,issueId:null,savedViewId:id})}
            issueOverlayOpen={reportIssueOpen}/>
        </Suspense>}
        {view === 'documents' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>문서를 불러오는 중입니다.</p></div>}><Documents {...props} selectedDocumentId={documentId} sectionId={sectionId} onSelectDocument={selectDocument} publicationLink={publication} onClosePublicationLink={closePublicationLink} issueDrawerOpen={documentIssueOpen}
          commentFocus={activeCommentFocus?.targetType === 'document' && activeCommentFocus.targetId === documentId ? activeCommentFocus : undefined}
          reading={documentReading} onChangeReading={changeDocumentReading}
          onCopyCommentLink={copyDocumentCommentLink} onOpenIssueSchedule={openFollowUpSchedule} onOpenIssueForReview={openIssueForReview}
          onOpenMigratedIssue={openMigratedWikiIssue}
          documentLabel={documentLabel} onChangeDocumentLabel={label => {
            const current = acceptedRouteRef.current;
            if (current?.view === 'documents') requestRoute({...current, documentLabel:label});
          }}/></Suspense>}
        {view === 'publication' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>검토함을 불러오는 중입니다.</p></div>}><DocumentPublicationLibrary {...props} tab={publicationTab} criteria={publicationCriteria}
          onTabChange={changePublicationTab} onCriteriaChange={changePublicationCriteria}
          onOpenPublication={(id, kind, revisionId) => { void openPublication(id, kind, revisionId, true); }}
          returnFocus={publicationReturnFocus?.actorId === actorId ? publicationReturnFocus.target : undefined}/></Suspense>}
        {view === 'development' && <Development {...props} activityFilters={gitlabActivityFilters}
          deploymentView={gitlabDeploymentView} onChangeDeploymentView={changeGitlabDeploymentView}
          onChangeActivityFilters={changeGitlabActivityFilters} onOpenIssueForReview={openIssueForReview} />}
        {view === 'settings' && <WorkspaceSettings key={actorId} {...props}/>}
        {view === 'trash' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>휴지통을 불러오는 중입니다.</p></div>}><Trash key={actorId} {...props}/></Suspense>}
        {!project && view !== 'trash' && view !== 'teamoverview' && view !== 'search' && view !== 'favorites' && <div className="empty-state"><FolderPlus/><h2>첫 프로젝트를 만들어보세요</h2><button className="btn btn-primary" onClick={() => setProjectModal(true)}>프로젝트 만들기</button></div>}
      </main>
    </div>
    {openedIssue && <IssuePanel key={`${openedIssue.id}:${actorId}`} {...props} projectId={openedIssue.projectId} documentOverlay={documentIssueOpen} modalFocus={boardIssueFocus || contextualIssueOpen || Boolean(reviewPosition)}
      issueId={openedIssue.id} onOpenIssueSchedule={openIssueSchedule} onOpenMilestone={openIssueMilestone} onClose={() => closeIssuePanel(openedIssue.id)}
      ganttDateDraftsRef={view === 'gantt' ? ganttDateDraftsRef : undefined}
      reviewPosition={reviewPosition && { ...reviewPosition, focusDirection: issueReview?.focusDirection }} onAdvanceReview={advanceIssueReview}
      gitlabActivitySelection={gitlabActivitySelection} gitlabActivityId={gitlabActivityId} onCopyGitlabActivityLink={copyGitlabActivityLink}
      commentFocus={activeCommentFocus?.targetType === 'issue' && activeCommentFocus.targetId === openedIssue.id ? activeCommentFocus : undefined}
      previewDocumentId={activeDocumentPreviewId} onPreviewDocument={previewIssueDocument} onCloseDocumentPreview={closeIssueDocumentPreview}/>}
    {searchOpen && <SearchDialog {...props} openIssue={openSearchIssue} openDocument={openDocument} onClose={() => setSearchOpen(false)} onShowAll={showSearchResults}/>}
    {projectModal && <ProjectCreationDialog actorId={actorId} restoreGeneration={data.restoreGeneration} refresh={refresh} notify={notify}
      onClose={() => setProjectModal(false)} onOpenProject={id => {
        if (!dataRef.current?.projects.some(project => project.id === id) ||
            !requestRoute({ projectId: id, view: 'overview', documentId: null, issueId: null })) return false;
        requestAnimationFrame(() => workspaceMain.current?.querySelector<HTMLElement>('.overview-page h1')?.focus());
        return true;
      }}/>}
    {toast && <div role="status" className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={18}/> : <Bell size={18}/>}<span>{toast.message}</span><button onClick={() => setToast(null)} className="icon-btn" aria-label="알림 닫기"><X size={15}/></button></div>}
  </div></FavoritesProvider>;
}

function PublicationInboxButton({actorId,onClick}:{actorId:string;onClick:()=>void}) {
  const [summary,setSummary] = useState<{actorId:string;count:number} | null>(null);
  useEffect(() => {
    if (!actorId) return;
    let request: AbortController | undefined;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void api<{pendingAssigned:number}>('/document-publications/count', {
        headers:{'X-Actor-Id':actorId},signal:controller.signal,
      }).then(value => {
        if (!controller.signal.aborted) setSummary({actorId,count:value.pendingAssigned});
      }).catch(() => {
        if (!controller.signal.aborted) setSummary(null);
      });
    };
    load();
    const timer = setInterval(load,30_000);
    window.addEventListener('focus',load);
    window.addEventListener('teamspace:publication-changed',load);
    document.addEventListener('visibilitychange',load);
    return () => {
      request?.abort();
      clearInterval(timer);
      window.removeEventListener('focus',load);
      window.removeEventListener('teamspace:publication-changed',load);
      document.removeEventListener('visibilitychange',load);
    };
  }, [actorId]);
  const count = actorId === summary?.actorId ? summary.count : null;
  return <button type="button" className="icon-btn publication-inbox-button" aria-label="검토함·발행본"
    aria-description={count === null ? undefined : `배정된 검토 ${count}개`} title="검토함·발행본" onClick={onClick}>
    <Inbox size={18} />{count !== null && count > 0 && <span className="publication-inbox-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
  </button>;
}

function Overview(props: FeatureProps & {navigate: (view: View) => void}) {
  const { data, projectId, openIssue, openDocument, navigate } = props;
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return null;
  const issues = data.issues.filter(i => i.projectId === projectId);
  const documents = data.documents.filter(d => d.projectId === projectId);
  const tracked = issues.filter(i => statusMeta(data,i.projectId,i.status).category !== 'cancelled');
  const statuses = projectStatuses(data,projectId);
  const completed = issues.filter(i => statusMeta(data,i.projectId,i.status).category === 'done').length;
  const active = issues.filter(i => ['in_progress','review'].includes(statusMeta(data,i.projectId,i.status).category));
  const today = new Date().toLocaleDateString('sv-SE');
  const overdue = issues.filter(i => i.endDate && i.endDate < today && !isTerminalStatus(data, i.projectId, i.status));
  const percent = tracked.length ? Math.round(completed / tracked.length * 100) : 0;
  const recentIds = new Set([...issues.map(i => i.id), ...documents.map(d => d.id), projectId]);
  const activities = data.activities.filter(a => recentIds.has(a.resourceId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,8);
  return <div className="page overview-page"><div className="page-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1 tabIndex={-1}>{project.name}</h1><p>{project.description || '팀의 목표를 업무와 문서로 연결하는 공간입니다.'}</p></div><button className="btn btn-primary" onClick={() => navigate('issues')}><Plus size={16}/>업무 관리</button></div>
    <div className="project-summary-strip"><span className="project-key">{project.key}</span><span>{data.users.length}명의 팀원</span><span className="summary-separator"/><span>{documents.length}개의 문서</span><div className="team-avatars">{data.users.slice(0,5).map(u => <span key={u.id} className="avatar" style={{background:u.color}} title={u.name}>{u.name.slice(0,1)}</span>)}</div></div>
    <div className="metric-grid"><Metric label="전체 업무" value={issues.length} icon={<ListTodo/>} caption={`${completed}개 완료`}/><Metric label="진행 중" value={active.length} icon={<CircleDot/>} caption="개발 · 검토 중인 업무"/><Metric label="일정 초과" value={overdue.length} icon={<SquareChartGantt/>} caption={overdue.length ? '일정을 확인해주세요' : '차근차근 진행하고 있어요'} warning={overdue.length > 0}/><Metric label="프로젝트 문서" value={documents.length} icon={<BookOpen/>} caption="팀의 지식이 쌓이고 있어요"/></div>
    <div className="overview-grid"><section className="card progress-card"><div className="card-heading"><h2>프로젝트 진행 현황</h2><button className="text-link" onClick={() => navigate('issues')}>전체 업무 <ArrowUpRight size={15}/></button></div><div className="progress-headline"><strong>{percent}<small>%</small></strong><span>{tracked.length}개 업무 중 {completed}개 완료 · 취소 제외</span></div><div className="segmented-progress">{statuses.filter(meta => meta.category !== 'cancelled').map(meta => {const count = tracked.filter(i => i.status === meta.id).length;return count ? <span key={meta.id} title={`${meta.label} ${count}개`} style={{width:`${count / tracked.length * 100}%`,background:meta.color}}/> : null;})}</div><div className="status-breakdown">{statuses.filter(meta => meta.category !== 'cancelled').map(meta => <div key={meta.id}><span className="status-dot" style={{background:meta.color}}/><span>{meta.label}</span><strong>{issues.filter(i => i.status === meta.id).length}</strong></div>)}</div></section>
      <section className="card schedule-card"><div className="card-heading"><h2>함께 보는 일정</h2><SquareChartGantt size={18}/></div><div className="schedule-illustration"><div><span>계획</span><i/><i/><i/></div><div><span>개발</span><i/><i/><i/></div><div><span>검증</span><i/><i/><i/></div></div><h3>업무를 일정에 연결해보세요</h3><p>날짜를 직접 입력하고, 업무 간 선후행 관계를 한눈에 확인하세요.</p><button className="btn btn-secondary" onClick={() => navigate('gantt')}>간트에서 일정 보기 <ArrowUpRight size={15}/></button></section>
      <section className="card overview-work"><div className="card-heading"><h2>지금 진행하는 업무 <span className="count-pill">{active.length}</span></h2><button className="text-link" onClick={() => navigate('issues')}>전체 보기 <ArrowUpRight size={15}/></button></div>{active.length ? active.slice(0,6).map(issue => <button key={issue.id} className="overview-issue" onClick={() => openIssue(issue.id)}><span className="status-ring" style={{color:statusMeta(data,issue.projectId,issue.status).color}}/><span className="issue-key">{issue.key}</span><span className="overview-issue-title">{issue.title}</span><span className="badge" style={{color:statusMeta(data,issue.projectId,issue.status).color}}>{statusMeta(data,issue.projectId,issue.status).label}</span></button>) : <div className="compact-empty">진행 중인 업무가 없습니다. 새 업무를 시작해보세요.</div>}</section>
      <section className="card overview-docs"><div className="card-heading"><h2>최근 문서</h2><button className="text-link" onClick={() => navigate('documents')}>문서 공간 <ArrowUpRight size={15}/></button></div>{[...documents].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,4).map(doc => <button key={doc.id} className="document-summary" onClick={() => openDocument(doc.id)}><span className="document-summary-icon">{doc.icon || '📄'}</span><div><strong>{doc.title || '제목 없는 문서'}</strong><span>{relativeTime(doc.updatedAt)} · v{doc.version}</span></div><ChevronRight size={15}/></button>)}{!documents.length && <div className="compact-empty">첫 번째 프로젝트 문서를 만들어보세요.</div>}</section>
      <section className="card activity-card"><div className="card-heading"><h2>팀의 최근 활동</h2><span className="muted">업무와 문서의 변경 이력</span></div>{activities.map(activity => {const user = data.users.find(u => u.id === activity.actorId); return <div className="activity-row" key={activity.id}><span className="avatar" style={{background:user?.color}}>{user?.name.slice(0,1) || '팀'}</span><div><strong>{user?.name || '팀원'}</strong> <span>{activity.detail || activity.action}</span></div><time>{relativeTime(activity.createdAt)}</time></div>;})}{!activities.length && <div className="compact-empty">새로운 활동이 여기에 표시됩니다.</div>}</section>
    </div></div>;
}

function Metric({label,value,icon,caption,warning=false}:{label:string;value:number;icon:React.ReactNode;caption:string;warning?:boolean}) {return <div className={`metric-card ${warning ? 'warning' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}<small>개</small></strong><p>{caption}</p></div>;}

function SearchDialog({ data, refresh, openIssue, openDocument, onClose, onShowAll }: Pick<FeatureProps, 'data' | 'refresh'> & {
  openIssue: (id: string, commentId?: string) => void;
  openDocument: (id: string, sectionId?: string, commentId?: string) => void;
  onClose: () => void;
  onShowAll: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const lookup = useAtlassianSearch(query, data, refresh, 150);
  const issues = searchQuickIssues(data, query, lookup.matches);
  const projectNames = new Map(data.projects.map(project => [project.id, project.name]));
  const docs = searchQuickDocuments(data, query, lookup.matches);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="search-dialog" role="dialog" aria-modal="true" aria-label="통합 검색">
      <form className="search-input-wrap" onSubmit={event => {
        event.preventDefault();
        onShowAll(normalizeWorkspaceSearchInput(query));
      }} id="workspace-quick-search">
        <Search size={21} aria-hidden="true"/>
        <input autoFocus value={query} maxLength={WORKSPACE_SEARCH_INPUT_LIMIT} onChange={event => setQuery(event.target.value)}
          aria-label="통합 검색어" placeholder="업무 번호, 제목, 본문, 원본 주소"/>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="검색 닫기"><X size={19}/></button>
      </form>
      <div className="search-results">
        {!trimmed ? <div className="search-intro"><Command size={30}/><h3>팀의 업무와 지식을 찾아보세요</h3><p>모든 프로젝트의 티켓과 문서를 검색합니다.</p></div> : <>
          {issues.length > 0 && <div className="search-label">업무</div>}
          {issues.map(({issue, matchedAliases, matchedGitlab, commentId}) => <button type="button" className="search-result search-result-issue" key={issue.id}
            aria-label={commentId ? `${issue.key} ${issue.title} 댓글 열기` : undefined} onClick={() => openIssue(issue.id, commentId)}>
            <CircleDot size={17} style={{color:statusMeta(data, issue.projectId, issue.status).color}} aria-hidden="true"/>
            <span className="search-result-issue-content">
              <span className="search-result-issue-title"><span className="workspace-search-issue-key">{issue.key}</span><span>{issue.title}</span></span>
              <span className="workspace-search-result-path">{projectNames.get(issue.projectId) ?? '프로젝트'}</span>
              {(matchedAliases || matchedGitlab || lookup.label) && <span className="workspace-search-result-labels">
                {matchedAliases?.map(alias => <span key={`${alias.source}:${alias.key}`} className="workspace-search-label">{issueSearchAliasLabel(alias)}</span>)}
                {matchedGitlab && <span className="workspace-search-label">{matchedGitlab}</span>}
                {lookup.label && <span className="workspace-search-label">{lookup.label}</span>}
              </span>}
            </span>
            <ChevronRight size={15} aria-hidden="true"/>
          </button>)}
          {docs.length > 0 && <div className="search-label">문서</div>}
          {docs.map(({ document: doc, sectionId, commentId }) => <button type="button" className="search-result" key={doc.id}
            aria-label={commentId ? `${doc.title} 댓글 열기` : undefined} onClick={() => openDocument(doc.id, sectionId, commentId)}>
            <BookOpen size={17} aria-hidden="true"/>
            <span className="search-result-issue-content">
              <span>{doc.title}</span>
              {lookup.label && <span className="workspace-search-result-labels"><span className="workspace-search-label">{lookup.label}</span></span>}
            </span>
            <ChevronRight size={15} aria-hidden="true"/>
          </button>)}
          {lookup.pending && <div className="empty-state" role="status"><p>원본 주소를 찾는 중…</p></div>}
          {lookup.failed && <div className="empty-state"><p role="alert">원본 주소를 확인하지 못했습니다.</p>
            <button className="btn" type="button" onClick={lookup.retry}>다시 검색</button></div>}
          {!lookup.pending && !lookup.failed && !issues.length && !docs.length && <div className="empty-state"><Search/><p>빠른 검색 결과가 없습니다.</p></div>}
        </>}
      </div>
      <div className="search-footer">
        <button type="submit" form="workspace-quick-search" className="btn">전체 검색 결과</button>
        <kbd>ESC 닫기</kbd>
      </div>
    </div>
  </div>;
}

function WorkspaceSettings(props:FeatureProps) {
  const [name,setName]=useState('');const [email,setEmail]=useState('');const [busy,setBusy]=useState(false);const [importData,setImportData]=useState<unknown>(null);const [importName,setImportName]=useState('');
  const [packageInventoryVersion, setPackageInventoryVersion] = useState(0);
  const prepareMigrationRef = useRef<PrepareMigration>(null);
  const packageInventoryChanged = useCallback(() => setPackageInventoryVersion(version => version + 1), []);
  const prepareMigration: PrepareMigration = packages => {
    if (prepareMigrationRef.current) return prepareMigrationRef.current(packages);
    props.notify('이관 매핑 화면을 불러온 뒤 다시 선택해 주세요.', 'error');
    return false;
  };
  async function restoreWorkspace() {
    setBusy(true);
    try {
      await post('/import', { data: importData });
      try { clearGanttDateDrafts(window.sessionStorage); } catch { /* The new restore generation also fences these drafts. */ }
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('teamspace:document-draft:') || key.startsWith('teamspace:document-comment-draft:') ||
          key.startsWith('teamspace:document-selection-comment-draft:')) localStorage.removeItem(key);
      }
      await props.refresh();
      window.dispatchEvent(new Event('teamspace:workspace-imported'));
      setImportData(null);
      props.notify('백업 데이터를 가져왔습니다. 기존 API 키는 회수되었습니다.');
    } catch (error) { props.notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  return <div className="page settings-page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>팀의 작업 공간</h1><p>간단한 팀원 관리와 데이터 이동 기능을 제공합니다.</p></div></div><section className="card settings-card"><div className="card-heading"><h2><Users size={19}/>팀원</h2><span className="badge">{props.data.users.length}명</span></div><p className="muted">상단의 작업자를 선택하면 변경 이력에 해당 팀원이 기록됩니다. 현재는 별도의 로그인 기능을 사용하지 않습니다.</p><div className="team-list">{props.data.users.map(user=><div className="team-row" key={user.id}><span className="avatar" style={{background:user.color}}>{user.name.slice(0,1)}</span><strong>{user.name}</strong><span>{user.email}</span><button className="btn btn-ghost" onClick={async()=>{const next=window.prompt('변경할 이메일 주소',user.email);if(next===null||next===user.email)return;try{await patch(`/users/${user.id}`,{email:next});await props.refresh();props.notify('이메일 주소를 변경했습니다.');}catch(e){props.notify((e as Error).message,'error');}}}>이메일 변경</button></div>)}</div><form className="invite-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await post('/users',{name,email,color:'#6785b5'});setName('');setEmail('');await props.refresh();props.notify('팀원을 추가했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}><input className="field" aria-label="새 팀원 이름" placeholder="이름" value={name} onChange={e=>setName(e.target.value)} required/><input type="email" className="field" aria-label="새 팀원 이메일" placeholder="이메일" value={email} onChange={e=>setEmail(e.target.value)} required/><button disabled={busy} className="btn btn-primary"><Plus size={16}/>팀원 추가</button></form></section>
    {props.actorId && <Suspense fallback={<div className="card settings-card"><p>마감 알림 설정을 불러오는 중입니다.</p></div>}>
      <DeadlineReminderSettings key={props.actorId} actorId={props.actorId}
        actorName={props.data.users.find(user => user.id === props.actorId)?.name ?? '현재 작업자'} notify={props.notify}/>
    </Suspense>}
    <Suspense fallback={<div className="card settings-card"><p>프로젝트 워크플로를 불러오는 중입니다.</p></div>}><WorkflowSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>담당자 배정 규칙을 불러오는 중입니다.</p></div>}><IssueAssignmentRules {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 양식을 불러오는 중입니다.</p></div>}><IssueSchemaSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 템플릿을 불러오는 중입니다.</p></div>}><IssueTemplateSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>반복 업무를 불러오는 중입니다.</p></div>}><RecurringIssueSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 달력을 불러오는 중입니다.</p></div>}><CalendarSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>API 키를 불러오는 중입니다.</p></div>}><ApiKeysSettings actorId={props.actorId} projects={props.data.projects} notify={props.notify}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>원본 이관 분석을 불러오는 중입니다.</p></div>}>
      <LegacyImportSettings {...props} onPackageInventoryChange={packageInventoryChanged} onPrepareMigration={prepareMigration}/>
    </Suspense>
    <Suspense fallback={null}>
      <MigrationApplySettings {...props} packageInventoryVersion={packageInventoryVersion} prepareMigrationRef={prepareMigrationRef}/>
    </Suspense>
    <section className="card settings-card"><div className="card-heading"><h2>데이터 내보내기 · 가져오기</h2><ArrowDownToLine size={19}/></div><p className="muted">티켓·문서·관계, 문서 검토·발행 기록, 휴지통, 개인 즐겨찾기, 팀 알림과 개인 마감 알림 설정, 작업 시간과 보고서 보관본, 변경 이력을 자체 JSON 형식으로 보관합니다. API 키, GitLab 토큰과 외부 웹훅 설정·비밀값·전송 기록은 포함되지 않습니다.</p><div className="data-actions"><button className="btn btn-secondary" onClick={async()=>{try{const payload=await api('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`teamspace-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);props.notify('데이터를 내보냈습니다.');}catch(e){props.notify((e as Error).message,'error');}}}><ArrowDownToLine size={16}/>전체 데이터 내보내기</button><label className="btn btn-ghost"><ArrowUpFromLine size={16}/>백업 가져오기<input className="sr-only" type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>64*1024*1024-1024){props.notify('가져오기 파일은 64MB 미만이어야 합니다.','error');e.target.value='';return;}try{const parsed=JSON.parse(await file.text());if(!parsed || typeof parsed!=='object' || !supportsNativeBackupVersion(parsed.schemaVersion))throw new Error(`Teamspace 내보내기 파일(schemaVersion 1~${NATIVE_BACKUP_SCHEMA_VERSION})을 선택해주세요.`);setImportData(parsed);setImportName(file.name);}catch(error){props.notify(error instanceof SyntaxError ? '올바른 JSON 파일이 아닙니다.' : (error as Error).message,'error');}e.target.value='';}}/></label></div></section>
    <section className="card settings-card"><div className="card-heading"><h2>이 개발 버전의 범위</h2><span className="badge">개발 중</span></div><p>팀원 선택은 작업자 기록을 위한 기능입니다. 프로젝트별 워크플로와 공유 보기, 문서별 공동 편집, 팀 보고서와 주간 문서를 사용할 수 있습니다.</p><p className="muted">실제 Jira·Confluence 파일 이관 리허설, 운영 GitLab 연결과 팀 사용 검증이 남아 있습니다.</p></section>
    {importData !== null && <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-label="백업 가져오기 확인"><h2>백업을 가져올까요?</h2><p><strong>{importName}</strong></p><p>현재 워크스페이스의 티켓·문서·계획·관계·첨부·작업 시간·보고서·팀 알림·개인 마감 알림 설정·개인 즐겨찾기와 휴지통 데이터를 이 백업으로 교체하고 이 브라우저의 임시 문서·댓글·간트 날짜 및 마감 알림 설정 초안도 초기화합니다. 업무 양식·업무 템플릿·티켓 필드 변경 기록·기준 계획·마일스톤·업무 달력도 교체하며 백업에 없는 항목은 초기화됩니다. GitLab 자동화 규칙은 비활성으로 복원됩니다. 반복 업무는 백업의 활성 상태·다음 실행과 최근 실행 기록을 적용합니다. 외부 웹훅 설정과 대기 전송은 초기화되고 기존 API 키는 모두 회수되며 필요한 키는 다시 발급해야 합니다. 먼저 현재 데이터를 내보내어 보관해주세요.</p><div className="modal-actions"><button className="btn" onClick={()=>setImportData(null)}>취소</button><button className="btn btn-danger" disabled={busy} onClick={restoreWorkspace}>확인하고 가져오기</button></div></div></div>}
  </div>;
}
