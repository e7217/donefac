import { randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { BaselineIssue, BaselineMilestone, Issue, Milestone, Project, ScheduleBaseline, User, WorkCalendar } from '../shared/types.js';
import { validateWorkCalendar } from '../shared/calendar.js';
import { Store } from './store.js';

export class ScheduleArtifactError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
const fail = (status: number, message: string): never => { throw new ScheduleArtifactError(status, message); };
const object = (value: unknown, label: string): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(400, `${label} 형식을 확인해주세요.`);
const text = (value: unknown, label: string, max = 300): string => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(400, `${label}을(를) 확인해주세요.`);
const description = (value: unknown): string => typeof value === 'string' && value.length <= 200000 ? value : fail(400, '설명을 확인해주세요.');
const positive = (value: unknown): number => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fail(400, '양의 정수 버전이 필요합니다.');
const date = (value: unknown): string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : fail(400, '유효한 YYYY-MM-DD 날짜가 필요합니다.');
const nullableDate = (value: unknown) => value === null ? null : date(value);
const timestamp = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fail(400, '기록 시간을 확인해주세요.');
const status = (value: unknown): Milestone['status'] => value === 'open' || value === 'reached' ? value : fail(400, '이정표 상태를 확인해주세요.');
const array = (value: unknown, label: string): unknown[] => Array.isArray(value) && value.length <= 100000 ? value : fail(400, `${label} 목록을 확인해주세요.`);
const cas = (expected: unknown, current: { version: number }) => { if (positive(expected) !== current.version) fail(409, '다른 변경사항이 있습니다. 최신 내용을 불러온 뒤 다시 시도해주세요.'); };
const iso = () => new Date().toISOString();
type Hooks = {
  actor: (request: Request) => string;
  activity: (request: Request, type: string, id: string, action: string, detail?: string) => unknown;
  getCalendar: (projectId: string) => WorkCalendar;
};
export interface ImportedScheduleArtifacts { milestones: Milestone[]; baselines: ScheduleBaseline[] }

export class ScheduleArtifactService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS milestones(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),owner_id TEXT REFERENCES users(id),json TEXT NOT NULL
    );CREATE INDEX IF NOT EXISTS milestones_project ON milestones(project_id);
    CREATE TABLE IF NOT EXISTS baselines(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),author_id TEXT NOT NULL REFERENCES users(id),json TEXT NOT NULL
    );CREATE INDEX IF NOT EXISTS baselines_project ON baselines(project_id);`);
  }
  allMilestones(): Milestone[] { return this.store.all<Milestone>('milestones'); }
  allBaselines(): ScheduleBaseline[] { return this.store.all<ScheduleBaseline>('baselines'); }
  private milestone(id: unknown): Milestone { return typeof id === 'string' && this.store.get<Milestone>('milestones', id) || fail(404, '이정표를 찾을 수 없습니다.'); }
  private baseline(id: unknown): ScheduleBaseline { return typeof id === 'string' && this.store.get<ScheduleBaseline>('baselines', id) || fail(404, '기준선을 찾을 수 없습니다.'); }
  private project(id: unknown): string { if (typeof id !== 'string' || !this.store.get('projects', id)) fail(400, '프로젝트를 확인해주세요.'); return id as string; }
  private putMilestone(value: Milestone) { this.store.db.prepare('INSERT INTO milestones(id,project_id,owner_id,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,owner_id=excluded.owner_id,json=excluded.json').run(value.id, value.projectId, value.ownerId, JSON.stringify(value)); }
  private putBaseline(value: ScheduleBaseline) { this.store.db.prepare('INSERT INTO baselines(id,project_id,author_id,json) VALUES(?,?,?,?)').run(value.id, value.projectId, value.authorId, JSON.stringify(value)); }

  private parseMilestone(raw: unknown, projects: Project[], users: User[], issues: Issue[]): Milestone {
    const value = object(raw, '이정표');
    const projectId = text(value.projectId, '프로젝트 ID');
    if (!projects.some(project => project.id === projectId)) fail(400, '이정표 프로젝트를 찾을 수 없습니다.');
    const ownerId = value.ownerId === null ? null : text(value.ownerId, '담당자 ID');
    if (ownerId && !users.some(user => user.id === ownerId)) fail(400, '이정표 담당자를 찾을 수 없습니다.');
    const issueIds = array(value.issueIds, '연결 업무').map(id => text(id, '업무 ID'));
    if (new Set(issueIds).size !== issueIds.length) fail(400, '이정표에 중복된 업무가 있습니다.');
    for (const id of issueIds) if (!issues.some(issue => issue.id === id && issue.projectId === projectId)) fail(400, '연결 업무는 같은 프로젝트의 실제 업무여야 합니다.');
    return { id: text(value.id, '이정표 ID'), projectId, title: text(value.title, '이정표 제목'), description: description(value.description), date: date(value.date), status: status(value.status), ownerId, issueIds, version: positive(value.version), createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt) };
  }

  private guardVersions(expected: unknown, current: { id: string; version: number }[], label: string) {
    const map = object(expected, `${label} 버전`);
    for (const version of Object.values(map)) positive(version);
    if (Object.keys(map).length !== current.length || current.some(item => !Object.hasOwn(map, item.id) || map[item.id] !== item.version)) fail(409, `${label} 목록 또는 내용이 변경되었습니다. 새로고침 후 기준선을 저장해주세요.`);
  }

  private calendar(value: unknown, projectId: string): WorkCalendar {
    try { return validateWorkCalendar(value, projectId); }
    catch (error) { return fail(400, error instanceof Error ? error.message : '근무일 기준을 확인해주세요.'); }
  }
  capture(input: unknown, actorId: string, getCalendar: Hooks['getCalendar'], onCaptured?: (baseline: ScheduleBaseline) => void): ScheduleBaseline {
    const value = object(input, '기준선');
    const projectId = this.project(value.projectId);
    const name = text(value.name, '기준선 이름');
    const detail = description(value.description ?? '');
    if (!this.store.get('users', actorId)) fail(400, '기준선 작성자를 확인해주세요.');
    return this.store.transaction(() => {
      const issues = this.store.all<Issue>('issues').filter(issue => issue.projectId === projectId);
      const milestones = this.allMilestones().filter(milestone => milestone.projectId === projectId);
      const calendar = this.calendar(getCalendar(projectId), projectId);
      this.guardVersions(value.expectedIssueVersions, issues, '업무');
      this.guardVersions(value.expectedMilestoneVersions, milestones, '이정표');
      cas(value.expectedCalendarVersion, calendar);
      const baseline: ScheduleBaseline = {
        id: randomUUID(), projectId, name, description: detail, authorId: actorId, version: 1, createdAt: iso(), calendar: structuredClone(calendar),
        issues: issues.map(issue => ({ issueId: issue.id, key: issue.key, title: issue.title, startDate: issue.startDate, endDate: issue.endDate, sourceVersion: issue.version })),
        milestones: milestones.map(milestone => ({ milestoneId: milestone.id, title: milestone.title, date: milestone.date, status: milestone.status, sourceVersion: milestone.version })),
      };
      this.putBaseline(baseline);
      onCaptured?.(baseline);
      return baseline;
    });
  }

  /** Called inside the root issue-delete transaction. Historical baselines are
   * deliberately untouched; their values describe the time of capture. */
  detachIssue(issueId: string): Milestone[] {
    const changed = this.allMilestones().filter(milestone => milestone.issueIds.includes(issueId)).map(milestone => ({ ...milestone, issueIds: milestone.issueIds.filter(id => id !== issueId), version: milestone.version + 1, updatedAt: iso() }));
    for (const milestone of changed) this.putMilestone(milestone);
    return changed;
  }

  validateImport(rawMilestones: unknown, rawBaselines: unknown, projects: Project[], users: User[], issues: Issue[]): ImportedScheduleArtifacts {
    const milestones = array(rawMilestones, '이정표').map(value => this.parseMilestone(value, projects, users, issues));
    if (new Set(milestones.map(milestone => milestone.id)).size !== milestones.length) fail(400, '이정표 ID가 중복되었습니다.');
    const baselines = array(rawBaselines, '기준선').map(raw => {
      const value = object(raw, '기준선');
      const projectId = text(value.projectId, '기준선 프로젝트');
      if (!projects.some(project => project.id === projectId)) fail(400, '기준선 프로젝트를 찾을 수 없습니다.');
      const authorId = text(value.authorId, '기준선 작성자');
      if (!users.some(user => user.id === authorId)) fail(400, '기준선 작성자를 찾을 수 없습니다.');
      const calendar = this.calendar(value.calendar, projectId);
      const snapshots: BaselineIssue[] = array(value.issues, '기준선 업무').map(rawIssue => {
        const issue = object(rawIssue, '기준선 업무');
        const issueId = text(issue.issueId, '기준선 업무 ID');
        if (issues.some(current => current.id === issueId && current.projectId !== projectId)) fail(400, '다른 프로젝트의 업무를 기준선에 넣을 수 없습니다.');
        const startDate = nullableDate(issue.startDate), endDate = nullableDate(issue.endDate);
        if (startDate && endDate && startDate > endDate) fail(400, '기준선 업무의 종료일이 시작일보다 빠릅니다.');
        return { issueId, key: text(issue.key, '기준선 업무 번호'), title: text(issue.title, '기준선 업무 제목'), startDate, endDate, sourceVersion: positive(issue.sourceVersion) };
      });
      if (new Set(snapshots.map(issue => issue.issueId)).size !== snapshots.length) fail(400, '기준선 업무 ID가 중복되었습니다.');
      const markers: BaselineMilestone[] = array(value.milestones, '기준선 이정표').map(rawMarker => {
        const marker = object(rawMarker, '기준선 이정표');
        const milestoneId = text(marker.milestoneId, '기준선 이정표 ID');
        if (milestones.some(current => current.id === milestoneId && current.projectId !== projectId)) fail(400, '다른 프로젝트의 이정표를 기준선에 넣을 수 없습니다.');
        return { milestoneId, title: text(marker.title, '기준선 이정표 제목'), date: date(marker.date), status: status(marker.status), sourceVersion: positive(marker.sourceVersion) };
      });
      if (new Set(markers.map(marker => marker.milestoneId)).size !== markers.length) fail(400, '기준선 이정표 ID가 중복되었습니다.');
      return { id: text(value.id, '기준선 ID'), projectId, name: text(value.name, '기준선 이름'), description: description(value.description), authorId, version: positive(value.version), createdAt: timestamp(value.createdAt), calendar: structuredClone(calendar), issues: snapshots, milestones: markers };
    });
    if (new Set(baselines.map(baseline => baseline.id)).size !== baselines.length) fail(400, '기준선 ID가 중복되었습니다.');
    return { milestones, baselines };
  }

  replaceImported(values: ImportedScheduleArtifacts, oldMilestones = new Map<string, number>(), oldBaselines = new Map<string, number>()) {
    for (const milestone of values.milestones) this.putMilestone({ ...milestone, version: Math.max(milestone.version, (oldMilestones.get(milestone.id) || 0) + 1) });
    for (const baseline of values.baselines) this.putBaseline({ ...baseline, version: Math.max(baseline.version, (oldBaselines.get(baseline.id) || 0) + 1) });
  }

  registerRoutes(app: Express, hooks: Hooks) {
    const route = (handler: (request: Request, response: Response) => unknown) => (request: Request, response: Response, next: NextFunction) => { try { handler(request, response); } catch (error) { next(error); } };
    app.get('/api/milestones', route((request, response) => { const id = this.project(request.query.projectId); response.json(this.allMilestones().filter(milestone => milestone.projectId === id)); }));
    app.post('/api/milestones', route((request, response) => {
      const value = this.store.transaction(() => {
        const now = iso();
        const milestone = this.parseMilestone({ id: randomUUID(), projectId: request.body.projectId, title: request.body.title, description: request.body.description === undefined ? '' : request.body.description, date: request.body.date, status: request.body.status === undefined ? 'open' : request.body.status, ownerId: request.body.ownerId === undefined ? null : request.body.ownerId, issueIds: request.body.issueIds === undefined ? [] : request.body.issueIds, version: 1, createdAt: now, updatedAt: now }, this.store.all('projects'), this.store.all('users'), this.store.all('issues'));
        hooks.actor(request); this.putMilestone(milestone); hooks.activity(request, 'milestone', milestone.id, '이정표 생성', milestone.title); return milestone;
      });
      response.status(201).json(value);
    }));
    app.patch('/api/milestones/:id', route((request, response) => {
      const updated = this.store.transaction(() => {
        const old = this.milestone(request.params.id); cas(request.body.expectedVersion, old);
        if (Object.hasOwn(request.body, 'projectId') && request.body.projectId !== old.projectId) fail(400, '이정표 프로젝트는 변경할 수 없습니다.');
        const fields = ['title', 'description', 'date', 'status', 'ownerId', 'issueIds'];
        const milestone = this.parseMilestone({ ...old, ...Object.fromEntries(fields.filter(field => Object.hasOwn(request.body, field)).map(field => [field, request.body[field]])), version: old.version + 1, updatedAt: iso() }, this.store.all('projects'), this.store.all('users'), this.store.all('issues'));
        hooks.actor(request); this.putMilestone(milestone); hooks.activity(request, 'milestone', milestone.id, '이정표 변경', milestone.title); return milestone;
      });
      response.json(updated);
    }));
    const deleteVersion = (request: Request) => { const value = request.query.expectedVersion; if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(400, '삭제할 대상의 expectedVersion이 필요합니다.'); return positive(Number(value)); };
    app.delete('/api/milestones/:id', route((request, response) => {
      this.store.transaction(() => { const milestone = this.milestone(request.params.id); cas(deleteVersion(request), milestone); hooks.actor(request); this.store.remove('milestones', milestone.id); hooks.activity(request, 'milestone', milestone.id, '이정표 삭제', milestone.title); }); response.json({ ok: true });
    }));
    app.get('/api/baselines', route((request, response) => { const id = this.project(request.query.projectId); response.json(this.allBaselines().filter(baseline => baseline.projectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }));
    app.get('/api/baselines/:id', route((request, response) => response.json(this.baseline(request.params.id))));
    app.post('/api/baselines', route((request, response) => {
      const actor = hooks.actor(request);
      const baseline = this.capture(request.body, actor, projectId => hooks.getCalendar(projectId), value => hooks.activity(request, 'baseline', value.id, '일정 기준선 저장', value.name));
      response.status(201).json(baseline);
    }));
    app.delete('/api/baselines/:id', route((request, response) => {
      this.store.transaction(() => { const baseline = this.baseline(request.params.id); cas(deleteVersion(request), baseline); hooks.actor(request); this.store.remove('baselines', baseline.id); hooks.activity(request, 'baseline', baseline.id, '일정 기준선 삭제', baseline.name); }); response.json({ ok: true });
    }));
  }
}
