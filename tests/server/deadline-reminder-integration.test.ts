import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { ISSUE_DEADLINE_REMINDER_KINDS, type DeadlineReminderPreferences, type DeadlineReminderPreferenceRecord,
  type Issue, type TeamNotification, type TeamNotificationPage, type User, type WorkspaceSnapshot } from '../../shared/types.js';

const settingsPath = '/notifications/deadline-reminders';
const defaultSettings = { daysBefore: 0, onDueDate: false, overdue: false, version: null };
const reminderKinds: ReadonlySet<string> = new Set(ISSUE_DEADLINE_REMINDER_KINDS);
type Backup = WorkspaceSnapshot & { schemaVersion: number; teamNotifications: TeamNotification[]; deadlineReminderPreferences: DeadlineReminderPreferenceRecord[] };

async function fixture(t: TestContext, initialInstant: string, worker = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-deadline-route-'));
  let instant = initialInstant;
  async function start() {
    const app = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: worker,
      deadlineReminderIntervalMs: 25, deadlineReminderClock: () => new Date(instant) });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { app, server, base: `http://127.0.0.1:${address.port}/api` };
  }
  let service = await start();
  async function stop() {
    await new Promise<void>(resolve => service.server.close(() => resolve()));
    service.app.close();
  }
  t.after(async () => {
    try { await stop(); } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', data?: unknown, actorId = 'user-min') {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(actorId ? { 'X-Actor-Id': actorId } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, cacheControl: response.headers.get('cache-control'), data: await response.json() as T };
  }
  async function assignee() {
    const created = await call<User>('/users', 'POST', { name: '합성 마감 담당자', email: 'reminder-recipient@example.test' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  }
  async function issue(assigneeId: string, date: string) {
    const created = await call<Issue>('/issues', 'POST', { title: '합성 마감 확인 업무', projectId: 'project-neo', assigneeId, dueDate: date });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data;
  }
  async function reminderRows(actorId: string) {
    const inbox = await call<TeamNotificationPage>('/notifications', 'GET', undefined, actorId);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
    return inbox.data.items.filter(item => reminderKinds.has(item.kind));
  }
  async function observeWorker(actorId: string, kind: string) {
    // Observe persisted effects without an inbox request participating in delivery.
    const reader = new DatabaseSync(join(dataDir, 'donefac.sqlite'), { readOnly: true });
    try {
      const query = reader.prepare('SELECT id FROM team_notifications WHERE recipient_id=? AND kind=?');
      const expires = Date.now() + 3_000;
      while (Date.now() < expires) {
        const row = query.get(actorId, kind) as { id: string } | undefined;
        if (row) return row.id;
        await delay(25);
      }
      assert.fail(`Deadline worker did not persist ${kind}`);
    } finally { reader.close(); }
  }
  return {
    assignee, call, issue, reminderRows, observeWorker,
    setClock(value: string) { instant = value; },
    async restart(nextInstant?: string) {
      await stop();
      if (nextInstant) instant = nextInstant;
      service = await start();
    },
  };
}

test('deadline worker sends once at Seoul midnight without inbox traffic and resumes on restart', async t => {
  const f = await fixture(t, '2031-01-27T14:59:59.000Z');
  const actor = await f.assignee();
  const issue = await f.issue(actor, '2031-01-28');
  const before = await f.call<DeadlineReminderPreferences>(settingsPath, 'GET', undefined, actor);
  assert.equal(before.status, 200);
  assert.deepEqual(before.data, defaultSettings);
  assert.equal(before.cacheControl, 'no-store');
  assert.equal((await f.call(settingsPath, 'GET', undefined, '')).status, 400);
  assert.equal((await f.call(settingsPath + '?userId=' + actor, 'GET')).status, 400);
  assert.equal((await f.call(settingsPath, 'PUT', {
    daysBefore: 0, onDueDate: true, overdue: true, expectedVersion: null, userId: 'user-min',
  }, actor)).status, 400);
  const enabled = await f.call<DeadlineReminderPreferences>(settingsPath, 'PUT', {
    daysBefore: 0, onDueDate: true, overdue: true, expectedVersion: null,
  }, actor);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.ok(enabled.data.version);
  assert.deepEqual((await f.call(settingsPath)).data, defaultSettings);
  assert.deepEqual(await f.reminderRows(actor), []);

  f.setClock('2031-01-27T15:00:00.000Z');
  const todayId = await f.observeWorker(actor, 'issue-deadline-today');
  const today = (await f.reminderRows(actor))[0];
  assert.deepEqual({ id: today.id, actorId: today.actorId, targetId: today.targetId, detail: today.detail, createdAt: today.createdAt },
    { id: todayId, actorId: null, targetId: issue.id, detail: '목표 마감일 2031-01-28', createdAt: '2031-01-27T15:00:00.000Z' });
  assert.equal((await f.call(`/notifications/${todayId}/read`, 'PATCH')).status, 404);
  assert.equal((await f.call(`/notifications/${todayId}/read`, 'PATCH', undefined, actor)).status, 200);
  await f.restart();
  const sameDay = await f.reminderRows(actor);
  assert.deepEqual(sameDay.map(row => row.id), [todayId]);
  assert.ok(sameDay[0].readAt);
  assert.deepEqual((await f.call(settingsPath, 'GET', undefined, actor)).data, enabled.data);

  await f.restart('2031-01-28T15:00:00.000Z');
  const resumed = await f.reminderRows(actor);
  assert.deepEqual(resumed.map(row => row.kind), ['issue-deadline-overdue', 'issue-deadline-today']);
  f.setClock('2031-01-29T15:00:00.000Z');
  await delay(70);
  assert.deepEqual(await f.reminderRows(actor), resumed);
});

test('native format 70 carries deadline receipts and settings and rejects older or malformed snapshots atomically', async t => {
  const f = await fixture(t, '2031-01-29T00:00:00.000Z', false);
  const actor = await f.assignee();
  const issue = await f.issue(actor, '2031-01-30');
  const original = (await f.call<Backup>('/export')).data;
  const saved = await f.call<DeadlineReminderPreferences>(settingsPath, 'PUT', {
    daysBefore: 2, onDueDate: true, overdue: false, expectedVersion: null,
  }, actor);
  assert.equal(saved.status, 200);
  const [reminder] = await f.reminderRows(actor);
  assert.equal(reminder.kind, 'issue-deadline-upcoming');
  assert.equal(reminder.actorId, null);
  assert.equal(reminder.targetId, issue.id);
  assert.equal((await f.call(`/notifications/${reminder.id}/read`, 'PATCH', undefined, actor)).status, 200);
  const receipt = await f.reminderRows(actor);
  const backup = (await f.call<Backup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.deadlineReminderPreferences, [{ userId: actor, ...saved.data }]);
  assert.ok(backup.teamNotifications.some(row => row.actorId === null && row.id === reminder.id));

  const oldWithSettings = { ...backup, schemaVersion: 69, teamNotifications: original.teamNotifications };
  const oldWithReceipt = { ...backup, schemaVersion: 69, deadlineReminderPreferences: [] };
  for (const data of [oldWithSettings, oldWithReceipt]) {
    const rejected = await f.call<{ error: string }>('/import', 'POST', { data });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /schemaVersion 70/u);
  }
  const malformed = { ...backup, deadlineReminderPreferences: [...backup.deadlineReminderPreferences, ...backup.deadlineReminderPreferences] };
  assert.equal((await f.call('/import', 'POST', { data: malformed })).status, 400);
  assert.deepEqual((await f.call(settingsPath, 'GET', undefined, actor)).data, saved.data);
  assert.deepEqual(await f.reminderRows(actor), receipt);

  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  const restored = (await f.call<DeadlineReminderPreferences>(settingsPath, 'GET', undefined, actor)).data;
  assert.deepEqual(restored, { ...saved.data, version: restored.version });
  assert.ok(restored.version && restored.version !== saved.data.version);
  assert.equal((await f.call(settingsPath, 'PUT', { daysBefore: 3, onDueDate: false, overdue: true, expectedVersion: saved.data.version }, actor)).status, 409);
  assert.equal((await f.call(settingsPath, 'PUT', { daysBefore: 3, onDueDate: false, overdue: true, expectedVersion: restored.version }, actor)).status, 200);
  assert.deepEqual(await f.reminderRows(actor), receipt);

  const compatible = { ...original, schemaVersion: 69, deadlineReminderPreferences: undefined };
  assert.equal((await f.call('/import', 'POST', { data: compatible })).status, 200);
  assert.deepEqual((await f.call(settingsPath, 'GET', undefined, actor)).data, defaultSettings);
  assert.deepEqual(await f.reminderRows(actor), []);
});
