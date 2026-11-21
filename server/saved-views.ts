import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { PlanningItem, Project, ProjectIssueSchema, SavedView, SavedViewState, User } from '../shared/types.js';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import { parseIssueFieldFilter } from '../shared/issue-field-filter.js';
import {
  IssueViewGitlabFilterError, IssueViewPlanningFilterError, IssueViewPriorityLabelFilterError, IssueViewReporterFilterError,
  parseIssueViewGitlabFilter, parseIssueViewLabelFilter, parseIssueViewPlanningFilter, parseIssueViewPriorities, parseIssueViewReporterFilter,
} from '../shared/issue-view.js';
import { planningFields } from '../shared/planning-helpers.js';
import type { IssueSchemaService } from './issue-schema.js';
import { Store } from './store.js';

export class SavedViewError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new SavedViewError(message, status); };
const string = (value: unknown, name: string, max: number, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) return fail(`${name}을(를) 확인해주세요.`);
  return empty ? value : value.trim();
};
function state(value: unknown, schema: ProjectIssueSchema, users: User[], planningItems: readonly PlanningItem[], previous?: SavedViewState['filters']): SavedViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('보기 설정은 객체여야 합니다.');
  const v = value as Record<string, unknown>;
  const { layout, boardGrouping } = v;
  if (layout !== 'list' && layout !== 'board') return fail('목록 또는 보드 보기만 저장할 수 있습니다.');
  if (boardGrouping != null && boardGrouping !== 'assignee') return fail('보드 묶는 기준을 확인해주세요.');
  if (!v.filters || typeof v.filters !== 'object' || Array.isArray(v.filters)) return fail('보기 필터가 올바르지 않습니다.');
  const filters = v.filters as Record<string, unknown>;
  const query = string(filters.query, '검색어', 800, true);
  const status = string(filters.status, '상태 필터', 80);
  const assigneeId = string(filters.assigneeId, '담당자 필터', 100);
  const type = string(filters.type, '유형 필터', 80);
  if (type !== 'all' && !schema.issueTypes.some(value => value.id === type)) return fail('지원하지 않는 업무 유형 필터입니다.');
  const fieldFilter = filters.fieldFilter == null ? undefined : parseIssueFieldFilter(filters.fieldFilter, schema, users);
  try {
    const planning = parseIssueViewPlanningFilter(Object.hasOwn(filters, 'planning') ? filters.planning : previous?.planning, schema.projectId, planningItems);
    const gitlabInput = Object.hasOwn(filters, 'gitlab') ? filters.gitlab : previous?.gitlab;
    const gitlab = previous && gitlabInput === null ? undefined : parseIssueViewGitlabFilter(gitlabInput);
    const priorities = Object.hasOwn(filters, 'priorities') ? parseIssueViewPriorities(filters.priorities) : previous?.priorities;
    const labels = Object.hasOwn(filters, 'labels') ? parseIssueViewLabelFilter(filters.labels) : previous?.labels;
    const reporter = parseIssueViewReporterFilter(Object.hasOwn(filters, 'reporter') ? filters.reporter : previous?.reporter, users);
    return { layout, ...(layout === 'board' && boardGrouping === 'assignee' ? { boardGrouping } : {}), filters: {
      query, status, assigneeId, type, ...(fieldFilter ? {fieldFilter} : {}), ...(planning ? {planning} : {}), ...(gitlab ? {gitlab} : {}),
      ...(priorities ? { priorities } : {}), ...(labels ? { labels } : {}), ...(reporter ? { reporter } : {}),
    } };
  } catch (error) {
    if (error instanceof IssueViewPlanningFilterError || error instanceof IssueViewGitlabFilterError ||
        error instanceof IssueViewPriorityLabelFilterError || error instanceof IssueViewReporterFilterError) return fail(error.message, error.status);
    throw error;
  }
}
const validTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
// Match SQLite's NOCASE collation, which folds ASCII letters only.
const nameKey = (projectId: string, name: string) => JSON.stringify([projectId, name.replace(/[A-Z]/g, letter => letter.toLowerCase())]);

/** Persisted shared project views. It deliberately does not introduce an account/permission engine. */
export class SavedViewService {
  constructor(private readonly store: Store, private readonly issueSchemas?: IssueSchemaService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS saved_views(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      json TEXT NOT NULL,
      UNIQUE(project_id,name)
    ); CREATE INDEX IF NOT EXISTS saved_views_project ON saved_views(project_id);`);
  }
  all(): SavedView[] { return this.store.all<SavedView>('saved_views'); }
  findPlanningItemReference(item: PlanningItem): Pick<SavedView, 'id' | 'name'> | undefined {
    const path = `$.filters.planning.${planningFields(item.kind).idField}`;
    return this.store.db.prepare(`SELECT id,name FROM saved_views
      WHERE project_id=? AND json_extract(json,?)=? ORDER BY name LIMIT 1`).get(item.projectId, path, item.id) as Pick<SavedView, 'id' | 'name'> | undefined;
  }
  private project(id: unknown) {
    if (typeof id !== 'string' || !this.store.get('projects', id)) return fail('프로젝트를 찾을 수 없습니다.', 404);
    return id;
  }
  private get(id: string): SavedView { return this.store.get<SavedView>('saved_views', id) || fail('저장된 보기를 찾을 수 없습니다.', 404); }
  private put(view: SavedView) {
    this.store.db.prepare('INSERT INTO saved_views(id,project_id,name,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,json=excluded.json').run(view.id, view.projectId, view.name, JSON.stringify(view));
  }
  private validateAssignee(view: SavedViewState, users: User[]) {
    if (!['all', 'none'].includes(view.filters.assigneeId) && !users.some(u => u.id === view.filters.assigneeId)) return fail('담당자 필터의 팀원을 찾을 수 없습니다.');
  }
  validateImport(values: unknown, projects: Project[], users: User[], issueSchemas: ProjectIssueSchema[] = [], planningItems: readonly PlanningItem[] = []): SavedView[] {
    if (!Array.isArray(values) || values.length > 5000) return fail('저장된 보기 목록을 확인해주세요.');
    const ids = new Set<string>();
    const names = new Set<string>();
    return values.map(value => {
      if (!value || typeof value !== 'object') return fail('저장된 보기 형식을 확인해주세요.');
      const id = string(value.id, '보기 ID', 100);
      const projectId = string(value.projectId, '프로젝트 ID', 100);
      const name = string(value.name, '보기 이름', 80);
      const authorId = string(value.authorId, '보기 작성자', 100);
      if (!projects.some(p => p.id === projectId) || !users.some(u => u.id === authorId)) return fail('저장된 보기의 프로젝트 또는 작성자를 찾을 수 없습니다.');
      if (ids.has(id) || names.has(nameKey(projectId, name))) return fail('저장된 보기의 ID 또는 이름이 중복됩니다.');
      ids.add(id); names.add(nameKey(projectId, name));
      if (!Number.isSafeInteger(value.version) || value.version < 1 || !validTime(value.createdAt) || !validTime(value.updatedAt)) return fail('저장된 보기의 버전 또는 작성 시간이 올바르지 않습니다.');
      const selected = state(value, issueSchemas.find(schema => schema.projectId === projectId) || defaultIssueSchema(projectId), users, planningItems);
      this.validateAssignee(selected, users);
      return { id, projectId, name, authorId, ...selected, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
    });
  }
  /** Caller owns the import transaction; versions keep pre-import editors stale. */
  replaceImported(values: SavedView[], previous = new Map(this.all().map(view => [view.id, view.version]))) {
    this.store.db.exec('DELETE FROM saved_views');
    for (const value of values) {
      const old = previous.get(value.id);
      this.put({ ...value, version: old === undefined ? value.version : Math.max(old, value.version) + 1 });
    }
  }
  registerRoutes(app: Express, hooks: {
    actor: (request: Request) => string;
    activity: (request: Request, resourceType: string, resourceId: string, action: string, detail?: string) => unknown;
    planningItems: (projectId: string) => readonly PlanningItem[];
  }) {
    const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
      try { handler(req, res); }
      catch (error) {
        if (error instanceof SavedViewError) return res.status(error.status).json({ error: error.message });
        if ((error as Error)?.message?.includes('saved_views.project_id, saved_views.name')) return res.status(409).json({ error: '이 프로젝트에 같은 이름의 보기가 있습니다.' });
        next(error);
      }
    };
    app.get('/api/views', route((req, res) => {
      const projectId = this.project(req.query.projectId);
      res.json(this.all().filter(view => view.projectId === projectId).sort((a,b) => a.name.localeCompare(b.name, 'ko')));
    }));
    app.post('/api/views', route((req, res) => {
      const view = this.store.transaction(() => {
        const projectId = this.project(req.body.projectId);
        const users = this.store.all<User>('users');
        const selected = state(req.body, this.issueSchemas?.get(projectId) || defaultIssueSchema(projectId), users, hooks.planningItems(projectId));
        this.validateAssignee(selected, users);
        const now = new Date().toISOString();
        const view: SavedView = { id: randomUUID(), projectId, name: string(req.body.name, '보기 이름', 80), ...selected, authorId: hooks.actor(req), version: 1, createdAt: now, updatedAt: now };
        this.put(view);
        hooks.activity(req, 'project', projectId, '업무 보기 저장', view.name);
        return view;
      });
      res.status(201).json(view);
    }));
    app.patch('/api/views/:id', route((req, res) => {
      const updated = this.store.transaction(() => {
        const old = this.get(String(req.params.id));
        if (!Number.isSafeInteger(req.body.expectedVersion)) return fail('보기의 expectedVersion이 필요합니다.');
        if (req.body.expectedVersion !== old.version) return fail('다른 작업자가 보기를 변경했습니다. 다시 불러온 뒤 저장해주세요.', 409);
        if ('projectId' in req.body && req.body.projectId !== old.projectId) return fail('보기의 프로젝트는 변경할 수 없습니다.');
        const users = this.store.all<User>('users');
        const selected = state({ ...old, ...req.body }, this.issueSchemas?.get(old.projectId) || defaultIssueSchema(old.projectId), users, hooks.planningItems(old.projectId), old.filters);
        this.validateAssignee(selected, users);
        const updated: SavedView = { ...old, ...selected, name: 'name' in req.body ? string(req.body.name, '보기 이름', 80) : old.name, version: old.version + 1, updatedAt: new Date().toISOString() };
        if (!selected.boardGrouping) delete updated.boardGrouping;
        this.put(updated);
        hooks.activity(req, 'project', old.projectId, '업무 보기 변경', updated.name);
        return updated;
      });
      res.json(updated);
    }));
    app.delete('/api/views/:id', route((req, res) => {
      const version = Number(req.query.expectedVersion);
      if (!Number.isSafeInteger(version) || version < 1) return fail('삭제할 보기의 expectedVersion이 필요합니다.');
      this.store.transaction(() => {
        const old = this.get(String(req.params.id));
        if (version !== old.version) return fail('다른 작업자가 보기를 변경했습니다. 다시 확인해주세요.', 409);
        this.store.remove('saved_views', old.id);
        hooks.activity(req, 'project', old.projectId, '업무 보기 삭제', old.name);
      });
      res.json({ ok: true });
    }));
  }
}
