import { createHash, randomUUID } from 'node:crypto';
import { isCalendarDate } from '../shared/calendar.js';
import { COMMENT_MENTION_NOTIFICATION_KINDS, INTAKE_NOTIFICATION_KIND_BY_STATUS, isIntakeNotificationKind,
  ISSUE_DEADLINE_REMINDER_KINDS, ISSUE_RISK_NOTIFICATION_KINDS, TEAM_NOTIFICATION_KINDS } from '../shared/types.js';
import type { Comment, IssueIntakeRequest, TeamNotification, TeamNotificationFilter, TeamNotificationInboxChange, TeamNotificationPage } from '../shared/types.js';
import type { Store } from './store.js';

const PAGE_SIZE = 50;
const LABEL_LIMIT = 500;
export const MAX_NOTIFICATION_DETAIL_LENGTH = 500;
const KINDS: ReadonlySet<string> = new Set(TEAM_NOTIFICATION_KINDS);
const DEADLINE_KINDS: ReadonlySet<string> = new Set(ISSUE_DEADLINE_REMINDER_KINDS);
const COMMENT_MENTION_KINDS: ReadonlySet<string> = new Set(COMMENT_MENTION_NOTIFICATION_KINDS);
const ISSUE_COMMENT_KIND = 'issue-comment';
const COMMENT_REPLY_KIND = 'document-comment-reply';
const REQUIRED_DETAIL_KINDS: ReadonlySet<string> = new Set([...ISSUE_RISK_NOTIFICATION_KINDS, ...ISSUE_DEADLINE_REMINDER_KINDS]);
const COLUMNS = `id,recipient_id AS recipientId,actor_id AS actorId,kind,project_id AS projectId,
  target_id AS targetId,target_label AS targetLabel,created_at AS createdAt,read_at AS readAt,detail,comment_id AS commentId,archived_at AS archivedAt`;
const INSERT = `INSERT INTO team_notifications
  (id,recipient_id,actor_id,kind,project_id,target_id,target_label,created_at,read_at,detail,comment_id,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS team_notifications (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  project_id TEXT,
  target_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  detail TEXT,
  comment_id TEXT,
  archived_at TEXT
)`;
const RESTORE_FIELDS = new Set(['id', 'recipientId', 'actorId', 'kind', 'projectId', 'targetId', 'targetLabel', 'createdAt', 'readAt', 'detail', 'commentId', 'archivedAt']);

export class TeamNotificationError extends Error {
  readonly status = 400;
}

type NewNotification = Omit<TeamNotification, 'actorId' | 'id' | 'recipientId' | 'readAt' | 'archivedAt'> & {
  actorId: string;
  recipientIds: (string | null | undefined)[];
};
type DeadlineKind = typeof ISSUE_DEADLINE_REMINDER_KINDS[number];
type NewDeadlineReminder = Pick<TeamNotification, 'recipientId' | 'targetId' | 'targetLabel' | 'createdAt'> & {
  kind: DeadlineKind;
  projectId: string;
  deadline: { value: string; source: 'dueDate' | 'endDate' };
};
type StoredNotification = Omit<TeamNotification, 'detail' | 'commentId' | 'archivedAt'> & {
  detail: string | null; commentId: string | null; archivedAt: string | null;
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validId = (value: unknown): value is string => nonempty(value) && value.length <= 200 && value.trim() === value;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function reminderId(kind: string, recipientId: string, targetId: string, date: string): string {
  return createHash('sha256').update(JSON.stringify([kind, recipientId, targetId, date])).digest('hex');
}

function validateDetail(kind: string, detail: unknown, present: boolean): string | null {
  const required = REQUIRED_DETAIL_KINDS.has(kind);
  if (!present && !required) return null;
  if (present && (required || kind === 'issue-status-changed') && typeof detail === 'string' &&
    detail.trim() && detail.length <= MAX_NOTIFICATION_DETAIL_LENGTH && !/\p{Cc}/u.test(detail)) return detail;
  throw new TeamNotificationError('알림 종류에 맞는 상세 내용을 입력해 주세요.');
}

function validateCommentId(kind: string, commentId: unknown, present: boolean): string | null {
  const required = COMMENT_MENTION_KINDS.has(kind) || kind === COMMENT_REPLY_KIND;
  if (!present && !required) return null;
  if (present && (required || kind === ISSUE_COMMENT_KIND) && validId(commentId)) return commentId;
  throw new TeamNotificationError('댓글 알림의 댓글 ID를 확인해 주세요.');
}

function publicNotification({ detail, commentId, archivedAt, ...row }: StoredNotification): TeamNotification {
  return { ...row, ...(detail === null ? {} : { detail }), ...(commentId === null ? {} : { commentId }), ...(archivedAt === null ? {} : { archivedAt }) };
}

function restoreRow(value: unknown, users: Set<string>, comments?: ReadonlyMap<string, Comment>,
  intakeRequests?: ReadonlyMap<string, IssueIntakeRequest>): TeamNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamNotificationError('알림 데이터 형식을 확인해 주세요.');
  const row = value as Record<string, unknown>;
  const deadlineReminder = typeof row.kind === 'string' && DEADLINE_KINDS.has(row.kind);
  const validActor = deadlineReminder ? row.actorId === null :
    nonempty(row.actorId) && users.has(row.actorId) && row.recipientId !== row.actorId;
  if (Object.keys(row).some(field => !RESTORE_FIELDS.has(field)) ||
    !validId(row.id) || !nonempty(row.recipientId) || !users.has(row.recipientId) ||
    !validActor ||
    typeof row.kind !== 'string' || !KINDS.has(row.kind) ||
    (row.projectId !== null && !nonempty(row.projectId)) || (row.kind.startsWith('issue-') && row.projectId === null) ||
    !nonempty(row.targetId) || !nonempty(row.targetLabel) || row.targetLabel.length > LABEL_LIMIT ||
    !timestamp(row.createdAt) || (row.readAt !== null && (!timestamp(row.readAt) || row.readAt < row.createdAt)) ||
    (Object.hasOwn(row, 'archivedAt') && (!timestamp(row.archivedAt) || row.archivedAt < row.createdAt))) {
    throw new TeamNotificationError('알림 종류·팀원·대상·시간을 확인해 주세요.');
  }
  const detail = validateDetail(row.kind, row.detail, Object.hasOwn(row, 'detail'));
  const commentId = validateCommentId(row.kind, row.commentId, Object.hasOwn(row, 'commentId'));
  if (isIntakeNotificationKind(row.kind)) {
    const request = intakeRequests?.get(row.targetId);
    if (!request || request.status === 'pending' || INTAKE_NOTIFICATION_KIND_BY_STATUS[request.status] !== row.kind ||
        request.projectId !== row.projectId || request.reporterId !== row.recipientId || request.reviewerId !== row.actorId) {
      throw new TeamNotificationError('접수 결과 알림의 요청, 수신자와 검토자를 확인해 주세요.');
    }
  }
  if (commentId !== null) {
    const comment = comments?.get(commentId);
    // A receipt remains available after permanent deletion of its target comment.
    // A later edit can also remove the mention that generated the receipt.
    const wasEditedSinceNotification = comment?.editVersion !== undefined && timestamp(comment.editedAt) && row.createdAt <= comment.editedAt;
    if (comment && (comment.resourceType !== (row.kind.startsWith('issue-') ? 'issue' : 'document') ||
        comment.resourceId !== row.targetId || comment.authorId !== row.actorId ||
        (row.kind === COMMENT_REPLY_KIND && !comment.parentCommentId) ||
        (COMMENT_MENTION_KINDS.has(row.kind) && !wasEditedSinceNotification &&
          !comment.mentions?.some(mention => mention.userId === row.recipientId)))) {
      throw new TeamNotificationError('댓글 알림의 대상과 수신자를 확인해 주세요.');
    }
  }
  if (deadlineReminder) {
    const date = /^(?:목표 마감일|계획 종료일) (\d{4}-\d{2}-\d{2})$/u.exec(detail ?? '')?.[1];
    if (!isCalendarDate(date) || row.id !== reminderId(row.kind, row.recipientId, row.targetId, date)) {
      throw new TeamNotificationError('기한 알림의 날짜와 식별자를 확인해 주세요.');
    }
  }
  return row as unknown as TeamNotification;
}

export class NotificationsService {
  constructor(private readonly store: Store) {
    store.transaction(() => {
      store.db.exec(CREATE_TABLE);
      const columns = store.db.prepare('PRAGMA table_info(team_notifications)').all();
      if (!columns.some(column => column.name === 'detail')) {
        store.db.exec('ALTER TABLE team_notifications ADD COLUMN detail TEXT');
      }
      if (!columns.some(column => column.name === 'comment_id')) {
        store.db.exec('ALTER TABLE team_notifications ADD COLUMN comment_id TEXT');
      }
      if (!columns.some(column => column.name === 'archived_at')) {
        store.db.exec('ALTER TABLE team_notifications ADD COLUMN archived_at TEXT');
      }
      if (columns.find(column => column.name === 'actor_id')?.notnull === 1) {
        const fields = 'seq,id,recipient_id,actor_id,kind,project_id,target_id,target_label,created_at,read_at,detail,comment_id,archived_at';
        store.db.exec(`
          ALTER TABLE team_notifications RENAME TO previous_team_notifications;
          ${CREATE_TABLE};
          INSERT INTO team_notifications(${fields}) SELECT ${fields} FROM previous_team_notifications;
          DROP TABLE previous_team_notifications;
        `);
      }
      store.db.exec(`
        CREATE INDEX IF NOT EXISTS team_notifications_recipient ON team_notifications(recipient_id,seq);
        CREATE INDEX IF NOT EXISTS team_notifications_unread ON team_notifications(recipient_id,seq) WHERE read_at IS NULL;
        CREATE INDEX IF NOT EXISTS team_notifications_actor ON team_notifications(actor_id);
      `);
    });
  }

  /** The caller commits notifications in the same transaction as the action. */
  notify(input: NewNotification): void {
    if (!nonempty(input.actorId) || DEADLINE_KINDS.has(input.kind)) {
      throw new TeamNotificationError('알림에 실제 작업자가 필요합니다.');
    }
    const recipients = new Set(input.recipientIds.filter((id): id is string => nonempty(id) && id !== input.actorId));
    if (!recipients.size) return;
    const insert = this.store.db.prepare(INSERT);
    const targetLabel = input.targetLabel.slice(0, LABEL_LIMIT);
    const detail = validateDetail(input.kind, input.detail, input.detail !== undefined);
    const commentId = validateCommentId(input.kind, input.commentId, input.commentId !== undefined);
    for (const id of recipients) {
      insert.run(randomUUID(), id, input.actorId, input.kind, input.projectId, input.targetId, targetLabel, input.createdAt, null, detail, commentId, null);
    }
  }

  /** A delivered reminder is also its persisted receipt, including in native backups. */
  notifyDeadline(input: NewDeadlineReminder): void {
    const { kind, recipientId, projectId, targetId, targetLabel, deadline, createdAt } = input;
    if (!DEADLINE_KINDS.has(kind) || !isCalendarDate(deadline.value)) {
      throw new TeamNotificationError('업무 기한 알림의 종류와 날짜를 확인해 주세요.');
    }
    const detail = `${deadline.source === 'dueDate' ? '목표 마감일' : '계획 종료일'} ${deadline.value}`;
    this.store.db.prepare(`${INSERT} ON CONFLICT(id) DO NOTHING`).run(
      reminderId(kind, recipientId, targetId, deadline.value), recipientId, null, kind, projectId, targetId,
      targetLabel.slice(0, LABEL_LIMIT), createdAt, null, detail, null, null,
    );
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
    const archiveCondition = filter === 'archived' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
    const rows = this.store.db.prepare(`SELECT ${COLUMNS} FROM team_notifications WHERE recipient_id=? AND ${archiveCondition}
      ${filter === 'unread' ? 'AND read_at IS NULL' : ''} ${before === undefined ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT ?`)
      .all(...params) as unknown as StoredNotification[];
    const items = rows.slice(0, PAGE_SIZE).map(publicNotification);
    return {items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].id : null, unreadCount: this.count(recipientId)};
  }

  count(recipientId: string): number {
    const row = this.store.db.prepare('SELECT count(*) AS unread FROM team_notifications WHERE recipient_id=? AND read_at IS NULL AND archived_at IS NULL')
      .get(recipientId) as {unread: number};
    return row.unread;
  }

  markRead(recipientId: string, id: string): boolean {
    const result = this.store.db.prepare(`UPDATE team_notifications SET read_at=coalesce(read_at,max(created_at,?))
      WHERE recipient_id=? AND id=?`).run(new Date().toISOString(), recipientId, id);
    return result.changes !== 0;
  }

  markAllRead(recipientId: string, throughId: string): boolean {
    const cutoff = this.store.db.prepare('SELECT seq FROM team_notifications WHERE recipient_id=? AND id=?').get(recipientId, throughId);
    if (!cutoff) return false;
    this.store.db.prepare(`UPDATE team_notifications SET read_at=max(created_at,?)
      WHERE recipient_id=? AND seq <= ? AND read_at IS NULL AND archived_at IS NULL`)
      .run(new Date().toISOString(), recipientId, cutoff.seq);
    return true;
  }

  changeInbox(recipientId: string, id: string, change: TeamNotificationInboxChange): { item: TeamNotification; unreadCount: number } | null {
    const field = 'archived' in change ? 'archived_at' : 'read_at';
    const enabled = 'archived' in change ? change.archived : change.read;
    const row = this.store.db.prepare(`UPDATE team_notifications
      SET ${field}=CASE WHEN ? THEN coalesce(${field},max(created_at,?)) ELSE NULL END
      WHERE recipient_id=? AND id=? RETURNING ${COLUMNS}`)
      .get(Number(enabled), new Date().toISOString(), recipientId, id) as StoredNotification | undefined;
    return row ? { item: publicNotification(row), unreadCount: this.count(recipientId) } : null;
  }

  all(): TeamNotification[] {
    const rows = this.store.db.prepare(`SELECT ${COLUMNS} FROM team_notifications ORDER BY seq`).all() as unknown as StoredNotification[];
    return rows.map(publicNotification);
  }

  /** Restoring oldest-first preserves insertion order and all read state. */
  restore(raw: unknown, users: Set<string>, comments?: ReadonlyMap<string, Comment>,
    intakeRequests?: ReadonlyMap<string, IssueIntakeRequest>): void {
    if (!Array.isArray(raw)) throw new TeamNotificationError('백업의 알림 목록을 확인해 주세요.');
    const seen = new Set<string>();
    const intakeTargets = new Set<string>();
    const rows = Array.from(raw, value => {
      const row = restoreRow(value, users, comments, intakeRequests);
      if (seen.has(row.id)) throw new TeamNotificationError('백업에 중복된 알림 ID가 있습니다.');
      seen.add(row.id);
      if (isIntakeNotificationKind(row.kind)) {
        if (intakeTargets.has(row.targetId)) throw new TeamNotificationError('백업에 중복된 접수 결과 알림이 있습니다.');
        intakeTargets.add(row.targetId);
      }
      return row;
    });
    this.store.db.exec('DELETE FROM team_notifications');
    const insert = this.store.db.prepare(INSERT);
    for (const row of rows) insert.run(row.id, row.recipientId, row.actorId, row.kind, row.projectId, row.targetId,
      row.targetLabel, row.createdAt, row.readAt, row.detail ?? null, row.commentId ?? null, row.archivedAt ?? null);
  }
}
