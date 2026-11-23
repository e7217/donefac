import { randomUUID } from 'node:crypto';
import type { Issue, IssueReportEvent, MutationOrigin, Project, ProjectWorkflow, ReportingCoverage, ReportingLedgerData, ReportIssueState } from '../shared/types.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import type { Store, StoreChange } from './store.js';

export class ReportingLedgerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function invalid(message: string): never { throw new ReportingLedgerError(400, message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('보고 이력 객체를 확인해 주세요.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label}을(를) 확인해 주세요.`);
  return value;
}
function nullableText(value: unknown, label: string, max = 200): string | null { return value === null ? null : text(value, label, max); }
function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(`${label}은 밀리초를 포함하는 UTC ISO 시각이어야 합니다.`);
  return value;
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid('보고 이력의 날짜를 확인해 주세요.');
  return value;
}
const categories = new Set(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']);
const origins = new Set<MutationOrigin>(['user', 'gitlab', 'automation', 'system', 'import', 'restore']);
function positive(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label}을(를) 확인해 주세요.`); return Number(value); }
function parseState(value: unknown): ReportIssueState {
  const source = object(value);
  if (typeof source.category !== 'string' || !categories.has(source.category)) invalid('보고 이력의 상태 분류를 확인해 주세요.');
  const hasCycle = Object.hasOwn(source, 'cycleId');
  const hasEstimate = Object.hasOwn(source, 'estimate');
  const estimate = source.estimate;
  if (hasCycle !== hasEstimate || hasEstimate && estimate !== null &&
    (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0 || estimate > 100_000)) {
    invalid('보고 이력의 사이클과 예상 작업량을 확인해 주세요.');
  }
  return {
    issueId: text(source.issueId, '업무 ID'), projectId: text(source.projectId, '프로젝트 ID'),
    key: text(source.key, '업무 키'), title: text(source.title, '업무 제목', 1000), type: text(source.type, '업무 유형'),
    statusId: text(source.statusId, '상태 ID'), statusLabel: text(source.statusLabel, '상태 이름', 300), category: source.category as ReportIssueState['category'],
    assigneeId: nullableText(source.assigneeId, '담당자 ID'), startDate: date(source.startDate), endDate: date(source.endDate), dueDate: date(source.dueDate),
    ...(hasCycle ? { cycleId: nullableText(source.cycleId, '사이클 ID'), estimate: estimate as number | null } : {}),
  };
}
function same(a: ReportIssueState | null, b: ReportIssueState | null): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function hasCycleState(state: ReportIssueState | null): boolean { return state !== null && Object.hasOwn(state, 'cycleId'); }
function weeklyState<T extends ReportIssueState | null>(state: T): T {
  if (!state) return state;
  const weekly = { ...state };
  delete weekly.cycleId;
  delete weekly.estimate;
  return weekly;
}
function jsonRows<T>(rows: unknown): T[] { return (rows as { json: string }[]).map(row => JSON.parse(row.json) as T); }
export type PreviousIssueKey = { projectId: string; key: string };

export function previousIssueKeys(store: Store): Map<string, PreviousIssueKey[]> {
  const rows = store.db.prepare(`SELECT json_extract(json,'$.issueId') AS issueId, project_id AS projectId,
    json_extract(json,'$.before.key') AS key FROM reporting_events WHERE json_extract(json,'$.kind')='moved_out' ORDER BY sequence`)
    .all() as (PreviousIssueKey & { issueId: string })[];
  const result = new Map<string, PreviousIssueKey[]>();
  for (const { issueId, projectId, key } of rows) {
    const entries = result.get(issueId);
    if (entries) entries.push({ projectId, key });
    else result.set(issueId, [{ projectId, key }]);
  }
  return result;
}

/** A permanent observation ledger. Baselines say what was known at collection time,
 * never when an imported or previously existing issue supposedly changed state. */
export class ReportingLedger {
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly store: Store, private readonly lookup: (projectId: string) => ProjectWorkflow, private readonly clock: () => string = () => new Date().toISOString()) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS reporting_coverage(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,ended_at TEXT,json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reporting_one_active ON reporting_coverage((1)) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS reporting_events(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE,coverage_id TEXT NOT NULL REFERENCES reporting_coverage(id),project_id TEXT NOT NULL,occurred_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reporting_events_project_time ON reporting_events(project_id,occurred_at,sequence);
      CREATE INDEX IF NOT EXISTS reporting_events_time ON reporting_events(occurred_at,sequence);
      CREATE INDEX IF NOT EXISTS reporting_events_issue_sequence ON reporting_events(coverage_id,project_id,sequence);
      CREATE INDEX IF NOT EXISTS reporting_moved_out ON reporting_events(sequence) WHERE json_extract(json,'$.kind')='moved_out';
      CREATE INDEX IF NOT EXISTS reporting_events_cycle_before ON reporting_events(project_id,json_extract(json,'$.before.cycleId'),occurred_at,sequence)
        WHERE json_extract(json,'$.before.cycleId') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS reporting_events_cycle_after ON reporting_events(project_id,json_extract(json,'$.after.cycleId'),occurred_at,sequence)
        WHERE json_extract(json,'$.after.cycleId') IS NOT NULL;
    `);
  }
  private states(projectId?: string): Issue[] {
    const rows = projectId === undefined
      ? this.store.db.prepare('SELECT json FROM issues').all()
      : this.store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY id').all(projectId);
    return jsonRows<Issue>(rows);
  }
  private state(issue: Issue, workflow = this.lookup(issue.projectId)): ReportIssueState {
    const status = workflow.statuses.find(value => value.id === issue.status);
    if (!status) invalid(`보고 이력: ${issue.key}의 상태가 워크플로에 없습니다.`);
    return parseState({
      issueId: issue.id, projectId: issue.projectId, key: issue.key, title: issue.title, type: issue.type,
      statusId: issue.status, statusLabel: status.label, category: status.category,
      assigneeId: issue.assigneeId, startDate: issue.startDate, endDate: issue.endDate, dueDate: issue.dueDate,
      cycleId: issue.cycleId ?? null, estimate: issue.estimate ?? null,
    });
  }
  private requireProject(projectId: string): void {
    text(projectId, '프로젝트 ID');
    if (!this.store.get<Project>('projects', projectId)) throw new ReportingLedgerError(404, '보고서 프로젝트를 찾을 수 없습니다.');
  }
  private coverage(): ReportingCoverage[] {
    const rows = this.store.db.prepare('SELECT json FROM reporting_coverage ORDER BY started_at,ended_at IS NULL,ended_at,rowid').all();
    return jsonRows<ReportingCoverage>(rows);
  }
  private events(projectId?: string): IssueReportEvent[] {
    const rows = projectId === undefined
      ? this.store.db.prepare('SELECT json FROM reporting_events ORDER BY occurred_at,sequence').all()
      : this.store.db.prepare('SELECT json FROM reporting_events WHERE project_id=? ORDER BY occurred_at,sequence').all(projectId);
    return jsonRows<IssueReportEvent>(rows);
  }
  private time(): string {
    const candidate = instant(this.clock(), '수집 시각');
    const row = this.store.db.prepare(`
      SELECT MAX(value) AS value FROM (
        SELECT MAX(occurred_at) AS value FROM reporting_events
        UNION ALL SELECT MAX(started_at) FROM reporting_coverage
        UNION ALL SELECT MAX(ended_at) FROM reporting_coverage
      )
    `).get() as { value: string | null };
    return row.value && row.value > candidate ? row.value : candidate;
  }
  private active(): ReportingCoverage {
    const row = this.store.db.prepare('SELECT json FROM reporting_coverage WHERE ended_at IS NULL').get() as { json: string } | undefined;
    if (!row) invalid('보고 수집 구간이 시작되지 않았습니다.');
    return JSON.parse(row.json) as ReportingCoverage;
  }
  private putCoverage(value: ReportingCoverage): void { this.store.db.prepare('INSERT INTO reporting_coverage(id,started_at,ended_at,json) VALUES(?,?,?,?)').run(value.id, value.startedAt, value.endedAt, JSON.stringify(value)); }
  private putEvent(value: IssueReportEvent): void {
    this.store.db.prepare('INSERT INTO reporting_events(id,sequence,coverage_id,project_id,occurred_at,json) VALUES(?,?,?,?,?,?)')
      .run(value.id, value.sequence, value.coverageId, value.projectId, value.occurredAt, JSON.stringify(value));
  }
  private append(kind: IssueReportEvent['kind'], before: ReportIssueState | null, after: ReportIssueState | null, context: StoreChange['context'], workflowVersion: number, occurredAt = this.time()): void {
    const state = after || before;
    if (!state) invalid('보고 사건에 업무 상태가 필요합니다.');
    const row = this.store.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM reporting_events').get() as { sequence: number };
    if (!Number.isSafeInteger(row.sequence)) invalid('보고 이력 순번 범위를 초과했습니다.');
    this.putEvent({
      id: randomUUID(), sequence: row.sequence, coverageId: this.active().id, projectId: state.projectId,
      issueId: state.issueId, occurredAt, kind, actorId: context.actorId, origin: context.origin,
      workflowVersion, before, after,
    });
  }
  private capture(change: StoreChange): void {
    if (change.context.origin === 'import') return;
    if (change.table === 'issues') {
      const before = change.before as Issue | undefined, after = change.after as Issue | undefined;
      if (!before && !after) return;
      if (before && after && before.projectId !== after.projectId) {
        const source = this.lookup(before.projectId);
        const target = this.lookup(after.projectId);
        const at = this.time();
        this.append('moved_out', this.state(before, source), null, change.context, source.version, at);
        this.append('moved_in', null, this.state(after, target), change.context, target.version, at);
        return;
      }
      const workflow = this.lookup((after || before)!.projectId), oldState = before ? this.state(before, workflow) : null, newState = after ? this.state(after, workflow) : null;
      if (same(oldState, newState)) return;
      const kind = !before ? (change.context.origin === 'restore' ? 'restored' : 'created') : !after ? 'deleted' : 'changed';
      this.append(kind, oldState, newState, change.context, workflow.version);
      return;
    }
    const next = change.after as ProjectWorkflow | undefined;
    if (!next) return;
    const previous = change.before as ProjectWorkflow | undefined || defaultWorkflow(next.projectId);
    for (const issue of this.states(next.projectId)) {
      const before = this.state(issue, previous), after = this.state(issue, next);
      if (!same(before, after)) this.append('reclassified', before, after, change.context, next.version);
    }
  }
  private startCycleObservation(active: ReportingCoverage): void {
    const startedAt = this.time();
    this.store.db.prepare('UPDATE reporting_coverage SET json=? WHERE id=?')
      .run(JSON.stringify({ ...active, cycleStartedAt: startedAt }), active.id);
    const lastObserved = jsonRows<IssueReportEvent>(this.store.db.prepare(`
      SELECT json FROM reporting_events WHERE sequence IN (
        SELECT MAX(sequence) FROM reporting_events WHERE coverage_id=? GROUP BY json_extract(json,'$.issueId')
      )`).all(active.id));
    const previous = new Map(lastObserved.flatMap(event => event.after ? [[event.issueId, event.after] as const] : []));
    const issues = this.states();
    if (previous.size !== issues.length) invalid('기존 보고 이력과 현재 업무가 일치해야 사이클 수집을 시작할 수 있습니다.');
    for (const issue of issues) {
      const workflow = this.lookup(issue.projectId);
      const after = this.state(issue, workflow);
      const before = previous.get(issue.id) ?? null;
      if (!same(before, weeklyState(after))) invalid('기존 보고 이력과 현재 업무가 일치해야 사이클 수집을 시작할 수 있습니다.');
      this.append('cycle_baseline', before, after, { actorId: null, origin: 'system' }, workflow.version, startedAt);
    }
  }
  start(): void {
    if (this.unsubscribe) return;
    this.store.transaction(() => {
      if (this.store.db.prepare('SELECT id FROM reporting_coverage WHERE ended_at IS NULL').get()) {
        const active = this.active();
        if (!active.cycleStartedAt) this.startCycleObservation(active);
        return;
      }
      const at = this.time();
      this.putCoverage({ id: randomUUID(), startedAt: at, endedAt: null, reason: this.coverage().length ? 'restore' : 'initial', cycleStartedAt: at });
      for (const issue of this.states()) this.append('baseline', null, this.state(issue), { actorId: null, origin: 'system' }, this.lookup(issue.projectId).version, at);
    });
    this.unsubscribe = this.store.onChange(change => this.capture(change), ['issues', 'workflows']);
  }
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  current(projectId: string): ReportIssueState[] {
    this.requireProject(projectId);
    return this.states(projectId).map(issue => weeklyState(this.state(issue)));
  }
  read(projectId: string): ReportingLedgerData {
    this.requireProject(projectId);
    const coverage = this.coverage().map(value => {
      const weekly = { ...value };
      delete weekly.cycleStartedAt;
      return weekly;
    });
    const events: IssueReportEvent[] = [];
    for (const event of this.events(projectId)) {
      if (event.kind === 'cycle_baseline') continue;
      const before = weeklyState(event.before), after = weeklyState(event.after);
      if (event.kind !== 'changed' || !same(before, after)) events.push({ ...event, before, after });
    }
    return { coverage, events };
  }
  readCycle(projectId: string, cycleId: string, through?: string): ReportingLedgerData {
    this.requireProject(projectId);
    text(cycleId, '사이클 ID');
    const at = through === undefined ? this.time() : instant(through, '조회 기준 시각');
    // Separate indexed branches cover removals and additions without duplicating in-cycle updates.
    const events = jsonRows<IssueReportEvent>(this.store.db.prepare(`
      SELECT json FROM (
        SELECT occurred_at,sequence,json FROM reporting_events
          WHERE project_id=? AND json_extract(json,'$.before.cycleId')=? AND occurred_at<=?
        UNION ALL
        SELECT occurred_at,sequence,json FROM reporting_events
          WHERE project_id=? AND json_extract(json,'$.after.cycleId')=? AND occurred_at<=? AND json_extract(json,'$.before.cycleId') IS NOT ?
      ) ORDER BY occurred_at,sequence`).all(projectId, cycleId, at, projectId, cycleId, at, cycleId));
    return { coverage: this.coverage(), events };
  }
  exportData(through: string): ReportingLedgerData {
    const at = instant(through, '내보내기 기준 시각'), coverage = this.coverage(), events = this.events();
    if (coverage.some(value => value.startedAt > at || value.endedAt !== null && value.endedAt > at) || events.some(value => value.occurredAt > at)) invalid('내보내기 기준 시각이 수집된 보고 이력보다 이전입니다.');
    return { coverage: coverage.map(value => ({ ...value, endedAt: value.endedAt || at })), events };
  }
  baselineImportedIssues(issues: Issue[]): void {
    const at = this.time(), coverageId = this.active().id;
    const existing = new Map(this.events().filter(event => event.coverageId === coverageId).map(event => [event.issueId, event.after]));
    for (const issue of issues) {
      const state = this.state(issue);
      if (existing.has(issue.id)) { if (!same(existing.get(issue.id) || null, state)) invalid('이미 수집한 업무를 이관 기준 상태로 덮어쓸 수 없습니다.'); continue; }
      this.append('baseline', null, state, { actorId: null, origin: 'import' }, this.lookup(issue.projectId).version, at);
      existing.set(issue.id, state);
    }
  }
  recordImportedIssueUpdate(before: Issue, after: Issue, actorId: string): void {
    const workflow = this.lookup(before.projectId);
    const prior = this.state(before, workflow), updated = this.state(after, workflow);
    if (!same(prior, updated)) this.append('changed', prior, updated, { actorId, origin: 'import' }, workflow.version);
  }
  validateRestore(raw: unknown, exportedAt: string, restoreAt: string, projects: Project[]): ReportingLedgerData {
    const exported = instant(exportedAt, '백업 내보내기 시각'), restore = instant(restoreAt, '복원 시각'), source = object(raw);
    if (!Array.isArray(source.coverage) || !Array.isArray(source.events)) invalid('백업의 보고 수집 구간과 사건 목록이 필요합니다.');
    const projectIds = new Set(projects.map(project => project.id)), coverageIds = new Set<string>(), eventIds = new Set<string>(), sequences = new Set<number>();
    let lastEnd: string | null = null;
    const coverage: ReportingCoverage[] = source.coverage.map(raw => {
      const value = object(raw), id = text(value.id, '수집 구간 ID'), startedAt = instant(value.startedAt, '수집 시작 시각'), endedAt = instant(value.endedAt, '수집 종료 시각');
      if (coverageIds.has(id) || endedAt < startedAt || endedAt > exported || endedAt > restore || lastEnd !== null && startedAt < lastEnd || value.reason !== 'initial' && value.reason !== 'restore') invalid('백업의 보고 수집 구간이 중복되거나 겹치거나 시각 범위를 벗어납니다.');
      const cycleStartedAt = Object.hasOwn(value, 'cycleStartedAt') ? instant(value.cycleStartedAt, '사이클 수집 시작 시각') : undefined;
      if (cycleStartedAt !== undefined && (cycleStartedAt < startedAt || cycleStartedAt > endedAt)) {
        invalid('사이클 수집 시작 시각이 보고 구간을 벗어납니다.');
      }
      coverageIds.add(id); lastEnd = endedAt;
      return { id, startedAt, endedAt, reason: value.reason, ...(cycleStartedAt === undefined ? {} : { cycleStartedAt }) };
    });
    const byCoverage = new Map(coverage.map(value => [value.id, value])), states = new Map<string, ReportIssueState | null>();
    const missingCycleStates = new Set<string>();
    let lastAt = '', lastSequence = 0;
    let transfer: { state: ReportIssueState; coverageId: string; actorId: string | null; occurredAt: string; sequence: number } | null = null;
    const events: IssueReportEvent[] = source.events.map(raw => {
      const value = object(raw), id = text(value.id, '보고 사건 ID'), sequence = positive(value.sequence, '보고 사건 순번'), coverageId = text(value.coverageId, '수집 구간 ID'), projectId = text(value.projectId, '프로젝트 ID'), issueId = text(value.issueId, '업무 ID');
      const occurredAt = instant(value.occurredAt, '보고 사건 시각'), epoch = byCoverage.get(coverageId), actorId = nullableText(value.actorId, '작업자 ID'), workflowVersion = positive(value.workflowVersion, '워크플로 버전');
      if (!epoch || !projectIds.has(projectId) || eventIds.has(id) || sequences.has(sequence) ||
          sequence <= lastSequence || occurredAt < lastAt || occurredAt < epoch.startedAt || occurredAt > epoch.endedAt! ||
          typeof value.origin !== 'string' || !origins.has(value.origin as MutationOrigin)) {
        invalid('보고 사건의 참조·순서·발생 시각이 올바르지 않습니다.');
      }
      if (!['baseline', 'cycle_baseline', 'created', 'changed', 'reclassified', 'deleted', 'restored', 'moved_out', 'moved_in'].includes(String(value.kind)) || (value.kind === 'restored') !== (value.origin === 'restore')) invalid('보고 사건 종류를 확인해 주세요.');
      const before = value.before === null ? null : parseState(value.before), after = value.after === null ? null : parseState(value.after), kind = value.kind as IssueReportEvent['kind'];
      for (const state of [before, after]) if (state && (state.issueId !== issueId || state.projectId !== projectId)) invalid('보고 사건과 업무 상태의 ID가 다릅니다.');
      const invalidCreation = (kind === 'baseline' || kind === 'created' || kind === 'restored' || kind === 'moved_in') && (before !== null || after === null);
      const invalidDeletion = (kind === 'deleted' || kind === 'moved_out') && (before === null || after !== null);
      const invalidChange = (kind === 'changed' || kind === 'reclassified') && (before === null || after === null || same(before, after));
      if (invalidCreation || invalidDeletion || invalidChange) invalid('보고 사건의 이전·이후 상태가 올바르지 않습니다.');
      const cycleStates = [before, after].filter((state): state is ReportIssueState => state !== null).map(hasCycleState);
      if (kind === 'cycle_baseline') {
        if (occurredAt !== epoch.cycleStartedAt || value.origin !== 'system' || actorId !== null ||
          !before || !after || hasCycleState(before) || !hasCycleState(after) || !same(before, weeklyState(after))) {
          invalid('사이클 수집 기준 상태를 확인해 주세요.');
        }
      } else if (cycleStates.includes(true) && cycleStates.includes(false) ||
        cycleStates.includes(true) && (epoch.cycleStartedAt === undefined || occurredAt < epoch.cycleStartedAt) ||
        cycleStates.includes(false) && epoch.cycleStartedAt !== undefined && occurredAt > epoch.cycleStartedAt) {
        invalid('사이클 관측 상태와 수집 시각이 일치하지 않습니다.');
      }
      if (transfer || kind === 'moved_in') {
        if (!transfer || kind !== 'moved_in' || value.origin !== 'user' || !after || transfer.state.issueId !== issueId ||
          transfer.state.projectId === projectId || transfer.state.key === after.key || transfer.coverageId !== coverageId ||
          transfer.actorId !== actorId || transfer.occurredAt !== occurredAt || transfer.sequence + 1 !== sequence) {
          invalid('업무 프로젝트 이동의 출발·도착 보고 기록이 일치하지 않습니다.');
        }
        transfer = null;
      } else if (kind === 'moved_out') {
        if (value.origin !== 'user' || !before) invalid('업무 프로젝트 이동의 출발 보고 기록이 올바르지 않습니다.');
        transfer = { state: before, coverageId, actorId, occurredAt, sequence };
      }
      const key = `${coverageId}\0${issueId}`, previous = states.get(key) || null;
      if (!same(previous, before) || kind === 'baseline' && states.has(key)) invalid('같은 수집 구간의 업무 변경 이력이 이어지지 않습니다.');
      if (kind === 'reclassified' && !same({ ...before!, category: after!.category, statusLabel: after!.statusLabel }, after)) invalid('워크플로 재분류 사건에 업무 자체 변경이 섞여 있습니다.');
      if (epoch.cycleStartedAt !== undefined && after && !hasCycleState(after)) missingCycleStates.add(key);
      else missingCycleStates.delete(key);
      eventIds.add(id); sequences.add(sequence); states.set(key, after); lastAt = occurredAt; lastSequence = sequence;
      return { id, sequence, coverageId, projectId, issueId, occurredAt, kind, actorId, origin: value.origin as MutationOrigin, workflowVersion, before, after };
    });
    if (transfer) invalid('업무 프로젝트 이동의 도착 보고 기록이 없습니다.');
    if (missingCycleStates.size) invalid('사이클 수집을 시작한 구간에 관측하지 않은 업무 상태가 남아 있습니다.');
    return { coverage, events };
  }
  replaceRestored(data: ReportingLedgerData, at: string): void {
    const restoredAt = instant(at, '복원 시각');
    this.store.db.exec('DELETE FROM reporting_events; DELETE FROM reporting_coverage;');
    for (const value of data.coverage) this.putCoverage(value);
    for (const value of data.events) this.putEvent(value);
    this.putCoverage({ id: randomUUID(), startedAt: restoredAt, endedAt: null, reason: 'restore', cycleStartedAt: restoredAt });
    for (const issue of this.states()) this.append('baseline', null, this.state(issue), { actorId: null, origin: 'import' }, this.lookup(issue.projectId).version, restoredAt);
  }
}
