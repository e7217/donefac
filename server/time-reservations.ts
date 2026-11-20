import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Issue, IssueTimeReservation, IssueTimeReservationEntry, User } from '../shared/types.js';
import type { Store } from './store.js';

const DAY_MS = 86_400_000;
const MAX_CALENDAR_DAYS = 31;
const MAX_CALENDAR_ENTRIES = 10_000;
const MAX_VERSION = Number.MAX_SAFE_INTEGER - 1;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const CREATE_HASH = /^[a-f0-9]{64}$/;

interface ReservationRecord extends IssueTimeReservation {
  createHash: string;
  deletedAt: string | null;
}

interface BackupReferences { issues: readonly Issue[]; archivedIssues: readonly Issue[]; users: readonly User[] }
type Fields = Pick<IssueTimeReservation, 'userId' | 'startAt' | 'endAt'>;
type DisplayIssue = Pick<Issue, 'projectId' | 'key' | 'title'>;
type CalendarRow = { json: string; projectId: string; key: string; title: string };
interface Hooks {
  actor(request: Request): string;
  activity(request: Request, resourceType: string, resourceId: string, action: string, detail?: string): void;
}

export class TimeReservationError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: { conflict: IssueTimeReservationEntry }) {
    super(message);
  }
}

function fail(status: number, message: string): never { throw new TimeReservationError(status, message); }

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isMinute(value: unknown): value is string {
  return typeof value === 'string' && UTC_MINUTE.test(value) && isTimestamp(value);
}

function period(startAt: unknown, endAt: unknown, maxDays: number): Pick<Fields, 'startAt' | 'endAt'> {
  if (!isMinute(startAt) || !isMinute(endAt)) fail(400, '시작과 종료를 분 단위 UTC 시각으로 입력해 주세요.');
  if (startAt >= endAt) fail(400, '종료 시각은 시작 시각보다 늦어야 합니다.');
  if (Date.parse(endAt) - Date.parse(startAt) > maxDays * DAY_MS) fail(400, `시간 범위는 ${maxDays}일 이내여야 합니다.`);
  return { startAt, endAt };
}

function inputRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail(400, '시간 배정의 입력 항목을 확인해 주세요.');
  }
  return value as Record<string, unknown>;
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) fail(400, '시간 배정의 편집 버전이 필요합니다.');
  return value;
}

function nextVersion(value: number): number {
  if (value >= MAX_VERSION) fail(409, '시간 배정의 편집 버전 범위를 초과했습니다.');
  return value + 1;
}

function display(value: ReservationRecord, issue: DisplayIssue): IssueTimeReservationEntry {
  const { id, issueId, userId, startAt, endAt, version, state, createdById, updatedById, createdAt, updatedAt } = value;
  return { id, issueId, userId, startAt, endAt, version, state, createdById, updatedById, createdAt, updatedAt,
    projectId: issue.projectId, issueKey: issue.key, issueTitle: issue.title };
}

const calendarSelect = `SELECT r.json,i.project_id AS projectId,json_extract(i.json,'$.key') AS key,json_extract(i.json,'$.title') AS title
  FROM issue_time_reservations r JOIN issues i ON i.id = r.issue_id
  WHERE r.state='reserved' AND r.deleted_at IS NULL AND r.start_at < ? AND r.end_at > ?`;

const ORDERED_PERIOD = 'ORDER BY r.start_at,r.end_at,r.id';
const RETIRE_REQUESTS = `INSERT INTO retired_time_reservation_requests(id,version)
  SELECT id,json_extract(json,'$.version') FROM issue_time_reservations`;
const FIELD_KEYS = ['userId', 'startAt', 'endAt'];
const BACKUP_KEYS = ['id', 'issueId', ...FIELD_KEYS, 'version', 'state', 'createdById', 'updatedById', 'createdAt', 'updatedAt', 'createHash', 'deletedAt'];

export class TimeReservationService {
  constructor(private readonly store: Store) {
    // The issue ID is also valid while the ticket and its bookings are in trash.
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_time_reservations (
        id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        start_at TEXT NOT NULL, end_at TEXT NOT NULL CHECK (start_at < end_at),
        state TEXT NOT NULL CHECK (state IN ('reserved','needs-review')), deleted_at TEXT, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_time_reservations_issue ON issue_time_reservations(issue_id,start_at,end_at,id);
      CREATE INDEX IF NOT EXISTS issue_time_reservations_member ON issue_time_reservations(user_id,start_at,end_at,id)
        WHERE state='reserved' AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS issue_time_reservations_calendar ON issue_time_reservations(start_at,end_at,id)
        WHERE state='reserved' AND deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS retired_time_reservation_requests (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    `);
  }

  private issue(issueId: string): Issue {
    return this.store.get<Issue>('issues', issueId) ?? fail(404, '시간을 배정할 업무를 찾을 수 없습니다.');
  }

  private member(value: unknown): string {
    if (typeof value !== 'string' || !value || !this.store.get<User>('users', value)) fail(400, '시간을 배정할 팀원을 선택해 주세요.');
    return value;
  }

  private fields(body: Record<string, unknown>): Fields {
    return { userId: this.member(body.userId), ...period(body.startAt, body.endAt, 1) };
  }

  private write(value: ReservationRecord): void {
    this.store.db.prepare(`INSERT INTO issue_time_reservations(id,issue_id,user_id,start_at,end_at,state,deleted_at,json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,start_at=excluded.start_at,
      end_at=excluded.end_at,state=excluded.state,deleted_at=excluded.deleted_at,json=excluded.json`)
      .run(value.id, value.issueId, value.userId, value.startAt, value.endAt, value.state, value.deletedAt, JSON.stringify(value));
  }

  private overlapping(value: Fields, exclude: { id?: string; issueId?: string } = {}): IssueTimeReservationEntry | undefined {
    const row = this.store.db.prepare(`${calendarSelect} AND r.user_id = ?
      ${exclude.id === undefined ? '' : 'AND r.id <> ?'}
      ${exclude.issueId === undefined ? '' : 'AND r.issue_id <> ?'} ${ORDERED_PERIOD} LIMIT 1`)
      .get(value.endAt, value.startAt, value.userId,
        ...[exclude.id, exclude.issueId].filter((id): id is string => id !== undefined)) as CalendarRow | undefined;
    return row && display(JSON.parse(row.json) as ReservationRecord, row);
  }

  private requireVacancy(value: Fields, id?: string): void {
    const conflict = this.overlapping(value, { id });
    if (conflict) throw new TimeReservationError(409, `같은 팀원의 ${conflict.issueKey} 배정과 시간이 겹칩니다.`, { conflict });
  }

  private listIssue(issueId: string, query: Request['query']): IssueTimeReservationEntry[] {
    if (Object.keys(query).length) fail(400, '업무의 시간 배정 조회 조건을 확인해 주세요.');
    const issue = this.issue(issueId);
    const rows = this.store.db.prepare(`SELECT json FROM issue_time_reservations WHERE issue_id=? AND deleted_at IS NULL
      ORDER BY start_at,end_at,id`).all(issueId) as { json: string }[];
    return rows.map(row => display(JSON.parse(row.json) as ReservationRecord, issue));
  }

  private listCalendar(query: Request['query']): IssueTimeReservationEntry[] {
    inputRecord(query, ['startAt', 'endAt', 'userId']);
    const range = period(query.startAt, query.endAt, MAX_CALENDAR_DAYS);
    const userId = query.userId === undefined ? undefined : this.member(query.userId);
    const rows = this.store.db.prepare(`${calendarSelect} ${userId === undefined ? '' : 'AND r.user_id = ?'} ${ORDERED_PERIOD} LIMIT ?`)
      .all(range.endAt, range.startAt, ...(userId === undefined ? [] : [userId]), MAX_CALENDAR_ENTRIES + 1) as CalendarRow[];
    if (rows.length > MAX_CALENDAR_ENTRIES) fail(422, '표시할 시간 배정이 많습니다. 조회 기간을 줄이거나 팀원을 선택해 주세요.');
    return rows.map(row => display(JSON.parse(row.json) as ReservationRecord, row));
  }

  private create(request: Request, issueId: string, hooks: Hooks): { value: IssueTimeReservationEntry; replay: boolean } {
    const actorId = hooks.actor(request);
    inputRecord(request.query, []);
    const body = inputRecord(request.body, [...FIELD_KEYS, 'requestId']);
    const { requestId } = body;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) fail(400, '시간 배정 요청 ID가 필요합니다.');
    return this.store.transaction(() => {
      const issue = this.issue(issueId);
      const input = this.fields(body);
      const createHash = createHashFor(issueId, actorId, input);
      const previous = this.store.get<ReservationRecord>('issue_time_reservations', requestId);
      if (previous) {
        if (previous.deletedAt !== null || previous.issueId !== issueId || previous.createdById !== actorId || previous.createHash !== createHash) {
          fail(409, '이미 처리한 시간 배정 요청입니다. 현재 배정을 확인해 주세요.');
        }
        return { value: display(previous, issue), replay: true };
      }
      if (this.store.db.prepare('SELECT 1 FROM retired_time_reservation_requests WHERE id=?').get(requestId)) {
        fail(409, '이전에 완료된 시간 배정 요청입니다. 새 입력을 시작해 주세요.');
      }
      this.requireVacancy(input);
      const timestamp = new Date().toISOString();
      const value: ReservationRecord = { ...input, id: requestId, issueId, version: 1, state: 'reserved', createdById: actorId, updatedById: actorId,
        createdAt: timestamp, updatedAt: timestamp, createHash, deletedAt: null };
      this.write(value);
      hooks.activity(request, 'issue', issueId, '시간 배정 등록', `${input.startAt} ~ ${input.endAt}`);
      return { value: display(value, issue), replay: false };
    });
  }

  private forIssue(issueId: string, id: string): ReservationRecord {
    const previous = this.store.get<ReservationRecord>('issue_time_reservations', id);
    if (!previous || previous.issueId !== issueId) fail(404, '업무의 시간 배정을 찾을 수 없습니다.');
    return previous;
  }

  private edit(request: Request, issueId: string, id: string, hooks: Hooks): IssueTimeReservationEntry {
    const actorId = hooks.actor(request);
    inputRecord(request.query, []);
    const body = inputRecord(request.body, [...FIELD_KEYS, 'expectedVersion']);
    const version = expectedVersion(body.expectedVersion);
    return this.store.transaction(() => {
      const issue = this.issue(issueId);
      const previous = this.forIssue(issueId, id);
      if (previous.deletedAt !== null) fail(404, '취소된 시간 배정입니다.');
      if (previous.version !== version) fail(409, '다른 작업자가 시간 배정을 변경했습니다. 최신 배정을 확인해 주세요.');
      const input = this.fields(body);
      if (previous.state === 'reserved' && previous.userId === input.userId && previous.startAt === input.startAt && previous.endAt === input.endAt) return display(previous, issue);
      this.requireVacancy(input, previous.id);
      const value: ReservationRecord = { ...previous, ...input, state: 'reserved', version: nextVersion(version),
        updatedById: actorId, updatedAt: new Date().toISOString() };
      this.write(value);
      hooks.activity(request, 'issue', issueId, '시간 배정 수정', `${input.startAt} ~ ${input.endAt}`);
      return display(value, issue);
    });
  }

  private remove(request: Request, issueId: string, id: string, hooks: Hooks): { ok: true } {
    const actorId = hooks.actor(request);
    const { expectedVersion: queryVersion } = request.query;
    inputRecord(request.query, ['expectedVersion']);
    const version = expectedVersion(typeof queryVersion === 'string' && /^\d{1,16}$/.test(queryVersion) ? Number(queryVersion) : undefined);
    return this.store.transaction(() => {
      this.issue(issueId);
      const previous = this.forIssue(issueId, id);
      if (previous.deletedAt !== null) {
        if (previous.version === version + 1) return { ok: true };
        fail(404, '취소된 시간 배정입니다.');
      }
      if (previous.version !== version) fail(409, '다른 작업자가 시간 배정을 변경했습니다. 최신 배정을 확인해 주세요.');
      const timestamp = new Date().toISOString();
      this.write({ ...previous, version: nextVersion(version), updatedById: actorId, updatedAt: timestamp, deletedAt: timestamp });
      hooks.activity(request, 'issue', issueId, '시간 배정 취소', `${previous.startAt} ~ ${previous.endAt}`);
      return { ok: true };
    });
  }

  /** The issue has already been reinserted in the caller's trash restore transaction. */
  restoreIssue(issueId: string): number {
    const rows = this.store.db.prepare('SELECT json FROM issue_time_reservations WHERE issue_id=?').all(issueId) as { json: string }[];
    let needsReview = 0;
    for (const { json } of rows) {
      const value = JSON.parse(json) as ReservationRecord;
      const blocked = value.deletedAt === null && value.state === 'reserved' && this.overlapping(value, { issueId });
      if (blocked) needsReview += 1;
      this.write({ ...value, version: nextVersion(value.version), state: blocked ? 'needs-review' : value.state });
    }
    return needsReview;
  }

  purgeIssue(issueId: string): void {
    // Retire opaque request IDs before removing the issue's reservation records and details.
    this.store.db.prepare(`${RETIRE_REQUESTS} WHERE issue_id=?
      ON CONFLICT(id) DO UPDATE SET version=max(version,excluded.version)`).run(issueId);
    this.store.db.prepare('DELETE FROM issue_time_reservations WHERE issue_id=?').run(issueId);
  }

  all(): ReservationRecord[] {
    const rows = this.store.db.prepare('SELECT json FROM issue_time_reservations ORDER BY id').all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as ReservationRecord);
  }

  validateRestore(raw: unknown, { issues, archivedIssues, users }: BackupReferences, exportedAt: unknown): ReservationRecord[] {
    if (!Array.isArray(raw) || raw.length > 100_000) fail(400, '백업의 시간 배정 목록을 확인해 주세요.');
    if (!raw.length) return [];
    if (!isTimestamp(exportedAt)) fail(400, '시간 배정 백업의 내보낸 시각을 확인해 주세요.');
    const members = new Set(users.map(user => user.id));
    const knownIssues = new Set([...issues, ...archivedIssues].map(issue => issue.id));
    const activeIssues = new Set(issues.map(issue => issue.id));
    const ids = new Set<string>();
    const groups = new Map<string, ReservationRecord[]>();
    const rows = raw.map((item: unknown): ReservationRecord => {
      const value = inputRecord(item, BACKUP_KEYS);
      const { id, issueId, userId, version, state, createdById, updatedById, createdAt, updatedAt, createHash, deletedAt } = value;
      if (typeof id !== 'string' || !UUID.test(id) || ids.has(id) || typeof issueId !== 'string' || !knownIssues.has(issueId) ||
        typeof userId !== 'string' || !members.has(userId) || typeof createdById !== 'string' || !members.has(createdById) ||
        typeof updatedById !== 'string' || !members.has(updatedById) || (state !== 'reserved' && state !== 'needs-review') ||
        typeof createHash !== 'string' || !CREATE_HASH.test(createHash) || !isTimestamp(createdAt) || !isTimestamp(updatedAt) ||
        createdAt > updatedAt || updatedAt > exportedAt || (deletedAt !== null && deletedAt !== updatedAt)) {
        fail(400, '백업의 시간 배정 ID·업무·팀원·상태를 확인해 주세요.');
      }
      ids.add(id);
      const record: ReservationRecord = { id, issueId, userId, ...period(value.startAt, value.endAt, 1), state,
        version: expectedVersion(version), createdById, updatedById, createdAt, updatedAt, createHash, deletedAt };
      if (record.deletedAt === null && record.state === 'reserved') {
        // Archived tickets release their time across tickets, but their original slots cannot overlap one another.
        const group = JSON.stringify([userId, activeIssues.has(issueId) ? null : issueId]);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push(record);
      }
      return record;
    });
    for (const group of groups.values()) {
      group.sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (group.some((record, index) => index > 0 && group[index - 1].endAt > record.startAt)) fail(400, '백업에 같은 팀원의 겹치는 시간 배정이 있습니다.');
    }
    return rows;
  }

  /** Clear user references before replacing the workspace in the caller's transaction. */
  clearForRestore(): void {
    this.store.db.exec(`${RETIRE_REQUESTS} WHERE 1 ON CONFLICT(id) DO UPDATE SET version=max(version,excluded.version)`);
    this.store.db.exec('DELETE FROM issue_time_reservations');
  }

  replaceRestored(rows: ReservationRecord[]): void {
    const retired = this.store.db.prepare('SELECT version FROM retired_time_reservation_requests WHERE id=?');
    const reactivate = this.store.db.prepare('DELETE FROM retired_time_reservation_requests WHERE id=?');
    for (const value of rows) {
      const priorReceipt = retired.get(value.id) as { version: number } | undefined;
      const previous = priorReceipt?.version ?? 0;
      const version = previous < value.version ? value.version : nextVersion(previous);
      this.write({ ...value, version });
      reactivate.run(value.id);
    }
  }

  registerRoutes(app: Express, hooks: Hooks): void {
    app.get('/api/time-reservations', (req, res) => res.set('Cache-Control', 'no-store').json(this.listCalendar(req.query)));
    const issuePath = '/api/issues/:issueId/time-reservations';
    app.get(issuePath, (req, res) => res.set('Cache-Control', 'no-store').json(this.listIssue(req.params.issueId, req.query)));
    app.post(issuePath, (req, res) => {
      const result = this.create(req, req.params.issueId, hooks);
      res.status(result.replay ? 200 : 201).json(result.value);
    });
    app.patch(`${issuePath}/:id`, (req, res) => res.json(this.edit(req, req.params.issueId, req.params.id, hooks)));
    app.delete(`${issuePath}/:id`, (req, res) => res.json(this.remove(req, req.params.issueId, req.params.id, hooks)));
  }
}

function createHashFor(issueId: string, actorId: string, input: Fields): string {
  return createHash('sha256').update(JSON.stringify([issueId, actorId, input])).digest('hex');
}
