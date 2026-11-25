'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight, GitBranch, RefreshCw, Search } from 'lucide-react';
import { DEFAULT_GITLAB_ACTIVITY_FILTERS, GITLAB_ACTIVITY_QUERY_LIMIT, GITLAB_ACTIVITY_SCOPES, GITLAB_ACTIVITY_SCOPE_LABELS,
  filterGitlabActivityLinks, gitlabActivityRepositories, normalizeGitlabActivityQuery, type GitlabActivityFilters } from '../../shared/gitlab-activity-filter';
import type { FeatureProps, GitlabHistoryLimits, GitlabIssueRefreshResult, GitlabJiraRoute, GitlabJiraSource, GitlabLink, GitlabSettings, GitlabSyncCoverage, GitlabSyncCoverageState, GitlabSyncFailure, GitlabSyncPreview, GitlabSyncPreviewCounts, GitlabSyncRepositoryFailure, GitlabSyncResult, GitlabSyncStatus, Project } from '../../shared/types';
import { api, ApiError, patch, post } from '../lib/api';
import type { ChangeGitlabDeploymentView, GitlabDeploymentView } from '../lib/gitlab-deployment-route';
import type { OpenIssueForReview } from '../lib/issue-review';
import { afterAcceptedNavigation, isDevelopmentReviewNavigation } from '../lib/navigation';
import { AutomationSettings } from './AutomationSettings';
import { GitlabActivityList, GitlabActivityRefresh, gitlabActivityKindLabel, gitlabActivityStateLabel,
  gitlabLinkedStatusRefreshPath, isGitlabLinkedStatusRefreshResult } from './GitlabActivity';
import { GitlabDeploymentPreview } from './GitlabDeploymentPreview';
import { useGitlabFollowUp } from './GitlabFollowUp';
import { RepositoryGitlabDeployments } from './GitlabDeployments';
import { GitlabProjectWebhookPanel } from './GitlabProjectWebhookPanel';
import { GitlabRepositoryPicker } from './GitlabRepositoryPicker';
import { GitlabWebhookStatusPanel } from './GitlabWebhookStatusPanel';
import { WebhookSettings } from './WebhookSettings';
import './development.css';

type Draft={baseUrl:string;ids:string;token:string;secret:string;signingToken:string;jiraRoutes:GitlabJiraRoute[]};
const empty:Draft={baseUrl:'',ids:'',token:'',secret:'',signingToken:'',jiraRoutes:[]};
const sortedRoutes = (routes: GitlabJiraRoute[]) => [...routes].sort((a, b) => a.repositoryId - b.repositoryId);
const draftOf=(settings:GitlabSettings):Draft=>({...empty,baseUrl:settings.baseUrl,ids:settings.projectIds.join(', '),jiraRoutes:sortedRoutes(settings.jiraRoutes ?? [])});
type PreviewState = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; result: GitlabSyncPreview; jiraRoutes: GitlabJiraRoute[] };
type SyncStatusRead = { version: number; status: GitlabSyncStatus | null; loading: boolean; error: string; settingsChanged: boolean };
type SyncRetry = { repositoryIds: number[]; includeHistory: boolean };
type JiraSources = { items: GitlabJiraSource[]; loading: boolean; error: string };
const maxGitlabRepositories = 100;
function HistoryLimitNote({ limits }: { limits?: GitlabHistoryLimits }) {
  const capped = [limits?.branches && '브랜치 500개', limits?.commits && '커밋 100개'].filter(Boolean);
  return capped.length > 0 && <p className="help-text gitlab-history-limits">{capped.join(' · ')} 조회 한도에 도달했습니다.</p>;
}

const activityCoverageLabel: Record<GitlabSyncCoverageState, string> = {
  complete: '마지막 페이지까지 조회',
  limited: '추가 페이지 있음',
  unverified: '추가 페이지 확인 불가',
};

function ActivityCoverageNote({ coverage }: { coverage?: GitlabSyncCoverage }) {
  if (!coverage) return null;
  return <>
    <p className="help-text">MR {activityCoverageLabel[coverage.mergeRequests]} · 파이프라인 {activityCoverageLabel[coverage.pipelines]}</p>
    {(coverage.mergeRequests !== 'complete' || coverage.pipelines !== 'complete') && <p className="help-text">
      빠진 활동의 주소를 알고 있다면 티켓의 <strong>GitLab 링크 추가</strong>에서 연결할 수 있습니다.
    </p>}
  </>;
}

function readProjectIds(input: string): number[] {
  const projectIds = input.split(',').map(value => value.trim()).filter(Boolean).map(Number);
  if (projectIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('프로젝트 ID는 쉼표로 구분된 양의 정수로 입력해 주세요.');
  if (projectIds.length > maxGitlabRepositories || new Set(projectIds).size !== projectIds.length) throw new Error(`중복되지 않은 저장소 ID를 최대 ${maxGitlabRepositories}개까지 입력해 주세요.`);
  return projectIds;
}

function editableRepoIds(input: string): number[] {
  try { return readProjectIds(input); }
  catch { return []; }
}

function normalizedAddress(input: string): string | null {
  if (!input.trim()) return '';
  try { return new URL(input.trim()).toString().replace(/\/+$/, ''); }
  catch { return null; }
}

function syncFailure(cause: unknown, version: number): GitlabSyncFailure | null {
  if (!(cause instanceof ApiError) || cause.status !== 502 || !cause.details || typeof cause.details !== 'object') return null;
  const details = cause.details as Partial<GitlabSyncFailure>;
  return details.settingsVersion === version && typeof details.reason === 'string' && Array.isArray(details.repositories) &&
    details.repositories.length && details.repositories.every(repository => repository?.status === 'error' && repository.error)
    ? details as GitlabSyncFailure : null;
}

type DevelopmentActivityProps = {
  activityFilters: GitlabActivityFilters;
  onChangeActivityFilters: (filters: GitlabActivityFilters, mode?: 'push' | 'replace') => void;
  onOpenIssueForReview: OpenIssueForReview;
};
export function Development(props: FeatureProps & DevelopmentActivityProps & {
  deploymentView: GitlabDeploymentView;
  onChangeDeploymentView: ChangeGitlabDeploymentView;
}) {
  const {notify}=props;
  const [settings,setSettings]=useState<GitlabSettings|null>(null),[draft,setDraft]=useState< Draft>(empty),[baseline,setBaseline]=useState< Draft>(empty);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [refreshingLinkId, setRefreshingLinkId] = useState<string | null>(null);
  const [checkedActivity, setCheckedActivity] = useState<{ context: string; link: GitlabLink } | null>(null);
  const checkedActivityButton = useRef<HTMLButtonElement>(null);
  const activityRequest = useRef<AbortController | null>(null);
  const activityReturnFocus = useRef<{ trigger: HTMLButtonElement; fallback: HTMLElement | null } | null>(null);
  const [syncRead, setSyncRead] = useState<SyncStatusRead | null>(null);
  const [jiraSources, setJiraSources] = useState<JiraSources>({ items: [], loading: true, error: '' });
  const [repositorySearchRevision, setRepositorySearchRevision] = useState(0);
  const [deploymentPreviewRevision, setDeploymentPreviewRevision] = useState(0);
  const previewRequest = useRef<AbortController | null>(null);
  const syncStatusRequest = useRef<AbortController | null>(null);
  const syncStatusVersion = useRef<number | null>(null);
  const jiraSourcesRequest = useRef<AbortController | null>(null);
  const connectionForm = useRef<HTMLFormElement>(null);
  const pending=useRef(false),dirtyRef=useRef(false),alive=useRef(true);
  const dirty=JSON.stringify(draft)!==JSON.stringify(baseline);
  const { scope: activityScope, query: activityQuery, memberId: activityMember, repositoryKey: activityRepository } = props.activityFilters;
  const activityContext = JSON.stringify([props.projectId, props.actorId, activityScope, activityQuery, activityMember, activityRepository]);
  const retainsToken = settings?.tokenConfigured && normalizedAddress(draft.baseUrl) === settings.baseUrl;
  const missingRoutesAfterAddressEdit = baseline.jiraRoutes.length > 0 && draft.jiraRoutes.length === 0
    && normalizedAddress(draft.baseUrl) !== normalizedAddress(baseline.baseUrl);
  useEffect(()=>{dirtyRef.current=dirty;},[dirty]);
  useEffect(() => () => activityRequest.current?.abort(), []);
  useLayoutEffect(() => {
    const focus = activityReturnFocus.current;
    if (busy || !focus) return;
    activityReturnFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement !== focus.trigger) return;
    const followUp = checkedActivityButton.current;
    const target = focus.trigger.isConnected && !focus.trigger.disabled ? focus.trigger : followUp ?? focus.fallback;
    if (target?.isConnected) target.focus({ preventScroll: target !== followUp });
  }, [busy]);
  const clearPreview = useCallback(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreview(null);
  }, []);
  const clearRepositorySearch = useCallback(() => setRepositorySearchRevision(value => value + 1), []);
  const clearDeploymentPreview = useCallback(() => setDeploymentPreviewRevision(value => value + 1), []);
  const readSyncStatus = useCallback(async (version: number): Promise<GitlabSyncStatus | null> => {
    if (!alive.current || syncStatusVersion.current !== version) return null;
    syncStatusRequest.current?.abort();
    const controller = new AbortController();
    syncStatusRequest.current = controller;
    setSyncRead(current => ({ version, status: current?.version === version ? current.status : null, loading: true, error: '', settingsChanged: false }));
    try {
      const status = await api<GitlabSyncStatus>('/integrations/gitlab/sync-status', { cache: 'no-store', signal: controller.signal });
      if (syncStatusRequest.current !== controller) return null;
      if (!Array.isArray(status?.repositories)) throw new Error('Unexpected GitLab sync status');
      if (status.settingsVersion !== version) {
        setSyncRead({ version, status: null, loading: false, settingsChanged: true,
          error: '연결 설정이 변경되었습니다. 최신 설정을 불러온 뒤 동기화 결과를 다시 확인하세요.' });
        return null;
      }
      setSyncRead({ version, status, loading: false, error: '', settingsChanged: false });
      return status;
    } catch {
      if (syncStatusRequest.current === controller) {
        setSyncRead(current => ({ version, status: current?.version === version ? current.status : null, loading: false,
          error: '저장된 GitLab 동기화 결과를 불러오지 못했습니다.', settingsChanged: false }));
      }
      return null;
    } finally {
      if (syncStatusRequest.current === controller) syncStatusRequest.current = null;
    }
  }, []);
  const accept=useCallback((value:GitlabSettings)=>{
    clearPreview();
    clearRepositorySearch();
    clearDeploymentPreview();
    setSettings(value);
    const next = draftOf(value);
    setDraft(next);
    setBaseline(next);
    dirtyRef.current = false;
    setError('');
    syncStatusVersion.current = value.baseUrl && value.projectIds.length ? value.version : null;
    if (syncStatusVersion.current !== null) void readSyncStatus(value.version);
    else {
      syncStatusRequest.current?.abort();
      syncStatusRequest.current = null;
      setSyncRead(null);
    }
  },[clearPreview,clearRepositorySearch,clearDeploymentPreview,readSyncStatus]);
  useEffect(()=>{
    alive.current=true;
    let cancelled=false;
    void api<GitlabSettings>('/integrations/gitlab').then(value=>{if(!cancelled)accept(value);}).catch(e=>{if(!cancelled)setError((e as Error).message);});
    return()=>{
      cancelled=true;
      alive.current=false;
      previewRequest.current?.abort();
      previewRequest.current=null;
      syncStatusRequest.current?.abort();
      syncStatusRequest.current=null;
      syncStatusVersion.current=null;
    };
  },[accept]);
  const loadJiraSources = useCallback(async () => {
    jiraSourcesRequest.current?.abort();
    const controller = new AbortController();
    jiraSourcesRequest.current = controller;
    setJiraSources(current => ({ ...current, loading: true, error: '' }));
    try {
      const items = await api<GitlabJiraSource[]>('/integrations/gitlab/jira-sources', { signal: controller.signal });
      if (!controller.signal.aborted) setJiraSources({ items, loading: false, error: '' });
    } catch (cause) {
      if (!controller.signal.aborted) setJiraSources(current => ({ ...current, loading: false, error: cause instanceof Error ? cause.message : '이관한 Jira 원본을 불러오지 못했습니다.' }));
    }
  }, []);
  useEffect(() => {
    const scheduled = window.setTimeout(() => void loadJiraSources(), 0);
    return () => { window.clearTimeout(scheduled); jiraSourcesRequest.current?.abort(); };
  }, [loadJiraSources]);
  useEffect(()=>{
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('GitLab 요청이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      if (isDevelopmentReviewNavigation(event) || !dirtyRef.current) return;
      if (!window.confirm('저장하지 않은 GitLab 설정을 버리고 이동할까요?')) event.preventDefault();
      else afterAcceptedNavigation(event, () => {
        clearPreview();
        clearRepositorySearch();
        clearDeploymentPreview();
        setDraft(baseline);
        dirtyRef.current = false;
        setError('');
      });
    };
    const unload=(event:BeforeUnloadEvent)=>{if(pending.current||dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('teamspace:navigate',guard);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('teamspace:navigate',guard);window.removeEventListener('beforeunload',unload);};
  },[baseline,clearPreview,clearRepositorySearch,clearDeploymentPreview,notify]);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    clearPreview();
    if (key === 'baseUrl' || key === 'token') clearRepositorySearch();
    if (key === 'baseUrl' || key === 'token' || key === 'ids') clearDeploymentPreview();
    setDraft(previous => {
      const next = { ...previous, [key]: value };
      if (key === 'baseUrl' && normalizedAddress(next.baseUrl) !== normalizedAddress(previous.baseUrl)) next.jiraRoutes = [];
      return next;
    });
  }
  function addRepository(repositoryId: number) {
    const ids = readProjectIds(draft.ids);
    if (ids.includes(repositoryId)) return;
    if (ids.length >= maxGitlabRepositories) throw new Error(`최대 ${maxGitlabRepositories}개까지 저장소를 선택할 수 있습니다.`);
    edit('ids', [...ids, repositoryId].join(', '));
  }
  function updateJiraRoute(repositoryId: number, projectId: string, jiraInstanceKey = '') {
    const other = draft.jiraRoutes.filter(route => route.repositoryId !== repositoryId);
    edit('jiraRoutes', sortedRoutes(projectId ? [...other, { repositoryId, projectId, jiraInstanceKey }] : other));
  }
  function submittedRoutes(projectIds: number[]) {
    const routes = draft.jiraRoutes.filter(route => projectIds.includes(route.repositoryId));
    const incomplete = routes.find(route => !route.jiraInstanceKey);
    if (incomplete) {
      const source = connectionForm.current?.querySelector(`[data-gitlab-source-repo="${incomplete.repositoryId}"]`);
      const input = source instanceof HTMLSelectElement && !source.disabled ? source :
        connectionForm.current?.querySelector(`[data-gitlab-project-repo="${incomplete.repositoryId}"]`);
      if (input instanceof HTMLSelectElement) input.focus();
      throw new Error(`저장소 ${incomplete.repositoryId}의 Jira 원본 인스턴스를 선택해 주세요.`);
    }
    return routes;
  }
  async function execute(action:()=>Promise<void>){if(pending.current)return;clearPreview();pending.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError((e as Error).message);}finally{pending.current=false;if(alive.current)setBusy(false);}}
  async function reload(){if(dirtyRef.current&&!window.confirm('작성 중인 GitLab 설정을 버리고 최신 설정을 불러올까요?'))return;await execute(async()=>{accept(await api<GitlabSettings>('/integrations/gitlab'));await loadJiraSources();});}
  async function save(event:FormEvent){event.preventDefault();if(!settings)return;await execute(async()=>{
    const projectIds=readProjectIds(draft.ids);
    const jiraRoutes = submittedRoutes(projectIds);
    const saved=await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,baseUrl:draft.baseUrl,projectIds,...(jiraRoutes.length||settings.jiraRoutes?.length?{jiraRoutes}:{}),...(draft.token?{token:draft.token}:{}),...(draft.secret?{webhookSecret:draft.secret}:{}),...(draft.signingToken?{signingToken:draft.signingToken}:{})});accept(saved);window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 연결 설정을 저장했습니다.');
  });}
  async function disconnect(){if(!settings||!window.confirm('GitLab 자격 증명을 삭제하고 상태 자동화를 비활성화할까요? 입력 중인 연결 설정도 초기화합니다. 기존 개발 활동 기록은 유지됩니다.'))return;await execute(async()=>{accept(await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,token:'',webhookSecret:'',signingToken:''}));window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 자격 증명을 삭제했습니다.');});}
  async function sync(retry?: SyncRetry) {
    if (!settings) return;
    const expectedVersion = settings.version;
    const scanHistory = retry?.includeHistory ?? includeHistory;
    await execute(async () => {
      let result: GitlabSyncResult | undefined;
      try {
        result = await post<GitlabSyncResult>('/integrations/gitlab/sync', {
          expectedVersion, ...(scanHistory ? { includeHistory: true } : {}), ...(retry ? { repositoryIds: retry.repositoryIds } : {}),
        });
        if (!result?.ok || result.settings.version !== expectedVersion) throw new Error('Unexpected GitLab sync response');
      } catch (cause) {
        if (!alive.current) return;
        const failure = syncFailure(cause, expectedVersion);
        const refreshed = readSyncStatus(expectedVersion);
        if (failure) {
          await refreshed;
          if (alive.current) props.notify('요청한 저장소를 조회하지 못했습니다. 동기화 결과를 확인하세요.', 'error');
          return;
        }
        if (cause instanceof ApiError && cause.status < 500) {
          await refreshed;
          throw cause;
        }
        await Promise.all([refreshed, props.refresh().catch(() => undefined)]);
        throw new Error('GitLab 동기화 응답을 확인하지 못했습니다. 서버에 저장된 최근 결과를 확인해 주세요.');
      }
      if (!alive.current) return;
      setSettings(result.settings);
      await Promise.all([readSyncStatus(expectedVersion), props.refresh()]);
      if (alive.current) {
        if (result.partial) props.notify(`조회한 저장소에서 ${result.linked}개 연결을 저장했습니다. 실패한 저장소는 동기화 결과에서 확인하세요.`);
        else props.notify(`GitLab 동기화를 완료했습니다. ${result.linked}개 연결`);
      }
    });
  }
  async function requestPreview() {
    if (!settings || pending.current || previewRequest.current) return;
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreview({ state: 'loading' });
    try {
      const projectIds = readProjectIds(draft.ids);
      const jiraRoutes = submittedRoutes(projectIds);
      const result = await api<GitlabSyncPreview>('/integrations/gitlab/sync-preview', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ expectedVersion: settings.version, baseUrl: draft.baseUrl, projectIds,
          ...(jiraRoutes.length || settings.jiraRoutes?.length ? { jiraRoutes } : {}), ...(draft.token ? { token: draft.token } : {}), ...(includeHistory ? { includeHistory: true } : {}) }),
      });
      if (previewRequest.current === controller) setPreview({ state: 'ready', result, jiraRoutes });
    } catch (cause) {
      if (previewRequest.current === controller) setPreview({ state: 'failed', error: cause instanceof Error ? cause.message : 'GitLab 조회에 실패했습니다.' });
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
    }
  }
  async function checkActivityStatus(link: GitlabLink, trigger: HTMLButtonElement, fallback: HTMLElement | null) {
    if (pending.current) return;
    const hadFocus = document.activeElement === trigger;
    const controller = new AbortController();
    activityRequest.current = controller;
    pending.current = true;
    setBusy(true);
    setRefreshingLinkId(link.id);
    setCheckedActivity(null);
    try {
      const result = await api<GitlabIssueRefreshResult>(gitlabLinkedStatusRefreshPath(link.issueId, link.id), {
        method: 'POST', body: '{}', signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!isGitlabLinkedStatusRefreshResult(result, link)) {
        notify('GitLab 상태 확인 결과를 받지 못했습니다. GitLab 활동 새로고침을 눌러 주세요.', 'error');
        return;
      }
      const checked = result.links[0];
      if (!checked) {
        notify(result.failures[0].message, 'error');
        return;
      }
      try { await props.refresh(); }
      catch {
        if (!controller.signal.aborted) notify('GitLab 상태를 저장했습니다. 목록을 다시 불러오려면 새로고침을 눌러 주세요.', 'error');
        return;
      }
      if (!controller.signal.aborted) {
        setCheckedActivity({ context: activityContext, link: checked });
        notify(`${gitlabActivityKindLabel(checked.kind)} 상태를 확인했습니다. ${gitlabActivityStateLabel(checked.state)}`, 'success');
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError) {
        notify(cause.message, 'error');
        if (cause.status === 404 || cause.status === 409) await props.refresh().catch(() => undefined);
      } else {
        notify('GitLab 상태 확인 결과를 받지 못했습니다. GitLab 활동 새로고침을 눌러 주세요.', 'error');
      }
    } finally {
      activityRequest.current = null;
      pending.current = false;
      if (!controller.signal.aborted) {
        if (hadFocus) activityReturnFocus.current = { trigger, fallback };
        setRefreshingLinkId(null);
        setBusy(false);
      }
    }
  }
  const repositoryIds = editableRepoIds(draft.ids);
  const currentSyncRead = syncRead?.version === settings?.version ? syncRead : null;
  const syncStatus = currentSyncRead?.status ?? null;
  const legacySyncFallback = Boolean(currentSyncRead?.error && !currentSyncRead.settingsChanged && !syncStatus);
  function focusConnectionSettings() {
    const heading = connectionForm.current?.querySelector('h2');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }
  return <div className="page development-page"><div className="page-heading"><div><div className="eyebrow">DEVELOPMENT</div><h1>코드와 업무를 연결하세요</h1><p>GitLab 활동과 자동화, 외부 도구로 보내는 알림을 관리합니다.</p></div>
    <div className="development-heading-actions">
      <button className="btn" type="button" onClick={focusConnectionSettings}>연결 설정으로 이동</button>
      <button className="btn btn-primary" type="button" disabled={busy||!settings?.baseUrl||!settings.projectIds.length} onClick={() => void sync()}><GitBranch size={16}/>{busy?'처리 중…':'지금 동기화'}</button>
    </div></div>
    {error&&<div className="inline-error" role="alert">{error} 작성 내용은 유지됩니다.</div>}
    <DevelopmentActivityFeed key={props.projectId} {...props} statusBusy={busy} refreshingLinkId={refreshingLinkId}
      checkedActivity={checkedActivity?.context === activityContext ? checkedActivity.link : null} checkedActivityButton={checkedActivityButton}
      onCheckActivityStatus={checkActivityStatus} />
    <div className="integration-grid"><form ref={connectionForm} className="card integration-form" onSubmit={save}><div className="card-heading"><h2 tabIndex={-1}><GitBranch size={19}/>GitLab 연결</h2><button type="button" className="btn btn-ghost" disabled={busy} onClick={reload}><RefreshCw size={14}/>최신 설정</button></div><fieldset disabled={busy||!settings} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <label className="form-label">GitLab 주소<input type="url" className="field" placeholder="https://gitlab.example.com" value={draft.baseUrl} onChange={e=>edit('baseUrl',e.target.value)}/></label>
      {missingRoutesAfterAddressEdit && <p className="help-text gitlab-token-note" role="status">주소가 바뀌어 Jira 원본 연결 범위를 비웠습니다. 새 저장소에서 사용할 범위를 선택하세요.</p>}
      <label className="form-label">읽기 API 토큰<input type="password" autoComplete="new-password" className="field" placeholder={retainsToken?'저장된 토큰 유지 · 변경할 때만 입력':'선택 · read_api 권한의 토큰'} value={draft.token} onChange={e=>edit('token',e.target.value)}/></label>
      {settings?.tokenConfigured && !retainsToken && !draft.token && <p className="help-text gitlab-token-note">새 주소에서 인증하려면 읽기 토큰을 입력하세요. 빈칸으로 저장하면 기존 읽기 토큰이 지워집니다.</p>}
      {settings && <GitlabRepositoryPicker key={`${settings.version}:${repositorySearchRevision}`} baseUrl={draft.baseUrl}
        token={draft.token} settingsVersion={settings.version} selectedIds={repositoryIds} maxRepositories={maxGitlabRepositories} onAdd={addRepository} />}
      <label className="form-label">GitLab 프로젝트 ID<input className="field" placeholder="예: 12, 34" value={draft.ids} onChange={e=>edit('ids',e.target.value)}/><span className="help-text">저장소를 선택하거나 숫자 ID를 직접 입력하세요.</span></label>
      {repositoryIds.length > 0 && <JiraRouteSettings repositoryIds={repositoryIds} routes={draft.jiraRoutes} sources={jiraSources}
        projects={props.data.projects} onRetry={() => void loadJiraSources()} onChange={updateJiraRoute} />}
      <label className="form-label">웹훅 Secret Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.webhookSecretConfigured?'저장된 비밀값 유지':'웹훅 인증에 사용할 비밀값'} value={draft.secret} onChange={e=>edit('secret',e.target.value)}/></label>
      <label className="form-label">웹훅 Signing Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.signingTokenConfigured?'저장된 서명 키 유지':'선택 · GitLab에서 발급한 whsec_ 서명 키'} value={draft.signingToken} onChange={e=>edit('signingToken',e.target.value)}/><span className="help-text">GitLab에서 제공하는 인증 방식에 맞춰 Secret Token 또는 Signing Token을 설정하세요.</span></label>
      <div className="gitlab-history-option">
        <label><input type="checkbox" checked={includeHistory} aria-describedby="gitlab-history-help" onChange={event => { clearPreview(); setIncludeHistory(event.target.checked); }} />기존 브랜치·커밋 포함</label>
        <p className="help-text" id="gitlab-history-help">미리보기와 지금 동기화에 적용합니다. 저장소별로 브랜치 최대 500개와 최근 커밋 최대 100개를 읽습니다.</p>
      </div>
      <div className="data-actions"><button className="btn btn-primary" disabled={!dirty}>연결 설정 저장</button><button type="button" className="btn" disabled={!draft.baseUrl.trim() || !draft.ids.trim() || preview?.state === 'loading'} onClick={() => void requestPreview()}><Search size={15} aria-hidden="true"/>연결 미리보기</button>{(settings?.tokenConfigured||settings?.webhookSecretConfigured||settings?.signingTokenConfigured)&&<button className="btn btn-ghost" type="button" onClick={disconnect}>연결 해제</button>}</div>
      {settings && <GitlabDeploymentPreview actorId={props.actorId} settingsVersion={settings.version} draftRevision={deploymentPreviewRevision}
        baseUrl={draft.baseUrl} token={draft.token} projectIds={repositoryIds} />}
    </fieldset>{legacySyncFallback&&settings?.lastSyncAt&&<p className="help-text">마지막 동기화: {new Date(settings.lastSyncAt).toLocaleString('ko-KR')}</p>}{legacySyncFallback&&settings?.lastError&&<p className="error-text">{settings.lastError}</p>}
    </form>
    {preview && <GitlabPreview preview={preview} projects={props.data.projects} openIssue={props.openIssue}/>}
    {settings?.baseUrl && settings.projectIds.length > 0 && <GitlabSyncReport read={currentSyncRead} busy={busy}
      onReload={() => void readSyncStatus(settings.version)} onRetry={options => void sync(options)} />}
    {settings && <GitlabProjectWebhookPanel key={`project-webhook:${props.actorId}:${settings.version}:${settings.webhookReceiverUrl ?? ''}`} settings={settings} />}
    {settings && <GitlabWebhookStatusPanel key={settings.version} settings={settings} />}
    <section className="card integration-guide"><div className="gitlab-symbol"><GitBranch size={35}/></div><h2>티켓 번호로 자연스럽게 연결</h2><p>브랜치 이름이나 커밋 메시지, MR 제목에 티켓 번호를 넣으세요.</p><code>feature/{props.data.projects.find(project=>project.id===props.projectId)?.key||'TEAM'}-12-login</code><ul><li>GitLab 웹훅에서 Push events를 켜면 MR을 열기 전에도 새 브랜치와 커밋을 티켓에서 확인할 수 있습니다.</li><li>티켓 상태 변경은 MR·파이프라인 이벤트에 연결한 활성화 규칙으로 처리합니다.</li><li>지금 동기화는 저장한 연결 설정을 사용합니다. 기존 브랜치·커밋을 포함하면 웹훅 설정 전의 활동도 찾을 수 있습니다.</li></ul></section></div>
    {settings && <RepositoryGitlabDeployments settings={settings} syncStatus={syncStatus} view={props.deploymentView} onChangeView={props.onChangeDeploymentView}
      onSyncSettled={() => readSyncStatus(settings.version)} />}
    <AutomationSettings {...props}/><WebhookSettings {...props}/>
  </div>;
}

function DevelopmentActivityFeed({ data, projectId, actorId, openIssue, refresh, notify, activityFilters, onChangeActivityFilters, onOpenIssueForReview,
  statusBusy, refreshingLinkId, checkedActivity, checkedActivityButton, onCheckActivityStatus }: Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'openIssue' | 'refresh' | 'notify'> & DevelopmentActivityProps & {
    statusBusy: boolean;
    refreshingLinkId: string | null;
    checkedActivity: GitlabLink | null;
    checkedActivityButton: RefObject<HTMLButtonElement | null>;
    onCheckActivityStatus: (link: GitlabLink, trigger: HTMLButtonElement, fallback: HTMLElement | null) => void;
  }) {
  const { scope, query, memberId, repositoryKey, pages } = activityFilters;
  const heading = useRef<HTMLHeadingElement>(null);
  const [search, setSearch] = useState({ source: query, value: query, invalid: false });
  if (search.source !== query) setSearch({ source: query, value: query, invalid: false });
  const projectIssues = useMemo(() => data.issues.filter(issue => issue.projectId === projectId), [data.issues, projectId]);
  const issueKeys = useMemo(() => new Map(projectIssues.map(issue => [issue.id, issue.key])), [projectIssues]);
  const issueVersions = useMemo(() => new Map(projectIssues.map(issue => [issue.id, issue.version])), [projectIssues]);
  const links = useMemo(() => data.gitlabLinks.filter(link => issueKeys.has(link.issueId)), [data.gitlabLinks, issueKeys]);
  const followUp = useGitlabFollowUp({ data, projectId, actorId, openIssue, refresh, notify }, links, statusBusy, heading);
  const repositories = useMemo(() => gitlabActivityRepositories(links), [links]);
  const unavailableRepository = repositoryKey && !repositories.some(repository => repository.key === repositoryKey);
  const matching = useMemo(() => filterGitlabActivityLinks({ issues: projectIssues, issueAliases: data.issueAliases }, links,
    { scope, query, memberId, repositoryKey, pages: {} }), [data.issueAliases, projectIssues, links, scope, query, memberId, repositoryKey]);
  const checkedLink = checkedActivity && links.find(link => link.id === checkedActivity.id && link.issueId === checkedActivity.issueId &&
    link.projectId === checkedActivity.projectId && link.kind === checkedActivity.kind && link.iid === checkedActivity.iid &&
    link.manualLinkId === checkedActivity.manualLinkId);
  const filteredCheckedLink = checkedLink && !matching.includes(checkedLink) ? checkedLink : null;
  const hasFilters = scope !== 'all' || Boolean(query || memberId || repositoryKey || search.value || Object.keys(pages).length);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = normalizeGitlabActivityQuery(search.value);
    if (search.value.trim() && !nextQuery) {
      setSearch({ ...search, invalid: true });
      return;
    }
    setSearch({ source: query, value: nextQuery, invalid: false });
    onChangeActivityFilters({ ...activityFilters, query: nextQuery, pages: {} }, 'replace');
  }
  function changePage(kind: GitlabLink['kind'], page: number) {
    const next = { ...pages };
    if (page === 1) delete next[kind];
    else next[kind] = page;
    onChangeActivityFilters({ ...activityFilters, pages: next }, 'push');
  }
  function clearFilters() {
    setSearch({ source: query, value: '', invalid: false });
    onChangeActivityFilters(DEFAULT_GITLAB_ACTIVITY_FILTERS, 'push');
  }
  function openCheckedActivity({ id, issueId, projectId, kind, iid, manualLinkId }: GitlabLink, opener: HTMLButtonElement) {
    onOpenIssueForReview(issueId, { issueIds: [issueId], opener, fallback: heading.current,
      gitlabActivity: { link: { id, issueId, projectId, kind, iid, manualLinkId }, selectActivity: true } });
  }

  return <section className="card linked-development" aria-label="연결된 개발 활동">
    <div className="card-heading gitlab-activity-header">
      <h2 ref={heading} tabIndex={-1}>연결된 개발 활동 <span className="count-pill">{matching.length}</span></h2>
      <GitlabActivityRefresh refresh={refresh} notify={notify} disabled={statusBusy} />
    </div>
    <div className="development-activity-filters">
      <label className="form-label development-activity-scope">개발 활동 범위
        <select className="field" value={scope} onChange={event => {
          const nextScope = GITLAB_ACTIVITY_SCOPES.find(value => value === event.currentTarget.value);
          if (nextScope) onChangeActivityFilters({ ...activityFilters, scope: nextScope, pages: {} }, 'push');
        }}>
          {GITLAB_ACTIVITY_SCOPES.map(value => <option key={value} value={value}>{GITLAB_ACTIVITY_SCOPE_LABELS[value]}</option>)}
        </select>
      </label>
      {(repositories.length > 0 || repositoryKey) && <label className="form-label development-activity-repository">저장소
        <select className="field" aria-label="GitLab 활동 저장소" value={repositoryKey ?? ''} onChange={event =>
          onChangeActivityFilters({ ...activityFilters, repositoryKey: event.currentTarget.value || undefined, pages: {} }, 'push')}>
          <option value="">전체 저장소</option>
          {unavailableRepository && <option disabled value={repositoryKey}>연결된 활동을 찾을 수 없는 저장소</option>}
          {repositories.map(repository => <option key={repository.key} value={repository.key}>{repository.label}</option>)}
        </select>
      </label>}
      <label className="form-label development-activity-member">팀원
        <select className="field" aria-label="GitLab 활동 팀원" value={memberId ?? ''} onChange={event =>
          onChangeActivityFilters({ ...activityFilters, memberId: event.currentTarget.value || undefined, pages: {} }, 'push')}>
          <option value="">전체 팀원</option>
          {data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select>
      </label>
      <form className="development-activity-search" onSubmit={submitSearch}>
        <label className="form-label">개발 활동 검색
          <input type="search" className="field" value={search.value} maxLength={GITLAB_ACTIVITY_QUERY_LIMIT}
            placeholder="티켓 키, 제목, 저장소 또는 GitLab 주소" aria-invalid={search.invalid || undefined}
            onChange={event => setSearch({ source: query, value: event.currentTarget.value, invalid: false })} />
        </label>
        <button type="submit" className="btn"><Search size={15} aria-hidden="true" />검색</button>
        {search.invalid && <p role="alert">GitLab 활동 주소 또는 검색어를 확인해 주세요.</p>}
      </form>
      <button type="button" className="btn btn-ghost" disabled={!hasFilters} onClick={clearFilters}>활동 필터 초기화</button>
    </div>
    {filteredCheckedLink && <section className="gitlab-activity-feedback" aria-label="확인한 GitLab 활동" data-gitlab-link-id={filteredCheckedLink.id}>
      <p className="gitlab-activity-hint" role="status">
        <strong>{gitlabActivityKindLabel(filteredCheckedLink.kind)} {filteredCheckedLink.kind === 'pipeline' ? `#${filteredCheckedLink.iid}` :
          filteredCheckedLink.kind === 'merge_request' ? `!${filteredCheckedLink.iid}` : filteredCheckedLink.title} · {gitlabActivityStateLabel(filteredCheckedLink.state)}</strong>
        {' '}현재 필터 범위를 벗어났습니다.
      </p>
      <div className="gitlab-activity-actions">
        <button ref={checkedActivityButton} className="btn" type="button" data-gitlab-review-opener="activity"
          onClick={event => openCheckedActivity(filteredCheckedLink, event.currentTarget)}>
          <ArrowRight size={14} aria-hidden="true" />티켓에서 이 활동 보기
        </button>
      </div>
    </section>}
    {followUp.content}
    {matching.length > 0 ? <GitlabActivityList links={matching} heading="h3" issueVersions={issueVersions} followUpActions={followUp.actions}
      issueReview={{ keys: issueKeys, openIssue: onOpenIssueForReview, fallbackRef: heading }} pagination={{ pages, onChangePage: changePage }}
      statusActions={{ disabled: statusBusy, refreshingLinkId, checkStatus: (link, trigger) => onCheckActivityStatus(link, trigger, heading.current) }} />
      : unavailableRepository ? <p className="development-activity-empty" role="status">이 프로젝트에 선택한 저장소의 개발 활동이 없습니다.</p>
        : links.length > 0 ? <p className="development-activity-empty" role="status">조건에 맞는 개발 활동이 없습니다.</p>
        : <div className="empty-state"><GitBranch aria-hidden="true" /><h3>아직 연결된 개발 활동이 없습니다</h3>
          <p>GitLab을 연결한 뒤 티켓 번호가 들어간 브랜치를 푸시하거나 지금 동기화를 실행하세요.</p></div>}
  </section>;
}

function JiraRouteSettings({ repositoryIds, routes, sources, projects, onRetry, onChange }: {
  repositoryIds: number[];
  routes: GitlabJiraRoute[];
  sources: JiraSources;
  projects: Project[];
  onRetry: () => void;
  onChange: (repositoryId: number, projectId: string, jiraInstanceKey?: string) => void;
}) {
  const instancesByProject = new Map<string, Set<string>>();
  for (const source of sources.items) {
    const instances = instancesByProject.get(source.projectId) ?? new Set<string>();
    instances.add(source.jiraInstanceKey);
    instancesByProject.set(source.projectId, instances);
  }
  const available = projects.filter(project => instancesByProject.has(project.id));
  const routesByRepo = new Map(routes.map(route => [route.repositoryId, route]));
  return <section className="gitlab-jira-routes" aria-label="저장소별 Jira 원본 키 연결">
    <h3>저장소별 Jira 원본 키 연결</h3>
    <p className="help-text">프로젝트와 Jira 원본 인스턴스를 선택하면 해당 프로젝트의 현재 티켓 키와 이관한 Jira 키를 함께 찾습니다.</p>
    {sources.loading && <p role="status" className="help-text">이관한 Jira 원본을 불러오는 중입니다.</p>}
    {sources.error && <div className="gitlab-jira-route-error">
      <p className="error-text" role="alert">{sources.error}</p>
      <button className="btn btn-ghost" type="button" onClick={onRetry}>Jira 원본 다시 불러오기</button>
    </div>}
    {!sources.loading && !sources.error && available.length === 0 && <p className="help-text">이관한 Jira 원본이 있는 프로젝트가 없습니다.</p>}
    {(available.length > 0 || repositoryIds.some(id => routesByRepo.has(id))) && <div className="gitlab-jira-route-list">
      {repositoryIds.map(repositoryId => {
        const route = routesByRepo.get(repositoryId);
        const projectId = route?.projectId ?? '';
        const instance = route?.jiraInstanceKey ?? '';
        const options = [...(instancesByProject.get(projectId) ?? [])];
        const missingProject = projectId && !available.some(project => project.id === projectId);
        const missingInstance = instance && !options.includes(instance);
        const fallback = sources.loading || sources.error ? '목록 미확인' : '선택할 수 없음';
        return <div key={repositoryId} className="gitlab-jira-route" role="group" aria-label={`저장소 ${repositoryId} Jira 키 설정`}>
          <strong>저장소 {repositoryId}</strong>
          <label className="form-label">대상 Teamspace 프로젝트
            <select className="field" aria-label={`저장소 ${repositoryId} Teamspace 프로젝트`} data-gitlab-project-repo={repositoryId} value={projectId}
              onChange={event => onChange(repositoryId, event.target.value)}>
              <option value="">현재 티켓 키만 사용</option>
              {missingProject && <option disabled value={projectId}>{projects.find(project => project.id === projectId)?.name ?? projectId} ({fallback})</option>}
              {available.map(project => <option value={project.id} key={project.id}>{project.key} · {project.name}</option>)}
            </select>
          </label>
          <label className="form-label">Jira 원본 인스턴스
            <select className="field" aria-label={`저장소 ${repositoryId} Jira 원본 인스턴스`} data-gitlab-source-repo={repositoryId} value={instance}
              required={Boolean(projectId)} disabled={!projectId || options.length === 0}
              onChange={event => onChange(repositoryId, projectId, event.target.value)}>
              <option value="">원본 인스턴스 선택</option>
              {missingInstance && <option disabled value={instance}>{instance} ({fallback})</option>}
              {options.map(value => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
        </div>;
      })}
    </div>}
  </section>;
}

const candidateAction = { create: '신규 연결', update: '갱신', unchanged: '유지' } as const;
const candidateKind = { merge_request: 'MR', pipeline: '파이프라인', branch: '브랜치', commit: '커밋' } as const;
const readStage = { project: '저장소 정보', 'merge-requests': 'MR', pipelines: '파이프라인', branches: '브랜치', commits: '커밋', save: '결과 저장' } as const;
const repositoryReadHints: Partial<Record<number, string>> = {
  401: '저장한 읽기 API 토큰이 유효한지 확인하세요.',
  403: '읽기 API 토큰에 이 저장소를 조회할 권한이 있는지 확인하세요.',
  404: '저장소 ID와 읽기 API 토큰의 접근 권한을 확인하세요.',
  429: 'GitLab 요청 제한이 풀린 뒤 다시 시도하세요.',
};

function RepositoryReadError({ error }: Pick<GitlabSyncRepositoryFailure, 'error'>) {
  const hint = error.httpStatus === null ? undefined : repositoryReadHints[error.httpStatus];
  return <>
    <p className="error-text">{error.message}</p>
    {hint && <p className="help-text">{hint}</p>}
  </>;
}

function RepositoryCounts({ counts }: { counts: GitlabSyncPreviewCounts }) {
  return <>
    <p>MR {counts.mergeRequests}개 · 파이프라인 {counts.pipelines}개
      {counts.branches !== undefined && ` · 브랜치 ${counts.branches}개`}
      {counts.commits !== undefined && ` · 커밋 ${counts.commits}개`}</p>
    <p>신규 연결 {counts.create}개 · 갱신 {counts.update}개 · 유지 {counts.unchanged}개</p>
  </>;
}

function GitlabSyncReport({ read, busy, onReload, onRetry }: {
  read: SyncStatusRead | null;
  busy: boolean;
  onReload: () => void;
  onRetry: (options: SyncRetry) => void;
}) {
  const repositories = read?.status?.repositories ?? [];
  const failed = repositories.flatMap(({ repositoryId, activity }) => activity?.result.status === 'error'
    ? [{ repositoryId, includeHistory: activity.includeHistory }] : []);
  const completed = repositories.filter(repository => repository.activity?.result.status === 'ok');
  const history = completed.filter(repository => repository.activity?.includeHistory);
  const branches = history.reduce((total, repository) => total + (repository.activity?.result.counts.branches ?? 0), 0);
  const commits = history.reduce((total, repository) => total + (repository.activity?.result.counts.commits ?? 0), 0);
  const untried = repositories.length - completed.length - failed.length;
  const retryMode = failed[0]?.includeHistory;
  const aggregateRetry = retryMode !== undefined && failed.every(repository => repository.includeHistory === retryMode);
  const disabled = busy || Boolean(read?.loading);
  return <section className="card gitlab-sync-result" aria-labelledby="gitlab-sync-result-title">
    <div className="card-heading gitlab-sync-result-heading">
      <h2 id="gitlab-sync-result-title">GitLab 동기화 결과</h2>
      <div className="gitlab-sync-result-actions">
        <button className="btn" type="button" disabled={disabled} onClick={onReload}>
          <RefreshCw size={15} aria-hidden="true" />동기화 결과 새로고침
        </button>
        {aggregateRetry && <button className="btn" type="button" disabled={disabled}
          onClick={() => onRetry({ repositoryIds: failed.map(repository => repository.repositoryId), includeHistory: retryMode })}>
          <RefreshCw size={15} aria-hidden="true" />실패한 저장소 다시 시도
        </button>}
      </div>
    </div>
    {read?.error && <p className="error-text" role="alert">{read.error}</p>}
    {read?.loading && !read.status && <p role="status">동기화 결과를 불러오는 중입니다.</p>}
    {read?.status && <p role="status">저장소 {completed.length}곳 동기화 완료 · {failed.length}곳 실패{untried > 0 && ` · ${untried}곳 기록 없음`}</p>}
    {history.length > 0 && <div className="gitlab-history-result" role="status" aria-label="기존 개발 이력 동기화 결과">
      <p>브랜치 {branches}개 · 커밋 {commits}개 조회</p>
    </div>}
    {repositories.length > 0 && <ul className="gitlab-preview-repositories" aria-label="저장소별 동기화 결과">
      {repositories.map(({ repositoryId, activity }) => {
        const result = activity?.result;
        return <li key={repositoryId}>
          <section aria-label={`저장소 ${repositoryId}`}>
            <h3>저장소 {repositoryId} <span className={`badge ${result ? `gitlab-preview-${result.status}` : 'gitlab-webhook-waiting'}`}>
              {result?.status === 'ok' ? '동기화 완료' : result?.status === 'error'
                ? result.error.stage === 'save' ? '결과 저장 실패' : `${readStage[result.error.stage]} 조회 실패`
                : '동기화 기록 없음'}
            </span></h3>
            {activity && <div className="gitlab-sync-result-meta">
              <p>최근 시도 <time dateTime={activity.completedAt}>{new Date(activity.completedAt).toLocaleString('ko-KR')}</time></p>
              <p>마지막 성공 {activity.lastSuccessfulAt
                ? <time dateTime={activity.lastSuccessfulAt}>{new Date(activity.lastSuccessfulAt).toLocaleString('ko-KR')}</time>
                : '기록 없음'}</p>
              <p>{activity.includeHistory ? '브랜치·커밋 포함' : 'MR·파이프라인'}</p>
            </div>}
            {result?.status === 'error' && <>
              <RepositoryReadError error={result.error} />
              {!aggregateRetry && activity && <button className="btn btn-ghost gitlab-sync-row-retry" type="button" disabled={disabled}
                onClick={() => onRetry({ repositoryIds: [repositoryId], includeHistory: activity.includeHistory })}>
                <RefreshCw size={14} aria-hidden="true" />저장소 {repositoryId} 다시 시도
              </button>}
            </>}
            {result?.status === 'ok' && <>
              <RepositoryCounts counts={result.counts} />
              <ActivityCoverageNote coverage={result.coverage} />
              <HistoryLimitNote limits={result.historyLimits} />
            </>}
          </section>
        </li>;
      })}
    </ul>}
  </section>;
}

function GitlabPreview({ preview, projects, openIssue }: { preview: PreviewState; projects: Project[]; openIssue: FeatureProps['openIssue'] }) {
  return <section className="card gitlab-preview" aria-labelledby="gitlab-preview-title">
    <div className="card-heading"><h2 id="gitlab-preview-title"><Search size={18} aria-hidden="true"/>GitLab 연결 미리보기</h2></div>
    {preview.state === 'loading' && <p role="status">입력한 설정으로 GitLab 저장소를 조회하는 중입니다.</p>}
    {preview.state === 'failed' && <p className="inline-error" role="alert">{preview.error} 작성 내용은 유지됩니다.</p>}
    {preview.state === 'ready' && <>
      <p>현재 입력값으로 조회한 결과입니다. 지금 동기화는 저장한 설정을 사용해 조회를 마친 저장소의 연결을 저장합니다.</p>
      <div className="gitlab-preview-summary" aria-label="미리보기 집계">
        <span>조회 MR <strong>{preview.result.counts.mergeRequests}</strong></span>
        <span>조회 파이프라인 <strong>{preview.result.counts.pipelines}</strong></span>
        {preview.result.counts.branches !== undefined && <span>조회 브랜치 <strong>{preview.result.counts.branches}</strong></span>}
        {preview.result.counts.commits !== undefined && <span>조회 커밋 <strong>{preview.result.counts.commits}</strong></span>}
        <span>연결 후보가 있는 항목 <strong>{preview.result.counts.matched}</strong></span>
        <span>일치 티켓 없음 <strong>{preview.result.counts.unmatched}</strong></span>
        <span>조회 결과에서 건너뜀 <strong>{preview.result.counts.skipped}</strong></span>
      </div>
      <ul className="gitlab-preview-repositories" aria-label="저장소별 조회 결과">
        {preview.result.repositories.map(repository => {
          const route = preview.jiraRoutes.find(item => item.repositoryId === repository.projectId);
          const ambiguousKeys = repository.status === 'ok' ? repository.ambiguousKeys ?? [] : [];
          return <li key={repository.projectId}>
            <section aria-label={`저장소 ${repository.projectId}`}>
              <h3>저장소 {repository.projectId} <span className={`badge gitlab-preview-${repository.status}`}>{repository.error ? `${readStage[repository.error.stage]} 조회 실패` : '조회 가능'}</span></h3>
              {route && <p className="help-text">연결 범위 {projects.find(project => project.id === route.projectId)?.name ?? route.projectId} · Jira 원본 {route.jiraInstanceKey}</p>}
              {repository.error ? <RepositoryReadError error={repository.error} /> : <>
                  <RepositoryCounts counts={repository.counts} />
                  <ActivityCoverageNote coverage={repository.coverage} />
                  {ambiguousKeys.length > 0 && <div className="gitlab-preview-ambiguity">
                    <p>여러 티켓과 일치한 키</p>
                    <ul aria-label="연결이 보류된 키">{ambiguousKeys.map(key => <li key={key}><code>{key}</code></li>)}</ul>
                  </div>}
                  <HistoryLimitNote limits={repository.historyLimits} />
                </>}
            </section>
          </li>;
        })}
      </ul>
      <section className="gitlab-preview-candidates" aria-labelledby="gitlab-preview-candidates-title">
        <h3 id="gitlab-preview-candidates-title">티켓 연결 후보</h3>
        {preview.result.candidates.length ? <ul>
          {preview.result.candidates.map(candidate => <li key={`${candidate.projectId}:${candidate.kind}:${candidate.objectId}:${candidate.issueId}`}>
            <div><small>저장소 {candidate.projectId} · {candidateKind[candidate.kind]} · {candidate.state}</small><strong>{candidate.title}</strong>
              {candidate.originalJiraKey && <small>원본 Jira 키 <code>{candidate.originalJiraKey}</code></small>}
            </div>
            <div className="gitlab-preview-target"><span className="badge">{candidateAction[candidate.action]}</span><button type="button" className="text-link" aria-label={`업무 ${candidate.issueKey} 열기`} onClick={() => openIssue(candidate.issueId)}>{candidate.issueKey} · {candidate.issueTitle}</button></div>
          </li>)}
        </ul> : <p>조회한 항목에서 티켓 연결 후보를 찾지 못했습니다.</p>}
        {preview.result.candidatesTruncated && <p className="help-text">연결 후보 중 {preview.result.candidates.length}개를 표시합니다.</p>}
      </section>
    </>}
  </section>;
}
