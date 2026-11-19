import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TeamNotification } from '../../shared/types.js';
import { NotificationsService, TeamNotificationError } from '../../server/notifications.js';
import { Store } from '../../server/store.js';

const users = new Set(['actor', 'recipient', 'teammate']);
const event = {
  actorId: 'actor', kind: 'issue-assigned', projectId: 'project',
  targetId: 'legacy ticket', targetLabel: 'LEG-1 오래된\n제목', createdAt: '2026-11-19T00:00:00.000Z',
} as const;
const rowIds = (rows: TeamNotification[]) => rows.map(row => row.id);

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-notifications-'));
  const store = new Store(dir);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const id of users) store.put('users', { id, email: `${id}@example.test` });
  return { store, notifications: new NotificationsService(store), dir };
}

test('notifications keep the action transaction, isolate recipients, and page in stable insertion order', t => {
  const {store, notifications} = fixture(t);
  assert.throws(() => store.transaction(() => {
    notifications.notify({ ...event, recipientIds: ['recipient', 'teammate'] });
    throw new Error('rejected action');
  }), /rejected action/);
  assert.equal(notifications.all().length, 0);

  store.transaction(() => {
    notifications.notify({ ...event, recipientIds: ['recipient', 'actor', 'recipient', 'teammate', null] });
    for (let index = 1; index < 55; index++) {
      notifications.notify({ ...event, recipientIds: ['recipient'], targetLabel: `합성 업무 ${index}` });
    }
  });
  assert.equal(notifications.count('actor'), 0);
  assert.equal(notifications.count('teammate'), 1);
  const first = notifications.list('recipient', 'unread');
  assert.equal(first.items.length, 50);
  assert.equal(first.unreadCount, 55);
  assert.equal(first.items[0].targetLabel, '합성 업무 54');
  const second = notifications.list('recipient', 'all', first.nextCursor!);
  assert.deepEqual(second.items.map(row => row.targetLabel), ['합성 업무 4', '합성 업무 3', '합성 업무 2', '합성 업무 1', event.targetLabel]);
  assert.equal(second.nextCursor, null);
  const other = notifications.list('teammate', 'all').items[0].id;
  assert.throws(() => notifications.list('recipient', 'all', other), TeamNotificationError);
  assert.equal(notifications.markRead('recipient', other), false);
  assert.equal(notifications.markAllRead('recipient', other), false);

  notifications.notify({ ...event, recipientIds: ['recipient'], targetLabel: '읽음 처리 직전에 도착' });
  assert.equal(notifications.markAllRead('recipient', first.items[0].id), true);
  assert.equal(notifications.markAllRead('recipient', first.items[0].id), true);
  assert.equal(notifications.count('teammate'), 1);
  const unread = notifications.list('recipient', 'unread');
  assert.equal(unread.unreadCount, 1);
  assert.equal(unread.items[0].targetLabel, '읽음 처리 직전에 도착');
  assert.equal(notifications.markRead('recipient', unread.items[0].id), true);
  const readAt = notifications.list('recipient', 'all').items[0].readAt;
  assert.ok(readAt && readAt >= event.createdAt);
  assert.equal(notifications.markRead('recipient', unread.items[0].id), true);
  assert.equal(notifications.list('recipient', 'all').items[0].readAt, readAt);
});

test('notification restore preserves read state and deleted target references while rejecting invalid rows atomically', t => {
  const {store, notifications, dir} = fixture(t);
  store.transaction(() => {
    notifications.notify({ ...event, recipientIds: ['recipient'] });
    notifications.notify({ ...event, recipientIds: ['recipient'], kind: 'document-comment', projectId: null });
  });
  notifications.markRead('recipient', notifications.all()[0].id);
  const backup = JSON.parse(JSON.stringify(notifications.all())) as TeamNotification[];
  const expected = rowIds(notifications.list('recipient', 'all').items);
  const reopenedStore = new Store(dir);
  try {
    const reopened = new NotificationsService(reopenedStore);
    assert.deepEqual(rowIds(reopened.list('recipient', 'all').items), expected);
    assert.equal(reopened.count('recipient'), 1);
  } finally { reopenedStore.db.close(); }
  for (const bad of [
    [backup[0], { ...backup[1], id: backup[0].id }],
    [backup[0], { ...backup[1], actorId: 'missing' }],
    [backup[0], { ...backup[1], readAt: '2026-11-18T00:00:00.000Z' }],
  ]) {
    assert.throws(() => store.transaction(() => notifications.restore(bad, users)), TeamNotificationError);
    assert.deepEqual(rowIds(notifications.list('recipient', 'all').items), expected);
  }
  store.transaction(() => notifications.restore([], users));
  assert.equal(notifications.all().length, 0);
  store.transaction(() => notifications.restore(backup, users));
  assert.deepEqual(JSON.parse(JSON.stringify(notifications.all())), backup);
  assert.deepEqual(rowIds(notifications.list('recipient', 'all').items), expected);
  assert.equal(notifications.count('recipient'), 1);
});
