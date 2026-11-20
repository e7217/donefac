import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import type {
  Issue, IssueAssignmentOutcome, IssueAssignmentPreview, IssueAssignmentRule, IssueAssignmentRuleInput,
  IssueAssignmentRun, IssueAssignmentRunPage, Project, ProjectIssueSchema, ProjectWorkflow, User,
} from '../shared/types.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import type { Store } from './store.js';

export class IssueAssignmentRulesError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export interface IssueAssignmentDecision {
  rule: IssueAssignmentRule;
  assigneeId: string | null;
  outcome: IssueAssignmentRun['outcome'];
  reason: string;
}

type RouteHooks = {
  actor: (request: Request) => string;
  activity: (request: Request, type: string, id: string, action: string, detail?: string) => unknown;
  validate: (proposed: Issue, before: Issue) => Issue;
};
type ImportReferences = { projects: Project[]; users: User[]; workflows: ProjectWorkflow[]; schemas: ProjectIssueSchema[] };
type RunContext = Pick<IssueAssignmentRun, 'actorId' | 'source'> & { sourceEventId?: string | null };
type SavedRuleCallback = (rule: IssueAssignmentRule) => void;
type JsonRow = { json: string };

const RULE_LIMIT = 1000;
const PREVIEW_LIMIT = 50;
const PRIORITY_LIMIT = 10000;
const VERSION_FLOOR_KEY = 'issueAssignmentRuleVersionFloor';

function fail(message: string, status = 400, details?: unknown): never {
  throw new IssueAssignmentRulesError(status, message, details);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('담당자 배정 규칙 설정을 확인해 주세요.');
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.trim() !== value) fail(`${label} ID를 확인해 주세요.`);
  return value;
}

function identifiers(value: unknown, label: string, max: number, min = 0): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || new Set(value).size !== value.length) fail(`${label} 목록을 확인해 주세요.`);
  return value.map(id => identifier(id, label));
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('유효한 expectedVersion이 필요합니다.');
  return value;
}

function nextVersion(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) fail('담당자 배정 규칙 버전의 최댓값에 도달했습니다.', 409);
  return current + 1;
}

function queryNumber(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`${label} 값을 확인해 주세요.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${label} 값을 확인해 주세요.`);
  return number;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function config(input: Record<string, unknown>, workflow: ProjectWorkflow, schema: ProjectIssueSchema, users: Set<string>): IssueAssignmentRuleInput {
  const { enabled, mode, priority } = input;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) fail('규칙 이름을 1~100자로 입력해 주세요.');
  if (typeof enabled !== 'boolean') fail('규칙 사용 여부를 확인해 주세요.');
  if (mode !== 'unassigned' && mode !== 'replace') fail('담당자 배정 방식을 확인해 주세요.');
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0 || priority > PRIORITY_LIMIT) fail('우선순위는 0~10000의 정수여야 합니다.');

  const fromStatuses = identifiers(input.fromStatuses, '출발 상태', workflow.statuses.length);
  const toStatusId = identifier(input.toStatusId, '도착 상태');
  if ([...fromStatuses, toStatusId].some(id => !workflow.statuses.some(status => status.id === id))) fail('프로젝트에 없는 업무 상태입니다.');
  const issueTypes = identifiers(input.issueTypes, '업무 유형', schema.issueTypes.length);
  if (issueTypes.some(id => !schema.issueTypes.some(type => type.id === id))) fail('프로젝트에 없는 업무 유형입니다.');
  const assigneeId = identifier(input.assigneeId, '담당 팀원');
  if (!users.has(assigneeId)) fail('담당 팀원을 찾을 수 없습니다.');
  return { name, enabled, fromStatuses, toStatusId, issueTypes, assigneeId, mode, priority };
}

function mismatch(rule: IssueAssignmentRule, before: Issue, proposed: Issue): string | null {
  if (before.projectId !== rule.projectId || proposed.projectId !== rule.projectId) return '규칙과 다른 프로젝트의 업무입니다.';
  if (before.status === proposed.status) return '이미 도착 상태인 업무입니다.';
  if (proposed.status !== rule.toStatusId) return '규칙의 도착 상태가 아닙니다.';
  if (rule.fromStatuses.length && !rule.fromStatuses.includes(before.status)) return '현재 상태가 선택한 출발 상태에 없습니다.';
  if (rule.issueTypes.length && !rule.issueTypes.includes(proposed.type)) return '선택한 업무 유형이 아닙니다.';
  return null;
}

function decision(rule: IssueAssignmentRule, before: Issue, proposed: Issue, assigneeExplicit = false): IssueAssignmentDecision {
  const { assigneeId } = proposed;
  if (assigneeExplicit || assigneeId !== before.assigneeId) return { rule, assigneeId, outcome: 'skipped', reason: '업무 변경에서 직접 지정한 담당자를 적용했습니다.' };
  if (assigneeId === rule.assigneeId) return { rule, assigneeId, outcome: 'unchanged', reason: '이미 규칙의 담당자로 지정되어 있습니다.' };
  if (assigneeId !== null && rule.mode === 'unassigned') return { rule, assigneeId, outcome: 'skipped', reason: '업무에 이미 지정된 담당자를 유지했습니다.' };
  return { rule, assigneeId: rule.assigneeId, outcome: 'assigned', reason: '규칙에 따라 담당자를 배정했습니다.' };
}

function issueDetails(before: Issue, proposed: Issue) {
  return {
    issueId: before.id, issueKey: proposed.key, issueTitle: proposed.title, fromStatusId: before.status,
    toStatusId: proposed.status, previousAssigneeId: before.assigneeId, assigneeId: proposed.assigneeId,
  };
}

export class IssueAssignmentRulesService {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_assignment_rules(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        assignee_id TEXT NOT NULL REFERENCES users(id), priority INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_assignment_rules_order ON issue_assignment_rules(project_id, priority, id);
      CREATE TABLE IF NOT EXISTS issue_assignment_runs(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL, issue_version INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(issue_id, issue_version)
      );
      CREATE INDEX IF NOT EXISTS issue_assignment_runs_project ON issue_assignment_runs(project_id);
    `);
  }

  all(): IssueAssignmentRule[] {
    const rows = this.store.db.prepare('SELECT json FROM issue_assignment_rules ORDER BY project_id, priority, id').all() as JsonRow[];
    return rows.map(row => JSON.parse(row.json) as IssueAssignmentRule);
  }

  revisions(projectId: string): [string, number][] {
    return this.projectRules(projectId).map(({ id, version }) => [id, version]);
  }

  decide(before: Issue, proposed: Issue, assigneeExplicit = false): IssueAssignmentDecision | null {
    if (before.status === proposed.status) return null;
    const rule = this.projectRules(before.projectId).find(rule => rule.enabled && mismatch(rule, before, proposed) === null);
    return rule ? decision(rule, before, proposed, assigneeExplicit) : null;
  }

  /** The issue write and its assignment result share the caller's transaction. */
  record(decided: IssueAssignmentDecision, before: Issue, final: Issue, context: RunContext): IssueAssignmentRun {
    if (!this.store.db.isTransaction) throw new Error('Issue assignment results require the issue transaction.');
    const run: IssueAssignmentRun = {
      ...issueDetails(before, final), id: randomUUID(), projectId: final.projectId, ruleId: decided.rule.id,
      ruleName: decided.rule.name, actorId: context.actorId, source: context.source,
      sourceEventId: context.sourceEventId ?? null, issueVersion: final.version,
      outcome: decided.outcome, reason: decided.reason, createdAt: final.updatedAt,
    };
    const inserted = this.store.db.prepare(`INSERT INTO issue_assignment_runs(id, project_id, issue_id, issue_version, json)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(issue_id, issue_version) DO NOTHING`).run(run.id, run.projectId, run.issueId, run.issueVersion, JSON.stringify(run));
    if (inserted.changes) return run;
    const existing = this.store.db.prepare('SELECT json FROM issue_assignment_runs WHERE issue_id = ? AND issue_version = ?').get(run.issueId, run.issueVersion) as JsonRow;
    return JSON.parse(existing.json) as IssueAssignmentRun;
  }

  private project(projectId: string): Project {
    return this.store.get<Project>('projects', projectId) ?? fail('프로젝트를 찾을 수 없습니다.', 404);
  }

  private projectRules(projectId: string): IssueAssignmentRule[] {
    const rows = this.store.db.prepare('SELECT json FROM issue_assignment_rules WHERE project_id = ? ORDER BY priority, id').all(projectId) as JsonRow[];
    return rows.map(row => JSON.parse(row.json) as IssueAssignmentRule);
  }

  private currentRule(projectId: string, ruleId: string, expectedVersion: unknown): IssueAssignmentRule {
    const rule = this.store.get<IssueAssignmentRule>('issue_assignment_rules', ruleId);
    if (!rule || rule.projectId !== projectId) fail('담당자 배정 규칙을 찾을 수 없습니다.', 404);
    if (version(expectedVersion) !== rule.version) fail('담당자 배정 규칙이 변경되었습니다. 최신 설정을 확인해 주세요.', 409, { currentVersion: rule.version });
    return rule;
  }

  private parse(projectId: string, input: Record<string, unknown>, previous?: IssueAssignmentRule): IssueAssignmentRule {
    const project = this.project(projectId);
    if (input.projectId !== undefined && input.projectId !== projectId) fail('규칙의 프로젝트는 변경할 수 없습니다.');
    const workflow = this.store.get<ProjectWorkflow>('workflows', projectId) ?? defaultWorkflow(projectId, project.createdAt);
    const schema = this.store.get<ProjectIssueSchema>('issue_schemas', projectId) ?? defaultIssueSchema(projectId, project.createdAt);
    const users = new Set(this.store.all<User>('users').map(user => user.id));
    const editable = config({ enabled: false, mode: 'unassigned', priority: 100, fromStatuses: [], issueTypes: [], ...previous, ...input }, workflow, schema, users);
    const now = new Date().toISOString();
    return {
      ...editable, id: previous?.id ?? randomUUID(), projectId, version: previous ? nextVersion(previous.version) : 1,
      createdAt: previous?.createdAt ?? now, updatedAt: now,
    };
  }

  private put(rule: IssueAssignmentRule): void {
    this.store.db.prepare(`INSERT INTO issue_assignment_rules(id, project_id, assignee_id, priority, json) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET assignee_id = excluded.assignee_id, priority = excluded.priority, json = excluded.json`)
      .run(rule.id, rule.projectId, rule.assigneeId, rule.priority, JSON.stringify(rule));
    this.trackVersion(rule.version);
  }

  private versionFloor(): number {
    const current: unknown = this.store.setting(VERSION_FLOOR_KEY);
    return typeof current === 'number' && Number.isSafeInteger(current) && current > 0 ? current : 0;
  }

  private trackVersion(observed: number): void {
    if (observed > this.versionFloor()) this.store.setSetting(VERSION_FLOOR_KEY, observed);
  }

  private create(projectId: string, input: Record<string, unknown>, afterSave: SavedRuleCallback): IssueAssignmentRule {
    return this.store.transaction(() => {
      const { total } = this.store.db.prepare('SELECT COUNT(*) AS total FROM issue_assignment_rules').get() as { total: number };
      if (total >= RULE_LIMIT) fail('담당자 배정 규칙은 최대 1000개까지 만들 수 있습니다.');
      const rule = this.parse(projectId, input);
      this.put(rule);
      afterSave(rule);
      return rule;
    });
  }

  private save(projectId: string, ruleId: string, input: Record<string, unknown>, afterSave: SavedRuleCallback): IssueAssignmentRule {
    return this.store.transaction(() => {
      const before = this.currentRule(projectId, ruleId, input.expectedVersion);
      const rule = this.parse(projectId, input, before);
      this.put(rule);
      afterSave(rule);
      return rule;
    });
  }

  private remove(projectId: string, ruleId: string, expectedVersion: number, afterDelete: SavedRuleCallback): void {
    this.store.transaction(() => {
      const rule = this.currentRule(projectId, ruleId, expectedVersion);
      this.trackVersion(rule.version);
      this.store.remove('issue_assignment_rules', rule.id);
      afterDelete(rule);
    });
  }

  private preview(projectId: string, input: Record<string, unknown>, validate: RouteHooks['validate']): IssueAssignmentPreview {
    const rule = this.parse(projectId, object(input.rule));
    const issueIds = identifiers(input.issueIds, '미리 볼 업무', PREVIEW_LIMIT, 1);
    const outcomes = issueIds.map((issueId): IssueAssignmentOutcome => {
      const before = this.store.get<Issue>('issues', issueId);
      if (!before || before.projectId !== projectId) fail('미리 볼 업무를 찾을 수 없습니다.', 404);
      const proposed = { ...before, status: rule.toStatusId, version: before.version + 1, updatedAt: rule.updatedAt };
      const reason = mismatch(rule, before, proposed);
      if (reason) return { ...issueDetails(before, proposed), outcome: 'skipped', reason };
      const decided = decision(rule, before, proposed);
      proposed.assigneeId = decided.assigneeId;
      try {
        const validated = validate(proposed, before);
        return { ...issueDetails(before, validated), outcome: decided.outcome, reason: decided.reason };
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status !== 'number' || status < 400 || status >= 500) throw error;
        return { ...issueDetails(before, proposed), outcome: 'blocked', reason: error instanceof Error ? error.message : '현재 업무 조건에서 상태를 변경할 수 없습니다.' };
      }
    });
    return { outcomes };
  }

  private runs(projectId: string, offset: number, limit: number): IssueAssignmentRunPage {
    this.project(projectId);
    const { total } = this.store.db.prepare('SELECT COUNT(*) AS total FROM issue_assignment_runs WHERE project_id = ?').get(projectId) as { total: number };
    const rows = this.store.db.prepare('SELECT json FROM issue_assignment_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(projectId, limit, offset) as JsonRow[];
    return { items: rows.map(row => JSON.parse(row.json) as IssueAssignmentRun), total, offset, limit };
  }

  validateImport(value: unknown, references: ImportReferences): IssueAssignmentRule[] {
    if (!Array.isArray(value) || value.length > RULE_LIMIT) fail('백업의 담당자 배정 규칙 목록을 확인해 주세요.');
    const projects = new Map(references.projects.map(project => [project.id, project]));
    const workflows = new Map(references.workflows.map(workflow => [workflow.projectId, workflow]));
    const schemas = new Map(references.schemas.map(schema => [schema.projectId, schema]));
    const users = new Set(references.users.map(user => user.id));
    const ids = new Set<string>();
    return value.map(raw => {
      const input = object(raw);
      const id = identifier(input.id, '규칙');
      const projectId = identifier(input.projectId, '프로젝트');
      const project = projects.get(projectId);
      if (!project || ids.has(id)) fail('백업의 담당자 배정 규칙 ID 또는 프로젝트를 확인해 주세요.');
      ids.add(id);
      const { createdAt, updatedAt } = input;
      if (!validTime(createdAt) || !validTime(updatedAt)) fail('백업의 담당자 배정 규칙 시간을 확인해 주세요.');
      const workflow = workflows.get(projectId) ?? defaultWorkflow(projectId, project.createdAt);
      const schema = schemas.get(projectId) ?? defaultIssueSchema(projectId, project.createdAt);
      const rule = config(input, workflow, schema, users);
      return { ...rule, id, projectId, enabled: false, version: version(input.version), createdAt, updatedAt };
    });
  }

  clearForImport(): Map<string, number> {
    const previousVersions = new Map(this.all().map(rule => [rule.id, rule.version]));
    this.trackVersion(Math.max(0, ...previousVersions.values()));
    this.store.db.exec('DELETE FROM issue_assignment_runs; DELETE FROM issue_assignment_rules;');
    return previousVersions;
  }

  replaceImported(rules: IssueAssignmentRule[], previousVersions: Map<string, number>): void {
    if (!rules.length) return;
    // A restored ID can belong to a rule deleted after its backup was made.
    const replacementVersion = nextVersion(Math.max(this.versionFloor(), ...previousVersions.values(), ...rules.map(rule => rule.version)));
    for (const rule of rules) this.put({ ...rule, enabled: false, version: replacementVersion });
  }

  registerRoutes(app: Express, hooks: RouteHooks): void {
    const rules = '/api/projects/:projectId/assignment-rules';
    app.get(rules, (req, res) => {
      const projectId = String(req.params.projectId);
      this.project(projectId);
      res.set('Cache-Control', 'no-store').json(this.projectRules(projectId));
    });
    app.post(rules, (req, res) => {
      hooks.actor(req);
      const rule = this.create(String(req.params.projectId), object(req.body), saved => {
        hooks.activity(req, 'project', saved.projectId, '담당자 배정 규칙 생성', saved.name);
      });
      res.status(201).json(rule);
    });
    app.patch(`${rules}/:id`, (req, res) => {
      hooks.actor(req);
      const rule = this.save(String(req.params.projectId), String(req.params.id), object(req.body), saved => {
        hooks.activity(req, 'project', saved.projectId, '담당자 배정 규칙 변경', saved.name);
      });
      res.json(rule);
    });
    app.delete(`${rules}/:id`, (req, res) => {
      hooks.actor(req);
      const expectedVersion = queryNumber(req.query.expectedVersion, 'expectedVersion', 1);
      this.remove(String(req.params.projectId), String(req.params.id), expectedVersion, removed => {
        hooks.activity(req, 'project', removed.projectId, '담당자 배정 규칙 삭제', removed.name);
      });
      res.json({ ok: true });
    });
    app.post(`${rules}/preview`, (req, res) => {
      hooks.actor(req);
      res.set('Cache-Control', 'no-store').json(this.preview(String(req.params.projectId), object(req.body), hooks.validate));
    });
    app.get('/api/projects/:projectId/assignment-runs', (req, res) => {
      const offset = req.query.offset === undefined ? 0 : queryNumber(req.query.offset, '시작 위치', 0);
      const limit = req.query.limit === undefined ? 20 : queryNumber(req.query.limit, '실행 기록 개수', 1, 100);
      res.set('Cache-Control', 'no-store').json(this.runs(String(req.params.projectId), offset, limit));
    });
  }
}
