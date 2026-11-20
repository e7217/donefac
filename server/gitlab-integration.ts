import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import type { Express,Request,Response,NextFunction } from 'express';
import type { AutomationEvent,AutomationRun,GitlabHistoryLimits,GitlabJiraRoute,GitlabJiraSource,GitlabLink,GitlabSettings,GitlabSyncFailure,GitlabSyncPreview,GitlabSyncPreviewCandidate,GitlabSyncPreviewCounts,GitlabSyncRepositoryFailure,GitlabSyncRepositoryResult,GitlabSyncResult,Issue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl, gitlabScopedPushUrl, readGitlabHeadPush, type GitlabHeadPush } from './gitlab-push.js';
import { GitlabReadError,readGitlabSyncProject } from './gitlab-read-sync.js';
import type { Store } from './store.js';

export class GitlabIntegrationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new GitlabIntegrationError(status,message,details);}
type Obj=Record<string,unknown>;
type RawSettings={baseUrl:string;projectIds:number[];jiraRoutes?:GitlabJiraRoute[];token?:string|null;webhookSecret?:string|null;signingToken?:string|null;version:number;lastSyncAt:string|null;lastError:string|null};
type ObjectCursor={id:string;occurredAt:string|null;state:string;receivedAt?:string};
type BranchCursor={id:string;pipelineId:number};
type PushObservation={id:string;state:'active'|'deleted';sourceSha:string;webUrl:string;updatedAt:string};
type Hooks={
  processEvent:(event:AutomationEvent)=>AutomationRun[];
  onConnectionChanged:(previous:GitlabSettings,next:GitlabSettings)=>number;
  findArchivedBranchLink?:(cursorId:string)=>GitlabLink|undefined;
  jiraSources?:()=>GitlabJiraSource[];
  jiraOriginalKeys?:(route:GitlabJiraRoute)=>Map<string,JiraKeyBinding|null>;
};
type RouteHooks={actor:(request:Request)=>string;activity:(request:Request,resourceType:string,resourceId:string,action:string,detail?:string)=>unknown};
type SyncConnection={baseUrl:string;projectIds:number[];jiraRoutes?:GitlabJiraRoute[];token:string|null;version:number};
type ReadOptions={signal?:AbortSignal;includeHistory?:boolean};
type SyncOptions=Pick<ReadOptions,'includeHistory'> & { expectedVersion?: unknown; repositoryIds?: unknown };
type SyncKind=GitlabSyncPreviewCandidate['kind'];
type IssueMatch=Pick<Issue,'id'|'key'|'title'|'projectId'>;
type JiraKeyBinding={issueId:string;originalJiraKey:string};
type TicketMatch={issue:IssueMatch;originalJiraKey?:string};
type KeyReader=(...values:unknown[])=>string[];
type TicketMatcher={match:(keys:string[],inherited?:TicketMatch[])=>TicketMatch[];inherit:(link:GitlabLink)=>TicketMatch|undefined;ambiguousKeys:Set<string>};
const PREVIEW_CANDIDATE_LIMIT=100;
const AMBIGUOUS_KEY_LIMIT=20;
const GITLAB_PUSH_COMMIT_LIMIT=20;
const now=()=>new Date().toISOString();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const string=(value:unknown):string=>typeof value==='string'?value:'';
const bound=(value:unknown,max:number):string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:'';
const objectId=(object:Obj):string=>{const id=object.id??object.iid;return typeof id==='number'&&Number.isSafeInteger(id)&&id>0?String(id):typeof id==='string'&&id.trim()?bound(id,200):'';};
function baseUrl(value:unknown):string{if(typeof value!=='string')fail('GitLab 주소를 확인해 주세요.');if(!value.trim())return'';let url:URL;try{url=new URL(value.trim());}catch{fail('GitLab 주소를 확인해 주세요.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('인증 정보가 없는 GitLab http(s) 기본 주소가 필요합니다.');return url.toString().replace(/\/+$/,'');}
function projectIds(value:unknown):number[]{
  if(!Array.isArray(value)||value.length>100||value.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(value).size!==value.length)fail('저장소 ID는 중복되지 않은 양의 정수 목록이어야 합니다.');
  return [...value].sort((a,b)=>a-b);
}
function jiraSourceId(source:Pick<GitlabJiraSource,'projectId'|'jiraInstanceKey'>):string {
  return JSON.stringify([source.projectId,source.jiraInstanceKey]);
}
function parseJiraRoutes(value:unknown,allowed:number[],sources:GitlabJiraSource[]):GitlabJiraRoute[]{
  if(!Array.isArray(value)||value.length>100)fail('GitLab 저장소별 Jira 원본 경로를 확인해 주세요.');
  const selected=new Set<number>(),sourceIds=new Set(sources.map(jiraSourceId));
  return value.map(raw=>{
    const input=record(raw),{repositoryId,projectId,jiraInstanceKey}=input;
    if(Object.keys(input).length!==3||typeof repositoryId!=='number'||!allowed.includes(repositoryId)||selected.has(repositoryId)||
       typeof projectId!=='string'||typeof jiraInstanceKey!=='string'||!sourceIds.has(jiraSourceId({projectId,jiraInstanceKey}))){
      fail('허용된 저장소마다 현재 이관된 프로젝트와 Jira 원본 조합을 한 번만 선택해 주세요.');
    }
    selected.add(repositoryId);
    return {repositoryId,projectId,jiraInstanceKey};
  }).sort((a,b)=>a.repositoryId-b.repositoryId);
}
function credential(value:unknown):string{
  if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value))fail('인증 값을 확인해 주세요.');
  return value;
}
function historyRequested(input:Obj):boolean{
  if('includeHistory'in input&&typeof input.includeHistory!=='boolean')fail('기존 브랜치·커밋 조회 옵션을 확인해 주세요.');
  return input.includeHistory===true;
}
function assertSettingsVersion(expectedVersion:unknown, currentVersion:number):void{
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==currentVersion)fail('GitLab 연결 설정이 변경되었습니다. 최신 설정을 확인해 주세요.',Number.isSafeInteger(expectedVersion)?409:400,{currentVersion});
}
function occurredAt(value:unknown):string|null{if(typeof value!=='string'||value.length>100)return null;const candidate=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(value)?value.replace(' ','T').replace(' UTC','Z'):value;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(candidate)||!isCalendarDate(candidate.slice(0,10))||Number(candidate.slice(11,13))>23||Number(candidate.slice(14,16))>59||Number(candidate.slice(17,19))>59)return null;const time=Date.parse(candidate);return Number.isFinite(time)&&time<=Date.now()?new Date(time).toISOString():null;}
function keys(...values:unknown[]):string[]{return[...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g)||[]))];}
function routedKeys(...values:unknown[]):string[]{
  return [...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Za-z][A-Za-z0-9_]{0,127}-\d+\b/g)||[]).map(key=>key.toUpperCase()))];
}
function constantEqual(a:string,b:string):boolean{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function signingKey(value:string):Buffer{if(!value.startsWith('whsec_'))fail('서명 토큰은 whsec_ 형식이어야 합니다.');const encoded=value.slice(6),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)fail('서명 토큰은 32바이트 Base64 whsec_ 형식이어야 합니다.');return key;}
function validWebUrl(value:unknown):string{if(typeof value!=='string'||value.length>4000)return'';try{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():'';}catch{return'';}}

function readLink(kind:GitlabLink['kind'],object:Obj,explicitKeys:string[],readKeys:KeyReader=keys){
  const id=objectId(object);
  const title=string(object.title)||string(object.name)||string(object.ref)||string(object.message)||`${kind} #${id}`;
  return {
    id,title:title.slice(0,500),matchedKeys:[...new Set([...readKeys(title,object.description,object.source_branch,object.ref),...explicitKeys])],
    webUrl:validWebUrl(object.web_url||object.url),iid:kind==='commit'?0:Number(object.iid||object.id)||0,
    state:string(object.state)||string(object.status)||'unknown',incomingTime:occurredAt(object.updated_at||object.finished_at||object.created_at),
    sourceBranch:bound(object.source_branch||object.ref,512),sourceSha:bound(object.sha||record(object.last_commit).id,128),
  };
}
type LinkDraft=ReturnType<typeof readLink>;
type ProjectReadPlan={
  projectId:number;mergeRequests:LinkDraft[];pipelines:LinkDraft[];
  history?:{branches:LinkDraft[];commits:LinkDraft[];limits:GitlabHistoryLimits};
};
type ProjectReadOutcome={projectId:number;plan:ProjectReadPlan}|{projectId:number;failure:GitlabSyncRepositoryFailure};
function linkForIssue(instance:string,projectId:number,kind:GitlabLink['kind'],match:TicketMatch,draft:LinkDraft):GitlabLink{
  const { id,title,iid,webUrl,state,incomingTime,sourceBranch,sourceSha }=draft;
  const {issue:{id:issueId},originalJiraKey}=match;
  return {id:`gitlab:${instance}:${projectId}:${kind}:${id}:${issueId}`,issueId,projectId,iid,kind,title,webUrl,state,updatedAt:incomingTime||now(),...(sourceBranch?{sourceBranch}:{}),...(sourceSha?{sourceSha}:{}),...(originalJiraKey?{originalJiraKey}:{})};
}
function retainOriginalJiraKey(link:GitlabLink,existing?:GitlabLink):GitlabLink{
  return !link.originalJiraKey&&existing?.originalJiraKey?{...link,originalJiraKey:existing.originalJiraKey}:link;
}

function makeTicketMatcher(issues:IssueMatch[],route:GitlabJiraRoute|undefined,originals:Map<string,JiraKeyBinding|null>):TicketMatcher{
  const scoped=route?issues.filter(issue=>issue.projectId===route.projectId):issues;
  const byId=new Map(scoped.map(issue=>[issue.id,issue]));
  const byKey=new Map(scoped.map(issue=>[route?issue.key.toUpperCase():issue.key,issue]));
  const ambiguousKeys=new Set<string>();

  function fromKey(key:string):TicketMatch|undefined{
    const normalized=route?key.toUpperCase():key;
    const current=byKey.get(normalized),alias=originals.get(normalized);
    if(alias===null||current&&alias&&current.id!==alias.issueId){
      if(ambiguousKeys.size<AMBIGUOUS_KEY_LIMIT)ambiguousKeys.add(normalized);
      return;
    }
    const issue=current??(alias?byId.get(alias.issueId):undefined);
    return issue?{issue,...(alias?{originalJiraKey:alias.originalJiraKey}:{})}:undefined;
  }

  return {
    match(keys,inherited=[]){
      const matches=new Map<string,TicketMatch>();
      for(const candidate of [...keys.map(fromKey),...inherited]){
        if(!candidate)continue;
        const previous=matches.get(candidate.issue.id);
        if(!previous||!previous.originalJiraKey&&candidate.originalJiraKey)matches.set(candidate.issue.id,candidate);
      }
      return [...matches.values()];
    },
    inherit(link){
      const issue=byId.get(link.issueId);
      if(!issue)return;
      if(!link.originalJiraKey)return {issue};
      const alias=originals.get(link.originalJiraKey.toUpperCase());
      if(alias?.issueId!==issue.id||fromKey(link.originalJiraKey)?.issue.id!==issue.id)return;
      return {issue,originalJiraKey:alias.originalJiraKey};
    },
    ambiguousKeys,
  };
}
function keepNewerLink(existing:GitlabLink,draft:LinkDraft):boolean{
  return !draft.incomingTime||Date.parse(existing.updatedAt)>=Date.parse(draft.incomingTime);
}
function emptyCounts(includeHistory=false):GitlabSyncPreviewCounts{
  return {mergeRequests:0,pipelines:0,matched:0,unmatched:0,skipped:0,create:0,update:0,unchanged:0,...(includeHistory?{branches:0,commits:0}:{})};
}
function branchHead(branch:unknown,sha:unknown):string|null{
  const ref=bound(branch,512),head=bound(sha,128);
  return ref&&head?JSON.stringify([ref,head]):null;
}
const branchObjectId=(branch:string)=>createHash('sha256').update(branch).digest('hex');
function pushCursorId(instance: string, projectId: number, branch: string): string {
  return `gitlab:${instance}:${projectId}:branch:${branchObjectId(branch)}`;
}
function pushObservationFromLink(link: GitlabLink, includeSnapshot=false): PushObservation | null {
  if (!includeSnapshot && link.branchObservationSource === 'sync') return null;
  const { sourceBranch, state, webUrl, updatedAt } = link;
  if (link.kind !== 'branch' || !isGitlabBranchName(sourceBranch) || (state !== 'active' && state !== 'deleted')) return null;
  const instance = /^gitlab:([a-f\d]{12}):/.exec(link.id)?.[1];
  const sourceSha = gitlabObjectSha(link.sourceSha);
  if (!instance || !sourceSha || /^0+$/.test(sourceSha) || !Number.isFinite(Date.parse(updatedAt))) return null;
  const id = pushCursorId(instance, link.projectId, sourceBranch);
  return link.id === `${id}:${link.issueId}` ? { id, state, sourceSha, webUrl, updatedAt } : null;
}
function safePreviewValue(value:string,token:string|null):string{
  return token?value.replaceAll(token,'[숨김]'):value;
}

function repositoryBranchDraft(object:Obj, repository:URL, readKeys:KeyReader):LinkDraft{
  const branch=object.name, sha=gitlabObjectSha(record(object.commit).id);
  if(!isGitlabBranchName(branch)||!sha||/^0+$/.test(sha))return readLink('branch',{},[]);
  const draft=readLink('branch',{
    id:branchObjectId(branch),title:branch,source_branch:branch,sha,state:'active',web_url:gitlabPushLinkUrl(repository,'tree',branch),
  },[],readKeys);
  return {...draft,title:branch,iid:0};
}

function repositoryCommitDraft(object:Obj, repository:URL, readKeys:KeyReader):LinkDraft{
  const sha=gitlabObjectSha(object.id);
  if(!sha||/^0+$/.test(sha))return readLink('commit',{},[]);
  return readLink('commit',{
    id:sha,sha,title:object.title,message:object.message,state:'committed',
    updated_at:object.committed_date,web_url:gitlabPushLinkUrl(repository,'commit',sha),
  },readKeys(object.title,object.message),readKeys);
}

async function readProjectPlan(connection:SyncConnection,projectId:number,options:ReadOptions):Promise<ProjectReadPlan>{
  const scan=await readGitlabSyncProject(connection,projectId,options);
  const readKeys=connection.jiraRoutes?.some(route=>route.repositoryId===projectId)?routedKeys:keys;
  const mergeRequests=scan.mergeRequests.map(object=>readLink('merge_request',object,[],readKeys));
  const keysByHead=new Map<string,Set<string>>();
  for(const mr of mergeRequests){
    const head=branchHead(mr.sourceBranch,mr.sourceSha);
    if(!head||!mr.id||!mr.webUrl)continue;
    let selected=keysByHead.get(head);
    if(!selected){selected=new Set();keysByHead.set(head,selected);}
    for(const key of mr.matchedKeys)selected.add(key);
  }
  const pipelines=scan.pipelines.map(object=>{
    const head=branchHead(object.ref,object.sha);
    return readLink('pipeline',object,head?[...(keysByHead.get(head)??[])]:[],readKeys);
  });
  if(!scan.history)return {projectId,mergeRequests,pipelines};
  const repository=gitlabRepositoryUrl(connection.baseUrl,scan.history.project);
  if(!repository)throw new GitlabReadError('project','invalid-response');
  const {branches,commits,branchesLimited,commitsLimited}=scan.history;
  return {projectId,mergeRequests,pipelines,history:{
    branches:branches.map(object=>repositoryBranchDraft(object,repository,readKeys)),commits:commits.map(object=>repositoryCommitDraft(object,repository,readKeys)),
    limits:{branches:branchesLimited,commits:commitsLimited},
  }};
}

/** All external writes are local links; remote calls are explicit read-only syncs. */
export class GitlabIntegrationService{
  // Branch list snapshots have no revision number for reconciling overlapping manual scans.
  private historySyncActive=false;
  constructor(private readonly store:Store,private readonly hooks:Hooks){store.db.exec('CREATE TABLE IF NOT EXISTS gitlab_object_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS gitlab_branch_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS gitlab_push_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);');}
  private raw():RawSettings{const value=record(this.store.setting('gitlab'));return{baseUrl:string(value.baseUrl),projectIds:Array.isArray(value.projectIds)?value.projectIds as number[]:[],...(Array.isArray(value.jiraRoutes)&&value.jiraRoutes.length?{jiraRoutes:value.jiraRoutes as GitlabJiraRoute[]}:{}),token:typeof value.token==='string'?value.token:null,webhookSecret:typeof value.webhookSecret==='string'?value.webhookSecret:null,signingToken:typeof value.signingToken==='string'?value.signingToken:null,version:Number.isSafeInteger(value.version)&&Number(value.version)>0?Number(value.version):1,lastSyncAt:typeof value.lastSyncAt==='string'?value.lastSyncAt:null,lastError:typeof value.lastError==='string'?value.lastError:null};}
  private public(raw:RawSettings):GitlabSettings{return{baseUrl:raw.baseUrl,projectIds:raw.projectIds,tokenConfigured:!!raw.token,webhookSecretConfigured:!!raw.webhookSecret,signingTokenConfigured:!!raw.signingToken,version:raw.version,lastSyncAt:raw.lastSyncAt,lastError:raw.lastError,...(raw.jiraRoutes?.length?{jiraRoutes:raw.jiraRoutes}:{})};}
  settings():GitlabSettings{return this.public(this.raw());}
  private jiraSources():GitlabJiraSource[]{return this.hooks.jiraSources?.()??[];}
  private submittedJiraRoutes(input:Obj,old:RawSettings,address:string,repositories:number[]):GitlabJiraRoute[]{
    if(Object.hasOwn(input,'jiraRoutes'))return parseJiraRoutes(input.jiraRoutes,repositories,this.jiraSources());
    return address===old.baseUrl?(old.jiraRoutes??[]).filter(route=>repositories.includes(route.repositoryId)):[];
  }
  private instance(raw:Pick<RawSettings,'baseUrl'>=this.raw()):string{return createHash('sha256').update(raw.baseUrl).digest('hex').slice(0,12);}
  configure(value:unknown,afterSave?:(settings:GitlabSettings)=>void):GitlabSettings{return this.store.transaction(()=>{
    const input=record(value),old=this.raw();assertSettingsVersion(input.expectedVersion,old.version);const next={...old};
    if('baseUrl'in input)next.baseUrl=baseUrl(input.baseUrl);
    if(next.baseUrl!==old.baseUrl){next.token=null;next.lastSyncAt=null;next.lastError=null;}
    if('projectIds'in input)next.projectIds=projectIds(input.projectIds);
    const jiraRoutes=this.submittedJiraRoutes(input,old,next.baseUrl,next.projectIds);
    if(jiraRoutes.length)next.jiraRoutes=jiraRoutes;
    else delete next.jiraRoutes;
    for(const field of ['token','webhookSecret','signingToken'] as const)if(field in input){const value=credential(input[field]);if(value&&field==='signingToken')signingKey(value);next[field]=value?this.store.seal(value):null;}
    next.version=old.version+1;this.store.setSetting('gitlab',next);this.hooks.onConnectionChanged(this.public(old),this.public(next));afterSave?.(this.public(next));return this.public(next);
  });}
  resetForImport(branchLinks: Iterable<GitlabLink> = []): void {
    this.store.db.exec('DELETE FROM webhook_inbox;DELETE FROM gitlab_object_cursors;DELETE FROM gitlab_branch_cursors;DELETE FROM gitlab_push_cursors;');
    const observations = new Map<string, PushObservation>();
    for (const link of branchLinks) {
      const observed = pushObservationFromLink(link);
      if (!observed) continue;
      const previous = observations.get(observed.id);
      if (!previous || Date.parse(previous.updatedAt) < Date.parse(observed.updatedAt)) observations.set(observed.id, observed);
    }
    for (const observed of observations.values()) this.store.put('gitlab_push_cursors', observed);
    const raw = this.raw();
    if(raw.jiraRoutes?.length){
      const sources=new Set(this.jiraSources().map(jiraSourceId));
      raw.jiraRoutes=raw.jiraRoutes.filter(route=>raw.projectIds.includes(route.repositoryId)&&sources.has(jiraSourceId(route)));
      if(!raw.jiraRoutes.length)delete raw.jiraRoutes;
    }
    this.store.setSetting('gitlab', { ...raw, version: raw.version + 1 });
  }
  private authenticate(req:Request,raw:RawSettings):void{
    if(req.headers['webhook-signature']!==undefined){
      if(!raw.signingToken)fail('Webhook 서명 인증에 실패했습니다.',401);
      const id=req.header('webhook-id')||'',timestamp=req.header('webhook-timestamp')||'',signature=req.header('webhook-signature')||'',body=(req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody;
      if(!id||id.length>200||!/^\d{1,16}$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300||!body||signature.length>2048)fail('Webhook 서명 또는 발생 시각을 확인할 수 없습니다.',401);
      const expected=createHmac('sha256',signingKey(this.store.unseal(raw.signingToken))).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`),body])).digest();let valid=false;
      for(const part of signature.split(/\s+/)){const[version,encoded]=part.split(',');if(version!=='v1'||!encoded)continue;const received=Buffer.from(encoded,'base64');if(received.length===expected.length&&received.toString('base64')===encoded&&timingSafeEqual(received,expected))valid=true;}
      if(!valid)fail('Webhook 서명 인증에 실패했습니다.',401);return;
    }
    if(!raw.webhookSecret){if(raw.signingToken)fail('Webhook 서명이 필요합니다.',401);fail('Webhook 인증이 설정되지 않았습니다.',503);}
    if(!constantEqual(this.store.unseal(raw.webhookSecret),req.header('X-Gitlab-Token')||''))fail('Webhook 인증에 실패했습니다.',401);
  }
  private ticketMatcher(issues:IssueMatch[],route?:GitlabJiraRoute):TicketMatcher{
    return makeTicketMatcher(issues,route,route?this.hooks.jiraOriginalKeys?.(route)??new Map():new Map());
  }
  private inheritedMatches(projectId:number,branch:string,sha:string,instance:string,matcher:TicketMatcher):TicketMatch[]{
    if(!branch||!sha)return[];
    return this.store.all<GitlabLink>('gitlab_links').flatMap(link=>{
      if(link.kind!=='merge_request'||link.projectId!==projectId||!link.id.startsWith(`gitlab:${instance}:`)||link.sourceBranch!==branch||link.sourceSha!==sha)return[];
      const match=matcher.inherit(link);
      return match?[match]:[];
    });
  }
  private upsert(instance:string,projectId:number,kind:GitlabLink['kind'],draft:LinkDraft,matches:TicketMatch[],preserveExisting:boolean):number{
    if(!draft.webUrl)return 0;
    let linked=0;
    for(const match of matches){
      const link=linkForIssue(instance,projectId,kind,match,draft);
      const existing=this.store.get<GitlabLink>('gitlab_links',link.id);
      if(preserveExisting&&existing)continue;
      this.store.put('gitlab_links',retainOriginalJiraKey(link,existing));
      linked++;
    }
    return linked;
  }
  private observeBranch(baseUrl: string, instance: string, projectId: number, head: GitlabHeadPush, repository: URL | null, matches: TicketMatch[]): number {
    const id = pushCursorId(instance, projectId, head.branch);
    let previous = this.store.get<PushObservation>('gitlab_push_cursors', id);
    let snapshotUrl: string | undefined;
    if (!previous) {
      // Native backups contain branch links without transient webhook cursors.
      const persisted = matches.flatMap(({issue:{id:issueId}}) => {
        const prior = this.store.get<GitlabLink>('gitlab_links', `${id}:${issueId}`);
        if (prior?.branchObservationSource === 'sync') snapshotUrl ??= prior.webUrl;
        const observed = prior && pushObservationFromLink(prior);
        return observed ? [observed] : [];
      });
      previous = persisted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    }
    const archived = !previous && !matches.length ? this.hooks.findArchivedBranchLink?.(id) : undefined;
    if (archived) previous = pushObservationFromLink(archived) ?? undefined;
    if (!previous && !matches.length && !archived) return 0;
    const lastHead = previous?.state === 'deleted' ? '0'.repeat(previous.sourceSha.length) : previous?.sourceSha;
    const sameHead = lastHead === head.after;
    if (lastHead !== undefined && !sameHead && lastHead !== head.before) return 0;

    const treeUrl = repository && gitlabPushLinkUrl(repository, 'tree', head.branch);
    const webUrl = treeUrl || gitlabScopedPushUrl(baseUrl, previous?.webUrl ?? snapshotUrl ?? archived?.webUrl);
    if (!webUrl) return 0;
    const observation: PushObservation = sameHead && previous ? { ...previous, webUrl } : {
      id, state: head.deleted ? 'deleted' : 'active', sourceSha: head.deleted ? head.before : head.after, webUrl, updatedAt: now(),
    };
    this.store.put('gitlab_push_cursors', observation);
    let linked = 0;
    for (const {issue:{id:issueId},originalJiraKey} of matches) {
      const link: GitlabLink = { ...observation, id: `${id}:${issueId}`, issueId, projectId, iid: 0, kind: 'branch', title: head.branch, sourceBranch: head.branch, ...(originalJiraKey?{originalJiraKey}:{}) };
      const existing = this.store.get<GitlabLink>('gitlab_links', link.id);
      const next=retainOriginalJiraKey(link,existing);
      if (existing?.state === next.state && !existing.branchObservationSource && existing.sourceSha === next.sourceSha && existing.webUrl === next.webUrl && existing.originalJiraKey === next.originalJiraKey) continue;
      this.store.put('gitlab_links', next);
      linked++;
    }
    return linked;
  }
  latestObservedBranchLink(link: GitlabLink): GitlabLink {
    const observation = pushObservationFromLink(link,true);
    if (!observation) return link;
    const current = this.store.get<PushObservation>('gitlab_push_cursors', observation.id);
    if (!current) return link;
    const refreshed = { ...link, ...current, id: link.id };
    delete refreshed.branchObservationSource;
    return refreshed;
  }
  refreshRestoredBranchLinks(issueId: string): void {
    const links = this.store.db.prepare(`SELECT json FROM gitlab_links WHERE issue_id=? AND json_extract(json,'$.kind')='branch'`).all(issueId);
    for (const row of links) {
      const link = JSON.parse(String(row.json)) as GitlabLink;
      const latest = this.latestObservedBranchLink(link);
      if (latest !== link) this.store.put('gitlab_links', latest);
    }
  }
  private recordPush(raw: RawSettings, instance: string, projectId: number, kind: string, body: Obj, project: Obj): number {
    const head = kind === 'push' ? readGitlabHeadPush(body) : null;
    const route=raw.jiraRoutes?.find(candidate=>candidate.repositoryId===projectId);
    const readKeys=route?routedKeys:keys;
    const branchKeys = head ? readKeys(head.branch) : [];
    const commits = Array.isArray(body.commits) ? body.commits : [];
    if (!branchKeys.length && !commits.length) return 0;

    const repository = gitlabRepositoryUrl(raw.baseUrl, project);
    const matcher=this.ticketMatcher(this.syncIssues(),route);
    const branchMatches=matcher.match(branchKeys);
    let linked = head ? this.observeBranch(raw.baseUrl, instance, projectId, head, repository, branchMatches) : 0;
    if (head?.deleted) return linked;

    for (const item of (head ? commits.slice(-GITLAB_PUSH_COMMIT_LIMIT) : commits)) {
      const commit = record(item);
      const sha = gitlabObjectSha(commit.id);
      if (sha && /^0+$/.test(sha)) continue;
      if (head && (!sha || sha.length !== head.after.length)) continue;
      const explicitKeys = readKeys(commit.title, commit.message, commit.description);
      const matches = explicitKeys.length ? matcher.match(explicitKeys) : branchMatches;
      if (!matches.length) continue;

      const suppliedUrl = commit.web_url || commit.url;
      const canonicalUrl = repository && sha && gitlabPushLinkUrl(repository, 'commit', sha);
      const webUrl = canonicalUrl || gitlabScopedPushUrl(raw.baseUrl, suppliedUrl) || (!head && validWebUrl(suppliedUrl));
      if (!webUrl) continue;
      const draft = readLink('commit', {
        id: sha || commit.id, title: commit.title, message: commit.message, web_url: webUrl,
        state: 'committed', updated_at: commit.timestamp, source_branch: head?.branch, sha,
      }, []);
      if (!draft.id) continue;
      for (const match of matches) {
        const link = linkForIssue(instance, projectId, 'commit', match, draft);
        const existing = this.store.get<GitlabLink>('gitlab_links', link.id);
        if (existing) {
          const shaToAdd = existing.sourceSha ? undefined : link.sourceSha;
          const branchToAdd = existing.sourceBranch ? undefined : link.sourceBranch;
          const aliasToAdd = existing.originalJiraKey ? undefined : link.originalJiraKey;
          if (!shaToAdd && !branchToAdd && !aliasToAdd) continue;
          this.store.put('gitlab_links', { ...existing, ...(shaToAdd ? { sourceSha: shaToAdd } : {}), ...(branchToAdd ? { sourceBranch: branchToAdd } : {}), ...(aliasToAdd ? { originalJiraKey: aliasToAdd } : {}) });
        } else this.store.put('gitlab_links', link);
        linked++;
      }
    }
    return linked;
  }
  webhook(req:Request):{ok:true;duplicate:boolean;linked:number;runs:AutomationRun[]}{
    const raw=this.raw();this.authenticate(req,raw);const body=record(req.body),project=record(body.project),projectId=Number(project.id??body.project_id);if(!raw.projectIds.includes(projectId))fail('허용된 저장소가 아닙니다.',403);
    const header=req.header('X-Gitlab-Event')||'',kind=string(body.object_kind)||({'Merge Request Hook':'merge_request','Pipeline Hook':'pipeline','Push Hook':'push','Tag Push Hook':'tag_push'} as Record<string,string>)[header]||'';
    const attributes=record(body.object_attributes),instance=this.instance(raw),externalId=req.header('webhook-id')||req.header('Idempotency-Key')||req.header('X-Gitlab-Event-UUID')||createHash('sha256').update((req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody||Buffer.from(JSON.stringify(body))).digest('hex');if(externalId.length>500)fail('Webhook 식별자가 너무 깁니다.');const eventId=`gitlab:${instance}:${projectId}:${kind}:${createHash('sha256').update(externalId).digest('hex')}`;
    return this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM webhook_inbox WHERE id=?').get(eventId))return{ok:true,duplicate:true,linked:0,runs:[]};
      this.store.db.prepare('INSERT INTO webhook_inbox(id,created_at) VALUES(?,?)').run(eventId,now());
      if(kind==='push'||kind==='tag_push')return{ok:true,duplicate:false,linked:this.recordPush(raw,instance,projectId,kind,body,project),runs:[]};
      if(kind!=='merge_request'&&kind!=='pipeline')return{ok:true,duplicate:false,linked:0,runs:[]};
      const id=objectId(attributes),state=string(attributes.state)||string(attributes.status)||'unknown',branch=bound(kind==='merge_request'?attributes.source_branch:attributes.ref,512),sha=bound(attributes.sha||record(attributes.last_commit).id||record(body.commit).id,128);
      const time=occurredAt(kind==='merge_request'?(attributes.actioned_at||attributes.updated_at):(attributes.finished_at||attributes.updated_at||attributes.created_at));
      const cursorId=`${instance}:${projectId}:${kind}:${id}`,prior=id?this.store.get<ObjectCursor>('gitlab_object_cursors',cursorId):undefined;let disposition:AutomationEvent['disposition']='fresh',reason='';
      if(!id||!time){disposition='unverified';reason='이벤트 식별자 또는 유효한 과거 발생 시각을 확인할 수 없습니다.';}
      else if(prior?.occurredAt){const difference=Date.parse(time)-Date.parse(prior.occurredAt);if(difference<0){disposition='stale';reason='이 객체의 최신 수신 이벤트보다 오래된 이벤트입니다.';}else if(difference===0){disposition=state===prior.state?'stale':'ambiguous';reason=state===prior.state?'같은 발생 시각·상태의 이벤트를 이미 반영했습니다.':'같은 발생 시각의 상태가 서로 달라 적용하지 않았습니다.';}}
      const objectDisposition=disposition;
      if(id&&(disposition==='fresh'||!prior))this.store.put('gitlab_object_cursors',{id:cursorId,occurredAt:time,state,receivedAt:now()} satisfies ObjectCursor);
      if(kind==='pipeline'&&branch){const numericId=Number(id),branchId=`${instance}:${projectId}:${branch}`,latest=this.store.get<BranchCursor>('gitlab_branch_cursors',branchId);if(Number.isSafeInteger(numericId)&&numericId>0){if(latest&&numericId<latest.pipelineId){disposition='stale';reason='이 브랜치에 더 최근에 생성된 파이프라인이 있어 이전 결과를 적용하지 않았습니다.';}else if(objectDisposition==='fresh'&&time&&(!latest||numericId>latest.pipelineId))this.store.put('gitlab_branch_cursors',{id:branchId,pipelineId:numericId} satisfies BranchCursor);}else{disposition='unverified';reason='파이프라인 순서를 확인할 수 없습니다.';}}
      const route=raw.jiraRoutes?.find(candidate=>candidate.repositoryId===projectId),readKeys=route?routedKeys:keys;
      const issues=this.syncIssues(),matcher=this.ticketMatcher(issues,route);
      const mergeRequest=record(body.merge_request),extra=readKeys(mergeRequest.title,mergeRequest.description,mergeRequest.source_branch,record(body.commit).message,...(Array.isArray(body.commits)?body.commits.map(commit=>record(commit).message):[]));
      const inherited=kind==='pipeline'?this.inheritedMatches(projectId,branch,sha,instance,matcher):[];
      const object={...attributes,...(time?{updated_at:time}:{}),...(branch?{source_branch:branch}:{}),...(sha?{sha}:{}),web_url:attributes.web_url||attributes.url||(kind==='pipeline'&&project.web_url?`${project.web_url}/-/pipelines/${id}`:'')};
      const draft=readLink(kind,object,extra,readKeys),canUpsert=objectDisposition==='fresh'||objectDisposition==='unverified';
      const direct=canUpsert?draft.matchedKeys:readKeys(attributes.title,attributes.description,branch,attributes.ref,...extra);
      const byMatchId=new Map((id?matcher.match(direct,inherited):[]).map(match=>[match.issue.id,match]));
      const matches=issues.flatMap(issue=>{const match=byMatchId.get(issue.id);return match?[match]:[];});
      const linked=canUpsert?this.upsert(instance,projectId,kind,draft,matches,objectDisposition==='unverified'):0;
      const issueIds=matches.map(match=>match.issue.id);
      const action=string(attributes.action),trigger=kind==='merge_request'?({open:'merge_request.opened',reopen:'merge_request.opened',merge:'merge_request.merged',close:'merge_request.closed'} as Record<string,AutomationEvent['trigger']>)[action]:({success:'pipeline.succeeded',failed:'pipeline.failed'} as Record<string,AutomationEvent['trigger']>)[state];
      const runs=trigger?this.hooks.processEvent({id:eventId,trigger,gitlabProjectId:projectId,objectKind:kind,objectId:id,branch,issueIds,occurredAt:time,receivedAt:now(),disposition,reason}):[];
      return{ok:true,duplicate:false,linked,runs};
    });
  }
  private visitProjectLinks(
    instance:string,plan:ProjectReadPlan,startedAt:number,matcher:TicketMatcher,
    visit:(link:GitlabLink,match:TicketMatch,action:GitlabSyncPreviewCandidate['action'],kind:SyncKind,objectId:string)=>void,
  ):GitlabSyncPreviewCounts{
    const {projectId,mergeRequests,pipelines,history}=plan;
    const counts={...emptyCounts(Boolean(history)),mergeRequests:mergeRequests.length,pipelines:pipelines.length,
      ...(history?{branches:history.branches.length,commits:history.commits.length}:{})};
    // Earlier pages can contain the same object while GitLab changes during pagination.
    // Carry planned writes forward so an in-request duplicate sees what sync would have saved.
    const planned=new Map<string,GitlabLink>();
    const seenHistory=new Set<string>();
    for(const [kind,drafts] of [['branch',history?.branches??[]],['commit',history?.commits??[]],['merge_request',mergeRequests],['pipeline',pipelines]] as const)for(const draft of drafts){
      if(!draft.id||!draft.webUrl){counts.skipped++;continue;}
      let observation:PushObservation|undefined;
      if(kind==='branch'||kind==='commit'){
        const identity=`${kind}:${draft.id}`;
        if(kind==='branch')observation=this.store.get<PushObservation>('gitlab_push_cursors',`gitlab:${instance}:${projectId}:branch:${draft.id}`);
        if(seenHistory.has(identity)||observation&&(observation.state!=='active'||observation.sourceSha!==draft.sourceSha)){
          counts.skipped++;continue;
        }
        seenHistory.add(identity);
      }else{
        const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${projectId}:${kind}:${draft.id}`);
        if(cursor&&(Date.parse(cursor.receivedAt||'')>=startedAt||cursor.occurredAt&&(!draft.incomingTime||Date.parse(cursor.occurredAt)>Date.parse(draft.incomingTime)))){
          counts.skipped++;continue;
        }
      }
      const targets=matcher.match(draft.matchedKeys);
      // A sampled branch can add a scoped Jira link to the exact authenticated head without replacing that observation.
      const matched=observation?targets.filter(target=>target.originalJiraKey):targets;
      if(observation&&!matched.length){counts.skipped++;continue;}
      if(!matched.length){counts.unmatched++;continue;}
      counts.matched++;
      for(const match of matched){
        const link=linkForIssue(instance,projectId,kind,match,draft);
        if(observation){
          const {state,sourceSha,webUrl,updatedAt}=observation;
          Object.assign(link,{state,sourceSha,webUrl,updatedAt});
        }else if(kind==='branch')link.branchObservationSource='sync';
        const existing=planned.get(link.id)??this.store.get<GitlabLink>('gitlab_links',link.id);
        let currentEnough=false;
        if(existing){
          if(observation){
            currentEnough=!existing.branchObservationSource&&existing.state===link.state&&existing.sourceSha===link.sourceSha&&
              existing.webUrl===link.webUrl&&existing.updatedAt===link.updatedAt;
          }else if(kind==='branch'){
            currentEnough=existing.branchObservationSource!=='sync'||existing.sourceSha===link.sourceSha&&existing.webUrl===link.webUrl;
          }else currentEnough=kind==='commit'||keepNewerLink(existing,draft);
        }
        let action:GitlabSyncPreviewCandidate['action']=existing?'update':'create';
        let next=retainOriginalJiraKey(link,existing);
        if(currentEnough&&existing){
          if(!existing.originalJiraKey&&link.originalJiraKey)next={...existing,originalJiraKey:link.originalJiraKey};
          else{next=existing;action='unchanged';}
        }
        counts[action]++;
        if(action!=='unchanged')planned.set(link.id,next);
        visit(next,match,action,kind,draft.id);
      }
    }
    return counts;
  }

  private syncIssues():IssueMatch[]{
    return this.store.all<Issue>('issues').map(({id,key,title,projectId})=>({id,key,title,projectId}));
  }

  private currentForSync(version:number):RawSettings{
    const current=this.raw();
    if(current.version!==version)fail('동기화 도중 GitLab 설정이 변경되어 결과를 적용하지 않았습니다.',409);
    return current;
  }

  private async readRepositories(connection: SyncConnection, options: ReadOptions): Promise<ProjectReadOutcome[]> {
    const reads: ProjectReadOutcome[] = [];
    for (const projectId of connection.projectIds) {
      options.signal?.throwIfAborted();
      try { reads.push({ projectId, plan: await readProjectPlan(connection, projectId, options) }); }
      catch (error) {
        if (!(error instanceof GitlabReadError)) throw error;
        const { stage, httpStatus, message } = error;
        reads.push({ projectId, failure:{ projectId, status:'error', counts:emptyCounts(options.includeHistory), error:{stage,httpStatus,message} } });
      }
      options.signal?.throwIfAborted();
      this.currentForSync(connection.version);
    }
    return reads;
  }

  async previewSync(value:unknown, signal?:AbortSignal):Promise<GitlabSyncPreview>{
    const input=record(value),saved=this.raw(),startedAt=Date.now();
    if(Object.keys(input).some(key=>!['expectedVersion','baseUrl','projectIds','token','includeHistory','jiraRoutes'].includes(key)))fail('지원하지 않는 GitLab 미리보기 요청입니다.');
    assertSettingsVersion(input.expectedVersion,saved.version);
    const includeHistory=historyRequested(input);
    const address='baseUrl'in input?baseUrl(input.baseUrl):saved.baseUrl;
    const repositories='projectIds'in input?projectIds(input.projectIds):saved.projectIds;
    if(!address||!repositories.length)fail('GitLab 주소와 저장소 ID를 입력해 주세요.');
    const jiraRoutes=this.submittedJiraRoutes(input,saved,address,repositories);
    const token='token'in input?credential(input.token):address===saved.baseUrl&&saved.token?this.store.unseal(saved.token):null;
    const connection={baseUrl:address,projectIds:repositories,jiraRoutes,token,version:saved.version};
    const reads=await this.readRepositories(connection,{signal,includeHistory});
    const candidates:GitlabSyncPreviewCandidate[]=[],counts=emptyCounts(includeHistory),issues=this.syncIssues(),instance=this.instance(connection);
    const outcomes:GitlabSyncPreview['repositories']=reads.map(read=>{
      const {projectId}=read;
      if('failure'in read)return read.failure;
      const matcher=this.ticketMatcher(issues,jiraRoutes.find(route=>route.repositoryId===projectId));
      const projectCounts=this.visitProjectLinks(instance,read.plan,startedAt,matcher,(link,{issue,originalJiraKey},action,kind,objectId)=>{
        if(candidates.length<PREVIEW_CANDIDATE_LIMIT)candidates.push({
          projectId,kind,objectId:safePreviewValue(objectId,token),title:safePreviewValue(link.title,token),state:safePreviewValue(link.state.slice(0,100),token),
          issueId:issue.id,issueKey:issue.key,issueTitle:issue.title,action,...(originalJiraKey?{originalJiraKey:safePreviewValue(originalJiraKey,token)}:{}),
        });
      });
      for(const key of Object.keys(counts) as (keyof GitlabSyncPreviewCounts)[])counts[key]=(counts[key]??0)+(projectCounts[key]??0);
      return {projectId,status:'ok',counts:projectCounts,error:null,...(read.plan.history?{historyLimits:read.plan.history.limits}:{}),...(matcher.ambiguousKeys.size?{ambiguousKeys:[...matcher.ambiguousKeys].map(key=>safePreviewValue(key,token))}:{})};
    });
    return {settingsVersion:saved.version,baseUrl:address,projectIds:repositories,repositories:outcomes,counts,candidates,
      candidatesTruncated:counts.create+counts.update+counts.unchanged>candidates.length};
  }

  async sync(afterSync?:(scanned:number,linked:number,failedRepositories:number)=>void,{includeHistory=false,expectedVersion,repositoryIds}:SyncOptions = {}):Promise<GitlabSyncResult>{
    const captured=this.raw(),startedAt=Date.now();
    if(expectedVersion!==undefined||repositoryIds!==undefined)assertSettingsVersion(expectedVersion,captured.version);
    if(!captured.baseUrl||!captured.projectIds.length)fail('GitLab 주소와 저장소 ID를 먼저 설정해 주세요.');
    const selected=repositoryIds===undefined?captured.projectIds:projectIds(repositoryIds);
    if(!selected.length||selected.some(id=>!captured.projectIds.includes(id)))fail('저장한 GitLab 연결의 저장소를 선택해 주세요.');
    if(includeHistory&&this.historySyncActive)fail('기존 브랜치·커밋 동기화가 진행 중입니다.',409);
    if(includeHistory)this.historySyncActive=true;
    try{
      const connection={...captured,projectIds:selected,token:captured.token?this.store.unseal(captured.token):null};
      const reads=await this.readRepositories(connection,{includeHistory});
      const failures=reads.flatMap(read=>'failure'in read?[read.failure]:[]);
      const partial=failures.length>0;
      const failureSummary=`저장소 ${failures.length}곳을 조회하지 못했습니다.`;
      if(failures.length===reads.length){
        const reason=failures.length===1?failures[0].error.message:failureSummary;
        const details:GitlabSyncFailure={settingsVersion:captured.version,reason,repositories:failures};
        this.store.transaction(()=>{
          const current=this.currentForSync(captured.version);
          this.store.setSetting('gitlab',{...current,lastError:reason});
        });
        fail('GitLab 동기화에 실패했습니다.',502,details);
      }
      let scanned=0,linked=0;
      const repositories:GitlabSyncRepositoryResult[]=[];
      const historyCounts={branches:0,commits:0},historyLimits={branches:false,commits:false};
      this.store.transaction(()=>{
        const current=this.currentForSync(captured.version),instance=this.instance(current),issues=this.syncIssues();
        for(const read of reads){
          if('failure'in read){repositories.push(read.failure);continue;}
          const {plan}=read;
          const matcher=this.ticketMatcher(issues,current.jiraRoutes?.find(route=>route.repositoryId===plan.projectId));
          const counts=this.visitProjectLinks(instance,plan,startedAt,matcher,(link,_match,action)=>{if(action!=='unchanged')this.store.put('gitlab_links',link);});
          repositories.push({projectId:read.projectId,status:'ok',counts,error:null,...(plan.history?{historyLimits:plan.history.limits}:{})});
          scanned+=counts.mergeRequests+counts.pipelines+(counts.branches??0)+(counts.commits??0);
          linked+=counts.create+counts.update;
          if(plan.history){
            historyCounts.branches+=counts.branches??0;
            historyCounts.commits+=counts.commits??0;
            historyLimits.branches||=plan.history.limits.branches;
            historyLimits.commits||=plan.history.limits.commits;
          }
        }
        this.store.setSetting('gitlab',{...current,lastSyncAt:now(),lastError:partial?failureSummary:null});
        afterSync?.(scanned,linked,failures.length);
      });
      const notice=includeHistory ? '저장소당 브랜치 최대 500개와 최근 커밋 100개를 함께 확인했습니다. 업무 상태는 자동 변경하지 않습니다.'
        : 'MR은 저장소당 최근 최대 1000개, 파이프라인은 최근 50개를 조회합니다. 업무 상태는 자동 변경하지 않습니다.';
      return{ok:true,scanned,linked,settings:this.settings(),notice,partial,repositories,...(includeHistory?{historyCounts,historyLimits}:{})};
    }catch(error){
      this.currentForSync(captured.version);
      if(error instanceof GitlabIntegrationError)throw error;
      const message='GitLab 동기화 결과를 저장하지 못했습니다.';
      this.store.transaction(()=>{const current=this.currentForSync(captured.version);this.store.setSetting('gitlab',{...current,lastError:message});});
      return fail('GitLab 동기화에 실패했습니다.',502,{reason:message});
    }finally{if(includeHistory)this.historySyncActive=false;}
  }
  registerRoutes(app:Express,hooks:RouteHooks):void{
    app.get('/api/integrations/gitlab',(_req,res)=>res.json(this.settings()));
    app.get('/api/integrations/gitlab/jira-sources',(_req,res)=>res.set('Cache-Control','no-store').json(this.jiraSources()));
    app.patch('/api/integrations/gitlab',(req,res)=>{hooks.actor(req);res.json(this.configure(req.body,()=>hooks.activity(req,'integration','gitlab','GitLab 설정 변경')));});
    app.post('/api/integrations/gitlab/webhook',(req,res)=>res.json(this.webhook(req)));
    app.post('/api/integrations/gitlab/sync-preview',async(req,res)=>{
      hooks.actor(req);
      const controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',disconnected);
      try{
        const result=await this.previewSync(req.body,controller.signal);
        if(!controller.signal.aborted)res.set('Cache-Control','no-store').json(result);
      }catch(error){if(!controller.signal.aborted)throw error;}
      finally{res.off('close',disconnected);}
    });
    app.post('/api/integrations/gitlab/sync',(req:Request,res:Response,next:NextFunction)=>{
      hooks.actor(req);
      const input=record(req.body),includeHistory=historyRequested(input);
      void this.sync((scanned,linked,failed)=>hooks.activity(req,'integration','gitlab','GitLab 재동기화',
        `${scanned}개 항목 확인, ${linked}개 업무 연결${failed?`, 저장소 ${failed}곳 조회 실패`:''}`),
      {includeHistory,expectedVersion:input.expectedVersion,repositoryIds:input.repositoryIds}).then(result=>res.json(result),next);
    });
  }
}
