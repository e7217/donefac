import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { PlanningItem, PlanningKind, SavedView } from '../../shared/types.js';

async function fixture(directory?: string) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'teamspace-views-'));
  const runtime = createApp({dataDir:dir});
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const base = `http://127.0.0.1:${address.port}/api`;
  let closed = false;
  return {
    dir,
    async request(path:string, method='GET', body?:unknown, headers?:Record<string,string>) {
      const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Actor-Id':'user-min',...headers},...(body===undefined ? {} : {body:JSON.stringify(body)})});
      // Test requests include both successful resources and intentionally invalid packages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {status:response.status,data:await response.json() as any};
    },
    async close() {if(closed)return;closed=true;await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();},
  };
}
const definition = {projectId:'project-neo',name:'검토 업무',layout:'board',filters:{query:' 오류 ',status:'review',assigneeId:'user-seo',type:'버그'}};

async function addPlanningItem(f: Awaited<ReturnType<typeof fixture>>, kind: PlanningKind, name: string, projectId = definition.projectId): Promise<PlanningItem> {
  const created = await f.request('/planning-items', 'POST', {projectId, kind, name});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

test('saved views preserve real filters across reload and enforce version-safe shared edits',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof fixture>>|undefined;
  try {
    const created=await f.request('/views','POST',definition);assert.equal(created.status,201);assert.equal(created.data.version,1);assert.equal(created.data.filters.query,' 오류 ');
    const id=created.data.id;
    assert.equal((await f.request('/views?projectId=project-neo')).data.length,1);
    assert.equal((await f.request('/views?projectId=project-team')).data.length,0);
    const updated=await f.request('/views/'+id,'PATCH',{expectedVersion:1,name:'검토할 버그',filters:{...definition.filters,query:'연결'}});assert.equal(updated.status,200);assert.equal(updated.data.version,2);
    assert.equal((await f.request('/views/'+id,'PATCH',{expectedVersion:1,name:'오래된 변경'})).status,409);
    assert.equal((await f.request('/views/'+id+'?expectedVersion=1','DELETE')).status,409);
    await f.close();reopened=await fixture(f.dir);
    const persisted=await reopened.request('/views?projectId=project-neo');assert.equal(persisted.data[0].name,'검토할 버그');assert.equal(persisted.data[0].filters.query,'연결');
    assert.equal((await reopened.request('/views/'+id+'?expectedVersion=2','DELETE')).status,200);
    assert.equal((await reopened.request('/views?projectId=project-neo')).data.length,0);
  } finally {if(reopened)await reopened.close();else await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('saved view validation rejects invalid filters and duplicate project names without changing valid views',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/views','POST',definition)).status,201);
    assert.equal((await f.request('/views','POST',definition)).status,409);
    assert.equal((await f.request('/views','POST',{...definition,projectId:'project-team'})).status,201);
    assert.equal((await f.request('/views','POST',{...definition,name:'잘못된 보기',filters:[]})).status,400);
    assert.equal((await f.request('/views','POST',{...definition,name:'없는 담당자',filters:{...definition.filters,assigneeId:'missing'}})).status,400);
    assert.equal((await f.request('/views','POST',{...definition,projectId:'missing'})).status,404);
    assert.equal((await f.request('/views?projectId=project-neo')).data.length,1);
  }finally{await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('native backup preserves saved view definitions and rejects bad restore atomically',async()=>{
  const f=await fixture();try{
    const created=await f.request('/views','POST',definition);assert.equal(created.status,201);
    for (const name of ['Ångström','ångström']) assert.equal((await f.request('/views','POST',{...definition,name})).status,201);
    const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.equal(exported.savedViews.length,3);
    assert.equal((await f.request('/views/'+created.data.id,'PATCH',{expectedVersion:1,name:'임시 변경'})).status,200);
    const bad=structuredClone(exported);bad.savedViews[0].authorId='missing';assert.equal((await f.request('/import','POST',{data:bad})).status,400);
    assert.equal((await f.request('/views?projectId=project-neo')).data.find((view:{id:string})=>view.id===created.data.id).name,'임시 변경');
    assert.equal((await f.request('/import','POST',{data:exported})).status,200);
    const list=(await f.request('/views?projectId=project-neo')).data;assert.equal(list.length,3);
    const restored=list.find((view:{id:string})=>view.id===created.data.id);assert.equal(restored.name,definition.name);assert.deepEqual(restored.filters,definition.filters);assert.ok(restored.version>2);
    assert.equal((await f.request('/views/'+restored.id,'PATCH',{expectedVersion:2,name:'이전 편집'})).status,409);
  }finally{await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('shared planning filters validate exact project and kind, allow archived plans and prevent deleting references', async () => {
  const f = await fixture();
  try {
    const cycle = await addPlanningItem(f, 'cycle', '필터로 참조할 사이클');
    const release = await addPlanningItem(f, 'release', '필터로 참조할 릴리스');
    const foreign = await addPlanningItem(f, 'cycle', cycle.name, 'project-team');
    const planning = {cycleId: cycle.id, moduleId: null, releaseId: release.id, dates: {mode: 'overlap', from: '2024-02-29', to: '2024-03-01'}};
    const filters = {...definition.filters, planning};
    for (const invalid of [null, [], {sprintId: cycle.id}, {cycleId: 'unknown'}, {cycleId: foreign.id}, {cycleId: release.id},
      {dates: {mode: 'overlap'}}, {dates: {mode: 'due', from: '2025-02-29'}},
      {dates: {mode: 'due', from: '2026-02-02', to: '2026-02-01'}}, {dates: {mode: 'planned', from: '2026-01-01'}}]) {
      const rejected = await f.request('/views', 'POST', {...definition, filters: {...filters, planning: invalid}});
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    }
    const created = await f.request('/views', 'POST', {...definition, filters});
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.filters, filters);
    const viewPath = `/views/${created.data.id}`;
    const wrongPlan = await f.request(viewPath, 'PATCH', {expectedVersion: 1, filters: {...filters, planning: {releaseId: cycle.id}}});
    assert.equal(wrongPlan.status, 400);

    const planPath = `/planning-items/${cycle.id}`;
    const deletion = await f.request(`${planPath}?expectedVersion=${cycle.version}`, 'DELETE');
    assert.equal(deletion.status, 409);
    assert.equal(deletion.data.details.viewId, created.data.id);
    const archived = await f.request(planPath, 'PATCH', {expectedVersion: cycle.version, status: 'archived', name: '같은 ID의 보관 사이클'});
    assert.equal(archived.status, 200);
    assert.equal(archived.data.status, 'archived');
    const renamed = await f.request(viewPath, 'PATCH', {expectedVersion: 1, name: '보관 사이클 보기', filters: definition.filters});
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.filters, filters);
    assert.equal((await f.request(`${planPath}?expectedVersion=${archived.data.version}`, 'DELETE')).status, 409);
    assert.equal((await f.request(`/planning-items/${release.id}?expectedVersion=${release.version}`, 'DELETE')).status, 409);

    const cleared = await f.request(viewPath, 'PATCH', {expectedVersion: renamed.data.version, filters: {...definition.filters, planning: {}}});
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.filters, definition.filters);
    assert.equal((await f.request(`${planPath}?expectedVersion=${archived.data.version}`, 'DELETE')).status, 200);
    assert.equal((await f.request(`/planning-items/${release.id}?expectedVersion=${release.version}`, 'DELETE')).status, 200);
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('native restore validates planning views against the imported workspace and protects legacy format boundaries', async () => {
  const f = await fixture();
  try {
    const plan = await addPlanningItem(f, 'module', '백업에 저장할 모듈');
    const filters = {...definition.filters, planning: {moduleId: plan.id, dates: {mode: 'needs_dates'}}};
    const created = await f.request('/views', 'POST', {...definition, filters});
    assert.equal(created.status, 201);
    const {data: backup} = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const viewPath = `/views/${created.data.id}`;
    assert.equal((await f.request(viewPath, 'PATCH', {expectedVersion: 1, name: '현재 보기', filters: {...definition.filters, planning: {}}})).status, 200);
    assert.equal((await f.request(`/planning-items/${plan.id}?expectedVersion=${plan.version}`, 'DELETE')).status, 200);

    const downgraded = await f.request('/import', 'POST', {data: {...backup, schemaVersion: 46}});
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 47/);
    const withoutPlan = {...backup, planningItems: backup.planningItems.filter((item: PlanningItem) => item.id !== plan.id)};
    assert.equal((await f.request('/import', 'POST', {data: withoutPlan})).status, 400);
    const afterFailure = (await f.request(`/views?projectId=${plan.projectId}`)).data[0] as SavedView;
    assert.equal(afterFailure.name, '현재 보기');
    assert.deepEqual(afterFailure.filters, definition.filters);
    assert.equal((await f.request(`/planning-items/${plan.id}`)).status, 404);

    assert.equal((await f.request('/import', 'POST', {data: backup})).status, 200);
    const restored = (await f.request(`/views?projectId=${plan.projectId}`)).data[0] as SavedView;
    assert.deepEqual(restored.filters, filters);
    assert.ok(restored.version > afterFailure.version);
    assert.equal((await f.request(`/planning-items/${plan.id}`)).status, 200);
    assert.equal((await f.request(`/planning-items/${plan.id}?expectedVersion=${plan.version}`, 'DELETE')).status, 409);

    const oldShape = {...backup, schemaVersion: 46, savedViews: [{...backup.savedViews[0], filters: definition.filters}]};
    assert.equal((await f.request('/import', 'POST', {data: oldShape})).status, 200);
    assert.deepEqual((await f.request(`/views?projectId=${plan.projectId}`)).data[0].filters, definition.filters);
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('custom field reporting uses saved planning membership and date overlap for its issue population', async () => {
  const f = await fixture();
  try {
    const cycle = await addPlanningItem(f, 'cycle', '집계할 사이클');
    const schemaPath = `/projects/${cycle.projectId}/issue-schema`;
    const {data: schema} = await f.request(schemaPath);
    const saved = await f.request(schemaPath, 'PATCH', {...schema, expectedVersion: schema.version, fields: [...schema.fields, {
      id: 'planning-report-test', name: '일정용 점수', kind: 'number', description: '', required: false,
      archived: false, issueTypes: [], options: [],
    }]});
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const create = async (title: string, startDate: string, endDate: string, cycleId: string | null) => {
      const issue = await f.request('/issues', 'POST', {projectId: cycle.projectId, title, startDate, endDate, cycleId, customFields: {'planning-report-test': 3}});
      assert.equal(issue.status, 201, JSON.stringify(issue.data));
      return issue.data.id as string;
    };
    const included = await create('범위의 시작일을 포함한 업무', '2025-12-30', '2026-01-01', cycle.id);
    await create('같은 계획이지만 범위 밖인 업무', '2026-01-03', '2026-01-04', cycle.id);
    await create('범위에는 들지만 다른 계획의 업무', '2026-01-01', '2026-01-01', null);
    const view = await f.request('/views', 'POST', {...definition, filters: {
      query: '', type: 'all', status: 'all', assigneeId: 'all', planning: {cycleId: cycle.id, dates: {mode: 'overlap', from: '2026-01-01', to: '2026-01-02'}},
    }});
    assert.equal(view.status, 201);
    const path = `/projects/${cycle.projectId}/field-breakdown`;
    const selection = {fieldId: 'planning-report-test', savedViewId: view.data.id};
    const report = await f.request(path, 'POST', selection);
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.totalIssues, 1);
    const bucket = report.data.groups.find((group: {kind: string}) => group.kind === 'value');
    assert.equal(bucket.count, 1);
    const drilldown = await f.request(`${path}/issues`, 'POST', {...selection, revision: report.data.revision, bucketId: bucket.id});
    assert.equal(drilldown.status, 200);
    assert.deepEqual(drilldown.data.issues.map((item: {id: string}) => item.id), [included]);
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('shared GitLab filter persists, preserves legacy edits and restores only valid settings', async () => {
  const f = await fixture();
  try {
    for (const gitlab of [null, 'all', [], {mode:'failed_pipeline'}, 'FAILED_PIPELINE']) {
      const rejected = await f.request('/views', 'POST', {...definition, filters:{...definition.filters, gitlab}});
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    }
    const filters = {...definition.filters, gitlab:'open_merge_request'};
    const created = await f.request('/views', 'POST', {...definition, filters});
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const viewPath = `/views/${created.data.id}`;
    const updated = await f.request(viewPath, 'PATCH', {expectedVersion:1, filters:{...definition.filters, query:'검토'}});
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.deepEqual(updated.data.filters, {...filters, query:'검토'});
    const listPath = `/views?projectId=${definition.projectId}`;
    assert.deepEqual((await f.request(listPath)).data[0], updated.data);

    const {data: backup} = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal(backup.savedViews[0].filters.gitlab, 'open_merge_request');
    const rejectedPatch = await f.request(viewPath, 'PATCH', {expectedVersion:2, filters:{...definition.filters, gitlab:'unknown'}});
    assert.equal(rejectedPatch.status, 400);
    const cleared = await f.request(viewPath, 'PATCH', {expectedVersion:2, filters:{...definition.filters, gitlab:null}});
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.filters, definition.filters);

    const invalid = structuredClone(backup);
    invalid.savedViews[0].filters.gitlab = null;
    assert.equal((await f.request('/import','POST',{data:invalid})).status, 400);
    const downgraded = await f.request('/import','POST',{data:{...backup, schemaVersion:52}});
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 53/);
    assert.deepEqual((await f.request(listPath)).data[0], cleared.data);

    assert.equal((await f.request('/import','POST',{data:backup})).status, 200);
    const restored = (await f.request(listPath)).data[0] as SavedView;
    assert.deepEqual(restored.filters, updated.data.filters);
    assert.ok(restored.version > cleared.data.version);
    const legacy = structuredClone(backup);
    legacy.schemaVersion = 52;
    delete legacy.savedViews[0].filters.gitlab;
    assert.equal((await f.request('/import','POST',{data:legacy})).status, 200);
    assert.deepEqual((await f.request(listPath)).data[0].filters, {...definition.filters, query:'검토'});
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('saved GitLab view drives field report membership and invalidates drilldown after a subsequent success', async () => {
  const f = await fixture();
  try {
    const projectId = definition.projectId;
    const schemaPath = `/projects/${projectId}/issue-schema`;
    const {data: schema} = await f.request(schemaPath);
    const fieldId = 'gitlab-report-test';
    const updatedSchema = await f.request(schemaPath, 'PATCH', {...schema, expectedVersion:schema.version, fields:[...schema.fields, {
      id:fieldId, name:'합성 GitLab 점수', kind:'number', description:'', required:false, archived:false, issueTypes:[], options:[],
    }]});
    assert.equal(updatedSchema.status, 200, JSON.stringify(updatedSchema.data));
    async function createIssue(title: string) {
      const issue = await f.request('/issues', 'POST', {projectId, title, customFields:{[fieldId]:3}});
      assert.equal(issue.status, 201, JSON.stringify(issue.data));
      return issue.data as {id:string; key:string};
    }
    const repair = await createIssue('GitLab 집계 수정할 CI');
    const healthy = await createIssue('GitLab 집계 성공 CI');
    await createIssue('GitLab 집계 활동 없음');
    const baseUrl = 'https://git.example.test';
    const webhookSecret = 'synthetic-saved-gitlab-view';
    const {data: settings} = await f.request('/integrations/gitlab');
    const configured = await f.request('/integrations/gitlab', 'PATCH', {baseUrl, projectIds:[42], webhookSecret, expectedVersion:settings.version});
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    async function sendPipeline(issueKey: string, id: number, status: 'failed' | 'success') {
      const accepted = await f.request('/integrations/gitlab/webhook', 'POST', {
        object_kind:'pipeline', project:{id:42, web_url:`${baseUrl}/team/repository`},
        object_attributes:{id, ref:`feature/${issueKey}`, status, finished_at:new Date(Date.now() - 1000).toISOString()},
      }, {'X-Gitlab-Token':webhookSecret});
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      assert.equal(accepted.data.linked, 1);
    }
    await sendPipeline(repair.key, 200, 'failed');
    await sendPipeline(healthy.key, 201, 'success');
    const view = await f.request('/views','POST',{...definition, filters:{
      query:'GitLab 집계', type:'all', status:'all', assigneeId:'all', gitlab:'failed_pipeline',
    }});
    assert.equal(view.status, 201, JSON.stringify(view.data));
    const path = `/projects/${projectId}/field-breakdown`;
    const selection = {fieldId, savedViewId:view.data.id};
    const initial = await f.request(path,'POST',selection);
    assert.equal(initial.status, 200);
    assert.equal(initial.data.totalIssues, 1);
    const bucket = initial.data.groups.find((group: {kind:string}) => group.kind === 'value');
    assert.equal(bucket.count, 1);
    const drill = {...selection, revision:initial.data.revision, bucketId:bucket.id};
    const matching = await f.request(`${path}/issues`, 'POST', drill);
    assert.equal(matching.status, 200, JSON.stringify(matching.data));
    assert.deepEqual(matching.data.issues.map((issue: {id:string}) => issue.id), [repair.id]);

    await sendPipeline(repair.key, 202, 'success');
    const changed = await f.request(path,'POST',selection);
    assert.equal(changed.status, 200);
    assert.equal(changed.data.totalIssues, 0);
    assert.equal((await f.request(`${path}/issues`, 'POST', drill)).status, 409);
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});
