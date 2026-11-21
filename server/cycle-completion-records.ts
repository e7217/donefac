import { isCalendarDate } from '../shared/calendar.js';
import type {
  CycleCompletionPlan, CycleCompletionRecord, CycleCompletionRecordedIssue, CycleCompletionRecordsPage,
  CycleCompletionRecordSummary, Issue, PlanningItem, Project,
} from '../shared/types.js';
import type { Store } from './store.js';

export class CycleCompletionRecordsError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

interface RestoreOptions {
  schemaVersion: number;
  exportedAt: unknown;
  projects: readonly Project[];
  planningItems: readonly PlanningItem[];
  issues: readonly Issue[];
}

interface ListOptions { cycleId?: string; cursor?: string; limit: number }
type Cursor = { completed_at: string; cycle_version: number; id: string };

const TABLE = 'cycle_completion_records';
const BACKUP_FORMAT = 80;
const MAX_BACKUP_RECORDS = 100_000;
const MAX_RECORD_ISSUES = 100_000;
const MAX_BACKUP_ISSUES = 500_000;
const PLAN_FIELDS = ['id', 'name', 'version'];
const CYCLE_FIELDS = [...PLAN_FIELDS, 'startDate', 'endDate', 'targetDate'];
const COUNT_FIELDS = ['carry', 'done', 'cancelled'];
const ISSUE_FIELDS = ['id', 'key', 'title', 'statusId', 'statusLabel', 'disposition', 'assigneeId', 'assigneeName'];
const RECORD_FIELDS = ['id', 'projectId', 'cycle', 'destination', 'actorId', 'actorName', 'completedAt', 'counts', 'issues'];

function invalid(): never {
  throw new CycleCompletionRecordsError(400, '백업의 사이클 완료 기록을 확인해 주세요.');
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) return invalid();
  return value as Record<string, unknown>;
}

function name(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
}

function identifier(value: unknown, max = 200): value is string {
  return name(value, max) && !/[\x00-\x1f\x7f]/u.test(value);
}

function time(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nullableDate(value: unknown): value is string | null { return value === null || isCalendarDate(value); }

function plan({ id, name: planName, version }: Record<string, unknown>): CycleCompletionPlan {
  if (!identifier(id, 100) || !identifier(planName, 120) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return invalid();
  return { id, name: planName, version };
}

function issue(value: unknown): CycleCompletionRecordedIssue {
  const row = object(value, ISSUE_FIELDS);
  const { id, key, title, statusId, statusLabel, disposition, assigneeId, assigneeName } = row;
  // Older native imports can preserve a ticket key outside the current generated KEY-N form.
  if (!identifier(id) || typeof key !== 'string' || key.length > 2_000 || !name(title, 300) ||
      !identifier(statusId, 48) || !name(statusLabel, 48) ||
      (disposition !== 'carry' && disposition !== 'done' && disposition !== 'cancelled') ||
      (assigneeId !== null && !identifier(assigneeId)) ||
      (assigneeName !== null && (assigneeId === null || !name(assigneeName, 200)))) return invalid();
  return { id, key, title, statusId, statusLabel, disposition, assigneeId, assigneeName };
}

function record(value: unknown): CycleCompletionRecord {
  const row = object(value, RECORD_FIELDS);
  const { id, projectId, actorId, actorName, completedAt } = row;
  if (!identifier(id) || !identifier(projectId, 100) || !identifier(actorId) || !name(actorName, 200) || !time(completedAt)) return invalid();
  const cycle = object(row.cycle, CYCLE_FIELDS);
  const { startDate, endDate, targetDate } = cycle;
  if (!nullableDate(startDate) || !nullableDate(endDate) || !nullableDate(targetDate) || (startDate && endDate && startDate > endDate)) return invalid();
  const source = plan(cycle);
  const destination = row.destination === null ? null : plan(object(row.destination, PLAN_FIELDS));
  if (source.version < 2 || destination?.id === source.id || !Array.isArray(row.issues) || row.issues.length > MAX_RECORD_ISSUES) return invalid();

  const ids = new Set<string>(), keys = new Set<string>();
  const counts = { carry: 0, done: 0, cancelled: 0 };
  const issues = row.issues.map(value => {
    const member = issue(value);
    if (ids.has(member.id) || keys.has(member.key)) return invalid();
    ids.add(member.id);
    keys.add(member.key);
    counts[member.disposition]++;
    return member;
  });
  const suppliedCounts = object(row.counts, COUNT_FIELDS);
  if (Object.entries(counts).some(([key, count]) => suppliedCounts[key] !== count)) return invalid();
  return { id, projectId, cycle: { ...source, startDate, endDate, targetDate }, destination, actorId, actorName, completedAt, counts, issues };
}

export class CycleCompletionRecords {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cycle_id TEXT NOT NULL,
      cycle_version INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      json TEXT NOT NULL,
      UNIQUE(cycle_id, cycle_version)
    );
    CREATE INDEX IF NOT EXISTS cycle_completion_records_project ON ${TABLE}(project_id, completed_at DESC, cycle_version DESC, id DESC);
    CREATE INDEX IF NOT EXISTS cycle_completion_records_cycle ON ${TABLE}(project_id, cycle_id, completed_at DESC, cycle_version DESC, id DESC);`);
  }

  insert(snapshot: CycleCompletionRecord): void {
    this.requireTransaction();
    const captured = record(snapshot);
    this.insertRow(captured);
  }

  list(projectId: string, { cycleId, cursor, limit }: ListOptions): CycleCompletionRecordsPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CycleCompletionRecordsError(400, '완료 기록 조회 개수를 확인해 주세요.');
    const scope = cycleId === undefined ? 'project_id=?' : 'project_id=? AND cycle_id=?';
    const params = cycleId === undefined ? [projectId] : [projectId, cycleId];
    let after = '';
    const args: (string | number)[] = [...params];
    if (cursor !== undefined) {
      const anchor = this.store.db.prepare(`SELECT completed_at, cycle_version, id FROM ${TABLE} WHERE ${scope} AND id=?`)
        .get(...params, cursor) as Cursor | undefined;
      if (!anchor) throw new CycleCompletionRecordsError(400, '이 범위의 완료 기록 위치를 확인해 주세요.');
      after = ' AND (completed_at, cycle_version, id) < (?,?,?)';
      args.push(anchor.completed_at, anchor.cycle_version, anchor.id);
    }
    const rows = this.store.db.prepare(`SELECT json_remove(json, '$.issues') AS json FROM ${TABLE}
      WHERE ${scope}${after} ORDER BY completed_at DESC, cycle_version DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as { json: string }[];
    const items = rows.slice(0, limit).map(({ json }) => JSON.parse(json) as CycleCompletionRecordSummary);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  get(projectId: string, id: string): CycleCompletionRecord | undefined {
    const row = this.store.db.prepare(`SELECT json FROM ${TABLE} WHERE project_id=? AND id=?`).get(projectId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as CycleCompletionRecord : undefined;
  }

  exportRecords(): CycleCompletionRecord[] {
    const rows = this.store.db.prepare(`SELECT json FROM ${TABLE} ORDER BY project_id, completed_at DESC, cycle_version DESC, id DESC`).all() as { json: string }[];
    return rows.map(({ json }) => JSON.parse(json) as CycleCompletionRecord);
  }

  validateRestore(raw: unknown, { schemaVersion, exportedAt, projects, planningItems, issues }: RestoreOptions): CycleCompletionRecord[] {
    if (schemaVersion < BACKUP_FORMAT) {
      if (raw !== undefined && (!Array.isArray(raw) || raw.length)) {
        throw new CycleCompletionRecordsError(400, `사이클 완료 기록을 포함한 백업은 schemaVersion ${BACKUP_FORMAT}이 필요합니다.`);
      }
      return [];
    }
    if (!Array.isArray(raw) || raw.length > MAX_BACKUP_RECORDS || (raw.length > 0 && !time(exportedAt))) return invalid();
    const projectsById = new Set(projects.map(project => project.id));
    const planningById = new Map(planningItems.map(item => [item.id, item]));
    const issuesById = new Map(issues.map(item => [item.id, item]));
    const seenIds = new Set<string>();
    const seenVersions = new Set<string>();
    let issueCount = 0;
    return raw.map(value => {
      const snapshot = record(value);
      const { id, projectId, cycle, destination, completedAt } = snapshot;
      const generation = JSON.stringify([cycle.id, cycle.version]);
      const source = planningById.get(cycle.id);
      const target = destination && planningById.get(destination.id);
      issueCount += snapshot.issues.length;
      if (issueCount > MAX_BACKUP_ISSUES || !projectsById.has(projectId) || typeof exportedAt !== 'string' || completedAt > exportedAt ||
          seenIds.has(id) || seenVersions.has(generation) ||
          (source && (source.projectId !== projectId || source.kind !== 'cycle' || source.version < cycle.version)) ||
          (target && (target.projectId !== projectId || target.kind !== 'cycle'))) return invalid();
      for (const member of snapshot.issues) {
        const live = issuesById.get(member.id);
        if (live && (live.projectId !== projectId || live.key !== member.key)) return invalid();
      }
      seenIds.add(id);
      seenVersions.add(generation);
      return snapshot;
    });
  }

  restore(records: readonly CycleCompletionRecord[]): void {
    this.requireTransaction();
    this.store.db.exec(`DELETE FROM ${TABLE}`);
    for (const captured of records) this.insertRow(captured);
  }

  private requireTransaction(): void {
    if (!this.store.db.isTransaction) throw new CycleCompletionRecordsError(500, '사이클 완료 기록을 저장·복원하려면 트랜잭션이 필요합니다.');
  }

  private insertRow(snapshot: CycleCompletionRecord): void {
    this.store.db.prepare(`INSERT INTO ${TABLE}(id, project_id, cycle_id, cycle_version, completed_at, json) VALUES(?,?,?,?,?,?)`)
      .run(snapshot.id, snapshot.projectId, snapshot.cycle.id, snapshot.cycle.version, snapshot.completedAt, JSON.stringify(snapshot));
  }
}
