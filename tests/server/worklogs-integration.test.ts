import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, Issue, Project, ProjectWorklogReport, WorklogEntry, WorkspaceSnapshot } from '../../shared/types.js';

interface WorklogList { entries: WorklogEntry[]; totalMinutes: number; totalEntries: number }
type WorklogBackup = WorkspaceSnapshot & { schemaVersion: number; worklogs: (WorklogEntry & { createHash: string; deletedAt: string | null })[] };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-worklogs-integration-'));
  const service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, actorId = 'user-yun', token?: string) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  };
  const created = await call<Project>('/projects', 'POST', { key: 'TME', name: '합성 시간 기록 프로젝트' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { call, project: created.data, async close() { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function issue(f: Fixture, title = '합성 기록 대상 업무') {
  const made = await f.call<Issue>('/issues', 'POST', { projectId: f.project.id, title, estimate: 5 });
  assert.equal(made.status, 201, JSON.stringify(made.data)); return made.data;
}
function endpoint(issueId: string, entryId?: string) { return `/issues/${issueId}/worklogs${entryId ? '/' + entryId : ''}`; }
async function list(f: Fixture, issueId: string, offset = 0) {
  const response = await f.call<WorklogList>(`${endpoint(issueId)}?offset=${offset}`);
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function log(f: Fixture, issueId: string, minutes: number, workDate = '2026-11-19', actorId = 'user-yun', note = '합성 검증 기록') {
  const input = { requestId: randomUUID(), workDate, minutes, note };
  const response = await f.call<WorklogEntry>(endpoint(issueId), 'POST', input, actorId);
  assert.equal(response.status, 201, JSON.stringify(response.data)); return { entry: response.data, input };
}

test('worklogs persist canonical minutes once per request, enforce author and scoped-parent checks, and use versioned edits/deletes', async () => {
  const f = await fixture();
  try {
    const target = await issue(f), sibling = await issue(f, '다른 합성 업무');
    const made = await log(f, target.id, 75);
    assert.equal(made.entry.issueId, target.id); assert.equal(made.entry.projectId, f.project.id); assert.equal(made.entry.authorId, 'user-yun');
    assert.equal(made.entry.minutes, 75); assert.equal(made.entry.workDate, made.input.workDate); assert.equal(made.entry.version, 1);
    const retried = await f.call<WorklogEntry>(endpoint(target.id), 'POST', made.input); assert.equal(retried.status, 201); assert.deepEqual(retried.data, made.entry);
    assert.equal((await f.call(endpoint(target.id), 'POST', { ...made.input, minutes: 76 })).status, 409);
    assert.equal((await f.call(endpoint(sibling.id), 'POST', made.input)).status, 409);
    const initial = await list(f, target.id); assert.deepEqual(initial.entries, [made.entry]); assert.equal(initial.totalMinutes, 75); assert.equal(initial.totalEntries, 1);
    const patch = { expectedVersion: 1, workDate: '2026-11-20', minutes: 90, note: '검토한 합성 시간 기록' };
    assert.equal((await f.call(endpoint(target.id, made.entry.id), 'PATCH', patch, 'user-seo')).status, 403);
    assert.equal((await f.call(endpoint(target.id, made.entry.id), 'DELETE', { expectedVersion: 1 }, 'user-seo')).status, 403);
    assert.equal((await f.call(endpoint(sibling.id, made.entry.id), 'PATCH', patch)).status, 404);
    const edited = await f.call<WorklogEntry>(endpoint(target.id, made.entry.id), 'PATCH', patch); assert.equal(edited.status, 200, JSON.stringify(edited.data)); assert.equal(edited.data.version, 2); assert.equal(edited.data.minutes, 90);
    assert.equal((await f.call(endpoint(target.id, made.entry.id), 'PATCH', patch)).status, 409);
    assert.equal((await f.call(endpoint(target.id, made.entry.id), 'DELETE', { expectedVersion: 1 })).status, 409);
    assert.equal((await list(f, target.id)).totalMinutes, 90);
    const canonical = (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === target.id)!;
    assert.equal(canonical.estimate, target.estimate); assert.equal(canonical.status, target.status); assert.equal(canonical.version, target.version);
    const removed = await f.call(endpoint(target.id, made.entry.id), 'DELETE', { expectedVersion: 2 }); assert.equal(removed.status, 200); assert.deepEqual(removed.data, { ok: true });
    assert.deepEqual(await list(f, target.id), { entries: [], totalMinutes: 0, totalEntries: 0 });
    assert.ok([409, 410].includes((await f.call(endpoint(target.id), 'POST', made.input)).status));
    assert.equal((await f.call(endpoint('missing'), 'GET')).status, 404);
    assert.equal((await f.call(endpoint('missing'), 'POST', { ...made.input, requestId: randomUUID() })).status, 404);
    for (const minutes of [0, 1441, 1.5]) assert.equal((await f.call(endpoint(target.id), 'POST', { ...made.input, requestId: randomUUID(), minutes })).status, 400);
    assert.equal((await f.call(endpoint(target.id), 'POST', { ...made.input, requestId: randomUUID(), workDate: '2026-02-30' })).status, 400);
    assert.equal((await list(f, target.id)).totalEntries, 0);
    assert.equal((await log(f, target.id, 1440, '2026-11-20', 'user-yun', '')).entry.minutes, 1440);
  } finally { await f.close(); }
});

test('issue time-entry pagination stays fixed at fifty while page totals include all live records', async () => {
  const f = await fixture();
  try {
    const target = await issue(f), expectedIds = new Set<string>();
    for (let index = 0; index < 51; index++) expectedIds.add((await log(f, target.id, 1, '2026-11-19', 'user-yun', `합성 기록 ${index + 1}`)).entry.id);
    const first = await list(f, target.id), second = await list(f, target.id, 50);
    assert.equal(first.entries.length, 50); assert.equal(second.entries.length, 1);
    for (const page of [first, second]) { assert.equal(page.totalMinutes, 51); assert.equal(page.totalEntries, 51); }
    assert.deepEqual(new Set([...first.entries, ...second.entries].map(value => value.id)), expectedIds);
    const beyond = await list(f, target.id, 100); assert.equal(beyond.entries.length, 0); assert.equal(beyond.totalMinutes, 51); assert.equal(beyond.totalEntries, 51);
    assert.equal((await f.call(`${endpoint(target.id)}?offset=-1`)).status, 400);
  } finally { await f.close(); }
});

test('project period totals filter by author, exclude deleted entries, and retain work against deleted issues with captured identity', async () => {
  const f = await fixture();
  try {
    const a = await issue(f, '계속 사용하는 합성 업무'), b = await issue(f, '나중에 삭제할 합성 업무');
    await log(f, a.id, 60); await log(f, a.id, 30, '2026-11-19', 'user-seo'); await log(f, b.id, 90, '2026-11-20');
    await log(f, a.id, 5, '2026-11-01'); await log(f, b.id, 10, '2026-11-30');
    await log(f, a.id, 15, '2026-10-31'); await log(f, a.id, 20, '2026-12-01');
    const erased = await log(f, a.id, 45); assert.equal((await f.call(endpoint(a.id, erased.entry.id), 'DELETE', { expectedVersion: erased.entry.version })).status, 200);
    assert.equal((await f.call(`/issues/${b.id}`, 'DELETE', { expectedVersion: b.version })).status, 200);
    const path = `/projects/${f.project.id}/worklog-report?startDate=2026-11-01&endDate=2026-11-30`;
    const response = await f.call<ProjectWorklogReport>(path); assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.projectId, f.project.id); assert.equal(response.data.authorId, null); assert.equal(response.data.minutes, 195); assert.equal(response.data.entryCount, 5);
    assert.deepEqual(new Map(response.data.byAuthor.map(row => [row.authorId, [row.minutes, row.entries]])), new Map([['user-yun', [165, 4]], ['user-seo', [30, 1]]]));
    assert.deepEqual(response.data.byIssue.find(row => row.issueId === a.id), { issueId: a.id, key: a.key, title: a.title, deleted: false, minutes: 95, entries: 3 });
    assert.deepEqual(response.data.byIssue.find(row => row.issueId === b.id), { issueId: b.id, key: b.key, title: b.title, deleted: true, minutes: 100, entries: 2 });
    assert.equal(response.data.days.length, 30);
    assert.deepEqual(response.data.days.filter(row => row.minutes > 0), [
      { date: '2026-11-01', minutes: 5, entries: 1 }, { date: '2026-11-19', minutes: 90, entries: 2 },
      { date: '2026-11-20', minutes: 90, entries: 1 }, { date: '2026-11-30', minutes: 10, entries: 1 },
    ]);
    const author = await f.call<ProjectWorklogReport>(path + '&authorId=user-yun'); assert.equal(author.status, 200, JSON.stringify(author.data));
    assert.equal(author.data.minutes, 165); assert.equal(author.data.entryCount, 4); assert.equal(author.data.authorId, 'user-yun');
    assert.deepEqual(author.data.byAuthor, [{ authorId: 'user-yun', minutes: 165, entries: 4 }]);
    const deletedIssueList = await f.call(endpoint(b.id)); assert.equal(deletedIssueList.status, 404);
    assert.equal((await f.call(`/projects/${f.project.id}/worklog-report?startDate=2026-09-01&endDate=2026-12-01`)).status, 200);
    assert.equal((await f.call(`/projects/${f.project.id}/worklog-report?startDate=2026-01-01&endDate=2026-12-31`)).status, 400);
  } finally { await f.close(); }
});

test('native schema11 retains canonical entries and deletion tombstones, raises stale versions after restore, and rejects corrupt references atomically', async () => {
  const f = await fixture();
  try {
    const target = await issue(f), live = await log(f, target.id, 60), removed = await log(f, target.id, 15), historicalTarget = await issue(f, '복원할 삭제 업무의 이름');
    const historical = await log(f, historicalTarget.id, 25);
    assert.equal((await f.call(`/issues/${historicalTarget.id}`, 'DELETE', { expectedVersion: historicalTarget.version })).status, 200);
    const edited = await f.call<WorklogEntry>(endpoint(target.id, live.entry.id), 'PATCH', { expectedVersion: 1, workDate: '2026-11-20', minutes: 90, note: '백업할 합성 기록' }); assert.equal(edited.status, 200);
    assert.equal((await f.call(endpoint(target.id, removed.entry.id), 'DELETE', { expectedVersion: 1 })).status, 200);
    const exported = await f.call<WorklogBackup>('/export'); assert.equal(exported.status, 200); assert.equal(exported.data.schemaVersion, 19); assert.equal(exported.data.worklogs.length, 3);
    const tombstone = exported.data.worklogs.find(value => value.id === removed.entry.id)!; assert.ok(tombstone.deletedAt); assert.equal(tombstone.note, ''); assert.match(tombstone.createHash, /^[a-f\d]{64}$/);
    assert.equal(exported.data.worklogs.find(value => value.id === historical.entry.id)?.issueTitle, historicalTarget.title);
    const later = await f.call<WorklogEntry>(endpoint(target.id, live.entry.id), 'PATCH', { expectedVersion: edited.data.version, workDate: '2026-11-21', minutes: 120, note: '백업 후 수정' }); assert.equal(later.status, 200);
    const restored = await f.call('/import', 'POST', { data: exported.data }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const listAfterRestore = await list(f, target.id); assert.equal(listAfterRestore.totalMinutes, 90); assert.equal(listAfterRestore.totalEntries, 1); assert.equal(listAfterRestore.entries[0].note, '백업할 합성 기록');
    assert.ok(listAfterRestore.entries[0].version > later.data.version);
    assert.equal((await f.call(endpoint(target.id, live.entry.id), 'PATCH', { expectedVersion: edited.data.version, workDate: '2026-11-20', minutes: 95, note: '' })).status, 409);
    assert.ok([409, 410].includes((await f.call(endpoint(target.id), 'POST', removed.input)).status));
    const period = await f.call<ProjectWorklogReport>(`/projects/${f.project.id}/worklog-report?startDate=2026-11-01&endDate=2026-11-30`);
    assert.equal(period.status, 200); assert.equal(period.data.minutes, 115);
    assert.equal(period.data.byIssue.find(row => row.issueId === historicalTarget.id)?.deleted, true);
    assert.equal(period.data.byIssue.find(row => row.issueId === historicalTarget.id)?.title, historicalTarget.title);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, backup = (await f.call<WorklogBackup>('/export')).data;
    const bad = structuredClone(backup); bad.worklogs.find(value => value.id === live.entry.id)!.projectId = 'missing-project';
    const rejected = await f.call('/import', 'POST', { data: bad }); assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before); assert.deepEqual(await list(f, target.id), listAfterRestore);
    assert.deepEqual((await f.call<WorklogBackup>('/export')).data.worklogs, backup.worklogs);
  } finally { await f.close(); }
});

test('scoped API keys read and write worklogs within their projects and cannot spoof the recorded author or edit another author’s entry', async () => {
  const f = await fixture();
  try {
    const target = await issue(f), foreign = (await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.projectId !== f.project.id)!;
    const reader = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 시간 조회 키', access: 'read', projectIds: [f.project.id], expiresAt: null });
    const writer = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 시간 기록 키', access: 'write', projectIds: [f.project.id], expiresAt: null });
    assert.equal(reader.status, 201); assert.equal(writer.status, 201);
    const input = { requestId: randomUUID(), workDate: '2026-11-19', minutes: 40, note: '키로 입력한 합성 시간' };
    assert.equal((await f.call('/v1' + endpoint(target.id), 'POST', input, 'user-seo', reader.data.token)).status, 403);
    const made = await f.call<WorklogEntry>('/v1' + endpoint(target.id), 'POST', { ...input, actorId: 'user-seo', authorId: 'user-seo' }, 'user-seo', writer.data.token);
    assert.equal(made.status, 201, JSON.stringify(made.data)); assert.equal(made.data.authorId, 'user-yun');
    const readable = await f.call<WorklogList>('/v1' + endpoint(target.id) + '?offset=0', 'GET', undefined, 'user-seo', reader.data.token);
    assert.equal(readable.status, 200); assert.equal(readable.data.totalMinutes, 40); assert.equal(readable.data.entries[0].authorId, 'user-yun');
    assert.equal((await f.call('/v1' + endpoint(foreign.id), 'GET', undefined, 'user-yun', reader.data.token)).status, 403);
    assert.equal((await f.call('/v1' + endpoint(foreign.id), 'POST', { ...input, requestId: randomUUID() }, 'user-yun', writer.data.token)).status, 403);
    const reportPath = `/v1/projects/${f.project.id}/worklog-report?startDate=2026-11-01&endDate=2026-11-30`;
    const report = await f.call<ProjectWorklogReport>(reportPath, 'GET', undefined, 'user-seo', reader.data.token); assert.equal(report.status, 200); assert.equal(report.data.minutes, 40);
    assert.equal((await f.call(`/v1/projects/${foreign.projectId}/worklog-report?startDate=2026-11-01&endDate=2026-11-30`, 'GET', undefined, 'user-yun', reader.data.token)).status, 403);
    const someoneElse = await log(f, target.id, 20, '2026-11-20', 'user-seo');
    const patch = { expectedVersion: 1, workDate: '2026-11-21', minutes: 50, note: '' };
    assert.equal((await f.call('/v1' + endpoint(target.id, someoneElse.entry.id), 'PATCH', { ...patch, actorId: 'user-seo' }, 'user-seo', writer.data.token)).status, 403);
    const changed = await f.call<WorklogEntry>('/v1' + endpoint(target.id, made.data.id), 'PATCH', patch, 'user-seo', writer.data.token);
    assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.authorId, 'user-yun'); assert.equal(changed.data.minutes, 50);
    assert.equal((await list(f, target.id)).totalMinutes, 70);
  } finally { await f.close(); }
});
