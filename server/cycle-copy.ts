import { randomUUID } from 'node:crypto';
import { calendarDate, calendarDay, CalendarError, createCalendarMath } from '../shared/calendar.js';
import { checkDependencySchedule, dependencyGuardFields, SCHEDULE_DATE_LABELS } from '../shared/schedule-dependencies.js';
import {
  MAX_CYCLE_COPY_DEPENDENCIES, MAX_CYCLE_COPY_ISSUES, MAX_CYCLE_COPY_SHIFT_DAYS, type CycleCopyInput, type CycleCopyPreview,
  type CycleCopyResult, type Dependency, type Issue, type PlanningItem, type PlanScheduleDates, type WorkCalendar,
} from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import { hasScheduleDependencyCycle } from './schedule-dependency-changes.js';
import type { Store } from './store.js';

const previewTtl = 30 * 60_000;
const resultTtl = 7 * 24 * 60 * 60_000;
const table = 'cycle_copy_requests';
type Parent = Pick<Issue, 'id' | 'projectId' | 'parentId'>;
type Preview = { kind: 'preview'; actorId: string; cycleId: string; input: CycleCopyInput; fingerprint: string };
type Applied = { kind: 'applied'; actorId: string; cycleId: string; result: Omit<CycleCopyResult, 'duplicate'> };
type Receipt = Preview | Applied;
type Hooks = {
  plan: (source: PlanningItem, name: string, dates: PlanScheduleDates, timestamp: string) => PlanningItem;
  issue: (source: Issue, target: Parent, parents: ReadonlyMap<string, Parent>, cycle: PlanningItem, dates: Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>) => Issue;
  order: (projectId: string) => string[];
  versions: (projectId: string) => { workflow: number; schema: number; initialStatus: string };
  calendar: (projectId: string) => WorkCalendar;
  validationMessage: (error: unknown) => string | null;
};
type Writes = {
  cycle: (cycle: PlanningItem) => void;
  issue: (issue: Issue) => Issue;
  dependency: (dependency: Dependency, batch: Dependency[]) => void;
};

export class CycleCopyError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { reason: 'stale_preview' | 'result_unavailable' }) {
    super(message);
  }
}

function stale(message = '이 사이클 복제 미리보기를 사용할 수 없습니다. 다시 검토해 주세요.'): never {
  throw new CycleCopyError(409, message, { reason: 'stale_preview' });
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function parseInput(value: unknown): CycleCopyInput {
  const invalid = () => new CycleCopyError(400, '사이클 이름·날짜 이동과 선택한 업무 버전을 확인해 주세요.');
  if (!isRecord(value) || Object.keys(value).some(field => !['expectedVersion', 'name', 'dateShiftDays', 'issues'].includes(field))) throw invalid();
  const { expectedVersion, name, dateShiftDays, issues } = value;
  if (!isVersion(expectedVersion) || typeof name !== 'string' || !name.trim() || name.length > 120 || /[\p{Cc}]/u.test(name) ||
      typeof dateShiftDays !== 'number' || !Number.isSafeInteger(dateShiftDays) || Math.abs(dateShiftDays) > MAX_CYCLE_COPY_SHIFT_DAYS ||
      !Array.isArray(issues) || !issues.length || issues.length > MAX_CYCLE_COPY_ISSUES) throw invalid();
  const seen = new Set<string>();
  const selection = issues.map(entry => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 ||
        !isVersion(entry.expectedVersion) || seen.has(entry.id)) throw invalid();
    seen.add(entry.id);
    return { id: entry.id, expectedVersion: entry.expectedVersion };
  });
  return { expectedVersion, name: name.trim(), dateShiftDays, issues: selection };
}

function shifted(date: string | null, days: number): string | null {
  return date === null || days === 0 ? date : calendarDate(calendarDay(date) + days);
}

function scheduleWarning(rule: Dependency, before: Issue, after: Issue, calendar: ReturnType<typeof createCalendarMath>): string | undefined {
  const result = checkDependencySchedule(rule, before, after, calendar);
  if (result.kind === 'conflict') return `후행 업무 ${SCHEDULE_DATE_LABELS[result.successorEndpoint]}은 ${result.requiredDate} 이후여야 합니다.`;
  if (result.kind === 'missing') return '선후행 일정에 필요한 날짜가 비어 있습니다.';
  if (result.kind === 'invalid') return result.reason;
}

export class CycleCopyService {
  constructor(private readonly store: Store, private readonly hooks: Hooks) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS cycle_copy_requests_expiry ON ${table}(expires_at);`);
  }

  private prepare(cycleId: string, input: CycleCopyInput) {
    const source = this.store.get<PlanningItem>('planning_items', cycleId);
    if (source?.kind !== 'cycle') throw new CycleCopyError(404, '복제할 사이클을 찾을 수 없습니다.');
    if (source.version !== input.expectedVersion) stale('원본 사이클이 변경되었습니다. 최신 계획을 확인해 주세요.');
    const selected = new Map(input.issues.map(({ id, expectedVersion }) => {
      const issue = this.store.get<Issue>('issues', id);
      if (!issue || issue.version !== expectedVersion || issue.projectId !== source.projectId || issue.cycleId !== source.id) {
        stale('선택한 업무가 변경되었거나 원본 사이클을 벗어났습니다. 최신 업무를 확인해 주세요.');
      }
      return [id, issue];
    }));
    const sourceRows = this.hooks.order(source.projectId).flatMap(id => selected.get(id) ?? []);
    if (sourceRows.length !== selected.size) stale('선택한 업무의 현재 순서를 확인해 주세요.');
    const days = input.dateShiftDays;
    const target = this.hooks.plan(source, input.name, {
      startDate: shifted(source.startDate, days), endDate: shifted(source.endDate, days), targetDate: shifted(source.targetDate, days),
    }, new Date().toISOString());
    const { name, ownerId, startDate, endDate, targetDate } = target;
    const calendar = this.hooks.calendar(source.projectId);
    const settings = this.hooks.versions(source.projectId);
    const preview: Omit<CycleCopyPreview, 'previewId' | 'expiresAt'> = {
      cycle: { name, ownerId, startDate, endDate, targetDate }, rows: [], dependencies: [], omitted: { parents: 0, dependencies: 0 }, errors: [],
    };

    const newIds = new Map(sourceRows.map(issue => [issue.id, randomUUID()]));
    const parents = new Map(sourceRows.map(issue => {
      const id = newIds.get(issue.id)!;
      const parentId = issue.parentId ? newIds.get(issue.parentId) ?? null : null;
      if (issue.parentId && !parentId) preview.omitted.parents++;
      return [id, { id, projectId: source.projectId, parentId }];
    }));
    const prepared = new Map<string, Issue>();
    for (const issue of sourceRows) {
      try {
        const dates = { startDate: shifted(issue.startDate, days), endDate: shifted(issue.endDate, days), dueDate: shifted(issue.dueDate, days) };
        const parent = parents.get(newIds.get(issue.id)!)!;
        const next = this.hooks.issue(issue, parent, parents, target, dates);
        prepared.set(issue.id, next);
        preview.rows.push({ sourceIssueId: issue.id, key: issue.key, title: next.title, assigneeId: next.assigneeId,
          parentKey: issue.parentId ? selected.get(issue.parentId)?.key ?? null : null, statusId: next.status, ...dates });
      } catch (error) {
        const message = error instanceof CalendarError ? error.message : this.hooks.validationMessage(error);
        if (!message) throw error;
        preview.errors.push({ key: issue.key, message });
      }
    }

    const ids = [...selected.keys()];
    const marks = ids.map(() => '?').join(',');
    const incident = (this.store.db.prepare(`SELECT json FROM dependencies
      WHERE predecessor_id IN (${marks}) OR successor_id IN (${marks}) ORDER BY id`).all(...ids, ...ids) as { json: string }[])
      .map(row => JSON.parse(row.json) as Dependency);
    const internal = incident.filter(link => selected.has(link.predecessorId) && selected.has(link.successorId));
    preview.omitted.dependencies = incident.length - internal.length;
    const dependencies: Dependency[] = [];
    if (internal.length > MAX_CYCLE_COPY_DEPENDENCIES) {
      preview.errors.push({ message: `선후행 연결은 ${MAX_CYCLE_COPY_DEPENDENCIES}개까지 복제할 수 있습니다. 업무를 줄여 주세요.` });
    } else {
      const math = createCalendarMath(calendar);
      for (const link of internal) {
        const before = prepared.get(link.predecessorId), after = prepared.get(link.successorId);
        if (!before || !after) continue;
        const { type, lagDays } = link;
        const warning = scheduleWarning(link, before, after, math);
        preview.dependencies.push({ predecessorKey: selected.get(link.predecessorId)!.key, successorKey: selected.get(link.successorId)!.key,
          type, lagDays, ...(warning ? { warning } : {}) });
        dependencies.push({ id: randomUUID(), predecessorId: before.id, successorId: after.id, type, lagDays, version: 1 });
      }
      if (hasScheduleDependencyCycle(dependencies)) preview.errors.push({ message: '선택한 업무의 선후행 연결에 순환이 있습니다.' });
    }
    const fingerprint = creationRequestFingerprint({ settings, calendarVersion: calendar.version, sourceVersion: source.version,
      orderedSources: sourceRows.map(({ id, version }) => [id, version]), links: internal.map(dependencyGuardFields),
      cycle: preview.cycle, rows: preview.rows, omitted: preview.omitted });
    return { target, prepared, dependencies, preview, fingerprint };
  }

  preview(cycleId: string, actorId: string, value: unknown): CycleCopyPreview {
    const input = parseInput(value);
    return this.store.transaction(() => {
      const { preview, fingerprint } = this.prepare(cycleId, input);
      if (preview.errors.length) return { ...preview, previewId: null, expiresAt: null };
      const time = Date.now();
      this.store.db.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(time);
      const previewId = randomUUID();
      const record: Preview = { kind: 'preview', actorId, cycleId, input, fingerprint };
      this.store.db.prepare(`INSERT INTO ${table}(id,expires_at,json) VALUES(?,?,?)`)
        .run(previewId, time + previewTtl, JSON.stringify(record));
      return { ...preview, previewId, expiresAt: new Date(time + previewTtl).toISOString() };
    });
  }

  apply(cycleId: string, actorId: string, value: unknown, writes: Writes): CycleCopyResult {
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.previewId !== 'string' || !creationRequestId.test(value.previewId)) {
      throw new CycleCopyError(400, '적용할 사이클 복제 미리보기 ID를 확인해 주세요.');
    }
    const id = value.previewId.toLowerCase();
    return this.store.transaction(() => {
      const time = Date.now();
      const row = this.store.db.prepare(`SELECT expires_at AS expiresAt,json FROM ${table} WHERE id=?`).get(id) as { expiresAt: number; json: string } | undefined;
      if (!row || row.expiresAt <= time) return stale();
      const record = JSON.parse(row.json) as Receipt;
      if (record.actorId !== actorId || record.cycleId !== cycleId) return stale();
      if (record.kind === 'applied') {
        const { cycle, issues } = record.result;
        const saved = this.store.get<PlanningItem>('planning_items', cycle.id);
        if (!saved || saved.projectId !== cycle.projectId || issues.some(issue => this.store.get<Issue>('issues', issue.id)?.projectId !== cycle.projectId)) {
          throw new CycleCopyError(409, '복제를 적용했습니다. 생성된 사이클과 업무의 현재 위치를 확인해 주세요.', { reason: 'result_unavailable' });
        }
        return { ...record.result, cycle: saved, duplicate: true };
      }
      const { target, prepared, dependencies, preview, fingerprint } = this.prepare(cycleId, record.input);
      if (preview.errors.length || fingerprint !== record.fingerprint) return stale('검토한 업무·연결 또는 프로젝트 설정이 변경되었습니다. 다시 검토해 주세요.');
      writes.cycle(target);
      const issues = [...prepared].map(([sourceIssueId, draft]) => {
        const { id: issueId, key } = writes.issue(draft);
        return { sourceIssueId, id: issueId, key };
      });
      for (const link of dependencies) writes.dependency(link, dependencies);
      const result = { cycle: target, issues, dependencies: dependencies.length };
      const receipt: Applied = { kind: 'applied', actorId, cycleId, result };
      this.store.db.prepare(`UPDATE ${table} SET expires_at=?,json=? WHERE id=?`).run(time + resultTtl, JSON.stringify(receipt), id);
      return { ...result, duplicate: false };
    });
  }

  clearForImport(): void {
    this.store.db.exec(`DELETE FROM ${table}`);
  }
}
