'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, BarChart3, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleDot, Command, FolderPlus, GitBranch, Inbox, KeyRound, LayoutDashboard, ListTodo, LoaderCircle, Plus, Search, Settings2, Sparkles, SquareChartGantt, Trash2, Users, X } from 'lucide-react';
import type { DocumentPublicationListTab, DocumentPublicationTarget, FeatureProps, TeamNotification, TeamOverviewFilters, WorkspaceSnapshot } from '../shared/types';
import { isTeamOverviewIssueMetric } from '../shared/types';
import { reservationDayRange } from '../shared/time-reservations';
import { NATIVE_BACKUP_SCHEMA_VERSION, supportsNativeBackupVersion } from '../shared/native-backup';
import { projectStatuses, statusMeta, isTerminalStatus } from '../shared/workflow-helpers';
import { issueSearchText } from '../shared/issue-schema';
import { countActiveMyWork } from '../shared/my-work';
import { isDocumentSectionId } from '../shared/document-sections';
import { countIssueDocumentReferences } from '../shared/document-references';
import type { ScheduleDependencyEndpoint } from '../shared/schedule-dependencies';
import { api, patch, post, relativeTime, setActor } from './lib/api';
import { dispatchWorkspaceNavigation } from './lib/navigation';
import { Issues } from './features/Issues';
import { Gantt } from './features/Gantt';
import { IssuePanel } from './features/IssuePanel';
import { MyWork } from './features/MyWork';
import TeamNotifications from './features/TeamNotifications';
const WorkflowSettings = lazy(() => import('./features/WorkflowSettings').then(module => ({default: module.WorkflowSettings})));
const IssueAssignmentRules = lazy(() => import('./features/IssueAssignmentRules').then(module => ({default: module.IssueAssignmentRules})));
const IssueSchemaSettings = lazy(() => import('./features/IssueSchemaSettings').then(module => ({default: module.IssueSchemaSettings})));
const CalendarSettings = lazy(() => import('./features/CalendarSettings').then(module => ({default: module.CalendarSettings})));
const MigrationApplySettings = lazy(() => import('./features/MigrationApplySettings').then(module => ({default:module.MigrationApplySettings})));
const LegacyImportSettings = lazy(() => import('./features/LegacyImportSettings').then(module => ({default:module.LegacyImportSettings})));
const ApiKeysSettings = lazy(() => import('./features/ApiKeysSettings').then(module => ({default: module.ApiKeysSettings})));
const Development = lazy(() => import('./features/Development').then(module => ({default:module.Development})));
const Planning = lazy(() => import('./features/Planning').then(module => ({default: module.Planning})));
const Reports = lazy(() => import('./features/Reports').then(module => ({default: module.Reports})));
const Documents = lazy(() => import('./features/Documents').then(module => ({default: module.Documents})));
const DocumentPublicationLibrary = lazy(() => import('./features/DocumentPublicationLibrary').then(module => ({default: module.DocumentPublicationLibrary})));
const TeamOverview = lazy(() => import('./features/TeamOverview').then(module => ({default: module.TeamOverview})));
const Trash = lazy(() => import('./features/Trash').then(module => ({default: module.Trash})));

type View = 'overview' | 'issues' | 'gantt' | 'planning' | 'reports' | 'documents' | 'publication' | 'development' | 'settings' | 'mywork' | 'trash' | 'teamoverview';
const navigation = [
  { id: 'overview', label: '프로젝트 개요', icon: LayoutDashboard },
  { id: 'issues', label: '업무', icon: ListTodo },
  { id: 'gantt', label: '간트 · 일정', icon: SquareChartGantt },
  { id: 'planning', label: '사이클 · 모듈 · 릴리스', icon: FolderPlus },
  { id: 'reports', label: '보고서', icon: BarChart3 },
  { id: 'documents', label: '문서', icon: BookOpen },
  { id: 'publication', label: '검토함 · 발행본', icon: Inbox },
  { id: 'development', label: '개발 · GitLab', icon: GitBranch },
] as const;

type WorkspaceRoute = {
  projectId: string; view: View; documentId: string | null; reportId?: string | null; planningId?: string | null; issueId: string | null;
  documentPreviewId?: string | null;
  savedViewId?: string | null; ganttFocusIssueId?: string | null; ganttFocusDate?: ScheduleDependencyEndpoint | null;
  publicationTab?: DocumentPublicationListTab; publication?: DocumentPublicationTarget | null;
  sectionId?: string | null;
  teamOverviewFilters?: TeamOverviewFilters;
};
const validViews: View[] = ['overview','issues','gantt','planning','reports','documents','publication','development','settings','mywork','trash','teamoverview'];
const emptyTeamOverviewFilters: TeamOverviewFilters = { projectId: '', memberId: '', date: '' };
function routeHash(route: WorkspaceRoute) {
  const detail = route.view === 'documents' ? route.documentId : route.view === 'publication' ? route.publicationTab ?? 'assigned' : route.view === 'reports' ? route.reportId :
    (route.view === 'gantt' || route.view === 'planning') ? route.planningId : null;
  const query = new URLSearchParams();
  if (route.issueId) query.set('issue', route.issueId);
  if ((route.view === 'issues' || route.view === 'gantt') && route.savedViewId) query.set('savedView', route.savedViewId);
  if (route.view === 'gantt' && route.ganttFocusIssueId) {
    query.set('focusIssue', route.ganttFocusIssueId);
    if (route.ganttFocusDate) query.set('focusDate', route.ganttFocusDate);
  }
  if (route.view === 'documents' && route.documentId && route.publication) {
    query.set('publication', route.publication.kind);
    query.set('revision', route.publication.revisionId);
  }
  if (route.view === 'documents' && route.documentId && route.sectionId) query.set('section', route.sectionId);
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
  if (route.issueId && route.documentPreviewId) query.set('documentPreview', route.documentPreviewId);
  return `#/${encodeURIComponent(route.projectId)}/${route.view}${detail ? '/' + encodeURIComponent(detail) : ''}${query.size ? '?' + query.toString() : ''}`;
}
function hasSameDocumentContext(previous: WorkspaceRoute, next: WorkspaceRoute): boolean {
  return previous.view === 'documents' && next.view === 'documents' && previous.documentId !== null &&
    previous.projectId === next.projectId && previous.documentId === next.documentId &&
    previous.publication?.kind === next.publication?.kind && previous.publication?.revisionId === next.publication?.revisionId;
}
function hasDocumentIssueOverlay(route: WorkspaceRoute | null): boolean {
  return Boolean(route?.view === 'documents' && route.documentId && route.issueId);
}
function canPreviewIssueDocument(snapshot: WorkspaceSnapshot, issueId: string, documentId: string): boolean {
  const document = snapshot.documents.find(value => value.id === documentId);
  return Boolean(document && (snapshot.resourceLinks.some(link => link.issueId === issueId && link.documentId === documentId) ||
    countIssueDocumentReferences(document.content, issueId) > 0));
}
function confirmRouteNavigation(previous: WorkspaceRoute | null, next: WorkspaceRoute): boolean {
  if (previous?.issueId && previous.documentPreviewId !== next.documentPreviewId &&
      routeHash({ ...previous, documentPreviewId: null }) === routeHash({ ...next, documentPreviewId: null })) return true;
  if (previous && hasSameDocumentContext(previous, next)) {
    if (previous.issueId === next.issueId && previous.sectionId !== next.sectionId &&
        previous.documentPreviewId === next.documentPreviewId) return true;
    return dispatchWorkspaceNavigation(previous.documentId);
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
  const requestedIssue = parameters.get('issue');
  const issue = snapshot.issues.find(i => i.id === requestedIssue);
  if (issue) {
    issueId = issue.id;
    if (view !== 'teamoverview' && !documentId) projectId = issue.projectId;
    if (view === 'settings' || (view === 'documents' && !documentId)) view = 'issues';
  }
  const requestedDocumentPreview = parameters.get('documentPreview');
  const documentPreviewId = issueId && requestedDocumentPreview &&
    canPreviewIssueDocument(snapshot, issueId, requestedDocumentPreview) ? requestedDocumentPreview : null;
  const reportId = view === 'reports' && projectId === parts[0] && /^[0-9a-f-]{36}$/i.test(parts[2] || '') ? parts[2] : null;
  const requestedFocusIssue = parameters.get('focusIssue');
  const ganttFocusIssueId = view === 'gantt' && requestedFocusIssue && requestedFocusIssue.length <= 200 &&
    requestedFocusIssue.trim() && !/[\u0000-\u001f\u007f]/.test(requestedFocusIssue) ? requestedFocusIssue : null;
  const requestedFocusDate = parameters.get('focusDate');
  const ganttFocusDate = ganttFocusIssueId && (requestedFocusDate === 'startDate' || requestedFocusDate === 'endDate') ? requestedFocusDate : null;
  const planningId = (view === 'planning' || view === 'gantt' && !ganttFocusIssueId) && projectId === parts[0] &&
    snapshot.planningItems?.some(item => item.id === parts[2] && item.projectId === projectId) ? parts[2] : null;
  const savedViewId = view === 'issues' || (view === 'gantt' && !ganttFocusIssueId) ? parameters.get('savedView') || null : null;
  const publicationTab = view === 'publication' && (parts[2] === 'requested' || parts[2] === 'published') ? parts[2] : 'assigned';
  const kind = parameters.get('publication'), revisionId = parameters.get('revision');
  const publication: DocumentPublicationTarget | null = view === 'documents' && documentId && (kind === 'review' || kind === 'published') &&
    revisionId && revisionId.length <= 200 && revisionId.trim() && !/[\u0000-\u001f\u007f]/.test(revisionId) ? {kind,revisionId} : null;
  const section = parameters.get('section');
  const sectionId = view === 'documents' && documentId && isDocumentSectionId(section) ? section : null;
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
  return { projectId, view, documentId, issueId, documentPreviewId, reportId, planningId, savedViewId, ganttFocusIssueId, ganttFocusDate, publicationTab, publication, sectionId, teamOverviewFilters };
}

export default function Workspace({environmentLabel = '로컬 개발 환경', pilotAccess = false}: { environmentLabel?: string; pilotAccess?: boolean } = {}) {
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const dataRef = useRef<WorkspaceSnapshot | null>(null);
  const [failure, setFailure] = useState('');
  const [projectId, setProjectId] = useState('');
  const [actorId, setActorId] = useState('');
  const [view, setView] = useState<View>('overview');
  const [issueId, setIssueId] = useState<string | null>(null);
  const [documentPreviewId, setDocumentPreviewId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [savedViewId, setSavedViewId] = useState<string | null>(null);
  const [ganttFocusIssueId, setGanttFocusIssueId] = useState<string | null>(null);
  const [ganttFocusDate, setGanttFocusDate] = useState<ScheduleDependencyEndpoint | null>(null);
  const [issueFocusActivation, setIssueFocusActivation] = useState(0);
  const [publicationTab, setPublicationTab] = useState<DocumentPublicationListTab>('assigned');
  const [publication, setPublication] = useState<DocumentPublicationTarget | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [teamOverviewFilters, setTeamOverviewFilters] = useState(emptyTeamOverviewFilters);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [toast, setToast] = useState<{message: string; kind: string} | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const acceptedRouteRef = useRef<WorkspaceRoute | null>(null);
  const publicationOpenRequest = useRef(0);
  const notificationOpenRequest = useRef(0);
  const routeIndexRef = useRef(0);
  const rollbackHashRef = useRef<string | null>(null);
  const documentIssueOpener = useRef<HTMLElement | null>(null);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => setToast({ message, kind }), []);
  const refresh = useCallback(async () => {
    const snapshot = await api<WorkspaceSnapshot>('/workspace');
    dataRef.current = snapshot;
    setData(snapshot);
    setFailure('');
    setProjectId(id => snapshot.projects.some(p => p.id === id) ? id : snapshot.projects[0]?.id || '');
    setActorId(id => {
      const stored = id || localStorage.getItem('teamspace.actor') || '';
      const selected = snapshot.users.some(u => u.id === stored) ? stored : snapshot.users[0]?.id || '';
      setActor(selected);
      return selected;
    });
  }, []);
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
        if (!hasDocumentIssueOverlay(acceptedRouteRef.current) && !acceptedRouteRef.current?.documentPreviewId) {
          setSearchOpen(value => !value);
        }
      }
      if (event.key === 'Escape') { setSearchOpen(false); setProjectModal(false); setSidebarOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const writeRoute = useCallback((route: WorkspaceRoute, index: number, mode: 'push' | 'replace') => {
    const previous = acceptedRouteRef.current;
    if (!previous || !hasSameDocumentContext(previous, route)) documentIssueOpener.current = null;
    else if (!previous.issueId && route.issueId) {
      const active = document.activeElement;
      documentIssueOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    } else if (previous.issueId && !route.issueId) {
      const opener = documentIssueOpener.current;
      documentIssueOpener.current = null;
      if (opener) requestAnimationFrame(() => {
        const current = acceptedRouteRef.current;
        if (current && !current.issueId && hasSameDocumentContext(route, current) && opener.isConnected && !opener.closest('[inert]')) {
          opener.focus({ preventScroll: true });
        }
      });
    }
    if (hasDocumentIssueOverlay(route) || route.documentPreviewId) setSearchOpen(false);
    const hash = routeHash(route);
    const state = { ...(history.state && typeof history.state === 'object' ? history.state : {}), teamspaceRouteIndex: index };
    if (mode === 'push') history.pushState(state, '', hash);
    else history.replaceState(state, '', hash);
    acceptedRouteRef.current = route;
    routeIndexRef.current = index;
    setProjectId(route.projectId); setView(route.view);
    setDocumentId(route.documentId); setIssueId(route.issueId); setReportId(route.reportId || null); setPlanningId(route.planningId || null);
    setDocumentPreviewId(route.documentPreviewId ?? null);
    setSavedViewId(route.savedViewId ?? null);
    setGanttFocusIssueId(route.ganttFocusIssueId ?? null);
    setGanttFocusDate(route.ganttFocusDate ?? null);
    setPublicationTab(route.publicationTab ?? 'assigned');
    setPublication(previous => previous?.kind === route.publication?.kind && previous?.revisionId === route.publication?.revisionId ? previous : route.publication ?? null);
    setSectionId(route.sectionId ?? null);
    const filters = route.teamOverviewFilters ?? emptyTeamOverviewFilters;
    setTeamOverviewFilters(previous => previous.projectId === filters.projectId && previous.memberId === filters.memberId &&
      previous.date === filters.date && previous.issueMetric === filters.issueMetric && previous.issueOffset === filters.issueOffset ? previous : filters);
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
    if (previous && previousHash && routeHash(incoming) !== previousHash && !confirmRouteNavigation(previous, incoming)) {
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

  const requestRoute = (route: WorkspaceRoute) => {
    if (!dataRef.current) return false;
    const next = normalizeRoute(dataRef.current, routeHash(route));
    const previous = acceptedRouteRef.current;
    if (previous && routeHash(next) === routeHash(previous)) { setSidebarOpen(false); return true; }
    if (!confirmRouteNavigation(previous, next)) return false;
    writeRoute(next, routeIndexRef.current + 1, 'push'); setSidebarOpen(false);
    return true;
  };
  const navigate = (nextView: View, nextProject = projectId, nextDoc?: string) => {
    const sameView = nextView === view && nextProject === projectId;
    requestRoute({projectId:nextProject, view:nextView, documentId:nextDoc || null, issueId:null,
      savedViewId: sameView ? savedViewId : null, ganttFocusIssueId: sameView ? ganttFocusIssueId : null,
      ganttFocusDate: sameView ? ganttFocusDate : null,
      teamOverviewFilters: nextView === 'teamoverview' && view === 'teamoverview' ? teamOverviewFilters : undefined});
  };
  const openIssue = (id: string) => {
    const issue = dataRef.current?.issues.find(i => i.id === id);
    if (!issue) return;
    const current = acceptedRouteRef.current;
    const retainedPreview = current?.issueId === id ? current.documentPreviewId : null;
    if (current?.view === 'documents' && current.documentId) {
      requestRoute({ ...current, issueId: id, documentPreviewId: retainedPreview });
      return;
    }
    const sameProject = issue.projectId === projectId;
    if (requestRoute({
      projectId:view === 'teamoverview' ? projectId : issue.projectId,
      view:view === 'documents' || view === 'settings' ? 'issues' : view, documentId:null,
      reportId:sameProject ? reportId : null, planningId:sameProject ? planningId : null, savedViewId:sameProject ? savedViewId : null,
      ganttFocusIssueId:sameProject ? ganttFocusIssueId : null,
      ganttFocusDate:sameProject ? ganttFocusDate : null,
      publicationTab, issueId:id, documentPreviewId:retainedPreview, teamOverviewFilters,
    })) setSearchOpen(false);
  };
  const closeIssuePanel = (id: string) => {
    const current = acceptedRouteRef.current;
    if (current?.issueId === id) requestRoute({ ...current, issueId: null, documentPreviewId: null });
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
    const target: WorkspaceRoute = {
      projectId:issue.projectId, view:'gantt', documentId:null, issueId:null, ganttFocusIssueId:id, ganttFocusDate:endpoint,
    };
    const current = acceptedRouteRef.current;
    if (endpoint && current && routeHash(current) === routeHash(target) && !confirmRouteNavigation(current, target)) return false;
    if (!requestRoute(target)) return false;
    setIssueFocusActivation(value => value + 1);
    return true;
  };
  const openPlanIn = (nextView: 'planning' | 'gantt', id: string) =>
    requestRoute({projectId, view:nextView, documentId:null, planningId:id, issueId:null});
  const openDocument = (id: string) => {
    const document = dataRef.current?.documents.find(d => d.id === id);
    if (!document) return;
    const current = acceptedRouteRef.current;
    if (current?.view === 'documents' && current.documentId === id && current.issueId) {
      closeIssuePanel(current.issueId);
      return;
    }
    if (requestRoute({projectId:document.projectId || projectId, view:'documents',documentId:id,issueId:null})) setSearchOpen(false);
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
    if (notification.kind.startsWith('issue-')) {
      const issue = snapshot?.issues.find(value => value.id === notification.targetId);
      if (issue) return requestRoute({ projectId:issue.projectId, view:'issues', documentId:null, issueId:issue.id,
        savedViewId:view === 'issues' && projectId === issue.projectId ? savedViewId : null });
    } else {
      const doc = snapshot?.documents.find(value => value.id === notification.targetId);
      if (doc) return requestRoute({ projectId:doc.projectId || projectId, view:'documents', documentId:doc.id, issueId:null });
    }
    notify('알림의 대상이 삭제되었거나 현재 워크스페이스에 없습니다.', 'error');
    return false;
  };
  const openPublication = async (id: string, kind: DocumentPublicationTarget['kind'], revisionId: string) => {
    const request = ++publicationOpenRequest.current;
    const from = location.hash;
    let document = dataRef.current?.documents.find(value => value.id === id);
    if (!document) {
      try { await refresh(); }
      catch (cause) {
        if (request === publicationOpenRequest.current && from === location.hash) notify((cause as Error).message,'error');
        return;
      }
      if (request !== publicationOpenRequest.current || from !== location.hash) return;
      document = dataRef.current?.documents.find(value => value.id === id);
    }
    if (!document) {
      notify('문서가 변경되었거나 삭제되었습니다. 목록을 새로 불러와 주세요.', 'error');
      return;
    }
    requestRoute({projectId:document.projectId || projectId,view:'documents',documentId:id,publication:{kind,revisionId},issueId:null});
  };
  const closePublicationLink = useCallback((id: string, target: DocumentPublicationTarget) => {
    const current = acceptedRouteRef.current;
    if (current?.view === 'documents' && current.documentId === id && current.publication?.kind === target.kind &&
      current.publication.revisionId === target.revisionId) {
      writeRoute({...current, publication:null, sectionId:null},routeIndexRef.current,'replace');
    }
  }, [writeRoute]);
  // The document tree already confirms/cache-preserves its local draft before invoking this callback.
  const selectDocument = (id: string) => {
    if (!dataRef.current) return;
    const route = normalizeRoute(dataRef.current, routeHash({projectId,view:'documents',documentId:id,issueId:null}));
    const previous = acceptedRouteRef.current;
    if (previous && routeHash(previous) === routeHash(route)) return;
    const automaticSelection = previous?.view === 'documents' && !previous.documentId;
    writeRoute(route, routeIndexRef.current + (automaticSelection ? 0 : 1), automaticSelection ? 'replace' : 'push');
  };

  if (!data) return <div className="loading-screen"><div className="brand-mark"><Command size={26}/></div><h1>Teamspace</h1>{failure ? <><p className="error-text">{failure}</p><button className="btn btn-primary" onClick={() => refresh().catch(e => setFailure(e.message))}>다시 연결</button><p className="muted">API 서버가 실행 중인지 확인해주세요.</p></> : <><LoaderCircle className="spin"/><p className="muted">팀의 업무 공간을 불러오는 중입니다</p></>}</div>;
  const project = data.projects.find(p => p.id === projectId) || data.projects[0];
  const actor = data.users.find(u => u.id === actorId);
  const props: FeatureProps = { data, projectId, actorId, refresh, notify, openIssue, openDocument };
  const projectIssues = data.issues.filter(i => i.projectId === projectId);
  const openedIssue = data.issues.find(issue => issue.id === issueId);
  const documentIssueOpen = view === 'documents' && Boolean(documentId && openedIssue);
  const activeDocumentPreviewId = openedIssue && documentPreviewId && canPreviewIssueDocument(data, openedIssue.id, documentPreviewId)
    ? documentPreviewId : null;
  const workspaceObscured = documentIssueOpen || Boolean(activeDocumentPreviewId);

  return <div className="workspace">
    {sidebarOpen && !workspaceObscured && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)}/>}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} inert={workspaceObscured}>
      <div className="workspace-brand"><div className="brand-mark"><Command size={22}/></div><div><strong>Teamspace</strong><span>함께 만드는 팀의 작업 공간</span></div><button className="icon-btn mobile-only" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기"><X size={18}/></button></div>
      <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16}/><span>업무와 문서 검색</span><kbd>⌘ K</kbd></button>
      <nav className="sidebar-section">
        <button className={`nav-item ${view === 'teamoverview' ? 'active' : ''}`} aria-current={view === 'teamoverview' ? 'page' : undefined} onClick={() => navigate('teamoverview')}><LayoutDashboard size={18}/><span>팀 개요</span></button>
        <button className={`nav-item ${view === 'mywork' ? 'active' : ''}`} aria-current={view === 'mywork' ? 'page' : undefined} onClick={() => navigate('mywork')}><CircleDot size={18}/><span>내 업무</span><span className="nav-count">{countActiveMyWork(data, actorId)}</span></button>
        <button className={`nav-item ${view === 'trash' ? 'active' : ''}`} onClick={() => navigate('trash')}><Trash2 size={17}/><span>휴지통</span></button>
      </nav>
      <div className="sidebar-section-title"><span>프로젝트</span><button className="icon-btn" title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={() => setProjectModal(true)}><Plus size={15}/></button></div>
      <div className="project-list">{data.projects.map(p => <button key={p.id} className={`project-item ${p.id === projectId ? 'selected' : ''}`} onClick={() => navigate('overview', p.id)}><span className="project-symbol" style={{background: p.color + '17', color: p.color}}>{p.key.slice(0,1)}</span><span>{p.name}</span>{p.id === projectId && <ChevronDown size={14}/>}</button>)}</div>
      {project && <nav className="project-navigation">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={17}/><span>{item.label}</span>{item.id === 'issues' && <span className="nav-count">{projectIssues.length}</span>}</button>)}</nav>}
      <div className="sidebar-note"><Sparkles size={17}/><strong>업무와 지식을 한곳에</strong><p>계획에서 구현, 그리고 문서까지.<br/>우리 팀의 흐름을 연결하세요.</p></div>
      <div className="sidebar-footer">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={17}/><span>워크스페이스 설정</span></button>
        {pilotAccess && <a className="nav-item" href="/pilot-access" target="_blank" rel="noopener noreferrer"><KeyRound size={17}/><span>팀 접속</span></a>}
        <div className="local-status"><span/>{environmentLabel} <span className="version-label">v0.1</span></div>
      </div>
    </aside>
    <div className="workspace-content" inert={workspaceObscured}>
      <header className="topbar"><button className="icon-btn mobile-only" aria-label="메뉴 열기" onClick={() => setSidebarOpen(true)}><ListTodo size={20}/></button><div className="breadcrumbs"><span className="breadcrumb-workspace">워크스페이스</span><ChevronRight size={14}/>{view === 'teamoverview' ? <strong>팀 개요</strong> : <><span>{project?.name || '새 프로젝트'}</span><ChevronRight size={14}/><strong>{view === 'settings' ? '설정' : view === 'mywork' ? '내 업무' : view === 'trash' ? '휴지통' : navigation.find(n => n.id === view)?.label}</strong></>}</div><div className="topbar-actions">
        <PublicationInboxButton actorId={actorId} onClick={() => navigate('publication')}/>
        {actorId && <TeamNotifications actorId={actorId} users={data.users} onOpen={openNotification}/>}
        <button className="icon-btn" aria-label="통합 검색" title="통합 검색" onClick={() => setSearchOpen(true)}><Search size={18}/></button>
        <div className="actor-picker"><span className="avatar" style={{background: actor?.color}}>{actor?.name.slice(0,1)}</span><label className="sr-only" htmlFor="actor-select">작업자 선택</label><select id="actor-select" value={actorId} onChange={e => {
          if(!dispatchWorkspaceNavigation())return;
          publicationOpenRequest.current++;notificationOpenRequest.current++;
          setActorId(e.target.value);setActor(e.target.value);localStorage.setItem('teamspace.actor',e.target.value);
        }}>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      </div></header>
      <main className={`main-content view-${view}`}>
        {view === 'overview' && <Overview {...props} navigate={navigate}/>}
        {view === 'teamoverview' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>팀 개요를 불러오는 중입니다.</p></div>}>
          <TeamOverview {...props} filters={teamOverviewFilters} openPublication={openPublication}
            onFiltersChange={filters => requestRoute({projectId,view,documentId:null,issueId,teamOverviewFilters:filters})}
            openProject={(id, destination) => navigate(destination,id)} onOpenIssueSchedule={openIssueSchedule}/>
        </Suspense>}
        {view === 'mywork' && <MyWork key={actorId} data={data} actorId={actorId} openIssue={openIssue}/>}
        {view === 'issues' && <Issues {...props} savedViewId={savedViewId}
          onChangeSavedView={id => requestRoute({projectId,view:'issues',documentId:null,issueId,savedViewId:id})}
          onOpenGantt={id => requestRoute({projectId,view:'gantt',documentId:null,issueId:null,savedViewId:id})}/>}
        {view === 'gantt' && <Gantt {...props} initialPlanningId={planningId} ganttViewId={savedViewId} onOpenPlanning={id => openPlanIn('planning',id)}
          focusIssueId={ganttFocusIssueId} focusDateEndpoint={ganttFocusDate} issueOverlayOpen={Boolean(openedIssue)} issueFocusActivation={issueFocusActivation}
          onLocateIssueDate={openIssueSchedule}
          onClearIssueFocus={() => requestRoute({projectId,view:'gantt',documentId:null,issueId})}
          onChangeGanttView={id => requestRoute({projectId,view:'gantt',documentId:null,issueId,planningId,savedViewId:id})}
          onOpenSavedIssueView={id => requestRoute({projectId,view:'issues',documentId:null,issueId:null,savedViewId:id})}/>}
        {view === 'planning' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>프로젝트 계획을 불러오는 중입니다.</p></div>}><Planning {...props} initialPlanningId={planningId} onOpenGantt={id => openPlanIn('gantt',id)}/></Suspense>}
        {view === 'reports' && project && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>보고서를 불러오는 중입니다.</p></div>}><Reports {...props} snapshotId={reportId}/></Suspense>}
        {view === 'documents' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>문서를 불러오는 중입니다.</p></div>}><Documents {...props} selectedDocumentId={documentId} sectionId={sectionId} onSelectDocument={selectDocument} publicationLink={publication} onClosePublicationLink={closePublicationLink} issueDrawerOpen={documentIssueOpen}/></Suspense>}
        {view === 'publication' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>검토함을 불러오는 중입니다.</p></div>}><DocumentPublicationLibrary {...props} initialTab={publicationTab} onOpenPublication={openPublication}
          onTabChange={tab => requestRoute({projectId,view:'publication',documentId:null,issueId:null,publicationTab:tab})}/></Suspense>}
        {view === 'development' && <Development {...props}/>}
        {view === 'settings' && <WorkspaceSettings key={actorId} {...props}/>}
        {view === 'trash' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>휴지통을 불러오는 중입니다.</p></div>}><Trash key={actorId} {...props}/></Suspense>}
        {!project && view !== 'trash' && view !== 'teamoverview' && <div className="empty-state"><FolderPlus/><h2>첫 프로젝트를 만들어보세요</h2><button className="btn btn-primary" onClick={() => setProjectModal(true)}>프로젝트 만들기</button></div>}
      </main>
    </div>
    {openedIssue && <IssuePanel key={`${openedIssue.id}:${actorId}`} {...props} projectId={openedIssue.projectId} documentOverlay={documentIssueOpen}
      issueId={openedIssue.id} onOpenIssueSchedule={openIssueSchedule} onClose={() => closeIssuePanel(openedIssue.id)}
      previewDocumentId={activeDocumentPreviewId} onPreviewDocument={previewIssueDocument} onCloseDocumentPreview={closeIssueDocumentPreview}/>}
    {searchOpen && <SearchDialog {...props} onClose={() => setSearchOpen(false)}/>}
    {projectModal && <ProjectDialog refresh={refresh} notify={notify} onClose={() => setProjectModal(false)} onCreated={id => navigate('overview', id)}/>}
    {toast && <div role="status" className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={18}/> : <Bell size={18}/>}<span>{toast.message}</span><button onClick={() => setToast(null)} className="icon-btn" aria-label="알림 닫기"><X size={15}/></button></div>}
  </div>;
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
  return <div className="page overview-page"><div className="page-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1>{project.name}</h1><p>{project.description || '팀의 목표를 업무와 문서로 연결하는 공간입니다.'}</p></div><button className="btn btn-primary" onClick={() => navigate('issues')}><Plus size={16}/>업무 관리</button></div>
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

function SearchDialog(props: FeatureProps & {onClose:()=>void}) {
  const [query,setQuery] = useState('');
  const q = query.toLocaleLowerCase().trim();
  const issues = q ? props.data.issues.filter(i => issueSearchText(props.data,i).toLocaleLowerCase().includes(q)).slice(0,12) : [];
  const docs = q ? props.data.documents.filter(d => `${d.title} ${d.plainText}`.toLocaleLowerCase().includes(q)).slice(0,8) : [];
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="통합 검색"><div className="search-input-wrap"><Search size={21}/><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="티켓 번호, 업무 제목, 문서 내용 검색…"/><button className="icon-btn" onClick={props.onClose} aria-label="검색 닫기"><X size={19}/></button></div><div className="search-results">{!q ? <div className="search-intro"><Command size={30}/><h3>팀의 업무와 지식을 찾아보세요</h3><p>모든 프로젝트의 티켓과 문서를 검색합니다.</p></div> : <>{issues.length > 0 && <div className="search-label">업무</div>}{issues.map(i => <button className="search-result" key={i.id} onClick={() => props.openIssue(i.id)}><CircleDot size={17} style={{color:statusMeta(props.data,i.projectId,i.status).color}}/><span className="issue-key">{i.key}</span><span>{i.title}</span><ChevronRight size={15}/></button>)}{docs.length > 0 && <div className="search-label">문서</div>}{docs.map(d => <button className="search-result" key={d.id} onClick={() => props.openDocument(d.id)}><BookOpen size={17}/><span>{d.title}</span><ChevronRight size={15}/></button>)}{!issues.length && !docs.length && <div className="empty-state"><Search/><p>검색 결과가 없습니다.</p></div>}</>}</div><div className="search-footer"><span>업무 · 문서 · 프로젝트</span><kbd>ESC 닫기</kbd></div></div></div>;
}

function ProjectDialog({refresh,notify,onClose,onCreated}:{refresh:()=>Promise<void>;notify:FeatureProps['notify'];onClose:()=>void;onCreated:(id:string)=>void}) {
  const [name,setName]=useState('');const [key,setKey]=useState('');const [description,setDescription]=useState('');const [busy,setBusy]=useState(false);
  return <div className="modal-backdrop"><form className="modal-card" onSubmit={async e=>{e.preventDefault();setBusy(true);try{const p=await post<{id:string}>('/projects',{name,key,description,color:'#177c72'});await refresh();notify('프로젝트를 만들었습니다.');onClose();onCreated(p.id);}catch(error){notify((error as Error).message,'error');}finally{setBusy(false);}}}><div className="card-heading"><h2>새 프로젝트</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="닫기"><X size={19}/></button></div><p className="muted">새로운 목표를 팀의 업무와 문서로 연결하세요.</p><label className="form-label">프로젝트 이름<input className="field" required value={name} onChange={e=>setName(e.target.value)} placeholder="예: 제품 개발"/></label><label className="form-label">티켓 접두어<input className="field" required value={key} onChange={e=>setKey(e.target.value.toUpperCase())} placeholder="예: DEV" pattern="[A-Z][A-Z0-9]{1,9}" minLength={2} maxLength={10}/><span className="help-text">영문 대문자와 숫자 2~10자 · DEV-1처럼 사용합니다.</span></label><label className="form-label">프로젝트 소개<textarea className="field" value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label><div className="modal-actions"><button type="button" className="btn" onClick={onClose}>취소</button><button disabled={busy} className="btn btn-primary">{busy ? '생성 중…' : '프로젝트 만들기'}</button></div></form></div>;
}

function WorkspaceSettings(props:FeatureProps) {
  const [name,setName]=useState('');const [email,setEmail]=useState('');const [busy,setBusy]=useState(false);const [importData,setImportData]=useState<unknown>(null);const [importName,setImportName]=useState('');
  return <div className="page settings-page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>팀의 작업 공간</h1><p>간단한 팀원 관리와 데이터 이동 기능을 제공합니다.</p></div></div><section className="card settings-card"><div className="card-heading"><h2><Users size={19}/>팀원</h2><span className="badge">{props.data.users.length}명</span></div><p className="muted">상단의 작업자를 선택하면 변경 이력에 해당 팀원이 기록됩니다. 현재는 별도의 로그인 기능을 사용하지 않습니다.</p><div className="team-list">{props.data.users.map(user=><div className="team-row" key={user.id}><span className="avatar" style={{background:user.color}}>{user.name.slice(0,1)}</span><strong>{user.name}</strong><span>{user.email}</span><button className="btn btn-ghost" onClick={async()=>{const next=window.prompt('변경할 이메일 주소',user.email);if(next===null||next===user.email)return;try{await patch(`/users/${user.id}`,{email:next});await props.refresh();props.notify('이메일 주소를 변경했습니다.');}catch(e){props.notify((e as Error).message,'error');}}}>이메일 변경</button></div>)}</div><form className="invite-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await post('/users',{name,email,color:'#6785b5'});setName('');setEmail('');await props.refresh();props.notify('팀원을 추가했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}><input className="field" aria-label="새 팀원 이름" placeholder="이름" value={name} onChange={e=>setName(e.target.value)} required/><input type="email" className="field" aria-label="새 팀원 이메일" placeholder="이메일" value={email} onChange={e=>setEmail(e.target.value)} required/><button disabled={busy} className="btn btn-primary"><Plus size={16}/>팀원 추가</button></form></section>
    <Suspense fallback={<div className="card settings-card"><p>프로젝트 워크플로를 불러오는 중입니다.</p></div>}><WorkflowSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>담당자 배정 규칙을 불러오는 중입니다.</p></div>}><IssueAssignmentRules {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 양식을 불러오는 중입니다.</p></div>}><IssueSchemaSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>업무 달력을 불러오는 중입니다.</p></div>}><CalendarSettings {...props}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>API 키를 불러오는 중입니다.</p></div>}><ApiKeysSettings actorId={props.actorId} projects={props.data.projects} notify={props.notify}/></Suspense>
    <Suspense fallback={<div className="card settings-card"><p>원본 이관 분석을 불러오는 중입니다.</p></div>}><LegacyImportSettings {...props}/></Suspense>
    <Suspense fallback={null}><MigrationApplySettings {...props}/></Suspense>
    <section className="card settings-card"><div className="card-heading"><h2>데이터 내보내기 · 가져오기</h2><ArrowDownToLine size={19}/></div><p className="muted">티켓·문서·관계, 문서 검토·발행 기록, 휴지통, 팀 알림, 작업 시간과 보고서 보관본, 변경 이력을 자체 JSON 형식으로 보관합니다. API 키, GitLab 토큰과 외부 웹훅 설정·비밀값·전송 기록은 포함되지 않습니다.</p><div className="data-actions"><button className="btn btn-secondary" onClick={async()=>{try{const payload=await api('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`teamspace-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);props.notify('데이터를 내보냈습니다.');}catch(e){props.notify((e as Error).message,'error');}}}><ArrowDownToLine size={16}/>전체 데이터 내보내기</button><label className="btn btn-ghost"><ArrowUpFromLine size={16}/>백업 가져오기<input className="sr-only" type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>64*1024*1024-1024){props.notify('가져오기 파일은 64MB 미만이어야 합니다.','error');e.target.value='';return;}try{const parsed=JSON.parse(await file.text());if(!parsed || typeof parsed!=='object' || !supportsNativeBackupVersion(parsed.schemaVersion))throw new Error(`Teamspace 내보내기 파일(schemaVersion 1~${NATIVE_BACKUP_SCHEMA_VERSION})을 선택해주세요.`);setImportData(parsed);setImportName(file.name);}catch(error){props.notify(error instanceof SyntaxError ? '올바른 JSON 파일이 아닙니다.' : (error as Error).message,'error');}e.target.value='';}}/></label></div></section>
    <section className="card settings-card"><div className="card-heading"><h2>이 개발 버전의 범위</h2><span className="badge">개발 중</span></div><p>팀원 선택은 작업자 기록을 위한 기능입니다. 프로젝트별 워크플로와 공유 보기, 문서별 공동 편집, 팀 보고서와 주간 문서를 사용할 수 있습니다.</p><p className="muted">실제 Jira·Confluence 파일 이관 리허설, 운영 GitLab 연결과 팀 사용 검증이 남아 있습니다.</p></section>
    {importData !== null && <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-label="백업 가져오기 확인"><h2>백업을 가져올까요?</h2><p><strong>{importName}</strong></p><p>현재 워크스페이스의 티켓·문서·계획·관계·첨부·작업 시간·보고서·팀 알림과 휴지통 데이터를 이 백업으로 교체하고 이 브라우저의 임시 문서·댓글 초안도 초기화합니다. 업무 유형·사용자 정의 필드·기준 계획·마일스톤·업무 달력도 교체하며 백업에 없는 항목은 초기화됩니다. 자동화 규칙은 비활성으로 복원됩니다. 외부 웹훅 설정과 대기 전송은 초기화되고 기존 API 키는 모두 회수되며 필요한 키는 다시 발급해야 합니다. 먼저 현재 데이터를 내보내어 보관해주세요.</p><div className="modal-actions"><button className="btn" onClick={()=>setImportData(null)}>취소</button><button className="btn btn-danger" disabled={busy} onClick={async()=>{setBusy(true);try{await post('/import',{data:importData});for(const key of Object.keys(localStorage)){if(key.startsWith('teamspace:document-draft:') || key.startsWith('teamspace:document-comment-draft:'))localStorage.removeItem(key);}await props.refresh();window.dispatchEvent(new Event('teamspace:workspace-imported'));setImportData(null);props.notify('백업 데이터를 가져왔습니다. 기존 API 키는 회수되었습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}>확인하고 가져오기</button></div></div></div>}
  </div>;
}
