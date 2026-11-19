import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import { calculateProjectWorkload, defaultWorkloadCapacity, WorkloadError } from '../../shared/project-workload.js';
import type { ApiKeyCreated, Issue, Project, ProjectWorkloadCapacity, ProjectWorkloadResult, WorkspaceSnapshot } from '../../shared/types.js';

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
  async function call<T = unknown>(path: string, method = 'GET', data?: unknown, expected = 200, token?: string) {
    const response = await fetch(runtime.base + path, {
      method, headers:{ 'Content-Type':'application/json', 'X-Actor-Id':alice, ...(token ? { Authorization:`Bearer ${token}` } : {}) },
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
  assert.equal(backup.schemaVersion, 18);
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
