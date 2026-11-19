import { createHash, randomUUID } from 'node:crypto';
import type { Issue, IssueOrderMove, IssueOrderMoveResult, Project, ProjectIssueOrder } from '../shared/types.js';
import type { Store, StoreChange } from './store.js';

type IssuePosition = Pick<Issue, 'id' | 'status'>;
type StoredOrder = { project_id: string; issue_ids: string | null; revision: string };
type RestoredOrder = Pick<ProjectIssueOrder, 'projectId' | 'issueIds'>;

export class IssueOrderError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

const fail = (message: string, status = 400, details?: unknown): never => { throw new IssueOrderError(status, message, details); };
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseMove(value: Record<string, unknown>): IssueOrderMove {
  const { issueId, expectedVersion, expectedIssueVersion, anchorId, position, status } = value;
  if (!isId(issueId) || (anchorId !== null && !isId(anchorId)) || issueId === anchorId) return fail('이동할 업무와 기준 업무를 확인해 주세요.');
  if (position !== 'before' && position !== 'after') return fail('기준 업무의 앞이나 뒤를 선택해 주세요.');
  if (!isId(expectedVersion) || expectedVersion.length > 200 || typeof expectedIssueVersion !== 'number' || !Number.isSafeInteger(expectedIssueVersion) || expectedIssueVersion < 1) {
    return fail('업무 순서와 이동할 업무의 버전이 필요합니다.');
  }
  if (status !== undefined && !isId(status)) return fail('이동할 상태를 확인해 주세요.');
  return { issueId, expectedVersion, expectedIssueVersion, anchorId, position, status };
}

export class IssueOrderService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_issue_orders (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      issue_ids TEXT,
      revision TEXT NOT NULL
    )`);
    store.onChange(change => this.trackIssue(change), ['issues']);
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
      if (before.status !== after.status) {
        // Preserve the rank while giving board clients a new version for this column change.
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
    const remaining = new Map(issues.map(issue => [issue.id, issue.status]));
    const ordered: [string, string][] = [];
    const storedIds = row?.issue_ids ? JSON.parse(row.issue_ids) as string[] : [];
    for (const id of storedIds) {
      const status = remaining.get(id);
      if (status === undefined) continue;
      ordered.push([id, status]);
      remaining.delete(id);
    }
    for (const entry of remaining) ordered.push(entry);
    const version = createHash('sha256').update(JSON.stringify([projectId, generation, row?.revision ?? null, ordered])).digest('hex');
    return { projectId, issueIds: ordered.map(([id]) => id), version };
  }

  private read(projectId: string): ProjectIssueOrder {
    const issues = this.store.db.prepare("SELECT id, json_extract(json, '$.status') AS status FROM issues WHERE project_id=? ORDER BY rowid").all(projectId) as IssuePosition[];
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
    changeStatus: (issue: Issue, status: string) => Issue;
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
      if (move.status !== undefined && anchor && anchor.status !== move.status) return fail('기준 업무의 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 409);

      const nextIds = order.issueIds.filter(id => id !== source.id);
      const insertionIndex = anchor ? nextIds.indexOf(anchor.id) + Number(move.position === 'after') : move.position === 'before' ? 0 : nextIds.length;
      nextIds.splice(insertionIndex, 0, source.id);
      const orderChanged = nextIds.some((id, index) => order.issueIds[index] !== id);
      const issue = move.status !== undefined && move.status !== source.status ? hooks.changeStatus(source, move.status) : source;
      if (orderChanged) {
        this.put(projectId, nextIds);
        hooks.recordMove(issue, anchor, move.position);
      }
      return { order: orderChanged || issue !== source ? this.read(projectId) : order, issue };
    });
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
