import { createHash, randomUUID } from 'node:crypto';
import type { CycleBoardMoveInput, CycleBoardMoveResult, Issue, IssueOrderMove, IssueOrderMoveResult, PlanningItem, Project, ProjectIssueOrder } from '../shared/types.js';
import { AUTO_RESULT_RETENTION_MS } from './automatic-schedule.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import type { Store, StoreChange } from './store.js';

type IssuePosition = Pick<Issue, 'id' | 'status' | 'cycleId'>;
type IssueMoveChanges = Partial<Pick<Issue, 'status' | 'assigneeId'>>;
type StoredOrder = { project_id: string; issue_ids: string | null; revision: string };
type RestoredOrder = Pick<ProjectIssueOrder, 'projectId' | 'issueIds'>;
type MoveReceipt = { project_id: string; issue_id: string; actor_id: string; fingerprint: string };
type CycleBoardPlacement = {
  sourceCycle: PlanningItem | null;
  targetCycle: PlanningItem | null;
  anchor: Issue | undefined;
  position: CycleBoardMoveInput['position'];
  orderChanged: boolean;
};

export class IssueOrderError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

const fail = (message: string, status = 400, details?: unknown): never => { throw new IssueOrderError(status, message, details); };
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isBoardId = (value: unknown): value is string => isId(value) && value.length <= 200 && value === value.trim() && !/\p{Cc}/u.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const laneId = (issue: IssuePosition) => issue.cycleId ?? null;

function parseMove(value: Record<string, unknown>): IssueOrderMove {
  const { issueId, expectedVersion, expectedIssueVersion, anchorId, position, status, targetAssigneeId, assigneeId } = value;
  if (!isId(issueId) || (anchorId !== null && !isId(anchorId)) || issueId === anchorId) return fail('이동할 업무와 기준 업무를 확인해 주세요.');
  if (position !== 'before' && position !== 'after') return fail('기준 업무의 앞이나 뒤를 선택해 주세요.');
  if (!isId(expectedVersion) || expectedVersion.length > 200 || !isVersion(expectedIssueVersion)) {
    return fail('업무 순서와 이동할 업무의 버전이 필요합니다.');
  }
  if (status !== undefined && !isId(status)) return fail('이동할 상태를 확인해 주세요.');
  if ((targetAssigneeId !== undefined && targetAssigneeId !== null && !isId(targetAssigneeId)) ||
      (assigneeId !== undefined && assigneeId !== null && !isId(assigneeId))) return fail('이동할 담당자를 확인해 주세요.');
  if (targetAssigneeId !== undefined && assigneeId !== undefined && assigneeId !== targetAssigneeId) return fail('지정한 담당자와 이동할 담당자 묶음이 일치해야 합니다.');
  return { issueId, expectedVersion, expectedIssueVersion, anchorId, position, status, targetAssigneeId, assigneeId };
}

function parseCycleReference(value: unknown): CycleBoardMoveInput['sourceCycle'] {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isBoardId(value.id) || !isVersion(value.expectedVersion)) {
    return fail('사이클 ID와 조회한 버전을 확인해 주세요.');
  }
  return { id: value.id, expectedVersion: value.expectedVersion };
}

function parseCycleBoardMove(value: unknown): CycleBoardMoveInput {
  if (!isRecord(value) || Object.keys(value).some(key => !['requestId', 'issueId', 'expectedVersion', 'expectedIssueVersion',
    'sourceCycle', 'targetCycle', 'anchorId', 'position'].includes(key))) return fail('사이클 보드 이동 요청을 확인해 주세요.');
  const { requestId, issueId, expectedVersion, expectedIssueVersion, anchorId, position } = value;
  if (!isId(requestId) || !creationRequestId.test(requestId)) return fail('사이클 보드 이동 요청 ID를 확인해 주세요.');
  if (!isBoardId(issueId) || (anchorId !== null && !isBoardId(anchorId)) || issueId === anchorId || (position !== 'before' && position !== 'after')) {
    return fail('이동할 업무와 기준 업무를 확인해 주세요.');
  }
  if (!isBoardId(expectedVersion) || !isVersion(expectedIssueVersion)) return fail('업무 순서와 이동할 업무의 버전이 필요합니다.');
  return { requestId: requestId.toLowerCase(), issueId, expectedVersion, expectedIssueVersion, anchorId, position,
    sourceCycle: parseCycleReference(value.sourceCycle), targetCycle: parseCycleReference(value.targetCycle) };
}

function placeIssue(issueIds: string[], issueId: string, anchorId: string | null, position: IssueOrderMove['position']): string[] {
  const nextIds = issueIds.filter(id => id !== issueId);
  const index = anchorId ? nextIds.indexOf(anchorId) + Number(position === 'after') : position === 'before' ? 0 : nextIds.length;
  nextIds.splice(index, 0, issueId);
  return nextIds;
}

export class IssueOrderService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_issue_orders (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      issue_ids TEXT,
      revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_board_move_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cycle_board_move_expiry ON cycle_board_move_requests(expires_at);`);
    this.pruneCycleMoves();
    store.onChange(change => this.trackIssue(change), ['issues']);
  }

  private pruneCycleMoves(): void {
    this.store.db.prepare('DELETE FROM cycle_board_move_requests WHERE expires_at<=?').run(new Date().toISOString());
  }

  private stored(projectId: string): StoredOrder | undefined {
    return this.store.db.prepare('SELECT project_id, issue_ids, revision FROM project_issue_orders WHERE project_id=?').get(projectId) as StoredOrder | undefined;
  }

  private put(projectId: string, issueIds: string[] | null) {
    this.store.db.prepare(`INSERT INTO project_issue_orders (project_id, issue_ids, revision) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET issue_ids=excluded.issue_ids, revision=excluded.revision`)
      .run(projectId, issueIds === null ? null : JSON.stringify(issueIds), randomUUID());
  }

  private trackIssue(change: StoreChange) {
    if (change.context.origin === 'import') return;
    const before = change.before as Issue | undefined;
    const after = change.after as Issue | undefined;
    if (before && after && before.projectId === after.projectId) {
      if (before.status !== after.status || before.assigneeId !== after.assigneeId || laneId(before) !== laneId(after)) {
        // Preserve the rank while invalidating stale board destinations.
        this.store.db.prepare(`INSERT INTO project_issue_orders (project_id, revision) VALUES (?, ?)
          ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision`).run(after.projectId, randomUUID());
      }
      return;
    }
    if (before) {
      const row = this.stored(before.projectId);
      const issueIds = row?.issue_ids ? (JSON.parse(row.issue_ids) as string[]).filter(id => id !== before.id) : null;
      this.put(before.projectId, issueIds);
    }
    if (after) {
      const row = this.stored(after.projectId);
      const issueIds = row?.issue_ids ? [...JSON.parse(row.issue_ids) as string[], after.id] : null;
      this.put(after.projectId, issueIds);
    }
  }

  private resolve(projectId: string, issues: IssuePosition[], row: StoredOrder | undefined, generation: unknown): ProjectIssueOrder {
    const remaining = new Map(issues.map(issue => [issue.id, issue]));
    const ordered: IssuePosition[] = [];
    const storedIds = row?.issue_ids ? JSON.parse(row.issue_ids) as string[] : [];
    for (const id of storedIds) {
      const issue = remaining.get(id);
      if (issue === undefined) continue;
      ordered.push(issue);
      remaining.delete(id);
    }
    for (const issue of remaining.values()) ordered.push(issue);
    const positions = ordered.map(issue => [issue.id, issue.status, laneId(issue)]);
    const version = createHash('sha256').update(JSON.stringify([projectId, generation, row?.revision ?? null, positions])).digest('hex');
    return { projectId, issueIds: ordered.map(issue => issue.id), version };
  }

  private read(projectId: string): ProjectIssueOrder {
    const issues = this.store.db.prepare(`SELECT id, json_extract(json, '$.status') AS status, json_extract(json, '$.cycleId') AS cycleId
      FROM issues WHERE project_id=? ORDER BY rowid`).all(projectId) as IssuePosition[];
    return this.resolve(projectId, issues, this.stored(projectId), this.store.setting('attachmentImportGeneration'));
  }

  get(projectId: string): ProjectIssueOrder {
    if (!this.store.get('projects', projectId)) return fail('프로젝트를 찾을 수 없습니다.', 404);
    return this.read(projectId);
  }

  snapshot(projects: Project[], issues: Issue[]): ProjectIssueOrder[] {
    const rows = this.store.db.prepare('SELECT project_id, issue_ids, revision FROM project_issue_orders').all() as StoredOrder[];
    const byProject = new Map(rows.map(row => [row.project_id, row]));
    const issuesByProject = new Map<string, Issue[]>();
    for (const issue of issues) {
      const group = issuesByProject.get(issue.projectId);
      if (group) group.push(issue);
      else issuesByProject.set(issue.projectId, [issue]);
    }
    const generation = this.store.setting('attachmentImportGeneration');
    return projects.map(project => this.resolve(project.id, issuesByProject.get(project.id) ?? [], byProject.get(project.id), generation));
  }

  move(projectId: string, body: Record<string, unknown>, hooks: {
    changeIssue: (issue: Issue, changes: IssueMoveChanges) => Issue;
    recordMove: (issue: Issue, anchor: Issue | undefined, position: IssueOrderMove['position']) => void;
  }): IssueOrderMoveResult {
    const move = parseMove(body);
    return this.store.transaction(() => {
      const order = this.get(projectId);
      if (move.expectedVersion !== order.version) return fail('업무 순서나 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 409, { currentVersion: order.version });
      const source = this.store.get<Issue>('issues', move.issueId);
      const anchor = move.anchorId === null ? undefined : this.store.get<Issue>('issues', move.anchorId);
      if (source?.projectId !== projectId || (move.anchorId !== null && anchor?.projectId !== projectId)) {
        return fail('이동 업무와 기준 업무는 현재 프로젝트에 있어야 합니다.', 409);
      }
      if (source.version !== move.expectedIssueVersion) return fail('이동할 업무가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 409, { currentIssueVersion: source.version });
      const targetAssignee = move.targetAssigneeId !== undefined ? move.targetAssigneeId : move.assigneeId;
      if (targetAssignee != null && !this.store.get('users', targetAssignee)) return fail('이동할 담당자를 찾을 수 없습니다.');
      const targetStatus = move.status ?? (move.targetAssigneeId !== undefined ? source.status : undefined);
      if (targetStatus !== undefined && anchor && anchor.status !== targetStatus) return fail('기준 업무의 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 409);
      if (move.targetAssigneeId !== undefined) {
        const anchorMoved = anchor && anchor.assigneeId !== move.targetAssigneeId;
        const sourceMoved = move.assigneeId === undefined && source.assigneeId !== move.targetAssigneeId;
        if (anchorMoved || sourceMoved) return fail('업무의 담당자 묶음이 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 409);
      }

      const nextIds = placeIssue(order.issueIds, source.id, anchor?.id ?? null, move.position);
      const orderChanged = nextIds.some((id, index) => order.issueIds[index] !== id);
      const changes: IssueMoveChanges = {};
      if (move.status !== undefined && move.status !== source.status) changes.status = move.status;
      if (move.assigneeId !== undefined && (move.assigneeId !== source.assigneeId || changes.status !== undefined)) changes.assigneeId = move.assigneeId;
      const issue = changes.status !== undefined || changes.assigneeId !== undefined ? hooks.changeIssue(source, changes) : source;
      if (orderChanged) {
        this.put(projectId, nextIds);
        hooks.recordMove(issue, anchor, move.position);
      }
      return { order: orderChanged || issue !== source ? this.read(projectId) : order, issue };
    });
  }

  private currentCycle(projectId: string, reference: CycleBoardMoveInput['sourceCycle'], role: 'source' | 'target'): PlanningItem | null {
    if (reference === null) return null;
    const current = this.store.get<PlanningItem>('planning_items', reference.id);
    const matching = current?.projectId === projectId && current.kind === 'cycle';
    if (!matching || (current.status !== 'planned' && current.status !== 'active') || current.version !== reference.expectedVersion) {
      return fail('사이클의 버전이나 상태가 변경되었습니다. 최신 보드를 확인해 주세요.', 409, {
        reason: role === 'source' ? 'source_cycle_changed' : 'target_cycle_changed',
        ...(matching ? { currentCycleVersion: current.version } : {}),
      });
    }
    return current;
  }

  private cycleAnchor(order: ProjectIssueOrder, move: CycleBoardMoveInput): Issue | undefined {
    const targetId = move.targetCycle?.id ?? null;
    if (move.anchorId !== null) {
      const anchor = this.store.get<Issue>('issues', move.anchorId);
      if (anchor?.projectId !== order.projectId || laneId(anchor) !== targetId) {
        return fail('기준 업무의 사이클이 변경되었습니다. 최신 보드를 확인해 주세요.', 409, { reason: 'anchor_changed' });
      }
      return anchor;
    }
    const rows = this.store.db.prepare(`SELECT id FROM issues WHERE project_id=? AND id<>? AND json_extract(json, '$.cycleId') IS ?`)
      .all(order.projectId, move.issueId, targetId) as { id: string }[];
    const targetIds = new Set(rows.map(row => row.id));
    const anchorId = move.position === 'before' ? order.issueIds.find(id => targetIds.has(id)) : order.issueIds.findLast(id => targetIds.has(id));
    return anchorId === undefined ? undefined : this.store.get<Issue>('issues', anchorId);
  }

  moveOnCycleBoard(projectId: string, actorId: string, body: unknown,
    apply: (issue: Issue, placement: CycleBoardPlacement) => Issue): CycleBoardMoveResult {
    const move = parseCycleBoardMove(body);
    const fingerprint = creationRequestFingerprint({ ...move });
    return this.store.transaction(() => {
      this.pruneCycleMoves();
      const receipt = this.store.db.prepare('SELECT project_id,issue_id,actor_id,fingerprint FROM cycle_board_move_requests WHERE id=?')
        .get(move.requestId) as MoveReceipt | undefined;
      if (receipt) {
        if (receipt.project_id !== projectId || receipt.issue_id !== move.issueId || receipt.actor_id !== actorId || receipt.fingerprint !== fingerprint) {
          return fail('이미 사용한 사이클 보드 이동 요청입니다.', 409, { reason: 'request_reused' });
        }
        const current = this.store.get<Issue>('issues', receipt.issue_id);
        if (current?.projectId !== projectId) {
          return fail('저장한 이동 업무를 현재 프로젝트에서 찾을 수 없습니다.', 409, { reason: 'receipt_unavailable' });
        }
        return { issue: current, order: this.read(projectId), duplicate: true };
      }
      const order = this.get(projectId);
      if (order.version !== move.expectedVersion) {
        return fail('프로젝트 업무 순서나 사이클 배정이 변경되었습니다. 최신 보드를 확인해 주세요.', 409,
          { reason: 'order_changed', currentVersion: order.version });
      }
      const source = this.store.get<Issue>('issues', move.issueId);
      if (source?.projectId !== projectId) {
        return fail('이동할 업무를 현재 프로젝트에서 찾을 수 없습니다.', 409, { reason: 'issue_missing' });
      }
      if (source.version !== move.expectedIssueVersion) {
        return fail('이동할 업무가 변경되었습니다. 최신 보드를 확인해 주세요.', 409,
          { reason: 'issue_changed', currentIssueVersion: source.version });
      }
      const sourceCycle = this.currentCycle(projectId, move.sourceCycle, 'source');
      if (laneId(source) !== (sourceCycle?.id ?? null)) {
        return fail('이동할 업무의 사이클이 변경되었습니다. 최신 보드를 확인해 주세요.', 409, { reason: 'source_cycle_changed' });
      }
      const targetCycle = this.currentCycle(projectId, move.targetCycle, 'target');
      const anchor = this.cycleAnchor(order, move);
      const nextIds = anchor ? placeIssue(order.issueIds, source.id, anchor.id, move.position) : order.issueIds;
      const orderChanged = nextIds.some((id, index) => id !== order.issueIds[index]);
      const membershipChanged = laneId(source) !== (targetCycle?.id ?? null);
      const issue = orderChanged || membershipChanged ? apply(source, { sourceCycle, targetCycle, anchor, position: move.position, orderChanged }) : source;
      if (orderChanged) this.put(projectId, nextIds);
      this.store.db.prepare(`INSERT INTO cycle_board_move_requests(id,project_id,issue_id,actor_id,fingerprint,expires_at) VALUES(?,?,?,?,?,?)`)
        .run(move.requestId, projectId, issue.id, actorId, fingerprint, new Date(Date.now() + AUTO_RESULT_RETENTION_MS).toISOString());
      return { issue, order: orderChanged || membershipChanged ? this.read(projectId) : order, duplicate: false };
    });
  }

  clearCycleMovesForImport(): void {
    if (!this.store.db.isTransaction) fail('사이클 보드 이동 기록 초기화에는 트랜잭션이 필요합니다.', 500);
    this.store.db.exec('DELETE FROM cycle_board_move_requests');
  }

  validateImport(value: unknown, projects: Project[], issues: Issue[]): RestoredOrder[] {
    if (!Array.isArray(value) || value.length !== projects.length) return fail('백업의 프로젝트별 업무 순서를 확인해 주세요.');
    const missingProjects = new Set(projects.map(project => project.id));
    const issueProjects = new Map(issues.map(issue => [issue.id, issue.projectId]));
    const orders = value.map((record: unknown) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('백업의 업무 순서 형식을 확인해 주세요.');
      const { projectId, issueIds, version } = record as Partial<ProjectIssueOrder>;
      if (!isId(projectId) || !missingProjects.delete(projectId) || !Array.isArray(issueIds) || !isId(version) || !/^[0-9a-f]{64}$/.test(version)) {
        return fail('백업의 업무 순서 프로젝트와 버전을 확인해 주세요.');
      }
      for (const id of issueIds) {
        if (!isId(id) || issueProjects.get(id) !== projectId) return fail('백업의 업무 순서에 같은 프로젝트의 유효한 업무 ID를 한 번씩 넣어 주세요.');
        issueProjects.delete(id);
      }
      return { projectId, issueIds };
    });
    if (issueProjects.size > 0) return fail('백업의 업무 순서에 빠진 업무가 있습니다.');
    return orders;
  }

  replaceImported(orders: RestoredOrder[]) {
    this.store.db.exec('DELETE FROM project_issue_orders');
    for (const order of orders) this.put(order.projectId, order.issueIds);
  }
}
