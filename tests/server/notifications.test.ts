import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ISSUE_RISK_NOTIFICATION_KINDS, type Comment, type TeamNotification } from '../../shared/types.js';
import { NotificationsService, TeamNotificationError } from '../../server/notifications.js';
import { Store } from '../../server/store.js';

const users = new Set(['actor', 'recipient', 'teammate']);
const event = {
  actorId: 'actor', kind: 'issue-assigned', projectId: 'project',
  targetId: 'legacy ticket', targetLabel: 'LEG-1 오래된\n제목', createdAt: '2026-11-19T00:00:00.000Z',
} as const;
const rowIds = (rows: TeamNotification[]) => rows.map(row => row.id);

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-notifications-'));
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

test('upgrades the previous SQLite notification table in place and omits detail for existing rows', t => {
  const { store, dir } = fixture(t);
  store.db.exec(`
    DROP TABLE team_notifications;
    CREATE TABLE team_notifications (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, project_id TEXT, target_id TEXT NOT NULL, target_label TEXT NOT NULL,
      created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX team_notifications_recipient ON team_notifications(recipient_id,seq);
    CREATE INDEX team_notifications_unread ON team_notifications(recipient_id,seq) WHERE read_at IS NULL;
    CREATE INDEX team_notifications_actor ON team_notifications(actor_id);
  `);
  const legacy: TeamNotification = { ...event, id: 'existing-notice', recipientId: 'recipient', readAt: event.createdAt };
  store.db.prepare(`INSERT INTO team_notifications
    (seq,id,recipient_id,actor_id,kind,project_id,target_id,target_label,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(27, legacy.id, legacy.recipientId, legacy.actorId, legacy.kind, legacy.projectId, legacy.targetId,
      legacy.targetLabel, legacy.createdAt, legacy.readAt);

  const upgraded = new NotificationsService(store);
  assert.deepEqual(upgraded.all(), [legacy]);
  assert.equal(Object.hasOwn(upgraded.list('recipient', 'all').items[0], 'detail'), false);
  assert.deepEqual({ ...store.db.prepare('SELECT seq,detail FROM team_notifications WHERE id=?').get(legacy.id) }, { seq: 27, detail: null });
  assert.equal(store.db.prepare('PRAGMA table_info(team_notifications)').all().find(column => column.name === 'actor_id')?.notnull, 0);

  const reopenedStore = new Store(dir);
  try {
    const reopened = new NotificationsService(reopenedStore);
    reopened.notify({ ...event, kind: 'issue-block-added', detail: '외부 업무 LEG-2', recipientIds: ['recipient'] });
    assert.deepEqual(reopened.all()[0], legacy);
    assert.equal(reopened.list('recipient', 'unread').items[0].detail, '외부 업무 LEG-2');
  } finally { reopenedStore.db.close(); }
});

test('risk notification details survive restore and invalid or cross-kind details are rejected', t => {
  const { store, notifications } = fixture(t);
  const recipients = { recipientIds: ['recipient'] };
  notifications.notify({ ...event, ...recipients });
  const details = ['LEG-2 선행 검토', '선행 검토 완료', '가'.repeat(500)];
  ISSUE_RISK_NOTIFICATION_KINDS.forEach((kind, index) => {
    notifications.notify({ ...event, ...recipients, kind, detail: details[index] });
  });
  const unread = notifications.list('recipient', 'unread');
  assert.deepEqual(unread.items.slice(0, 3).map(row => row.detail), [...details].reverse());
  assert.equal(Object.hasOwn(unread.items[3], 'detail'), false);
  notifications.markRead('recipient', unread.items[0].id);
  const backup = notifications.all();
  store.transaction(() => notifications.restore(JSON.parse(JSON.stringify(backup)), users));
  assert.deepEqual(notifications.all(), backup);

  const [legacy, risk] = backup;
  const missing = { ...risk };
  delete missing.detail;
  for (const row of [missing, { ...legacy, detail: risk.detail }, { ...legacy, detail: null },
    ...[null, 42, '', ' ', '가'.repeat(501), '금지\u0000문자', '줄\n바꿈'].map(detail => ({ ...risk, detail }))]) {
    assert.throws(() => store.transaction(() => notifications.restore([row], users)), TeamNotificationError);
    assert.deepEqual(notifications.all(), backup);
  }
  assert.throws(() => notifications.notify({ ...event, ...recipients, kind: 'issue-block-resolved' }), TeamNotificationError);
  assert.throws(() => notifications.notify({ ...event, ...recipients, detail: '다른 알림의 상세 내용' }), TeamNotificationError);
  assert.deepEqual(notifications.all(), backup);
});

test('status notification details are optional, validated, and retained across backup restore', t => {
  const { store, notifications } = fixture(t);
  const status = { ...event, kind: 'issue-status-changed', recipientIds: ['recipient'] } satisfies Parameters<NotificationsService['notify']>[0];
  notifications.notify(status);
  notifications.notify({ ...status, detail: '할 일 → 진행 중' });
  const [legacy, updated] = notifications.all();
  notifications.markRead('recipient', updated.id);
  const backup = notifications.all();
  assert.equal(Object.hasOwn(legacy, 'detail'), false);
  assert.equal(updated.detail, '할 일 → 진행 중');

  for (const detail of [null, '', ' ', '가'.repeat(501), '할 일\n진행 중']) {
    assert.throws(() => store.transaction(() => notifications.restore([{ ...updated, detail }], users)), TeamNotificationError);
  }
  assert.throws(() => notifications.notify({ ...status, detail: '할 일\n진행 중' }), TeamNotificationError);
  assert.throws(() => notifications.notify({ ...status, kind: 'issue-comment', detail: updated.detail }), TeamNotificationError);
  assert.deepEqual(notifications.all(), backup);

  store.transaction(() => notifications.restore([], users));
  store.transaction(() => notifications.restore(JSON.parse(JSON.stringify(backup)), users));
  assert.deepEqual(notifications.all(), backup);
});

test('ordinary issue comment anchors validate existing comments and keep receipts after deletion', t => {
  const { store, notifications } = fixture(t);
  const ordinary = { ...event, kind: 'issue-comment', recipientIds: ['recipient'] } satisfies Parameters<NotificationsService['notify']>[0];
  const comment = {
    id: 'saved-comment', resourceType: 'issue', resourceId: ordinary.targetId, authorId: ordinary.actorId,
    body: '확인했습니다.', createdAt: ordinary.createdAt,
  } satisfies Comment;
  notifications.notify(ordinary);
  notifications.notify({ ...ordinary, commentId: comment.id });
  const backup = notifications.all();
  const [legacy, anchored] = backup;
  assert.equal(Object.hasOwn(legacy, 'commentId'), false);
  assert.equal(anchored.commentId, comment.id);

  const available = (value: Comment) => new Map([[comment.id, value]]);
  for (const mismatched of [
    { ...comment, resourceId: 'other issue' },
    { ...comment, resourceType: 'document' } as const,
    { ...comment, authorId: 'teammate' },
  ]) {
    assert.throws(() => store.transaction(() => notifications.restore([anchored], users, available(mismatched))), TeamNotificationError);
  }
  for (const bad of [{ ...anchored, commentId: '' }, { ...anchored, commentId: null }, { ...anchored, kind: 'document-comment' },
    { ...anchored, kind: 'issue-comment-mentioned' }, { ...legacy, kind: 'issue-comment-mentioned' }]) {
    assert.throws(() => store.transaction(() => notifications.restore([bad], users, available(comment))), TeamNotificationError);
  }
  assert.throws(() => notifications.notify({ ...ordinary, kind: 'issue-status-changed', commentId: comment.id }), TeamNotificationError);
  assert.throws(() => notifications.notify({ ...ordinary, kind: 'document-comment-reply', projectId: null }), TeamNotificationError);
  assert.deepEqual(notifications.all(), backup);

  for (const comments of [available(comment), new Map<string, Comment>()]) {
    store.transaction(() => notifications.restore([], users));
    store.transaction(() => notifications.restore(JSON.parse(JSON.stringify(backup)), users, comments));
    assert.deepEqual(notifications.all(), backup);
  }
});
