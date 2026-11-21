import { randomUUID } from 'node:crypto';
import { calendarDay } from '../shared/calendar.js';
import { issueDeadline } from '../shared/my-work.js';
import { reservationLocalDateTime } from '../shared/time-reservations.js';
import { MAX_DEADLINE_REMINDER_DAYS, type DeadlineReminderPreferenceRecord, type DeadlineReminderPreferences, type Issue } from '../shared/types.js';
import type { NotificationsService } from './notifications.js';
import type { Store } from './store.js';

const preferencesSelect = `SELECT user_id AS userId, days_before AS daysBefore,
  on_due_date AS onDueDate, overdue, version FROM deadline_reminder_preferences`;
const preferencesWrite = `INSERT INTO deadline_reminder_preferences
  (user_id, days_before, on_due_date, overdue, version) VALUES (?,?,?,?,?)
  ON CONFLICT(user_id) DO UPDATE SET days_before=excluded.days_before, on_due_date=excluded.on_due_date,
    overdue=excluded.overdue, version=excluded.version`;
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type PreferenceOptions = Omit<DeadlineReminderPreferences, 'version'>;
type StoredPreferences = Omit<DeadlineReminderPreferenceRecord, 'onDueDate' | 'overdue'> & { onDueDate: number; overdue: number };

export class DeadlineReminderError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) { super(message); }
}

function checkedFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new DeadlineReminderError(400, '업무 기한 알림 설정을 확인해 주세요.');
  }
  return value as Record<string, unknown>;
}

function readOptions({ daysBefore, onDueDate, overdue }: Record<string, unknown>): PreferenceOptions {
  if (typeof daysBefore !== 'number' || !Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > MAX_DEADLINE_REMINDER_DAYS ||
      typeof onDueDate !== 'boolean' || typeof overdue !== 'boolean') {
    throw new DeadlineReminderError(400, `업무 기한 알림은 0~${MAX_DEADLINE_REMINDER_DAYS}일과 당일·초과 여부를 지정해 주세요.`);
  }
  return { daysBefore, onDueDate, overdue };
}

function readVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && versionPattern.test(value);
}

function fromStorage({ onDueDate, overdue, ...rest }: StoredPreferences): DeadlineReminderPreferenceRecord {
  return { ...rest, onDueDate: Boolean(onDueDate), overdue: Boolean(overdue) };
}

function reminderKind(days: number, preferences: PreferenceOptions) {
  if (days < 0) return preferences.overdue ? 'issue-deadline-overdue' : null;
  if (days === 0) return preferences.onDueDate ? 'issue-deadline-today' : null;
  return days <= preferences.daysBefore ? 'issue-deadline-upcoming' : null;
}

export class DeadlineRemindersService {
  constructor(
    private readonly store: Store,
    private readonly notifications: NotificationsService,
    private readonly terminal: (issue: Issue) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS deadline_reminder_preferences (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        days_before INTEGER NOT NULL CHECK(days_before BETWEEN 0 AND ${MAX_DEADLINE_REMINDER_DAYS}),
        on_due_date INTEGER NOT NULL CHECK(on_due_date IN (0,1)),
        overdue INTEGER NOT NULL CHECK(overdue IN (0,1)),
        version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issues_deadline_assignee ON issues(assignee_id) WHERE assignee_id IS NOT NULL;
    `);
  }

  get(userId: string): DeadlineReminderPreferences {
    const row = this.store.db.prepare(`${preferencesSelect} WHERE user_id=?`).get(userId) as StoredPreferences | undefined;
    if (!row) return { daysBefore: 0, onDueDate: false, overdue: false, version: null };
    const { daysBefore, onDueDate, overdue, version } = fromStorage(row);
    return { daysBefore, onDueDate, overdue, version };
  }

  update(userId: string, raw: unknown): DeadlineReminderPreferences {
    const input = checkedFields(raw, ['daysBefore', 'onDueDate', 'overdue', 'expectedVersion']);
    const options = readOptions(input);
    if (input.expectedVersion !== null && !readVersion(input.expectedVersion)) {
      throw new DeadlineReminderError(400, '기한 알림 설정의 버전을 확인해 주세요.');
    }
    return this.store.transaction(() => {
      const current = this.get(userId);
      if (current.version !== input.expectedVersion) {
        throw new DeadlineReminderError(409, '기한 알림 설정이 변경되었습니다. 다시 불러와 주세요.', { currentVersion: current.version });
      }
      const next = { ...options, version: randomUUID() };
      const record = { ...next, userId };
      this.write(record);
      this.deliver([record]);
      return next;
    });
  }

  sweep(): void {
    this.store.transaction(() => this.deliver(this.all()));
  }

  all(): DeadlineReminderPreferenceRecord[] {
    const rows = this.store.db.prepare(`${preferencesSelect} ORDER BY user_id`).all() as StoredPreferences[];
    return rows.map(fromStorage);
  }

  /** The caller commits the workspace restore and renewed preference versions together. */
  restore(raw: unknown, users: Set<string>): void {
    if (!Array.isArray(raw) || raw.length > users.size) {
      throw new DeadlineReminderError(400, '백업의 업무 기한 알림 설정을 확인해 주세요.');
    }
    const seen = new Set<string>();
    const records = Array.from(raw, value => {
      const row = checkedFields(value, ['userId', 'daysBefore', 'onDueDate', 'overdue', 'version']);
      const { userId, version } = row;
      if (typeof userId !== 'string' || !users.has(userId) || seen.has(userId) || !readVersion(version)) {
        throw new DeadlineReminderError(400, '백업의 업무 기한 알림 설정에서 팀원과 버전을 확인해 주세요.');
      }
      seen.add(userId);
      return { ...readOptions(row), userId, version: randomUUID() };
    });
    this.store.db.exec('DELETE FROM deadline_reminder_preferences');
    for (const record of records) this.write(record);
  }

  private write({ userId, daysBefore, onDueDate, overdue, version }: DeadlineReminderPreferenceRecord): void {
    this.store.db.prepare(preferencesWrite).run(userId, daysBefore, Number(onDueDate), Number(overdue), version);
  }

  private deliver(settings: DeadlineReminderPreferenceRecord[]): void {
    const optedIn = settings.filter(({ daysBefore, onDueDate, overdue }) => daysBefore > 0 || onDueDate || overdue);
    if (!optedIn.length) return;
    const createdAt = this.now().toISOString();
    const today = calendarDay(reservationLocalDateTime(createdAt, 'Asia/Seoul').slice(0, 10));
    const assignedIssues = this.store.db.prepare('SELECT json FROM issues WHERE assignee_id=? ORDER BY rowid');
    for (const preferences of optedIn) {
      for (const row of assignedIssues.iterate(preferences.userId)) {
        const issue = JSON.parse(row.json as string) as Issue;
        const deadline = issueDeadline(issue);
        if (!deadline) continue;
        const kind = reminderKind(calendarDay(deadline.value) - today, preferences);
        if (!kind || this.terminal(issue)) continue;
        this.notifications.notifyDeadline({
          kind, recipientId: preferences.userId, projectId: issue.projectId, targetId: issue.id,
          targetLabel: `${issue.key} ${issue.title}`, createdAt, deadline,
        });
      }
    }
  }
}
