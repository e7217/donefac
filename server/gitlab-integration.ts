import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import type { Express,Request,Response,NextFunction } from 'express';
import type { AutomationEvent,AutomationRun,GitlabLink,GitlabSettings,Issue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import type { Store } from './store.js';

export class GitlabIntegrationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new GitlabIntegrationError(status,message,details);}
type Obj=Record<string,unknown>;
type RawSettings={baseUrl:string;projectIds:number[];token?:string|null;webhookSecret?:string|null;signingToken?:string|null;version:number;lastSyncAt:string|null;lastError:string|null};
type ObjectCursor={id:string;occurredAt:string|null;state:string;receivedAt?:string};
type BranchCursor={id:string;pipelineId:number};
type Hooks={processEvent:(event:AutomationEvent)=>AutomationRun[];onConnectionChanged:(previous:GitlabSettings,next:GitlabSettings)=>number};
type RouteHooks={actor:(request:Request)=>string;activity:(request:Request,resourceType:string,resourceId:string,action:string,detail?:string)=>unknown};
const now=()=>new Date().toISOString();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const string=(value:unknown):string=>typeof value==='string'?value:'';
const bound=(value:unknown,max:number):string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:'';
const objectId=(object:Obj):string=>{const id=object.id??object.iid;return(typeof id==='string'||typeof id==='number')&&String(id).length<=200?String(id):'';};
function baseUrl(value:unknown):string{if(typeof value!=='string')fail('GitLab 주소를 확인해 주세요.');if(!value.trim())return'';let url:URL;try{url=new URL(value.trim());}catch{fail('GitLab 주소를 확인해 주세요.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('인증 정보가 없는 GitLab http(s) 기본 주소가 필요합니다.');return url.toString().replace(/\/+$/,'');}
function occurredAt(value:unknown):string|null{if(typeof value!=='string'||value.length>100)return null;const candidate=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(value)?value.replace(' ','T').replace(' UTC','Z'):value;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(candidate)||!isCalendarDate(candidate.slice(0,10))||Number(candidate.slice(11,13))>23||Number(candidate.slice(14,16))>59||Number(candidate.slice(17,19))>59)return null;const time=Date.parse(candidate);return Number.isFinite(time)&&time<=Date.now()?new Date(time).toISOString():null;}
function keys(...values:unknown[]):string[]{return[...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g)||[]))];}
function constantEqual(a:string,b:string):boolean{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function signingKey(value:string):Buffer{if(!value.startsWith('whsec_'))fail('서명 토큰은 whsec_ 형식이어야 합니다.');const encoded=value.slice(6),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)fail('서명 토큰은 32바이트 Base64 whsec_ 형식이어야 합니다.');return key;}
function validWebUrl(value:unknown):string{if(typeof value!=='string'||value.length>4000)return'';try{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():'';}catch{return'';}}

/** All external writes are local links; remote calls are explicit read-only syncs. */
export class GitlabIntegrationService{
  constructor(private readonly store:Store,private readonly hooks:Hooks){store.db.exec('CREATE TABLE IF NOT EXISTS gitlab_object_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS gitlab_branch_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);');}
  private raw():RawSettings{const value=record(this.store.setting('gitlab'));return{baseUrl:string(value.baseUrl),projectIds:Array.isArray(value.projectIds)?value.projectIds as number[]:[],token:typeof value.token==='string'?value.token:null,webhookSecret:typeof value.webhookSecret==='string'?value.webhookSecret:null,signingToken:typeof value.signingToken==='string'?value.signingToken:null,version:Number.isSafeInteger(value.version)&&Number(value.version)>0?Number(value.version):1,lastSyncAt:typeof value.lastSyncAt==='string'?value.lastSyncAt:null,lastError:typeof value.lastError==='string'?value.lastError:null};}
  private public(raw:RawSettings):GitlabSettings{return{baseUrl:raw.baseUrl,projectIds:raw.projectIds,tokenConfigured:!!raw.token,webhookSecretConfigured:!!raw.webhookSecret,signingTokenConfigured:!!raw.signingToken,version:raw.version,lastSyncAt:raw.lastSyncAt,lastError:raw.lastError};}
  settings():GitlabSettings{return this.public(this.raw());}
  private instance(raw=this.raw()):string{return createHash('sha256').update(raw.baseUrl).digest('hex').slice(0,12);}
  configure(value:unknown,afterSave?:(settings:GitlabSettings)=>void):GitlabSettings{return this.store.transaction(()=>{
    const input=record(value),old=this.raw();if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==old.version)fail('GitLab 연결 설정이 변경되었습니다. 최신 설정을 확인해 주세요.',Number.isSafeInteger(input.expectedVersion)?409:400,{currentVersion:old.version});const next={...old};
    if('baseUrl'in input)next.baseUrl=baseUrl(input.baseUrl);
    if('projectIds'in input){if(!Array.isArray(input.projectIds)||input.projectIds.length>100||input.projectIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(input.projectIds).size!==input.projectIds.length)fail('저장소 ID는 중복되지 않은 양의 정수 목록이어야 합니다.');next.projectIds=[...input.projectIds].sort((a,b)=>a-b);}
    for(const field of ['token','webhookSecret','signingToken'] as const)if(field in input){const value=input[field];if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value))fail('인증 값을 확인해 주세요.');if(value&&field==='signingToken')signingKey(value);next[field]=value?this.store.seal(value):null;}
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
  private upsert(raw:RawSettings,projectId:number,kind:GitlabLink['kind'],object:Obj,explicitKeys:string[]=[],preserveExisting=false,monotonic=false):{linked:number;issueIds:string[]}{
    const id=objectId(object);if(!id)return{linked:0,issueIds:[]};const title=string(object.title)||string(object.name)||string(object.ref)||string(object.message)||`${kind} #${id}`,matched=new Set(keys(title,object.description,object.source_branch,object.ref,...explicitKeys)),url=validWebUrl(object.web_url||object.url);if(!url)return{linked:0,issueIds:this.store.all<Issue>('issues').filter(issue=>matched.has(issue.key)).map(issue=>issue.id)};const instance=this.instance(raw),sourceBranch=bound(object.source_branch||object.ref,512),sourceSha=bound(object.sha||record(object.last_commit).id,128),issueIds:string[]=[];let linked=0;
    for(const issue of this.store.all<Issue>('issues'))if(matched.has(issue.key)){const linkId=`gitlab:${instance}:${projectId}:${kind}:${id}:${issue.id}`;issueIds.push(issue.id);const existing=this.store.get<GitlabLink>('gitlab_links',linkId),incomingTime=occurredAt(object.updated_at||object.finished_at||object.created_at);if(existing&&(preserveExisting||monotonic&&(!incomingTime||Date.parse(existing.updatedAt)>=Date.parse(incomingTime))))continue;this.store.put('gitlab_links',{id:linkId,issueId:issue.id,projectId,iid:kind==='commit'?0:Number(object.iid||object.id)||0,kind,title:title.slice(0,500),webUrl:url,state:string(object.state)||string(object.status)||'unknown',updatedAt:incomingTime||now(),...(sourceBranch?{sourceBranch}:{}),...(sourceSha?{sourceSha}:{})} satisfies GitlabLink);linked++;}
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
  async sync(afterSync?:(scanned:number,linked:number)=>void):Promise<{ok:true;scanned:number;linked:number;settings:GitlabSettings;notice:string}>{
    const captured=this.raw(),startedAt=Date.now();if(!captured.baseUrl||!captured.projectIds.length)fail('GitLab 주소와 저장소 ID를 먼저 설정해 주세요.');
    try{
      const headers:Record<string,string>={Accept:'application/json'};if(captured.token)headers['PRIVATE-TOKEN']=this.store.unseal(captured.token);
      const objects:{projectId:number;kind:'merge_request'|'pipeline';object:Obj;keys:string[]}[]=[];
      for(const projectId of captured.projectIds){
        const api=async(path:string):Promise<Obj[]>=>{const response=await fetch(`${captured.baseUrl}/api/v4/projects/${projectId}/${path}`,{headers,signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw new Error(`GitLab HTTP ${response.status}`);const data:unknown=await response.json();if(!Array.isArray(data)||data.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new Error('GitLab 응답 형식 오류');return data as Obj[];};
        for(let page=1;page<=10;page++){const mrs=await api(`merge_requests?scope=all&per_page=100&page=${page}`);for(const object of mrs)objects.push({projectId,kind:'merge_request',object,keys:[]});if(mrs.length<100)break;}
        for(const object of await api('pipelines?per_page=50')){const inherited=objects.filter(item=>item.projectId===projectId&&item.kind==='merge_request'&&item.object.source_branch===object.ref).flatMap(item=>keys(item.object.title,item.object.description,item.object.source_branch));objects.push({projectId,kind:'pipeline',object,keys:inherited});}
      }
      let linked=0;this.store.transaction(()=>{const current=this.raw();if(current.version!==captured.version)fail('동기화 도중 GitLab 설정이 변경되어 결과를 적용하지 않았습니다.',409);for(const item of objects){const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${this.instance(current)}:${item.projectId}:${item.kind}:${objectId(item.object)}`),incomingTime=occurredAt(item.object.updated_at||item.object.finished_at||item.object.created_at);if(cursor&&(Date.parse(cursor.receivedAt||'')>=startedAt||cursor.occurredAt&&(!incomingTime||Date.parse(cursor.occurredAt)>Date.parse(incomingTime))))continue;linked+=this.upsert(current,item.projectId,item.kind,item.object,item.keys,false,true).linked;}this.store.setSetting('gitlab',{...current,lastSyncAt:now(),lastError:null});afterSync?.(objects.length,linked);});
      return{ok:true,scanned:objects.length,linked,settings:this.settings(),notice:'MR은 저장소당 최근 최대 1000개, 파이프라인은 최근 50개를 조회합니다. 업무 상태는 자동 변경하지 않습니다.'};
    }catch(error){if(this.raw().version!==captured.version)fail('동기화 도중 GitLab 설정이 변경되어 결과를 적용하지 않았습니다.',409);if(error instanceof GitlabIntegrationError)throw error;const message=(error instanceof Error?error.message:'GitLab 연결 실패').slice(0,500);this.store.transaction(()=>{const current=this.raw();if(current.version!==captured.version)fail('동기화 도중 GitLab 설정이 변경되었습니다.',409);this.store.setSetting('gitlab',{...current,lastError:message});});fail('GitLab 동기화에 실패했습니다.',502,{reason:message});}
  }
  registerRoutes(app:Express,hooks:RouteHooks):void{
    app.get('/api/integrations/gitlab',(_req,res)=>res.json(this.settings()));
    app.patch('/api/integrations/gitlab',(req,res)=>{hooks.actor(req);res.json(this.configure(req.body,()=>hooks.activity(req,'integration','gitlab','GitLab 설정 변경')));});
    app.post('/api/integrations/gitlab/webhook',(req,res)=>res.json(this.webhook(req)));
    app.post('/api/integrations/gitlab/sync',(req:Request,res:Response,next:NextFunction)=>{hooks.actor(req);void this.sync((scanned,linked)=>hooks.activity(req,'integration','gitlab','GitLab 재동기화',`${scanned}개 항목 확인, ${linked}개 업무 연결`)).then(result=>res.json(result),next);});
  }
}
