import { COMMON_DOCUMENT_NOTIFICATION_SPACE_ID, PROJECT_DOCUMENT_NOTIFICATION_SPACE_PREFIX,
  type NotificationSubscription, type NotificationSubscriptionState, type NotificationSubscriptionTarget } from '../shared/types.js';
import type { Store } from './store.js';

type SubscriptionReferences = { users: Set<string>; issueIds: Set<string>; documentIds: Set<string>; projectIds: Set<string> };

const INSERT = 'INSERT INTO notification_subscriptions(target_type,target_id,user_id) VALUES(?,?,?)';
const SUBSCRIPTIONS_TABLE = `CREATE TABLE IF NOT EXISTS notification_subscriptions (
  target_type TEXT NOT NULL CHECK(target_type IN ('issue','document','project','space')),
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(target_type,target_id,user_id)
)`;

export function documentNotificationSpaceProject(targetId: string): string | null | undefined {
  if (targetId === COMMON_DOCUMENT_NOTIFICATION_SPACE_ID) return null;
  if (targetId.startsWith(PROJECT_DOCUMENT_NOTIFICATION_SPACE_PREFIX)) {
    return targetId.slice(PROJECT_DOCUMENT_NOTIFICATION_SPACE_PREFIX.length) || undefined;
  }
}

function targetIsInBackup(targetType: unknown, targetId: string, refs: SubscriptionReferences, scoped: boolean): targetType is NotificationSubscriptionTarget {
  if (targetType === 'issue') return refs.issueIds.has(targetId);
  if (targetType === 'document') return refs.documentIds.has(targetId);
  if (!scoped) return false;
  if (targetType === 'project') return refs.projectIds.has(targetId);
  if (targetType !== 'space') return false;
  const projectId = documentNotificationSpaceProject(targetId);
  return projectId === null || projectId !== undefined && refs.projectIds.has(projectId);
}

export class NotificationSubscriptionError extends Error {
  readonly status = 400;
}

export class NotificationSubscriptionsService {
  constructor(private readonly store: Store) {
    // Targets can be in either the active tables or the trash during a subscription's lifetime.
    store.transaction(() => {
      const table = store.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='notification_subscriptions'").get() as {sql: string} | undefined;
      if (table && !table.sql.includes("'space'")) {
        store.db.exec(`ALTER TABLE notification_subscriptions RENAME TO previous_notification_subscriptions;
          ${SUBSCRIPTIONS_TABLE};
          INSERT INTO notification_subscriptions(target_type,target_id,user_id)
            SELECT target_type,target_id,user_id FROM previous_notification_subscriptions;
          DROP TABLE previous_notification_subscriptions;`);
      } else {
        store.db.exec(SUBSCRIPTIONS_TABLE);
      }
      store.db.exec('CREATE INDEX IF NOT EXISTS notification_subscriptions_user ON notification_subscriptions(user_id)');
    });
  }

  isSubscribed(userId: string, targetType: NotificationSubscriptionTarget, targetId: string): boolean {
    return this.store.db.prepare('SELECT 1 FROM notification_subscriptions WHERE target_type=? AND target_id=? AND user_id=?')
      .get(targetType, targetId, userId) !== undefined;
  }

  setSubscribed(userId: string, targetType: NotificationSubscriptionTarget, targetId: string, subscribed: boolean): NotificationSubscriptionState {
    const sql = subscribed
      ? `${INSERT} ON CONFLICT(target_type,target_id,user_id) DO NOTHING`
      : 'DELETE FROM notification_subscriptions WHERE target_type=? AND target_id=? AND user_id=?';
    this.store.db.prepare(sql).run(targetType, targetId, userId);
    return { subscribed };
  }

  recipients(targetType: NotificationSubscriptionTarget, targetId: string): string[] {
    const rows = this.store.db.prepare('SELECT user_id FROM notification_subscriptions WHERE target_type=? AND target_id=? ORDER BY user_id')
      .all(targetType, targetId) as {user_id: string}[];
    return rows.map(row => row.user_id);
  }

  activeIssueIds(userId: string): string[] {
    const rows = this.store.db.prepare(`SELECT subscription.target_id FROM notification_subscriptions AS subscription
      JOIN issues AS issue ON issue.id=subscription.target_id
      WHERE subscription.user_id=? AND subscription.target_type='issue' ORDER BY subscription.target_id`).all(userId);
    return rows.map(row => String(row.target_id));
  }

  removeTarget(targetType: NotificationSubscriptionTarget, targetId: string): void {
    this.store.db.prepare('DELETE FROM notification_subscriptions WHERE target_type=? AND target_id=?').run(targetType, targetId);
  }

  all(): NotificationSubscription[] {
    const rows = this.store.db.prepare(`SELECT user_id AS userId,target_type AS targetType,target_id AS targetId
      FROM notification_subscriptions ORDER BY target_type,target_id,user_id`).all() as unknown as NotificationSubscription[];
    return rows.map(({userId, targetType, targetId}) => ({userId, targetType, targetId}));
  }

  /** Replace subscriptions inside the same transaction that restores their users and targets. */
  restore(raw: unknown, refs: SubscriptionReferences, scoped: boolean): void {
    if (!Array.isArray(raw)) throw new NotificationSubscriptionError('백업의 알림 구독 목록을 확인해 주세요.');
    const seen = new Set<string>();
    const rows = Array.from(raw, (value: unknown): NotificationSubscription => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) {
        throw new NotificationSubscriptionError('알림 구독 데이터 형식을 확인해 주세요.');
      }
      const {userId, targetType, targetId} = value as Record<string, unknown>;
      if (typeof userId !== 'string' || !userId || !refs.users.has(userId) ||
          typeof targetId !== 'string' || !targetId || !targetIsInBackup(targetType, targetId, refs, scoped)) {
        throw new NotificationSubscriptionError('알림 구독의 팀원과 대상을 확인해 주세요.');
      }
      const key = JSON.stringify([targetType, targetId, userId]);
      if (seen.has(key)) throw new NotificationSubscriptionError('백업에 중복된 알림 구독이 있습니다.');
      seen.add(key);
      return {userId, targetType, targetId};
    });
    this.store.db.exec('DELETE FROM notification_subscriptions');
    const insert = this.store.db.prepare(INSERT);
    for (const row of rows) insert.run(row.targetType, row.targetId, row.userId);
  }
}
