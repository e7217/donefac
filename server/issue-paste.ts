import { randomUUID } from 'node:crypto';
import { createCalendarMath } from '../shared/calendar.js';
import { SCHEDULE_DATE_LABELS, checkDependencySchedule } from '../shared/schedule-dependencies.js';
import {
  PRIORITY, type Dependency, type Issue, type IssuePasteDependencyPreview, type IssuePastePreview, type IssuePastePreviewRow,
  type IssuePasteResult, type ProjectIssueSchema, type ProjectWorkflow, type User, type WorkCalendar,
} from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import { normalizeIssuePasteKey, parseIssuePaste, type IssuePasteInputRow } from './issue-paste-parser.js';
import type { Store } from './store.js';

const PREVIEW_TTL = 30 * 60_000;
const RESULT_TTL = 7 * 24 * 60 * 60_000;
const STALE = '이 미리보기를 사용할 수 없습니다. 새로 검토해 주세요.';

type Scope = { projectId: string; actorId: string };
type Preview = Scope & { kind: 'preview'; rows: IssuePasteInputRow[]; fingerprint: string };
type Receipt = Scope & { kind: 'applied'; issues: Pick<Issue, 'id' | 'key'>[]; dependencies?: Dependency[] };
type Saved = { expiresAt: number; json: string };
type Prepared = { issue: Issue; review: IssuePastePreviewRow; input: IssuePasteInputRow };
type PlannedDependency = Omit<Dependency, 'id' | 'version'>;
type Hooks = {
  schema: (projectId: string) => ProjectIssueSchema;
  workflow: (projectId: string) => ProjectWorkflow;
  calendar: (projectId: string) => WorkCalendar;
  prepare: (input: Record<string, unknown>) => Issue;
  validationMessage: (error: unknown) => string | null;
};

export class IssuePasteError extends Error {
  constructor(public status: number, message: string, public details?: { reason: 'stale_preview' | 'result_unavailable' }) {
    super(message);
  }
}

function stale(message = STALE): never {
  throw new IssuePasteError(409, message, { reason: 'stale_preview' });
}

const normalized = (value: string) => value.normalize('NFC').toLowerCase();
function resolveId<T extends { id: string }>(value: string, choices: T[], label: string, name: (choice: T) => string): string {
  const byId = choices.find(choice => choice.id === value);
  if (byId) return byId.id;
  const matches = choices.filter(choice => normalized(name(choice)) === normalized(value));
  if (matches.length > 1) throw new IssuePasteError(400, `${label} 이름이 여러 개와 일치합니다. 정확한 ID를 사용해 주세요.`);
  if (!matches.length) throw new IssuePasteError(400, `${label}을(를) 찾을 수 없습니다. 현재 프로젝트와 팀의 값을 확인해 주세요.`);
  return matches[0].id;
}

function resolveAssignee(value: string, users: User[]): string {
  const exact = users.find(user => user.id === value);
  if (exact) return exact.id;
  const emails = users.filter(user => normalized(user.email) === normalized(value));
  if (emails.length) return resolveId(value, emails, '담당자 이메일', user => user.email);
  return resolveId(value, users, '담당자', user => user.name);
}

const priorities = Object.entries(PRIORITY).map(([id, label]) => ({ id, label }));

function scheduleWarning(rule: Pick<Dependency, 'type' | 'lagDays'>, predecessor: Issue, successor: Issue,
  math: ReturnType<typeof createCalendarMath>): string | undefined {
  const check = checkDependencySchedule(rule, predecessor, successor, math);
  if (check.kind === 'invalid') return check.reason;
  if (check.kind === 'conflict') return `후행 업무 ${SCHEDULE_DATE_LABELS[check.successorEndpoint]}은 ${check.requiredDate} 이후여야 합니다.`;
  if (check.kind === 'missing') {
    const missing = [!check.predecessorDate && `선행 업무 ${SCHEDULE_DATE_LABELS[check.predecessorEndpoint]}`,
      !check.successorDate && `후행 업무 ${SCHEDULE_DATE_LABELS[check.successorEndpoint]}`].filter(Boolean);
    return `${missing.join(' · ')}이 미정입니다.`;
  }
}

export class IssuePasteService {
  constructor(private readonly store: Store, private readonly hooks: Hooks) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_paste_requests (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issue_paste_requests_expiry ON issue_paste_requests(expires_at);`);
  }

  private existingPredecessors(projectId: string, wanted: ReadonlySet<string>) {
    const matches = new Map<string, Issue | null>();
    if (!wanted.size) return matches;
    const rows = this.store.db.prepare("SELECT id, json_extract(json,'$.key') AS key FROM issues WHERE project_id=?");
    for (const row of rows.iterate(projectId)) {
      if (typeof row.key !== 'string') continue;
      const key = normalizeIssuePasteKey(row.key);
      if (!wanted.has(key)) continue;
      matches.set(key, matches.has(key) ? null : this.store.get<Issue>('issues', String(row.id)) ?? null);
    }
    return matches;
  }

  private reviewDependencies(projectId: string, rows: Prepared[], errors: IssuePastePreview['errors']) {
    const dependencies: PlannedDependency[] = [];
    const linkedRows = rows.filter(row => row.input.dependencies?.length);
    if (!linkedRows.length) return { dependencies, guard: undefined };

    const local = new Map<string, Prepared | null>();
    for (const row of rows) {
      if (!row.input.localKey) continue;
      const key = normalizeIssuePasteKey(row.input.localKey);
      local.set(key, local.has(key) ? null : row);
    }
    const requestedKeys = new Set<string>();
    for (const row of linkedRows) for (const { predecessor } of row.input.dependencies ?? []) {
      if (predecessor.kind === 'existing') requestedKeys.add(normalizeIssuePasteKey(predecessor.key));
    }
    const existing = this.existingPredecessors(projectId, requestedKeys);
    const calendar = this.hooks.calendar(projectId);
    const math = createCalendarMath(calendar);
    const observedVersions = new Map<string, number>();

    for (const { issue, input, review } of linkedRows) {
      for (const { predecessor, type, lagDays } of input.dependencies ?? []) {
        let source: Issue;
        let preview: IssuePasteDependencyPreview['predecessor'];
        if (predecessor.kind === 'new') {
          const match = local.get(normalizeIssuePasteKey(predecessor.localKey));
          if (!match) {
            errors.push({ line: input.line, message: `선행 업무 new:${predecessor.localKey}의 새 업무 행을 확인해 주세요.` });
            continue;
          }
          source = match.issue;
          preview = { kind: 'new', line: match.input.line, temporaryKey: match.input.localKey!, title: source.title };
        } else {
          const match = existing.get(normalizeIssuePasteKey(predecessor.key));
          if (!match) {
            const message = match === null ? '현재 프로젝트의 여러 업무와 일치합니다.' : '현재 프로젝트에 해당하는 업무가 없습니다.';
            errors.push({ line: input.line, message: `선행 업무 키 ${predecessor.key} · ${message}` });
            continue;
          }
          source = match;
          observedVersions.set(source.id, source.version);
          preview = { kind: 'existing', issueId: source.id, key: source.key, title: source.title };
        }
        const dependency = { predecessorId: source.id, successorId: issue.id, type, lagDays };
        const warning = scheduleWarning(dependency, source, issue, math);
        (review.predecessors ??= []).push({ predecessor: preview, type, lagDays, ...(warning ? { warning } : {}) });
        dependencies.push(dependency);
      }
    }
    return { dependencies, guard: { calendarVersion: calendar.version, predecessorVersions: [...observedVersions] } };
  }

  private review(projectId: string, input: IssuePasteInputRow[]) {
    const schema = this.hooks.schema(projectId);
    const workflow = this.hooks.workflow(projectId);
    const activeTypes = schema.issueTypes.filter(type => !type.archived);
    const users = this.store.all<User>('users');
    const teamNames = new Set<string>();
    const duplicateNames = new Set<string>();
    for (const user of users) {
      const name = normalized(user.name);
      if (teamNames.has(name)) duplicateNames.add(name);
      teamNames.add(name);
    }
    const assigneeLabels = new Map(users.map(({ id, name, email }) => [
      id, duplicateNames.has(normalized(name)) ? `${name} (${email})` : name,
    ]));
    const typeNames = new Map(activeTypes.map(({ id, name }) => [id, name]));
    const statusLabels = new Map(workflow.statuses.map(({ id, label }) => [id, label]));
    const rows: Prepared[] = [];
    const errors: IssuePastePreview['errors'] = [];
    for (const row of input) {
      const { line, title, description, type, status, priority, assignee, startDate, endDate, dueDate, labels, localKey } = row;
      try {
        const issue = this.hooks.prepare({
          projectId, title,
          ...(description !== undefined && { description }),
          ...(type && { type: resolveId(type, activeTypes, '업무 유형', option => option.name) }),
          ...(status && { status: resolveId(status, workflow.statuses, '상태', option => option.label) }),
          ...(priority && { priority: resolveId(normalized(priority), priorities, '우선순위', option => option.label) }),
          ...(assignee && { assigneeId: resolveAssignee(assignee, users) }),
          startDate, endDate, dueDate,
          ...(labels && { labels }),
        });
        rows.push({
          issue, input: row,
          review: {
            line, title: issue.title, description: issue.description, type: issue.type, status: issue.status,
            priority: issue.priority, assigneeId: issue.assigneeId, startDate: issue.startDate,
            endDate: issue.endDate, dueDate: issue.dueDate, labels: issue.labels,
            typeName: typeNames.get(issue.type) ?? issue.type, statusLabel: statusLabels.get(issue.status) ?? issue.status,
            assigneeLabel: issue.assigneeId ? assigneeLabels.get(issue.assigneeId) ?? issue.assigneeId : null,
            ...(localKey ? { temporaryKey: localKey } : {}),
          },
        });
      } catch (error) {
        const message = error instanceof IssuePasteError ? error.message : this.hooks.validationMessage(error);
        if (!message) throw error;
        errors.push({ line, message });
      }
    }
    const { dependencies, guard } = this.reviewDependencies(projectId, rows, errors);
    const fingerprint = creationRequestFingerprint({
      schemaVersion: schema.version, workflowVersion: workflow.version,
      rows: rows.map(row => row.review),
      ...(guard ? { dependencyGuard: guard } : {}),
    });
    return { rows, errors, fingerprint, dependencies };
  }

  preview(scope: Scope, text: unknown): IssuePastePreview {
    const parsed = parseIssuePaste(text);
    return this.store.transaction(() => {
      const current = Date.now();
      const reviewed = this.review(scope.projectId, parsed.rows);
      const rows = reviewed.rows.map(row => row.review);
      const errors = [...parsed.errors, ...reviewed.errors].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      if (errors.length || !rows.length) return { previewId: null, rows, errors };
      this.store.db.prepare('DELETE FROM issue_paste_requests WHERE expires_at <= ?').run(current);
      const previewId = randomUUID();
      const record: Preview = { ...scope, kind: 'preview', rows: parsed.rows, fingerprint: reviewed.fingerprint };
      this.store.db.prepare('INSERT INTO issue_paste_requests(id,expires_at,json) VALUES (?,?,?)')
        .run(previewId, current + PREVIEW_TTL, JSON.stringify(record));
      return { previewId, rows, errors };
    });
  }

  apply(scope: Scope, previewId: unknown, commit: (issue: Issue) => Issue,
    commitDependency: (dependency: Dependency, batch: Dependency[]) => Dependency): IssuePasteResult {
    if (typeof previewId !== 'string' || !creationRequestId.test(previewId)) {
      throw new IssuePasteError(400, '업무 붙여넣기 미리보기를 확인해 주세요.');
    }
    const id = previewId.toLowerCase();
    return this.store.transaction(() => {
      const current = Date.now();
      const saved = this.store.db.prepare('SELECT expires_at AS expiresAt, json FROM issue_paste_requests WHERE id = ?')
        .get(id) as Saved | undefined;
      if (!saved || saved.expiresAt <= current) return stale();
      const record = JSON.parse(saved.json) as Preview | Receipt;
      if (record.actorId !== scope.actorId || record.projectId !== scope.projectId) return stale();
      if (record.kind === 'applied') {
        const issues: Issue[] = [];
        for (const entry of record.issues) {
          const issue = this.store.get<Issue>('issues', entry.id);
          if (!issue || issue.projectId !== scope.projectId || issue.key !== entry.key) {
            throw new IssuePasteError(409, '이 붙여넣기는 이미 적용했습니다. 생성한 업무의 현재 위치를 목록이나 휴지통에서 확인해 주세요.', { reason: 'result_unavailable' });
          }
          issues.push(issue);
        }
        return { issues, duplicate: true, ...(record.dependencies ? { dependencies: record.dependencies } : {}) };
      }

      const reviewed = this.review(scope.projectId, record.rows);
      if (reviewed.errors.length || reviewed.fingerprint !== record.fingerprint) {
        return stale(record.rows.some(row => row.dependencies?.length)
          ? '검토 뒤 업무 양식, 선행 업무 또는 작업 달력이 바뀌었습니다. 다시 미리보기로 확인해 주세요.'
          : '검토 뒤 업무 양식, 상태 또는 담당자 정보가 바뀌었습니다. 다시 미리보기로 확인해 주세요.');
      }
      const issues = reviewed.rows.map(row => commit(row.issue));
      const batch = reviewed.dependencies.map(dependency => ({ ...dependency, id: randomUUID(), version: 1 }));
      // Every edge ends at one of the new tickets, so no pre-existing edge can join a cycle through the batch.
      const dependencies = batch.map(dependency => commitDependency(dependency, batch));
      const linked = dependencies.length ? { dependencies } : {};
      const receipt: Receipt = { ...scope, kind: 'applied', issues: issues.map(({ id: issueId, key }) => ({ id: issueId, key })), ...linked };
      this.store.db.prepare('UPDATE issue_paste_requests SET expires_at = ?, json = ? WHERE id = ?')
        .run(current + RESULT_TTL, JSON.stringify(receipt), id);
      return { issues, duplicate: false, ...linked };
    });
  }

  resetForImport(): void {
    this.store.db.exec('DELETE FROM issue_paste_requests');
  }
}
