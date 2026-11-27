import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, Issue, IssueTimeReservation, IssueTimeReservationEntry, Project, ProjectWorkloadResult,
  TrashRestoreResult, WorkspaceSnapshot,
} from '../../shared/types.js';

const actor = 'user-yun';
const editor = 'user-min';
const member = 'user-seo';
const iso = (day: number, time: string) => `2026-11-${String(day).padStart(2, '0')}T${time}:00.000Z`;
const endpoint = (issueId: string, bookingId?: string) => `/issues/${issueId}/time-reservations${bookingId ? `/${bookingId}` : ''}`;
const range = (startAt: string, endAt: string, userId?: string) => '/time-reservations?' + new URLSearchParams({
  startAt, endAt, ...(userId ? { userId } : {}),
});
const input = (startAt: string, endAt: string, userId = member) => ({ startAt, endAt, userId, requestId: randomUUID() });

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  timeReservations?: (IssueTimeReservation & { createHash: string; deletedAt: string | null })[];
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-time-reservations-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      url: `http://127.0.0.1:${address.port}/api`,
      async close() {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        runtime.close();
      },
    };
  }
  let running: Awaited<ReturnType<typeof start>> | undefined;
  t.after(async () => {
    try { await running?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  running = await start();
  async function call<T = Record<string, unknown>>(path: string, method = 'GET', data?: unknown, actorId = actor, token?: string) {
    const response = await fetch(running!.url + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const first = await expectStatus(call<Project>('/projects', 'POST', { key: 'TSBOOK', name: '합성 시간 배정 프로젝트' }), 201);
  const second = await expectStatus(call<Project>('/projects', 'POST', { key: 'TSOTHER', name: '겹침을 확인할 별도 프로젝트' }), 201);
  return {
    call, first, second,
    async restart() {
      await running?.close();
      running = undefined;
      running = await start();
    },
  };
}

async function expectStatus<T>(response: Promise<{ status: number; data: T }>, status = 200) {
  const result = await response;
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const createIssue = (f: Fixture, projectId: string, title: string, fields: Partial<Issue> = {}) =>
  expectStatus(f.call<Issue>('/issues', 'POST', { projectId, title, ...fields }), 201);
const list = (f: Fixture, issueId: string) => expectStatus(f.call<IssueTimeReservationEntry[]>(endpoint(issueId)));
const calendar = (f: Fixture, low: string, high: string, userId?: string) => expectStatus(f.call<IssueTimeReservationEntry[]>(range(low, high, userId)));
const backup = (f: Fixture) => expectStatus(f.call<Backup>('/export'));

test('guarded time reservation mutations replay after restart and do not overwrite later edits or restored data', async t => {
  const f = await fixture(t);
  const issue = await createIssue(f, f.first.id, '수정 결과를 다시 확인할 배정 업무');
  const created = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST', input(iso(23, '03:00'), iso(23, '04:00'))), 201);
  const path = endpoint(issue.id, created.id);
  const expectedRestoreGeneration = (await expectStatus(f.call<WorkspaceSnapshot>('/workspace'))).restoreGeneration!;
  const edit = { userId: member, startAt: created.startAt, endAt: iso(23, '04:30'), expectedVersion: created.version, expectedRestoreGeneration, requestId: randomUUID() };
  const changed = await expectStatus(f.call<IssueTimeReservationEntry>(path, 'PATCH', edit));
  await f.restart();
  assert.deepEqual(await expectStatus(f.call<IssueTimeReservationEntry>(path, 'PATCH', edit)), changed);
  await expectStatus(f.call(path, 'PATCH', edit, editor), 409);
  await expectStatus(f.call(path, 'PATCH', { ...edit, endAt: iso(23, '04:45') }), 409);

  const later = await expectStatus(f.call<IssueTimeReservationEntry>(path, 'PATCH', {
    ...edit, requestId: randomUUID(), expectedVersion: changed.version, endAt: iso(23, '05:00'),
  }, editor));
  assert.deepEqual(await expectStatus(f.call<IssueTimeReservationEntry>(path, 'PATCH', edit)), later);
  const activeBackup = await backup(f);
  const deleteParams = { expectedVersion: String(later.version), expectedRestoreGeneration, requestId: randomUUID() };
  const deletion = `${path}?${new URLSearchParams(deleteParams)}`;
  await expectStatus(f.call(deletion, 'DELETE'));
  await f.restart();
  await expectStatus(f.call(deletion, 'DELETE'));
  await expectStatus(f.call(deletion, 'DELETE', undefined, editor), 409);
  await expectStatus(f.call(`${path}?${new URLSearchParams({ ...deleteParams, requestId: randomUUID() })}`, 'DELETE'), 404);
  assert.deepEqual(await list(f, issue.id), []);

  await expectStatus(f.call('/import', 'POST', { data: activeBackup }));
  const [restored] = await list(f, issue.id);
  assert.equal(restored.endAt, later.endAt);
  await expectStatus(f.call(path, 'PATCH', { ...edit, requestId: randomUUID(), expectedVersion: restored.version }), 409);
  await expectStatus(f.call(`${path}?${new URLSearchParams({ ...deleteParams, expectedVersion: String(restored.version) })}`, 'DELETE'), 409);
  assert.deepEqual(await list(f, issue.id), [restored]);
});

test('ticket time reservations enforce strict intervals and cross-project overlap, retain separate effort, and edit with CAS', async t => {
  const f = await fixture(t);
  const issue = await createIssue(f, f.first.id, '계획 필드가 있는 시간 배정 업무', {
    assigneeId: member, startDate: '2026-11-23', endDate: '2026-11-23', plannedEffortMinutes: 120,
  });
  const other = await createIssue(f, f.second.id, '다른 프로젝트에서 같은 팀원이 맡을 업무');
  const first = input(iso(22, '23:30'), iso(23, '00:30'));
  const saved = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST', first), 201);
  assert.deepEqual(saved, {
    id: first.requestId, issueId: issue.id, userId: member, startAt: first.startAt, endAt: first.endAt,
    version: 1, state: 'reserved', createdById: actor, updatedById: actor,
    createdAt: saved.createdAt, updatedAt: saved.createdAt,
    projectId: f.first.id, issueKey: issue.key, issueTitle: issue.title,
  });
  assert.equal(new Date(saved.createdAt).toISOString(), saved.createdAt);
  assert.deepEqual(await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST', first)), saved);
  await expectStatus(f.call(endpoint(issue.id), 'POST', { ...first, endAt: iso(23, '00:31') }), 409);
  await expectStatus(f.call(endpoint(issue.id), 'POST', first, editor), 409);
  await expectStatus(f.call(endpoint(other.id), 'POST', first), 409);
  const overlap = await expectStatus(f.call<{ details: { conflict: IssueTimeReservationEntry } }>(endpoint(other.id), 'POST',
    input(iso(23, '00:00'), iso(23, '01:00'))), 409);
  assert.deepEqual(overlap.details.conflict, saved);
  const adjacent = input(iso(23, '00:30'), iso(23, '01:00'));
  const second = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(other.id), 'POST', adjacent), 201);
  const sameTimeDifferentMember = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST',
    input(first.startAt, first.endAt, editor)), 201);
  assert.deepEqual(new Set((await calendar(f, iso(23, '00:00'), iso(23, '00:30'))).map(row => row.id)), new Set([saved.id, sameTimeDifferentMember.id]));
  assert.deepEqual(await calendar(f, iso(23, '00:30'), iso(23, '01:00'), member), [second]);
  assert.deepEqual(await calendar(f, iso(23, '01:00'), iso(23, '01:30'), member), []);

  for (const invalid of [
    { startAt: '2026-02-30T00:00:00.000Z', endAt: '2026-03-01T00:00:00.000Z' },
    { startAt: '2026-11-24T00:00:01.000Z' }, { startAt: '2026-11-24T09:00:00.000+09:00' },
    { endAt: iso(24, '00:00') }, { endAt: iso(25, '00:01') }, { userId: 'unknown-member' },
    { requestId: 'invalid-id' }, { version: 1 },
  ]) {
    await expectStatus(f.call(endpoint(issue.id), 'POST', { ...input(iso(24, '00:00'), iso(24, '01:00')), ...invalid }), 400);
  }
  await expectStatus(f.call(range('2026-10-01T00:00:00.000Z', iso(23, '00:00'))), 400);
  await expectStatus(f.call(`${range(iso(23, '00:00'), iso(23, '01:00'))}&projectId=${f.first.id}`), 400);
  await expectStatus(f.call(endpoint('unknown-issue')), 404);
  const maximum = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST',
    input(iso(24, '00:00'), iso(25, '00:00'))), 201);
  assert.equal(maximum.endAt, iso(25, '00:00'));

  const patch = { userId: member, startAt: iso(23, '01:00'), endAt: iso(23, '02:00'), expectedVersion: 1 };
  await expectStatus(f.call(endpoint(other.id, saved.id), 'PATCH', patch), 404);
  await expectStatus(f.call(endpoint(issue.id, saved.id), 'PATCH', { ...patch, startAt: iso(23, '00:45') }), 409);
  const edited = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id, saved.id), 'PATCH', patch, editor));
  assert.deepEqual(edited, { ...saved, startAt: patch.startAt, endAt: patch.endAt, version: 2, updatedAt: edited.updatedAt, updatedById: editor });
  assert.deepEqual(await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id), 'POST', first)), edited);
  await expectStatus(f.call(endpoint(issue.id, saved.id), 'PATCH', patch), 409);
  await expectStatus(f.call(`${endpoint(issue.id, saved.id)}?expectedVersion=1`, 'DELETE'), 409);
  const deletion = `${endpoint(issue.id, saved.id)}?expectedVersion=2`;
  assert.deepEqual(await expectStatus(f.call(deletion, 'DELETE')), { ok: true });
  assert.deepEqual(await expectStatus(f.call(deletion, 'DELETE')), { ok: true });
  await expectStatus(f.call(endpoint(issue.id), 'POST', first), 409);
  assert.deepEqual((await list(f, issue.id)).map(row => row.id), [sameTimeDifferentMember.id, maximum.id]);

  const current = await expectStatus(f.call<WorkspaceSnapshot>('/workspace'));
  assert.deepEqual(current.issues.find(value => value.id === issue.id), issue);
  const workload = await expectStatus(f.call<ProjectWorkloadResult>(`/projects/${f.first.id}/workload?startDate=2026-11-23&endDate=2026-11-23`));
  assert.deepEqual(workload.rows.find(row => row.userId === member)?.days[0].allocations, [{ issueId: issue.id, minutes: 120 }]);
});

test('simultaneous reservation requests serialize, idempotency survives concurrent attempts, and public API keys cannot read the calendar', async t => {
  const f = await fixture(t);
  const first = await createIssue(f, f.first.id, '동시 저장 첫 업무');
  const second = await createIssue(f, f.second.id, '동시 저장 둘째 업무');
  const a = input(iso(23, '08:00'), iso(23, '09:00'));
  const b = input(iso(23, '08:30'), iso(23, '09:30'));
  const replies = await Promise.all([
    f.call<IssueTimeReservationEntry>(endpoint(first.id), 'POST', a),
    f.call<IssueTimeReservationEntry>(endpoint(second.id), 'POST', b, editor),
  ]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 409]);
  const winner = replies.find(reply => reply.status === 201)!.data;
  assert.deepEqual(await calendar(f, iso(23, '08:00'), iso(23, '10:00'), member), [winner]);

  const duplicate = input(iso(23, '10:00'), iso(23, '11:00'));
  const repeated = await Promise.all(Array.from({ length: 3 }, () => f.call<IssueTimeReservationEntry>(endpoint(second.id), 'POST', duplicate)));
  assert.deepEqual(repeated.map(reply => reply.status).sort(), [200, 200, 201]);
  for (const reply of repeated) assert.deepEqual(reply.data, repeated[0].data);
  assert.equal((await list(f, second.id)).filter(row => row.id === duplicate.requestId).length, 1);
  const key = await expectStatus(f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 자동화 키', access: 'write', expiresAt: null, projectIds: [f.first.id] }), 201);
  await expectStatus(f.call('/v1' + range(iso(23, '00:00'), iso(24, '00:00')), 'GET', undefined, actor, key.token), 403);
  await expectStatus(f.call('/v1' + endpoint(first.id), 'GET', undefined, actor, key.token), 403);
  await expectStatus(f.call('/v1' + endpoint(first.id), 'POST', input(iso(23, '12:00'), iso(23, '13:00')), actor, key.token), 403);
});

test('archive releases time and native backup retains slots, flags restore conflicts, and purges archived reservations', async t => {
  const f = await fixture(t);
  const issue = await createIssue(f, f.first.id, '휴지통에서 돌아올 배정 업무');
  const blocker = await createIssue(f, f.second.id, '휴지통 이후 시간을 넘겨받은 업무');
  const original = input(iso(23, '02:00'), iso(23, '03:00'));
  const remainsFree = input(iso(23, '03:00'), iso(23, '04:00'));
  await expectStatus(f.call(endpoint(issue.id), 'POST', original), 201);
  await expectStatus(f.call(endpoint(issue.id), 'POST', remainsFree), 201);
  const deleted = input(iso(23, '04:00'), iso(23, '05:00'));
  await expectStatus(f.call(endpoint(issue.id), 'POST', deleted), 201);
  await expectStatus(f.call(`${endpoint(issue.id, deleted.requestId)}?expectedVersion=1`, 'DELETE'));
  const archived = await expectStatus(f.call<{ trashEntryId: string }>(`/issues/${issue.id}?expectedVersion=${issue.version}`, 'DELETE'));
  await expectStatus(f.call(endpoint(issue.id)), 404);
  assert.deepEqual(await calendar(f, iso(23, '00:00'), iso(24, '00:00')), []);
  const replacement = input(iso(23, '02:15'), iso(23, '02:45'));
  await expectStatus(f.call(endpoint(blocker.id), 'POST', replacement), 201);

  const historical = await backup(f);
  assert.equal(historical.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(historical.timeReservations?.length, 4);
  assert.match(historical.timeReservations?.find(row => row.id === original.requestId)?.createHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(historical.timeReservations?.find(row => row.id === deleted.requestId)?.deletedAt);
  await expectStatus(f.call('/import', 'POST', { data: historical }));
  await f.restart();
  assert.deepEqual((await calendar(f, iso(23, '00:00'), iso(24, '00:00'))).map(row => row.id), [replacement.requestId]);
  const restored = await expectStatus(f.call<TrashRestoreResult>(`/trash/${archived.trashEntryId}/restore`, 'POST'));
  assert.equal(restored.resourceId, issue.id);
  assert.ok(restored.warnings.some(warning => /겹친 시간 배정 1건/.test(warning)), JSON.stringify(restored.warnings));
  const recovered = await list(f, issue.id);
  assert.deepEqual(recovered.map(row => [row.id, row.state]), [[original.requestId, 'needs-review'], [remainsFree.requestId, 'reserved']]);
  assert.ok(recovered.every(row => row.version > 1));
  assert.deepEqual((await calendar(f, iso(23, '00:00'), iso(24, '00:00'))).map(row => row.id), [replacement.requestId, remainsFree.requestId]);
  await expectStatus(f.call(endpoint(issue.id, original.requestId), 'PATCH', { userId: member, startAt: original.startAt, endAt: original.endAt, expectedVersion: 1 }), 409);
  await expectStatus(f.call(endpoint(issue.id, original.requestId), 'PATCH', { userId: member, startAt: original.startAt, endAt: original.endAt, expectedVersion: recovered[0].version }), 409);

  const canonical = await backup(f);
  const corrupt = structuredClone(canonical);
  corrupt.timeReservations!.find(row => row.id === original.requestId)!.state = 'reserved';
  await expectStatus(f.call('/import', 'POST', { data: corrupt }), 400);
  corrupt.timeReservations!.find(row => row.id === original.requestId)!.issueId = 'unknown-issue';
  await expectStatus(f.call('/import', 'POST', { data: corrupt }), 400);
  await expectStatus(f.call('/import', 'POST', { data: { ...canonical, schemaVersion: 29 } }), 400);
  assert.deepEqual((await backup(f)).timeReservations, canonical.timeReservations);

  const newStart = iso(23, '01:00'), newEnd = iso(23, '02:00');
  const confirmed = await expectStatus(f.call<IssueTimeReservationEntry>(endpoint(issue.id, original.requestId), 'PATCH', {
    userId: member, startAt: newStart, endAt: newEnd, expectedVersion: recovered[0].version,
  }));
  assert.equal(confirmed.state, 'reserved');
  assert.equal(confirmed.version, recovered[0].version + 1);
  assert.deepEqual((await calendar(f, newStart, iso(23, '04:00'))).map(row => row.id), [original.requestId, replacement.requestId, remainsFree.requestId]);
  const rearchived = await expectStatus(f.call<{ trashEntryId: string }>(`/issues/${issue.id}`, 'DELETE'));
  await expectStatus(f.call(`/trash/${rearchived.trashEntryId}`, 'DELETE'));
  assert.deepEqual((await backup(f)).timeReservations?.map(row => row.id), [replacement.requestId]);

  const legacy = { ...await backup(f), schemaVersion: 29 };
  delete legacy.timeReservations;
  await expectStatus(f.call('/import', 'POST', { data: legacy }));
  assert.deepEqual(await list(f, blocker.id), []);
  assert.deepEqual((await backup(f)).timeReservations, []);
  await expectStatus(f.call(endpoint(blocker.id), 'POST', replacement), 409);
  await expectStatus(f.call(endpoint(blocker.id), 'POST', { ...replacement, requestId: randomUUID() }), 201);
});
