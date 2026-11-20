'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { GitBranch, RefreshCw, Search } from 'lucide-react';
import type { FeatureProps, GitlabHistoryLimits, GitlabSettings, GitlabSyncPreview, GitlabSyncResult } from '../../shared/types';
import { api, patch, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { AutomationSettings } from './AutomationSettings';
import { GitlabActivityList, GitlabActivityRefresh } from './GitlabActivity';
import { WebhookSettings } from './WebhookSettings';
import './development.css';

type Draft={baseUrl:string;ids:string;token:string;secret:string;signingToken:string};
const empty:Draft={baseUrl:'',ids:'',token:'',secret:'',signingToken:''};
const draftOf=(settings:GitlabSettings):Draft=>({...empty,baseUrl:settings.baseUrl,ids:settings.projectIds.join(', ')});
type PreviewState = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; result: GitlabSyncPreview };
function HistoryLimitNote({ limits }: { limits?: GitlabHistoryLimits }) {
  const capped = [limits?.branches && '브랜치 500개', limits?.commits && '커밋 100개'].filter(Boolean);
  return capped.length > 0 && <p className="help-text gitlab-history-limits">{capped.join(' · ')} 조회 한도에 도달했습니다.</p>;
}

function readProjectIds(input: string): number[] {
  const projectIds = input.split(',').map(value => value.trim()).filter(Boolean).map(Number);
  if (projectIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('프로젝트 ID는 쉼표로 구분된 양의 정수로 입력해 주세요.');
  return projectIds;
}

function normalizedAddress(input: string): string | null {
  if (!input.trim()) return '';
  try { return new URL(input.trim()).toString().replace(/\/+$/, ''); }
  catch { return null; }
}

export function Development(props:FeatureProps){
  const {notify}=props;
  const [settings,setSettings]=useState<GitlabSettings|null>(null),[draft,setDraft]=useState< Draft>(empty),[baseline,setBaseline]=useState< Draft>(empty);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [historyResult, setHistoryResult] = useState<Pick<GitlabSyncResult, 'historyCounts' | 'historyLimits'> | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const pending=useRef(false),dirtyRef=useRef(false),alive=useRef(true);
  const dirty=JSON.stringify(draft)!==JSON.stringify(baseline);
  const retainsToken = settings?.tokenConfigured && normalizedAddress(draft.baseUrl) === settings.baseUrl;
  useEffect(()=>{dirtyRef.current=dirty;},[dirty]);
  const clearPreview = useCallback(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreview(null);
  }, []);
  const accept=useCallback((value:GitlabSettings)=>{clearPreview();setHistoryResult(null);setSettings(value);const next=draftOf(value);setDraft(next);setBaseline(next);dirtyRef.current=false;setError('');},[clearPreview]);
  useEffect(()=>{alive.current=true;let cancelled=false;void api<GitlabSettings>('/integrations/gitlab').then(value=>{if(!cancelled)accept(value);}).catch(e=>{if(!cancelled)setError((e as Error).message);});return()=>{cancelled=true;alive.current=false;previewRequest.current?.abort();previewRequest.current=null;};},[accept]);
  useEffect(()=>{
    const guard=(event:Event)=>{if(event.defaultPrevented)return;if(pending.current){event.preventDefault();notify('GitLab 요청이 끝난 뒤 이동해 주세요.','error');}else if(dirtyRef.current){if(!window.confirm('저장하지 않은 GitLab 설정을 버리고 이동할까요?'))event.preventDefault();else afterAcceptedNavigation(event,()=>{clearPreview();setDraft(baseline);dirtyRef.current=false;setError('');});}};
    const unload=(event:BeforeUnloadEvent)=>{if(pending.current||dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('teamspace:navigate',guard);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('teamspace:navigate',guard);window.removeEventListener('beforeunload',unload);};
  },[baseline,clearPreview,notify]);
  function edit<K extends keyof Draft>(key:K,value:Draft[K]){clearPreview();setDraft(previous=>({...previous,[key]:value}));}
  async function execute(action:()=>Promise<void>){if(pending.current)return;clearPreview();pending.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError((e as Error).message);}finally{pending.current=false;if(alive.current)setBusy(false);}}
  async function reload(){if(dirtyRef.current&&!window.confirm('작성 중인 GitLab 설정을 버리고 최신 설정을 불러올까요?'))return;await execute(async()=>accept(await api<GitlabSettings>('/integrations/gitlab')));}
  async function save(event:FormEvent){event.preventDefault();if(!settings)return;await execute(async()=>{
    const projectIds=readProjectIds(draft.ids);
    const saved=await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,baseUrl:draft.baseUrl,projectIds,...(draft.token?{token:draft.token}:{}),...(draft.secret?{webhookSecret:draft.secret}:{}),...(draft.signingToken?{signingToken:draft.signingToken}:{})});accept(saved);window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 연결 설정을 저장했습니다.');
  });}
  async function disconnect(){if(!settings||!window.confirm('GitLab 자격 증명을 삭제하고 상태 자동화를 비활성화할까요? 입력 중인 연결 설정도 초기화합니다. 기존 개발 활동 기록은 유지됩니다.'))return;await execute(async()=>{accept(await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,token:'',webhookSecret:'',signingToken:''}));window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 자격 증명을 삭제했습니다.');});}
  async function sync(){await execute(async()=>{
    setHistoryResult(null);
    const result = await post<GitlabSyncResult>('/integrations/gitlab/sync', includeHistory ? { includeHistory: true } : {});
    setSettings(result.settings);
    if (result.historyCounts) setHistoryResult({ historyCounts: result.historyCounts, historyLimits: result.historyLimits });
    await props.refresh();
    props.notify(`GitLab 동기화를 완료했습니다. ${result.linked}개 연결`);
  });}
  async function requestPreview() {
    if (!settings || pending.current || previewRequest.current) return;
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreview({ state: 'loading' });
    try {
      const projectIds = readProjectIds(draft.ids);
      const result = await api<GitlabSyncPreview>('/integrations/gitlab/sync-preview', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ expectedVersion: settings.version, baseUrl: draft.baseUrl, projectIds, ...(draft.token ? { token: draft.token } : {}), ...(includeHistory ? { includeHistory: true } : {}) }),
      });
      if (previewRequest.current === controller) setPreview({ state: 'ready', result });
    } catch (cause) {
      if (previewRequest.current === controller) setPreview({ state: 'failed', error: cause instanceof Error ? cause.message : 'GitLab 조회에 실패했습니다.' });
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
    }
  }
  const issueKeys = new Map(props.data.issues.filter(issue => issue.projectId === props.projectId).map(issue => [issue.id, issue.key]));
  const links = props.data.gitlabLinks.filter(link => issueKeys.has(link.issueId));
  return <div className="page development-page"><div className="page-heading"><div><div className="eyebrow">DEVELOPMENT</div><h1>코드와 업무를 연결하세요</h1><p>GitLab 활동과 자동화, 외부 도구로 보내는 알림을 관리합니다.</p></div><button className="btn btn-primary" disabled={busy||!settings?.baseUrl||!settings.projectIds.length} onClick={sync}><GitBranch size={16}/>{busy?'처리 중…':'지금 동기화'}</button></div>
    {error&&<div className="inline-error" role="alert">{error} 작성 내용은 유지됩니다.</div>}
    <div className="integration-grid"><form className="card integration-form" onSubmit={save}><div className="card-heading"><h2><GitBranch size={19}/>GitLab 연결</h2><button type="button" className="btn btn-ghost" disabled={busy} onClick={reload}><RefreshCw size={14}/>최신 설정</button></div><fieldset disabled={busy||!settings} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <label className="form-label">GitLab 주소<input type="url" className="field" placeholder="https://gitlab.example.com" value={draft.baseUrl} onChange={e=>edit('baseUrl',e.target.value)}/></label>
      <label className="form-label">GitLab 프로젝트 ID<input className="field" placeholder="예: 12, 34" value={draft.ids} onChange={e=>edit('ids',e.target.value)}/><span className="help-text">GitLab 프로젝트 설정의 숫자 ID를 입력하세요.</span></label>
      <label className="form-label">읽기 API 토큰<input type="password" autoComplete="new-password" className="field" placeholder={retainsToken?'저장된 토큰 유지 · 변경할 때만 입력':'선택 · read_api 권한의 토큰'} value={draft.token} onChange={e=>edit('token',e.target.value)}/></label>
      {settings?.tokenConfigured && !retainsToken && !draft.token && <p className="help-text gitlab-token-note">새 주소에서 인증하려면 읽기 토큰을 입력하세요. 빈칸으로 저장하면 기존 읽기 토큰이 지워집니다.</p>}
      <label className="form-label">웹훅 Secret Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.webhookSecretConfigured?'저장된 비밀값 유지':'웹훅 인증에 사용할 비밀값'} value={draft.secret} onChange={e=>edit('secret',e.target.value)}/></label>
      <label className="form-label">웹훅 Signing Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.signingTokenConfigured?'저장된 서명 키 유지':'선택 · GitLab에서 발급한 whsec_ 서명 키'} value={draft.signingToken} onChange={e=>edit('signingToken',e.target.value)}/><span className="help-text">GitLab에서 제공하는 인증 방식에 맞춰 Secret Token 또는 Signing Token을 설정하세요.</span></label>
      <div className="gitlab-history-option">
        <label><input type="checkbox" checked={includeHistory} aria-describedby="gitlab-history-help" onChange={event => { clearPreview(); setIncludeHistory(event.target.checked); }} />기존 브랜치·커밋 포함</label>
        <p className="help-text" id="gitlab-history-help">미리보기와 지금 동기화에 적용합니다. 저장소별로 브랜치 최대 500개와 최근 커밋 최대 100개를 읽습니다.</p>
      </div>
      <div className="data-actions"><button className="btn btn-primary" disabled={!dirty}>연결 설정 저장</button><button type="button" className="btn" disabled={!draft.baseUrl.trim() || !draft.ids.trim() || preview?.state === 'loading'} onClick={() => void requestPreview()}><Search size={15} aria-hidden="true"/>연결 미리보기</button>{(settings?.tokenConfigured||settings?.webhookSecretConfigured||settings?.signingTokenConfigured)&&<button className="btn btn-ghost" type="button" onClick={disconnect}>연결 해제</button>}</div>
    </fieldset>{settings?.lastSyncAt&&<p className="help-text">마지막 동기화: {new Date(settings.lastSyncAt).toLocaleString('ko-KR')}</p>}{settings?.lastError&&<p className="error-text">{settings.lastError}</p>}
      {historyResult?.historyCounts && <div className="gitlab-history-result" role="status" aria-label="기존 개발 이력 동기화 결과">
        <p>브랜치 {historyResult.historyCounts.branches}개 · 커밋 {historyResult.historyCounts.commits}개 조회</p>
        <HistoryLimitNote limits={historyResult.historyLimits} />
      </div>}
    </form>
    {preview && <GitlabPreview preview={preview} openIssue={props.openIssue}/>}
    <section className="card integration-guide"><div className="gitlab-symbol"><GitBranch size={35}/></div><h2>티켓 번호로 자연스럽게 연결</h2><p>브랜치 이름이나 커밋 메시지, MR 제목에 티켓 번호를 넣으세요.</p><code>feature/{props.data.projects.find(project=>project.id===props.projectId)?.key||'TEAM'}-12-login</code><ul><li>GitLab 웹훅에서 Push events를 켜면 MR을 열기 전에도 새 브랜치와 커밋을 티켓에서 확인할 수 있습니다.</li><li>티켓 상태 변경은 MR·파이프라인 이벤트에 연결한 활성화 규칙으로 처리합니다.</li><li>지금 동기화는 저장한 연결 설정을 사용합니다. 기존 브랜치·커밋을 포함하면 웹훅 설정 전의 활동도 찾을 수 있습니다.</li></ul><p className="help-text">GitLab에서 접근 가능한 배포 주소에 웹훅 경로 <code>/api/integrations/gitlab/webhook</code>를 설정하세요.</p></section></div>
    <AutomationSettings {...props}/><WebhookSettings {...props}/>
    <section className="card linked-development" aria-label="연결된 개발 활동">
      <div className="card-heading gitlab-activity-header"><h2>연결된 개발 활동 <span className="count-pill">{links.length}</span></h2><GitlabActivityRefresh refresh={props.refresh} notify={notify} /></div>
      {links.length ? <GitlabActivityList links={links} heading="h3" issueContext={{ keys: issueKeys, openIssue: props.openIssue }} /> : <div className="empty-state"><GitBranch aria-hidden="true"/><h3>아직 연결된 개발 활동이 없습니다</h3><p>GitLab을 연결한 뒤 티켓 번호가 들어간 브랜치를 푸시하거나 지금 동기화를 실행하세요.</p></div>}
    </section>
  </div>;
}

const candidateAction = { create: '신규 연결', update: '갱신', unchanged: '유지' } as const;
const candidateKind = { merge_request: 'MR', pipeline: '파이프라인', branch: '브랜치', commit: '커밋' } as const;
const readStage = { project: '저장소 정보', 'merge-requests': 'MR', pipelines: '파이프라인', branches: '브랜치', commits: '커밋' } as const;

function GitlabPreview({ preview, openIssue }: { preview: PreviewState; openIssue: FeatureProps['openIssue'] }) {
  return <section className="card gitlab-preview" aria-labelledby="gitlab-preview-title">
    <div className="card-heading"><h2 id="gitlab-preview-title"><Search size={18} aria-hidden="true"/>GitLab 연결 미리보기</h2></div>
    {preview.state === 'loading' && <p role="status">입력한 설정으로 GitLab 저장소를 조회하는 중입니다.</p>}
    {preview.state === 'failed' && <p className="inline-error" role="alert">{preview.error} 작성 내용은 유지됩니다.</p>}
    {preview.state === 'ready' && <>
      <p>현재 입력값으로 조회한 결과입니다. 지금 동기화는 저장한 설정의 모든 저장소를 조회한 뒤 연결을 저장합니다.</p>
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
        {preview.result.repositories.map(repository => <li key={repository.projectId}>
          <section aria-label={`저장소 ${repository.projectId}`}>
            <h3>저장소 {repository.projectId} <span className={`badge gitlab-preview-${repository.status}`}>{repository.error ? `${readStage[repository.error.stage]} 조회 실패` : '조회 가능'}</span></h3>
            {repository.error ? <p className="error-text">{repository.error.message}</p> :
              <>
                <p>MR {repository.counts.mergeRequests}개 · 파이프라인 {repository.counts.pipelines}개
                  {repository.counts.branches !== undefined && ` · 브랜치 ${repository.counts.branches}개`}
                  {repository.counts.commits !== undefined && ` · 커밋 ${repository.counts.commits}개`}</p>
                <p>신규 연결 {repository.counts.create}개 · 갱신 {repository.counts.update}개 · 유지 {repository.counts.unchanged}개</p>
                <HistoryLimitNote limits={repository.historyLimits} />
              </>}
          </section>
        </li>)}
      </ul>
      <section className="gitlab-preview-candidates" aria-labelledby="gitlab-preview-candidates-title">
        <h3 id="gitlab-preview-candidates-title">티켓 연결 후보</h3>
        {preview.result.candidates.length ? <ul>
          {preview.result.candidates.map(candidate => <li key={`${candidate.projectId}:${candidate.kind}:${candidate.objectId}:${candidate.issueId}`}>
            <div><small>저장소 {candidate.projectId} · {candidateKind[candidate.kind]} · {candidate.state}</small><strong>{candidate.title}</strong></div>
            <div className="gitlab-preview-target"><span className="badge">{candidateAction[candidate.action]}</span><button type="button" className="text-link" aria-label={`업무 ${candidate.issueKey} 열기`} onClick={() => openIssue(candidate.issueId)}>{candidate.issueKey} · {candidate.issueTitle}</button></div>
          </li>)}
        </ul> : <p>조회한 항목에서 티켓 연결 후보를 찾지 못했습니다.</p>}
        {preview.result.candidatesTruncated && <p className="help-text">연결 후보 중 {preview.result.candidates.length}개를 표시합니다.</p>}
      </section>
    </>}
  </section>;
}
