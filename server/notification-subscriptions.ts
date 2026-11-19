import type { NotificationSubscription, NotificationSubscriptionState, NotificationSubscriptionTarget } from '../shared/types.js';
import type { Store } from './store.js';

type SubscriptionReferences = { users: Set<string>; issueIds: Set<string>; documentIds: Set<string> };

const INSERT = 'INSERT INTO notification_subscriptions(target_type,target_id,user_id) VALUES(?,?,?)';

export class NotificationSubscriptionError extends Error {
  readonly status = 400;
}

export class NotificationSubscriptionsService {
  constructor(private readonly store: Store) {
    // Targets can be in either the active tables or the trash during a subscription's lifetime.
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_subscriptions (
        target_type TEXT NOT NULL CHECK(target_type IN ('issue','document')),
        target_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(target_type,target_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS notification_subscriptions_user ON notification_subscriptions(user_id);
    `);
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

  removeTarget(targetType: NotificationSubscriptionTarget, targetId: string): void {
    this.store.db.prepare('DELETE FROM notification_subscriptions WHERE target_type=? AND target_id=?').run(targetType, targetId);
  }

  all(): NotificationSubscription[] {
    const rows = this.store.db.prepare(`SELECT user_id AS userId,target_type AS targetType,target_id AS targetId
      FROM notification_subscriptions ORDER BY target_type,target_id,user_id`).all() as unknown as NotificationSubscription[];
    return rows.map(({userId, targetType, targetId}) => ({userId, targetType, targetId}));
  }

  /** Replace subscriptions inside the same transaction that restores their users and targets. */
  restore(raw: unknown, refs: SubscriptionReferences): void {
    if (!Array.isArray(raw)) throw new NotificationSubscriptionError('백업의 알림 구독 목록을 확인해 주세요.');
    const seen = new Set<string>();
    const rows = Array.from(raw, (value: unknown): NotificationSubscription => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) {
        throw new NotificationSubscriptionError('알림 구독 데이터 형식을 확인해 주세요.');
      }
      const {userId, targetType, targetId} = value as Record<string, unknown>;
      if (typeof userId !== 'string' || !userId || !refs.users.has(userId) ||
          (targetType !== 'issue' && targetType !== 'document') || typeof targetId !== 'string' || !targetId ||
          !(targetType === 'issue' ? refs.issueIds : refs.documentIds).has(targetId)) {
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
