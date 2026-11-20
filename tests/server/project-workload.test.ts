import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import { calculateProjectWorkload, defaultWorkloadCapacity, WorkloadError } from '../../shared/project-workload.js';
import type {
  ApiKeyCreated, Dependency, Issue, Project, ProjectWorkloadCapacity, ProjectWorkloadResult,
  TeamWorkloadCapacity, TeamWorkloadLevelPreview, TeamWorkloadResult, User, WorkloadLevelPreview, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const alice = 'user-min';
const bob = 'user-seo';
const friday = '2026-11-20';
const saturday = '2026-11-21';
const sunday = '2026-11-22';
const monday = '2026-11-23';
const tuesday = '2026-11-24';

function syntheticIssue(id: string, extra: Partial<Issue> = {}): Issue {
  return {
    id, key: `W-${id}`, projectId, title: id, description: '', type: '작업', priority: 'medium', status: 'todo',
    assigneeId: alice, collaboratorIds: [], parentId: null, labels: [], startDate: friday, endDate: tuesday, dueDate: null,
    estimate: 5, plannedEffortMinutes: 10, cycle: null, module: null, release: null, version: 1,
    createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z', completedAt: null, ...extra,
  };
}

const calendar = {
  ...defaultWorkCalendar(projectId),
  exceptions: [
    { date: saturday, isWorking: true, label: '합성 토요일 근무' },
    { date: monday, isWorking: false, label: '합성 대체 휴무' },
  ],
};
const capacity = {
  ...defaultWorkloadCapacity(projectId), defaultDailyMinutes: 9,
  members: [{ userId: alice, dailyMinutes: 5 }],
  exceptions: [
    { userId: alice, date: saturday, availableMinutes: 0 },
    { userId: alice, date: sunday, availableMinutes: 14 },
    { userId: bob, date: tuesday, availableMinutes: 7 },
  ],
};
const rowFor = (result: ProjectWorkloadResult, userId: string) => {
  const row = result.rows.find(value => value.userId === userId);
  assert.ok(row, `Missing workload row for ${userId}`);
  return row;
};

test('allocation preserves integer minutes across the full issue period, with clipped ranges and project/person exceptions', () => {
  const issues = [
    syntheticIssue('multiday'),
    syntheticIssue('overlap', { startDate: tuesday, endDate: tuesday, plannedEffortMinutes: 6 }),
    syntheticIssue('bob', { assigneeId: bob, startDate: friday, endDate: saturday, plannedEffortMinutes: 7 }),
  ];
  const input = { calendar, capacity, issues, userIds: [alice, bob], terminalStatusIds: ['done', 'cancelled'], endDate: tuesday };
  const full = calculateProjectWorkload({ ...input, startDate: friday });
  assert.deepEqual(full.days, [
    {date:friday,working:true}, {date:saturday,working:true}, {date:sunday,working:false},
    {date:monday,working:false}, {date:tuesday,working:true},
  ]);
  assert.deepEqual(rowFor(full, alice).days.map(value => [value.scheduledMinutes, value.availableMinutes]), [[4, 5], [3, 0], [0, 0], [0, 0], [9, 5]]);
  assert.deepEqual(rowFor(full, bob).days.map(value => [value.scheduledMinutes, value.availableMinutes]), [[4, 9], [3, 9], [0, 0], [0, 0], [0, 7]]);
  assert.equal(full.totalScheduledMinutes, 23);
  assert.equal(full.totalAvailableMinutes, 35);
  assert.equal(full.overloadedCells, 2);
  assert.equal(rowFor(full, alice).overloadedDays, 2);
  assert.deepEqual(full.incomplete, []);
  const clipped = calculateProjectWorkload({ ...input, startDate: saturday });
  for (const id of [alice, bob]) assert.deepEqual(rowFor(clipped, id).days, rowFor(full, id).days.slice(1));
  assert.deepEqual(rowFor(clipped, alice).days[0].allocations, [{issueId:'multiday',minutes:3}]);
  assert.equal(clipped.totalScheduledMinutes, 15);
});

test('missing inputs are explicit, zero is a real estimate, and entirely out-of-view or terminal issues do not inflate work', () => {
  const issues = [
    syntheticIssue('zero', { plannedEffortMinutes: 0 }),
    syntheticIssue('points-only', { plannedEffortMinutes: undefined, estimate: 100 }),
    syntheticIssue('all-missing', { assigneeId: null, startDate: null, endDate: null, plannedEffortMinutes: null }),
    syntheticIssue('rest-day', { startDate: sunday, endDate: monday, plannedEffortMinutes: 0 }),
    syntheticIssue('ended-earlier', { startDate: null, endDate: '2026-11-19', plannedEffortMinutes: null }),
    syntheticIssue('starts-later', { startDate: '2026-11-25', endDate: null, plannedEffortMinutes: null }),
    syntheticIssue('finished', { status: 'finished-status', plannedEffortMinutes: 500 }),
    syntheticIssue('cancelled', { status: 'cancelled-status', plannedEffortMinutes: 500 }),
    syntheticIssue('foreign', { projectId: 'project-team', plannedEffortMinutes: 500 }),
  ];
  const input = { startDate: friday, endDate: tuesday, calendar, capacity, issues, userIds: [alice, bob], terminalStatusIds: new Set(['finished-status', 'cancelled-status']) };
  const workload = calculateProjectWorkload(input);
  assert.deepEqual(new Map(workload.incomplete.map(value => [value.issueId, value.reasons])), new Map([
    ['points-only', ['missing-effort']], ['all-missing', ['unassigned', 'missing-dates', 'missing-effort']], ['rest-day', ['no-working-days']],
  ]));
  assert.equal(workload.totalScheduledMinutes, 0);
  assert.equal(workload.overloadedCells, 0);
  assert.ok(workload.rows.every(row => row.days.every(day => !day.allocations.length)));
  assert.throws(() => calculateProjectWorkload({...input, startDate:'2026-01-01'}), (error: unknown) => error instanceof WorkloadError && error.status === 400);
  assert.throws(() => calculateProjectWorkload({...input, startDate:'2026-02-30'}), (error: unknown) => error instanceof WorkloadError && error.status === 400);
  const long = calculateProjectWorkload({ ...input, issues:[syntheticIssue('centuries', {startDate:'0000-01-01',endDate:'9999-12-31',plannedEffortMinutes:1})] });
  assert.equal(long.totalScheduledMinutes, 0);
  assert.deepEqual(long.incomplete, []);
});

type WorkloadBackup = WorkspaceSnapshot & { schemaVersion: number; trashEntries: {id: string; resource: Issue}[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-workload-'));
  async function open() {
    const runtime = createApp({ dataDir, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      base: `http://127.0.0.1:${address.port}/api`,
      async close() {
        runtime.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
    };
  }
  let runtime = await open();
  t.after(async () => {
    try { await runtime.close(); }
    finally { rmSync(dataDir, { recursive:true, force:true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', data?: unknown, expected = 200, token?: string, actorId = alice) {
    const response = await fetch(runtime.base + path, {
      method, headers:{ 'Content-Type':'application/json', 'X-Actor-Id':actorId, ...(token ? { Authorization:`Bearer ${token}` } : {}) },
      body:data === undefined ? undefined : JSON.stringify(data),
    });
    const input = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${input}`);
    return JSON.parse(input) as T;
  }
  const project = await call<Project>('/projects', 'POST', { name:'합성 작업량 프로젝트', key:'WLD' }, 201);
  return {
    call, project,
    async restart() { await runtime.close(); runtime = await open(); },
    issue(extra: Partial<Issue> = {}) {
      return call<Issue>('/issues', 'POST', { projectId:project.id, title:'계획 시간 합성 업무', assigneeId:alice, startDate:monday, endDate:tuesday, ...extra }, 201);
    },
    export() { return call<WorkloadBackup>('/export'); },
  };
}

test('workload proposal shows exact projected overload, applies once after restart, and uses schedule undo', async t => {
  const f = await fixture(t);
  const capacityPath = `/projects/${f.project.id}/workload-capacity`;
  const wednesday = '2026-11-25';
  await f.call(capacityPath, 'PATCH', { expectedVersion: 1, defaultDailyMinutes: 100, members: [],
    exceptions: [{ userId: alice, date: tuesday, availableMinutes: 0 }] });
  const fixed = await f.issue({ title: '유지할 일정', startDate: monday, endDate: monday, plannedEffortMinutes: 70, priority: 'high' });
  const movable = await f.issue({ title: '조정할 일정', startDate: monday, endDate: monday, plannedEffortMinutes: 60, priority: 'low' });
  await f.call('/dependencies', 'POST', { predecessorId: fixed.id, successorId: movable.id, type: 'FS', lagDays: -1 }, 201);
  const input = { projectId: f.project.id, startDate: monday, endDate: wednesday, userIds: [alice] };
  const preview = await f.call<WorkloadLevelPreview>('/schedule/workload-preview', 'POST', input);
  assert.deepEqual(preview.before, { overloadedCells: 1, excessMinutes: 30, completionDate: monday });
  assert.deepEqual(preview.after, { overloadedCells: 0, excessMinutes: 0, completionDate: wednesday });
  assert.deepEqual(preview.changes.map(change => [change.id, change.fromStart, change.toStart, change.toEnd]), [[movable.id, monday, wednesday, wednesday]]);
  assert.deepEqual(preview.remaining, []);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === movable.id), movable);
  const resultPath = `/schedule/workload-result/${preview.previewId}`;
  const request = { previewId: preview.previewId };
  assert.deepEqual(await f.call(resultPath), { applied: false });
  await f.call(resultPath, 'GET', undefined, 409, undefined, bob);
  await f.call('/schedule/workload-apply', 'POST', request, 409, undefined, bob);
  await f.call('/schedule/auto-apply', 'POST', request, 404);
  await f.restart();
  const applied = await f.call<{ undoId: string; updated: Issue[] }>('/schedule/workload-apply', 'POST', request);
  assert.deepEqual(applied.updated.map(issue => [issue.id, issue.version, issue.startDate, issue.endDate, issue.plannedEffortMinutes]),
    [[movable.id, movable.version + 1, wednesday, wednesday, 60]]);
  assert.deepEqual(await f.call(resultPath), applied);
  await f.restart();
  assert.deepEqual(await f.call('/schedule/workload-apply', 'POST', request), applied);
  const undone = await f.call<{ updated: Issue[] }>('/schedule/undo', 'POST', { undoId: applied.undoId });
  assert.equal(undone.updated[0].startDate, monday);
  assert.equal(undone.updated[0].endDate, monday);
  const unchanged = await f.call<WorkloadLevelPreview>('/schedule/workload-preview', 'POST', { ...input, issueIds: [fixed.id], endDate: tuesday });
  assert.deepEqual(unchanged.changes, []);
  assert.equal(unchanged.remaining[0].excessMinutes, 30);
  await f.call('/schedule/workload-apply', 'POST', { previewId: unchanged.previewId }, 400);
});

test('workload proposal invalidates when capacity, linked work or project membership changes', async t => {
  const f = await fixture(t);
  const capacityPath = `/projects/${f.project.id}/workload-capacity`;
  const capacity = { defaultDailyMinutes: 100, members: [], exceptions: [] };
  await f.call(capacityPath, 'PATCH', { ...capacity, expectedVersion: 1 });
  const background = await f.issue({ startDate: monday, endDate: monday, plannedEffortMinutes: 60, priority: 'high' });
  const candidate = await f.issue({ startDate: monday, endDate: monday, plannedEffortMinutes: 60, priority: 'low' });
  const link = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: background.id, successorId: candidate.id, type: 'SS', lagDays: 0 }, 201);
  const input = { projectId: f.project.id, startDate: monday, endDate: '2026-11-27' };
  await f.call('/schedule/workload-preview', 'POST', { ...input, userIds: [alice, alice] }, 400);
  await f.call('/schedule/workload-preview', 'POST', { ...input, issueIds: ['issue-1'] }, 404);
  await f.call('/schedule/workload-preview', 'POST', { ...input, startDate: '2026-01-01' }, 400);
  const preview = () => f.call<WorkloadLevelPreview>('/schedule/workload-preview', 'POST', input);
  const checkStale = (snapshot: WorkloadLevelPreview) => f.call<{ error: string }>('/schedule/workload-apply', 'POST', { previewId: snapshot.previewId }, 409);

  let snapshot = await preview();
  assert.equal(snapshot.changes[0].toStart, tuesday);
  await f.call(capacityPath, 'PATCH', { ...capacity, expectedVersion: 2 });
  assert.match((await checkStale(snapshot)).error, /가용 시간/u);
  snapshot = await preview();
  await f.call(`/dependencies/${link.id}`, 'PATCH', { expectedVersion: link.version, type: 'SS', lagDays: 1 });
  assert.match((await checkStale(snapshot)).error, /의존성/u);
  snapshot = await preview();
  await f.issue({ startDate: tuesday, endDate: tuesday, plannedEffortMinutes: 65, priority: 'high' });
  assert.match((await checkStale(snapshot)).error, /업무/u);
  const rebuilt = await preview();
  assert.equal(rebuilt.changes.find(change => change.id === candidate.id)?.toStart, '2026-11-25');
  const backup = await f.export();
  await f.call('/import', 'POST', { data: backup });
  await f.call(`/schedule/workload-result/${rebuilt.previewId}`, 'GET', undefined, 404);
});

test('issue, calendar and versioned capacity feed one workload API, including scoped key permissions', async t => {
  const f = await fixture(t);
  const projectPath = `/projects/${f.project.id}`;
  const capacityPath = `${projectPath}/workload-capacity`;
  const range = `${projectPath}/workload?startDate=${monday}&endDate=${tuesday}`;
  const defaultCapacity = await f.call<ProjectWorkloadCapacity>(capacityPath);
  assert.equal(defaultCapacity.defaultDailyMinutes, 480);
  assert.equal(defaultCapacity.version, 1);
  assert.deepEqual(defaultCapacity.members, []);
  assert.deepEqual(defaultCapacity.exceptions, []);
  let issue = await f.issue({ estimate:8, plannedEffortMinutes:182 });
  assert.equal(issue.plannedEffortMinutes, 182);
  assert.equal(issue.estimate, 8);
  const issuePath = `/issues/${issue.id}`;
  for (const invalid of [-1, 1.5, 1_000_001, '60'])
    await f.call(issuePath, 'PATCH', { expectedVersion:issue.version, plannedEffortMinutes:invalid }, 400);
  issue = await f.call<Issue>(issuePath, 'PATCH', { expectedVersion:issue.version, plannedEffortMinutes:181 });
  assert.equal(issue.estimate, 8);
  await f.call(issuePath, 'PATCH', { expectedVersion:issue.version - 1, plannedEffortMinutes:200 }, 409);
  const pointsOnly = await f.issue({estimate:100});
  await f.issue({plannedEffortMinutes:700,status:'done'});

  const draft = {
    expectedVersion:defaultCapacity.version, defaultDailyMinutes:240,
    members:[{userId:alice,dailyMinutes:91}], exceptions:[{userId:alice,date:tuesday,availableMinutes:30}],
  };
  await f.call(capacityPath, 'PATCH', {...draft, defaultDailyMinutes:1441}, 400);
  await f.call(capacityPath, 'PATCH', {...draft, members:[...draft.members, ...draft.members]}, 400);
  await f.call(capacityPath, 'PATCH', {...draft, exceptions:[...draft.exceptions, ...draft.exceptions]}, 400);
  await f.call(capacityPath, 'PATCH', {...draft, members:[{userId:'absent-user',dailyMinutes:1}]}, 400);
  assert.deepEqual(await f.call(capacityPath), defaultCapacity);

  const reader = await f.call<ApiKeyCreated>('/api-keys', 'POST', {name:'합성 작업량 읽기',access:'read',projectIds:[f.project.id]}, 201);
  const writer = await f.call<ApiKeyCreated>('/api-keys', 'POST', {name:'합성 작업량 설정',access:'write',projectIds:[f.project.id]}, 201);
  await f.call(`/v1${capacityPath}`, 'PATCH', draft, 403, reader.token);
  await f.call('/v1/projects/project-team/workload-capacity', 'GET', undefined, 403, writer.token);
  await f.call(`/v1/projects/project-team/workload?startDate=${monday}&endDate=${tuesday}`, 'GET', undefined, 403, reader.token);
  assert.deepEqual(await f.call(`/v1${capacityPath}`, 'GET', undefined, 200, reader.token), defaultCapacity);
  const settings = await f.call<ProjectWorkloadCapacity>(`/v1${capacityPath}`, 'PATCH', draft, 200, writer.token);
  assert.equal(settings.version, defaultCapacity.version + 1);
  await f.call(capacityPath, 'PATCH', draft, 409);
  assert.deepEqual(await f.call(capacityPath), settings);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).workloadCapacities?.find(value => value.projectId === f.project.id), settings);

  const result = await f.call<ProjectWorkloadResult>(range);
  assert.deepEqual(await f.call(`/v1${range}`, 'GET', undefined, 200, reader.token), result);
  assert.deepEqual(rowFor(result, alice).days.map(day => [day.scheduledMinutes, day.availableMinutes]), [[91, 91], [90, 30]]);
  assert.equal(result.totalScheduledMinutes, 181);
  assert.equal(result.overloadedCells, 1);
  assert.deepEqual(result.incomplete, [{issueId:pointsOnly.id,reasons:['missing-effort']}]);
  await f.call(`${projectPath}/workload?startDate=2026-02-30&endDate=${tuesday}`, 'GET', undefined, 400);
  await f.call(`${projectPath}/workload?startDate=2026-01-01&endDate=${tuesday}`, 'GET', undefined, 400);

  const currentCalendar = await f.call<{version:number}>(`${projectPath}/calendar`);
  await f.call(`${projectPath}/calendar`, 'PATCH', {
    expectedVersion:currentCalendar.version, exceptions:[{date:tuesday,isWorking:false,label:'합성 개인 예외보다 우선하는 휴무'}],
  });
  const holiday = await f.call<ProjectWorkloadResult>(range);
  assert.deepEqual(rowFor(holiday, alice).days.map(day => [day.scheduledMinutes, day.availableMinutes]), [[181, 91], [0, 0]]);
  assert.equal(holiday.totalScheduledMinutes, result.totalScheduledMinutes);
});

test('native workload backup preserves live and archived effort and rejects invalid members without overwriting state', async t => {
  const f = await fixture(t);
  const capacityPath = `/projects/${f.project.id}/workload-capacity`;
  const initial = await f.call<ProjectWorkloadCapacity>(capacityPath);
  const saved = await f.call<ProjectWorkloadCapacity>(capacityPath, 'PATCH', {
    expectedVersion:initial.version, defaultDailyMinutes:360,
    members:[{userId:bob,dailyMinutes:0}], exceptions:[{userId:bob,date:tuesday,availableMinutes:75}],
  });
  const live = await f.issue({ estimate:3, plannedEffortMinutes:0 });
  const archived = await f.issue({ estimate:8, plannedEffortMinutes:321 });
  const removal = await f.call<{trashEntryId:string}>(`/issues/${archived.id}`, 'DELETE', { expectedVersion:archived.version });
  const archivePath = `/trash/${removal.trashEntryId}/restore`;
  const backup = await f.export();
  assert.equal(backup.schemaVersion, 26);
  assert.equal(backup.issues.find(value => value.id === live.id)?.plannedEffortMinutes, 0);
  assert.equal(backup.trashEntries.find(value => value.id === removal.trashEntryId)?.resource.plannedEffortMinutes, 321);
  assert.deepEqual(backup.workloadCapacities?.find(value => value.projectId === f.project.id), saved);
  await f.restart();
  assert.deepEqual(await f.call(capacityPath), saved);
  const changed = await f.call<ProjectWorkloadCapacity>(capacityPath, 'PATCH', {
    expectedVersion:saved.version, defaultDailyMinutes:120, members:[], exceptions:[],
  });
  const malformed = structuredClone(backup);
  malformed.workloadCapacities!.find(value => value.projectId === f.project.id)!.members = [{userId:'absent-user',dailyMinutes:0}];
  await f.call('/import', 'POST', {data:malformed}, 400);
  assert.deepEqual(await f.call(capacityPath), changed);
  const badArchivedEffort = structuredClone(backup);
  badArchivedEffort.trashEntries.find(value => value.id === removal.trashEntryId)!.resource.plannedEffortMinutes = -5;
  await f.call('/import', 'POST', {data:badArchivedEffort}, 400);
  assert.deepEqual(await f.call(capacityPath), changed);

  await f.call('/import', 'POST', {data:backup});
  const restored = await f.call<ProjectWorkloadCapacity>(capacityPath);
  assert.ok(restored.version > changed.version);
  assert.equal(restored.defaultDailyMinutes, saved.defaultDailyMinutes);
  assert.deepEqual(restored.members, saved.members);
  assert.deepEqual(restored.exceptions, saved.exceptions);
  await f.call(archivePath, 'POST', {});
  const merged = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(merged.issues.find(value => value.id === archived.id)?.plannedEffortMinutes, 321);
  assert.equal(merged.issues.find(value => value.id === live.id)?.plannedEffortMinutes, 0);

  const legacy = structuredClone(backup);
  legacy.schemaVersion = 17;
  delete legacy.workloadCapacities;
  for (const issue of [...legacy.issues, ...legacy.trashEntries.map(value => value.resource)]) delete issue.plannedEffortMinutes;
  await f.call('/import', 'POST', {data:legacy});
  const legacyCapacity = await f.call<ProjectWorkloadCapacity>(capacityPath);
  assert.equal(legacyCapacity.defaultDailyMinutes, 480);
  assert.deepEqual(legacyCapacity.members, []);
  assert.deepEqual(legacyCapacity.exceptions, []);
  await f.call(archivePath, 'POST', {});
  const legacyIssues = (await f.call<WorkspaceSnapshot>('/workspace')).issues;
  assert.equal(legacyIssues.find(value => value.id === live.id)?.plannedEffortMinutes ?? null, null);
  assert.equal(legacyIssues.find(value => value.id === archived.id)?.plannedEffortMinutes ?? null, null);
  assert.equal(legacyIssues.find(value => value.id === archived.id)?.estimate, 8);
});

test('team workload combines project calendars against one availability per person and date', async t => {
  const f = await fixture(t);
  const other = await f.call<Project>('/projects', 'POST', { name:'합성 병행 프로젝트', key:'WLO' }, 201);
  for (const { id, exceptions } of [
    { id:f.project.id, exceptions:[{date:saturday,isWorking:true,label:'주말 투입'}] },
    { id:other.id, exceptions:[{date:friday,isWorking:false,label:'대체 휴무'},{date:saturday,isWorking:true,label:'주말 투입'}] },
  ]) {
    const path = `/projects/${id}/calendar`;
    const { version } = await f.call<{version:number}>(path);
    await f.call(path, 'PATCH', {expectedVersion:version,exceptions});
  }
  const localPath = `/projects/${f.project.id}/workload-capacity`;
  const projectCapacity = await f.call<ProjectWorkloadCapacity>(localPath);
  await f.call(localPath, 'PATCH', {expectedVersion:projectCapacity.version,defaultDailyMinutes:1100});
  const first = await f.issue({ startDate:friday,endDate:monday,plannedEffortMinutes:361 });
  const second = await f.issue({ projectId:other.id,startDate:friday,endDate:monday,plannedEffortMinutes:400 });
  const incomplete = await f.issue({ projectId:other.id,assigneeId:null,startDate:null,endDate:null,plannedEffortMinutes:25 });
  await f.issue({ projectId:other.id,startDate:friday,endDate:monday,plannedEffortMinutes:900,status:'done' });

  const capacityPath = '/workload-capacity';
  const initial = await f.call<TeamWorkloadCapacity>(capacityPath);
  const capacity = await f.call<TeamWorkloadCapacity>(capacityPath, 'PATCH', {
    expectedVersion:initial.version,
    members:[{userId:alice,dailyMinutes:300}],
    calendarExceptions:[{date:monday,isWorking:false,label:'팀 휴무'}],
    exceptions:[{userId:alice,date:saturday,availableMinutes:250},{userId:alice,date:monday,availableMinutes:320}],
  });
  const range = `/workload?startDate=${friday}&endDate=${monday}`;
  const path = `${range}&projectId=${f.project.id}&projectId=${other.id}`;
  const both = await f.call<TeamWorkloadResult>(path);
  assert.deepEqual(new Set(both.projectIds), new Set([f.project.id, other.id]));
  assert.equal(both.capacityVersion, capacity.version);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).teamWorkloadCapacity, capacity);
  assert.deepEqual(both.days.map(day => [day.date, day.working]), [[friday,true],[saturday,false],[sunday,false],[monday,false]]);
  const person = both.rows.find(row => row.userId === alice)!;
  assert.deepEqual(person.days.map(day => [day.scheduledMinutes,day.availableMinutes]), [[121,300],[320,250],[0,0],[320,320]]);
  assert.equal(person.overloadedDays, 1);
  assert.equal(both.overloadedCells, 1);
  assert.equal(both.totalScheduledMinutes, 761);
  assert.deepEqual(new Map(person.days[1].allocations.map(value => [value.issueId, [value.projectId,value.minutes]])), new Map([
    [first.id,[f.project.id,120]], [second.id,[other.id,200]],
  ]));
  assert.deepEqual(both.incomplete, [{ issueId:incomplete.id,projectId:other.id,reasons:['unassigned','missing-dates'] }]);
  const single = await f.call<TeamWorkloadResult>(`${range}&projectId=${other.id}`);
  assert.equal(single.totalAvailableMinutes, both.totalAvailableMinutes);
  assert.equal(single.totalScheduledMinutes, 400);
  assert.equal(single.overloadedCells, 0);
  assert.ok((await f.call<TeamWorkloadResult>(range)).projectIds.includes(other.id));
  await f.call(`${range}&projectId=${other.id}&projectId=${other.id}`, 'GET', undefined, 400);
  await f.call(`${range}&projectId=absent-project`, 'GET', undefined, 404);
  await f.call(`${range}&ignored=1`, 'GET', undefined, 400);
  await f.call(`/workload?startDate=${friday}&endDate=2027-12-01`, 'GET', undefined, 400);
  const reader = await f.call<ApiKeyCreated>('/api-keys', 'POST', {name:'프로젝트 범위 키',access:'read',projectIds:[other.id]}, 201);
  await f.call(`/v1${path}`, 'GET', undefined, 403, reader.token);
  await f.call(`/v1${capacityPath}`, 'GET', undefined, 403, reader.token);
  await f.call('/v1/workspace', 'GET', undefined, 403, reader.token);
});

test('team workload proposal counts fixed projects, applies across calendars once and undoes all moves', async t => {
  const f = await fixture(t);
  const another = await f.call<Project>('/projects', 'POST', { name: '병행 조정 프로젝트', key: 'LVL' }, 201);
  const background = await f.call<Project>('/projects', 'POST', { name: '그대로 둘 프로젝트', key: 'FIX' }, 201);
  const assignee = await f.call<User>('/users', 'POST', { name: '합성 팀 작업 담당자', email: 'team-level@example.test' }, 201);
  const wednesday = '2026-11-25', thursday = '2026-11-26';
  await f.call('/workload-capacity', 'PATCH', { expectedVersion: 1, defaultDailyMinutes: 100,
    exceptions: [{ userId: assignee.id, date: tuesday, availableMinutes: 0 }] });
  await f.call(`/projects/${another.id}/calendar`, 'PATCH', { expectedVersion: 1,
    exceptions: [{ date: wednesday, isWorking: false, label: '프로젝트 휴무' }] });
  const start = { startDate: monday, endDate: monday, assigneeId: assignee.id, plannedEffortMinutes: 60, priority: 'low' } as const;
  const first = await f.issue({ ...start, title: '수요일에 가능한 업무' });
  const second = await f.issue({ ...start, projectId: another.id, title: '목요일에 가능한 업무' });
  const fixed = await f.issue({ ...start, projectId: background.id, title: '선택에서 제외한 업무' });

  const input = { startDate: monday, endDate: thursday, projectIds: [f.project.id, another.id], userIds: [assignee.id] };
  const previewPath = '/schedule/team-workload-preview';
  const applyPath = '/schedule/team-workload-apply';
  const workspace = async () => (await f.call<WorkspaceSnapshot>('/workspace')).issues;
  const preview = await f.call<TeamWorkloadLevelPreview>(previewPath, 'POST', input);
  assert.deepEqual(preview.movableProjectIds, input.projectIds);
  assert.equal(preview.before.overloadedCells, 1);
  assert.equal(preview.before.excessMinutes, 80);
  assert.equal(preview.after.excessMinutes, 0);
  assert.deepEqual(new Map(preview.changes.map(change => [change.id, [change.projectId, change.toStart, change.toEnd]])), new Map([
    [first.id, [f.project.id, wednesday, wednesday]], [second.id, [another.id, thursday, thursday]],
  ]));
  assert.deepEqual(new Map(preview.projectCompletions.map(value => [value.projectId, [value.before, value.after]])), new Map([
    [f.project.id, [monday, wednesday]], [another.id, [monday, thursday]],
  ]));
  assert.deepEqual((await workspace()).filter(issue => [first.id, second.id, fixed.id].includes(issue.id)), [first, second, fixed]);
  const request = { previewId: preview.previewId };
  const receiptPath = `/schedule/team-workload-result/${preview.previewId}`;
  assert.deepEqual(await f.call(receiptPath), { applied: false });
  await f.call(receiptPath, 'GET', undefined, 409, undefined, bob);
  await f.call(applyPath, 'POST', request, 409, undefined, bob);
  await f.call('/schedule/workload-apply', 'POST', request, 404);
  await f.call(`/schedule/workload-result/${preview.previewId}`, 'GET', undefined, 404);
  const applied = await f.call<{ undoId: string; updated: Issue[] }>(applyPath, 'POST', request);
  assert.deepEqual(new Map(applied.updated.map(issue => [issue.id, [issue.startDate, issue.version]])), new Map([
    [first.id, [wednesday, first.version + 1]], [second.id, [thursday, second.version + 1]],
  ]));
  assert.deepEqual((await workspace()).find(issue => issue.id === fixed.id), fixed);
  await f.restart();
  assert.deepEqual(await f.call(receiptPath), applied);
  assert.deepEqual(await f.call(applyPath, 'POST', request), applied);
  const workload = await f.call<TeamWorkloadResult>(`/workload?startDate=${monday}&endDate=${thursday}`);
  const row = rowFor(workload, assignee.id);
  assert.deepEqual(row.days.map(cell => [cell.scheduledMinutes, cell.availableMinutes]), [[60, 100], [0, 0], [60, 100], [60, 100]]);
  const undone = await f.call<{ updated: Issue[] }>('/schedule/undo', 'POST', { undoId: applied.undoId });
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, issue.startDate])), new Map([[first.id, monday], [second.id, monday]]));
});

test('team workload proposal rejects changes to fixed activity, calendars, team capacity and the project set', async t => {
  const f = await fixture(t);
  const fixedProject = await f.call<Project>('/projects', 'POST', { name: '고정 주변 프로젝트', key: 'BGW' }, 201);
  const assignee = await f.call<User>('/users', 'POST', { name: '합성 충돌 확인 담당자', email: 'team-guard@example.test' }, 201);
  await f.call('/workload-capacity', 'PATCH', { expectedVersion: 1, defaultDailyMinutes: 100 });
  const dates = { startDate: monday, endDate: monday, assigneeId: assignee.id, plannedEffortMinutes: 60 };
  const movable = await f.issue(dates);
  const fixed = await f.issue({ ...dates, projectId: fixedProject.id });
  const input = { startDate: monday, endDate: '2026-11-27', projectIds: [f.project.id], userIds: [assignee.id] };
  const route = '/schedule/team-workload-preview';
  const token = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '프로젝트 작성 키', access: 'write', projectIds: [f.project.id] }, 201);
  await f.call(`/v1${route}`, 'POST', input, 403, token.token);
  await f.call(route, 'POST', { ...input, projectIds: [] }, 400);
  await f.call(route, 'POST', { ...input, projectIds: ['missing-project'] }, 404);
  const preview = () => f.call<TeamWorkloadLevelPreview>(route, 'POST', input);
  const stale = (before: TeamWorkloadLevelPreview) => f.call<{ error: string }>('/schedule/team-workload-apply', 'POST', { previewId: before.previewId }, 409);

  let before = await preview();
  assert.equal(before.changes[0].id, movable.id);
  await f.call(`/issues/${fixed.id}`, 'PATCH', { expectedVersion: fixed.version, plannedEffortMinutes: 70 });
  assert.match((await stale(before)).error, /업무/u);
  before = await preview();
  await f.call(`/projects/${fixedProject.id}/calendar`, 'PATCH', { expectedVersion: 1, name: '고정 일정의 새 달력' });
  assert.match((await stale(before)).error, /작업 달력/u);
  before = await preview();
  await f.call('/workload-capacity', 'PATCH', { expectedVersion: 2, defaultDailyMinutes: 105 });
  assert.match((await stale(before)).error, /팀 가용 시간/u);
  before = await preview();
  await f.call('/projects', 'POST', { name: '새로 포함할 프로젝트', key: 'ADD' }, 201);
  assert.match((await stale(before)).error, /프로젝트 목록/u);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).issues.find(value => value.id === movable.id), movable);
  const unapplied = await preview();
  await f.call('/import', 'POST', { data: await f.export() });
  await f.call(`/schedule/team-workload-result/${unapplied.previewId}`, 'GET', undefined, 404);
});

test('workspace availability survives restart and restore, and old backups retain project planning with a fresh team calendar', async t => {
  const f = await fixture(t);
  const path = '/workload-capacity';
  const initial = await f.call<TeamWorkloadCapacity>(path);
  const planned = await f.issue({plannedEffortMinutes:180});
  const draft = {
    expectedVersion:initial.version, defaultDailyMinutes:390, workingWeekdays:[6,1,2,3,4],
    calendarExceptions:[{date:friday,isWorking:true,label:'합성 근무'}],
    members:[{userId:alice,dailyMinutes:300}], exceptions:[{userId:alice,date:friday,availableMinutes:0}],
  };
  await f.call(path, 'PATCH', {...draft,workingWeekdays:[1,1]}, 400);
  await f.call(path, 'PATCH', {...draft,calendarExceptions:[...draft.calendarExceptions,...draft.calendarExceptions]}, 400);
  await f.call(path, 'PATCH', {...draft,members:[{userId:'absent-user',dailyMinutes:0}]}, 400);
  assert.deepEqual(await f.call(path), initial);
  const saved = await f.call<TeamWorkloadCapacity>(path, 'PATCH', draft);
  assert.deepEqual(saved.workingWeekdays, [1,2,3,4,6]);
  await f.call(path, 'PATCH', draft, 409);
  await f.restart();
  assert.deepEqual(await f.call(path), saved);

  const backup = await f.export();
  assert.equal(backup.schemaVersion, 26);
  assert.deepEqual(backup.teamWorkloadCapacity, saved);
  const changed = await f.call<TeamWorkloadCapacity>(path, 'PATCH', {expectedVersion:saved.version,defaultDailyMinutes:75});
  const malformed = structuredClone(backup);
  malformed.teamWorkloadCapacity!.exceptions[0].userId = 'absent-user';
  await f.call('/import', 'POST', {data:malformed}, 400);
  await f.call('/import', 'POST', {data:{...backup,schemaVersion:18}}, 400);
  assert.deepEqual(await f.call(path), changed);
  await f.call('/import', 'POST', {data:backup});
  const restored = await f.call<TeamWorkloadCapacity>(path);
  assert.ok(restored.version > changed.version);
  assert.deepEqual({...restored,version:saved.version}, saved);
  await f.call(path, 'PATCH', {expectedVersion:changed.version,defaultDailyMinutes:100}, 409);

  const legacy = structuredClone(backup);
  legacy.schemaVersion = 18;
  delete legacy.teamWorkloadCapacity;
  await f.call('/import', 'POST', {data:legacy});
  const defaults = await f.call<TeamWorkloadCapacity>(path);
  assert.ok(defaults.version > restored.version);
  assert.deepEqual({ ...defaults,version:initial.version,updatedAt:initial.updatedAt }, initial);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === planned.id)?.plannedEffortMinutes, 180);
});
