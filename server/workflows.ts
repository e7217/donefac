import type { Express, Request } from 'express';
import { type Issue, type IssueRequiredField, type Project, type ProjectIssueSchema, type ProjectWorkflow, type WorkflowFieldRule, type WorkflowStatus, type WorkflowTransition } from '../shared/types.js';
import { MAX_WORKING_DURATION_DAYS } from '../shared/calendar.js';
import { defaultWorkflow, MAX_WORKFLOW_WIP_LIMIT, STATUS_CATEGORY_LABELS } from '../shared/workflow-helpers.js';
import { BASE_REQUIRED_FIELD_LABELS, defaultIssueSchema, fieldApplies, hasCustomValue, requiredFieldLabels } from '../shared/issue-schema.js';
import { visibilityFieldsWithMissingStatuses, type IssueSchemaService } from './issue-schema.js';
import { directTeamspaceBlockers, type IssueRelationsService } from './issue-relations.js';
import type { Store } from './store.js';

export class WorkflowError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
function invalid(message: string, status = 400, details?: unknown): never { throw new WorkflowError(status, message, details); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('워크플로 설정 객체가 필요합니다.'); return value as Record<string, unknown>; }
function fields(value: unknown, schema: ProjectIssueSchema): IssueRequiredField[] {
  if (!Array.isArray(value) || !value.every(field => typeof field === 'string' && (Object.hasOwn(BASE_REQUIRED_FIELD_LABELS, field) || field.startsWith('custom:') && schema.fields.some(definition => definition.id === field.slice(7) && !definition.archived)))) invalid('지원하지 않거나 보관된 필수 속성이 있습니다.');
  return [...new Set(value)] as IssueRequiredField[];
}
function nonempty(value: unknown, label: string, limit: number): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) invalid(`${label}을(를) 확인해 주세요.`); return value.trim(); }
function config(projectId: string, value: unknown, version: number, updatedAt: string, schema: ProjectIssueSchema, previous?: ProjectWorkflow): ProjectWorkflow {
  const source = object(value);
  const issueTypes = new Set(schema.issueTypes.map(type => type.id));
  const previousStatuses = new Map(previous?.statuses.map(status => [status.id, status]));
  const previousBlockerGuards = new Set(previous?.transitions.filter(edge => edge.requireResolvedBlockers).map(edge => `${edge.from}:${edge.to}`));
  if (!Array.isArray(source.statuses) || source.statuses.length < 1 || source.statuses.length > 40) invalid('상태는 1~40개여야 합니다.');
  const statuses: WorkflowStatus[] = source.statuses.map(value => {
    const status = object(value), id = nonempty(status.id, '상태 ID', 48), label = nonempty(status.label, '상태 이름', 40);
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) invalid('상태 ID는 영문 소문자로 시작하는 영문·숫자·밑줄·하이픈이어야 합니다.');
    if (typeof status.color !== 'string' || !/^#[a-f\d]{6}$/i.test(status.color)) invalid('상태 색상은 #RRGGBB 형식이어야 합니다.');
    if (typeof status.category !== 'string' || !Object.hasOwn(STATUS_CATEGORY_LABELS, status.category)) invalid('상태 분류를 확인해 주세요.');
    const previousStatus = previousStatuses.get(id);
    const limit = status.wipLimit === undefined ? previousStatus?.wipLimit : status.wipLimit;
    const defaultDueWorkdays = status.defaultDueWorkdays === undefined ? previousStatus?.defaultDueWorkdays : status.defaultDueWorkdays;
    const normalized: WorkflowStatus = { id, label, color: status.color, category: status.category as WorkflowStatus['category'] };
    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_WIP_LIMIT) {
        invalid('상태별 보드 업무 한도는 1~10,000의 정수 또는 null이어야 합니다.');
      }
      normalized.wipLimit = limit;
    }
    if (defaultDueWorkdays != null) {
      if (typeof defaultDueWorkdays !== 'number' || !Number.isSafeInteger(defaultDueWorkdays) ||
        defaultDueWorkdays < 1 || defaultDueWorkdays > MAX_WORKING_DURATION_DAYS) {
        invalid('상태별 기본 목표 마감일의 근무일 수는 1~3,650의 정수 또는 null이어야 합니다.');
      }
      normalized.defaultDueWorkdays = defaultDueWorkdays;
    }
    return normalized;
  });
  const ids = new Set(statuses.map(status => status.id));
  if (ids.size !== statuses.length) invalid('중복된 상태 ID가 있습니다.');
  if (typeof source.initialStatusId !== 'string' || !ids.has(source.initialStatusId)) invalid('새 업무의 기본 상태를 선택해 주세요.');
  if (!Array.isArray(source.transitions) || source.transitions.length > 1600) invalid('허용 전이 목록을 확인해 주세요.');
  const pairs = new Set<string>();
  const transitions: WorkflowTransition[] = source.transitions.map(value => {
    const edge = object(value);
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string' || !ids.has(edge.from) || !ids.has(edge.to)) invalid('전이의 출발·도착 상태가 설정에 없습니다.');
    const pair = `${edge.from}:${edge.to}`;
    if (pairs.has(pair)) invalid('같은 상태 사이의 전이는 한 번만 설정해 주세요.'); pairs.add(pair);
    if (!Array.isArray(edge.issueTypes) || !edge.issueTypes.every(type => typeof type === 'string' && issueTypes.has(type))) invalid('전이의 업무 유형을 확인해 주세요.');
    if (Object.hasOwn(edge, 'requireResolvedBlockers') && typeof edge.requireResolvedBlockers !== 'boolean') {
      invalid('열린 차단 업무 제한은 true 또는 false여야 합니다.');
    }
    const requireResolvedBlockers = edge.requireResolvedBlockers ?? previousBlockerGuards.has(pair);
    return { from: edge.from, to: edge.to, issueTypes: [...new Set(edge.issueTypes)] as string[], requiredFields: fields(edge.requiredFields, schema),
      ...(requireResolvedBlockers ? { requireResolvedBlockers: true } : {}) };
  });
  if (!Array.isArray(source.fieldRules) || source.fieldRules.length > 1000) invalid('유형·상태별 필수 속성 규칙을 확인해 주세요.');
  const rules = new Set<string>();
  const fieldRules: WorkflowFieldRule[] = source.fieldRules.map(value => {
    const rule = object(value);
    if (typeof rule.issueType !== 'string' || (rule.issueType !== '*' && !issueTypes.has(rule.issueType))) invalid('필수 속성 규칙의 업무 유형을 확인해 주세요.');
    if (typeof rule.statusId !== 'string' || !ids.has(rule.statusId)) invalid('필수 속성 규칙의 상태를 확인해 주세요.');
    const key = `${rule.issueType}:${rule.statusId}`; if (rules.has(key)) invalid('같은 유형·상태의 필수 속성 규칙이 중복되었습니다.'); rules.add(key);
    return { issueType: rule.issueType, statusId: rule.statusId, requiredFields: fields(rule.requiredFields, schema) };
  });
  return { id: projectId, projectId, version, initialStatusId: source.initialStatusId, statuses, transitions, fieldRules, updatedAt };
}
export function validateWorkflowImport(value: unknown, projects: Project[], issues: Issue[], issueSchemas: ProjectIssueSchema[] = []): ProjectWorkflow[] {
  if (!Array.isArray(value)) invalid('백업의 workflows 목록이 필요합니다.');
  const projectIds = new Set(projects.map(project => project.id));
  const seen = new Set<string>();
  const result = value.map(value => {
    const source = object(value);
    if (typeof source.projectId !== 'string' || source.id !== source.projectId || !projectIds.has(source.projectId)) invalid('워크플로의 프로젝트 참조가 올바르지 않습니다.');
    if (seen.has(source.projectId)) invalid('프로젝트 워크플로가 중복되었습니다.'); seen.add(source.projectId);
    if (!Number.isSafeInteger(source.version) || Number(source.version) < 1) invalid('워크플로 버전이 올바르지 않습니다.');
    if (typeof source.updatedAt !== 'string' || Number.isNaN(Date.parse(source.updatedAt))) invalid('워크플로 수정 시간이 올바르지 않습니다.');
    return config(source.projectId, source, Number(source.version), source.updatedAt, issueSchemas.find(schema => schema.projectId === source.projectId) || defaultIssueSchema(source.projectId));
  });
  for (const project of projects) if (!seen.has(project.id)) result.push(defaultWorkflow(project.id, project.createdAt));
  for (const issue of issues) {
    const workflow = result.find(value => value.projectId === issue.projectId);
    if (!workflow || !workflow.statuses.some(status => status.id === issue.status)) invalid(`${issue.key || issue.id}: 백업 워크플로에 없는 상태입니다.`);
  }
  return result;
}
type Hooks = { actor?: (request: Request) => string; activity?: (request: Request, resourceType: string, resourceId: string, action: string, detail?: string) => void };

export class WorkflowService {
  constructor(private readonly store: Store, private readonly issueSchemas?: IssueSchemaService,
    private readonly issueRelations?: Pick<IssueRelationsService, 'directBlockers'>) {
    store.db.exec('CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL)');
  }
  get(projectId: string): ProjectWorkflow {
    const project = this.store.get<Project>('projects', projectId); if (!project) invalid('프로젝트를 찾을 수 없습니다.', 404);
    return this.store.get<ProjectWorkflow>('workflows', projectId) || defaultWorkflow(projectId, project.createdAt);
  }
  snapshot(): ProjectWorkflow[] { return this.store.all<Project>('projects').map(project => this.get(project.id)); }
  save(projectId: string, input: unknown, expectedVersion: unknown, afterSave?: (workflow: ProjectWorkflow) => void): ProjectWorkflow {
    return this.store.transaction(() => {
      const previous = this.get(projectId);
      if (!Number.isInteger(expectedVersion)) invalid('expectedVersion이 필요합니다.');
      if (expectedVersion !== previous.version) invalid('다른 작업자가 워크플로를 변경했습니다. 최신 설정을 불러온 뒤 다시 편집해 주세요.', 409, { currentVersion: previous.version });
      const schema = this.issueSchemas?.get(projectId) ?? defaultIssueSchema(projectId);
      const next = config(projectId, input, previous.version + 1, new Date().toISOString(), schema, previous);
      const statusIds = new Set(next.statuses.map(status => status.id));
      const visibilityFields = visibilityFieldsWithMissingStatuses(schema, statusIds);
      if (visibilityFields.length) invalid('필드 표시 조건에서 참조하는 상태입니다. 표시 조건을 변경한 뒤 상태를 삭제해 주세요.', 409, { fieldIds: visibilityFields.map(field => field.id) });
      const issues = this.store.all<Issue>('issues').filter(issue => issue.projectId === projectId);
      const referenced = issues.filter(issue => !statusIds.has(issue.status));
      if (referenced.length) invalid(`사용 중인 상태는 삭제할 수 없습니다: ${[...new Set(referenced.map(issue => previous.statuses.find(status => status.id === issue.status)?.label || issue.status))].join(', ')}`, 409, { issueIds: referenced.map(issue => issue.id) });
      for(const table of ['automation_rules','issue_assignment_rules']){
        if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
        const rules=this.store.all<Pick<import('../shared/types.js').AutomationRule,'projectId'|'fromStatuses'|'toStatusId'>>(table);
        if(rules.some(rule=>rule.projectId===projectId&&[...rule.fromStatuses,rule.toStatusId].some(id=>!statusIds.has(id)))){
          invalid('자동화 규칙에서 참조하는 상태입니다. 규칙을 변경하거나 삭제한 뒤 상태를 삭제해 주세요.',409);
        }
      }
      for (const issue of issues) {
        const wasDone = previous.statuses.find(status => status.id === issue.status)?.category === 'done';
        const isDone = next.statuses.find(status => status.id === issue.status)?.category === 'done';
        const completedAt = isDone ? (wasDone && issue.completedAt ? issue.completedAt : next.updatedAt) : null;
        if (wasDone !== isDone || issue.completedAt !== completedAt) this.store.put('issues', { ...issue, completedAt, version: issue.version + 1, updatedAt: next.updatedAt });
      }
      this.store.put('workflows', next); afterSave?.(next); return next;
    });
  }
  validateIssue(next: Issue, previous?: Issue, options: { checkTransition?: boolean; checkFields?: boolean } = {}): void {
    const workflow = this.get(next.projectId);
    if (!workflow.statuses.some(status => status.id === next.status)) invalid('프로젝트 워크플로에 없는 상태입니다.');
    const required = workflow.fieldRules.filter(rule => rule.statusId === next.status && (rule.issueType === '*' || rule.issueType === next.type)).flatMap(rule => rule.requiredFields);
    if (previous && previous.status !== next.status && options.checkTransition !== false) {
      const edge = workflow.transitions.find(edge => edge.from === previous.status && edge.to === next.status && (!edge.issueTypes.length || edge.issueTypes.includes(next.type)));
      if (!edge) invalid(`허용되지 않은 상태 전이입니다: ${previous.status} → ${next.status}`, 422);
      if (edge.requireResolvedBlockers && this.hasOpenBlockers(next.id, workflow)) {
        invalid('열린 차단 업무를 해결한 뒤 상태를 변경해 주세요.', 422, { reason: 'open_issue_blockers' });
      }
      required.push(...edge.requiredFields);
    }
    if (options.checkFields === false) return;
    const schema = this.issueSchemas?.get(next.projectId) || defaultIssueSchema(next.projectId);
    const missing = [...new Set(required)].filter(field => {
      if (field.startsWith('custom:')) { const id = field.slice(7), definition = schema.fields.find(value => value.id === id); return Boolean(definition && !definition.archived && fieldApplies(definition, next.type) && !hasCustomValue(next.customFields?.[id])); }
      const value = next[field as keyof Issue]; return value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.some(item => typeof item === 'string' && item.trim()));
    });
    if (missing.length) invalid(`필수 속성을 입력해 주세요: ${requiredFieldLabels({ issueSchemas: [schema] }, next.projectId, missing).join(', ')}`, 422, { requiredFields: missing });
  }
  private hasOpenBlockers(issueId: string, targetWorkflow: ProjectWorkflow): boolean {
    const blockers = this.issueRelations?.directBlockers([issueId]) ?? directTeamspaceBlockers(this.store, [issueId]);
    if (!blockers.length) return false;
    const sources = this.store.db.prepare(`SELECT source.project_id AS projectId, json_extract(source.json, '$.status') AS status
      FROM json_each(?) AS verified JOIN issues AS source ON source.id=verified.value`)
      .iterate(JSON.stringify(blockers.map(({ sourceIssueId }) => sourceIssueId))) as Iterable<{ projectId: string; status: string }>;
    const workflows = new Map([[targetWorkflow.projectId, targetWorkflow]]);
    for (const { projectId, status } of sources) {
      let workflow = workflows.get(projectId);
      if (!workflow) {
        workflow = this.get(projectId);
        workflows.set(projectId, workflow);
      }
      const category = workflow.statuses.find(value => value.id === status)?.category;
      if (category !== 'done' && category !== 'cancelled') return true;
    }
    return false;
  }
  validateImport(value: unknown, projects: Project[], issues: Issue[], issueSchemas: ProjectIssueSchema[] = []) { return validateWorkflowImport(value, projects, issues, issueSchemas); }
  replaceImported(workflows: ProjectWorkflow[]): void { this.store.db.exec('DELETE FROM workflows'); workflows.forEach(workflow => this.store.put('workflows', workflow)); }
  registerRoutes(app: Express, hooks: Hooks = {}): void {
    app.get('/api/projects/:projectId/workflow', (request, response) => { response.json(this.get(String(request.params.projectId))); });
    app.patch('/api/projects/:projectId/workflow', (request, response) => {
      hooks.actor?.(request);
      const workflow = this.save(String(request.params.projectId), request.body, request.body?.expectedVersion, saved => hooks.activity?.(request, 'project', saved.projectId, '워크플로 변경', `버전 ${saved.version} · 상태 ${saved.statuses.length}개`));
      response.json(workflow);
    });
  }
}
