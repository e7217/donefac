'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, GitBranch, RefreshCw } from 'lucide-react';
import type { FeatureProps, GitlabSettings } from '../../shared/types';
import { api, patch, post } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { AutomationSettings } from './AutomationSettings';
import { WebhookSettings } from './WebhookSettings';
import './development.css';

type Draft={baseUrl:string;ids:string;token:string;secret:string;signingToken:string};
const empty:Draft={baseUrl:'',ids:'',token:'',secret:'',signingToken:''};
const draftOf=(settings:GitlabSettings):Draft=>({...empty,baseUrl:settings.baseUrl,ids:settings.projectIds.join(', ')});

export function Development(props:FeatureProps){
  const {notify}=props;
  const [settings,setSettings]=useState<GitlabSettings|null>(null),[draft,setDraft]=useState< Draft>(empty),[baseline,setBaseline]=useState< Draft>(empty);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(false),dirtyRef=useRef(false),alive=useRef(true);
  const dirty=JSON.stringify(draft)!==JSON.stringify(baseline);
  useEffect(()=>{dirtyRef.current=dirty;},[dirty]);
  const accept=useCallback((value:GitlabSettings)=>{setSettings(value);const next=draftOf(value);setDraft(next);setBaseline(next);dirtyRef.current=false;setError('');},[]);
  useEffect(()=>{alive.current=true;let cancelled=false;void api<GitlabSettings>('/integrations/gitlab').then(value=>{if(!cancelled)accept(value);}).catch(e=>{if(!cancelled)setError((e as Error).message);});return()=>{cancelled=true;alive.current=false;};},[accept]);
  useEffect(()=>{
    const guard=(event:Event)=>{if(event.defaultPrevented)return;if(pending.current){event.preventDefault();notify('GitLab 요청이 끝난 뒤 이동해 주세요.','error');}else if(dirtyRef.current){if(!window.confirm('저장하지 않은 GitLab 설정을 버리고 이동할까요?'))event.preventDefault();else afterAcceptedNavigation(event,()=>{setDraft(baseline);dirtyRef.current=false;setError('');});}};
    const unload=(event:BeforeUnloadEvent)=>{if(pending.current||dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('teamspace:navigate',guard);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('teamspace:navigate',guard);window.removeEventListener('beforeunload',unload);};
  },[baseline,notify]);
  function edit<K extends keyof Draft>(key:K,value:Draft[K]){setDraft(previous=>({...previous,[key]:value}));}
  async function execute(action:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError((e as Error).message);}finally{pending.current=false;if(alive.current)setBusy(false);}}
  async function reload(){if(dirtyRef.current&&!window.confirm('작성 중인 GitLab 설정을 버리고 최신 설정을 불러올까요?'))return;await execute(async()=>accept(await api<GitlabSettings>('/integrations/gitlab')));}
  async function save(event:FormEvent){event.preventDefault();if(!settings)return;await execute(async()=>{
    const projectIds=draft.ids.split(',').map(value=>value.trim()).filter(Boolean).map(Number);if(projectIds.some(id=>!Number.isSafeInteger(id)||id<1))throw new Error('프로젝트 ID는 쉼표로 구분된 양의 정수로 입력해주세요.');
    const saved=await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,baseUrl:draft.baseUrl,projectIds,...(draft.token?{token:draft.token}:{}),...(draft.secret?{webhookSecret:draft.secret}:{}),...(draft.signingToken?{signingToken:draft.signingToken}:{})});accept(saved);window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 연결 설정을 저장했습니다.');
  });}
  async function disconnect(){if(!settings||!window.confirm('GitLab 자격 증명을 삭제하고 상태 자동화를 비활성화할까요? 입력 중인 연결 설정도 초기화합니다. 기존 개발 활동 기록은 유지됩니다.'))return;await execute(async()=>{accept(await patch<GitlabSettings>('/integrations/gitlab',{expectedVersion:settings.version,token:'',webhookSecret:'',signingToken:''}));window.dispatchEvent(new Event('teamspace:gitlab-settings-changed'));props.notify('GitLab 자격 증명을 삭제했습니다.');});}
  async function sync(){await execute(async()=>{const result=await post<{linked:number;settings:GitlabSettings}>('/integrations/gitlab/sync',{});setSettings(result.settings);await props.refresh();props.notify(`GitLab 동기화를 완료했습니다. ${result.linked}개 연결`);});}
  const issueIds=new Set(props.data.issues.filter(issue=>issue.projectId===props.projectId).map(issue=>issue.id)),links=props.data.gitlabLinks.filter(link=>issueIds.has(link.issueId));
  return <div className="page development-page"><div className="page-heading"><div><div className="eyebrow">DEVELOPMENT</div><h1>코드와 업무를 연결하세요</h1><p>GitLab 활동과 자동화, 외부 도구로 보내는 알림을 관리합니다.</p></div><button className="btn btn-primary" disabled={busy||!settings?.baseUrl||!settings.projectIds.length} onClick={sync}><GitBranch size={16}/>{busy?'처리 중…':'지금 동기화'}</button></div>
    {error&&<div className="inline-error" role="alert">{error} 작성 내용은 유지됩니다.</div>}
    <div className="integration-grid"><form className="card integration-form" onSubmit={save}><div className="card-heading"><h2><GitBranch size={19}/>GitLab 연결</h2><button type="button" className="btn btn-ghost" disabled={busy} onClick={reload}><RefreshCw size={14}/>최신 설정</button></div><fieldset disabled={busy||!settings} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <label className="form-label">GitLab 주소<input type="url" className="field" placeholder="https://gitlab.example.com" value={draft.baseUrl} onChange={e=>edit('baseUrl',e.target.value)}/></label>
      <label className="form-label">GitLab 프로젝트 ID<input className="field" placeholder="예: 12, 34" value={draft.ids} onChange={e=>edit('ids',e.target.value)}/><span className="help-text">GitLab 프로젝트 설정의 숫자 ID를 입력하세요.</span></label>
      <label className="form-label">읽기 API 토큰<input type="password" autoComplete="new-password" className="field" placeholder={settings?.tokenConfigured?'저장된 토큰 유지 · 변경할 때만 입력':'선택 · read_api 권한의 토큰'} value={draft.token} onChange={e=>edit('token',e.target.value)}/></label>
      <label className="form-label">웹훅 Secret Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.webhookSecretConfigured?'저장된 비밀값 유지':'웹훅 인증에 사용할 비밀값'} value={draft.secret} onChange={e=>edit('secret',e.target.value)}/></label>
      <label className="form-label">웹훅 Signing Token<input type="password" autoComplete="new-password" className="field" placeholder={settings?.signingTokenConfigured?'저장된 서명 키 유지':'선택 · GitLab에서 발급한 whsec_ 서명 키'} value={draft.signingToken} onChange={e=>edit('signingToken',e.target.value)}/><span className="help-text">GitLab에서 제공하는 인증 방식에 맞춰 Secret Token 또는 Signing Token을 설정하세요.</span></label>
      <div className="data-actions"><button className="btn btn-primary" disabled={!dirty}>연결 설정 저장</button>{(settings?.tokenConfigured||settings?.webhookSecretConfigured||settings?.signingTokenConfigured)&&<button className="btn btn-ghost" type="button" onClick={disconnect}>연결 해제</button>}</div>
    </fieldset>{settings?.lastSyncAt&&<p className="help-text">마지막 동기화: {new Date(settings.lastSyncAt).toLocaleString('ko-KR')}</p>}{settings?.lastError&&<p className="error-text">{settings.lastError}</p>}</form>
    <section className="card integration-guide"><div className="gitlab-symbol"><GitBranch size={35}/></div><h2>티켓 번호로 자연스럽게 연결</h2><p>브랜치 이름이나 MR 제목에 티켓 번호를 넣으면 관련 업무를 찾아 연결합니다.</p><code>{props.data.projects.find(project=>project.id===props.projectId)?.key||'TEAM'}-12 로그인 오류 수정</code><ul><li>MR과 파이프라인 활동을 티켓에서 확인합니다.</li><li>상태 변경은 활성화한 자동화 규칙에 따라 처리합니다.</li><li>수동 동기화는 개발 활동 연결을 갱신합니다.</li></ul><p className="help-text">웹훅 경로: <code>/api/integrations/gitlab/webhook</code><br/>GitLab에서 접근 가능한 배포 주소가 있을 때 설정하세요.</p></section></div>
    <AutomationSettings {...props}/><WebhookSettings {...props}/>
    <section className="card linked-development"><div className="card-heading"><h2>연결된 개발 활동</h2><span className="count-pill">{links.length}</span></div>{links.length?links.map(link=><div className="development-row" key={link.id}><GitBranch size={19}/><div><a href={link.webUrl} target="_blank" rel="noreferrer">{link.title} <ArrowUpRight size={13}/></a><button className="text-link" onClick={()=>props.openIssue(link.issueId)}>{props.data.issues.find(issue=>issue.id===link.issueId)?.key}</button></div><span className="badge">{link.state}</span></div>):<div className="empty-state"><GitBranch/><h3>아직 연결된 개발 활동이 없습니다</h3><p>GitLab을 설정하고 티켓 번호가 포함된 MR을 동기화해보세요.</p></div>}</section>
  </div>;
}
