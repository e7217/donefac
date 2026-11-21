import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { Express,Request,Response,NextFunction } from 'express';
import type { AutomationEvent,AutomationRun,GitlabHistoryLimits,GitlabJiraRoute,GitlabJiraSource,GitlabLink,GitlabMergeReadiness,GitlabRepositorySearch,GitlabSettings,GitlabSyncFailure,GitlabSyncPreview,GitlabSyncPreviewCandidate,GitlabSyncPreviewCounts,GitlabSyncRepositoryFailure,GitlabSyncRepositoryResult,GitlabSyncResult,GitlabWebhookDelivery,GitlabWebhookStatus,Issue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha, isGitlabBranchName, isGitlabManualLinkId, isRestorableGitlabLink } from '../shared/gitlab-links.js';
import { parseGitlabMergeReadiness } from '../shared/gitlab-merge-readiness.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl, gitlabScopedPushUrl, readGitlabHeadPush, type GitlabHeadPush } from './gitlab-push.js';
import { GITLAB_REPOSITORY_SEARCH_MAX_PAGE, GitlabManualUrlError, GitlabReadError, GitlabRepositoryQueryError, readGitlabManualObject, readGitlabRepositorySearch, readGitlabSyncProject } from './gitlab-read-sync.js';
import { GitlabProjectWebhookSetup } from './gitlab-project-webhook-setup.js';
import type { Store } from './store.js';

export class GitlabIntegrationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new GitlabIntegrationError(status,message,details);}
type Obj=Record<string,unknown>;
type RawSettings={baseUrl:string;projectIds:number[];jiraRoutes?:GitlabJiraRoute[];token?:string|null;webhookSecret?:string|null;signingToken?:string|null;version:number;lastSyncAt:string|null;lastError:string|null};
type WebhookResult = { ok: true; duplicate: boolean; linked: number; runs: AutomationRun[] };
type StoredWebhookDelivery = { id: string; delivery: GitlabWebhookDelivery };
type ObjectCursor={id:string;occurredAt:string|null;state:string;receivedAt?:string;approvalRevision?:{updatedAt:string;head:string}};
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
type WorkflowGitlabKind=Extract<GitlabLink['kind'],'merge_request'|'pipeline'>;
type IssueMatch=Pick<Issue,'id'|'key'|'title'|'projectId'>;
type JiraKeyBinding={issueId:string;originalJiraKey:string};
type TicketMatch={issue:IssueMatch;originalJiraKey?:string};
type KeyReader=(...values:unknown[])=>string[];
type TicketMatcher={match:(keys:string[],inherited?:TicketMatch[])=>TicketMatch[];inherit:(link:GitlabLink)=>TicketMatch|undefined;ambiguousKeys:Set<string>};
type MergeObservation=Pick<GitlabMergeReadiness,'source'|'observedAt'>&{invalidate?:boolean};
const approvalActions=new Set(['approval','approved','unapproval','unapproved']);
const PREVIEW_CANDIDATE_LIMIT=100;
const AMBIGUOUS_KEY_LIMIT=20;
const GITLAB_PUSH_COMMIT_LIMIT=20;
const now=()=>new Date().toISOString();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const string=(value:unknown):string=>typeof value==='string'?value:'';
const bound=(value:unknown,max:number):string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:'';
const objectId=(object:Obj):string=>{const id=object.id??object.iid;return typeof id==='number'&&Number.isSafeInteger(id)&&id>0?String(id):typeof id==='string'&&id.trim()?bound(id,200):'';};
function numericObjectId(value:unknown): string {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):'';
  return typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))?value:'';
}
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

function readLink(kind:GitlabLink['kind'],object:Obj,explicitKeys:string[],readKeys:KeyReader=keys,observation?:MergeObservation){
  const id=objectId(object);
  const explicitTitle=string(object.title)||string(object.name);
  const title=explicitTitle||string(object.ref)||string(object.message)||`${kind} #${id}`;
  return {
    id,numericId:numericObjectId(object.id),hasTitle:Boolean(explicitTitle),title:title.slice(0,500),matchedKeys:[...new Set([...readKeys(title,object.description,object.source_branch,object.ref),...explicitKeys])],
    webUrl:validWebUrl(object.web_url||object.url),iid:kind==='commit'?0:Number(object.iid||object.id)||0,reportedIid:Number(numericObjectId(object.iid))||0,
    state:string(object.state)||string(object.status)||'unknown',incomingTime:occurredAt(object.updated_at||object.finished_at||object.created_at),
    sourceBranch:bound(object.source_branch||object.ref,512),sourceSha:bound(object.sha||record(object.last_commit).id,128),
    mergeObservation:kind==='merge_request'&&object.state==='opened'&&observation
      ?{...observation,evidence:parseGitlabMergeReadiness(object,observation.observedAt,observation.source)}:undefined,
  };
}
type LinkDraft=ReturnType<typeof readLink>;
type ProjectReadPlan={
  projectId:number;mergeRequests:LinkDraft[];pipelines:LinkDraft[];
  history?:{branches:LinkDraft[];commits:LinkDraft[];limits:GitlabHistoryLimits};
};
type ProjectReadOutcome={projectId:number;plan:ProjectReadPlan}|{projectId:number;failure:GitlabSyncRepositoryFailure};
function gitlabLinkObjectKey(instance:string,projectId:number,kind:GitlabLink['kind'],id:string):string{
  return `gitlab:${instance}:${projectId}:${kind}:${id}`;
}
function linkForIssue(instance:string,projectId:number,kind:GitlabLink['kind'],match:TicketMatch,draft:LinkDraft):GitlabLink{
  const { id,title,iid,webUrl,state,incomingTime,sourceBranch,sourceSha }=draft;
  const {issue:{id:issueId},originalJiraKey}=match;
  return {id:`${gitlabLinkObjectKey(instance,projectId,kind,id)}:${issueId}`,issueId,projectId,iid,kind,title,webUrl,state,updatedAt:incomingTime||now(),...(sourceBranch?{sourceBranch}:{}),...(sourceSha?{sourceSha}:{}),...(originalJiraKey?{originalJiraKey}:{}),...(draft.mergeObservation?.evidence?{mergeReadiness:draft.mergeObservation.evidence}:{})};
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
      if(link.manualLinkId)return;
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
function sameMergeHead(link:GitlabLink,draft:LinkDraft):boolean{
  return (!link.iid||!draft.reportedIid||link.iid===draft.reportedIid)&&
    (!link.sourceSha||!draft.sourceSha||link.sourceSha===draft.sourceSha)&&
    (!link.sourceBranch||!draft.sourceBranch||link.sourceBranch===draft.sourceBranch);
}
function matchingApprovalTime(cursor:ObjectCursor|undefined,draft:LinkDraft):string|undefined{
  const revision=cursor?.approvalRevision;
  return revision&&draft.state==='opened'&&cursor?.state==='opened'&&
    draft.incomingTime===revision.updatedAt&&gitlabObjectSha(draft.sourceSha)===revision.head
    ?cursor.occurredAt??undefined:undefined;
}
function applyMergeObservation(link:GitlabLink,existing:GitlabLink,draft:LinkDraft,approvalAt?:string):GitlabLink{
  if(link.kind!=='merge_request')return link;
  const prior=existing.mergeReadiness,observation=draft.mergeObservation;
  let evidence=link.state==='opened'?prior:undefined;
  const approvalHead=Boolean(approvalAt)&&approvalAt===existing.updatedAt&&Boolean(draft.sourceSha)&&existing.sourceSha===draft.sourceSha;
  if(link.state==='opened'&&observation&&(draft.incomingTime===link.updatedAt||approvalHead)&&sameMergeHead(link,draft)){
    const metadataAdvanced=link.updatedAt!==existing.updatedAt;
    const headChanged=!sameMergeHead(existing,draft);
    const newer=!prior||observation.observedAt>prior.observedAt||observation.observedAt===prior.observedAt&&
      (metadataAdvanced||observation.source==='webhook'&&prior.source==='read');
    if(newer){
      if(observation.evidence)evidence=observation.evidence;
      else if(prior&&(metadataAdvanced||observation.invalidate||observation.source==='read')){
        evidence={state:'unknown',observedAt:observation.observedAt,source:observation.source};
      }
    }else if(prior&&headChanged&&prior.state!=='unknown'){
      // A changed revision can make the newer observation irrelevant.
      // Keep its clock so a read already in flight cannot restore the displaced finding.
      evidence={...prior,state:'unknown'};
    }
  }
  if(evidence===link.mergeReadiness)return link;
  const next={...link};
  if(evidence)next.mergeReadiness=evidence;
  else delete next.mergeReadiness;
  return next;
}
function matchesManualLink(existing:GitlabLink,draft:LinkDraft):boolean{
  if(existing.kind==='branch')return isGitlabBranchName(draft.sourceBranch)&&existing.sourceBranch===draft.sourceBranch&&draft.id===branchObjectId(draft.sourceBranch);
  if(existing.kind==='commit')return draft.id===draft.sourceSha&&existing.sourceSha===draft.id&&gitlabObjectSha(draft.id)===draft.id;
  return Boolean(draft.numericId&&draft.id===draft.numericId&&(existing.kind!=='merge_request'||existing.iid===draft.iid));
}
function manualTitle(title:string,token:string|null):string{
  return safePreviewValue(title.replace(/[\u0000-\u001f\u007f]/gu,' '),token).slice(0,500).toWellFormed().trim();
}
function refreshExistingLink(existing:GitlabLink,draft:LinkDraft,token:string|null,approvalAt?:string):GitlabLink{
  const next=!draft.incomingTime||keepNewerLink(existing,draft)?existing:{...existing,
    title:draft.hasTitle?manualTitle(draft.title,token)||existing.title:existing.title,
    state:draft.state==='unknown'?existing.state:bound(safePreviewValue(draft.state,token),100)||existing.state,
    updatedAt:draft.incomingTime,
    ...(draft.sourceBranch?{sourceBranch:safePreviewValue(draft.sourceBranch,token).slice(0,512)}:{}),
    ...(draft.sourceSha?{sourceSha:safePreviewValue(draft.sourceSha,token).slice(0,128)}:{}),
  };
  return applyMergeObservation(next,existing,draft,approvalAt);
}
function automaticLinkForAttached(existing:GitlabLink,draft:LinkDraft,originalJiraKey:string|undefined,token:string|null):GitlabLink{
  return promoteAttachedLink(refreshExistingLink(existing,draft,token),originalJiraKey);
}
function promoteAttachedLink(link:GitlabLink,originalJiraKey?:string):GitlabLink{
  const verified={...link};
  delete verified.manualLinkId;
  return originalJiraKey?{...verified,originalJiraKey}:verified;
}
function refreshAttachedBranch(link:GitlabLink, {state,sourceSha,webUrl,updatedAt,branchObservationSource}:Pick<GitlabLink,'state'|'sourceSha'|'webUrl'|'updatedAt'|'branchObservationSource'>):GitlabLink{
  if(branchObservationSource==='sync' && (link.branchObservationSource!=='sync' || Date.parse(link.updatedAt)>Date.parse(updatedAt)))return link;
  if(link.state===state&&link.sourceSha===sourceSha&&link.webUrl===webUrl&&link.branchObservationSource===branchObservationSource)return link;
  const refreshed={...link,state,sourceSha,webUrl,updatedAt};
  if(branchObservationSource===undefined)delete refreshed.branchObservationSource;
  else refreshed.branchObservationSource=branchObservationSource;
  return refreshed;
}
function emptyCounts(includeHistory=false):GitlabSyncPreviewCounts{
  return {mergeRequests:0,pipelines:0,matched:0,unmatched:0,skipped:0,create:0,update:0,unchanged:0,...(includeHistory?{branches:0,commits:0}:{})};
}
function branchHead(branch:unknown,sha:unknown):string|null{
  const ref=bound(branch,512),head=bound(sha,128);
  return ref&&head?JSON.stringify([ref,head]):null;
}
export const branchObjectId=(branch:string)=>createHash('sha256').update(branch).digest('hex');
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

function repositoryBranchDraft(object:Obj, readKeys:KeyReader):LinkDraft{
  const branch=object.name, sha=gitlabObjectSha(record(object.commit).id);
  if(!isGitlabBranchName(branch)||!sha||/^0+$/.test(sha))return readLink('branch',{},[]);
  const draft=readLink('branch',{
    id:branchObjectId(branch),title:branch,source_branch:branch,sha,state:'active',web_url:object.web_url,
  },[],readKeys);
  return {...draft,title:branch,iid:0};
}

function repositoryCommitDraft(object:Obj, readKeys:KeyReader):LinkDraft{
  const sha=gitlabObjectSha(object.id);
  if(!sha||/^0+$/.test(sha))return readLink('commit',{},[]);
  return readLink('commit',{
    id:sha,sha,title:object.title,message:object.message,state:'committed',
    updated_at:object.committed_date,web_url:object.web_url,
  },readKeys(object.title,object.message),readKeys);
}

async function readProjectPlan(connection:SyncConnection,projectId:number,options:ReadOptions):Promise<ProjectReadPlan>{
  const observation={source:'read',observedAt:now()} as const;
  const scan=await readGitlabSyncProject(connection,projectId,options);
  const readKeys=connection.jiraRoutes?.some(route=>route.repositoryId===projectId)?routedKeys:keys;
  const mergeRequests=scan.mergeRequests.map(object=>readLink('merge_request',object,[],readKeys,
    object.target_project_id===undefined||numericObjectId(object.target_project_id)===String(projectId)?observation:undefined));
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
    branches:branches.map(object=>repositoryBranchDraft({...object,web_url:gitlabPushLinkUrl(repository,'tree',string(object.name))},readKeys)),
    commits:commits.map(object=>repositoryCommitDraft({...object,web_url:gitlabPushLinkUrl(repository,'commit',gitlabObjectSha(object.id)??'')},readKeys)),
    limits:{branches:branchesLimited,commits:commitsLimited},
  }};
}

/** GitLab activity reads and explicit project webhook setup use the saved connection. */
export class GitlabIntegrationService{
  // Branch list snapshots have no revision number for reconciling overlapping manual scans.
  private historySyncActive=false;
  // A verified branch read can race its first webhook before a link exists.
  private readonly pendingBranchReads=new Map<string,{count:number;webUrl:string}>();
  private readonly manualLinkRows:StatementSync;
  private readonly linkedMergeRequestRows:StatementSync;
  private readonly projectWebhooks: GitlabProjectWebhookSetup;
  constructor(private readonly store:Store,private readonly hooks:Hooks,webhookPublicOrigin?:string){
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_object_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_branch_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_push_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_webhook_deliveries(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gitlab_links_manual ON gitlab_links(id) WHERE json_extract(json,'$.manualLinkId') IS NOT NULL;`);
    this.manualLinkRows=store.db.prepare(`SELECT json FROM gitlab_links WHERE id>=? AND id<?
      AND json_extract(json,'$.manualLinkId') IS NOT NULL`);
    this.linkedMergeRequestRows=store.db.prepare('SELECT json FROM gitlab_links WHERE id>=? AND id<?');
    this.projectWebhooks = new GitlabProjectWebhookSetup(store, () => {
      const saved = this.raw();
      const authMode = saved.signingToken ? 'signature' : saved.webhookSecret ? 'secret' : null;
      return { baseUrl: saved.baseUrl, version: saved.version, projectIds: saved.projectIds, authMode,
        readToken: () => saved.token ? this.store.unseal(saved.token) : null,
        matchesCredential: value => this.sameWebhookCredential(authMode === 'signature' ? saved.signingToken : saved.webhookSecret, value),
      };
    }, webhookPublicOrigin);
  }
  private raw():RawSettings{const value=record(this.store.setting('gitlab'));return{baseUrl:string(value.baseUrl),projectIds:Array.isArray(value.projectIds)?value.projectIds as number[]:[],...(Array.isArray(value.jiraRoutes)&&value.jiraRoutes.length?{jiraRoutes:value.jiraRoutes as GitlabJiraRoute[]}:{}),token:typeof value.token==='string'?value.token:null,webhookSecret:typeof value.webhookSecret==='string'?value.webhookSecret:null,signingToken:typeof value.signingToken==='string'?value.signingToken:null,version:Number.isSafeInteger(value.version)&&Number(value.version)>0?Number(value.version):1,lastSyncAt:typeof value.lastSyncAt==='string'?value.lastSyncAt:null,lastError:typeof value.lastError==='string'?value.lastError:null};}
  private public(raw:RawSettings):GitlabSettings{return{baseUrl:raw.baseUrl,projectIds:raw.projectIds,tokenConfigured:!!raw.token,webhookSecretConfigured:!!raw.webhookSecret,signingTokenConfigured:!!raw.signingToken,version:raw.version,lastSyncAt:raw.lastSyncAt,lastError:raw.lastError,...(raw.jiraRoutes?.length?{jiraRoutes:raw.jiraRoutes}:{}),...(this.projectWebhooks.receiverUrl?{webhookReceiverUrl:this.projectWebhooks.receiverUrl}:{})};}
  settings():GitlabSettings{return this.public(this.raw());}
  webhookStatus(): GitlabWebhookStatus {
    const settings = this.raw();
    const deliveries = new Map(this.store.all<StoredWebhookDelivery>('gitlab_webhook_deliveries').map(({ id, delivery }) => [id, delivery]));
    return {
      settingsVersion: settings.version,
      repositories: settings.projectIds.map(repositoryId => ({ repositoryId, lastDelivery: deliveries.get(String(repositoryId)) ?? null })),
    };
  }
  private jiraSources():GitlabJiraSource[]{return this.hooks.jiraSources?.()??[];}
  private submittedJiraRoutes(input:Obj,old:RawSettings,address:string,repositories:number[]):GitlabJiraRoute[]{
    if(Object.hasOwn(input,'jiraRoutes'))return parseJiraRoutes(input.jiraRoutes,repositories,this.jiraSources());
    return address===old.baseUrl?(old.jiraRoutes??[]).filter(route=>repositories.includes(route.repositoryId)):[];
  }
  private instance(raw:Pick<RawSettings,'baseUrl'>=this.raw()):string{return createHash('sha256').update(raw.baseUrl).digest('hex').slice(0,12);}
  private requireIssue(issueId:string):Issue{
    return this.store.get<Issue>('issues',issueId)??fail('업무를 찾을 수 없습니다.',404);
  }
  async attachLink(issueId:string,value:unknown,afterAttach?:(link:GitlabLink)=>void,signal?:AbortSignal):Promise<{link:GitlabLink;created:boolean}>{
    const input=record(value);
    if(Object.keys(input).some(key=>!['repositoryId','url','expectedSettingsVersion','actorId'].includes(key)))fail('GitLab 활동 연결 요청을 확인해 주세요.');
    const captured=this.raw();
    assertSettingsVersion(input.expectedSettingsVersion,captured.version);
    const repositoryId=input.repositoryId;
    if(typeof repositoryId!=='number'||!Number.isSafeInteger(repositoryId)||repositoryId<1)fail('GitLab 저장소를 선택해 주세요.');
    if(!captured.baseUrl||!captured.projectIds.includes(repositoryId))fail('허용된 GitLab 저장소를 선택해 주세요.',403);
    const issue=this.requireIssue(issueId);
    const token=captured.token?this.store.unseal(captured.token):null;
    const startedAt=now();
    const instance=this.instance(captured);
    let pendingBranchId:string|undefined;
    let branchCursorBeforeRead:PushObservation|undefined;
    let verified:Awaited<ReturnType<typeof readGitlabManualObject>>;
    try {
      verified=await readGitlabManualObject({baseUrl:captured.baseUrl,token},repositoryId,input.url,signal,(name,webUrl)=>{
        if(token&&(name.includes(token)||webUrl.includes(token)))fail('GitLab 활동의 주소를 확인할 수 없습니다.',502);
        const id=pushCursorId(instance,repositoryId,name);
        const pending=this.pendingBranchReads.get(id);
        this.pendingBranchReads.set(id,{count:(pending?.count??0)+1,webUrl});
        pendingBranchId=id;
        branchCursorBeforeRead=this.store.get<PushObservation>('gitlab_push_cursors',id);
      });
    } catch(error) {
      signal?.throwIfAborted();
      assertSettingsVersion(captured.version,this.raw().version);
      if(error instanceof GitlabManualUrlError)fail(error.message,400);
      if(error instanceof GitlabReadError)fail(error.message,error.httpStatus===404?404:502,{stage:error.stage,httpStatus:error.httpStatus});
      throw error;
    } finally {
      if(pendingBranchId){
        const pending=this.pendingBranchReads.get(pendingBranchId)!;
        if(pending.count===1)this.pendingBranchReads.delete(pendingBranchId);
        else pending.count--;
      }
    }
    signal?.throwIfAborted();
    const {kind,object,webUrl}=verified;
    if(token&&webUrl.includes(token))fail('GitLab 활동의 주소를 확인할 수 없습니다.',502);
    const data={...object,web_url:webUrl};
    const draft=kind==='branch'?repositoryBranchDraft(data,keys):kind==='commit'?repositoryCommitDraft(data,keys):readLink(kind,{
      ...data,iid:kind==='merge_request'?object.iid:Number(numericObjectId(object.iid)||numericObjectId(object.id)),
    },[],keys,{source:'read',observedAt:startedAt});
    if(!draft.id||!draft.webUrl)fail('GitLab 활동의 저장 정보를 확인할 수 없습니다.',502);
    return this.store.transaction(()=>{
      assertSettingsVersion(captured.version,this.raw().version);
      const currentIssue=this.requireIssue(issueId);
      if(currentIssue.projectId!==issue.projectId)fail('업무가 다른 프로젝트로 이동했습니다. 최신 업무에서 다시 연결해 주세요.',409);
      const snapshot=linkForIssue(instance,repositoryId,kind,{issue:currentIssue},draft);
      const existing=this.store.get<GitlabLink>('gitlab_links',snapshot.id);
      if(existing&&!existing.manualLinkId)return {link:existing,created:false};
      if(existing&&!matchesManualLink(existing,draft))fail('저장한 GitLab 활동의 식별자와 일치하지 않습니다.',409);
      const link=kind==='branch'
        ?this.verifiedBranchAttachment(instance,snapshot,existing,startedAt,branchCursorBeforeRead)
        :kind==='commit'
          ?existing??{...snapshot,title:manualTitle(snapshot.title,token)||`commit #${snapshot.sourceSha}`,manualLinkId:randomUUID()}
          :this.verifiedWorkflowAttachment(kind,instance,snapshot,draft,existing,token,startedAt);
      if(link!==existing){
        if(!isRestorableGitlabLink(link))fail('GitLab 활동의 저장 정보를 확인할 수 없습니다.',502);
        this.store.put('gitlab_links',link);
      }
      if(!existing)afterAttach?.(link);
      return {link,created:!existing};
    });
  }
  private verifiedBranchAttachment(instance:string,snapshot:GitlabLink,existing:GitlabLink|undefined,startedAt:string,before?:PushObservation):GitlabLink{
    const cursor=this.store.get<PushObservation>('gitlab_push_cursors',pushCursorId(instance,snapshot.projectId,snapshot.sourceBranch!));
    if(cursor&&(cursor.state!=='active'||cursor.sourceSha!==snapshot.sourceSha)){
      const changedDuringRead=cursor.state!==before?.state||cursor.sourceSha!==before?.sourceSha||cursor.updatedAt!==before?.updatedAt;
      if(existing&&(changedDuringRead||Date.parse(cursor.updatedAt)>Date.parse(startedAt)))return existing;
      fail('GitLab에서 조회한 브랜치 HEAD가 마지막으로 확인한 푸시 기록과 다릅니다.',409);
    }
    const sample:GitlabLink=cursor?{...snapshot,updatedAt:cursor.updatedAt}:{...snapshot,branchObservationSource:'sync',updatedAt:startedAt};
    return existing?refreshAttachedBranch(existing,sample):{...sample,manualLinkId:randomUUID()};
  }
  private verifiedWorkflowAttachment(kind:WorkflowGitlabKind,instance:string,snapshot:GitlabLink,draft:LinkDraft,existing:GitlabLink|undefined,token:string|null,startedAt:string):GitlabLink{
    const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${snapshot.projectId}:${kind}:${draft.id}`);
    const cursorTime=Date.parse(cursor?.occurredAt??''),readTime=Date.parse(draft.incomingTime??'');
    const webhookDuringRead=kind==='merge_request'&&Date.parse(cursor?.receivedAt??'')>=Date.parse(startedAt);
    const approvalAt=kind==='merge_request'&&existing?matchingApprovalTime(cursor,draft):undefined;
    const approvalRead=Boolean(approvalAt)&&approvalAt===existing?.updatedAt;
    if(webhookDuringRead||!approvalRead&&Number.isFinite(cursorTime)&&(!Number.isFinite(readTime)||cursorTime>readTime||cursorTime===readTime&&cursor?.state!==draft.state)){
      if(existing)return existing;
      fail('방금 GitLab 활동 상태가 변경되었습니다. 다시 확인해 주세요.',409);
    }
    const {sourceBranch,sourceSha,...identity}=snapshot;
    const verified:GitlabLink=existing?refreshExistingLink(existing,draft,token,approvalAt):{...identity,manualLinkId:randomUUID(),
      title:manualTitle(snapshot.title,token)||`GitLab #${snapshot.iid}`,
      state:bound(safePreviewValue(snapshot.state,token),100)||'unknown',
      ...(sourceBranch?{sourceBranch:safePreviewValue(sourceBranch,token).slice(0,512)}:{}),
      ...(sourceSha?{sourceSha:safePreviewValue(sourceSha,token).slice(0,128)}:{}),
    };
    return verified.webUrl===snapshot.webUrl?verified:{...verified,webUrl:snapshot.webUrl};
  }
  removeAttachedLink(issueId:string,linkId:string,expectedManualLinkId:unknown,afterRemove?:(link:GitlabLink)=>void):void{
    if(!isGitlabManualLinkId(expectedManualLinkId))fail('해제할 GitLab 수동 연결을 다시 선택해 주세요.');
    this.store.transaction(()=>{
      this.requireIssue(issueId);
      const link=this.store.get<GitlabLink>('gitlab_links',linkId);
      if(link?.issueId!==issueId)fail('업무의 GitLab 활동 연결을 찾을 수 없습니다.',404);
      if(!link.manualLinkId)fail('이 활동은 업무 번호로 자동 연결되었습니다.',409);
      if(link.manualLinkId!==expectedManualLinkId)fail('GitLab 연결이 변경되었습니다. 최신 활동을 확인해 주세요.',409);
      this.store.remove('gitlab_links',linkId);
      afterRemove?.(link);
    });
  }
  configure(value:unknown,afterSave?:(settings:GitlabSettings)=>void):GitlabSettings{return this.store.transaction(()=>{
    const input=record(value),old=this.raw();assertSettingsVersion(input.expectedVersion,old.version);const next={...old};
    if('baseUrl'in input)next.baseUrl=baseUrl(input.baseUrl);
    if(next.baseUrl!==old.baseUrl){next.token=null;next.lastSyncAt=null;next.lastError=null;}
    if('projectIds'in input)next.projectIds=projectIds(input.projectIds);
    const jiraRoutes=this.submittedJiraRoutes(input,old,next.baseUrl,next.projectIds);
    if(jiraRoutes.length)next.jiraRoutes=jiraRoutes;
    else delete next.jiraRoutes;
    let webhookCredentialsChanged = false;
    for (const field of ['token', 'webhookSecret', 'signingToken'] as const) {
      if (!Object.hasOwn(input, field)) continue;
      const submitted = credential(input[field]);
      if (submitted && field === 'signingToken') signingKey(submitted);
      if (field !== 'token') {
        if (this.sameWebhookCredential(old[field], submitted)) continue;
        webhookCredentialsChanged = true;
      }
      next[field] = submitted ? this.store.seal(submitted) : null;
    }
    this.invalidateWebhookDeliveries(old, next, webhookCredentialsChanged);
    next.version=old.version+1;this.store.setSetting('gitlab',next);this.hooks.onConnectionChanged(this.public(old),this.public(next));afterSave?.(this.public(next));return this.public(next);
  });}
  private sameWebhookCredential(stored: string | null | undefined, submitted: string): boolean {
    if (!stored) return !submitted;
    if (!submitted) return false;
    try { return constantEqual(this.store.unseal(stored), submitted); }
    catch { return false; }
  }
  private invalidateWebhookDeliveries(previous: RawSettings, next: RawSettings, credentialsChanged: boolean): void {
    if (previous.baseUrl !== next.baseUrl || credentialsChanged) {
      this.store.db.exec('DELETE FROM gitlab_webhook_deliveries');
      return;
    }
    const allowed = new Set(next.projectIds);
    const previousRoutes = new Map((previous.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    const nextRoutes = new Map((next.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    for (const id of previous.projectIds) {
      if (!allowed.has(id) || previousRoutes.get(id) !== nextRoutes.get(id)) this.store.remove('gitlab_webhook_deliveries', String(id));
    }
  }
  resetForImport(branchLinks: Iterable<GitlabLink> = []): void {
    this.store.db.exec('DELETE FROM webhook_inbox;DELETE FROM gitlab_object_cursors;DELETE FROM gitlab_branch_cursors;DELETE FROM gitlab_push_cursors;DELETE FROM gitlab_webhook_deliveries;');
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
  private authenticate(req:Request,raw:RawSettings):GitlabWebhookDelivery['authentication']{
    if(req.headers['webhook-signature']!==undefined){
      if(!raw.signingToken)fail('Webhook 서명 인증에 실패했습니다.',401);
      const id=req.header('webhook-id')||'',timestamp=req.header('webhook-timestamp')||'',signature=req.header('webhook-signature')||'',body=(req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody;
      if(!id||id.length>200||!/^\d{1,16}$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300||!body||signature.length>2048)fail('Webhook 서명 또는 발생 시각을 확인할 수 없습니다.',401);
      const expected=createHmac('sha256',signingKey(this.store.unseal(raw.signingToken))).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`),body])).digest();let valid=false;
      for(const part of signature.split(/\s+/)){const[version,encoded]=part.split(',');if(version!=='v1'||!encoded)continue;const received=Buffer.from(encoded,'base64');if(received.length===expected.length&&received.toString('base64')===encoded&&timingSafeEqual(received,expected))valid=true;}
      if(!valid)fail('Webhook 서명 인증에 실패했습니다.',401);return 'signing-token';
    }
    if(!raw.webhookSecret){if(raw.signingToken)fail('Webhook 서명이 필요합니다.',401);fail('Webhook 인증이 설정되지 않았습니다.',503);}
    if(!constantEqual(this.store.unseal(raw.webhookSecret),req.header('X-Gitlab-Token')||''))fail('Webhook 인증에 실패했습니다.',401);
    return 'secret-token';
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
  private manualLinksForKey(instance:string,projectId:number,kind:GitlabLink['kind'],objectId:string):GitlabLink[]{
    const key=gitlabLinkObjectKey(instance,projectId,kind,objectId);
    const rows=this.manualLinkRows.all(`${key}:`,`${key};`) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as GitlabLink).filter(link=>
      link.id===`${key}:${link.issueId}`&&link.kind===kind&&link.projectId===projectId);
  }
  private manualLinksForObject(instance:string,projectId:number,kind:GitlabLink['kind'],draft:LinkDraft):GitlabLink[]{
    if(kind!=='branch'&&kind!=='commit'&&(!draft.numericId||draft.id!==draft.numericId))return[];
    return this.manualLinksForKey(instance,projectId,kind,draft.id).filter(link=>matchesManualLink(link,draft));
  }
  private existingAutomaticMergeRequests(instance:string,projectId:number,draft:LinkDraft,matcher:TicketMatcher){
    if(!draft.numericId||draft.id!==draft.numericId)return [];
    const key=gitlabLinkObjectKey(instance,projectId,'merge_request',draft.numericId);
    const rows=this.linkedMergeRequestRows.all(`${key}:`,`${key};`) as {json:string}[];
    return rows.flatMap(row=>{
      const link=JSON.parse(row.json) as GitlabLink;
      if(link.id!==`${key}:${link.issueId}`||link.kind!=='merge_request'||link.projectId!==projectId||
         draft.reportedIid&&link.iid!==draft.reportedIid)return [];
      const match=matcher.inherit(link);
      return match?[{link,match}]:[];
    });
  }
  private upsert(instance:string,projectId:number,kind:WorkflowGitlabKind,draft:LinkDraft,matches:TicketMatch[],preserveExisting:boolean,token:string|null):number{
    let linked=0;
    for(const match of matches){
      const link=linkForIssue(instance,projectId,kind,match,draft);
      const existing=this.store.get<GitlabLink>('gitlab_links',link.id);
      if(preserveExisting&&existing)continue;
      if(existing?.manualLinkId){
        if(!matchesManualLink(existing,draft))continue;
        this.store.put('gitlab_links',automaticLinkForAttached(existing,draft,match.originalJiraKey,token));
      }else{
        if(!draft.webUrl)continue;
        let next=retainOriginalJiraKey(link,existing);
        if(kind==='merge_request'&&existing){
          if(keepNewerLink(existing,draft))next=existing;
          next=applyMergeObservation(next,existing,draft);
          if(next===existing)continue;
        }
        this.store.put('gitlab_links',next);
      }
      linked++;
    }
    return linked;
  }
  private observeBranch(baseUrl: string, instance: string, projectId: number, head: GitlabHeadPush, repository: URL | null, matches: TicketMatch[]): number {
    const objectId = branchObjectId(head.branch);
    const id = gitlabLinkObjectKey(instance, projectId, 'branch', objectId);
    const attached = this.manualLinksForKey(instance, projectId, 'branch', objectId).filter(link=>link.sourceBranch===head.branch);
    const pending = this.pendingBranchReads.get(id);
    let previous = this.store.get<PushObservation>('gitlab_push_cursors', id);
    let snapshotUrl: string | undefined;
    if (!previous) {
      // Native backups contain branch links without transient webhook cursors.
      const storedLinks=matches.map(({issue:{id:issueId}})=>this.store.get<GitlabLink>('gitlab_links',`${id}:${issueId}`));
      const persisted=[...storedLinks,...attached].flatMap(prior=>{
        if(prior?.branchObservationSource==='sync')snapshotUrl??=prior.webUrl;
        const observed=prior&&pushObservationFromLink(prior);
        return observed?[observed]:[];
      });
      previous = persisted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    }
    const archived = !previous && !matches.length && !attached.length ? this.hooks.findArchivedBranchLink?.(id) : undefined;
    if (archived) previous = pushObservationFromLink(archived) ?? undefined;
    if (!previous && !matches.length && !attached.length && !pending && !archived) return 0;
    const latestAttached = [...attached, ...(archived?.manualLinkId ? [archived] : [])].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
    const baseline = previous ?? (latestAttached && pushObservationFromLink(latestAttached,true));
    const lastHead = baseline?.state === 'deleted' ? '0'.repeat(baseline.sourceSha.length) : baseline?.sourceSha;
    const sameHead = lastHead === head.after;
    if (lastHead !== undefined && !sameHead && lastHead !== head.before) return 0;

    const treeUrl = repository && gitlabPushLinkUrl(repository, 'tree', head.branch);
    const webUrl = treeUrl || gitlabScopedPushUrl(baseUrl, previous?.webUrl ?? snapshotUrl ?? pending?.webUrl ?? archived?.webUrl);
    if (!webUrl) return 0;
    const observation: PushObservation = sameHead && previous ? { ...previous, webUrl } : {
      id, state: head.deleted ? 'deleted' : 'active', sourceSha: head.deleted ? head.before : head.after, webUrl, updatedAt: now(),
    };
    this.store.put('gitlab_push_cursors', observation);
    let linked = 0;
    const matchedIds = new Set<string>();
    for (const {issue:{id:issueId},originalJiraKey} of matches) {
      matchedIds.add(issueId);
      const link: GitlabLink = { ...observation, id: `${id}:${issueId}`, issueId, projectId, iid: 0, kind: 'branch', title: head.branch, sourceBranch: head.branch, ...(originalJiraKey?{originalJiraKey}:{}) };
      const existing = this.store.get<GitlabLink>('gitlab_links', link.id);
      const next=retainOriginalJiraKey(link,existing);
      if (existing?.state === next.state && !existing.manualLinkId && !existing.branchObservationSource && existing.sourceSha === next.sourceSha && existing.webUrl === next.webUrl && existing.originalJiraKey === next.originalJiraKey) continue;
      this.store.put('gitlab_links', next);
      linked++;
    }
    for(const prior of attached){
      if(matchedIds.has(prior.issueId))continue;
      const next=refreshAttachedBranch(prior,observation);
      if(next===prior)continue;
      this.store.put('gitlab_links',next);
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
    if (!head && !commits.length) return 0;

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
          if(existing.manualLinkId){
            if(!matchesManualLink(existing,draft))continue;
            const promoted=promoteAttachedLink(existing,link.originalJiraKey);
            this.store.put('gitlab_links',{...promoted,...(!promoted.sourceBranch&&link.sourceBranch?{sourceBranch:link.sourceBranch}:{})});
            linked++;
            continue;
          }
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
  webhook(req:Request):WebhookResult{
    const raw=this.raw(),authentication=this.authenticate(req,raw);const body=record(req.body),project=record(body.project),projectId=Number(project.id??body.project_id);if(!raw.projectIds.includes(projectId))fail('허용된 저장소가 아닙니다.',403);
    const header=req.header('X-Gitlab-Event')||'',kind=string(body.object_kind)||({'Merge Request Hook':'merge_request','Pipeline Hook':'pipeline','Push Hook':'push','Tag Push Hook':'tag_push'} as Record<string,string>)[header]||'';
    const attributes=record(body.object_attributes),instance=this.instance(raw),externalId=req.header('webhook-id')||req.header('Idempotency-Key')||req.header('X-Gitlab-Event-UUID')||createHash('sha256').update((req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody||Buffer.from(JSON.stringify(body))).digest('hex');if(externalId.length>500)fail('Webhook 식별자가 너무 깁니다.');const eventId=`gitlab:${instance}:${projectId}:${kind}:${createHash('sha256').update(externalId).digest('hex')}`;
    const receivedAt = now();
    const processWebhook = (): WebhookResult => {
      if(this.store.db.prepare('SELECT id FROM webhook_inbox WHERE id=?').get(eventId))return{ok:true,duplicate:true,linked:0,runs:[]};
      this.store.db.prepare('INSERT INTO webhook_inbox(id,created_at) VALUES(?,?)').run(eventId,now());
      if(kind==='push'||kind==='tag_push')return{ok:true,duplicate:false,linked:this.recordPush(raw,instance,projectId,kind,body,project),runs:[]};
      if(kind!=='merge_request'&&kind!=='pipeline')return{ok:true,duplicate:false,linked:0,runs:[]};
      const id=objectId(attributes),state=string(attributes.state)||string(attributes.status)||'unknown',branch=bound(kind==='merge_request'?attributes.source_branch:attributes.ref,512),sha=bound(attributes.sha||record(attributes.last_commit).id||record(body.commit).id,128);
      const action=string(attributes.action);
      const mergeRepositoryMatches=kind==='merge_request'&&(attributes.target_project_id===undefined||numericObjectId(attributes.target_project_id)===String(projectId));
      const time=occurredAt(kind==='merge_request'?(attributes.actioned_at||attributes.updated_at):(attributes.finished_at||attributes.updated_at||attributes.created_at));
      const cursorId=`${instance}:${projectId}:${kind}:${id}`,prior=id?this.store.get<ObjectCursor>('gitlab_object_cursors',cursorId):undefined;let disposition:AutomationEvent['disposition']='fresh',reason='';
      if(!id||!time){disposition='unverified';reason='이벤트 식별자 또는 유효한 과거 발생 시각을 확인할 수 없습니다.';}
      else if(prior?.occurredAt){const difference=Date.parse(time)-Date.parse(prior.occurredAt);if(difference<0){disposition='stale';reason='이 객체의 최신 수신 이벤트보다 오래된 이벤트입니다.';}else if(difference===0){disposition=state===prior.state?'stale':'ambiguous';reason=state===prior.state?'같은 발생 시각·상태의 이벤트를 이미 반영했습니다.':'같은 발생 시각의 상태가 서로 달라 적용하지 않았습니다.';}}
      const objectDisposition=disposition;
      if(id&&(disposition==='fresh'||!prior)){
        const updatedAt=occurredAt(attributes.updated_at),head=gitlabObjectSha(attributes.sha||record(attributes.last_commit).id);
        const approvalRevision=mergeRepositoryMatches&&state==='opened'&&approvalActions.has(action)&&time&&updatedAt&&updatedAt<time&&head
          ?{updatedAt,head}:undefined;
        this.store.put('gitlab_object_cursors',{id:cursorId,occurredAt:time,state,receivedAt:now(),...(approvalRevision?{approvalRevision}:{})} satisfies ObjectCursor);
      }
      if(kind==='pipeline'&&branch){const numericId=Number(id),branchId=`${instance}:${projectId}:${branch}`,latest=this.store.get<BranchCursor>('gitlab_branch_cursors',branchId);if(Number.isSafeInteger(numericId)&&numericId>0){if(latest&&numericId<latest.pipelineId){disposition='stale';reason='이 브랜치에 더 최근에 생성된 파이프라인이 있어 이전 결과를 적용하지 않았습니다.';}else if(objectDisposition==='fresh'&&time&&(!latest||numericId>latest.pipelineId))this.store.put('gitlab_branch_cursors',{id:branchId,pipelineId:numericId} satisfies BranchCursor);}else{disposition='unverified';reason='파이프라인 순서를 확인할 수 없습니다.';}}
      const route=raw.jiraRoutes?.find(candidate=>candidate.repositoryId===projectId),readKeys=route?routedKeys:keys;
      const issues=this.syncIssues(),matcher=this.ticketMatcher(issues,route);
      const mergeRequest=record(body.merge_request),extra=readKeys(mergeRequest.title,mergeRequest.description,mergeRequest.source_branch,record(body.commit).message,...(Array.isArray(body.commits)?body.commits.map(commit=>record(commit).message):[]));
      const inherited=kind==='pipeline'?this.inheritedMatches(projectId,branch,sha,instance,matcher):[];
      const object={...attributes,...(time?{updated_at:time}:{}),...(branch?{source_branch:branch}:{}),...(sha?{sha}:{}),web_url:attributes.web_url||attributes.url||(kind==='pipeline'&&project.web_url?`${project.web_url}/-/pipelines/${id}`:'')};
      const invalidate=Boolean(attributes.oldrev)||action==='reopen'||approvalActions.has(action);
      const observation:MergeObservation|undefined=mergeRepositoryMatches&&objectDisposition==='fresh'&&time?{source:'webhook',observedAt:time,invalidate}:undefined;
      const draft=readLink(kind,object,extra,readKeys,observation),canUpsert=objectDisposition==='fresh'||objectDisposition==='unverified';
      const direct=canUpsert?draft.matchedKeys:readKeys(attributes.title,attributes.description,branch,attributes.ref,...extra);
      const byMatchId=new Map((id?matcher.match(direct,inherited):[]).map(match=>[match.issue.id,match]));
      const matches=issues.flatMap(issue=>{const match=byMatchId.get(issue.id);return match?[match]:[];});
      const attached=objectDisposition==='fresh'?this.manualLinksForObject(instance,projectId,kind,draft):[];
      const token=attached.length&&raw.token?this.store.unseal(raw.token):null;
      let linked=canUpsert?this.upsert(instance,projectId,kind,draft,matches,objectDisposition==='unverified',token):0;
      for(const prior of attached){
        if(byMatchId.has(prior.issueId))continue;
        const updated=refreshExistingLink(prior,draft,token);
        if(updated===prior)continue;
        this.store.put('gitlab_links',updated);
        linked++;
      }
      if(mergeRepositoryMatches&&objectDisposition==='fresh'){
        for(const {link:prior} of this.existingAutomaticMergeRequests(instance,projectId,draft,matcher)){
          if(draft.webUrl&&byMatchId.has(prior.issueId))continue;
          const updated=refreshExistingLink(prior,draft,null);
          if(updated===prior)continue;
          this.store.put('gitlab_links',updated);
          linked++;
        }
      }
      const issueIds=matches.map(match=>match.issue.id);
      const trigger=kind==='merge_request'?({open:'merge_request.opened',reopen:'merge_request.opened',merge:'merge_request.merged',close:'merge_request.closed'} as Record<string,AutomationEvent['trigger']>)[action]:({success:'pipeline.succeeded',failed:'pipeline.failed'} as Record<string,AutomationEvent['trigger']>)[state];
      const runs=trigger?this.hooks.processEvent({id:eventId,trigger,gitlabProjectId:projectId,objectKind:kind,objectId:id,branch,issueIds,occurredAt:time,receivedAt:now(),disposition,reason}):[];
      return{ok:true,duplicate:false,linked,runs};
    };
    return this.store.transaction(() => {
      const result = processWebhook();
      const event = kind === 'push' || kind === 'tag_push' || kind === 'merge_request' || kind === 'pipeline' ? kind : 'other';
      const { duplicate, linked, runs } = result;
      const delivery: GitlabWebhookDelivery = { event, authentication, receivedAt, duplicate, linked, automationRuns: runs.length };
      this.store.put('gitlab_webhook_deliveries', { id: String(projectId), delivery } satisfies StoredWebhookDelivery);
      return result;
    });
  }
  private visitProjectLinks(
    instance:string,plan:ProjectReadPlan,startedAt:number,matcher:TicketMatcher,token:string|null,
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
      if(!draft.id){counts.skipped++;continue;}
      let observation:PushObservation|undefined;
      let approvalAt:string|undefined;
      if(kind==='branch'||kind==='commit'){
        const identity=`${kind}:${draft.id}`;
        if(kind==='branch')observation=this.store.get<PushObservation>('gitlab_push_cursors',`gitlab:${instance}:${projectId}:branch:${draft.id}`);
        if(seenHistory.has(identity)||observation&&(observation.state!=='active'||observation.sourceSha!==draft.sourceSha)){
          counts.skipped++;continue;
        }
        seenHistory.add(identity);
      }else{
        const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${projectId}:${kind}:${draft.id}`);
        const inconsistentMergeState=kind==='merge_request'&&Boolean(cursor?.occurredAt)&&cursor?.occurredAt===draft.incomingTime&&cursor?.state!==draft.state;
        const cursorNewer=Boolean(cursor?.occurredAt&&(!draft.incomingTime||Date.parse(cursor.occurredAt)>Date.parse(draft.incomingTime)));
        if(kind==='merge_request'&&cursorNewer)approvalAt=matchingApprovalTime(cursor,draft);
        if(cursor&&(Date.parse(cursor.receivedAt||'')>=startedAt||inconsistentMergeState||cursorNewer&&!approvalAt)){
          counts.skipped++;continue;
        }
      }
      const attached=this.manualLinksForObject(instance,projectId,kind,draft).map(link=>planned.get(link.id)??link).filter(link=>link.manualLinkId);
      const known=kind==='merge_request'?this.existingAutomaticMergeRequests(instance,projectId,draft,matcher):[];
      if(!draft.webUrl&&!attached.length&&!known.length){counts.skipped++;continue;}
      const attachedIssueIds=new Set(attached.map(link=>link.issueId));
      const targets=matcher.match(draft.matchedKeys).filter(match=>Boolean(draft.webUrl)||attachedIssueIds.has(match.issue.id));
      // A sampled branch can add a scoped Jira link to the exact authenticated head without replacing that observation.
      const matched=observation?targets.filter(target=>target.originalJiraKey||attachedIssueIds.has(target.issue.id)):targets;
      if(observation&&!matched.length&&!attached.length){counts.skipped++;continue;}
      if(!matched.length&&!attached.length&&!known.length){counts.unmatched++;continue;}
      counts.matched++;
      const matchedIssueIds=new Set(matched.map(match=>match.issue.id));
      for(const match of matched){
        const link=linkForIssue(instance,projectId,kind,match,draft);
        if(observation){
          const {state,sourceSha,webUrl,updatedAt}=observation;
          Object.assign(link,{state,sourceSha,webUrl,updatedAt});
        }else if(kind==='branch')link.branchObservationSource='sync';
        const existing=planned.get(link.id)??this.store.get<GitlabLink>('gitlab_links',link.id);
        if(approvalAt){
          if(existing){
            const next=applyMergeObservation(existing,existing,draft,approvalAt);
            const action=next===existing?'unchanged':'update';
            counts[action]++;
            planned.set(next.id,next);
            visit(next,match,action,kind,draft.id);
          }
          continue;
        }
        if(existing?.manualLinkId){
          if(!matchesManualLink(existing,draft))continue;
          const next=kind==='branch'
            ?promoteAttachedLink(refreshAttachedBranch(existing,{...link,updatedAt:observation?.updatedAt??new Date(startedAt).toISOString()}),match.originalJiraKey)
            :kind==='commit'?promoteAttachedLink(existing,match.originalJiraKey):automaticLinkForAttached(existing,draft,match.originalJiraKey,token);
          counts.update++;
          planned.set(link.id,next);
          visit(next,match,'update',kind,draft.id);
          continue;
        }
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
        if(kind==='merge_request'&&existing){
          next=applyMergeObservation(next,existing,draft);
          if(next!==existing)action='update';
        }
        counts[action]++;
        if(action!=='unchanged')planned.set(link.id,next);
        visit(next,match,action,kind,draft.id);
      }
      for(const prior of attached){
        if(matchedIssueIds.has(prior.issueId))continue;
        const issue=this.store.get<Issue>('issues',prior.issueId);
        if(!issue)continue;
        const next=kind==='branch'
          ?refreshAttachedBranch(prior,observation??{state:draft.state,sourceSha:draft.sourceSha,webUrl:draft.webUrl,updatedAt:new Date(startedAt).toISOString(),branchObservationSource:'sync'})
          :kind==='commit'?prior:refreshExistingLink(prior,draft,token,approvalAt);
        const action=next===prior?'unchanged':'update';
        counts[action]++;
        if(action==='update')planned.set(next.id,next);
        visit(next,{issue},action,kind,draft.id);
      }
      for(const {link,match} of known){
        if(matchedIssueIds.has(link.issueId))continue;
        const prior=planned.get(link.id)??link;
        const next=refreshExistingLink(prior,draft,null,approvalAt);
        const action=next===prior?'unchanged':'update';
        counts[action]++;
        if(action==='update')planned.set(next.id,next);
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

  private draftReadToken(input: Obj, address: string, saved: RawSettings): string | null {
    if (Object.hasOwn(input, 'token')) return credential(input.token);
    return address === saved.baseUrl && saved.token ? this.store.unseal(saved.token) : null;
  }

  async searchRepositories(value: unknown, signal?: AbortSignal): Promise<GitlabRepositorySearch> {
    const input = record(value);
    if (Object.keys(input).some(key => !['expectedVersion', 'baseUrl', 'token', 'query', 'page'].includes(key))) {
      fail('지원하지 않는 GitLab 저장소 검색 요청입니다.');
    }
    const saved = this.raw();
    assertSettingsVersion(input.expectedVersion, saved.version);
    const address = Object.hasOwn(input, 'baseUrl') ? baseUrl(input.baseUrl) : saved.baseUrl;
    if (!address) fail('GitLab 주소를 입력해 주세요.');
    const query = typeof input.query === 'string' && input.query.isWellFormed() && !/\p{Cc}/u.test(input.query) ? input.query.trim() : '';
    if (!query || query.length > 200) fail('GitLab 저장소 검색어를 1~200자로 입력해 주세요.');
    const page = Object.hasOwn(input, 'page') ? input.page : 1;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > GITLAB_REPOSITORY_SEARCH_MAX_PAGE) {
      fail('GitLab 저장소 검색 페이지를 1~20 사이로 지정해 주세요.');
    }
    const token = this.draftReadToken(input, address, saved);
    if (token && query.includes(token)) fail('GitLab 저장소 검색어를 확인해 주세요.');
    signal?.throwIfAborted();
    const result = await readGitlabRepositorySearch({ baseUrl: address, token }, query, page, signal).catch(error => {
      signal?.throwIfAborted();
      assertSettingsVersion(saved.version, this.raw().version);
      if (error instanceof GitlabRepositoryQueryError) fail(error.message);
      if (error instanceof GitlabReadError) {
        const message = error.httpStatus === 401 || error.httpStatus === 403
          ? 'GitLab 저장소를 읽을 수 없습니다. 읽기 토큰과 접근 권한을 확인해 주세요.'
          : 'GitLab 저장소 검색에 실패했습니다. 주소와 연결 상태를 확인해 주세요.';
        fail(message, 502);
      }
      throw error;
    });
    signal?.throwIfAborted();
    assertSettingsVersion(saved.version, this.raw().version);
    return { settingsVersion: saved.version, page, ...result };
  }

  private async readRepositories(connection: SyncConnection, options: ReadOptions): Promise<ProjectReadOutcome[]> {
    const reads: ProjectReadOutcome[] = [];
    for (const projectId of connection.projectIds) {
      options.signal?.throwIfAborted();
      try { reads.push({ projectId, plan: await readProjectPlan(connection, projectId, options) }); }
      catch (error) {
        if (!(error instanceof GitlabReadError) || error.stage === 'webhooks') throw error;
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
    const token=this.draftReadToken(input,address,saved);
    const connection={baseUrl:address,projectIds:repositories,jiraRoutes,token,version:saved.version};
    const reads=await this.readRepositories(connection,{signal,includeHistory});
    const candidates:GitlabSyncPreviewCandidate[]=[],counts=emptyCounts(includeHistory),issues=this.syncIssues(),instance=this.instance(connection);
    const outcomes:GitlabSyncPreview['repositories']=reads.map(read=>{
      const {projectId}=read;
      if('failure'in read)return read.failure;
      const matcher=this.ticketMatcher(issues,jiraRoutes.find(route=>route.repositoryId===projectId));
      const projectCounts=this.visitProjectLinks(instance,read.plan,startedAt,matcher,token,(link,{issue,originalJiraKey},action,kind,objectId)=>{
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
          const counts=this.visitProjectLinks(instance,plan,startedAt,matcher,connection.token,(link,_match,action)=>{if(action!=='unchanged')this.store.put('gitlab_links',link);});
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
    app.get('/api/integrations/gitlab/webhook-status',(req,res)=>{
      res.set('Cache-Control','no-store');
      if (Object.keys(req.query).length) fail('웹훅 수신 상태 조회 조건을 확인해 주세요.');
      res.json(this.webhookStatus());
    });
    app.patch('/api/integrations/gitlab',(req,res)=>{hooks.actor(req);res.json(this.configure(req.body,()=>hooks.activity(req,'integration','gitlab','GitLab 설정 변경')));});
    app.post('/api/integrations/gitlab/webhook',(req,res)=>res.json(this.webhook(req)));
    const projectWebhookRequest = (operation: 'review' | 'register') => async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const actorId = hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.projectWebhooks[operation](req.body, actorId, controller.signal);
        if (result.state === 'created') {
          try { hooks.activity(req, 'integration', 'gitlab', 'GitLab 웹훅 등록', `저장소 ${result.repositoryId}`); }
          catch { console.error('[teamspace GitLab] 웹훅 등록 활동을 기록하지 못했습니다.'); }
        }
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    };
    app.post('/api/integrations/gitlab/project-webhook-review', projectWebhookRequest('review'));
    app.post('/api/integrations/gitlab/project-webhook-register', projectWebhookRequest('register'));
    const linkDetail=(link:GitlabLink)=>`${link.kind==='merge_request'?`MR !${link.iid}`:`파이프라인 #${link.iid}`} · 저장소 ${link.projectId}`;
    app.post('/api/issues/:id/gitlab-links',async(req,res)=>{
      hooks.actor(req);
      const issueId=String(req.params.id),controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',disconnected);
      try{
        const {link,created}=await this.attachLink(issueId,req.body,link=>{
          hooks.activity(req,'issue',issueId,'GitLab 활동 수동 연결',linkDetail(link));
        },controller.signal);
        if(!controller.signal.aborted)res.status(created?201:200).set('Cache-Control','no-store').json(link);
      }catch(error){if(!controller.signal.aborted)throw error;}
      finally{res.off('close',disconnected);}
    });
    app.delete('/api/issues/:id/gitlab-links/:linkId',(req,res)=>{
      hooks.actor(req);
      if(Object.keys(req.query).some(key=>key!=='expectedManualLinkId'))fail('GitLab 연결 해제 요청을 확인해 주세요.');
      const issueId=String(req.params.id);
      this.removeAttachedLink(issueId,String(req.params.linkId),req.query.expectedManualLinkId,link=>{
        hooks.activity(req,'issue',issueId,'GitLab 수동 연결 해제',linkDetail(link));
      });
      res.set('Cache-Control','no-store').json({ok:true});
    });
    app.post('/api/integrations/gitlab/repository-search', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.searchRepositories(req.body, controller.signal);
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
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
