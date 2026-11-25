import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { Store } from '../../server/store.js';
import { seed } from '../../server/seed.js';
import { PlanningService, PlanningError } from '../../server/planning.js';
import { planningFields } from '../../shared/planning-helpers.js';
import type { Issue, PlanningItem, PlanningKind, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture(dir=mkdtempSync(join(tmpdir(),'teamspace-planning-')),withSeed=true){
  const service=createApp({dataDir:dir,seed:withSeed}),server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/api`;let closed=false;
  const request=async(path:string,method='GET',data?:unknown)=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json() as any};};
  return{dir,request,close:async()=>{if(closed)return;closed=true;service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));},remove:()=>rmSync(dir,{recursive:true,force:true})};
}
const kinds:PlanningKind[]=['cycle','module','release'];
async function create(f:Awaited<ReturnType<typeof fixture>>,kind:PlanningKind,name:string,extra:Record<string,unknown>={}){const response=await f.request('/planning-items','POST',{projectId:'project-neo',kind,name,...extra});assert.equal(response.status,201,JSON.stringify(response.data));return response.data as PlanningItem;}
async function issue(f:Awaited<ReturnType<typeof fixture>>,title:string,extra:Record<string,unknown>={}){const response=await f.request('/issues','POST',{projectId:'project-neo',title,...extra});assert.equal(response.status,201,JSON.stringify(response.data));return response.data as Issue;}
async function snapshot(f:Awaited<ReturnType<typeof fixture>>){return(await f.request('/workspace')).data as WorkspaceSnapshot;}

test('startup migration preserves exact legacy names and history, bumps stale issue versions, and is idempotent on reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-old-planning-')),store=new Store(dir);seed(store);
  const labels=new Map([['issue-1','Sprint'],['issue-2','sprint'],['issue-3',' Sprint '],['issue-4','Sprint'],['issue-9','Sprint']]);
  for(const [id,cycle]of labels){const old=store.get<Issue>('issues',id)!;store.put('issues',{...old,cycle});}
  const original=store.all<Issue>('issues'),activities=store.all('activities');store.db.close();const f=await fixture(dir);let next:Awaited<ReturnType<typeof fixture>>|undefined;
  try{
    const data=await snapshot(f);for(const old of original){const migrated=data.issues.find(value=>value.id===old.id)!;assert.equal(migrated.version,old.version+1);assert.equal(migrated.completedAt,old.completedAt);assert.deepEqual(migrated.startDate,old.startDate);assert.equal(migrated.status,old.status);for(const kind of kinds){const fields=planningFields(kind),item=data.planningItems!.find(item=>item.id===migrated[fields.idField]);assert.equal(migrated[fields.labelField],old[fields.labelField]);assert.equal(item?.name||null,old[fields.labelField]);}}
    assert.deepEqual(data.activities,activities);const a=data.issues.find(value=>value.id==='issue-1')!,b=data.issues.find(value=>value.id==='issue-2')!,c=data.issues.find(value=>value.id==='issue-3')!,d=data.issues.find(value=>value.id==='issue-4')!,other=data.issues.find(value=>value.id==='issue-9')!;assert.notEqual(a.cycleId,b.cycleId);assert.notEqual(a.cycleId,c.cycleId);assert.equal(a.cycleId,d.cycleId);assert.notEqual(a.cycleId,other.cycleId);
    assert.equal((await f.request('/issues/issue-1','PATCH',{expectedVersion:original.find(value=>value.id==='issue-1')!.version,cycleId:null})).status,409);
    const ids=data.planningItems!.map(item=>item.id).sort();await f.close();next=await fixture(dir);const reopened=await snapshot(next);assert.deepEqual(reopened.planningItems!.map(item=>item.id).sort(),ids);assert.equal(reopened.issues.find(value=>value.id==='issue-1')!.version,a.version);
  }finally{if(next)await next.close();await f.close();f.remove();}
});

test('planning CRUD validates metadata, uses canonical IDs and exact names, propagates renames, and protects archived/in-use items',async()=>{
  const f=await fixture();try{
    const item=await create(f,'cycle','개발 Sprint',{ownerId:'user-seo',startDate:'2026-11-16',endDate:'2026-11-27',targetDate:'2026-11-25'});
    assert.equal((await f.request('/planning-items','POST',{projectId:item.projectId,kind:item.kind,name:item.name})).status,409);await create(f,'cycle','개발 sprint');await create(f,'module',item.name);
    for(const fields of [{ownerId:'missing'},{status:'unknown'},{status:null},{description:null},{startDate:'2026-02-30'},{startDate:'2026-11-20',endDate:'2026-11-19'}])assert.equal((await f.request('/planning-items','POST',{projectId:item.projectId,kind:'release',name:'잘못된 항목',...fields})).status,400);
    assert.equal((await f.request(`/planning-items/${item.id}`,'PATCH',{expectedVersion:1,kind:'module'})).status,400);assert.equal((await f.request(`/planning-items/${item.id}`,'PATCH',{expectedVersion:1,projectId:'project-team'})).status,400);
    assert.equal((await f.request(`/planning-items/${item.id}`,'PATCH',{expectedVersion:99,name:'stale'})).status,409);
    const a=await issue(f,'계획 연결',{cycleId:item.id,cycle:'클라이언트의 오래된 표시 이름',startDate:'2026-11-17',endDate:'2026-11-19'});assert.equal(a.cycle,item.name);assert.equal(a.cycleId,item.id);
    const viaLabel=await issue(f,'기존 이름 호환',{cycle:item.name});assert.equal(viaLabel.cycleId,item.id);
    assert.equal((await f.request('/issues','POST',{projectId:'project-neo',title:'이름 자동 생성 금지',cycle:'없는 사이클'})).status,400);
    assert.equal((await f.request('/issues','POST',{projectId:'project-neo',title:'종류 불일치',moduleId:item.id})).status,400);
    assert.equal((await f.request('/issues','POST',{projectId:'project-team',title:'프로젝트 불일치',cycleId:item.id})).status,400);
    const renamed=await f.request(`/planning-items/${item.id}`,'PATCH',{expectedVersion:1,name:'  이름 보존 '.padEnd(110,'장')});assert.equal(renamed.status,200);const afterRename=await snapshot(f),a2=afterRename.issues.find(value=>value.id===a.id)!;assert.equal(a2.cycle,renamed.data.name);assert.equal(a2.cycleId,item.id);assert.equal(a2.version,a.version+1);assert.equal(a2.startDate,a.startDate);assert.equal(a2.endDate,a.endDate);assert.equal(a2.status,a.status);
    const newNameSearch=await f.request('/search?q='+encodeURIComponent(renamed.data.name));assert.ok(newNameSearch.data.issues.some((value:Issue)=>value.id===a.id));const oldNameSearch=await f.request('/search?q='+encodeURIComponent(item.name));assert.ok(!oldNameSearch.data.issues.some((value:Issue)=>value.id===a.id));
    assert.equal((await f.request(`/issues/${a.id}`,'PATCH',{expectedVersion:a.version,title:'stale'})).status,409);
    assert.equal((await f.request(`/planning-items/${item.id}?expectedVersion=2`,'DELETE')).status,409);
    const archived=await f.request(`/planning-items/${item.id}`,'PATCH',{expectedVersion:2,status:'archived'});assert.equal(archived.status,200);
    const retained=await f.request(`/issues/${a.id}`,'PATCH',{expectedVersion:a2.version,title:'보관된 계획은 기존 연결 유지'});assert.equal(retained.status,200);assert.equal(retained.data.cycleId,item.id);assert.equal(retained.data.cycle,renamed.data.name);
    assert.equal((await f.request('/issues','POST',{projectId:'project-neo',title:'신규 배정 금지',cycleId:item.id})).status,422);
    const members=(await snapshot(f)).issues.filter(value=>value.cycleId===item.id);const removed=await f.request(`/planning-items/${item.id}/issues`,'POST',{expectedVersion:archived.data.version,assignments:members.map(value=>({issueId:value.id,expectedVersion:value.version,assigned:false}))});assert.equal(removed.status,200);assert.equal(removed.data.updated.length,2);assert.equal(removed.data.item.version,3);
    assert.equal((await f.request(`/planning-items/${item.id}?expectedVersion=2`,'DELETE')).status,409);assert.equal((await f.request(`/planning-items/${item.id}?expectedVersion=3`,'DELETE')).status,200);assert.ok(!(await snapshot(f)).issues.some(value=>value.cycleId===item.id));assert.equal(viaLabel.startDate,null);
  }finally{await f.close();f.remove();}
});

test('bulk membership changes check every version and shared workflow rules before atomic issue/audit writes',async()=>{
  const f=await fixture();try{
    const plan=await create(f,'module','핵심 기능'),a=await issue(f,'업무 A',{description:'준비됨'}),b=await issue(f,'업무 B');
    const workflow=(await f.request('/projects/project-neo/workflow')).data;assert.equal((await f.request('/projects/project-neo/workflow','PATCH',{...workflow,expectedVersion:workflow.version,fieldRules:[{issueType:'*',statusId:'todo',requiredFields:['description']}]})).status,200);
    const before=await snapshot(f),assignments=[{issueId:a.id,expectedVersion:a.version,assigned:true},{issueId:b.id,expectedVersion:b.version,assigned:true}];
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments})).status,422);let state=await snapshot(f);assert.equal(state.activities.length,before.activities.length);assert.equal(state.issues.find(value=>value.id===a.id)!.version,1);assert.equal(state.issues.find(value=>value.id===a.id)!.moduleId,null);
    const b2=(await f.request(`/issues/${b.id}`,'PATCH',{expectedVersion:b.version,description:'준비 완료'})).data;
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments})).status,409);assert.equal((await snapshot(f)).issues.find(value=>value.id===a.id)!.moduleId,null);
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:99,assignments:[{...assignments[0]}]})).status,409);
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:[assignments[0],assignments[0]]})).status,400);
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:Array.from({length:1001},(_,i)=>({issueId:String(i),expectedVersion:1,assigned:true}))})).status,400);
    const applied=await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:[assignments[0],{issueId:b.id,expectedVersion:b2.version,assigned:true}]});assert.equal(applied.status,200);assert.equal(applied.data.item.version,1);assert.equal(applied.data.updated.length,2);assert.ok(applied.data.updated.every((value:Issue)=>value.moduleId===plan.id&&value.module===plan.name));
    state=await snapshot(f);assert.equal(state.activities.filter(value=>value.resourceType==='issue'&&value.action==='계획 연결 변경'&&[a.id,b.id].includes(value.resourceId)).length,2);
    const a2=state.issues.find(value=>value.id===a.id)!;const noOp=await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:[{issueId:a.id,expectedVersion:a2.version,assigned:true}]});assert.equal(noOp.status,200);assert.equal(noOp.data.updated.length,0);assert.equal((await snapshot(f)).activities.length,state.activities.length);
    const wrongProject=await issue(f,'다른 프로젝트',{projectId:'project-team',description:'설명'});assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:[{issueId:wrongProject.id,expectedVersion:1,assigned:true}]})).status,400);
    const activeWorkflow=(await f.request('/projects/project-neo/workflow')).data;assert.equal((await f.request('/projects/project-neo/workflow','PATCH',{...activeWorkflow,expectedVersion:activeWorkflow.version,fieldRules:[{issueType:'*',statusId:'todo',requiredFields:['description','module']}]})).status,200);
    assert.equal((await f.request(`/planning-items/${plan.id}/issues`,'POST',{expectedVersion:1,assignments:[{issueId:a.id,expectedVersion:a2.version,assigned:false}]})).status,422);assert.equal((await snapshot(f)).issues.find(value=>value.id===a.id)!.moduleId,plan.id);
  }finally{await f.close();f.remove();}
});

test('completed cycles preserve and remove historical membership while blocking new assignments', async () => {
  const source = await fixture(), restored = await fixture(undefined, false);
  try {
    const cycle = await create(source, 'cycle', '완료할 사이클', {
      status: 'active', startDate: '2026-11-09', endDate: '2026-11-20',
    });
    const linked = await issue(source, '완료된 업무', { cycleId: cycle.id, status: 'done' });
    const unassigned = await issue(source, '새로 연결하려는 업무');
    const completePath = `/planning-items/${cycle.id}/complete`;
    const review = await source.request(`${completePath}/preview`, 'POST', { expectedVersion: cycle.version, destinationId: null });
    assert.equal(review.status, 200, JSON.stringify(review.data));
    const completion = await source.request(completePath, 'POST', { previewId: review.data.previewId });
    assert.equal(completion.status, 200, JSON.stringify(completion.data));
    assert.equal(completion.data.cycle.status, 'completed');
    const current = completion.data.cycle as PlanningItem;
    const before = await snapshot(source);

    for (const fields of [{ cycleId: cycle.id }, { cycle: cycle.name }]) {
      const rejected = await source.request('/issues', 'POST', { projectId: cycle.projectId, title: '완료된 사이클로 생성', ...fields });
      assert.equal(rejected.status, 422);
      assert.match(rejected.data.error, /완료된 사이클/);
    }
    const rejectedUpdate = await source.request(`/issues/${unassigned.id}`, 'PATCH', { expectedVersion: unassigned.version, cycleId: cycle.id });
    assert.equal(rejectedUpdate.status, 422);
    assert.match(rejectedUpdate.data.error, /완료된 사이클/);
    const batch = await source.request(`/planning-items/${cycle.id}/issues`, 'POST', { expectedVersion: current.version, assignments: [
      { issueId: linked.id, expectedVersion: linked.version, assigned: false },
      { issueId: unassigned.id, expectedVersion: unassigned.version, assigned: true },
    ] });
    assert.equal(batch.status, 422);
    assert.match(batch.data.error, /완료된 사이클/);
    const bulk = await source.request(`/projects/${cycle.projectId}/issues/bulk-preview`, 'POST', {
      issues: [linked, unassigned].map(value => ({ id: value.id, expectedVersion: value.version })),
      changes: { cycleId: cycle.id, priority: 'high' },
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual([bulk.data.previewId, bulk.data.changed, bulk.data.blocked], [null, 1, 1]);
    assert.match(bulk.data.rows.find((row: { id: string }) => row.id === unassigned.id).reason, /완료된 사이클/);
    assert.deepEqual(await snapshot(source), before);

    const retained = await source.request(`/issues/${linked.id}`, 'PATCH', { expectedVersion: linked.version, cycleId: cycle.id, title: '기존 연결 유지' });
    assert.equal(retained.status, 200);
    assert.equal(retained.data.cycleId, cycle.id);
    const backup = await source.request('/export');
    assert.equal((await restored.request('/import', 'POST', { data: backup.data })).status, 200);
    assert.equal((await snapshot(restored)).issues.find(value => value.id === linked.id)?.cycleId, cycle.id);

    const deleted = await source.request(`/issues/${linked.id}`, 'DELETE', { expectedVersion: retained.data.version });
    assert.equal(deleted.status, 200);
    const fromTrash = await source.request(`/trash/${deleted.data.trashEntryId}/restore`, 'POST', {});
    assert.equal(fromTrash.status, 200, JSON.stringify(fromTrash.data));
    const restoredIssue = (await snapshot(source)).issues.find(value => value.id === linked.id)!;
    assert.equal(restoredIssue.cycleId, cycle.id);
    const removed = await source.request(`/planning-items/${cycle.id}/issues`, 'POST', { expectedVersion: current.version,
      assignments: [{ issueId: linked.id, expectedVersion: restoredIssue.version, assigned: false }],
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.updated[0].cycleId, null);

    const module = await create(source, 'module', '완료된 모듈', { status: 'completed' });
    const release = await create(source, 'release', '완료된 릴리스', { status: 'completed' });
    const otherPlanning = await issue(source, '모듈과 릴리스 연결', { moduleId: module.id, releaseId: release.id });
    assert.equal(otherPlanning.moduleId, module.id);
    assert.equal(otherPlanning.releaseId, release.id);
    assert.equal((await source.request(`/planning-items/${cycle.id}`, 'PATCH', { expectedVersion: current.version, status: 'planned' })).status, 200);
    assert.equal((await issue(source, '다시 계획 중인 사이클', { cycleId: cycle.id })).cycleId, cycle.id);
  } finally {
    await source.close(); await restored.close();
    source.remove(); restored.remove();
  }
});

test('current backup preserves canonical planning IDs and archived refs; legacy1/2/3 migrate original labels and invalid refs rollback',async()=>{
  const source=await fixture(),target=await fixture(undefined,false);
  try{
    const exactName=' '+'릴'.repeat(118)+' ';assert.equal(exactName.length,120);
    const plan=await create(source,'release',exactName,{ownerId:'user-yun',targetDate:'2026-12-01'});assert.equal(plan.name,exactName);const a=await issue(source,'계획 백업',{releaseId:plan.id});assert.equal(a.release,exactName);assert.equal((await source.request(`/planning-items/${plan.id}`,'PATCH',{expectedVersion:1,status:'archived'})).status,200);
    const exported=(await source.request('/export')).data;assert.equal(exported.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.ok(exported.planningItems.some((item:PlanningItem)=>item.id===plan.id));
    const misleading=structuredClone(exported);misleading.issues.find((value:Issue)=>value.id===a.id).release='잘못된 표시 이름';assert.equal((await target.request('/import','POST',{data:misleading})).status,200);let imported=await snapshot(target);assert.equal(imported.issues.find(value=>value.id===a.id)!.release,plan.name);assert.equal(imported.issues.find(value=>value.id===a.id)!.releaseId,plan.id);assert.equal(imported.planningItems!.find(value=>value.id===plan.id)!.status,'archived');
    const priorVersion=imported.planningItems!.find(value=>value.id===plan.id)!.version;assert.equal((await target.request('/import','POST',{data:exported})).status,200);imported=await snapshot(target);assert.ok(imported.planningItems!.find(value=>value.id===plan.id)!.version>priorVersion);assert.equal((await target.request(`/planning-items/${plan.id}`,'PATCH',{expectedVersion:priorVersion,name:'stale'})).status,409);
    const before=await snapshot(target);for(const change of [(data:any)=>data.issues.find((value:Issue)=>value.id===a.id).releaseId='missing',(data:any)=>data.issues.find((value:Issue)=>value.id===a.id).moduleId=plan.id,(data:any)=>delete data.issues[0].cycleId,(data:any)=>data.planningItems.push({...data.planningItems[0],id:'other-id'})]){const broken=structuredClone(exported);change(broken);assert.equal((await target.request('/import','POST',{data:broken})).status,400);assert.deepEqual(await snapshot(target),before);}
    for(const schemaVersion of [1,2,3]){const legacy=structuredClone(exported);legacy.schemaVersion=schemaVersion;if(schemaVersion===1){legacy.attachments=[];legacy.attachmentContents=[];}legacy.issues.find((value:Issue)=>value.id===a.id).releaseId='ignored-old-id';const oldText=legacy.issues.find((value:Issue)=>value.id===a.id).release;assert.equal((await target.request('/import','POST',{data:legacy})).status,200);const result=await snapshot(target),migrated=result.issues.find(value=>value.id===a.id)!;assert.equal(migrated.release,oldText);assert.notEqual(migrated.releaseId,'ignored-old-id');assert.equal(result.planningItems!.find(item=>item.id===migrated.releaseId)!.name,oldText);}
  }finally{for(const f of[source,target]){await f.close();f.remove();}}
});

test('pure import preparation does not mutate input or write records; schema4 requires sound nullable IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-planning-pure-')),store=new Store(dir);seed(store);const planning=new PlanningService(store);
  try{
    const projects=store.all('projects'),users=store.all('users'),issues=store.all<Issue>('issues');const original=JSON.stringify(issues);const prepared=planning.prepareImport([],projects,users,issues,{legacy:true});assert.equal(JSON.stringify(issues),original);assert.equal(planning.all().length,0);assert.ok(prepared.items.length>0);assert.ok(prepared.issues.every(value=>Object.hasOwn(value,'cycleId')&&Object.hasOwn(value,'moduleId')&&Object.hasOwn(value,'releaseId')));
    const invalid=structuredClone(prepared.issues);invalid[0].cycleId='';assert.throws(()=>planning.prepareImport(prepared.items,projects,users,invalid,{legacy:false}),PlanningError);
    const restored=planning.prepareImport(prepared.items,projects,users,prepared.issues,{legacy:false});assert.equal(restored.items.length,prepared.items.length);assert.equal(planning.all().length,0);
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
