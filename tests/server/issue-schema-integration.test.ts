import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, AutomaticSchedulePreview, Issue, ProjectIssueSchema, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number };
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'teamspace-schema-integration-'));
  const service=createApp({dataDir:dir});const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    async call<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,token?:string){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{'X-Actor-Id':'user-yun'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as T};},
    async close(){service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});},
  };
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const path='/projects/project-neo/issue-schema';
async function configure(f:Fixture){
  const schema=(await f.call<ProjectIssueSchema>(path)).data;
  const response=await f.call<ProjectIssueSchema>(path,'PATCH',{...schema,expectedVersion:schema.version,issueTypes:[...schema.issueTypes,{id:'incident',name:'운영 장애',color:'#ac4672',archived:false}],fields:[
    {id:'severity',name:'영향 범위',description:'영향을 받는 서비스',kind:'select',required:true,issueTypes:['incident'],options:[{id:'major',name:'서비스 전체',archived:false},{id:'minor',name:'일부 기능',archived:false}],archived:false},
    {id:'risk',name:'위험 점수',description:'',kind:'number',required:true,issueTypes:['incident'],options:[],archived:false},
    {id:'reviewed',name:'검토 여부',description:'',kind:'checkbox',required:true,issueTypes:['incident'],options:[],archived:false},
    {id:'evidence',name:'검증 내용',description:'',kind:'text',required:false,issueTypes:[],options:[],archived:false},
  ]});assert.equal(response.status,200,JSON.stringify(response.data));return response.data;
}
const values={severity:'major',risk:0,reviewed:false};

test('a project with only custom types has a valid API default and cannot save an empty active type list or the all-filter sentinel',async()=>{
  const f=await fixture();try{
    const created=await f.call<{id:string}>('/projects','POST',{name:'사용자 유형 전용',key:'QAF'});assert.equal(created.status,201);
    const endpoint=`/projects/${created.data.id}/issue-schema`,initial=(await f.call<ProjectIssueSchema>(endpoint)).data;
    const configured=await f.call<ProjectIssueSchema>(endpoint,'PATCH',{...initial,expectedVersion:initial.version,issueTypes:[{id:'inspection',name:'검사 요청',color:'#588b9c',archived:false}]});assert.equal(configured.status,200,JSON.stringify(configured.data));
    const issue=await f.call<Issue>('/issues','POST',{projectId:created.data.id,title:'유형 생략 시 기본 요청'});assert.equal(issue.status,201,JSON.stringify(issue.data));assert.equal(issue.data.type,'inspection');
    assert.equal((await f.call(endpoint,'PATCH',{...configured.data,expectedVersion:configured.data.version,issueTypes:configured.data.issueTypes.map(type=>({...type,archived:true}))})).status,400);
    assert.equal((await f.call(endpoint,'PATCH',{...configured.data,expectedVersion:configured.data.version,issueTypes:[...configured.data.issueTypes,{id:'all',name:'혼동되는 유형',color:'#588b9c',archived:false}]})).status,400);
    assert.equal((await f.call<ProjectIssueSchema>(endpoint)).data.version,configured.data.version);
  }finally{await f.close();}
});

test('scoped automation reads definitions and writes typed values through the same validators; search follows renamed labels',async()=>{
  const f=await fixture();try{
    let schema=await configure(f);
    const createdKey=await f.call<ApiKeyCreated>('/api-keys','POST',{name:'합성 양식 자동화',access:'write',projectIds:['project-neo'],expiresAt:null});assert.equal(createdKey.status,201);const token=createdKey.data.token;
    assert.equal((await f.call('/v1/projects/project-team/issue-schema','GET',undefined,token)).status,403);
    assert.deepEqual((await f.call<ProjectIssueSchema>('/v1'+path,'GET',undefined,token)).data,schema);
    assert.equal((await f.call('/v1'+path,'PATCH',{...schema,expectedVersion:schema.version},token)).status,403);
    const made=await f.call<Issue>('/v1/issues','POST',{projectId:'project-neo',type:'incident',title:'사용자 정의 API 장애',customFields:values},token);assert.equal(made.status,201,JSON.stringify(made.data));assert.deepEqual(made.data.customFields,values);
    const rejected=await f.call(`/v1/issues/${made.data.id}`,'PATCH',{expectedVersion:made.data.version,customFields:{...values,risk:'많음'}},token);assert.equal(rejected.status,400);
    const unchanged=(await f.call<Issue>(`/v1/issues/${made.data.id}`,'GET',undefined,token)).data;assert.equal(unchanged.version,made.data.version);assert.deepEqual(unchanged.customFields,values);
    schema=(await f.call<ProjectIssueSchema>(path,'PATCH',{...schema,expectedVersion:schema.version,issueTypes:schema.issueTypes.map(type=>type.id==='incident'?{...type,name:'고객 영향 사건'}:type),fields:schema.fields.map(field=>field.id==='severity'?{...field,name:'고객 영향도',options:field.options.map(option=>option.id==='major'?{...option,name:'전사 서비스 중단'}:option)}:field)})).data;
    const found=await f.call<{issues:Issue[]}>('/search?q='+encodeURIComponent('전사 서비스 중단'));assert.ok(found.data.issues.some(issue=>issue.id===made.data.id));
    assert.ok((await f.call<{issues:Issue[]}>('/search?q='+encodeURIComponent('고객 영향 사건'))).data.issues.some(issue=>issue.id===made.data.id));
    const patched=await f.call<Issue>(`/v1/issues/${made.data.id}`,'PATCH',{expectedVersion:unchanged.version,title:'제목만 수정'},token);assert.equal(patched.status,200);assert.deepEqual(patched.data.customFields,values);
    const snapshot=(await f.call<WorkspaceSnapshot>('/workspace')).data;assert.ok(snapshot.activities.some(activity=>activity.resourceId===made.data.id&&activity.actorId==='user-yun'));
  }finally{await f.close();}
});

test('native current backup preserves type/option IDs, archived history, workflow and view references; bad imports roll back and legacy5 resets definitions',async()=>{
  const f=await fixture();try{
    const initial=(await f.call<WorkspaceSnapshot>('/workspace')).data,calendar=initial.calendars!.find(value=>value.projectId==='project-neo')!;
    assert.equal((await f.call('/projects/project-neo/calendar','PATCH',{...calendar,expectedVersion:calendar.version,exceptions:[{date:'2026-12-25',isWorking:false,label:'회사 휴무'}]})).status,200);
    const milestone=await f.call<{id:string}>('/milestones','POST',{projectId:'project-neo',title:'이전 형식의 목표',date:'2026-12-24'});assert.equal(milestone.status,201);
    const visible=(await f.call<WorkspaceSnapshot>('/workspace')).data;
    const baseline=await f.call<{id:string}>('/baselines','POST',{projectId:'project-neo',name:'이전 형식의 일정',expectedIssueVersions:Object.fromEntries(visible.issues.filter(issue=>issue.projectId==='project-neo').map(issue=>[issue.id,issue.version])),expectedMilestoneVersions:Object.fromEntries(visible.milestones!.filter(item=>item.projectId==='project-neo').map(item=>[item.id,item.version])),expectedCalendarVersion:visible.calendars!.find(value=>value.projectId==='project-neo')!.version});assert.equal(baseline.status,201);
    const legacy=(await f.call<Backup>('/export')).data;legacy.schemaVersion=5;
    let schema=await configure(f);
    const made=await f.call<Issue>('/issues','POST',{projectId:'project-neo',type:'incident',title:'보관할 업무',customFields:values});assert.equal(made.status,201);
    const workflow=(await f.call<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    const savedWorkflow=await f.call('/projects/project-neo/workflow','PATCH',{...workflow,expectedVersion:workflow.version,fieldRules:[{issueType:'incident',statusId:'done',requiredFields:['custom:evidence']}]});assert.equal(savedWorkflow.status,200,JSON.stringify(savedWorkflow.data));
    const view=await f.call<SavedView>('/views','POST',{projectId:'project-neo',name:'장애 모아보기',layout:'list',filters:{query:'',status:'all',assigneeId:'all',type:'incident'}});assert.equal(view.status,201);
    schema=(await f.call<ProjectIssueSchema>(path,'PATCH',{...schema,expectedVersion:schema.version,issueTypes:schema.issueTypes.map(type=>type.id==='incident'?{...type,archived:true}:type),fields:schema.fields.map(field=>field.id==='severity'?{...field,options:field.options.map(option=>option.id==='major'?{...option,archived:true}:option)}:field)})).data;
    const backup=(await f.call<Backup>('/export')).data;assert.equal(backup.schemaVersion,17);
    const bad=structuredClone(backup);bad.issueSchemas=bad.issueSchemas!.filter(value=>value.projectId!=='project-neo');
    const before=(await f.call<WorkspaceSnapshot>('/workspace')).data;assert.equal((await f.call('/import','POST',{data:bad})).status,400);assert.deepEqual((await f.call('/workspace')).data,before);
    const badUser=structuredClone(backup);badUser.issues.find(issue=>issue.id===made.data.id)!.customFields={...values,reviewed:'false'};assert.equal((await f.call('/import','POST',{data:badUser})).status,400);assert.deepEqual((await f.call('/workspace')).data,before);
    assert.equal((await f.call('/import','POST',{data:backup})).status,200);
    const restored=(await f.call<WorkspaceSnapshot>('/workspace')).data;assert.deepEqual(restored.issues.find(issue=>issue.id===made.data.id)!.customFields,values);assert.ok(restored.issueSchemas!.find(value=>value.projectId==='project-neo')!.version>schema.version);assert.equal(restored.savedViews!.find(value=>value.id===view.data.id)!.filters.type,'incident');assert.ok(restored.workflows!.find(value=>value.projectId==='project-neo')!.fieldRules.some(rule=>rule.requiredFields.includes('custom:evidence')));
    assert.equal((await f.call(path,'PATCH',{...schema,expectedVersion:schema.version})).status,409);
    assert.equal((await f.call('/import','POST',{data:legacy})).status,200);const old=(await f.call<WorkspaceSnapshot>('/workspace')).data;assert.equal(old.issueSchemas!.find(value=>value.projectId==='project-neo')!.fields.length,0);assert.ok(!old.issueSchemas!.find(value=>value.projectId==='project-neo')!.issueTypes.some(type=>type.id==='incident'));assert.equal(old.calendars!.find(value=>value.projectId==='project-neo')!.exceptions[0].label,'회사 휴무');assert.ok(old.milestones!.some(item=>item.id===milestone.data.id));assert.ok(old.baselines!.some(item=>item.id===baseline.data.id));
  }finally{await f.close();}
});

test('custom workflow requirements gate state transitions and schedule changes, and schema edits invalidate stored automatic proposals',async()=>{
  const f=await fixture();try{
    let schema=await configure(f);
    const made=(await f.call<Issue>('/issues','POST',{projectId:'project-neo',type:'incident',title:'필수 값 일정',customFields:values,startDate:'2026-11-21',endDate:'2026-11-24'})).data;
    const proposal=await f.call<AutomaticSchedulePreview>('/schedule/auto-preview','POST',{projectId:'project-neo',issueIds:[made.id]});assert.equal(proposal.status,200);assert.equal(proposal.data.blocking.length,0);assert.ok(proposal.data.changes.length);
    schema=(await f.call<ProjectIssueSchema>(path,'PATCH',{...schema,expectedVersion:schema.version,fields:schema.fields.map(field=>field.id==='risk'?{...field,name:'영향 점수'}:field)})).data;
    assert.equal((await f.call('/schedule/auto-apply','POST',{previewId:proposal.data.previewId})).status,409);
    const workflow=(await f.call<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    assert.equal((await f.call('/projects/project-neo/workflow','PATCH',{...workflow,expectedVersion:workflow.version,fieldRules:[{issueType:'incident',statusId:'done',requiredFields:['custom:evidence']}]})).status,200);
    assert.equal((await f.call(`/issues/${made.id}`,'PATCH',{expectedVersion:made.version,status:'done'})).status,422);
    const done=await f.call<Issue>(`/issues/${made.id}`,'PATCH',{expectedVersion:made.version,status:'done',customFields:{...values,evidence:'재현·검증 완료'}});assert.equal(done.status,200);
    const requiredAdded=await f.call<ProjectIssueSchema>(path,'PATCH',{...schema,expectedVersion:schema.version,fields:[...schema.fields,{id:'approval',name:'승인 기록',description:'',kind:'text',required:true,issueTypes:['incident'],options:[],archived:false}]});assert.equal(requiredAdded.status,200);
    assert.equal((await f.call('/schedule/apply','POST',{changes:[{id:made.id,expectedVersion:done.data.version,startDate:'2026-11-23',endDate:'2026-11-25'}]})).status,422);
    const still=(await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue=>issue.id===made.id)!;assert.equal(still.version,done.data.version);assert.equal(still.startDate,made.startDate);
  }finally{await f.close();}
});
