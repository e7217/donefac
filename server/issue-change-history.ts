import { randomUUID } from 'node:crypto';
import { fieldValueLabel } from '../shared/issue-schema.js';
import { PRIORITY, type CustomFieldDefinition, type CustomFieldValue, type Issue, type IssueChangeHistoryEntry,
  type IssueChangeHistoryField, type IssueChangeHistoryPage, type IssueChangeHistoryValue, type Project,
  type ProjectIssueSchema, type ProjectWorkflow, type User } from '../shared/types.js';
import type { Store, StoreChange } from './store.js';

const TABLE = 'issue_change_history';
const PAGE_SIZE = 20;
const TEXT_LIMIT = 1_000;
const LIST_LIMIT = 200;
const FIELD_LABELS = {
  projectId: '프로젝트', key: '업무 키', title: '제목', description: '설명', descriptionFormat: '설명 서식',
  type: '유형', status: '상태', priority: '우선순위', assigneeId: '담당자', reporterId: '요청자',
  collaboratorIds: '참여자', parentId: '상위 업무', labels: '라벨', startDate: '시작일', endDate: '종료일',
  dueDate: '목표 마감일', estimate: '예상 소요 (포인트)', plannedEffortMinutes: '계획 작업 시간 (분)',
  cycleId: '사이클', moduleId: '모듈', releaseId: '릴리스',
} satisfies Record<Exclude<IssueChangeHistoryField, `custom:${string}`>, string>;
const PLAN_FIELDS = { cycleId: 'cycle', moduleId: 'module', releaseId: 'release' } as const;
const STANDARD_FIELDS = Object.entries(FIELD_LABELS) as [keyof typeof FIELD_LABELS, string][];
const CUSTOM_FIELD = /^custom:[a-z][a-z0-9_-]{0,47}$/u;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

type Change = IssueChangeHistoryEntry['changes'][number];
type RawValue = CustomFieldValue | undefined;
type Hooks = { workflow(projectId: string): ProjectWorkflow; schema(projectId: string): ProjectIssueSchema };

export class IssueChangeHistoryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function invalidBackup(): never {
  throw new IssueChangeHistoryError(400, '백업의 업무 필드 변경 이력이 올바르지 않습니다.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidBackup();
  return value as Record<string, unknown>;
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function equalValue(left: RawValue, right: RawValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((value, index) => value === sorted[index]);
}

function excerptStart(before: RawValue, after: RawValue): number {
  if (typeof before !== 'string' || typeof after !== 'string' ||
      (before.length <= TEXT_LIMIT && after.length <= TEXT_LIMIT)) return 0;
  let firstDifference = 0;
  const commonLength = Math.min(before.length, after.length);
  while (firstDifference < commonLength && before[firstDifference] === after[firstDifference]) firstDifference++;
  return firstDifference < TEXT_LIMIT ? 0 : firstDifference - Math.floor(TEXT_LIMIT / 4);
}

function excerpt(value: string, start = 0): string {
  if (value.length <= TEXT_LIMIT) return value;
  const offset = Math.min(start, value.length - TEXT_LIMIT);
  return value.slice(offset, offset + TEXT_LIMIT).toWellFormed();
}

function historyValue(value: RawValue, display: string | null, start: number): IssueChangeHistoryValue {
  const clipped = Array.isArray(value) ? value.slice(0, LIST_LIMIT).map(item => excerpt(item))
    : typeof value === 'string' ? excerpt(value, start) : value ?? null;
  const truncated = (typeof value === 'string' && value.length > TEXT_LIMIT) ||
    (Array.isArray(value) && (value.length > LIST_LIMIT || value.some(item => item.length > TEXT_LIMIT))) ||
    (display !== null && display.length > TEXT_LIMIT);
  return { value: clipped, display: display === null ? null : excerpt(display), ...(truncated ? { truncated: true } : {}) };
}

function parseValue(value: unknown): IssueChangeHistoryValue {
  const source = record(value);
  const { value: raw, display, truncated } = source;
  if (Object.keys(source).some(key => key !== 'value' && key !== 'display' && key !== 'truncated') ||
      (display !== null && (typeof display !== 'string' || display.length > TEXT_LIMIT)) ||
      (truncated !== undefined && (truncated !== true || (typeof raw !== 'string' && !Array.isArray(raw))))) invalidBackup();
  if (raw !== null && typeof raw !== 'boolean' && !(typeof raw === 'number' && Number.isFinite(raw)) &&
      !(typeof raw === 'string' && raw.length <= TEXT_LIMIT) &&
      !(Array.isArray(raw) && raw.length <= LIST_LIMIT && raw.every(item => typeof item === 'string' && item.length <= TEXT_LIMIT))) invalidBackup();
  return { value: raw as CustomFieldValue, display, ...(truncated ? { truncated: true } : {}) };
}

function parseChanges(value: unknown): Change[] {
  if (!Array.isArray(value) || !value.length || value.length > STANDARD_FIELDS.length + 200) invalidBackup();
  const used = new Set<string>();
  return value.map(item => {
    const { field, label, before, after, ...rest } = record(item);
    if (Object.keys(rest).length || typeof field !== 'string' ||
        (!Object.hasOwn(FIELD_LABELS, field) && !CUSTOM_FIELD.test(field)) || used.has(field) ||
        typeof label !== 'string' || !label.trim() || label.length > 120) invalidBackup();
    used.add(field);
    const prior = parseValue(before), next = parseValue(after);
    if (equalValue(prior.value, next.value) && prior.display === next.display && !prior.truncated && !next.truncated) invalidBackup();
    return { field: field as IssueChangeHistoryField, label, before: prior, after: next };
  });
}

export class IssueChangeHistory {
  private readonly unsubscribe: () => void;

  constructor(private readonly store: Store, private readonly hooks: Hooks) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT NOT NULL UNIQUE, issue_id TEXT NOT NULL, project_id TEXT NOT NULL, previous_project_id TEXT NOT NULL,
      issue_version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (issue_id, issue_version)
    )`);
    this.unsubscribe = this.store.onChange(change => this.capture(change), ['issues']);
  }

  private capture({ before, after, context }: StoreChange) {
    if (!before || !after || !context.actorId || (context.origin !== 'user' && context.origin !== 'automation')) return;
    const previous = before as Issue, issue = after as Issue;
    const changes = this.diff(previous, issue);
    if (!changes.length) return;
    const actor = this.store.get<User>('users', context.actorId);
    if (!actor) return;
    this.insert({ id: randomUUID(), issueId: issue.id, projectId: issue.projectId, previousProjectId: previous.projectId,
      issueVersion: issue.version, actorId: actor.id, actorName: actor.name, origin: context.origin,
      occurredAt: issue.updatedAt, changes });
  }

  private diff(previous: Issue, issue: Issue): Change[] {
    const changes: Change[] = [];
    const moved = previous.projectId !== issue.projectId;
    let beforeSchema: ProjectIssueSchema | undefined;
    let afterSchema: ProjectIssueSchema | undefined;
    const priorSchema = () => beforeSchema ??= this.hooks.schema(previous.projectId);
    const currentSchema = () => afterSchema ??= moved ? this.hooks.schema(issue.projectId) : priorSchema();
    const add = (field: IssueChangeHistoryField, label: string, before: RawValue, after: RawValue,
      names: () => [string | null, string | null], scopeSensitive = false) => {
      const same = equalValue(before, after);
      if (same && !scopeSensitive) return;
      const [beforeDisplay, afterDisplay] = names();
      if (same && beforeDisplay === afterDisplay) return;
      const start = excerptStart(before, after);
      changes.push({ field, label, before: historyValue(before, beforeDisplay, start), after: historyValue(after, afterDisplay, start) });
    };
    for (const [field, label] of STANDARD_FIELDS) {
      const before = this.fieldValue(previous, field), after = this.fieldValue(issue, field);
      add(field, label, before, after, () => {
        if (field === 'type') return [priorSchema().issueTypes.find(type => type.id === before)?.name ?? null,
          currentSchema().issueTypes.find(type => type.id === after)?.name ?? null];
        if (field === 'status') return [this.hooks.workflow(previous.projectId).statuses.find(status => status.id === before)?.label ?? null,
          this.hooks.workflow(issue.projectId).statuses.find(status => status.id === after)?.label ?? null];
        return [this.display(previous, field, before), this.display(issue, field, after)];
      }, moved && (field === 'type' || field === 'status'));
    }
    const priorValues = previous.customFields ?? {}, currentValues = issue.customFields ?? {};
    for (const id of new Set([...Object.keys(priorValues), ...Object.keys(currentValues)])) {
      const before = Object.hasOwn(priorValues, id) ? priorValues[id] ?? null : null;
      const after = Object.hasOwn(currentValues, id) ? currentValues[id] ?? null : null;
      if (!moved && equalValue(before, after)) continue;
      const beforeField = priorSchema().fields.find(field => field.id === id);
      const afterField = currentSchema().fields.find(field => field.id === id);
      add(`custom:${id}`, afterField?.name ?? beforeField?.name ?? id, before, after,
        () => [this.customDisplay(beforeField, before), this.customDisplay(afterField, after)], moved);
    }
    return changes;
  }

  private fieldValue(issue: Issue, field: keyof typeof FIELD_LABELS): RawValue {
    if (field === 'reporterId') return issue.reporterId;
    if (field === 'descriptionFormat') return issue.descriptionFormat ?? 'plain';
    if (field === 'cycleId' || field === 'moduleId' || field === 'releaseId') return issue[field] ?? issue[PLAN_FIELDS[field]] ?? null;
    if (field === 'collaboratorIds' || field === 'labels') return issue[field] ?? [];
    return issue[field] ?? null;
  }

  private display(issue: Issue, field: keyof typeof FIELD_LABELS, value: RawValue): string | null {
    if (field === 'reporterId' && value === undefined) return '기록 없음';
    if (field === 'reporterId' || field === 'assigneeId') return typeof value === 'string'
      ? this.store.get<User>('users', value)?.name ?? null : '미지정';
    if (field === 'priority') return PRIORITY[issue.priority] ?? null;
    if (field === 'projectId') return this.store.get<Project>('projects', issue.projectId)?.name ?? null;
    if (field === 'descriptionFormat') return value === 'markdown' ? 'Markdown' : '일반 텍스트';
    if (field === 'collaboratorIds' && Array.isArray(value) && value.length) {
      return value.slice(0, LIST_LIMIT).map(id => this.store.get<User>('users', id)?.name ?? id).join(', ');
    }
    if (field === 'parentId' && typeof value === 'string') {
      const parent = this.store.get<Issue>('issues', value);
      return parent ? `${parent.key} ${parent.title}` : null;
    }
    if (field === 'cycleId' || field === 'moduleId' || field === 'releaseId') return issue[PLAN_FIELDS[field]] ?? null;
    return null;
  }

  private customDisplay(field: CustomFieldDefinition | undefined, value: CustomFieldValue): string | null {
    if (!field || value === null) return null;
    if (field.kind === 'user' && typeof value === 'string') return this.store.get<User>('users', value)?.name ?? null;
    if (field.kind === 'checkbox' || field.kind === 'select' || field.kind === 'multi_select') {
      return fieldValueLabel(field, Array.isArray(value) ? [...value].sort() : value) || null;
    }
    return null;
  }

  private insert(entry: IssueChangeHistoryEntry): void {
    this.store.db.prepare(`INSERT INTO ${TABLE}(id,issue_id,project_id,previous_project_id,issue_version,json) VALUES(?,?,?,?,?,?)`)
      .run(entry.id, entry.issueId, entry.projectId, entry.previousProjectId, entry.issueVersion, JSON.stringify(entry));
  }

  page(issueId: string, beforeVersion?: number, projectIds?: readonly string[]): IssueChangeHistoryPage {
    if (beforeVersion !== undefined && !validVersion(beforeVersion)) {
      throw new IssueChangeHistoryError(400, '업무 변경 이력을 조회할 버전을 확인해 주세요.');
    }
    const conditions = ['issue_id=?'];
    const bindings: (string | number)[] = [issueId];
    if (beforeVersion !== undefined) {
      conditions.push('issue_version<?');
      bindings.push(beforeVersion);
    }
    if (projectIds !== undefined) {
      conditions.push('project_id IN (SELECT value FROM json_each(?))', 'previous_project_id IN (SELECT value FROM json_each(?))');
      const scope = JSON.stringify(projectIds);
      bindings.push(scope, scope);
    }
    const rows = this.store.db.prepare(`SELECT json FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY issue_version DESC LIMIT ?`)
      .all(...bindings, PAGE_SIZE + 1) as { json: string }[];
    const entries = rows.slice(0, PAGE_SIZE).map(row => JSON.parse(row.json) as IssueChangeHistoryEntry);
    return { entries, nextBeforeVersion: rows.length > PAGE_SIZE ? entries.at(-1)!.issueVersion : null };
  }

  all(): IssueChangeHistoryEntry[] {
    const rows = this.store.db.prepare(`SELECT json FROM ${TABLE} ORDER BY issue_id, issue_version`).all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as IssueChangeHistoryEntry);
  }

  validateRestore(value: unknown, issues: readonly Issue[], projects: readonly Project[], users: readonly User[],
    exportedAt: unknown): IssueChangeHistoryEntry[] {
    if (!Array.isArray(value) || !validTime(exportedAt)) invalidBackup();
    const byIssue = new Map(issues.map(issue => [issue.id, issue]));
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const ids = new Set<string>(), issueVersions = new Set<string>();
    return value.map(item => {
      const { id, issueId, projectId, previousProjectId, issueVersion, actorId, actorName, origin, occurredAt, changes, ...rest } = record(item);
      if (Object.keys(rest).length || typeof id !== 'string' || !ID.test(id) || ids.has(id) || typeof issueId !== 'string' ||
          typeof projectId !== 'string' || typeof previousProjectId !== 'string' || !projectIds.has(projectId) ||
          !projectIds.has(previousProjectId) || !validVersion(issueVersion) || typeof actorId !== 'string' || !userIds.has(actorId) ||
          typeof actorName !== 'string' || !actorName.trim() || actorName.length > 80 ||
          (origin !== 'user' && origin !== 'automation') || !validTime(occurredAt) || occurredAt > exportedAt) invalidBackup();
      const issue = byIssue.get(issueId), versionKey = JSON.stringify([issueId, issueVersion]);
      if (!issue || !validVersion(issue.version) || issueVersion > issue.version || issueVersions.has(versionKey)) invalidBackup();
      const parsed = parseChanges(changes);
      const move = parsed.find(change => change.field === 'projectId');
      if (projectId === previousProjectId ? move !== undefined :
          move?.before.value !== excerpt(previousProjectId) || move.after.value !== excerpt(projectId)) invalidBackup();
      ids.add(id);
      issueVersions.add(versionKey);
      return { id, issueId, projectId, previousProjectId, issueVersion, actorId, actorName, origin, occurredAt, changes: parsed };
    });
  }

  replace(entries: readonly IssueChangeHistoryEntry[]): void {
    // The native restore transaction owns replacement of the issue rows and their history.
    this.store.db.exec(`DELETE FROM ${TABLE}`);
    for (const entry of entries) this.insert(entry);
  }

  purgeIssue(issueId: string): void {
    this.store.db.prepare(`DELETE FROM ${TABLE} WHERE issue_id=?`).run(issueId);
  }

  close(): void { this.unsubscribe(); }
}
