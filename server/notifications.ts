import { randomUUID } from 'node:crypto';
import { ISSUE_RISK_NOTIFICATION_KINDS, TEAM_NOTIFICATION_KINDS } from '../shared/types.js';
import type { TeamNotification, TeamNotificationFilter, TeamNotificationPage } from '../shared/types.js';
import type { Store } from './store.js';

const PAGE_SIZE = 50;
const LABEL_LIMIT = 500;
export const MAX_NOTIFICATION_DETAIL_LENGTH = 500;
const KINDS: ReadonlySet<string> = new Set(TEAM_NOTIFICATION_KINDS);
const DETAIL_KINDS: ReadonlySet<string> = new Set(ISSUE_RISK_NOTIFICATION_KINDS);
const COLUMNS = `id,recipient_id AS recipientId,actor_id AS actorId,kind,project_id AS projectId,
  target_id AS targetId,target_label AS targetLabel,created_at AS createdAt,read_at AS readAt,detail`;
const INSERT = `INSERT INTO team_notifications
  (id,recipient_id,actor_id,kind,project_id,target_id,target_label,created_at,read_at,detail) VALUES(?,?,?,?,?,?,?,?,?,?)`;
const RESTORE_FIELDS = new Set(['id', 'recipientId', 'actorId', 'kind', 'projectId', 'targetId', 'targetLabel', 'createdAt', 'readAt', 'detail']);

export class TeamNotificationError extends Error {
  readonly status = 400;
}

type NewNotification = Omit<TeamNotification, 'id' | 'recipientId' | 'readAt'> & {
  recipientIds: (string | null | undefined)[];
};
type StoredNotification = Omit<TeamNotification, 'detail'> & { detail: string | null };

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function validateDetail(kind: string, detail: unknown, present: boolean): string | null {
  if (DETAIL_KINDS.has(kind)) {
    if (present && typeof detail === 'string' && detail.trim() && detail.length <= MAX_NOTIFICATION_DETAIL_LENGTH && !/\p{Cc}/u.test(detail)) return detail;
  } else if (!present) {
    return null;
  }
  throw new TeamNotificationError('알림 종류에 맞는 상세 내용을 입력해 주세요.');
}

function publicNotification({ detail, ...row }: StoredNotification): TeamNotification {
  return detail === null ? row : { ...row, detail };
}

function restoreRow(value: unknown, users: Set<string>): TeamNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamNotificationError('알림 데이터 형식을 확인해 주세요.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !RESTORE_FIELDS.has(field)) ||
    !nonempty(row.id) || row.id.length > 200 || row.id.trim() !== row.id || !nonempty(row.recipientId) || !users.has(row.recipientId) ||
    !nonempty(row.actorId) || !users.has(row.actorId) || row.recipientId === row.actorId ||
    typeof row.kind !== 'string' || !KINDS.has(row.kind) ||
    (row.projectId !== null && !nonempty(row.projectId)) || (row.kind.startsWith('issue-') && row.projectId === null) ||
    !nonempty(row.targetId) || !nonempty(row.targetLabel) || row.targetLabel.length > LABEL_LIMIT ||
    !timestamp(row.createdAt) || (row.readAt !== null && (!timestamp(row.readAt) || row.readAt < row.createdAt))) {
    throw new TeamNotificationError('알림 종류·팀원·대상·시간을 확인해 주세요.');
  }
  validateDetail(row.kind, row.detail, Object.hasOwn(row, 'detail'));
  return row as unknown as TeamNotification;
}

export class NotificationsService {
  constructor(private readonly store: Store) {
    store.transaction(() => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS team_notifications (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          project_id TEXT,
          target_id TEXT NOT NULL,
          target_label TEXT NOT NULL,
          created_at TEXT NOT NULL,
          read_at TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS team_notifications_recipient ON team_notifications(recipient_id,seq);
        CREATE INDEX IF NOT EXISTS team_notifications_unread ON team_notifications(recipient_id,seq) WHERE read_at IS NULL;
        CREATE INDEX IF NOT EXISTS team_notifications_actor ON team_notifications(actor_id);
      `);
      const columns = store.db.prepare('PRAGMA table_info(team_notifications)').all();
      if (!columns.some(column => column.name === 'detail')) {
        store.db.exec('ALTER TABLE team_notifications ADD COLUMN detail TEXT');
      }
    });
  }

  /** The caller commits notifications in the same transaction as the action. */
  notify(input: NewNotification): void {
    const recipients = new Set(input.recipientIds.filter((id): id is string => nonempty(id) && id !== input.actorId));
    if (!recipients.size) return;
    const insert = this.store.db.prepare(INSERT);
    const targetLabel = input.targetLabel.slice(0, LABEL_LIMIT);
    const detail = validateDetail(input.kind, input.detail, input.detail !== undefined);
    for (const id of recipients) {
      insert.run(randomUUID(), id, input.actorId, input.kind, input.projectId, input.targetId, targetLabel, input.createdAt, null, detail);
    }
  }

  list(recipientId: string, filter: TeamNotificationFilter, before?: string): TeamNotificationPage {
    const params: (string | number)[] = [recipientId];
    if (before !== undefined) {
      const cursor = this.store.db.prepare('SELECT seq FROM team_notifications WHERE recipient_id=? AND id=?')
        .get(recipientId, before) as {seq: number} | undefined;
      if (!cursor) throw new TeamNotificationError('알림 목록이 변경되었습니다. 처음부터 다시 불러와 주세요.');
      params.push(cursor.seq);
    }
    params.push(PAGE_SIZE + 1);
    const rows = this.store.db.prepare(`SELECT ${COLUMNS} FROM team_notifications WHERE recipient_id=?
      ${filter === 'unread' ? 'AND read_at IS NULL' : ''} ${before === undefined ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT ?`)
      .all(...params) as unknown as StoredNotification[];
    const items = rows.slice(0, PAGE_SIZE).map(publicNotification);
    return {items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].id : null, unreadCount: this.count(recipientId)};
  }

  count(recipientId: string): number {
    const row = this.store.db.prepare('SELECT count(*) AS unread FROM team_notifications WHERE recipient_id=? AND read_at IS NULL')
      .get(recipientId) as {unread: number};
    return row.unread;
  }

  markRead(recipientId: string, id: string): boolean {
    const result = this.store.db.prepare(`UPDATE team_notifications SET read_at=coalesce(read_at,max(created_at,?))
      WHERE recipient_id=? AND id=?`).run(new Date().toISOString(), recipientId, id);
    return result.changes !== 0;
  }

  markAllRead(recipientId: string, throughId: string): boolean {
    // Including an already-read cutoff row distinguishes an idempotent retry from a missing cutoff.
    const result = this.store.db.prepare(`UPDATE team_notifications SET read_at=coalesce(read_at,max(created_at,?))
      WHERE recipient_id=? AND seq <= (SELECT seq FROM team_notifications WHERE recipient_id=? AND id=?)
        AND (read_at IS NULL OR id=?)`).run(new Date().toISOString(), recipientId, recipientId, throughId, throughId);
    return result.changes !== 0;
  }

  all(): TeamNotification[] {
    const rows = this.store.db.prepare(`SELECT ${COLUMNS} FROM team_notifications ORDER BY seq`).all() as unknown as StoredNotification[];
    return rows.map(publicNotification);
  }

  /** Restoring oldest-first preserves insertion order and all read state. */
  restore(raw: unknown, users: Set<string>): void {
    if (!Array.isArray(raw)) throw new TeamNotificationError('백업의 알림 목록을 확인해 주세요.');
    const seen = new Set<string>();
    const rows = Array.from(raw, value => {
      const row = restoreRow(value, users);
      if (seen.has(row.id)) throw new TeamNotificationError('백업에 중복된 알림 ID가 있습니다.');
      seen.add(row.id);
      return row;
    });
    this.store.db.exec('DELETE FROM team_notifications');
    const insert = this.store.db.prepare(INSERT);
    for (const row of rows) insert.run(row.id, row.recipientId, row.actorId, row.kind, row.projectId, row.targetId, row.targetLabel, row.createdAt, row.readAt, row.detail ?? null);
  }
}
