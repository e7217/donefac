import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type {
  CycleCompletionCounts, CycleCompletionIssue, CycleCompletionPlan, CycleCompletionPreview, CycleCompletionResult,
  Issue, PlanningItem, ProjectWorkflow,
} from '../shared/types.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS } from './automatic-schedule.js';
import type { Store } from './store.js';

export class CycleCompletionError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) { super(message); }
}

interface Hooks<T extends { issue: Issue }> {
  actor(request: Request): string;
  activity(request: Request, resourceType: string, resourceId: string, action: string, detail: string): void;
  workflow(projectId: string): ProjectWorkflow;
  configurationToken(projectId: string): string;
  prepare(before: Issue, destinationId: string | null): T;
  validationMessage(error: unknown): string | null;
  commit(request: Request, before: Issue, prepared: T, history: { action: string; detail: string }): void;
  closeCycle(id: string, expectedVersion: number, updatedAt: string): PlanningItem;
}

interface PreviewInput { expectedVersion: number; destinationId: string | null }
interface Proposal extends PreviewInput {
  id: string;
  actorId: string;
  cycleId: string;
  projectId: string;
  destinationVersion: number | null;
  membership: string;
  configurationToken: string;
  removeAfter: string;
  result?: CycleCompletionResult;
}

const TABLE = 'cycle_completion_previews';
const STALE = '사이클·연결 업무 또는 프로젝트 설정이 변경되었습니다. 새로 검토해 주세요.';
const collator = new Intl.Collator('ko-KR', { numeric: true });
const after = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();

function fail(status: number, message: string, details?: unknown): never {
  throw new CycleCompletionError(status, message, details);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
}

function requestBody(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(field => field !== 'actorId' && !fields.includes(field))) {
    fail(400, '사이클 완료 요청을 확인해 주세요.');
  }
  return value as Record<string, unknown>;
}

function parsePreview(value: unknown): PreviewInput {
  const input = requestBody(value, ['expectedVersion', 'destinationId']);
  const { expectedVersion, destinationId } = input;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 || (destinationId !== null && !id(destinationId))) {
    fail(400, '사이클 버전과 이월할 사이클 또는 미지정을 확인해 주세요.');
  }
  return { expectedVersion, destinationId };
}

function parseApply(value: unknown): string {
  const input = requestBody(value, ['previewId']);
  if (!id(input.previewId)) fail(400, '적용할 사이클 완료 미리보기 ID를 확인해 주세요.');
  return input.previewId;
}

function summary({ id, name, version }: PlanningItem): CycleCompletionPlan { return { id, name, version }; }

function canReceive(cycle: PlanningItem, destination: PlanningItem | undefined): destination is PlanningItem {
  return Boolean(destination && destination.id !== cycle.id && destination.projectId === cycle.projectId &&
    destination.kind === 'cycle' && (destination.status === 'planned' || destination.status === 'active'));
}

function membership(members: Issue[]): string {
  return createHash('sha256').update(JSON.stringify(members.map(issue => [issue.id, issue.version]))).digest('hex');
}

export class CycleCompletionService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cycle_completion_remove_after ON ${TABLE}(json_extract(json,'$.removeAfter'));`);
    this.prune();
  }

  private prune(): void {
    this.store.db.prepare(`DELETE FROM ${TABLE} WHERE json_extract(json,'$.removeAfter') <= ?`).run(after(0));
  }

  private members(cycle: PlanningItem): Issue[] {
    const rows = this.store.db.prepare("SELECT json FROM issues WHERE project_id = ? AND json_extract(json,'$.cycleId') = ? ORDER BY id")
      .all(cycle.projectId, cycle.id) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as Issue);
  }

  private review<T extends { issue: Issue }>(cycle: PlanningItem, destination: PlanningItem | null, members: Issue[], hooks: Hooks<T>) {
    const statuses = new Map(hooks.workflow(cycle.projectId).statuses.map(status => [status.id, status]));
    const counts: CycleCompletionCounts = { carry: 0, done: 0, cancelled: 0, blocked: 0 };
    const issues: CycleCompletionIssue[] = [];
    const updates: Array<{ before: Issue; prepared: T }> = [];
    for (const before of members.toSorted((left, right) => collator.compare(left.key, right.key))) {
      const status = statuses.get(before.status);
      const disposition = status?.category === 'done' || status?.category === 'cancelled' ? status.category : 'carry';
      const row: CycleCompletionIssue = {
        id: before.id, key: before.key, title: before.title, statusId: before.status,
        statusLabel: status?.label ?? before.status, disposition,
      };
      issues.push(row);
      counts[disposition]++;
      if (disposition !== 'carry') continue;
      try {
        const prepared = hooks.prepare(before, destination?.id ?? null);
        const { issue } = prepared;
        if (issue.id !== before.id || issue.projectId !== before.projectId || issue.version !== before.version + 1 ||
          issue.cycleId !== (destination?.id ?? null) || issue.cycle !== (destination?.name ?? null)) {
          fail(500, '이월할 업무의 식별자·버전 또는 사이클이 일치하지 않습니다.');
        }
        updates.push({ before, prepared });
      } catch (error) {
        const reason = hooks.validationMessage(error);
        if (reason === null) throw error;
        row.blockedReason = reason;
        counts.blocked++;
      }
    }
    return { counts, issues, updates };
  }

  private preview<T extends { issue: Issue }>(cycleId: string, request: Request, hooks: Hooks<T>): CycleCompletionPreview {
    const input = parsePreview(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      const cycle = this.store.get<PlanningItem>('planning_items', cycleId);
      if (!cycle) fail(404, '계획 항목을 찾을 수 없습니다.');
      if (cycle.kind !== 'cycle') fail(422, '사이클을 선택해 주세요.');
      if (cycle.version !== input.expectedVersion || cycle.status !== 'active') fail(409, STALE, { currentVersion: cycle.version });
      const destination = input.destinationId === null ? null : this.store.get<PlanningItem>('planning_items', input.destinationId);
      if (destination !== null && !canReceive(cycle, destination)) {
        fail(422, '같은 프로젝트의 다른 계획 또는 진행 중 사이클을 선택해 주세요.');
      }
      const members = this.members(cycle);
      const { counts, issues } = this.review(cycle, destination, members, hooks);
      const result: CycleCompletionPreview = {
        previewId: null, expiresAt: null, cycle: summary(cycle), destination: destination ? summary(destination) : null,
        counts, issues,
      };
      if (counts.blocked) return result;

      const expiresAt = after(AUTO_PREVIEW_TTL_MS);
      const proposal: Proposal = {
        ...input, id: randomUUID(), cycleId, actorId, projectId: cycle.projectId,
        destinationVersion: destination?.version ?? null, membership: membership(members),
        configurationToken: hooks.configurationToken(cycle.projectId), removeAfter: expiresAt,
      };
      this.store.put(TABLE, proposal);
      return { ...result, previewId: proposal.id, expiresAt };
    });
  }

  private apply<T extends { issue: Issue }>(cycleId: string, request: Request, hooks: Hooks<T>): CycleCompletionResult {
    const previewId = parseApply(request.body);
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<Proposal>(TABLE, previewId);
      if (!proposal || proposal.cycleId !== cycleId || proposal.actorId !== actorId) fail(404, '적용할 미리보기를 찾을 수 없습니다.');
      if (proposal.removeAfter <= after(0)) fail(409, '사이클 완료 미리보기가 만료되었습니다. 새로 검토해 주세요.');
      if (proposal.result) return proposal.result;

      const cycle = this.store.get<PlanningItem>('planning_items', cycleId);
      if (!cycle || cycle.projectId !== proposal.projectId || cycle.kind !== 'cycle' || cycle.status !== 'active' ||
        cycle.version !== proposal.expectedVersion || hooks.configurationToken(cycle.projectId) !== proposal.configurationToken) {
        fail(409, STALE);
      }
      const destination = proposal.destinationId === null ? null : this.store.get<PlanningItem>('planning_items', proposal.destinationId);
      if (destination !== null && (!canReceive(cycle, destination) || destination.version !== proposal.destinationVersion)) fail(409, STALE);
      const members = this.members(cycle);
      if (membership(members) !== proposal.membership) fail(409, STALE);
      const { counts, updates } = this.review(cycle, destination, members, hooks);
      if (counts.blocked) fail(409, STALE);

      const targetName = destination?.name ?? '미지정';
      for (const { before, prepared } of updates) {
        hooks.commit(request, before, prepared, { action: '사이클 이월', detail: `${cycle.name} → ${targetName}` });
      }
      const completed = hooks.closeCycle(cycle.id, cycle.version, after(0));
      hooks.activity(request, 'planning', cycle.id, '사이클 완료', `${cycle.name} · ${targetName}에 ${counts.carry}개 이월`);
      const result: CycleCompletionResult = { cycle: completed, destination: destination ? summary(destination) : null, counts };
      this.store.put(TABLE, { ...proposal, result, removeAfter: after(AUTO_RESULT_RETENTION_MS) });
      return result;
    });
  }

  resetForImport(): void {
    if (!this.store.db.isTransaction) fail(500, '사이클 미리보기 초기화에는 트랜잭션이 필요합니다.');
    this.store.db.exec(`DELETE FROM ${TABLE}`);
  }

  registerRoutes<T extends { issue: Issue }>(app: Express, hooks: Hooks<T>): void {
    app.post('/api/planning-items/:id/complete/preview', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.preview(request.params.id, request, hooks));
    });
    app.post('/api/planning-items/:id/complete', (request, response) => {
      response.set('Cache-Control', 'no-store').json(this.apply(request.params.id, request, hooks));
    });
  }
}
