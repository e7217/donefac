import { createHash } from 'node:crypto';
import { fieldApplies, hasCustomValue } from '../shared/issue-schema.js';
import type { IssueProjectMoveInput, IssueProjectMoveMapping, IssueProjectMoveNotice, IssueProjectMovePreview, IssueProjectMoveResult } from '../shared/issue-project-move.js';
import type { CustomFieldDefinition, CustomFieldValue, Dependency, Issue, PlanningItem, Project, ProjectIssueOrder, ProjectIssueSchema, ProjectWorkflow, WorkCalendar } from '../shared/types.js';
import type { Store } from './store.js';

const MAX_ISSUES = 100;
const PLAN_FIELDS = ['cycleId', 'moduleId', 'releaseId'] as const;
const MAPPING_FIELDS = ['issueId', 'type', 'status', 'customFields', ...PLAN_FIELDS];

interface MoveHooks {
  schema(projectId: string): ProjectIssueSchema;
  workflow(projectId: string): ProjectWorkflow;
  calendar(projectId: string): WorkCalendar;
  order(projectId: string): ProjectIssueOrder;
  plans(projectId: string): PlanningItem[];
  validate(issue: Issue, parents: ReadonlyMap<string, Issue>): void;
  validationMessage(error: unknown): string | null;
  appendOrder(order: ProjectIssueOrder, issueIds: string[]): void;
}

export class IssueProjectMoveError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { reason: string }) { super(message); }
}

const badInput = () => new IssueProjectMoveError(400, '이동할 프로젝트와 업무별 대상 필드를 확인해 주세요.');
const stale = () => new IssueProjectMoveError(409, '업무 또는 이동 조건이 변경되었습니다. 다시 미리보기를 확인해 주세요.', { reason: 'project_move_stale' });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parseRequest(body: unknown, applying: boolean): IssueProjectMoveInput & { token?: string } {
  if (!object(body)) throw badInput();
  const { expectedVersion, projectId, includeConnected, mappings, token } = body;
  const fields = ['expectedVersion', 'projectId', 'includeConnected', 'mappings', 'actorId', ...(applying ? ['token'] : [])];
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !identifier(projectId) || typeof includeConnected !== 'boolean' || !Array.isArray(mappings) || mappings.length > MAX_ISSUES ||
      Object.keys(body).some(key => !fields.includes(key)) || (applying && (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)))) throw badInput();
  const seen = new Set<string>();
  const parsed = mappings.map((value: unknown): IssueProjectMoveMapping => {
    if (!object(value) || Object.keys(value).some(key => !MAPPING_FIELDS.includes(key))) throw badInput();
    const { issueId, type, status, customFields } = value;
    if (!identifier(issueId) || seen.has(issueId) || (type !== undefined && !identifier(type)) ||
        (status !== undefined && !identifier(status))) throw badInput();
    seen.add(issueId);
    const mapping: IssueProjectMoveMapping = { issueId };
    if (type !== undefined) mapping.type = type;
    if (status !== undefined) mapping.status = status;
    for (const field of PLAN_FIELDS) {
      const id = value[field];
      if (id !== undefined) {
        if (id !== null && !identifier(id)) throw badInput();
        mapping[field] = id;
      }
    }
    if (customFields !== undefined) {
      if (!object(customFields) || Object.keys(customFields).length > 250) throw badInput();
      const entries = Object.entries(customFields).sort(([a], [b]) => a.localeCompare(b));
      for (const [id, value] of entries) {
        if (!identifier(id) || !(value === null || typeof value === 'boolean' ||
            (typeof value === 'string' && value.length <= 20000) ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            (Array.isArray(value) && value.length <= 200 && value.every(identifier)))) throw badInput();
      }
      mapping.customFields = Object.fromEntries(entries) as Record<string, CustomFieldValue>;
    }
    return mapping;
  });
  parsed.sort((a, b) => a.issueId.localeCompare(b.issueId));
  return { expectedVersion, projectId, includeConnected, mappings: parsed, ...(typeof token === 'string' ? { token } : {}) };
}

function mappedFieldValue(source: CustomFieldDefinition, destination: CustomFieldDefinition, value: CustomFieldValue): CustomFieldValue | undefined {
  const option = (id: string): string | undefined => {
    const prior = source.options.find(item => item.id === id);
    if (!prior) return undefined;
    const compatible = destination.options.filter(item => !item.archived && item.name === prior.name);
    return compatible.find(item => item.id === id)?.id ?? (compatible.length === 1 ? compatible[0].id : undefined);
  };
  if (source.kind === 'select') return typeof value === 'string' ? option(value) : undefined;
  if (source.kind === 'multi_select') {
    if (!Array.isArray(value)) return undefined;
    const mapped = value.map(option);
    return mapped.every((id): id is string => id !== undefined) && new Set(mapped).size === mapped.length ? mapped : undefined;
  }
  return value;
}

function effectiveFields(issue: Issue, targetType: string, requested: IssueProjectMoveMapping, source: ProjectIssueSchema,
  destination: ProjectIssueSchema, blockers: IssueProjectMoveNotice[]): Record<string, CustomFieldValue> {
  const fields = new Map(Object.entries(requested.customFields ?? {}));
  const targets = destination.fields.filter(field => !field.archived && fieldApplies(field, targetType));
  const mapped = new Set<string>();
  for (const [id, value] of Object.entries(issue.customFields ?? {})) {
    if (!hasCustomValue(value)) continue;
    const definition = source.fields.find(field => field.id === id);
    const compatible = definition ? targets.filter(field => field.name === definition.name && field.kind === definition.kind) : [];
    const target = compatible.find(field => field.id === id) ?? (compatible.length === 1 ? compatible[0] : undefined);
    const transferred = definition && target ? mappedFieldValue(definition, target, value) : undefined;
    if (!target || transferred === undefined || mapped.has(target.id) || (fields.has(target.id) && !same(fields.get(target.id), transferred))) {
      blockers.push({ code: 'custom_field_incompatible', issueId: issue.id,
        message: `${definition?.name ?? id} 값을 대상 프로젝트에 그대로 옮길 수 없습니다.` });
      continue;
    }
    fields.set(target.id, transferred);
    mapped.add(target.id);
  }
  return Object.fromEntries([...fields].sort(([a], [b]) => a.localeCompare(b)));
}

interface MovePlan { preview: IssueProjectMovePreview; drafts: Issue[]; targetOrder: ProjectIssueOrder; nextNumber: number }

export class IssueProjectMoveService {
  private readonly children;
  private readonly links;

  constructor(private readonly store: Store, private readonly hooks: MoveHooks) {
    store.db.exec(`CREATE INDEX IF NOT EXISTS issues_parent ON issues(parent_id);
      CREATE INDEX IF NOT EXISTS dependencies_successor ON dependencies(successor_id);
      CREATE TABLE IF NOT EXISTS issue_project_move_receipts (
        token TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL
      );`);
    this.children = store.db.prepare(`SELECT id FROM issues WHERE parent_id=? ORDER BY id LIMIT ${MAX_ISSUES + 1}`);
    this.links = store.db.prepare(`SELECT json FROM dependencies WHERE predecessor_id=? OR successor_id=? ORDER BY id LIMIT ${2 * MAX_ISSUES + 1}`);
  }

  private connected(root: Issue, includeConnected: boolean, blockers: IssueProjectMoveNotice[]) {
    const issues = new Map([[root.id, root]]);
    const queue = [root];
    const edges = new Map<string, Dependency>();
    for (const issue of queue) {
      const children = (this.children.all(issue.id) as { id: string }[]).map(row => row.id);
      const neighbours = new Set([...children, ...(issue.parentId ? [issue.parentId] : [])]);
      for (const { json } of this.links.all(issue.id, issue.id) as { json: string }[]) {
        const edge = JSON.parse(json) as Dependency;
        edges.set(edge.id, edge);
        neighbours.add(edge.predecessorId === issue.id ? edge.successorId : edge.predecessorId);
      }
      if (!includeConnected && neighbours.size) {
        blockers.push({ code: 'connected_issues', issueId: issue.id, message: '상하위 업무 또는 선후행 일정이 연결되어 있습니다. 연결된 업무를 함께 이동해 주세요.' });
        break;
      }
      for (const id of neighbours) {
        if (issues.has(id)) continue;
        if (issues.size === MAX_ISSUES) {
          blockers.push({ code: 'connected_limit', message: '연결된 업무는 한 번에 100개까지 이동할 수 있습니다.' });
          return { issues, edges };
        }
        const next = this.store.get<Issue>('issues', id);
        if (!next || next.projectId !== root.projectId) {
          blockers.push({ code: 'connected_boundary', issueId: issue.id, message: '현재 프로젝트 밖의 상하위 업무 또는 선후행 일정이 연결되어 있습니다.' });
          continue;
        }
        issues.set(id, next);
        queue.push(next);
      }
    }
    return { issues, edges };
  }

  private historicalBlockers(projectId: string, ids: string[], blockers: IssueProjectMoveNotice[]) {
    const selected = JSON.stringify(ids);
    const record = (code: string, message: string, query: string, ...parameters: (string | number)[]) => {
      const sql = `WITH selected(id) AS (SELECT value FROM json_each(?)) SELECT DISTINCT id FROM (${query}) ORDER BY id`;
      for (const { id } of this.store.db.prepare(sql).all(selected, ...parameters) as { id: string }[]) {
        blockers.push({ code, message, issueId: id });
      }
    };
    record('worklogs', '작업 시간 기록이 남아 있어 이동할 수 없습니다.',
      'SELECT worklogs.issue_id AS id FROM worklogs JOIN selected ON selected.id=worklogs.issue_id');
    record('milestones', '프로젝트 이정표와의 연결을 먼저 해제해 주세요.',
      "SELECT selected.id FROM milestones, json_each(milestones.json, '$.issueIds') member JOIN selected ON selected.id=member.value WHERE milestones.project_id=?", projectId);
    record('baselines', '기준선에 남은 업무는 현재 프로젝트에 유지해야 합니다.',
      "SELECT selected.id FROM baselines, json_each(baselines.json, '$.issues') member JOIN selected ON selected.id=json_extract(member.value,'$.issueId') WHERE baselines.project_id=?", projectId);
    record('cycle_completion', '사이클 완료 기록에 남은 업무는 현재 프로젝트에 유지해야 합니다.',
      "SELECT selected.id FROM cycle_completion_records receipt, json_each(receipt.json, '$.issues') member JOIN selected ON selected.id=json_extract(member.value,'$.id') WHERE receipt.project_id=?", projectId);
    record('trashed_children', '휴지통의 하위 업무를 먼저 복원하거나 정리해 주세요.',
      "SELECT selected.id FROM trash_entries JOIN selected ON selected.id=trash_entries.parent_id WHERE trash_entries.resource_type='issue' AND trash_entries.project_id=?", projectId);
    record('trashed_schedule_links', '휴지통에 복원 가능한 선후행 일정이 남아 있습니다.',
      `SELECT selected.id FROM trash_entries, json_each(trash_entries.json, '$.dependencies') edge
       JOIN selected ON selected.id IN (json_extract(edge.value,'$.predecessorId'),json_extract(edge.value,'$.successorId'))
       WHERE trash_entries.resource_type='issue' AND trash_entries.project_id=?`, projectId);
    record('jira_origin', 'Jira에서 이관한 업무의 원본 연결은 현재 프로젝트에 유지해야 합니다.',
      "SELECT selected.id FROM source_bindings JOIN selected ON selected.id=source_bindings.target_id WHERE product='jira' AND kind='issue' AND target_type='issue'");
  }

  private plan(id: string, actorId: string, request: IssueProjectMoveInput, applying: boolean): MovePlan {
    const root = this.store.get<Issue>('issues', id);
    const project = this.store.get<Project>('projects', request.projectId);
    if (!root || !project) throw applying ? stale() : new IssueProjectMoveError(404, '이동할 업무 또는 프로젝트를 찾을 수 없습니다.');
    if (root.version !== request.expectedVersion) throw stale();
    if (root.projectId === project.id) throw applying ? stale() : new IssueProjectMoveError(400, '업무가 속한 프로젝트와 다른 프로젝트를 선택해 주세요.');
    const blockers: IssueProjectMoveNotice[] = [];
    const warnings: IssueProjectMoveNotice[] = [];
    const { issues, edges } = this.connected(root, request.includeConnected, blockers);
    const source = this.hooks.order(root.projectId);
    const targetOrder = this.hooks.order(project.id);
    const ids = source.issueIds.filter(id => issues.has(id));
    const input = new Map(request.mappings.map(mapping => [mapping.issueId, mapping]));
    if (request.mappings.some(mapping => !issues.has(mapping.issueId))) {
      blockers.push({ code: 'mapping_outside_scope', message: '이동할 업무 목록을 다시 확인해 주세요.' });
    }
    const sourceSchema = this.hooks.schema(root.projectId), targetSchema = this.hooks.schema(project.id);
    const sourceWorkflow = this.hooks.workflow(root.projectId), targetWorkflow = this.hooks.workflow(project.id);
    const sourceCalendar = this.hooks.calendar(root.projectId), targetCalendar = this.hooks.calendar(project.id);
    const plans = this.hooks.plans(project.id);
    this.historicalBlockers(root.projectId, ids, blockers);
    const sequence = this.store.db.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(project.id) as { next_number: number } | undefined;
    const nextNumber = sequence?.next_number ?? 1;
    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1 || !Number.isSafeInteger(nextNumber + ids.length)) {
      blockers.push({ code: 'key_sequence', message: '대상 프로젝트의 새 업무 키를 발급할 수 없습니다.' });
    }
    const targetKeys = ids.map((_, index) => `${project.key}-${nextNumber + index}`);
    const keys = JSON.stringify(targetKeys);
    const collision = this.store.db.prepare(`SELECT 1 FROM issues WHERE json_extract(json,'$.key') IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM trash_entries WHERE resource_type='issue' AND json_extract(summary,'$.issueKey') IN (SELECT value FROM json_each(?)) LIMIT 1`);
    if (collision.get(keys, keys)) blockers.push({ code: 'key_collision', message: '발급할 새 업무 키 중 이미 사용된 키가 있습니다.' });

    const matchingCalendars = same(sourceCalendar.workingWeekdays, targetCalendar.workingWeekdays) &&
      same(sourceCalendar.exceptions.map(({ date, isWorking }) => [date, isWorking]), targetCalendar.exceptions.map(({ date, isWorking }) => [date, isWorking]));
    if (!matchingCalendars && (edges.size || ids.some(id => issues.get(id)!.startDate || issues.get(id)!.endDate))) {
      warnings.push({ code: 'calendar_changed', message: '계획 날짜는 유지합니다. 대상 달력으로 바뀌어 근무일 기준 기간이나 선후행 일정이 달라질 수 있습니다.' });
    }
    const timestamp = new Date().toISOString();
    const drafts: Issue[] = [];
    const previewIssues = ids.map((issueId, index) => {
      const issue = issues.get(issueId)!;
      const requested = input.get(issueId) ?? { issueId };
      const oldStatus = sourceWorkflow.statuses.find(status => status.id === issue.status);
      const activeTypes = targetSchema.issueTypes.filter(type => !type.archived);
      const type = activeTypes.find(type => type.id === (requested.type ?? issue.type));
      const status = targetWorkflow.statuses.find(status => status.id === (requested.status ?? issue.status) &&
        (requested.status !== undefined || oldStatus?.category === status.category));
      const targetType = type?.id ?? activeTypes[0]?.id ?? issue.type;
      const targetStatus = status?.id ?? targetWorkflow.initialStatusId;
      if (!type) blockers.push({ code: 'target_type_required', issueId, message: '대상 프로젝트에서 사용할 업무 유형을 선택해 주세요.' });
      if (!status) blockers.push({ code: 'target_status_required', issueId, message: '대상 프로젝트에서 사용할 상태를 선택해 주세요.' });
      if (!Number.isSafeInteger(issue.version + 1)) blockers.push({ code: 'issue_version', issueId, message: '업무의 새 버전을 발급할 수 없습니다.' });
      const mapping: IssueProjectMoveMapping = { issueId, ...(type ? { type: targetType } : {}), ...(status ? { status: targetStatus } : {}),
        customFields: type ? effectiveFields(issue, targetType, requested, sourceSchema, targetSchema, blockers) : requested.customFields ?? {} };
      const category = targetWorkflow.statuses.find(status => status.id === targetStatus)?.category;
      if (status && category !== oldStatus?.category) warnings.push({ code: 'status_category_changed', issueId, message: '대상 상태의 분류에 맞춰 업무의 완료 여부가 바뀝니다.' });
      const draft: Issue = { ...issue, projectId: project.id, key: targetKeys[index], type: targetType, status: targetStatus,
        customFields: mapping.customFields, version: issue.version + 1, updatedAt: timestamp,
        completedAt: category === 'done' ? issue.completedAt ?? timestamp : null };
      for (const field of PLAN_FIELDS) {
        const kind = field.slice(0, -2) as 'cycle' | 'module' | 'release';
        const planId = requested[field] ?? null;
        const plan = planId ? plans.find(item => item.id === planId && item.kind === kind && item.status !== 'archived') : undefined;
        if (planId && !plan) blockers.push({ code: 'target_plan_invalid', issueId, message: '대상 프로젝트의 활성 계획 항목을 선택해 주세요.' });
        if (issue[field] && !plan) warnings.push({ code: 'source_plan_cleared', issueId, message: `기존 계획 항목 ${issue[kind] ?? ''} 연결이 해제됩니다.` });
        mapping[field] = plan?.id ?? null;
        draft[field] = mapping[field];
        draft[kind] = plan?.name ?? null;
      }
      drafts.push(draft);
      return { id: issueId, key: issue.key, title: issue.title, version: issue.version, targetKey: draft.key, mapping };
    });
    const parents = new Map(drafts.map(issue => [issue.id, issue]));
    for (const [index, draft] of drafts.entries()) {
      // An incomplete connected scope already explains why the parent cannot follow.
      if (!previewIssues[index].mapping.type || !previewIssues[index].mapping.status || (draft.parentId && !parents.has(draft.parentId))) continue;
      try { this.hooks.validate(draft, parents); }
      catch (error) {
        const message = this.hooks.validationMessage(error);
        if (message === null) throw error;
        blockers.push({ code: 'target_validation', issueId: draft.id, message });
      }
    }
    const token = blockers.length ? null : digest([
      this.store.setting('attachmentImportGeneration'), actorId, id, request, project, source.version, targetOrder.version, nextNumber,
      sourceSchema.version, targetSchema.version, sourceWorkflow.version, targetWorkflow.version, sourceCalendar.version, targetCalendar.version,
      previewIssues, [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      plans.filter(plan => previewIssues.some(issue => PLAN_FIELDS.some(field => issue.mapping[field] === plan.id))), warnings,
    ]);
    return { preview: { issueId: id, sourceProjectId: root.projectId, projectId: project.id, issues: previewIssues, blockers, warnings, token },
      drafts, targetOrder, nextNumber: nextNumber + ids.length };
  }

  preview(id: string, actorId: string, body: unknown): IssueProjectMovePreview {
    const request = parseRequest(body, false);
    return this.store.transaction(() => this.plan(id, actorId, request, false).preview);
  }

  apply(id: string, actorId: string, body: unknown, record: (before: Issue, after: Issue) => void): IssueProjectMoveResult {
    const { token, ...request } = parseRequest(body, true);
    return this.store.transaction(() => {
      const fingerprint = digest([this.store.setting('attachmentImportGeneration'), actorId, id, request]);
      const receipt = this.store.db.prepare('SELECT fingerprint,result FROM issue_project_move_receipts WHERE token=?').get(token!) as
        { fingerprint: string; result: string } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw stale();
        return { issues: JSON.parse(receipt.result) as Issue[], duplicate: true };
      }
      const { preview, drafts, targetOrder, nextNumber } = this.plan(id, actorId, request, true);
      if (preview.token !== token) throw stale();
      for (const issue of drafts) {
        const before = this.store.get<Issue>('issues', issue.id)!;
        this.store.put('issues', issue);
        record(before, issue);
      }
      this.hooks.appendOrder(targetOrder, drafts.map(issue => issue.id));
      this.store.db.prepare(`INSERT INTO issue_sequences(project_id,next_number) VALUES(?,?)
        ON CONFLICT(project_id) DO UPDATE SET next_number=excluded.next_number`).run(request.projectId, nextNumber);
      this.store.db.prepare('INSERT INTO issue_project_move_receipts(token,fingerprint,result) VALUES(?,?,?)')
        .run(token!, fingerprint, JSON.stringify(drafts));
      return { issues: drafts, duplicate: false };
    });
  }

  clearForImport(): void {
    if (!this.store.db.isTransaction) throw new IssueProjectMoveError(500, '가져오기 트랜잭션 안에서 이동 기록을 초기화해야 합니다.');
    this.store.db.exec('DELETE FROM issue_project_move_receipts');
  }
}
