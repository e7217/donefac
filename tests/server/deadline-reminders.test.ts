import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DeadlineReminderError, DeadlineRemindersService } from '../../server/deadline-reminders.js';
import { NotificationsService, TeamNotificationError } from '../../server/notifications.js';
import { Store } from '../../server/store.js';

const users = new Set(['assignee', 'teammate']);
const initialTime = '2026-11-21T14:59:59.000Z';
const preferences = { daysBefore: 1, onDueDate: true, overdue: true, expectedVersion: null };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-deadline-reminders-'));
  const store = new Store(dir);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const id of users) store.put('users', { id, email: `${id}@example.test` });
  store.put('projects', { id: 'project', key: 'DEAD' });
  const notifications = new NotificationsService(store);
  const time = { current: initialTime };
  const createReminders = (db: Store, notices: NotificationsService) => new DeadlineRemindersService(
    db, notices, issue => ['finalized', 'abandoned'].includes(issue.status), () => new Date(time.current),
  );
  const reminders = createReminders(store, notifications);
  return { dir, store, notifications, reminders, time, createReminders };
}

function saveIssue(store: Store, id: string, fields: {
  dueDate?: string | null; endDate?: string | null; assigneeId?: string | null; status?: string;
}) {
  store.put('issues', {
    id, key: `DEAD-${id}`, title: '업무', projectId: 'project', parentId: null, assigneeId: 'assignee',
    dueDate: null, endDate: null, status: 'todo', collaboratorIds: ['assignee'], ...fields,
  });
}

test('deadline stages use Seoul dates and the active assignee’s effective deadline', t => {
  const { store, notifications, reminders, time } = fixture(t);
  saveIssue(store, 'goal', { dueDate: '2026-11-22', endDate: '2026-11-20' });
  saveIssue(store, 'planned', { endDate: '2026-11-21' });
  saveIssue(store, 'late', { dueDate: '2026-11-20' });
  saveIssue(store, 'future', { dueDate: '2026-11-24' });
  saveIssue(store, 'done', { dueDate: '2026-11-21', status: 'finalized' });
  saveIssue(store, 'cancelled', { dueDate: '2026-11-21', status: 'abandoned' });
  saveIssue(store, 'undated', {});
  saveIssue(store, 'collaborator-only', { dueDate: '2026-11-21', assigneeId: 'teammate' });
  saveIssue(store, 'unassigned', { dueDate: '2026-11-21', assigneeId: null });

  assert.deepEqual(reminders.get('assignee'), { daysBefore: 0, onDueDate: false, overdue: false, version: null });
  reminders.sweep();
  assert.deepEqual(notifications.all(), []);

  reminders.update('assignee', preferences);
  reminders.sweep();
  assert.deepEqual(notifications.all().map(({ targetId, kind, detail, actorId, recipientId, createdAt }) =>
    [targetId, kind, detail, actorId, recipientId, createdAt]), [
    ['goal', 'issue-deadline-upcoming', '목표 마감일 2026-11-22', null, 'assignee', initialTime],
    ['planned', 'issue-deadline-today', '계획 종료일 2026-11-21', null, 'assignee', initialTime],
    ['late', 'issue-deadline-overdue', '목표 마감일 2026-11-20', null, 'assignee', initialTime],
  ]);

  time.current = '2026-11-21T15:00:00.000Z';
  reminders.sweep();
  reminders.sweep();
  assert.deepEqual(notifications.all().slice(3).map(({ targetId, kind }) => [targetId, kind]), [
    ['goal', 'issue-deadline-today'], ['planned', 'issue-deadline-overdue'],
  ]);
  saveIssue(store, 'goal', { endDate: '2026-11-22' });
  reminders.sweep();
  assert.equal(notifications.all().length, 5);
  saveIssue(store, 'goal', { dueDate: '2026-11-23' });
  reminders.sweep();
  const newDeadline = notifications.all().at(-1)!;
  assert.equal(newDeadline.kind, 'issue-deadline-upcoming');
  assert.equal(newDeadline.detail, '목표 마감일 2026-11-23');
  assert.equal(notifications.count('teammate'), 0);
});

test('reminder preferences validate revisions and roll back when immediate delivery fails', t => {
  const { store, reminders, notifications } = fixture(t);
  saveIssue(store, 'today', { dueDate: '2026-11-21' });
  for (const invalid of [
    { ...preferences, daysBefore: 15 }, { ...preferences, daysBefore: -1 },
    { ...preferences, daysBefore: 1.5 }, { ...preferences, onDueDate: 1 },
    { ...preferences, expectedVersion: 'arbitrary' }, { ...preferences, userId: 'teammate' },
    { daysBefore: 1, onDueDate: true, overdue: true },
  ]) {
    assert.throws(() => reminders.update('assignee', invalid), { status: 400 });
  }
  store.db.exec(`CREATE TRIGGER fail_deadline BEFORE INSERT ON team_notifications
    BEGIN SELECT RAISE(ABORT,'synthetic notification failure'); END;`);
  assert.throws(() => reminders.update('assignee', preferences), /synthetic notification failure/);
  assert.equal(reminders.get('assignee').version, null);
  assert.deepEqual(notifications.all(), []);
  store.db.exec('DROP TRIGGER fail_deadline');

  const saved = reminders.update('assignee', preferences);
  assert.ok(saved.version);
  assert.deepEqual(reminders.get('assignee'), saved);
  assert.equal(notifications.count('assignee'), 1);
  assert.throws(() => reminders.update('assignee', preferences), { status: 409 });
  assert.throws(() => reminders.update('assignee', { ...preferences, expectedVersion: `${saved.version}\n` }), { status: 400 });

  const disabled = reminders.update('assignee', { daysBefore: 0, onDueDate: false, overdue: false, expectedVersion: saved.version });
  assert.ok(disabled.version && disabled.version !== saved.version);
  saveIssue(store, 'other-today', { dueDate: '2026-11-21' });
  reminders.sweep();
  assert.equal(notifications.count('assignee'), 1);
});

test('deadline reminder receipts and read state survive reopening and native restore', t => {
  const { dir, store, reminders, notifications, createReminders } = fixture(t);
  saveIssue(store, 'same-day', { dueDate: '2026-11-21' });
  const settings = reminders.update('assignee', preferences);
  notifications.notify({
    recipientIds: ['assignee'], actorId: 'teammate', kind: 'issue-assigned', projectId: 'project',
    targetId: 'same-day', targetLabel: '동일한 업무', createdAt: initialTime,
  });
  const reminderId = notifications.all()[0].id;
  assert.equal(notifications.markRead('assignee', reminderId), true);
  const receiptBackup = notifications.all();
  const settingsBackup = reminders.all();
  const reopenedStore = new Store(dir);
  try {
    const reopenedNotifications = new NotificationsService(reopenedStore);
    const reopenedReminders = createReminders(reopenedStore, reopenedNotifications);
    reopenedReminders.sweep();
    assert.deepEqual(reopenedNotifications.all(), receiptBackup);
    reopenedStore.transaction(() => {
      reopenedNotifications.restore(receiptBackup, users);
      reopenedReminders.restore(settingsBackup, users);
    });
    reopenedReminders.sweep();
    assert.deepEqual(reopenedNotifications.all(), receiptBackup);
    assert.equal(reopenedNotifications.count('assignee'), 1);
    const restored = reopenedReminders.get('assignee');
    assert.notEqual(restored.version, settings.version);
    assert.deepEqual({ ...restored, version: settings.version }, settings);

    const [reminder, humanNotice] = receiptBackup;
    for (const invalid of [
      [{ ...reminder, actorId: 'teammate' }, humanNotice], [reminder, { ...humanNotice, actorId: null }],
      [{ ...reminder, id: 'bad-receipt' }, humanNotice], [{ ...reminder, detail: '목표 마감일 2026-02-30' }, humanNotice],
    ]) {
      assert.throws(() => reopenedStore.transaction(() => reopenedNotifications.restore(invalid, users)), TeamNotificationError);
      assert.deepEqual(reopenedNotifications.all(), receiptBackup);
    }
    for (const invalid of [
      [...settingsBackup, ...settingsBackup], [{ ...settingsBackup[0], userId: 'unknown' }],
      [{ ...settingsBackup[0], version: null }], [{ ...settingsBackup[0], daysBefore: 15 }],
    ]) {
      assert.throws(() => reopenedStore.transaction(() => reopenedReminders.restore(invalid, users)), DeadlineReminderError);
      assert.deepEqual(reopenedReminders.get('assignee'), restored);
    }
  } finally { reopenedStore.db.close(); }
});
