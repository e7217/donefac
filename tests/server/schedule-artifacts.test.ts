import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { seed } from '../../server/seed.js';
import { ScheduleArtifactService, ScheduleArtifactError } from '../../server/schedule-artifacts.js';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import type { Issue, Milestone, Project, ScheduleBaseline, User, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

type Export = WorkspaceSnapshot & { schemaVersion: number; comments: unknown[]; revisions: unknown[]; attachments: unknown[]; attachmentContents: unknown[]; trashEntries?: unknown[] };
async function fixture(withSeed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-schedule-artifacts-'));
  const service = createApp({ dataDir: dir, seed: withSeed }); const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    async request<T = { error: string }>(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(withSeed ? { 'X-Actor-Id': 'user-yun' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as T };
    },
    async close() { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const snapshot = async (f: Fixture) => (await f.request<WorkspaceSnapshot>('/workspace')).data;
async function createMilestone(f: Fixture, extra: Record<string, unknown> = {}) { const response = await f.request<Milestone>('/milestones', 'POST', { projectId: 'project-neo', title: '출시 검토', date: '2026-12-01', ...extra }); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; }
async function createIssue(f: Fixture, extra: Record<string, unknown> = {}) { const response = await f.request<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '기준선 업무', startDate: '2026-11-23', endDate: '2026-11-27', ...extra }); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; }
function captureInput(data: WorkspaceSnapshot, projectId = 'project-neo') { return { projectId, name: '승인 일정', description: '범위와 날짜를 고정한 기록', expectedIssueVersions: Object.fromEntries(data.issues.filter(item => item.projectId === projectId).map(item => [item.id, item.version])), expectedMilestoneVersions: Object.fromEntries((data.milestones || []).filter(item => item.projectId === projectId).map(item => [item.id, item.version])), expectedCalendarVersion: data.calendars!.find(item => item.projectId === projectId)!.version }; }

test('milestone CRUD validates actual dates, owners and same-project links, and every mutation uses CAS', async () => {
  const f = await fixture();
  try {
    const issue = await createIssue(f), other = await createIssue(f, { projectId: 'project-team' });
    const item = await createMilestone(f, { ownerId: 'user-seo', issueIds: [issue.id], description: '검토 기준' });
    assert.equal(item.version, 1); assert.equal(item.ownerId, 'user-seo'); assert.deepEqual(item.issueIds, [issue.id]);
    for (const fields of [{ date: '2026-02-30' }, { date: '2026-2-01' }, { ownerId: 'missing' }, { status: 'done' }, { issueIds: [other.id] }, { issueIds: [issue.id, issue.id] }, { issueIds: ['missing'] }]) assert.equal((await f.request('/milestones', 'POST', { projectId: item.projectId, title: 'invalid', date: item.date, ...fields })).status, 400);
    assert.equal((await f.request('/milestones?projectId=project-neo&projectId=project-team')).status, 400);
    assert.equal((await f.request(`/milestones/${item.id}`, 'PATCH', { title: 'missing version' })).status, 400);
    assert.equal((await f.request(`/milestones/${item.id}`, 'PATCH', { expectedVersion: 4, title: 'stale' })).status, 409);
    assert.equal((await f.request(`/milestones/${item.id}`, 'PATCH', { expectedVersion: 1, projectId: other.projectId })).status, 400);
    const changed = await f.request<Milestone>(`/milestones/${item.id}`, 'PATCH', { expectedVersion: 1, title: '출시 승인', status: 'reached', ownerId: null });
    assert.equal(changed.status, 200); assert.equal(changed.data.version, 2); assert.equal(changed.data.status, 'reached');
    for (const query of ['', '?expectedVersion=NaN', '?expectedVersion=2&expectedVersion=2']) assert.equal((await f.request(`/milestones/${item.id}${query}`, 'DELETE')).status, 400);
    assert.equal((await f.request(`/milestones/${item.id}?expectedVersion=1`, 'DELETE')).status, 409);
    assert.equal((await f.request(`/milestones/${item.id}?expectedVersion=2`, 'DELETE')).status, 200);
    assert.ok(!(await snapshot(f)).milestones!.some(value => value.id === item.id));
    assert.ok((await snapshot(f)).activities.some(activity => activity.resourceId === item.id && activity.actorId === 'user-yun' && activity.action === '이정표 삭제'));
  } finally { await f.close(); }
});

test('baseline capture requires the exact visible issue/milestone sets and calendar version and records immutable values', async () => {
  const f = await fixture();
  try {
    const issue = await createIssue(f), item = await createMilestone(f, { issueIds: [issue.id] });
    let visible = await snapshot(f); const original = captureInput(visible);
    const created = await createIssue(f, { title: '양식을 연 뒤 생긴 업무' });
    assert.equal((await f.request('/baselines', 'POST', original)).status, 409);
    visible = await snapshot(f); const staleIssue = captureInput(visible);
    assert.equal((await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, title: '업무 변경' })).status, 200);
    assert.equal((await f.request('/baselines', 'POST', staleIssue)).status, 409);
    visible = await snapshot(f); const staleMilestone = captureInput(visible);
    assert.equal((await f.request(`/milestones/${item.id}`, 'PATCH', { expectedVersion: item.version, title: '이정표 변경' })).status, 200);
    assert.equal((await f.request('/baselines', 'POST', staleMilestone)).status, 409);
    visible = await snapshot(f); const staleDelete = captureInput(visible);
    assert.equal((await f.request(`/issues/${created.id}?expectedVersion=${created.version}`, 'DELETE')).status, 200);
    assert.equal((await f.request('/baselines', 'POST', staleDelete)).status, 409);
    visible = await snapshot(f); const staleCalendar = captureInput(visible), calendar = visible.calendars!.find(value => value.projectId === 'project-neo')!;
    assert.equal((await f.request('/projects/project-neo/calendar', 'PATCH', { ...calendar, expectedVersion: calendar.version, name: '월~목 근무', workingWeekdays: [1, 2, 3, 4] })).status, 200);
    assert.equal((await f.request('/baselines', 'POST', staleCalendar)).status, 409);
    visible = await snapshot(f); const input = captureInput(visible);
    const missing = structuredClone(input); delete missing.expectedIssueVersions[issue.id]; assert.equal((await f.request('/baselines', 'POST', missing)).status, 409);
    assert.equal((await f.request('/baselines', 'POST', { ...input, expectedIssueVersions: [] })).status, 400);
    const captured = await f.request<ScheduleBaseline>('/baselines', 'POST', { ...input, authorId: 'user-seo' }); assert.equal(captured.status, 201, JSON.stringify(captured.data));
    assert.equal(captured.data.authorId, 'user-yun'); assert.equal(captured.data.calendar.name, '월~목 근무');
    assert.deepEqual(captured.data.issues.find(value => value.issueId === issue.id), { issueId: issue.id, key: issue.key, title: '업무 변경', startDate: issue.startDate, endDate: issue.endDate, sourceVersion: 2 });
    assert.equal(captured.data.milestones.find(value => value.milestoneId === item.id)!.sourceVersion, 2);
    assert.equal((await f.request(`/baselines/${captured.data.id}`, 'PATCH', { name: '수정 불가', expectedVersion: 1 })).status, 404);
    const latestIssue = visible.issues.find(value => value.id === issue.id)!; await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: latestIssue.version, startDate: '2026-12-07', endDate: '2026-12-10' });
    assert.deepEqual((await f.request<ScheduleBaseline>(`/baselines/${captured.data.id}`)).data, captured.data);
    assert.equal((await f.request(`/baselines/${captured.data.id}?expectedVersion=2`, 'DELETE')).status, 409);
    assert.equal((await f.request(`/baselines/${captured.data.id}?expectedVersion=1`, 'DELETE')).status, 200);
  } finally { await f.close(); }
});

test('issue deletion detaches current milestone links atomically while historical baseline rows survive', async () => {
  const f = await fixture();
  try {
    const issue = await createIssue(f), item = await createMilestone(f, { issueIds: [issue.id] });
    const captured = (await f.request<ScheduleBaseline>('/baselines', 'POST', captureInput(await snapshot(f)))).data;
    assert.equal((await f.request(`/issues/${issue.id}?expectedVersion=${issue.version}`, 'DELETE')).status, 200);
    const after = await snapshot(f), detached = after.milestones!.find(value => value.id === item.id)!;
    assert.deepEqual(detached.issueIds, []); assert.equal(detached.version, item.version + 1);
    assert.ok(after.activities.some(value => value.resourceId === item.id && value.action === '연결 업무 삭제'));
    assert.equal((await f.request(`/milestones/${item.id}?expectedVersion=${item.version}`, 'DELETE')).status, 409);
    assert.equal((await f.request(`/milestones/${item.id}?expectedVersion=${detached.version}`, 'DELETE')).status, 200);
    const historical = (await f.request<ScheduleBaseline>(`/baselines/${captured.id}`)).data;
    assert.deepEqual(historical, captured); assert.ok(historical.issues.some(value => value.issueId === issue.id)); assert.ok(historical.milestones.some(value => value.milestoneId === item.id));
  } finally { await f.close(); }
});

test('current backup round-trips historical rows and calendar snapshots, bumps record CAS, and legacy1..4 starts without artifacts', async () => {
  const source = await fixture(), target = await fixture(false);
  try {
    const issue = await createIssue(source), item = await createMilestone(source, { issueIds: [issue.id] });
    const captured = (await source.request<ScheduleBaseline>('/baselines', 'POST', captureInput(await snapshot(source)))).data;
    await source.request(`/issues/${issue.id}?expectedVersion=1`, 'DELETE');
    const currentItem = (await snapshot(source)).milestones!.find(value => value.id === item.id)!;
    await source.request(`/milestones/${item.id}?expectedVersion=${currentItem.version}`, 'DELETE');
    const exported = (await source.request<Export>('/export')).data; assert.equal(exported.schemaVersion, 19);
    assert.equal((await target.request('/import', 'POST', { data: exported })).status, 200);
    let imported = await snapshot(target); assert.deepEqual(imported.baselines!.find(value => value.id === captured.id), captured);
    assert.equal((await target.request('/import', 'POST', { data: exported })).status, 200);
    imported = await snapshot(target); const restored = imported.baselines!.find(value => value.id === captured.id)!;
    assert.equal(restored.version, 2); assert.deepEqual(restored.issues, captured.issues); assert.deepEqual(restored.calendar, captured.calendar);
    assert.equal((await target.request(`/baselines/${captured.id}?expectedVersion=1`, 'DELETE')).status, 409);
    const malformed = structuredClone(exported); malformed.baselines![0].calendar.exceptions = [{ date: '2026-02-30', isWorking: true, label: 'invalid' }];
    const before = await snapshot(target); assert.equal((await target.request('/import', 'POST', { data: malformed })).status, 400); assert.deepEqual(await snapshot(target), before);
    for (const schemaVersion of [1, 2, 3, 4]) { const legacy = structuredClone(exported); legacy.schemaVersion = schemaVersion; delete legacy.trashEntries; assert.equal((await target.request('/import', 'POST', { data: legacy })).status, 200); imported = await snapshot(target); assert.deepEqual(imported.milestones, []); assert.deepEqual(imported.baselines, []); assert.equal(imported.calendars!.length, imported.projects.length); }
  } finally { await source.close(); await target.close(); }
});

test('pure validation accepts missing historical IDs but rejects cross-project current IDs; capture audit rollback leaves no baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-artifact-pure-')), store = new Store(dir); seed(store); const service = new ScheduleArtifactService(store);
  try {
    const projects = store.all<Project>('projects'), users = store.all<User>('users'), issues = store.all<Issue>('issues');
    const calendar: WorkCalendar = defaultWorkCalendar('project-neo');
    const input = { projectId: 'project-neo', name: '검증', expectedIssueVersions: Object.fromEntries(issues.filter(value => value.projectId === 'project-neo').map(value => [value.id, value.version])), expectedMilestoneVersions: {}, expectedCalendarVersion: calendar.version };
    assert.throws(() => service.capture(input, 'user-yun', () => calendar, () => { throw new Error('audit failed'); }), /audit failed/); assert.equal(service.allBaselines().length, 0);
    const baseline = service.capture(input, 'user-yun', () => calendar), original = structuredClone(baseline);
    const historical = { ...baseline, id: 'historical', issues: [{ issueId: 'deleted', key: 'OLD-1', title: '삭제된 업무', startDate: null, endDate: null, sourceVersion: 7 }], milestones: [{ milestoneId: 'removed', title: '제거된 목표', date: '2026-12-01', status: 'reached' as const, sourceVersion: 3 }] };
    const validated = service.validateImport([], [historical], projects, users, issues); assert.deepEqual(validated.baselines[0], historical); assert.equal(service.allBaselines().length, 1); assert.deepEqual(baseline, original);
    const other = issues.find(value => value.projectId !== 'project-neo')!;
    assert.throws(() => service.validateImport([], [{ ...historical, issues: [{ ...historical.issues[0], issueId: other.id }] }], projects, users, issues), ScheduleArtifactError);
    assert.throws(() => service.validateImport([], [{ ...historical, issues: [historical.issues[0], historical.issues[0]] }], projects, users, issues), ScheduleArtifactError);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
