'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleDot, Command, FolderPlus, GitBranch, LayoutDashboard, ListTodo, LoaderCircle, Plus, Search, Settings2, Sparkles, SquareChartGantt, Users, X } from 'lucide-react';
import type { FeatureProps, GitlabSettings, WorkspaceSnapshot } from '../shared/types';
import { STATUS } from '../shared/types';
import { api, patch, post, relativeTime, setActor } from './lib/api';
import { Issues } from './features/Issues';
import { Gantt } from './features/Gantt';
import { IssuePanel } from './features/IssuePanel';
const Documents = lazy(() => import('./features/Documents').then(module => ({default: module.Documents})));

type View = 'overview' | 'issues' | 'gantt' | 'documents' | 'development' | 'settings' | 'mywork';
const navigation = [
  { id: 'overview', label: '프로젝트 개요', icon: LayoutDashboard },
  { id: 'issues', label: '업무', icon: ListTodo },
  { id: 'gantt', label: '간트 · 일정', icon: SquareChartGantt },
  { id: 'documents', label: '문서', icon: BookOpen },
  { id: 'development', label: '개발 · GitLab', icon: GitBranch },
] as const;

type WorkspaceRoute = { projectId: string; view: View; documentId: string | null; issueId: string | null };
const validViews: View[] = ['overview','issues','gantt','documents','development','settings','mywork'];
function routeHash(route: WorkspaceRoute) {
  return `#/${encodeURIComponent(route.projectId)}/${route.view}${route.view === 'documents' && route.documentId ? '/' + encodeURIComponent(route.documentId) : ''}${route.issueId ? '?issue=' + encodeURIComponent(route.issueId) : ''}`;
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
  const requestedIssue = new URLSearchParams(query).get('issue');
  const issue = snapshot.issues.find(i => i.id === requestedIssue);
  if (issue) { issueId = issue.id; projectId = issue.projectId; if (view === 'documents') { view = 'issues'; documentId = null; } }
  return { projectId, view, documentId, issueId };
}

export default function Workspace() {
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const dataRef = useRef<WorkspaceSnapshot | null>(null);
  const [failure, setFailure] = useState('');
  const [projectId, setProjectId] = useState('');
  const [actorId, setActorId] = useState('');
  const [view, setView] = useState<View>('overview');
  const [issueId, setIssueId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [toast, setToast] = useState<{message: string; kind: string} | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const acceptedRouteRef = useRef<WorkspaceRoute | null>(null);
  const routeIndexRef = useRef(0);
  const rollbackHashRef = useRef<string | null>(null);

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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
      if (event.key === 'Escape') { setSearchOpen(false); setProjectModal(false); setSidebarOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const writeRoute = useCallback((route: WorkspaceRoute, index: number, mode: 'push' | 'replace') => {
    const hash = routeHash(route);
    const state = { ...(history.state && typeof history.state === 'object' ? history.state : {}), teamspaceRouteIndex: index };
    if (mode === 'push') history.pushState(state, '', hash);
    else history.replaceState(state, '', hash);
    acceptedRouteRef.current = route;
    routeIndexRef.current = index;
    setProjectId(route.projectId); setView(route.view);
    setDocumentId(route.documentId); setIssueId(route.issueId);
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
    if (previousHash && routeHash(incoming) !== previousHash && !window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) {
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
    if (acceptedRouteRef.current && routeHash(next) === routeHash(acceptedRouteRef.current)) { setSidebarOpen(false); return true; }
    if (!window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) return false;
    writeRoute(next, routeIndexRef.current + 1, 'push'); setSidebarOpen(false);
    return true;
  };
  const navigate = (nextView: View, nextProject = projectId, nextDoc?: string) => {
    requestRoute({projectId:nextProject, view:nextView, documentId:nextDoc || null, issueId:null});
  };
  const openIssue = (id: string) => {
    const issue = dataRef.current?.issues.find(i => i.id === id);
    if (!issue) return;
    if (requestRoute({projectId:issue.projectId, view:view === 'documents' ? 'issues' : view, documentId:null, issueId:id})) setSearchOpen(false);
  };
  const openDocument = (id: string) => {
    const document = dataRef.current?.documents.find(d => d.id === id);
    if (!document) return;
    if (requestRoute({projectId:document.projectId || projectId, view:'documents',documentId:id,issueId:null})) setSearchOpen(false);
  };
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

  return <div className="workspace">
    {sidebarOpen && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)}/>}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="workspace-brand"><div className="brand-mark"><Command size={22}/></div><div><strong>Teamspace</strong><span>함께 만드는 팀의 작업 공간</span></div><button className="icon-btn mobile-only" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기"><X size={18}/></button></div>
      <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16}/><span>업무와 문서 검색</span><kbd>⌘ K</kbd></button>
      <nav className="sidebar-section"><button className={`nav-item ${view === 'mywork' ? 'active' : ''}`} onClick={() => navigate('mywork')}><CircleDot size={18}/><span>내 업무</span><span className="nav-count">{data.issues.filter(i => i.assigneeId === actorId && !['done','cancelled'].includes(i.status)).length}</span></button></nav>
      <div className="sidebar-section-title"><span>프로젝트</span><button className="icon-btn" title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={() => setProjectModal(true)}><Plus size={15}/></button></div>
      <div className="project-list">{data.projects.map(p => <button key={p.id} className={`project-item ${p.id === projectId ? 'selected' : ''}`} onClick={() => navigate('overview', p.id)}><span className="project-symbol" style={{background: p.color + '17', color: p.color}}>{p.key.slice(0,1)}</span><span>{p.name}</span>{p.id === projectId && <ChevronDown size={14}/>}</button>)}</div>
      {project && <nav className="project-navigation">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={17}/><span>{item.label}</span>{item.id === 'issues' && <span className="nav-count">{projectIssues.length}</span>}</button>)}</nav>}
      <div className="sidebar-note"><Sparkles size={17}/><strong>업무와 지식을 한곳에</strong><p>계획에서 구현, 그리고 문서까지.<br/>우리 팀의 흐름을 연결하세요.</p></div>
      <div className="sidebar-footer"><button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={17}/><span>워크스페이스 설정</span></button><div className="local-status"><span/>로컬 개발 환경 <span className="version-label">v0.1</span></div></div>
    </aside>
    <div className="workspace-content">
      <header className="topbar"><button className="icon-btn mobile-only" aria-label="메뉴 열기" onClick={() => setSidebarOpen(true)}><ListTodo size={20}/></button><div className="breadcrumbs"><span className="breadcrumb-workspace">워크스페이스</span><ChevronRight size={14}/><span>{project?.name || '새 프로젝트'}</span><ChevronRight size={14}/><strong>{view === 'settings' ? '설정' : view === 'mywork' ? '내 업무' : navigation.find(n => n.id === view)?.label}</strong></div><div className="topbar-actions"><button className="icon-btn" aria-label="통합 검색" title="통합 검색" onClick={() => setSearchOpen(true)}><Search size={18}/></button><div className="actor-picker"><span className="avatar" style={{background: actor?.color}}>{actor?.name.slice(0,1)}</span><label className="sr-only" htmlFor="actor-select">작업자 선택</label><select id="actor-select" value={actorId} onChange={e => {if(!window.dispatchEvent(new Event('teamspace:navigate',{cancelable:true})))return;setActorId(e.target.value); setActor(e.target.value); localStorage.setItem('teamspace.actor', e.target.value);}}>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div></div></header>
      <main className={`main-content view-${view}`}>
        {view === 'overview' && <Overview {...props} navigate={navigate}/>}
        {view === 'mywork' && <MyWork {...props}/>}
        {view === 'issues' && <Issues {...props}/>}
        {view === 'gantt' && <Gantt {...props}/>}
        {view === 'documents' && <Suspense fallback={<div className="empty-state"><LoaderCircle className="spin"/><p>문서를 불러오는 중입니다.</p></div>}><Documents {...props} selectedDocumentId={documentId} onSelectDocument={selectDocument}/></Suspense>}
        {view === 'development' && <Development {...props}/>}
        {view === 'settings' && <WorkspaceSettings {...props}/>}
        {!project && <div className="empty-state"><FolderPlus/><h2>첫 프로젝트를 만들어보세요</h2><button className="btn btn-primary" onClick={() => setProjectModal(true)}>프로젝트 만들기</button></div>}
      </main>
    </div>
    {issueId && data.issues.some(i => i.id === issueId) && <IssuePanel {...props} issueId={issueId} onClose={() => requestRoute({projectId,view,documentId,issueId:null})}/>}
    {searchOpen && <SearchDialog {...props} onClose={() => setSearchOpen(false)}/>}
    {projectModal && <ProjectDialog refresh={refresh} notify={notify} onClose={() => setProjectModal(false)} onCreated={id => navigate('overview', id)}/>}
    {toast && <div role="status" className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={18}/> : <Bell size={18}/>}<span>{toast.message}</span><button onClick={() => setToast(null)} className="icon-btn" aria-label="알림 닫기"><X size={15}/></button></div>}
  </div>;
}

function Overview(props: FeatureProps & {navigate: (view: View) => void}) {
  const { data, projectId, openIssue, openDocument, navigate } = props;
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return null;
  const issues = data.issues.filter(i => i.projectId === projectId);
  const documents = data.documents.filter(d => d.projectId === projectId);
  const completed = issues.filter(i => i.status === 'done').length;
  const active = issues.filter(i => i.status === 'in_progress' || i.status === 'review');
  const today = new Date().toLocaleDateString('sv-SE');
  const overdue = issues.filter(i => i.endDate && i.endDate < today && !['done','cancelled'].includes(i.status));
  const percent = issues.length ? Math.round(completed / issues.length * 100) : 0;
  const recentIds = new Set([...issues.map(i => i.id), ...documents.map(d => d.id), projectId]);
  const activities = data.activities.filter(a => recentIds.has(a.resourceId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,8);
  return <div className="page overview-page"><div className="page-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1>{project.name}</h1><p>{project.description || '팀의 목표를 업무와 문서로 연결하는 공간입니다.'}</p></div><button className="btn btn-primary" onClick={() => navigate('issues')}><Plus size={16}/>업무 관리</button></div>
    <div className="project-summary-strip"><span className="project-key">{project.key}</span><span>{data.users.length}명의 팀원</span><span className="summary-separator"/><span>{documents.length}개의 문서</span><div className="team-avatars">{data.users.slice(0,5).map(u => <span key={u.id} className="avatar" style={{background:u.color}} title={u.name}>{u.name.slice(0,1)}</span>)}</div></div>
    <div className="metric-grid"><Metric label="전체 업무" value={issues.length} icon={<ListTodo/>} caption={`${completed}개 완료`}/><Metric label="진행 중" value={active.length} icon={<CircleDot/>} caption="개발 · 검토 중인 업무"/><Metric label="일정 초과" value={overdue.length} icon={<SquareChartGantt/>} caption={overdue.length ? '일정을 확인해주세요' : '차근차근 진행하고 있어요'} warning={overdue.length > 0}/><Metric label="프로젝트 문서" value={documents.length} icon={<BookOpen/>} caption="팀의 지식이 쌓이고 있어요"/></div>
    <div className="overview-grid"><section className="card progress-card"><div className="card-heading"><h2>프로젝트 진행 현황</h2><button className="text-link" onClick={() => navigate('issues')}>전체 업무 <ArrowUpRight size={15}/></button></div><div className="progress-headline"><strong>{percent}<small>%</small></strong><span>{issues.length}개 업무 중 {completed}개 완료</span></div><div className="segmented-progress">{Object.entries(STATUS).map(([status, meta]) => {const count = issues.filter(i => i.status === status).length;return count ? <span key={status} title={`${meta.label} ${count}개`} style={{width:`${count / issues.length * 100}%`,background:meta.color}}/> : null;})}</div><div className="status-breakdown">{Object.entries(STATUS).filter(([status]) => status !== 'cancelled').map(([status,meta]) => <div key={status}><span className="status-dot" style={{background:meta.color}}/><span>{meta.label}</span><strong>{issues.filter(i => i.status === status).length}</strong></div>)}</div></section>
      <section className="card schedule-card"><div className="card-heading"><h2>함께 보는 일정</h2><SquareChartGantt size={18}/></div><div className="schedule-illustration"><div><span>계획</span><i/><i/><i/></div><div><span>개발</span><i/><i/><i/></div><div><span>검증</span><i/><i/><i/></div></div><h3>업무를 일정에 연결해보세요</h3><p>날짜를 직접 입력하고, 업무 간 선후행 관계를 한눈에 확인하세요.</p><button className="btn btn-secondary" onClick={() => navigate('gantt')}>간트에서 일정 보기 <ArrowUpRight size={15}/></button></section>
      <section className="card overview-work"><div className="card-heading"><h2>지금 진행하는 업무 <span className="count-pill">{active.length}</span></h2><button className="text-link" onClick={() => navigate('issues')}>전체 보기 <ArrowUpRight size={15}/></button></div>{active.length ? active.slice(0,6).map(issue => <button key={issue.id} className="overview-issue" onClick={() => openIssue(issue.id)}><span className="status-ring" style={{color:STATUS[issue.status].color}}/><span className="issue-key">{issue.key}</span><span className="overview-issue-title">{issue.title}</span><span className="badge" style={{color:STATUS[issue.status].color}}>{STATUS[issue.status].label}</span></button>) : <div className="compact-empty">진행 중인 업무가 없습니다. 새 업무를 시작해보세요.</div>}</section>
      <section className="card overview-docs"><div className="card-heading"><h2>최근 문서</h2><button className="text-link" onClick={() => navigate('documents')}>문서 공간 <ArrowUpRight size={15}/></button></div>{[...documents].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,4).map(doc => <button key={doc.id} className="document-summary" onClick={() => openDocument(doc.id)}><span className="document-summary-icon">{doc.icon || '📄'}</span><div><strong>{doc.title || '제목 없는 문서'}</strong><span>{relativeTime(doc.updatedAt)} · v{doc.version}</span></div><ChevronRight size={15}/></button>)}{!documents.length && <div className="compact-empty">첫 번째 프로젝트 문서를 만들어보세요.</div>}</section>
      <section className="card activity-card"><div className="card-heading"><h2>팀의 최근 활동</h2><span className="muted">업무와 문서의 변경 이력</span></div>{activities.map(activity => {const user = data.users.find(u => u.id === activity.actorId); return <div className="activity-row" key={activity.id}><span className="avatar" style={{background:user?.color}}>{user?.name.slice(0,1) || '팀'}</span><div><strong>{user?.name || '팀원'}</strong> <span>{activity.detail || activity.action}</span></div><time>{relativeTime(activity.createdAt)}</time></div>;})}{!activities.length && <div className="compact-empty">새로운 활동이 여기에 표시됩니다.</div>}</section>
    </div></div>;
}

function Metric({label,value,icon,caption,warning=false}:{label:string;value:number;icon:React.ReactNode;caption:string;warning?:boolean}) {return <div className={`metric-card ${warning ? 'warning' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}<small>개</small></strong><p>{caption}</p></div>;}

function MyWork(props: FeatureProps) {
  const issues = props.data.issues.filter(i => i.assigneeId === props.actorId);
  return <div className="page"><div className="page-heading"><div><div className="eyebrow">MY WORK</div><h1>내 업무</h1><p>프로젝트를 넘어, 내가 맡은 일을 한곳에서 확인하세요.</p></div></div>{(['in_progress','review','todo','backlog','done'] as const).map(status => <section className="card my-work-group" key={status}><div className="card-heading"><h2><span className="status-dot" style={{background:STATUS[status].color}}/>{STATUS[status].label}</h2><span className="count-pill">{issues.filter(i => i.status === status).length}</span></div>{issues.filter(i => i.status === status).map(issue => <button key={issue.id} className="overview-issue" onClick={() => props.openIssue(issue.id)}><span className="issue-key">{issue.key}</span><span className="overview-issue-title">{issue.title}</span><span className="muted">{props.data.projects.find(p => p.id === issue.projectId)?.name}</span></button>)}{!issues.some(i => i.status === status) && <div className="compact-empty">이 상태의 업무가 없습니다.</div>}</section>)}</div>;
}

function SearchDialog(props: FeatureProps & {onClose:()=>void}) {
  const [query,setQuery] = useState('');
  const q = query.toLocaleLowerCase().trim();
  const issues = q ? props.data.issues.filter(i => `${i.key} ${i.title} ${i.description} ${i.labels.join(' ')}`.toLocaleLowerCase().includes(q)).slice(0,12) : [];
  const docs = q ? props.data.documents.filter(d => `${d.title} ${d.plainText}`.toLocaleLowerCase().includes(q)).slice(0,8) : [];
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="통합 검색"><div className="search-input-wrap"><Search size={21}/><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="티켓 번호, 업무 제목, 문서 내용 검색…"/><button className="icon-btn" onClick={props.onClose} aria-label="검색 닫기"><X size={19}/></button></div><div className="search-results">{!q ? <div className="search-intro"><Command size={30}/><h3>팀의 업무와 지식을 찾아보세요</h3><p>모든 프로젝트의 티켓과 문서를 검색합니다.</p></div> : <>{issues.length > 0 && <div className="search-label">업무</div>}{issues.map(i => <button className="search-result" key={i.id} onClick={() => props.openIssue(i.id)}><CircleDot size={17} style={{color:STATUS[i.status].color}}/><span className="issue-key">{i.key}</span><span>{i.title}</span><ChevronRight size={15}/></button>)}{docs.length > 0 && <div className="search-label">문서</div>}{docs.map(d => <button className="search-result" key={d.id} onClick={() => props.openDocument(d.id)}><BookOpen size={17}/><span>{d.title}</span><ChevronRight size={15}/></button>)}{!issues.length && !docs.length && <div className="empty-state"><Search/><p>검색 결과가 없습니다.</p></div>}</>}</div><div className="search-footer"><span>업무 · 문서 · 프로젝트</span><kbd>ESC 닫기</kbd></div></div></div>;
}

function ProjectDialog({refresh,notify,onClose,onCreated}:{refresh:()=>Promise<void>;notify:FeatureProps['notify'];onClose:()=>void;onCreated:(id:string)=>void}) {
  const [name,setName]=useState('');const [key,setKey]=useState('');const [description,setDescription]=useState('');const [busy,setBusy]=useState(false);
  return <div className="modal-backdrop"><form className="modal-card" onSubmit={async e=>{e.preventDefault();setBusy(true);try{const p=await post<{id:string}>('/projects',{name,key,description,color:'#177c72'});await refresh();notify('프로젝트를 만들었습니다.');onClose();onCreated(p.id);}catch(error){notify((error as Error).message,'error');}finally{setBusy(false);}}}><div className="card-heading"><h2>새 프로젝트</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="닫기"><X size={19}/></button></div><p className="muted">새로운 목표를 팀의 업무와 문서로 연결하세요.</p><label className="form-label">프로젝트 이름<input className="field" required value={name} onChange={e=>setName(e.target.value)} placeholder="예: 제품 개발"/></label><label className="form-label">티켓 접두어<input className="field" required value={key} onChange={e=>setKey(e.target.value.toUpperCase())} placeholder="예: DEV" pattern="[A-Z][A-Z0-9]{1,9}" minLength={2} maxLength={10}/><span className="help-text">영문 대문자와 숫자 2~10자 · DEV-1처럼 사용합니다.</span></label><label className="form-label">프로젝트 소개<textarea className="field" value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label><div className="modal-actions"><button type="button" className="btn" onClick={onClose}>취소</button><button disabled={busy} className="btn btn-primary">{busy ? '생성 중…' : '프로젝트 만들기'}</button></div></form></div>;
}

function Development(props: FeatureProps) {
  const [settings,setSettings]=useState<GitlabSettings|null>(null);const [baseUrl,setBaseUrl]=useState('');const [ids,setIds]=useState('');const [token,setToken]=useState('');const [secret,setSecret]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const load=useCallback(async()=>{try{const s=await api<GitlabSettings>('/integrations/gitlab');setSettings(s);setBaseUrl(s.baseUrl);setIds(s.projectIds.join(', '));setError('');}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{load();},[load]);
  const issueIds=new Set(props.data.issues.filter(i=>i.projectId===props.projectId).map(i=>i.id));const links=props.data.gitlabLinks.filter(l=>issueIds.has(l.issueId));
  return <div className="page"><div className="page-heading"><div><div className="eyebrow">DEVELOPMENT</div><h1>코드와 업무를 연결하세요</h1><p>GitLab의 MR과 파이프라인을 티켓 맥락에서 확인합니다.</p></div><button className="btn btn-primary" disabled={busy || !settings?.tokenConfigured} onClick={async()=>{setBusy(true);try{const r=await post<{linked?:number}>('/integrations/gitlab/sync',{});await props.refresh();await load();props.notify(`GitLab 동기화를 완료했습니다.${r.linked !== undefined ? ` ${r.linked}개 연결` : ''}`);}catch(e){props.notify((e as Error).message,'error');await load();}finally{setBusy(false);}}}><GitBranch size={16}/>{busy ? '처리 중…' : '지금 동기화'}</button></div>
    {error && <div className="inline-error">{error}<button className="btn" onClick={load}>다시 시도</button></div>}
    <div className="integration-grid"><form className="card integration-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{const projectIds=ids.split(',').map(i=>i.trim()).filter(Boolean).map(Number);if(projectIds.some(i=>!Number.isInteger(i)||i<1))throw new Error('프로젝트 ID는 쉼표로 구분된 양의 정수로 입력해주세요.');await patch('/integrations/gitlab',{baseUrl,projectIds,...(token ? {token} : {}),...(secret ? {webhookSecret:secret}: {})});setToken('');setSecret('');await load();props.notify('GitLab 연결 설정을 저장했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}><div className="card-heading"><h2><GitBranch size={19}/>GitLab 연결</h2><span className={`badge ${settings?.tokenConfigured ? 'badge-green' : ''}`}>{settings?.tokenConfigured ? '설정됨' : '미연결'}</span></div><label className="form-label">GitLab 주소<input type="url" className="field" placeholder="https://gitlab.example.com" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} required/></label><label className="form-label">GitLab 프로젝트 ID<input className="field" placeholder="예: 12, 34" value={ids} onChange={e=>setIds(e.target.value)} required/><span className="help-text">GitLab 프로젝트 설정의 숫자 ID를 입력하세요.</span></label><label className="form-label">읽기 API 토큰<input type="password" autoComplete="new-password" className="field" placeholder={settings?.tokenConfigured ? '저장된 토큰 유지 · 변경할 때만 입력' : 'read_api 권한의 토큰'} value={token} onChange={e=>setToken(e.target.value)}/></label><label className="form-label">웹훅 Secret Token<input type="password" className="field" autoComplete="new-password" placeholder={settings?.webhookSecretConfigured ? '저장된 비밀값 유지' : '선택 · 웹훅 연결 시 입력'} value={secret} onChange={e=>setSecret(e.target.value)}/></label><div className="data-actions"><button className="btn btn-primary" disabled={busy}>연결 설정 저장</button>{(settings?.tokenConfigured || settings?.webhookSecretConfigured) && <button className="btn btn-ghost" type="button" disabled={busy} onClick={async()=>{if(!window.confirm('저장된 GitLab 토큰과 웹훅 비밀값을 삭제할까요? 기존 개발 활동 기록은 유지됩니다.'))return;setBusy(true);try{await patch('/integrations/gitlab',{token:'',webhookSecret:''});await load();props.notify('GitLab 자격 증명을 삭제했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}>연결 해제</button>}</div>{settings?.lastSyncAt && <p className="help-text">마지막 동기화: {new Date(settings.lastSyncAt).toLocaleString('ko-KR')}</p>}{settings?.lastError && <p className="error-text">{settings.lastError}</p>}</form>
    <section className="card integration-guide"><div className="gitlab-symbol"><GitBranch size={35}/></div><h2>티켓 번호로 자연스럽게 연결</h2><p>브랜치 이름이나 MR 제목에 티켓 번호를 넣으면 관련 업무를 찾아 연결합니다.</p><code>{props.data.projects.find(p=>p.id===props.projectId)?.key || 'TEAM'}-12 로그인 오류 수정</code><ul><li>코드 검토와 업무 진행 상태를 나란히 확인합니다.</li><li>MR 병합이 업무를 자동 완료시키지는 않습니다.</li><li>연결 설정 전에는 외부 GitLab에 요청하지 않습니다.</li></ul><p className="help-text">웹훅 경로: <code>/api/integrations/gitlab/webhook</code><br/>GitLab에서 접근 가능한 배포 주소가 있을 때 설정하세요.</p></section></div>
    <section className="card linked-development"><div className="card-heading"><h2>연결된 개발 활동</h2><span className="count-pill">{links.length}</span></div>{links.length ? links.map(link=><div className="development-row" key={link.id}><GitBranch size={19}/><div><a href={link.webUrl} target="_blank" rel="noreferrer">{link.title} <ArrowUpRight size={13}/></a><button className="text-link" onClick={()=>props.openIssue(link.issueId)}>{props.data.issues.find(i=>i.id===link.issueId)?.key}</button></div><span className="badge">{link.state}</span></div>) : <div className="empty-state"><GitBranch/><h3>아직 연결된 개발 활동이 없습니다</h3><p>GitLab을 설정하고 티켓 번호가 포함된 MR을 동기화해보세요.</p></div>}</section>
  </div>;
}

function WorkspaceSettings(props:FeatureProps) {
  const [name,setName]=useState('');const [email,setEmail]=useState('');const [busy,setBusy]=useState(false);const [importData,setImportData]=useState<unknown>(null);const [importName,setImportName]=useState('');
  return <div className="page settings-page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>팀의 작업 공간</h1><p>간단한 팀원 관리와 데이터 이동 기능을 제공합니다.</p></div></div><section className="card settings-card"><div className="card-heading"><h2><Users size={19}/>팀원</h2><span className="badge">{props.data.users.length}명</span></div><p className="muted">상단의 작업자를 선택하면 변경 이력에 해당 팀원이 기록됩니다. 현재는 별도의 로그인 기능을 사용하지 않습니다.</p><div className="team-list">{props.data.users.map(user=><div className="team-row" key={user.id}><span className="avatar" style={{background:user.color}}>{user.name.slice(0,1)}</span><strong>{user.name}</strong><span>{user.email}</span><button className="btn btn-ghost" onClick={async()=>{const next=window.prompt('변경할 이메일 주소',user.email);if(next===null||next===user.email)return;try{await patch(`/users/${user.id}`,{email:next});await props.refresh();props.notify('이메일 주소를 변경했습니다.');}catch(e){props.notify((e as Error).message,'error');}}}>이메일 변경</button></div>)}</div><form className="invite-form" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await post('/users',{name,email,color:'#6785b5'});setName('');setEmail('');await props.refresh();props.notify('팀원을 추가했습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}><input className="field" aria-label="새 팀원 이름" placeholder="이름" value={name} onChange={e=>setName(e.target.value)} required/><input type="email" className="field" aria-label="새 팀원 이메일" placeholder="이메일" value={email} onChange={e=>setEmail(e.target.value)} required/><button disabled={busy} className="btn btn-primary"><Plus size={16}/>팀원 추가</button></form></section>
    <section className="card settings-card"><div className="card-heading"><h2>데이터 내보내기 · 가져오기</h2><ArrowDownToLine size={19}/></div><p className="muted">티켓·문서·관계와 변경 이력을 자체 JSON 형식으로 보관합니다. GitLab 토큰은 포함되지 않습니다.</p><div className="data-actions"><button className="btn btn-secondary" onClick={async()=>{try{const payload=await api('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`teamspace-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);props.notify('데이터를 내보냈습니다.');}catch(e){props.notify((e as Error).message,'error');}}}><ArrowDownToLine size={16}/>전체 데이터 내보내기</button><label className="btn btn-ghost"><ArrowUpFromLine size={16}/>백업 가져오기<input className="sr-only" type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>64*1024*1024-1024){props.notify('가져오기 파일은 64MB 미만이어야 합니다.','error');e.target.value='';return;}try{const parsed=JSON.parse(await file.text());if(!parsed || typeof parsed!=='object' || ![1,2].includes(parsed.schemaVersion))throw new Error('Teamspace 내보내기 파일(schemaVersion 1 또는 2)을 선택해주세요.');setImportData(parsed);setImportName(file.name);}catch(error){props.notify(error instanceof SyntaxError ? '올바른 JSON 파일이 아닙니다.' : (error as Error).message,'error');}e.target.value='';}}/></label></div></section>
    <section className="card settings-card"><div className="card-heading"><h2>이 개발 버전의 범위</h2><span className="badge">개발 중</span></div><p>현재 데이터는 API 서버의 SQLite 파일에 저장됩니다. 팀원 선택은 작업자 기록을 위한 기능이며 인증 기능이 아닙니다.</p><p className="muted">실시간 공동 편집, 기존 Jira·Confluence 전체 이관, 고급 워크플로 설정과 운영 배포는 후속 개발·검증 범위입니다.</p></section>
    {importData !== null && <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-label="백업 가져오기 확인"><h2>백업을 가져올까요?</h2><p><strong>{importName}</strong></p><p>현재 워크스페이스의 티켓·문서·관계·첨부 데이터를 이 백업으로 교체하고 이 브라우저의 임시 문서·댓글 초안도 초기화합니다. 먼저 현재 데이터를 내보내어 보관해주세요.</p><div className="modal-actions"><button className="btn" onClick={()=>setImportData(null)}>취소</button><button className="btn btn-danger" disabled={busy} onClick={async()=>{setBusy(true);try{await post('/import',{data:importData});for(const key of Object.keys(localStorage)){if(key.startsWith('teamspace:document-draft:') || key.startsWith('teamspace:document-comment-draft:'))localStorage.removeItem(key);}await props.refresh();setImportData(null);props.notify('백업 데이터를 가져왔습니다.');}catch(e){props.notify((e as Error).message,'error');}finally{setBusy(false);}}}>확인하고 가져오기</button></div></div></div>}
  </div>;
}
