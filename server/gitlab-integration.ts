import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import type { Express,Request,Response,NextFunction } from 'express';
import type { AutomationEvent,AutomationRun,GitlabLink,GitlabSettings,GitlabSyncPreview,GitlabSyncPreviewCandidate,GitlabSyncPreviewCounts,Issue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { GitlabReadError,readGitlabSyncProject } from './gitlab-read-sync.js';
import type { Store } from './store.js';

export class GitlabIntegrationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new GitlabIntegrationError(status,message,details);}
type Obj=Record<string,unknown>;
type RawSettings={baseUrl:string;projectIds:number[];token?:string|null;webhookSecret?:string|null;signingToken?:string|null;version:number;lastSyncAt:string|null;lastError:string|null};
type ObjectCursor={id:string;occurredAt:string|null;state:string;receivedAt?:string};
type BranchCursor={id:string;pipelineId:number};
type Hooks={processEvent:(event:AutomationEvent)=>AutomationRun[];onConnectionChanged:(previous:GitlabSettings,next:GitlabSettings)=>number};
type RouteHooks={actor:(request:Request)=>string;activity:(request:Request,resourceType:string,resourceId:string,action:string,detail?:string)=>unknown};
type SyncConnection={baseUrl:string;projectIds:number[];token:string|null;version:number};
type SyncKind=GitlabSyncPreviewCandidate['kind'];
type IssueMatch=Pick<Issue,'id'|'key'|'title'>;
const PREVIEW_CANDIDATE_LIMIT=100;
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
function credential(value:unknown):string{
  if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value))fail('인증 값을 확인해 주세요.');
  return value;
}
function assertSettingsVersion(expectedVersion:unknown, currentVersion:number):void{
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==currentVersion)fail('GitLab 연결 설정이 변경되었습니다. 최신 설정을 확인해 주세요.',Number.isSafeInteger(expectedVersion)?409:400,{currentVersion});
}
function occurredAt(value:unknown):string|null{if(typeof value!=='string'||value.length>100)return null;const candidate=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(value)?value.replace(' ','T').replace(' UTC','Z'):value;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(candidate)||!isCalendarDate(candidate.slice(0,10))||Number(candidate.slice(11,13))>23||Number(candidate.slice(14,16))>59||Number(candidate.slice(17,19))>59)return null;const time=Date.parse(candidate);return Number.isFinite(time)&&time<=Date.now()?new Date(time).toISOString():null;}
function keys(...values:unknown[]):string[]{return[...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g)||[]))];}
function constantEqual(a:string,b:string):boolean{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function signingKey(value:string):Buffer{if(!value.startsWith('whsec_'))fail('서명 토큰은 whsec_ 형식이어야 합니다.');const encoded=value.slice(6),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)fail('서명 토큰은 32바이트 Base64 whsec_ 형식이어야 합니다.');return key;}
function validWebUrl(value:unknown):string{if(typeof value!=='string'||value.length>4000)return'';try{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():'';}catch{return'';}}

function readLink(kind:GitlabLink['kind'],object:Obj,explicitKeys:string[]){
  const id=objectId(object);
  const title=string(object.title)||string(object.name)||string(object.ref)||string(object.message)||`${kind} #${id}`;
  return {
    id,title:title.slice(0,500),matchedKeys:[...new Set([...keys(title,object.description,object.source_branch,object.ref),...explicitKeys])],
    webUrl:validWebUrl(object.web_url||object.url),iid:kind==='commit'?0:Number(object.iid||object.id)||0,
    state:string(object.state)||string(object.status)||'unknown',incomingTime:occurredAt(object.updated_at||object.finished_at||object.created_at),
    sourceBranch:bound(object.source_branch||object.ref,512),sourceSha:bound(object.sha||record(object.last_commit).id,128),
  };
}
type LinkDraft=ReturnType<typeof readLink>;
type ProjectReadPlan={projectId:number;mergeRequests:LinkDraft[];pipelines:LinkDraft[]};
function linkForIssue(instance:string,projectId:number,kind:GitlabLink['kind'],issueId:string,draft:LinkDraft):GitlabLink{
  const { id,title,iid,webUrl,state,incomingTime,sourceBranch,sourceSha }=draft;
  return {id:`gitlab:${instance}:${projectId}:${kind}:${id}:${issueId}`,issueId,projectId,iid,kind,title,webUrl,state,updatedAt:incomingTime||now(),...(sourceBranch?{sourceBranch}:{}),...(sourceSha?{sourceSha}:{})};
}
function keepNewerLink(existing:GitlabLink,draft:LinkDraft):boolean{
  return !draft.incomingTime||Date.parse(existing.updatedAt)>=Date.parse(draft.incomingTime);
}
function emptyCounts():GitlabSyncPreviewCounts{return {mergeRequests:0,pipelines:0,matched:0,unmatched:0,skipped:0,create:0,update:0,unchanged:0};}
function branchHead(branch:unknown,sha:unknown):string|null{
  const ref=bound(branch,512),head=bound(sha,128);
  return ref&&head?JSON.stringify([ref,head]):null;
}
function safePreviewValue(value:string,token:string|null):string{
  return token?value.replaceAll(token,'[숨김]'):value;
}

async function readProjectPlan(connection:SyncConnection,projectId:number,signal?:AbortSignal):Promise<ProjectReadPlan>{
  const scan=await readGitlabSyncProject(connection,projectId,{signal});
  const mergeRequests=scan.mergeRequests.map(object=>readLink('merge_request',object,[]));
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
    return readLink('pipeline',object,head?[...(keysByHead.get(head)??[])]:[]);
  });
  return {projectId,mergeRequests,pipelines};
}

/** All external writes are local links; remote calls are explicit read-only syncs. */
export class GitlabIntegrationService{
  constructor(private readonly store:Store,private readonly hooks:Hooks){store.db.exec('CREATE TABLE IF NOT EXISTS gitlab_object_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS gitlab_branch_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);');}
  private raw():RawSettings{const value=record(this.store.setting('gitlab'));return{baseUrl:string(value.baseUrl),projectIds:Array.isArray(value.projectIds)?value.projectIds as number[]:[],token:typeof value.token==='string'?value.token:null,webhookSecret:typeof value.webhookSecret==='string'?value.webhookSecret:null,signingToken:typeof value.signingToken==='string'?value.signingToken:null,version:Number.isSafeInteger(value.version)&&Number(value.version)>0?Number(value.version):1,lastSyncAt:typeof value.lastSyncAt==='string'?value.lastSyncAt:null,lastError:typeof value.lastError==='string'?value.lastError:null};}
  private public(raw:RawSettings):GitlabSettings{return{baseUrl:raw.baseUrl,projectIds:raw.projectIds,tokenConfigured:!!raw.token,webhookSecretConfigured:!!raw.webhookSecret,signingTokenConfigured:!!raw.signingToken,version:raw.version,lastSyncAt:raw.lastSyncAt,lastError:raw.lastError};}
  settings():GitlabSettings{return this.public(this.raw());}
  private instance(raw:Pick<RawSettings,'baseUrl'>=this.raw()):string{return createHash('sha256').update(raw.baseUrl).digest('hex').slice(0,12);}
  configure(value:unknown,afterSave?:(settings:GitlabSettings)=>void):GitlabSettings{return this.store.transaction(()=>{
    const input=record(value),old=this.raw();assertSettingsVersion(input.expectedVersion,old.version);const next={...old};
    if('baseUrl'in input)next.baseUrl=baseUrl(input.baseUrl);
    if(next.baseUrl!==old.baseUrl){next.token=null;next.lastSyncAt=null;next.lastError=null;}
    if('projectIds'in input)next.projectIds=projectIds(input.projectIds);
    for(const field of ['token','webhookSecret','signingToken'] as const)if(field in input){const value=credential(input[field]);if(value&&field==='signingToken')signingKey(value);next[field]=value?this.store.seal(value):null;}
    next.version=old.version+1;this.store.setSetting('gitlab',next);this.hooks.onConnectionChanged(this.public(old),this.public(next));afterSave?.(this.public(next));return this.public(next);
  });}
  resetForImport():void{this.store.db.exec('DELETE FROM webhook_inbox;DELETE FROM gitlab_object_cursors;DELETE FROM gitlab_branch_cursors;');const raw=this.raw();this.store.setSetting('gitlab',{...raw,version:raw.version+1});}
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
  private inheritedKeys(projectId:number,branch:string,sha:string,instance:string):string[]{
    if(!branch||!sha)return[];const issueIds=new Set(this.store.all<GitlabLink>('gitlab_links').filter(link=>link.kind==='merge_request'&&link.projectId===projectId&&link.id.startsWith(`gitlab:${instance}:`)&&link.sourceBranch===branch&&link.sourceSha===sha).map(link=>link.issueId));return this.store.all<Issue>('issues').filter(issue=>issueIds.has(issue.id)).map(issue=>issue.key);
  }
  private upsert(raw:RawSettings,projectId:number,kind:GitlabLink['kind'],object:Obj,explicitKeys:string[]=[],preserveExisting=false):{linked:number;issueIds:string[]}{
    const draft=readLink(kind,object,explicitKeys);if(!draft.id)return{linked:0,issueIds:[]};
    const matched=new Set(draft.matchedKeys),issueIds=this.store.all<Issue>('issues').filter(issue=>matched.has(issue.key)).map(issue=>issue.id);
    if(!draft.webUrl)return{linked:0,issueIds};
    const instance=this.instance(raw);let linked=0;
    for(const issueId of issueIds){const link=linkForIssue(instance,projectId,kind,issueId,draft);if(preserveExisting&&this.store.get('gitlab_links',link.id))continue;this.store.put('gitlab_links',link);linked++;}
    return{linked,issueIds};
  }
  webhook(req:Request):{ok:true;duplicate:boolean;linked:number;runs:AutomationRun[]}{
    const raw=this.raw();this.authenticate(req,raw);const body=record(req.body),project=record(body.project),projectId=Number(project.id??body.project_id);if(!raw.projectIds.includes(projectId))fail('허용된 저장소가 아닙니다.',403);
    const header=req.header('X-Gitlab-Event')||'',kind=string(body.object_kind)||({'Merge Request Hook':'merge_request','Pipeline Hook':'pipeline','Push Hook':'push'} as Record<string,string>)[header]||'';
    const attributes=record(body.object_attributes),instance=this.instance(raw),externalId=req.header('webhook-id')||req.header('Idempotency-Key')||req.header('X-Gitlab-Event-UUID')||createHash('sha256').update((req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody||Buffer.from(JSON.stringify(body))).digest('hex');if(externalId.length>500)fail('Webhook 식별자가 너무 깁니다.');const eventId=`gitlab:${instance}:${projectId}:${kind}:${createHash('sha256').update(externalId).digest('hex')}`;
    return this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM webhook_inbox WHERE id=?').get(eventId))return{ok:true,duplicate:true,linked:0,runs:[]};
      this.store.db.prepare('INSERT INTO webhook_inbox(id,created_at) VALUES(?,?)').run(eventId,now());
      if(kind==='push'||kind==='tag_push'){let linked=0;for(const item of Array.isArray(body.commits)?body.commits:[])linked+=this.upsert(raw,projectId,'commit',{...record(item),state:'committed'}).linked;return{ok:true,duplicate:false,linked,runs:[]};}
      if(kind!=='merge_request'&&kind!=='pipeline')return{ok:true,duplicate:false,linked:0,runs:[]};
      const id=objectId(attributes),state=string(attributes.state)||string(attributes.status)||'unknown',branch=bound(kind==='merge_request'?attributes.source_branch:attributes.ref,512),sha=bound(attributes.sha||record(attributes.last_commit).id||record(body.commit).id,128);
      const time=occurredAt(kind==='merge_request'?(attributes.actioned_at||attributes.updated_at):(attributes.finished_at||attributes.updated_at||attributes.created_at));
      const cursorId=`${instance}:${projectId}:${kind}:${id}`,prior=id?this.store.get<ObjectCursor>('gitlab_object_cursors',cursorId):undefined;let disposition:AutomationEvent['disposition']='fresh',reason='';
      if(!id||!time){disposition='unverified';reason='이벤트 식별자 또는 유효한 과거 발생 시각을 확인할 수 없습니다.';}
      else if(prior?.occurredAt){const difference=Date.parse(time)-Date.parse(prior.occurredAt);if(difference<0){disposition='stale';reason='이 객체의 최신 수신 이벤트보다 오래된 이벤트입니다.';}else if(difference===0){disposition=state===prior.state?'stale':'ambiguous';reason=state===prior.state?'같은 발생 시각·상태의 이벤트를 이미 반영했습니다.':'같은 발생 시각의 상태가 서로 달라 적용하지 않았습니다.';}}
      const objectDisposition=disposition;
      if(id&&(disposition==='fresh'||!prior))this.store.put('gitlab_object_cursors',{id:cursorId,occurredAt:time,state,receivedAt:now()} satisfies ObjectCursor);
      if(kind==='pipeline'&&branch){const numericId=Number(id),branchId=`${instance}:${projectId}:${branch}`,latest=this.store.get<BranchCursor>('gitlab_branch_cursors',branchId);if(Number.isSafeInteger(numericId)&&numericId>0){if(latest&&numericId<latest.pipelineId){disposition='stale';reason='이 브랜치에 더 최근에 생성된 파이프라인이 있어 이전 결과를 적용하지 않았습니다.';}else if(objectDisposition==='fresh'&&time&&(!latest||numericId>latest.pipelineId))this.store.put('gitlab_branch_cursors',{id:branchId,pipelineId:numericId} satisfies BranchCursor);}else{disposition='unverified';reason='파이프라인 순서를 확인할 수 없습니다.';}}
      const mergeRequest=record(body.merge_request),extra=keys(mergeRequest.title,mergeRequest.description,mergeRequest.source_branch,record(body.commit).message,...(Array.isArray(body.commits)?body.commits.map(commit=>record(commit).message):[]));
      if(kind==='pipeline')extra.push(...this.inheritedKeys(projectId,branch,sha,instance));
      const object={...attributes,...(time?{updated_at:time}:{}),...(branch?{source_branch:branch}:{}),...(sha?{sha}:{}),web_url:attributes.web_url||attributes.url||(kind==='pipeline'&&project.web_url?`${project.web_url}/-/pipelines/${id}`:'')};
      let linked=0;let issueIds:string[]=[];
      if(objectDisposition==='fresh'||objectDisposition==='unverified'){const result=this.upsert(raw,projectId,kind,object,extra,objectDisposition==='unverified');linked=result.linked;issueIds=result.issueIds;}
      else{const matched=new Set(keys(attributes.title,attributes.description,branch,attributes.ref,...extra));issueIds=this.store.all<Issue>('issues').filter(issue=>matched.has(issue.key)).map(issue=>issue.id);}
      const action=string(attributes.action),trigger=kind==='merge_request'?({open:'merge_request.opened',reopen:'merge_request.opened',merge:'merge_request.merged',close:'merge_request.closed'} as Record<string,AutomationEvent['trigger']>)[action]:({success:'pipeline.succeeded',failed:'pipeline.failed'} as Record<string,AutomationEvent['trigger']>)[state];
      const runs=trigger?this.hooks.processEvent({id:eventId,trigger,gitlabProjectId:projectId,objectKind:kind,objectId:id,branch,issueIds,occurredAt:time,receivedAt:now(),disposition,reason}):[];
      return{ok:true,duplicate:false,linked,runs};
    });
  }
  private visitProjectLinks(
    instance:string,plan:ProjectReadPlan,startedAt:number,issues:Map<string,IssueMatch>,
    visit:(link:GitlabLink,issue:IssueMatch,action:GitlabSyncPreviewCandidate['action'],kind:SyncKind,objectId:string)=>void,
  ):GitlabSyncPreviewCounts{
    const {projectId,mergeRequests,pipelines}=plan;
    const counts={...emptyCounts(),mergeRequests:mergeRequests.length,pipelines:pipelines.length};
    // Earlier pages can contain the same object while GitLab changes during pagination.
    // Carry planned writes forward so an in-request duplicate sees what sync would have saved.
    const planned=new Map<string,GitlabLink>();
    for(const [kind,drafts] of [['merge_request',mergeRequests],['pipeline',pipelines]] as const)for(const draft of drafts){
      if(!draft.id||!draft.webUrl){counts.skipped++;continue;}
      const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${projectId}:${kind}:${draft.id}`);
      if(cursor&&(Date.parse(cursor.receivedAt||'')>=startedAt||cursor.occurredAt&&(!draft.incomingTime||Date.parse(cursor.occurredAt)>Date.parse(draft.incomingTime)))){
        counts.skipped++;
        continue;
      }
      const matched=draft.matchedKeys.flatMap(key=>{const issue=issues.get(key);return issue?[issue]:[];});
      if(!matched.length){counts.unmatched++;continue;}
      counts.matched++;
      for(const issue of matched){
        const link=linkForIssue(instance,projectId,kind,issue.id,draft);
        const existing=planned.get(link.id)??this.store.get<GitlabLink>('gitlab_links',link.id);
        const action=!existing?'create':keepNewerLink(existing,draft)?'unchanged':'update';
        counts[action]++;
        if(action!=='unchanged')planned.set(link.id,link);
        visit(action==='unchanged'&&existing?existing:link,issue,action,kind,draft.id);
      }
    }
    return counts;
  }

  private syncIssues():Map<string,IssueMatch>{
    return new Map(this.store.all<Issue>('issues').map(({id,key,title})=>[key,{id,key,title}]));
  }

  private currentForSync(version:number):RawSettings{
    const current=this.raw();
    if(current.version!==version)fail('동기화 도중 GitLab 설정이 변경되어 결과를 적용하지 않았습니다.',409);
    return current;
  }

  async previewSync(value:unknown, signal?:AbortSignal):Promise<GitlabSyncPreview>{
    const input=record(value),saved=this.raw(),startedAt=Date.now();
    if(Object.keys(input).some(key=>!['expectedVersion','baseUrl','projectIds','token'].includes(key)))fail('지원하지 않는 GitLab 미리보기 요청입니다.');
    assertSettingsVersion(input.expectedVersion,saved.version);
    const address='baseUrl'in input?baseUrl(input.baseUrl):saved.baseUrl;
    const repositories='projectIds'in input?projectIds(input.projectIds):saved.projectIds;
    if(!address||!repositories.length)fail('GitLab 주소와 저장소 ID를 입력해 주세요.');
    const token='token'in input?credential(input.token):address===saved.baseUrl&&saved.token?this.store.unseal(saved.token):null;
    const connection={baseUrl:address,projectIds:repositories,token,version:saved.version};
    const reads:({projectId:number;plan:ProjectReadPlan}|{projectId:number;error:GitlabReadError})[]=[];
    for(const projectId of repositories){
      signal?.throwIfAborted();
      try{reads.push({projectId,plan:await readProjectPlan(connection,projectId,signal)});}
      catch(error){if(!(error instanceof GitlabReadError))throw error;reads.push({projectId,error});}
      signal?.throwIfAborted();
      this.currentForSync(saved.version);
    }
    const candidates:GitlabSyncPreviewCandidate[]=[],counts=emptyCounts(),issues=this.syncIssues(),instance=this.instance(connection);
    const outcomes:GitlabSyncPreview['repositories']=reads.map(read=>{
      const {projectId}=read;
      if('error'in read){const {stage,httpStatus,message}=read.error;return {projectId,status:'error',counts:emptyCounts(),error:{stage,httpStatus,message}};}
      const projectCounts=this.visitProjectLinks(instance,read.plan,startedAt,issues,(link,issue,action,kind,objectId)=>{
        if(candidates.length<PREVIEW_CANDIDATE_LIMIT)candidates.push({
          projectId,kind,objectId:safePreviewValue(objectId,token),title:safePreviewValue(link.title,token),state:safePreviewValue(link.state.slice(0,100),token),
          issueId:issue.id,issueKey:issue.key,issueTitle:issue.title,action,
        });
      });
      for(const key of Object.keys(counts) as (keyof GitlabSyncPreviewCounts)[])counts[key]+=projectCounts[key];
      return {projectId,status:'ok',counts:projectCounts,error:null};
    });
    return {settingsVersion:saved.version,baseUrl:address,projectIds:repositories,repositories:outcomes,counts,candidates,
      candidatesTruncated:counts.create+counts.update+counts.unchanged>candidates.length};
  }

  async sync(afterSync?:(scanned:number,linked:number)=>void):Promise<{ok:true;scanned:number;linked:number;settings:GitlabSettings;notice:string}>{
    const captured=this.raw(),startedAt=Date.now();
    if(!captured.baseUrl||!captured.projectIds.length)fail('GitLab 주소와 저장소 ID를 먼저 설정해 주세요.');
    try{
      const connection={...captured,token:captured.token?this.store.unseal(captured.token):null};
      const plans:ProjectReadPlan[]=[];
      for(const projectId of connection.projectIds){
        plans.push(await readProjectPlan(connection,projectId));
        this.currentForSync(captured.version);
      }
      let scanned=0,linked=0;
      this.store.transaction(()=>{
        const current=this.currentForSync(captured.version),instance=this.instance(current),issues=this.syncIssues();
        for(const plan of plans){
          const counts=this.visitProjectLinks(instance,plan,startedAt,issues,(link,_issue,action)=>{if(action!=='unchanged')this.store.put('gitlab_links',link);});
          scanned+=counts.mergeRequests+counts.pipelines;
          linked+=counts.create+counts.update;
        }
        this.store.setSetting('gitlab',{...current,lastSyncAt:now(),lastError:null});
        afterSync?.(scanned,linked);
      });
      return{ok:true,scanned,linked,settings:this.settings(),notice:'MR은 저장소당 최근 최대 1000개, 파이프라인은 최근 50개를 조회합니다. 업무 상태는 자동 변경하지 않습니다.'};
    }catch(error){
      this.currentForSync(captured.version);
      if(error instanceof GitlabIntegrationError)throw error;
      const message=error instanceof GitlabReadError?error.message:'GitLab 동기화 결과를 저장하지 못했습니다.';
      this.store.transaction(()=>{const current=this.currentForSync(captured.version);this.store.setSetting('gitlab',{...current,lastError:message});});
      fail('GitLab 동기화에 실패했습니다.',502,{reason:message});
    }
  }
  registerRoutes(app:Express,hooks:RouteHooks):void{
    app.get('/api/integrations/gitlab',(_req,res)=>res.json(this.settings()));
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
    app.post('/api/integrations/gitlab/sync',(req:Request,res:Response,next:NextFunction)=>{hooks.actor(req);void this.sync((scanned,linked)=>hooks.activity(req,'integration','gitlab','GitLab 재동기화',`${scanned}개 항목 확인, ${linked}개 업무 연결`)).then(result=>res.json(result),next);});
  }
}
