import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import type { AutomationRule, Issue, WebhookDelivery, WebhookEndpointCreated, WebhookEnvelope } from '../../shared/types.js';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'teamspace-automation-outbox-')),service=createApp({dataDir:dir,outboundWorker:false});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const observer=new Store(dir);
  async function call<T=any>(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){const response=await fetch(`${base}/api${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as T};}
  return{call,observer,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));service.close();observer.db.close();rmSync(dir,{recursive:true,force:true});}};
}
async function configure(f:Awaited<ReturnType<typeof fixture>>){const response=await f.call('/integrations/gitlab','PATCH',{expectedVersion:1,baseUrl:'http://gitlab.synthetic.test',projectIds:[42],webhookSecret:'integration-secret'});assert.equal(response.status,200);}
async function rule(f:Awaited<ReturnType<typeof fixture>>,overrides:Record<string,unknown>={}){const response=await f.call<AutomationRule>('/automation-rules','POST',{projectId:'project-neo',name:'병합 후 완료',trigger:'merge_request.merged',enabled:true,gitlabProjectIds:[42],branchPattern:'feature/*',issueTypes:[],fromStatuses:['in_progress','review','done'],toStatusId:'done',actorId:'user-seo',priority:100,...overrides});assert.equal(response.status,201,JSON.stringify(response.data));return response.data;}
async function endpoint(f:Awaited<ReturnType<typeof fixture>>){const response=await f.call<WebhookEndpointCreated>('/webhook-endpoints','POST',{name:'합성 수신처',url:'http://127.0.0.1:9/receiver',eventTypes:['issue.updated','document.created','document.updated','comment.created'],projectIds:['project-neo']});assert.equal(response.status,201);const enabled=await f.call('/webhook-endpoints/'+response.data.endpoint.id,'PATCH',{expectedVersion:response.data.endpoint.version,enabled:true});assert.equal(enabled.status,200);return{...response.data,endpoint:enabled.data};}
function payload(id=101,issue='NEO-1',timestamp=new Date().toISOString()){return{object_kind:'merge_request',project:{id:42},object_attributes:{id,iid:id,action:'merge',state:'merged',title:`${issue} synthetic`,source_branch:`feature/${issue}`,url:`http://gitlab.synthetic.test/-/merge_requests/${id}`,updated_at:timestamp}};}
async function hook(f:Awaited<ReturnType<typeof fixture>>,body=payload(),id=randomUUID()){return f.call('/integrations/gitlab/webhook','POST',body,{'X-Gitlab-Token':'integration-secret','webhook-id':id});}

test('authenticated automation shares issue, audit, receipt and minimal outbox transaction',async()=>{
  const f=await fixture();try{
    await configure(f);await endpoint(f);await rule(f);const before=f.observer.get<Issue>('issues','issue-1')!;const body=payload(),id=randomUUID();const result=await hook(f,body,id);assert.equal(result.status,200,JSON.stringify(result.data));
    const snapshot=(await f.call('/workspace')).data,issue=snapshot.issues.find((value:Issue)=>value.id==='issue-1');assert.equal(issue.status,'done');assert.ok(issue.completedAt);assert.equal(issue.version,before.version+1);
    const activity=snapshot.activities.at(-1);assert.equal(activity.actorId,'user-seo');assert.match(activity.action,/자동화/);
    const deliveries=(await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;assert.equal(deliveries.length,1);
    const detail=(await f.call<{delivery:WebhookDelivery;envelope:WebhookEnvelope}>('/webhook-deliveries/'+deliveries[0].id)).data;assert.equal(detail.envelope.origin,'automation');assert.equal(detail.envelope.actorId,'user-seo');assert.ok(detail.envelope.sourceEventId);assert.deepEqual(detail.envelope.changedFields.sort(),['completedAt','status']);assert.equal(detail.envelope.resource.status,'done');assert.ok(!JSON.stringify(detail).includes('integration-secret'));assert.ok(!Object.hasOwn(detail.envelope.resource,'description'));
    assert.equal((await hook(f,body,id)).data.duplicate,true);assert.equal((await f.call<WebhookDelivery[]>('/webhook-deliveries')).data.length,1);assert.equal((await f.call('/automation-runs')).data.length,1);
    const older=payload(101,'NEO-1',new Date(Date.now()-60000).toISOString());older.object_attributes.action='reopen';older.object_attributes.state='opened';assert.equal((await hook(f,older)).status,200);assert.equal(f.observer.get<Issue>('issues','issue-1')!.status,'done');
  }finally{await f.close();}
});

test('preview and webhook honor the same required-field workflow without creating mutation events',async()=>{
  const f=await fixture();try{
    await configure(f);assert.equal((await f.call('/issues/issue-1','PATCH',{expectedVersion:f.observer.get<Issue>('issues','issue-1')!.version,dueDate:null})).status,200);await endpoint(f);const workflow=(await f.call('/projects/project-neo/workflow')).data;workflow.transitions.find((edge:any)=>edge.from==='in_progress'&&edge.to==='done').requiredFields=['dueDate'];assert.equal((await f.call('/projects/project-neo/workflow','PATCH',{...workflow,expectedVersion:workflow.version})).status,200);
    const saved=await rule(f);const preview=await f.call('/automation/preview','POST',{rule:saved,issueIds:['issue-1'],sample:{trigger:'merge_request.merged',gitlabProjectId:42,branch:'feature/NEO-1'}});assert.equal(preview.status,200);assert.equal(preview.data.outcomes[0].outcome,'blocked');assert.equal((await f.call('/automation-runs')).data.length,0);
    const before=f.observer.get<Issue>('issues','issue-1')!;assert.equal((await hook(f)).status,200);assert.deepEqual(f.observer.get('issues','issue-1'),before);assert.equal((await f.call('/automation-runs')).data[0].outcome,'blocked');assert.equal((await f.call('/webhook-deliveries')).data.length,0);
  }finally{await f.close();}
});

test('native8 exports definitions only and restores disabled rules with operational outbox reset',async()=>{
  const f=await fixture();try{
    await configure(f);const destination=await endpoint(f);const saved=await rule(f);assert.equal((await hook(f)).status,200);const backup=(await f.call('/export')).data;assert.equal(backup.schemaVersion,14);assert.equal(backup.automationRules[0].id,saved.id);
    const serialized=JSON.stringify(backup);for(const privateValue of [destination.secret,destination.endpoint.url,'integration-secret','webhook_endpoints','webhook_deliveries'])assert.ok(!serialized.includes(privateValue));
    assert.equal((await f.call('/import','POST',{data:backup})).status,200);const restored=(await f.call<AutomationRule[]>('/automation-rules')).data[0];assert.equal(restored.enabled,false);assert.equal(restored.enabledAt,null);assert.ok(restored.version>saved.version);assert.equal((await f.call('/automation-runs')).data.length,0);assert.equal((await f.call('/webhook-endpoints')).data.length,0);assert.equal((await f.call('/webhook-deliveries')).data.length,0);assert.equal(f.observer.db.prepare('SELECT COUNT(*) AS total FROM webhook_events').get()!.total,0);
    assert.equal((await f.call('/integrations/gitlab')).data.webhookSecretConfigured,true);
    const legacy={...backup,schemaVersion:7};delete legacy.automationRules;assert.equal((await f.call('/import','POST',{data:legacy})).status,200);assert.equal((await f.call('/automation-rules')).data.length,0);
  }finally{await f.close();}
});

test('late native import validation failure rolls back rule, destination, queue and config generation',async()=>{
  const f=await fixture();try{
    await configure(f);await endpoint(f);await rule(f);await hook(f);const backup=(await f.call('/export')).data;
    const before={rules:(await f.call('/automation-rules')).data,endpoints:(await f.call('/webhook-endpoints')).data,deliveries:(await f.call('/webhook-deliveries')).data,settings:(await f.call('/integrations/gitlab')).data,generation:f.observer.setting('outboundWebhookGeneration')};
    backup.dependencies.push({id:randomUUID(),predecessorId:'missing-issue',successorId:'issue-1',type:'FS',lagDays:0});assert.equal((await f.call('/import','POST',{data:backup})).status,404);
    assert.deepEqual((await f.call('/automation-rules')).data,before.rules);assert.deepEqual((await f.call('/webhook-endpoints')).data,before.endpoints);assert.deepEqual((await f.call('/webhook-deliveries')).data,before.deliveries);assert.deepEqual((await f.call('/integrations/gitlab')).data,before.settings);assert.equal(f.observer.setting('outboundWebhookGeneration'),before.generation);
  }finally{await f.close();}
});

test('API keys cannot configure automation or destinations and outbound events retain fixed key actor',async()=>{
  const f=await fixture();try{
    await endpoint(f);const key=(await f.call('/api-keys','POST',{name:'합성 쓰기',access:'write',projectIds:['project-neo'],expiresAt:null},{'X-Actor-Id':'user-jun'})).data;
    const headers={Authorization:`Bearer ${key.token}`,'X-Actor-Id':'user-seo'};for(const path of ['/v1/automation-rules','/v1/webhook-endpoints','/v1/integrations/gitlab'])assert.equal((await f.call(path,'POST',{},headers)).status,403);
    const issue=f.observer.get<Issue>('issues','issue-1')!;assert.equal((await f.call('/v1/issues/issue-1','PATCH',{expectedVersion:issue.version,title:issue.title+' API'},headers)).status,200);
    const deliveries=(await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;assert.equal(deliveries.length,1);const detail=(await f.call('/webhook-deliveries/'+deliveries[0].id)).data;assert.equal(detail.envelope.actorId,'user-jun');assert.equal(detail.envelope.origin,'user');
  }finally{await f.close();}
});

test('Store change listeners join implicit writes and preserve separate async mutation contexts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-store-observer-')),store=new Store(dir);try{
    store.put('activities',{id:'seed'});const stop=store.onChange(change=>{store.put('settings_shadow',{id:'shadow',context:change.context});throw new Error('reject event enqueue');},['activities']);store.db.exec('CREATE TABLE settings_shadow(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    assert.throws(()=>store.withMutationContext({actorId:'first',origin:'user'},()=>store.put('activities',{id:'seed',value:2})),/reject event/);assert.deepEqual(store.get('activities','seed'),{id:'seed'});assert.equal(store.all('settings_shadow').length,0);stop();
    const contexts:string[]=[];store.onChange(change=>{contexts.push(change.context.actorId!);},['activities']);
    await Promise.all([store.withMutationContext({actorId:'one',origin:'user'},async()=>{await Promise.resolve();store.put('activities',{id:'one'});}),store.withMutationContext({actorId:'two',origin:'automation'},async()=>{await Promise.resolve();store.put('activities',{id:'two'});})]);assert.deepEqual(contexts,['one','two']);
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('automation audit failure rolls back link, inbox, cursor, issue and outgoing delivery together',async()=>{
  const f=await fixture();try{
    await configure(f);await endpoint(f);await rule(f);const before=f.observer.get<Issue>('issues','issue-1')!,body=payload(),id=randomUUID();
    f.observer.db.exec("CREATE TRIGGER reject_automation_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='GitLab 자동화 상태 변경' BEGIN SELECT RAISE(ABORT,'synthetic automation audit rejection'); END;");
    assert.equal((await hook(f,body,id)).status,500);assert.deepEqual(f.observer.get('issues','issue-1'),before);for(const table of ['webhook_inbox','gitlab_object_cursors','gitlab_links','automation_runs','webhook_events','webhook_deliveries'])assert.equal(f.observer.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total,0,table);
    f.observer.db.exec('DROP TRIGGER reject_automation_audit');assert.equal((await hook(f,body,id)).status,200);assert.equal(f.observer.get<Issue>('issues','issue-1')!.status,'done');assert.equal((await f.call('/webhook-deliveries')).data.length,1);
  }finally{await f.close();}
});

test('rules protect status/type references and connection credential removal disables stale rules',async()=>{
  const f=await fixture();try{
    await configure(f);const wfPath='/projects/project-neo/workflow',schemaPath='/projects/project-neo/issue-schema';
    const workflow=(await f.call(wfPath)).data,schema=(await f.call(schemaPath)).data;const addedWorkflow={...workflow,statuses:[...workflow.statuses,{id:'verification',label:'검증대기',category:'in_progress',color:'#123456'}],expectedVersion:workflow.version};assert.equal((await f.call(wfPath,'PATCH',addedWorkflow)).status,200);
    const addedSchema={...schema,issueTypes:[...schema.issueTypes,{id:'synthetic_type',name:'합성유형',color:'#123456',archived:false}],expectedVersion:schema.version};assert.equal((await f.call(schemaPath,'PATCH',addedSchema)).status,200);
    const saved=await rule(f,{fromStatuses:['verification'],issueTypes:['synthetic_type']});assert.equal((await f.call(wfPath,'PATCH',{...workflow,expectedVersion:workflow.version+1})).status,409);assert.equal((await f.call(schemaPath,'PATCH',{...schema,expectedVersion:schema.version+1})).status,409);
    const config=(await f.call('/integrations/gitlab')).data;assert.equal((await f.call('/integrations/gitlab','PATCH',{expectedVersion:config.version,webhookSecret:''})).status,200);const disabled=(await f.call<AutomationRule[]>('/automation-rules')).data[0];assert.equal(disabled.enabled,false);assert.equal(disabled.enabledAt,null);assert.ok(disabled.version>saved.version);assert.equal((await f.call('/automation-rules/'+saved.id,'PATCH',{expectedVersion:saved.version,enabled:true})).status,409);
    assert.equal((await f.call('/automation-rules/'+saved.id,'DELETE',{expectedVersion:disabled.version})).status,200);assert.equal((await f.call(wfPath,'PATCH',{...workflow,expectedVersion:workflow.version+1})).status,200);assert.equal((await f.call(schemaPath,'PATCH',{...schema,expectedVersion:schema.version+1})).status,200);
  }finally{await f.close();}
});
