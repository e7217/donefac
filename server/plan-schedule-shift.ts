import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { calendarDate, calendarDay, CalendarError, createCalendarMath } from '../shared/calendar.js';
import { planningFields } from '../shared/planning-helpers.js';
import type { Dependency, Issue, PlanningItem, PlanScheduleDates, PlanScheduleShiftPreview, PlanScheduleShiftResult, WorkCalendar } from '../shared/types.js';
import { dependencyGuardFields } from '../shared/schedule-dependencies.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS, type AutomaticScheduleMutation } from './automatic-schedule.js';
import type { Store } from './store.js';

export class PlanScheduleShiftError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

interface Versions { calendar: number; workflow: number; schema: number }
interface Hooks {
  actor(request: Request): string;
  calendar(projectId: string): WorkCalendar;
  versions(projectId: string): Versions;
  isTerminal(issue: Issue): boolean;
  validateChange(issue: Issue, change: AutomaticScheduleMutation): string | null;
  warnings(issues: Issue[], dependencies: Dependency[]): string[];
  commit(request: Request, plan: PlanningItem, dates: PlanScheduleDates, changes: AutomaticScheduleMutation[], dependencies: Dependency[]): PlanScheduleShiftResult;
}
interface ProjectState { issues: Issue[]; members: Issue[]; dependencies: Dependency[] }
interface Proposal {
  id: string;
  actorId: string;
  planId: string;
  includeLinked: boolean;
  workingDays: boolean;
  removeAfter: string;
  guard: string;
  dates: PlanScheduleDates;
  changes: AutomaticScheduleMutation[];
  result?: PlanScheduleShiftResult;
}

const table = 'plan_schedule_previews';
const AFTER = (ms: number) => new Date(Date.now() + ms).toISOString();
const MAX_ISSUES = 10_000;
const MAX_MEMBERS = 1_000;
const emptyState: ProjectState = { issues: [], members: [], dependencies: [] };
const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function fail(status: number, message: string): never { throw new PlanScheduleShiftError(status, message); }
function datesOf(plan: PlanningItem): PlanScheduleDates {
  return { startDate: plan.startDate, endDate: plan.endDate, targetDate: plan.targetDate };
}
function incidentLinks(state: ProjectState, changes: AutomaticScheduleMutation[]) {
  const ids = new Set(changes.map(change => change.id));
  return state.dependencies.filter(link => ids.has(link.predecessorId) || ids.has(link.successorId));
}

export class PlanScheduleShiftService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS plan_schedule_previews (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plan_schedule_remove_after ON plan_schedule_previews(json_extract(json,'$.removeAfter'));`);
    this.prune();
  }
  private prune() {
    this.store.db.prepare("DELETE FROM plan_schedule_previews WHERE json_extract(json,'$.removeAfter') <= ?").run(AFTER(0));
  }
  private getPlan(id: string) {
    return this.store.get<PlanningItem>('planning_items', id) ?? fail(404, '계획 항목을 찾을 수 없습니다.');
  }
  private projectState(plan: PlanningItem): ProjectState {
    const issueRows = this.store.db.prepare('SELECT json FROM issues WHERE project_id=? LIMIT ?').all(plan.projectId, MAX_ISSUES + 1) as {json:string}[];
    if (issueRows.length > MAX_ISSUES) fail(413, '연결 업무를 함께 이동할 때 프로젝트 업무는 10,000개까지 지원합니다.');
    const issues = issueRows.map(row => JSON.parse(row.json) as Issue);
    const field = planningFields(plan.kind).idField;
    const members = issues.filter(issue => issue[field] === plan.id).sort(compareId);
    if (members.length > MAX_MEMBERS) fail(413, '한 번에 연결 업무 1,000개까지 검토할 수 있습니다.');
    const links = this.store.db.prepare(`SELECT d.json FROM dependencies d
      JOIN issues i ON i.id=d.predecessor_id WHERE i.project_id=? ORDER BY d.id`).all(plan.projectId) as {json:string}[];
    return { issues, members, dependencies: links.map(row => JSON.parse(row.json) as Dependency) };
  }
  private guard(plan: PlanningItem, state: ProjectState, changes: AutomaticScheduleMutation[], versions: Partial<Versions>) {
    const links = incidentLinks(state, changes);
    const endpoints = new Set(links.flatMap(link => [link.predecessorId, link.successorId]));
    return createHash('sha256').update(JSON.stringify({
      plan: [plan.id, plan.projectId, plan.kind, plan.version],
      members: state.members.map(issue => [issue.id, issue.version]),
      endpoints: state.issues.filter(issue => endpoints.has(issue.id)).sort(compareId).map(issue => [issue.id, issue.version]),
      links: links.map(dependencyGuardFields),
      versions,
    })).digest('hex');
  }
  private guardedVersions(plan: PlanningItem, includeLinked: boolean, workingDays: boolean, hooks: Hooks): Partial<Versions> {
    if (includeLinked) return hooks.versions(plan.projectId);
    return workingDays ? {calendar:hooks.calendar(plan.projectId).version} : {};
  }
  private preview(id: string, request: Request, hooks: Hooks): PlanScheduleShiftPreview {
    const {expectedPlanVersion, days, workingDays, includeLinked} = request.body;
    if (!Number.isSafeInteger(expectedPlanVersion) || expectedPlanVersion < 1 ||
      !Number.isSafeInteger(days) || !days || Math.abs(days) > 3650 || typeof workingDays !== 'boolean' || typeof includeLinked !== 'boolean') {
      fail(400, '검토한 계획 버전, 0이 아닌 이동 일수와 이동 범위를 확인해 주세요.');
    }
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      this.prune();
      const item = this.getPlan(id);
      if (item.version !== expectedPlanVersion) fail(409, '계획이 변경되었습니다. 최신 정보를 불러와 다시 검토해 주세요.');
      const from = datesOf(item);
      const result: PlanScheduleShiftPreview = {
        previewId:null,expiresAt:null,plan:{id:item.id,name:item.name,kind:item.kind,version:item.version,from,to:from},
        changes:[],skipped:[],warnings:[],blocking:[],
      };
      if (!from.startDate && !from.endDate && !from.targetDate) {
        result.blocking.push('이동할 계획 날짜가 없습니다. 시작일·종료일·목표일 중 하나를 입력해 주세요.');
        return result;
      }
      const math = workingDays ? createCalendarMath(hooks.calendar(item.projectId)) : undefined;
      const move = (value: string | null) => value === null ? null : math ? math.shift(value, days) : calendarDate(calendarDay(value) + days);
      try {
        result.plan.to = {startDate:move(from.startDate),endDate:move(from.endDate),targetDate:move(from.targetDate)};
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        result.blocking.push(`계획 ${item.name} · ${error.message}`);
        return result;
      }
      const state = includeLinked ? this.projectState(item) : emptyState;
      const changes: AutomaticScheduleMutation[] = [];
      for (const issue of state.members) {
        const {id,key,title,version,startDate,endDate} = issue;
        if (hooks.isTerminal(issue)) { result.skipped.push({id,key,title,reason:'terminal'}); continue; }
        if (!startDate && !endDate) { result.skipped.push({id,key,title,reason:'unscheduled'}); continue; }
        try {
          const toStart = move(startDate), toEnd = move(endDate);
          const change = {id,expectedVersion:version,startDate:toStart,endDate:toEnd};
          const error = hooks.validateChange(issue,change);
          if (error) { result.blocking.push(`${key} · ${error}`); continue; }
          changes.push(change);
          result.changes.push({id,key,title,version,fromStart:startDate,fromEnd:endDate,toStart,toEnd});
        } catch (error) {
          if (!(error instanceof CalendarError)) throw error;
          result.blocking.push(`${key} · ${error.message}`);
        }
      }
      if (changes.length) {
        const byId = new Map(changes.map(change => [change.id,change]));
        const projected = state.issues.map(issue => {
          const change = byId.get(issue.id);
          return change ? {...issue,startDate:change.startDate,endDate:change.endDate} : issue;
        });
        result.warnings = hooks.warnings(projected,incidentLinks(state,changes));
      }
      if (result.blocking.length) return result;
      const previewId = randomUUID(), expiresAt = AFTER(AUTO_PREVIEW_TTL_MS);
      const proposal: Proposal = {
        id:previewId,actorId,planId:item.id,includeLinked,workingDays,removeAfter:expiresAt,
        guard:this.guard(item,state,changes,this.guardedVersions(item,includeLinked,workingDays,hooks)),
        dates:result.plan.to,changes,
      };
      this.store.put(table,proposal);
      return {...result,previewId,expiresAt};
    });
  }
  private apply(id: string, request: Request, hooks: Hooks): PlanScheduleShiftResult {
    const {previewId} = request.body;
    if (typeof previewId !== 'string' || !previewId || previewId.length > 200) fail(400, '적용할 미리보기 ID가 필요합니다.');
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<Proposal>(table,previewId);
      if (!proposal) fail(404, '미리보기가 없거나 만료되었습니다.');
      if (proposal.planId !== id || proposal.actorId !== actorId) fail(409, '미리보기를 만든 계획과 작업자를 확인해 주세요.');
      if (proposal.removeAfter <= AFTER(0)) fail(409, '미리보기가 만료되었습니다. 다시 검토해 주세요.');
      if (proposal.result) return proposal.result;
      const plan = this.getPlan(id);
      const state = proposal.includeLinked ? this.projectState(plan) : emptyState;
      const versions = this.guardedVersions(plan,proposal.includeLinked,proposal.workingDays,hooks);
      if (proposal.guard !== this.guard(plan,state,proposal.changes,versions)) {
        fail(409, '계획·연결 업무·선후행 관계 또는 일정 설정이 변경되었습니다. 다시 미리 검토해 주세요.');
      }
      const result = hooks.commit(request,plan,proposal.dates,proposal.changes,incidentLinks(state,proposal.changes));
      this.store.put(table,{...proposal,result,removeAfter:AFTER(AUTO_RESULT_RETENTION_MS)});
      return result;
    });
  }
  registerRoutes(app: Express, hooks: Hooks) {
    app.post('/api/planning-items/:id/schedule-preview',(request,response)=>{
      response.json(this.preview(request.params.id,request,hooks));
    });
    app.post('/api/planning-items/:id/schedule-apply',(request,response)=>{
      response.json(this.apply(request.params.id,request,hooks));
    });
  }
}
