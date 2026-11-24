import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { orderIssueView } from '../../shared/issue-view.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { GitlabLink, Issue, IssueViewSortRule, PlanningItem, PlanningKind, Priority, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

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

test('saved views keep field priority, use rank for ties and restore native sort rules without affecting project ranks', async () => {
  const f = await fixture();
  try {
    const sort: IssueViewSortRule[] = [{ field: 'dueDate', direction: 'desc' }, { field: 'priority', direction: 'desc' }];
    const native = await f.request('/views', 'POST', definition);
    assert.equal(native.status, 201);
    assert.equal(Object.hasOwn(native.data, 'sort'), false);
    const sorted = await f.request('/views', 'POST', { ...definition, name: '마감일과 우선순위', sort });
    assert.equal(sorted.status, 201);
    assert.deepEqual(sorted.data.sort, sort);
    const path = `/views/${sorted.data.id}`;
    const list = `/views?projectId=${definition.projectId}`;
    const loadView = async (): Promise<SavedView> => ((await f.request(list)).data as SavedView[]).find(view => view.id === sorted.data.id)!;
    const renamed = await f.request(path, 'PATCH', { expectedVersion: sorted.data.version, name: '마감일 먼저' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.sort, sort);
    for (const invalid of [true, { field: 'dueDate', direction: 'asc' }, [null], [{ field: 'unknown', direction: 'asc' }],
      [{ field: 'dueDate', direction: 'ASC' }], [{ field: 'dueDate', direction: 'asc', extra: true }], [sort[0], sort[0]]]) {
      assert.equal((await f.request(path, 'PATCH', { expectedVersion: renamed.data.version, sort: invalid })).status, 400);
    }
    assert.deepEqual(await loadView(), renamed.data);

    const workspace = (await f.request('/workspace')).data as WorkspaceSnapshot;
    const template = workspace.issues.find(issue => issue.projectId === definition.projectId)!;
    const issue = (id: string, key: string, dueDate: Issue['dueDate'], priority: Priority): Issue => ({ ...template, id, key, dueDate, priority });
    const late = issue('late', 'NEO-10', '2027-01-02', 'low');
    const early = issue('early', 'NEO-3', '2027-01-01', 'urgent');
    const urgentFirst = issue('urgent-first', 'NEO-22', late.dueDate, 'urgent');
    const urgentSecond = issue('urgent-second', 'NEO-2', late.dueDate, 'urgent');
    const undated = issue('undated', 'NEO-4', null, 'urgent');
    const original = [urgentSecond, late, undated, early, urgentFirst];
    const rank = { projectId: template.projectId, issueIds: ['undated', 'urgent-first', 'early'], version: '1' };
    assert.deepEqual(orderIssueView(original, rank, sort), [urgentFirst, urgentSecond, late, early, undated]);
    assert.deepEqual(orderIssueView(original, rank, [{ field: 'dueDate', direction: 'asc' }]), [early, urgentFirst, urgentSecond, late, undated]);
    assert.deepEqual(orderIssueView(original, rank, [{ field: 'key', direction: 'asc' }]), [urgentSecond, early, undated, late, urgentFirst]);
    assert.deepEqual(orderIssueView(original, rank), [undated, urgentFirst, early, urgentSecond, late]);
    assert.equal(original[0], urgentSecond);

    const { data: backup } = await f.request('/export');
    assert.equal(backup.schemaVersion, 106);
    assert.equal((await f.request('/import', 'POST', { data: { ...backup, schemaVersion: 105 } })).status, 400);
    assert.deepEqual(await loadView(), renamed.data);
    assert.equal((await f.request('/import', 'POST', { data: backup })).status, 200);
    const restored = await loadView();
    assert.deepEqual(restored.sort, sort);
    assert.ok(restored.version > renamed.data.version);
    assert.equal((await f.request(path, 'PATCH', { expectedVersion: renamed.data.version, sort: null })).status, 409);
    const cleared = await f.request(path, 'PATCH', { expectedVersion: restored.version, sort: null });
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn(cleared.data, 'sort'), false);
    const after = (await f.request('/workspace')).data as WorkspaceSnapshot;
    const ranks = (snapshot: WorkspaceSnapshot) => snapshot.issueOrders?.map(({ projectId, issueIds }) => ({ projectId, issueIds }));
    assert.deepEqual(ranks(after), ranks(workspace));
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('saved multi-status views keep exact conditions and restore them with native format 103', async () => {
  const f = await fixture();
  try {
    const project = await f.request('/projects', 'POST', { key: 'MSV', name: '여러 상태 보기 검증' });
    assert.equal(project.status, 201);
    const projectId = project.data.id as string;
    for (const status of ['todo', 'review', 'done']) {
      const issue = await f.request('/issues', 'POST', { projectId, title: `상태 ${status} 업무`, status });
      assert.equal(issue.status, 201, JSON.stringify(issue.data));
    }
    const base = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
    const input = { projectId, name: '열린 상태 보기', layout: 'list', filters: { ...base, statusIds: ['todo', 'retired-status', 'review', 'todo'] } };
    const created = await f.request('/views', 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const expected = { ...base, statusIds: ['retired-status', 'review', 'todo'] };
    assert.deepEqual(created.data.filters, expected);
    const path = `/views/${created.data.id}`;
    const listPath = `/views?projectId=${projectId}`;

    for (const changes of [
      { statusIds: 'todo' }, { statusIds: null }, { statusIds: ['all'] }, { statusIds: [''] }, { statusIds: [null] },
      { statusIds: ['x'.repeat(81)] }, { statusIds: Array.from({ length: 41 }, (_, index) => `status-${index}`) },
      { statusIds: ['review', 'todo'], status: 'done' },
    ]) {
      const filters = { ...base, ...changes };
      assert.equal((await f.request('/views', 'POST', { ...input, name: '거절할 보기', filters })).status, 400);
      assert.equal((await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters })).status, 400);
    }
    assert.deepEqual((await f.request(listPath)).data, [created.data]);
    const breakdownPath = `/projects/${projectId}/field-breakdown`;
    const report = await f.request(breakdownPath, 'POST', { groupBy: 'status', savedViewId: created.data.id });
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.totalIssues, 2);
    assert.deepEqual(report.data.groups.filter((group: { count: number }) => group.count > 0)
      .map((group: { label: string }) => group.label).sort(), ['검토', '할 일']);

    const edited = await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters: { ...base, query: '상태' } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.filters, { ...expected, query: '상태' });
    assert.equal((await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters: { ...base, statusIds: [] } })).status, 409);

    const { data: backup } = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.deepEqual(backup.savedViews[0].filters, edited.data.filters);
    const single = await f.request(path, 'PATCH', { expectedVersion: edited.data.version, filters: { ...base, status: 'done' } });
    assert.equal(single.status, 200);
    assert.deepEqual(single.data.filters, { ...base, status: 'done' });

    const older = { ...structuredClone(backup), schemaVersion: 102 };
    const badVersion = await f.request('/import', 'POST', { data: older });
    assert.equal(badVersion.status, 400);
    assert.match(badVersion.data.error, /schemaVersion 103/);
    assert.deepEqual((await f.request(listPath)).data, [single.data]);
    assert.equal((await f.request('/import', 'POST', { data: { ...backup, schemaVersion: 103 } })).status, 200);
    const [restored] = (await f.request(listPath)).data as SavedView[];
    assert.deepEqual(restored.filters, edited.data.filters);
    assert.ok(restored.version > single.data.version);
    assert.equal((await f.request(path, 'PATCH', { expectedVersion: single.data.version, filters: { ...base, statusIds: [] } })).status, 409);
    const cleared = await f.request(path, 'PATCH', { expectedVersion: restored.version, filters: { ...base, statusIds: [] } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.filters, base);
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('saved views preserve exact priority and label criteria across legacy edits and clear explicit empty values', async () => {
  const f = await fixture();
  try {
    const raw = { priorities: ['medium', 'urgent', 'medium'], labels: { include: ['ops', 'Ops', 'Ops'], match: 'any', exclude: [' Retired '] } };
    const expected = { priorities: ['urgent', 'medium'], labels: { include: ['Ops', 'ops'], exclude: [' Retired '] } };
    const created = await f.request('/views', 'POST', { ...definition, filters: { ...definition.filters, ...raw } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.filters, { ...definition.filters, ...expected });
    const path = `/views/${created.data.id}`;

    for (const invalid of [
      { priorities: ['highest'] }, { priorities: null }, { priorities: 'high' },
      { labels: null }, { labels: ['ops'] }, { labels: { include: [''] } },
      { labels: { exclude: ['x'.repeat(61)] } }, { labels: { include: Array.from({ length: 21 }, (_, i) => `label-${i}`) } },
      { labels: { presence: 'all' } }, { labels: { match: 'some', include: ['ops'] } }, { labels: { other: true } },
    ]) {
      const filters = { ...definition.filters, ...invalid };
      assert.equal((await f.request('/views', 'POST', { ...definition, name: '거절할 보기', filters })).status, 400);
      assert.equal((await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters })).status, 400);
    }
    const oldClientFilters = { ...definition.filters, query: '장기 업무' };
    const edited = await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters: oldClientFilters });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.filters, { ...oldClientFilters, ...expected });
    const clearedPriority = await f.request(path, 'PATCH', { expectedVersion: edited.data.version, filters: { ...oldClientFilters, priorities: [] } });
    assert.equal(clearedPriority.status, 200);
    assert.deepEqual(clearedPriority.data.filters, { ...oldClientFilters, labels: expected.labels });
    const clearedLabel = await f.request(path, 'PATCH', { expectedVersion: clearedPriority.data.version, filters: { ...oldClientFilters, labels: {} } });
    assert.equal(clearedLabel.status, 200);
    assert.deepEqual(clearedLabel.data.filters, oldClientFilters);
    assert.deepEqual((await f.request('/views?projectId=project-neo')).data, [clearedLabel.data]);
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('native backup preserves saved priority and label criteria and rejects loss at the version boundary', async () => {
  const f = await fixture();
  try {
    const filters = { ...definition.filters, priorities: ['high'], labels: { include: ['Retired'], match: 'all', presence: 'set' } };
    const created = await f.request('/views', 'POST', { ...definition, filters });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const { data: backup } = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.deepEqual(backup.savedViews[0].filters, filters);
    const edited = await f.request(`/views/${created.data.id}`, 'PATCH', { expectedVersion: created.data.version, name: '복원 전 보기' });
    assert.equal(edited.status, 200);

    const malformed = structuredClone(backup);
    malformed.savedViews[0].filters.labels = { include: [null] };
    assert.equal((await f.request('/import', 'POST', { data: malformed })).status, 400);
    const older = { ...structuredClone(backup), schemaVersion: 67 };
    const original = older.savedViews[0].filters;
    for (const criteria of [{ priorities: original.priorities }, { labels: original.labels }]) {
      older.savedViews[0].filters = { ...definition.filters, ...criteria };
      const rejected = await f.request('/import', 'POST', { data: older });
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /schemaVersion 68/);
    }
    assert.deepEqual((await f.request('/views?projectId=project-neo')).data, [edited.data]);

    assert.equal((await f.request('/import', 'POST', { data: backup })).status, 200);
    const restored = (await f.request('/views?projectId=project-neo')).data[0] as SavedView;
    assert.deepEqual(restored.filters, filters);
    assert.ok(restored.version > edited.data.version);

    older.savedViews[0].filters = definition.filters;
    assert.equal((await f.request('/import', 'POST', { data: older })).status, 200);
    assert.deepEqual((await f.request('/views?projectId=project-neo')).data[0].filters, definition.filters);
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('saved view reporter criterion persists through old-client edits and clears explicitly', async () => {
  const f = await fixture();
  try {
    const reporter = { kind: 'member', memberId: 'user-seo' };
    const created = await f.request('/views', 'POST', { ...definition, filters: { ...definition.filters, reporter } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.filters.reporter, reporter);
    const path = `/views/${created.data.id}`;
    for (const reporter of ['user-seo', { kind: 'member', memberId: 'missing' }, { kind: 'unset', memberId: 'user-seo' }, { kind: 'unknown', extra: true }]) {
      const filters = { ...definition.filters, reporter };
      assert.equal((await f.request('/views', 'POST', { ...definition, name: '잘못된 요청자 조건', filters })).status, 400);
      assert.equal((await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters })).status, 400);
    }
    const oldClientFilters = { ...definition.filters, query: '변경한 검색어' };
    const edited = await f.request(path, 'PATCH', { expectedVersion: created.data.version, filters: oldClientFilters });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.filters, { ...oldClientFilters, reporter });
    let version = edited.data.version;
    for (const kind of ['unset', 'unknown']) {
      const changed = await f.request(path, 'PATCH', { expectedVersion: version, filters: { ...oldClientFilters, reporter: { kind } } });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.data.filters.reporter, { kind });
      version = changed.data.version;
    }
    const cleared = await f.request(path, 'PATCH', { expectedVersion: version, filters: { ...oldClientFilters, reporter: null } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.filters, oldClientFilters);
    assert.deepEqual((await f.request('/views?projectId=project-neo')).data, [cleared.data]);
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('native backup reporter filters validate workspace members and require format 85', async () => {
  const f = await fixture();
  try {
    const reporters = [{ kind: 'member', memberId: 'user-seo' }, { kind: 'unset' }, { kind: 'unknown' }];
    const saved: SavedView[] = [];
    for (const reporter of reporters) {
      const created = await f.request('/views', 'POST', { ...definition, name: `요청자 ${reporter.kind}`, filters: { ...definition.filters, reporter } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      saved.push(created.data);
    }
    const { data: backup } = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.deepEqual(saved.map(view => (backup.savedViews as SavedView[]).find(entry => entry.id === view.id)?.filters.reporter), reporters);

    const importedMember = { ...backup.users.find((user: { id: string }) => user.id === 'user-seo'), id: 'imported-reporter', email: 'reporter@example.invalid' };
    const restoredPackage = structuredClone(backup);
    const memberView = (restoredPackage.savedViews as SavedView[]).find(entry => entry.id === saved[0].id)!;
    memberView.filters.reporter = { kind: 'member', memberId: importedMember.id };
    const rejected = await f.request('/import', 'POST', { data: restoredPackage });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /요청자 필터/);
    restoredPackage.users.push(importedMember);
    const older = { ...structuredClone(restoredPackage), schemaVersion: 84 };
    const versionRejected = await f.request('/import', 'POST', { data: older });
    assert.equal(versionRejected.status, 400);
    assert.match(versionRejected.data.error, /schemaVersion 85/);
    const list = async () => (await f.request('/views?projectId=project-neo')).data as SavedView[];
    const untouched = await list();
    assert.deepEqual(saved.map(view => untouched.find(entry => entry.id === view.id)), saved);

    assert.equal((await f.request('/import', 'POST', { data: restoredPackage })).status, 200);
    const restored = await list();
    assert.deepEqual(saved.map(view => restored.find(entry => entry.id === view.id)?.filters.reporter), [memberView.filters.reporter, ...reporters.slice(1)]);
    assert.ok(restored.every(view => view.version > 1));
    for (const view of older.savedViews as SavedView[]) delete view.filters.reporter;
    assert.equal((await f.request('/import', 'POST', { data: older })).status, 200);
    assert.ok((await list()).every(view => !Object.hasOwn(view.filters, 'reporter')));
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
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

test('custom field reporting combines saved planning, date overlap, priority and exact label criteria', async () => {
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
    const create = async (title: string, startDate: string, endDate: string, cycleId: string | null, priority: Priority = 'high', labels = ['Ops']) => {
      const issue = await f.request('/issues', 'POST', {projectId: cycle.projectId, title, startDate, endDate, cycleId, priority, labels, customFields: {'planning-report-test': 3}});
      assert.equal(issue.status, 201, JSON.stringify(issue.data));
      return issue.data.id as string;
    };
    const included = await create('범위의 시작일을 포함한 업무', '2025-12-30', '2026-01-01', cycle.id);
    await create('같은 계획이지만 범위 밖인 업무', '2026-01-03', '2026-01-04', cycle.id);
    await create('범위에는 들지만 다른 계획의 업무', '2026-01-01', '2026-01-01', null);
    await create('우선순위가 다른 업무', '2026-01-01', '2026-01-01', cycle.id, 'medium');
    await create('라벨의 대소문자가 다른 업무', '2026-01-01', '2026-01-01', cycle.id, 'high', ['ops']);
    const view = await f.request('/views', 'POST', {...definition, filters: {
      query: '', type: 'all', status: 'all', assigneeId: 'all', planning: {cycleId: cycle.id, dates: {mode: 'overlap', from: '2026-01-01', to: '2026-01-02'}},
      priorities: ['high'], labels: {include: ['Ops']},
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

test('native backup preserves merge readiness and blocked views across active and trashed issues', async () => {
  type Backup = WorkspaceSnapshot & { schemaVersion: number; exportedAt: string; trashEntries: { id: string; gitlabLinks: GitlabLink[] }[] };
  const f = await fixture();
  try {
    async function createIssue(title: string) {
      const result = await f.request('/issues', 'POST', { projectId: definition.projectId, title });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data.id as string;
    }
    const active = await createIssue('합성 병합 승인 대기'), archived = await createIssue('합성 병합 충돌');
    const makeLink = (issueId: string, iid: number, state: NonNullable<GitlabLink['mergeReadiness']>['state']): GitlabLink => ({
      id: `gitlab:0123456789ab:42:merge_request:${iid}:${issueId}`, issueId, projectId: 42, iid, kind: 'merge_request',
      title: `Synthetic MR ${iid}`, state: 'opened', webUrl: `https://git.example.test/team/repo/-/merge_requests/${iid}`,
      updatedAt: '2025-01-02T00:00:00.000Z', mergeReadiness: { state, source: 'read', observedAt: '2025-01-03T00:00:00.000Z' },
    });
    const activeLink = makeLink(active, 501, 'approval_required'), archivedLink = makeLink(archived, 502, 'conflict');
    const created = await f.request('/views', 'POST', { ...definition, filters: { ...definition.filters, gitlab: 'merge_blocked' } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const restore = (data: Backup) => f.request('/import', 'POST', { data });
    const initial = (await f.request('/export')).data as Backup;
    assert.equal(initial.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    initial.gitlabLinks.push(activeLink, archivedLink);
    assert.equal((await restore(initial)).status, 200);
    const deleted = await f.request(`/issues/${archived}`, 'DELETE');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const entryId = deleted.data.trashEntryId as string;
    const backup = (await f.request('/export')).data as Backup;
    assert.deepEqual(backup.gitlabLinks, [activeLink]);
    assert.deepEqual(backup.trashEntries.find(entry => entry.id === entryId)?.gitlabLinks, [archivedLink]);
    assert.equal(backup.savedViews?.[0].filters.gitlab, 'merge_blocked');

    for (const data of [
      { ...backup, schemaVersion: 56, savedViews: [], trashEntries: [] },
      { ...backup, schemaVersion: 56, savedViews: [], gitlabLinks: [] },
      { ...backup, schemaVersion: 56, trashEntries: [], gitlabLinks: [] },
    ]) {
      const invalid = await restore(data);
      assert.equal(invalid.status, 400);
      assert.match(invalid.data.error, /schemaVersion 57/);
    }
    const malformed = structuredClone(backup);
    malformed.trashEntries[0].gitlabLinks[0].state = 'closed';
    assert.equal((await restore(malformed)).status, 400);
    const afterExport = new Date(Date.parse(backup.exportedAt) + 1).toISOString();
    const afterRestore = new Date(Date.now() + 3_600_000).toISOString();
    for (const observedAt of [afterExport, afterRestore]) {
      for (const inTrash of [false, true]) {
        // A future export header alone cannot make a future observation acceptable.
        const future = structuredClone(backup);
        if (observedAt === afterRestore) future.exportedAt = afterRestore;
        const link = inTrash ? future.trashEntries[0].gitlabLinks[0] : future.gitlabLinks[0];
        link.mergeReadiness!.observedAt = observedAt;
        const rejected = await restore(future);
        assert.equal(rejected.status, 400);
        assert.match(rejected.data.error, /관측 시각이 백업 내보내기 또는 복원 시각보다 늦습니다/);
      }
    }
    assert.deepEqual((await f.request('/workspace')).data.gitlabLinks, [activeLink]);

    const legacy = structuredClone(backup);
    legacy.schemaVersion = 56;
    legacy.savedViews![0].filters.gitlab = 'open_merge_request';
    delete legacy.gitlabLinks[0].mergeReadiness;
    delete legacy.trashEntries[0].gitlabLinks[0].mergeReadiness;
    assert.equal((await restore(legacy)).status, 200);
    assert.equal((await f.request('/workspace')).data.gitlabLinks[0].mergeReadiness, undefined);

    assert.equal((await restore(backup)).status, 200);
    assert.equal((await f.request(`/trash/${entryId}/restore`, 'POST', {})).status, 200);
    const reopened = (await f.request('/workspace')).data as WorkspaceSnapshot;
    assert.deepEqual(reopened.gitlabLinks.find(link => link.id === archivedLink.id), archivedLink);
    assert.equal(reopened.savedViews?.[0].filters.gitlab, 'merge_blocked');
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('saved GitLab failed and manual views drive field reports and retain their filters across backup', async () => {
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
    const waiting = await createIssue('GitLab 집계 수동 대기 CI');
    await createIssue('GitLab 집계 활동 없음');
    const baseUrl = 'https://git.example.test';
    const webhookSecret = 'synthetic-saved-gitlab-view';
    const {data: settings} = await f.request('/integrations/gitlab');
    const configured = await f.request('/integrations/gitlab', 'PATCH', {baseUrl, projectIds:[42], webhookSecret, expectedVersion:settings.version});
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    async function sendPipeline(issueKey: string, id: number, status: 'failed' | 'success' | 'manual') {
      const accepted = await f.request('/integrations/gitlab/webhook', 'POST', {
        object_kind:'pipeline', project:{id:42, web_url:`${baseUrl}/team/repository`},
        object_attributes:{id, ref:`feature/${issueKey}`, status, finished_at:new Date(Date.now() - 1000).toISOString()},
      }, {'X-Gitlab-Token':webhookSecret});
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      assert.equal(accepted.data.linked, 1);
    }
    await sendPipeline(repair.key, 200, 'failed');
    await sendPipeline(healthy.key, 201, 'success');
    await sendPipeline(waiting.key, 202, 'manual');
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

    const manualFilters = { ...view.data.filters, gitlab: 'manual_pipeline' };
    const manual = await f.request('/views', 'POST', { ...definition, name: '수동 확인 대기 업무', filters: manualFilters });
    assert.equal(manual.status, 201, JSON.stringify(manual.data));
    const manualSelection = { fieldId, savedViewId: manual.data.id };
    const manualReport = async () => {
      const result = await f.request(path, 'POST', manualSelection);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    const manualBefore = await manualReport();
    const manualBucket = manualBefore.groups.find((group: { kind: string }) => group.kind === 'value');
    assert.equal(manualBefore.totalIssues, 1);
    const manualDrill = { ...manualSelection, revision: manualBefore.revision, bucketId: manualBucket.id };
    const manualMatches = await f.request(`${path}/issues`, 'POST', manualDrill);
    assert.equal(manualMatches.status, 200, JSON.stringify(manualMatches.data));
    assert.deepEqual(manualMatches.data.issues.map((issue: { id: string }) => issue.id), [waiting.id]);

    await sendPipeline(repair.key, 203, 'success');
    const changed = await f.request(path,'POST',selection);
    assert.equal(changed.status, 200);
    assert.equal(changed.data.totalIssues, 0);
    assert.equal((await f.request(`${path}/issues`, 'POST', drill)).status, 409);

    const { data: backup } = await f.request('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal((backup.savedViews as SavedView[]).find(candidate => candidate.id === manual.data.id)?.filters.gitlab, 'manual_pipeline');
    const oldFormat = { ...backup, schemaVersion: 103 };
    const rejected = await f.request('/import', 'POST', { data: oldFormat });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.match(rejected.data.error, /schemaVersion 104/);
    assert.equal((await manualReport()).totalIssues, 1);

    const previous = { ...oldFormat, savedViews: (backup.savedViews as SavedView[]).filter(candidate => candidate.id !== manual.data.id) };
    assert.equal((await f.request('/import', 'POST', { data: previous })).status, 200);
    const listPath = `/views?projectId=${projectId}`;
    assert.deepEqual(((await f.request(listPath)).data as SavedView[]).map(candidate => candidate.filters.gitlab), ['failed_pipeline']);
    assert.equal((await f.request('/import', 'POST', { data: backup })).status, 200);
    assert.deepEqual(((await f.request(listPath)).data as SavedView[]).find(candidate => candidate.id === manual.data.id)?.filters, manualFilters);
    assert.equal((await manualReport()).totalIssues, 1);
    await sendPipeline(waiting.key, 204, 'success');
    assert.equal((await manualReport()).totalIssues, 0);
  } finally { await f.close(); rmSync(f.dir, {recursive: true, force: true}); }
});

test('assignee board grouping is a presentation setting with explicit clearing and portable restore', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/views', 'POST', { ...definition, boardGrouping: 'assignee' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.boardGrouping, 'assignee');
    assert.deepEqual(created.data.filters, definition.filters);
    const id = created.data.id;
    const detail = `/views/${id}`;
    const views = () => f.request(`/views?projectId=${definition.projectId}`);
    const legacy = await f.request(detail, 'PATCH', {
      expectedVersion: created.data.version, filters: { ...definition.filters, query: '연결한 일감' },
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.boardGrouping, 'assignee');
    const expectedFilters = { ...definition.filters, query: '연결한 일감' };
    assert.deepEqual(legacy.data.filters, expectedFilters);
    assert.equal((await f.request(detail, 'PATCH', { expectedVersion: created.data.version, boardGrouping: null })).status, 409);
    for (const invalid of ['', 'status', [], 1, false]) {
      assert.equal((await f.request(detail, 'PATCH', { expectedVersion: legacy.data.version, boardGrouping: invalid })).status, 400);
    }

    const { data: archived } = await f.request('/export');
    assert.equal(archived.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal(archived.savedViews[0].boardGrouping, 'assignee');
    const olderWithGrouping = { ...archived, schemaVersion: 75 };
    const rejected = await f.request('/import', 'POST', { data: olderWithGrouping });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /schemaVersion 76/);
    const malformed = structuredClone(archived);
    malformed.savedViews[0].boardGrouping = 'priority';
    assert.equal((await f.request('/import', 'POST', { data: malformed })).status, 400);
    assert.deepEqual((await views()).data, [legacy.data]);
    assert.equal((await f.request('/import', 'POST', { data: archived })).status, 200);
    const [restored] = (await views()).data as SavedView[];
    assert.ok(restored.version > legacy.data.version);
    assert.equal(restored.boardGrouping, 'assignee');
    assert.deepEqual(restored.filters, expectedFilters);

    const cleared = await f.request(detail, 'PATCH', { expectedVersion: restored.version, boardGrouping: null });
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn(cleared.data, 'boardGrouping'), false);
    const groupedAgain = await f.request(detail, 'PATCH', { expectedVersion: cleared.data.version, boardGrouping: 'assignee' });
    assert.equal(groupedAgain.status, 200);
    const list = await f.request(detail, 'PATCH', { expectedVersion: groupedAgain.data.version, layout: 'list' });
    assert.equal(list.status, 200);
    assert.equal(Object.hasOwn(list.data, 'boardGrouping'), false);
    const flat = await f.request(detail, 'PATCH', { expectedVersion: list.data.version, layout: 'board' });
    assert.equal(flat.status, 200);
    assert.equal(Object.hasOwn(flat.data, 'boardGrouping'), false);

    const oldBackup = structuredClone(archived);
    oldBackup.schemaVersion = 75;
    delete oldBackup.savedViews[0].boardGrouping;
    assert.equal((await f.request('/import', 'POST', { data: oldBackup })).status, 200);
    const [restoredOld] = (await views()).data as SavedView[];
    assert.equal(Object.hasOwn(restoredOld, 'boardGrouping'), false);
    assert.equal(restoredOld.layout, 'board');
    assert.deepEqual(restoredOld.filters, expectedFilters);
  } finally { await f.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
