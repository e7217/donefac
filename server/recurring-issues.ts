import { calendarDate, calendarDay } from '../shared/calendar.js';
import { reservationInstant, reservationLocalDateTime } from '../shared/time-reservations.js';
import type { Issue, IssueTemplate, Project, RecurringIssueConfig, RecurringIssueRule, RecurringIssueRun, User } from '../shared/types.js';
import { creationRequestId } from './creation-request.js';
import type { Store } from './store.js';

const CONFIG_KEYS = ['name', 'templateId', 'weekday', 'time', 'assigneeId', 'enabled'] as const;
const BACKUP_KEYS = [...CONFIG_KEYS, 'id', 'projectId', 'authorId', 'version', 'archived', 'createdAt', 'updatedAt', 'nextRunAt', 'recentRuns'];
const RUN_KEYS = ['scheduledAt', 'processedAt', 'outcome'];
const RESTORE_VERSION_FLOOR = 'recurringIssueRestoreVersion';
const MAX_RECENT_RUNS = 12;
const MAX_REASON_LENGTH = 2000;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

type ErrorReason = 'recurring-issue-invalid-input' | 'recurring-issue-invalid-backup' | 'recurring-issue-not-found' |
  'recurring-issue-template-archived' | 'recurring-issue-archived' | 'recurring-issue-version-conflict' |
  'recurring-issue-request-conflict';

export class RecurringIssueError extends Error {
  constructor(readonly status: number, message: string, readonly details: { reason: ErrorReason; currentVersion?: number }) {
    super(message);
  }
}

type RecurringIssueHooks = {
  prepare: (rule: RecurringIssueRule, processedAt: string, template: IssueTemplate) => { issue: Issue } | { blocked: string };
  commit: (rule: RecurringIssueRule, issue: Issue) => Issue;
  onError?: (error: unknown, ruleId: string) => void;
};

function fail(status: number, message: string, reason: ErrorReason, currentVersion?: number): never {
  throw new RecurringIssueError(status, message, currentVersion === undefined ? { reason } : { reason, currentVersion });
}

function invalidInput(message: string, backup: boolean): never {
  if (backup) return fail(400, '백업의 반복 업무 예약 데이터를 확인해 주세요.', 'recurring-issue-invalid-backup');
  return fail(400, message, 'recurring-issue-invalid-input');
}

function record(input: unknown, keys: readonly string[], backup = false): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    return invalidInput('반복 업무 예약 형식을 확인해 주세요.', backup);
  }
  return input as Record<string, unknown>;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nextVersion(version: number): number {
  if (version >= Number.MAX_SAFE_INTEGER) {
    return fail(409, '반복 업무 예약의 편집 버전 범위를 초과했습니다.', 'recurring-issue-version-conflict', version);
  }
  return version + 1;
}

function entityId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && Boolean(value.trim()) && value.isWellFormed();
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function config(value: Record<string, unknown>, backup = false): RecurringIssueConfig {
  const { name: rawName, templateId, weekday, time, assigneeId, enabled } = value;
  const cleanName = typeof rawName === 'string' && rawName.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(rawName)
    ? rawName.trim().normalize('NFC') : '';
  if (!cleanName || cleanName.length > 100 || (backup && cleanName !== rawName)) {
    return invalidInput('반복 업무 예약 이름을 1~100자로 입력해 주세요.', backup);
  }
  if (!entityId(templateId) || typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
      typeof time !== 'string' || !LOCAL_TIME.test(time) || assigneeId !== null && !entityId(assigneeId) || typeof enabled !== 'boolean') {
    return invalidInput('업무 템플릿, 요일, 시간, 담당자와 활성화 여부를 확인해 주세요.', backup);
  }
  return { name: cleanName, templateId, weekday, time, assigneeId, enabled };
}

function sameConfig(left: RecurringIssueConfig, right: RecurringIssueConfig): boolean {
  return CONFIG_KEYS.every(key => left[key] === right[key]);
}

function isoWeekday(day: number): number {
  return ((day + 3) % 7 + 7) % 7 + 1;
}

function scheduleSlot(instant: string, rule: Pick<RecurringIssueConfig, 'weekday' | 'time'>, direction: 1 | -1): string {
  const currentDay = calendarDay(reservationLocalDateTime(instant).slice(0, 10));
  const offset = (direction * (rule.weekday - isoWeekday(currentDay)) + 7) % 7;
  for (let day = currentDay + direction * offset; ; day += direction * 7) {
    const slot = reservationInstant(`${calendarDate(day)}T${rule.time}`);
    // A skipped or ambiguous local minute cannot represent a unique occurrence.
    if (slot && (direction === 1 ? slot > instant : slot <= instant)) return slot;
  }
}

function matchesSchedule(instant: string, rule: RecurringIssueConfig): boolean {
  const local = reservationLocalDateTime(instant);
  return local.slice(11) === rule.time && isoWeekday(calendarDay(local.slice(0, 10))) === rule.weekday && reservationInstant(local) === instant;
}

function readRuns(value: unknown, createdAt: string, exportedAt: string): RecurringIssueRun[] {
  if (!Array.isArray(value) || value.length > MAX_RECENT_RUNS) return invalidInput('', true);
  let previousScheduledAt: string | undefined;
  let previousProcessedAt: string | undefined;
  const createdIssues = new Set<string>();
  return value.map(entry => {
    const row = record(entry, [...RUN_KEYS, 'issueId', 'issueKey', 'reason'], true);
    const { scheduledAt, processedAt, outcome, issueId, issueKey, reason } = row;
    if (!canonicalInstant(scheduledAt) || !scheduledAt.endsWith(':00.000Z') || scheduledAt <= createdAt ||
        !canonicalInstant(processedAt) || processedAt < scheduledAt || processedAt > exportedAt ||
        (previousScheduledAt !== undefined && scheduledAt >= previousScheduledAt) ||
        (previousProcessedAt !== undefined && processedAt >= previousProcessedAt)) return invalidInput('', true);
    previousScheduledAt = scheduledAt;
    previousProcessedAt = processedAt;
    if (outcome === 'created' && entityId(issueId) && entityId(issueKey) && !Object.hasOwn(row, 'reason') && !createdIssues.has(issueId)) {
      createdIssues.add(issueId);
      return { scheduledAt, processedAt, outcome, issueId, issueKey };
    }
    if (outcome === 'blocked' && typeof reason === 'string' && reason.trim() && reason.length <= MAX_REASON_LENGTH && reason.isWellFormed() &&
        !Object.hasOwn(row, 'issueId') && !Object.hasOwn(row, 'issueKey')) return { scheduledAt, processedAt, outcome, reason };
    return invalidInput('', true);
  });
}

export class RecurringIssueService {
  constructor(private readonly store: Store, private readonly clock: () => Date = () => new Date()) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS recurring_issue_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
        archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        next_run_at TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recurring_issue_rules_project ON recurring_issue_rules(project_id,archived);
      CREATE INDEX IF NOT EXISTS recurring_issue_rules_due ON recurring_issue_rules(next_run_at,id) WHERE next_run_at IS NOT NULL;
    `);
  }

  list(projectId: string, includeArchived = false): RecurringIssueRule[] {
    this.requireProject(projectId);
    const rows = this.store.db.prepare('SELECT json FROM recurring_issue_rules WHERE project_id=? AND (archived=0 OR ?=1)')
      .all(projectId, Number(includeArchived)) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as RecurringIssueRule)
      .sort((left, right) => Number(left.archived) - Number(right.archived) || left.name.localeCompare(right.name, 'ko') || left.id.localeCompare(right.id));
  }

  create(projectId: string, input: unknown, actorId: string, onCreated?: (rule: RecurringIssueRule) => void): RecurringIssueRule {
    const body = record(input, [...CONFIG_KEYS, 'requestId', 'actorId']);
    if (typeof body.requestId !== 'string' || !creationRequestId.test(body.requestId)) {
      return invalidInput('반복 업무 예약의 요청 ID를 확인해 주세요.', false);
    }
    const id = body.requestId.toLowerCase();
    const values = config(body);
    const save = () => {
      this.requireProject(projectId);
      this.requireActor(actorId);
      const existing = this.store.get<RecurringIssueRule>('recurring_issue_rules', id);
      if (existing) {
        if (existing.projectId === projectId && existing.authorId === actorId && !existing.archived && sameConfig(existing, values)) return existing;
        return fail(409, '이미 다른 내용으로 처리된 반복 업무 예약 요청입니다.', 'recurring-issue-request-conflict');
      }
      this.requireTemplate(projectId, values.templateId, true);
      this.requireAssignee(values.assigneeId);
      const timestamp = this.clock().toISOString();
      const nextRunAt = values.enabled ? scheduleSlot(timestamp, values, 1) : null;
      const rule: RecurringIssueRule = { ...values, id, projectId, authorId: actorId, archived: false,
        version: nextVersion(this.versionFloor()), createdAt: timestamp, updatedAt: timestamp, nextRunAt, recentRuns: [] };
      this.put(rule);
      onCreated?.(rule);
      return rule;
    };
    return this.store.db.isTransaction ? save() : this.store.transaction(save);
  }

  patch(projectId: string, id: string, input: unknown, actorId: string): RecurringIssueRule {
    const body = record(input, [...CONFIG_KEYS, 'expectedVersion', 'archived', 'actorId']);
    const { expectedVersion, archived: archiveInput } = body;
    if (!isVersion(expectedVersion) || (Object.hasOwn(body, 'archived') && typeof archiveInput !== 'boolean') ||
        ![...CONFIG_KEYS, 'archived'].some(key => Object.hasOwn(body, key))) {
      return invalidInput('반복 업무 예약의 버전과 변경 항목을 확인해 주세요.', false);
    }
    const save = () => {
      this.requireActor(actorId);
      const current = this.store.get<RecurringIssueRule>('recurring_issue_rules', id);
      if (!current || current.projectId !== projectId) return fail(404, '프로젝트에서 반복 업무 예약을 찾을 수 없습니다.', 'recurring-issue-not-found');
      if (current.version !== expectedVersion) {
        return fail(409, '반복 업무 예약이 변경되었습니다. 최신 내용을 확인해 주세요.', 'recurring-issue-version-conflict', current.version);
      }
      const archived = typeof archiveInput === 'boolean' ? archiveInput : current.archived;
      const values = config({ ...current, ...body });
      if (archiveInput === true) values.enabled = false;
      if (archived && values.enabled) return fail(409, '보관된 예약을 먼저 복원해 주세요.', 'recurring-issue-archived');
      if (archived === current.archived && sameConfig(current, values)) return current;

      this.requireTemplate(projectId, values.templateId, values.templateId !== current.templateId || values.enabled && !current.enabled);
      this.requireAssignee(values.assigneeId);
      const timestamp = [this.clock().toISOString(), current.updatedAt, current.recentRuns[0]?.processedAt ?? ''].sort().at(-1)!;
      const reschedule = !current.enabled || values.weekday !== current.weekday || values.time !== current.time;
      const nextRunAt = !values.enabled ? null : reschedule ? scheduleSlot(timestamp, values, 1) : current.nextRunAt;
      const rule = { ...current, ...values, archived, version: nextVersion(current.version), updatedAt: timestamp, nextRunAt };
      this.put(rule);
      return rule;
    };
    return this.store.db.isTransaction ? save() : this.store.transaction(save);
  }

  all(): RecurringIssueRule[] {
    const rows = this.store.db.prepare('SELECT json FROM recurring_issue_rules ORDER BY id').all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as RecurringIssueRule);
  }

  sweep(hooks: RecurringIssueHooks): number {
    const processedAt = this.clock().toISOString();
    const due = this.store.db.prepare('SELECT id FROM recurring_issue_rules WHERE next_run_at <= ? ORDER BY next_run_at,id')
      .all(processedAt) as { id: string }[];
    let completed = 0;
    const failures: { id: string; error: unknown }[] = [];
    for (const { id } of due) {
      try {
        if (this.store.transaction(() => this.runIfDue(id, processedAt, hooks))) completed++;
      } catch (error) {
        failures.push({ id, error });
      }
    }
    if (hooks.onError) for (const { id, error } of failures) hooks.onError(error, id);
    else if (failures.length) throw failures[0].error;
    return completed;
  }

  validateRestore(input: unknown, projects: readonly Project[], users: readonly User[], templates: readonly IssueTemplate[], exportedAt: unknown): RecurringIssueRule[] {
    if (!Array.isArray(input) || input.length > 100_000 || !canonicalInstant(exportedAt)) return invalidInput('', true);
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const templateProjects = new Map(templates.map(template => [template.id, template.projectId]));
    const ids = new Set<string>();
    return input.map(value => {
      const row = record(value, BACKUP_KEYS, true);
      const values = config(row, true);
      const { id, projectId, version, archived, authorId, createdAt, updatedAt, nextRunAt } = row;
      if (typeof id !== 'string' || !creationRequestId.test(id) || id !== id.toLowerCase() || ids.has(id) ||
          typeof projectId !== 'string' || !projectIds.has(projectId) || templateProjects.get(values.templateId) !== projectId ||
          !isVersion(version) || typeof archived !== 'boolean' || archived && values.enabled ||
          typeof authorId !== 'string' || !userIds.has(authorId) || values.assigneeId !== null && !userIds.has(values.assigneeId) ||
          !canonicalInstant(createdAt) || !canonicalInstant(updatedAt) || createdAt > updatedAt || updatedAt > exportedAt) return invalidInput('', true);
      const recentRuns = readRuns(row.recentRuns, createdAt, exportedAt);
      if (values.enabled) {
        if (!canonicalInstant(nextRunAt) || nextRunAt <= createdAt || nextRunAt <= (recentRuns[0]?.processedAt ?? '') ||
            !matchesSchedule(nextRunAt, values)) return invalidInput('', true);
      } else if (nextRunAt !== null) return invalidInput('', true);
      ids.add(id);
      return { ...values, id, projectId, authorId, version, archived, createdAt, updatedAt, nextRunAt: nextRunAt as string | null, recentRuns };
    });
  }

  restore(rules: readonly RecurringIssueRule[]): void {
    if (!this.store.db.isTransaction) throw new Error('Recurring issue restoration requires a transaction.');
    const local = this.store.db.prepare("SELECT MAX(json_extract(json,'$.version')) AS version FROM recurring_issue_rules").get() as { version: number | null };
    const floor = Math.max(local.version ?? 0, this.versionFloor());
    this.store.db.exec('DELETE FROM recurring_issue_rules');
    let highestVersion = floor;
    for (const rule of rules) {
      const version = Math.max(rule.version, floor ? nextVersion(floor) : 1);
      this.put({ ...rule, version });
      highestVersion = Math.max(highestVersion, version);
    }
    if (highestVersion) this.store.setSetting(RESTORE_VERSION_FLOOR, highestVersion);
  }

  private runIfDue(id: string, processedAt: string, hooks: RecurringIssueHooks): boolean {
    const current = this.store.get<RecurringIssueRule>('recurring_issue_rules', id);
    if (!current?.enabled || current.archived || !current.nextRunAt || current.nextRunAt > processedAt) return false;
    const scheduledAt = scheduleSlot(processedAt, current, -1);
    const nextRunAt = scheduleSlot(processedAt, current, 1);
    const template = this.store.get<IssueTemplate>('issue_templates', current.templateId);
    const prepared = !template || template.projectId !== current.projectId ? { blocked: '프로젝트에서 업무 템플릿을 찾을 수 없습니다.' }
      : template.archived ? { blocked: '보관된 업무 템플릿입니다.' }
      : !this.store.get<User>('users', current.authorId) ? { blocked: '예약을 만든 팀원을 찾을 수 없습니다.' }
      : hooks.prepare(current, processedAt, template);

    let run: RecurringIssueRun;
    if ('blocked' in prepared) {
      const reason = prepared.blocked.trim().slice(0, MAX_REASON_LENGTH).toWellFormed() || '업무 생성 조건을 확인해 주세요.';
      run = { scheduledAt, processedAt, outcome: 'blocked', reason };
    } else {
      const issue = hooks.commit(current, prepared.issue);
      run = { scheduledAt, processedAt, outcome: 'created', issueId: issue.id, issueKey: issue.key };
    }
    this.put({ ...current, nextRunAt, recentRuns: [run, ...current.recentRuns].slice(0, MAX_RECENT_RUNS) });
    return true;
  }

  private versionFloor(): number {
    const previous: unknown = this.store.setting(RESTORE_VERSION_FLOOR);
    return isVersion(previous) ? previous : 0;
  }

  private requireProject(projectId: string): void {
    if (!this.store.get<Project>('projects', projectId)) {
      fail(404, '반복 업무를 예약할 프로젝트를 찾을 수 없습니다.', 'recurring-issue-not-found');
    }
  }

  private requireActor(actorId: string): void {
    if (!this.store.get<User>('users', actorId)) invalidInput('반복 업무 예약을 변경할 작업자를 확인해 주세요.', false);
  }

  private requireAssignee(assigneeId: string | null): void {
    if (assigneeId !== null && !this.store.get<User>('users', assigneeId)) invalidInput('반복 업무의 담당자를 확인해 주세요.', false);
  }

  private requireTemplate(projectId: string, id: string, mustBeActive: boolean): void {
    const template = this.store.get<IssueTemplate>('issue_templates', id);
    if (!template || template.projectId !== projectId) fail(404, '프로젝트에서 업무 템플릿을 찾을 수 없습니다.', 'recurring-issue-not-found');
    if (mustBeActive && template.archived) fail(409, '다른 업무 템플릿을 선택하거나 보관된 템플릿을 복원해 주세요.', 'recurring-issue-template-archived');
  }

  private put(rule: RecurringIssueRule): void {
    this.store.db.prepare(`INSERT INTO recurring_issue_rules(id,project_id,archived,next_run_at,json) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET archived=excluded.archived,next_run_at=excluded.next_run_at,json=excluded.json`)
      .run(rule.id, rule.projectId, Number(rule.archived), rule.nextRunAt, JSON.stringify(rule));
  }
}
