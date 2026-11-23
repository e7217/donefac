import { createHash,randomUUID } from 'node:crypto';
import type { Express,Request } from 'express';
import type { AutomaticSchedulePreview, Dependency, Issue, ProjectWorkflow, ProjectWorkloadCapacity, ScheduleAnchorChange, ScheduleChange,
  TeamFollowUpScheduleInput, TeamScheduleBlocker, TeamWorkloadCapacity, TeamWorkloadLevelPreview, WorkCalendar, WorkloadLevelPlan, WorkloadLevelPreview } from '../shared/types.js';
import { createCalendarMath,isCalendarDate,CalendarError } from '../shared/calendar.js';
import { isRelationId } from '../shared/issue-relations.js';
import { DEPENDENCY_ENDPOINTS, SCHEDULE_DATE_LABELS, dependencyBound, dependencyGuardFields, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { isTerminalStatus } from '../shared/workflow-helpers.js';
import { MAX_TEAM_WORKLOAD_PROJECTS, validateWorkloadRange } from '../shared/project-workload.js';
import { levelProjectWorkload, levelTeamWorkload, MAX_WORKLOAD_LEVEL_CELLS, MAX_WORKLOAD_LEVEL_CHANGES,
  MAX_WORKLOAD_LEVEL_DEPENDENCIES, MAX_WORKLOAD_LEVEL_ISSUES } from '../shared/workload-leveling.js';
import { CalendarService } from './calendars.js';
import { Store } from './store.js';
import { calculateTeamFollowUpSchedule, teamFollowUpScope, TeamFollowUpScheduleError } from './team-follow-up-schedule.js';

export class AutomaticScheduleError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new AutomaticScheduleError(status,message,details);}
export type AutomaticScheduleMutation = ScheduleAnchorChange;
interface AutomaticScheduleInput{projectId:string;issueIds?:string[];anchorDate?:string|null;defaultDuration?:number|null;seedChanges?:AutomaticScheduleMutation[];anchorChange?:AutomaticScheduleMutation}
type ScheduleDates = Pick<AutomaticScheduleMutation, 'startDate' | 'endDate'>;
export interface AutomaticScheduleResult{undoId:string;updated:Issue[];warnings?:string[]}
type Hooks={actor:(request:Request)=>string;commitChanges:(request:Request,changes:AutomaticScheduleMutation[])=>AutomaticScheduleResult};
type WorkloadHooks = {
  capacity(projectId: string): ProjectWorkloadCapacity;
  teamCapacity(): TeamWorkloadCapacity;
  teamBlockers(): TeamScheduleBlocker[];
  workflow(projectId: string): ProjectWorkflow;
  validateChange(issue: Issue, change: AutomaticScheduleMutation): string | null;
};
export const AUTO_PREVIEW_TTL_MS=30*60*1000,AUTO_RESULT_RETENTION_MS=7*24*60*60*1000;
interface ProposalReceipt {
  id: string;
  actorId: string;
  createdAt: string;
  expiresAt: string;
  issueVersions: [string, number][];
  dependencyHash: string;
  preview: AutomaticSchedulePreview;
  used: boolean;
  appliedAt?: string;
  result?: AutomaticScheduleResult;
}
interface Proposal extends ProposalReceipt {
  projectId: string;
  calendarVersion: number;
  workflowVersion: number;
  issueSchemaVersion?: number;
  capacityVersion?: number;
}
type ProjectScheduleVersions = { projectId: string; calendar: number; workflow: number; schema: number };
interface TeamProposal extends ProposalReceipt {
  teamVersions: ProjectScheduleVersions[];
  teamCapacityVersion: number;
}
type TeamFollowUpRelation = NonNullable<AutomaticSchedulePreview['teamFollowUp']>;
interface TeamFollowUpProposal extends Omit<ProposalReceipt, 'issueVersions'> {
  teamFollowUp: TeamFollowUpRelation;
  issueVersions: [string, number, string][];
  projectVersions: ProjectScheduleVersions[];
}
type StoredProposal = Proposal | TeamProposal | TeamFollowUpProposal;
type ProposalScope = 'automatic' | 'project-workload' | 'team-workload' | 'team-follow-up';
function date(value:unknown,label:string):string|null{if(value===null)return null;if(!isCalendarDate(value))fail(`${label}은(는) YYYY-MM-DD 형식이어야 합니다.`);return value;}
const readset=(issues:Issue[]):[string,number][]=>issues.map(issue=>[issue.id,issue.version] as [string,number]).sort((a,b)=>a[0].localeCompare(b[0]));
const followUpReadset = (issues: Issue[]): [string, number, string][] => issues
  .map(({ id, version, projectId }): [string, number, string] => [id, version, projectId]).sort((a, b) => a[0].localeCompare(b[0]));

function parseTeamFollowUpInput(value: unknown): TeamFollowUpScheduleInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'relationId' && key !== 'expectedVersion' && key !== 'anchorChange')) {
    fail('선택한 차단 관계와 조회 당시 버전을 확인해 주세요.');
  }
  const { relationId, expectedVersion, anchorChange } = value as Record<string, unknown>;
  if (!isRelationId(relationId) ||
      typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    fail('선택한 차단 관계와 조회 당시 버전을 확인해 주세요.');
  }
  if (anchorChange === undefined) return { relationId, expectedVersion };
  if (!anchorChange || typeof anchorChange !== 'object' || Array.isArray(anchorChange) ||
      Object.keys(anchorChange).some(key => key !== 'id' && key !== 'expectedVersion' && key !== 'startDate' && key !== 'endDate')) {
    fail('원인 업무와 변경할 날짜를 확인해 주세요.');
  }
  const { id, expectedVersion: issueVersion, startDate, endDate } = anchorChange as Record<string, unknown>;
  if (!isRelationId(id) || typeof issueVersion !== 'number' || !Number.isSafeInteger(issueVersion) || issueVersion < 1) {
    fail('원인 업무와 조회 당시 업무 버전을 확인해 주세요.');
  }
  return { relationId, expectedVersion, anchorChange: { id, expectedVersion: issueVersion,
    startDate: date(startDate, '시작일'), endDate: date(endDate, '종료일') } };
}

function dependencyHash(dependencies: Dependency[]) {
  const fields = dependencies.map(dependencyGuardFields).sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function uniqueIds(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > max || new Set(value).size !== value.length ||
    value.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    fail(`${label}은 중복 없이 1~${max.toLocaleString('ko-KR')}개를 선택해 주세요.`);
  }
  return value;
}

const toMutation = (change: ScheduleChange): AutomaticScheduleMutation => ({
  id: change.id, expectedVersion: change.version, startDate: change.toStart, endDate: change.toEnd,
});

function readSeedChange(value: unknown, issues: ReadonlyMap<string, Issue>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('초기 일정 변경의 ID·날짜를 확인해 주세요.');
  const raw = value as Partial<AutomaticScheduleMutation>;
  if (typeof raw.id !== 'string' || !Object.hasOwn(raw, 'startDate') || !Object.hasOwn(raw, 'endDate')) {
    fail('초기 일정 변경의 ID·날짜를 확인해 주세요.');
  }
  const issue = issues.get(raw.id);
  if (!issue) fail('초기 일정 업무가 프로젝트에 없습니다.');
  if (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion !== issue.version) {
    fail('초기 일정 업무가 변경되었습니다. 다시 미리 확인해 주세요.', 409);
  }
  const startDate = date(raw.startDate, '시작일'), endDate = date(raw.endDate, '종료일');
  if (startDate && endDate && startDate > endDate) fail('초기 일정의 종료일은 시작일보다 빠를 수 없습니다.');
  return { issue, dates: { startDate, endDate } };
}

type ProjectScheduleInput = {
  issues: ReadonlyMap<string, Issue>;
  dependencies: readonly Dependency[];
  math: ReturnType<typeof createCalendarMath>;
  selected: ReadonlySet<string>;
  terminal: (issue: Issue) => boolean;
  fixedDates?: ReadonlyMap<string, ScheduleDates>;
  seeds?: ReadonlyMap<string, ScheduleDates>;
  anchorDate?: string | null;
  defaultDuration?: number | null;
  preserveSatisfied?: boolean;
};

function calculateProjectSchedule({
  issues, dependencies, math, selected: initialIds, terminal, fixedDates, seeds, anchorDate, defaultDuration = null, preserveSatisfied,
}: ProjectScheduleInput) {
  const selected = new Set(initialIds);
  const successors = new Map<string, Dependency[]>();
  const predecessors = new Map<string, Dependency[]>();
  for (const dependency of dependencies) {
    const outgoing = successors.get(dependency.predecessorId);
    if (outgoing) outgoing.push(dependency);
    else successors.set(dependency.predecessorId, [dependency]);
    const incoming = predecessors.get(dependency.successorId);
    if (incoming) incoming.push(dependency);
    else predecessors.set(dependency.successorId, [dependency]);
  }

  const pending = [...selected];
  while (pending.length) {
    const id = pending.pop()!;
    for (const dependency of successors.get(id) ?? []) {
      if (selected.has(dependency.successorId)) continue;
      if (!issues.has(dependency.successorId)) fail('프로젝트를 벗어난 의존성이 있습니다.');
      selected.add(dependency.successorId);
      pending.push(dependency.successorId);
    }
  }
  const indegree = new Map([...selected].map(id => [id, (predecessors.get(id) ?? []).filter(link => selected.has(link.predecessorId)).length]));
  const order = [...selected].filter(id => indegree.get(id) === 0).sort();
  for (let index = 0; index < order.length; index++) {
    for (const dependency of successors.get(order[index]) ?? []) {
      if (!selected.has(dependency.successorId)) continue;
      const remaining = indegree.get(dependency.successorId)! - 1;
      indegree.set(dependency.successorId, remaining);
      if (remaining === 0) order.push(dependency.successorId);
    }
  }

  const warnings: string[] = [];
  const blocking: string[] = [];
  const changes: ScheduleChange[] = [];
  const blocked = new Set<string>();
  const effective = new Map<string, ScheduleDates>();
  const block = (issue: Issue, message: string) => {
    blocked.add(issue.id);
    blocking.push(`${issue.key}: ${message}`);
  };
  const propose = (issue: Issue, { startDate, endDate }: ScheduleDates) => {
    if (startDate !== issue.startDate || endDate !== issue.endDate) {
      changes.push({ id: issue.id, key: issue.key, title: issue.title, version: issue.version,
        fromStart: issue.startDate, fromEnd: issue.endDate, toStart: startDate, toEnd: endDate });
    }
  };
  for (const id of order) {
    const issue = issues.get(id)!;
    const isTerminal = terminal(issue);
    const fixed = fixedDates?.get(id);
    const seed = fixed ?? seeds?.get(id);
    const basis = isTerminal ? issue : seed ?? issue;
    effective.set(id, basis);
    if (isTerminal && seed && (seed.startDate !== issue.startDate || seed.endDate !== issue.endDate)) {
      block(issue, '완료·취소 업무는 고정 일정입니다. 초기 일정 변경을 적용할 수 없습니다.');
    }
    const required: ScheduleDates = { startDate: null, endDate: null };
    for (const dependency of predecessors.get(id) ?? []) {
      const predecessor = issues.get(dependency.predecessorId);
      if (!predecessor) {
        block(issue, '프로젝트 밖의 선행 업무를 확인해 주세요.');
        continue;
      }
      if (!isDependencyType(dependency.type) || !isDependencyLag(dependency.lagDays)) {
        block(issue, `${predecessor.key} 연결의 종류와 간격을 확인해 주세요.`);
        continue;
      }
      if (blocked.has(predecessor.id)) {
        block(issue, `${predecessor.key}의 일정이 막혀 후속 일정을 계산할 수 없습니다.`);
        continue;
      }
      try {
        const bound = dependencyBound(dependency, effective.get(predecessor.id) ?? predecessor, math);
        if (!bound) {
          const label = SCHEDULE_DATE_LABELS[DEPENDENCY_ENDPOINTS[dependency.type].predecessor];
          block(issue, `${predecessor.key}의 ${label}이 없어 선후행 조건을 계산할 수 없습니다.`);
          continue;
        }
        const prior = required[bound.endpoint];
        if (!prior || bound.date > prior) required[bound.endpoint] = bound.date;
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        block(issue, `${predecessor.key} · ${error.message}`);
      }
    }
    if (isTerminal || fixed) {
      for (const endpoint of ['startDate', 'endDate'] as const) {
        const bound = required[endpoint];
        const actual = basis[endpoint];
        if (bound && (!actual || actual < bound)) {
          const label = isTerminal ? '고정' : '입력한';
          block(issue, `${label} ${SCHEDULE_DATE_LABELS[endpoint]} ${actual || '미정'}과 선후행 조건 ${bound}이 충돌합니다.`);
        }
      }
      if (isTerminal && (!basis.startDate || !basis.endDate)) warnings.push(`${issue.key}: 완료·취소 업무의 미정 일정은 변경하지 않습니다.`);
      if (!isTerminal && !blocked.has(id)) propose(issue, basis);
      continue;
    }
    if (blocked.has(id)) continue;

    let start = basis.startDate;
    let end = basis.endDate;
    let duration: number;
    // Fixed-date reviews move successors only when a projected dependency requires it.
    if (preserveSatisfied && (!required.startDate || (start && start >= required.startDate)) &&
        (!required.endDate || (end && end >= required.endDate))) continue;
    if ((start === null) !== (end === null)) {
      block(issue, '시작일과 종료일 중 하나만 있어 기간을 계산하지 않았습니다.');
      continue;
    }
    if (!start && !end) {
      if (!anchorDate || defaultDuration === null) {
        block(issue, '일정이 없습니다. 기준일과 기본 작업 기간을 명시하거나 날짜를 먼저 입력해 주세요.');
        continue;
      }
      start = anchorDate;
      duration = defaultDuration;
    } else {
      try { duration = math.count(start!, end!); }
      catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        block(issue, error.message);
        continue;
      }
      if (duration < 1) {
        block(issue, '기존 일정에 작업일이 없어 기간을 임의로 만들지 않았습니다.');
        continue;
      }
      if (duration > 3650) {
        block(issue, '기존 작업 기간이 3650 작업일을 초과합니다. 범위를 나누어 계획해 주세요.');
        continue;
      }
    }
    try {
      const originalStart = start;
      const originalEnd = end;
      start = math.onOrAfter(start!);
      if (start !== originalStart) warnings.push(`${issue.key}: 비작업 시작일 ${originalStart}을 다음 작업일 ${start}로 조정합니다.`);
      if (required.startDate && required.startDate > start) start = math.onOrAfter(required.startDate);
      if (end === null || start !== originalStart) {
        end = math.shift(start, duration - 1);
        if (originalEnd && end < originalEnd) end = originalEnd;
      }
      if (required.endDate && end < required.endDate) {
        end = math.onOrAfter(required.endDate);
        start = math.shift(end, 1 - duration);
      }
      effective.set(id, { startDate: start, endDate: end });
      propose(issue, { startDate: start, endDate: end });
    } catch (error) {
      if (!(error instanceof CalendarError)) throw error;
      block(issue, error.message);
    }
  }
  for (const id of selected) {
    if (!effective.has(id)) block(issues.get(id)!, '의존성 순환으로 일정을 계산할 수 없습니다.');
  }
  return { changes, warnings, blocking, issueIds: [...selected] };
}

const MAX_AUTOMATIC_SCHEDULE_CHANGES = 1000;
const CHANGE_LIMIT_MESSAGE = '한 번에 변경할 수 있는 업무는 1000개입니다. 범위를 나누어 미리 확인해 주세요.';

type FixedFollowUpInput = {
  issues: readonly Issue[];
  dependencies: readonly Dependency[];
  calendar: WorkCalendar;
  workflow: ProjectWorkflow;
} & (
  { anchor: AutomaticScheduleMutation; anchors?: never } |
  { anchors: readonly AutomaticScheduleMutation[]; anchor?: never }
);

export function calculateFixedFollowUpSchedule({ issues, dependencies, calendar, workflow, anchor, anchors }: FixedFollowUpInput) {
  if (issues.length > 10000) fail('자동 일정은 프로젝트 업무 10,000개 이하에서 계산해 주세요.');
  const anchorChanges = anchor ? [anchor] : anchors;
  if (!anchorChanges?.length || anchorChanges.length > MAX_AUTOMATIC_SCHEDULE_CHANGES) {
    fail('후행 일정의 기준 업무는 1~1000개를 지정해 주세요.');
  }
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const fixedDates = new Map<string, ScheduleDates>();
  for (const change of anchorChanges) {
    const { issue, dates } = readSeedChange(change, byId);
    if (issue.projectId !== calendar.projectId) fail('후행 일정의 기준 업무가 작업 달력의 프로젝트에 없습니다.');
    if (fixedDates.has(issue.id)) fail('후행 일정의 기준 업무를 중복해서 지정할 수 없습니다.');
    fixedDates.set(issue.id, dates);
  }
  const workflowData = { workflows: [workflow] };
  const { changes, warnings, blocking, issueIds } = calculateProjectSchedule({
    issues: byId, dependencies, math: createCalendarMath(calendar), selected: new Set(fixedDates.keys()), fixedDates,
    terminal: issue => isTerminalStatus(workflowData, issue.projectId, issue.status), preserveSatisfied: true,
  });
  if (changes.length > MAX_AUTOMATIC_SCHEDULE_CHANGES) blocking.push(CHANGE_LIMIT_MESSAGE);
  return { changes, warnings: [...new Set(warnings)], blocking: [...new Set(blocking)], issueIds: issueIds.sort() };
}

function prepareWorkloadPreview<T extends WorkloadLevelPlan>(plan: T, issues: ReadonlyMap<string, Issue>,
  calendarVersions: Record<string, number>, validateChange: WorkloadHooks['validateChange']) {
  const blocking: string[] = [];
  for (const change of plan.changes) {
    const message = validateChange(issues.get(change.id)!, toMutation(change));
    if (message) blocking.push(`${change.key}: ${message}`);
  }
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + AUTO_PREVIEW_TTL_MS).toISOString();
  return { createdAt, preview: {
    ...plan, previewId: randomUUID(), expiresAt, blocking, calendarVersions,
    warnings: plan.reason === 'search-limit' ? ['계산 한도 안에서 확인한 일정만 제안했습니다.'] : [],
  } };
}

/** Persisted, actor-bound proposals. Apply uses one transaction including the root undo/audit hook. */
export class AutomaticScheduleService{
  constructor(private readonly store:Store,private readonly calendars:CalendarService){store.db.exec('CREATE TABLE IF NOT EXISTS automatic_schedule_previews(id TEXT PRIMARY KEY,json TEXT NOT NULL)');this.prune();}
  private prune(){const timestamp=new Date().toISOString(),cutoff=new Date(Date.now()-AUTO_RESULT_RETENTION_MS).toISOString();this.store.db.prepare("DELETE FROM automatic_schedule_previews WHERE (json_extract(json,'$.used')=0 AND json_extract(json,'$.expiresAt')<=?) OR (json_extract(json,'$.used')=1 AND COALESCE(json_extract(json,'$.appliedAt'),json_extract(json,'$.createdAt'))<=?)").run(timestamp,cutoff);}
  private issues(projectId: string) {
    const rows = this.store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY rowid').all(projectId) as { json: string }[];
    return rows.map(({ json }) => JSON.parse(json) as Issue);
  }
  private issueSchemaVersion(projectId:string){const exists=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_schemas'").get();return exists?this.store.get<{version:number}>('issue_schemas',projectId)?.version||1:1;}
  private dependencies(issues:Issue[]){const ids=new Set(issues.map(issue=>issue.id));return this.store.all<Dependency>('dependencies').filter(dependency=>ids.has(dependency.predecessorId)||ids.has(dependency.successorId));}
  preview(value:unknown,actorId:string,validateChange?:WorkloadHooks['validateChange']):AutomaticSchedulePreview{return this.store.transaction(()=>this.buildPreview(value,actorId,validateChange));}
  private buildPreview(value:unknown,actorId:string,validateChange?:WorkloadHooks['validateChange']):AutomaticSchedulePreview{
    this.prune();
    if(!this.store.get('users',actorId))fail('작업자를 찾을 수 없습니다.');if(!value||typeof value!=='object'||Array.isArray(value))fail('자동 일정 미리보기 설정이 필요합니다.');const input=value as AutomaticScheduleInput;
    if(typeof input.projectId!=='string'||!this.store.get('projects',input.projectId))fail('프로젝트를 찾을 수 없습니다.',404);
    const projectId=input.projectId,issues=this.issues(projectId),byId=new Map(issues.map(issue=>[issue.id,issue]));if(issues.length>10000)fail('자동 일정은 프로젝트 업무 10,000개 이하에서 계산해 주세요.');
    const calendar=this.calendars.get(projectId),math=createCalendarMath(calendar),dependencies=this.dependencies(issues);
    if (Object.hasOwn(input, 'anchorChange') && Object.keys(input).some(key => key !== 'projectId' && key !== 'anchorChange')) {
      fail('후행 일정은 한 업무의 날짜 변경을 기준으로 미리 확인해 주세요.');
    }
    const anchor = Object.hasOwn(input, 'anchorChange') ? readSeedChange(input.anchorChange, byId) : null;
    const selected=new Set<string>();
    if(anchor)selected.add(anchor.issue.id);
    else if(input.issueIds!==undefined){if(!Array.isArray(input.issueIds)||!input.issueIds.length||input.issueIds.length>1000||input.issueIds.some((id:unknown)=>typeof id!=='string')||new Set(input.issueIds).size!==input.issueIds.length)fail('중복되지 않은 대상 업무 1~1000개가 필요합니다.');for(const id of input.issueIds){if(!byId.has(id))fail('선택한 업무가 프로젝트에 없습니다.',404);selected.add(id);}}
    else issues.forEach(issue=>selected.add(issue.id));
    let anchorDate:string|null=null;if(input.anchorDate!==undefined&&input.anchorDate!==null)anchorDate=date(input.anchorDate,'기준일');
    let defaultDuration:number|null=null;if(input.defaultDuration!==undefined&&input.defaultDuration!==null){if(!Number.isSafeInteger(input.defaultDuration)||input.defaultDuration<1||input.defaultDuration>3650)fail('기본 작업 기간은 1~3650 작업일이어야 합니다.');defaultDuration=input.defaultDuration;}
    const seeds=new Map<string,ScheduleDates>();
    if(input.seedChanges!==undefined){
      if(!Array.isArray(input.seedChanges)||input.seedChanges.length>1000)fail('초기 일정 변경은 1000개 이하여야 합니다.');
      for(const raw of input.seedChanges){
        if(raw&&seeds.has(raw.id))fail('초기 일정 변경의 ID·날짜를 확인해 주세요.');
        const {issue,dates}=readSeedChange(raw,byId);
        seeds.set(issue.id,dates);
        selected.add(issue.id);
      }
    }
    const workflowTable=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'").get();const workflows=workflowTable?this.store.all<ProjectWorkflow>('workflows'):[];
    const { changes, warnings, blocking } = calculateProjectSchedule({
      issues: byId, dependencies, math, selected, seeds, anchorDate, defaultDuration,
      fixedDates: anchor ? new Map([[anchor.issue.id, anchor.dates]]) : undefined,
      terminal: issue => isTerminalStatus({ workflows }, issue.projectId, issue.status),
    });
    if (anchor && validateChange) for (const change of changes) {
      const reason = validateChange(byId.get(change.id)!, toMutation(change));
      if (reason) blocking.push(`${change.key}: ${reason}`);
    }
    if (changes.length > MAX_AUTOMATIC_SCHEDULE_CHANGES) blocking.push(CHANGE_LIMIT_MESSAGE);
    const createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+AUTO_PREVIEW_TTL_MS).toISOString(),previewId=randomUUID();
    const preview:AutomaticSchedulePreview={previewId,changes,warnings:[...new Set(warnings)],blocking:[...new Set(blocking)],calendarVersions:{[projectId]:calendar.version},expiresAt};
    const proposal:Proposal={id:previewId,projectId,actorId,createdAt,expiresAt,issueVersions:readset(issues),calendarVersion:calendar.version,workflowVersion:workflows.find(workflow=>workflow.projectId===projectId)?.version||1,issueSchemaVersion:this.issueSchemaVersion(projectId),dependencyHash:dependencyHash(dependencies),preview,used:false};this.store.put('automatic_schedule_previews',proposal);return preview;
  }
  private workloadUsers(value: unknown, issues: readonly Issue[], span: number) {
    const supplied = uniqueIds(value, '담당자', 200);
    if (supplied?.some(id => !this.store.get('users', id))) fail('담당자가 팀에 없습니다.', 404);
    const selected = supplied ?? [...new Set(issues.flatMap(issue => issue.assigneeId ? [issue.assigneeId] : []))];
    if (selected.length * span > MAX_WORKLOAD_LEVEL_CELLS) fail('담당자별 날짜가 너무 많습니다. 조회 기간이나 담당자를 줄여 주세요.', 422);
    return selected;
  }

  private buildWorkloadPreview(value: unknown, actorId: string, hooks: WorkloadHooks): WorkloadLevelPreview {
    return this.store.transaction(() => {
      this.prune();
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('과부하 일정 조정 조건을 확인해 주세요.');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['projectId', 'startDate', 'endDate', 'userIds', 'issueIds'].includes(key))) {
        fail('과부하 일정 조정 조건을 확인해 주세요.');
      }
      const { projectId } = input;
      if (typeof projectId !== 'string' || !this.store.get('projects', projectId)) fail('프로젝트를 찾을 수 없습니다.', 404);
      const { startDate, endDate, span } = validateWorkloadRange(input.startDate, input.endDate);
      const issueIds = uniqueIds(input.issueIds, '업무', MAX_WORKLOAD_LEVEL_CHANGES);
      const issues = this.issues(projectId);
      if (issues.length > MAX_WORKLOAD_LEVEL_ISSUES) fail('프로젝트 업무 10,000개 이하에서 조정할 수 있습니다.', 422);
      const byId = new Map(issues.map(issue => [issue.id, issue]));
      if (issueIds?.some(id => !byId.has(id))) fail('선택한 업무가 프로젝트에 없습니다.', 404);
      const userIds = this.workloadUsers(input.userIds, issues, span);
      const dependencies = this.dependencies(issues);
      if (dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) fail('프로젝트 업무 연결 50,000개 이하에서 조정할 수 있습니다.', 422);
      const calendar = this.calendars.get(projectId), capacity = hooks.capacity(projectId), workflow = hooks.workflow(projectId);
      const plan = levelProjectWorkload({ startDate, endDate, calendar, capacity, workflow, issues, dependencies, userIds, issueIds });
      const { createdAt, preview } = prepareWorkloadPreview(plan, byId, { [projectId]: calendar.version }, hooks.validateChange);
      const proposal: Proposal = {
        id: preview.previewId, projectId, actorId, createdAt, expiresAt: preview.expiresAt, preview, used: false,
        issueVersions: readset(issues), calendarVersion: calendar.version, workflowVersion: workflow.version,
        issueSchemaVersion: this.issueSchemaVersion(projectId), dependencyHash: dependencyHash(dependencies), capacityVersion: capacity.version,
      };
      this.store.put('automatic_schedule_previews', proposal);
      return preview;
    });
  }

  private teamProjectIds() {
    const rows = this.store.db.prepare('SELECT id FROM projects ORDER BY id LIMIT ?').all(MAX_TEAM_WORKLOAD_PROJECTS + 1) as { id: string }[];
    return rows.map(row => row.id);
  }

  private teamIssues() {
    const rows = this.store.db.prepare('SELECT json FROM issues ORDER BY rowid LIMIT ?').all(MAX_WORKLOAD_LEVEL_ISSUES + 1) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as Issue);
  }

  private teamDependencies() {
    const rows = this.store.db.prepare('SELECT json FROM dependencies ORDER BY rowid LIMIT ?').all(MAX_WORKLOAD_LEVEL_DEPENDENCIES + 1) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as Dependency);
  }

  private followUpContext(input: TeamFollowUpScheduleInput, hooks: WorkloadHooks, applying: boolean) {
    const issues = this.teamIssues(), dependencies = this.teamDependencies();
    const limit = () => fail('프로젝트 간 후속 일정은 전체 업무 10,000개와 연결 50,000개 이하에서 계산할 수 있습니다.', applying ? 409 : 422);
    if (issues.length > MAX_WORKLOAD_LEVEL_ISSUES || dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) limit();
    const byId = new Map(issues.map(issue => [issue.id, issue]));
    const workflows = new Map<string, ProjectWorkflow>();
    const workflow = (projectId: string) => {
      let value = workflows.get(projectId);
      if (!value) {
        value = hooks.workflow(projectId);
        workflows.set(projectId, value);
      }
      return value;
    };
    const terminal = (issue: Issue) => isTerminalStatus({ workflows: [workflow(issue.projectId)] }, issue.projectId, issue.status);
    const blockers = hooks.teamBlockers();
    const chosen = blockers.find(relation => relation.id === input.relationId);
    const source = chosen && byId.get(chosen.sourceIssueId);
    const target = chosen && byId.get(chosen.targetIssueId);
    if (!chosen || !source || !target || source.projectId === target.projectId) {
      fail('프로젝트 간 차단 관계를 찾을 수 없습니다. 차단 목록을 다시 확인해 주세요.', applying ? 409 : 404);
    }
    if (chosen.version !== input.expectedVersion || terminal(source) || terminal(target)) {
      fail('차단 관계 또는 원인·대상 업무의 상태가 바뀌었습니다. 열린 차단 업무를 다시 확인해 주세요.', 409);
    }
    const { anchorChange } = input;
    if (anchorChange && anchorChange.id !== source.id) {
      fail('선택한 관계의 원인 업무만 변경할 수 있습니다.', applying ? 409 : 400);
    }
    if (anchorChange && anchorChange.expectedVersion !== source.version) {
      fail('선행 업무가 변경되었습니다. 최신 일정을 확인한 뒤 다시 검토해 주세요.', 409, {
        reason: 'stale_team_follow_up_source', currentVersion: source.version, startDate: source.startDate, endDate: source.endDate,
      });
    }
    for (const { id, sourceIssueId, targetIssueId, version, origin } of blockers) {
      // Imported relations only participate when explicitly chosen for this review.
      if (origin === 'jira' && id !== chosen.id) continue;
      const predecessor = byId.get(sourceIssueId), successor = byId.get(targetIssueId);
      if (!predecessor || !successor || predecessor.projectId === successor.projectId || terminal(predecessor) || terminal(successor)) continue;
      dependencies.push({ id: `team-blocker:${id}`, predecessorId: sourceIssueId, successorId: targetIssueId, type: 'FS', lagDays: 0, version });
      if (dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) limit();
    }
    try {
      const scope = teamFollowUpScope(source.id, target.id, issues, dependencies, anchorChange);
      const teamFollowUp: TeamFollowUpRelation = { ...input, sourceIssueId: source.id, targetIssueId: target.id,
        sourceEndDate: anchorChange ? anchorChange.endDate : source.endDate,
        sourceSchedule: { version: source.version, startDate: source.startDate, endDate: source.endDate } };
      return { scope, teamFollowUp, workflow, terminal };
    } catch (error) {
      if (!(error instanceof TeamFollowUpScheduleError)) throw error;
      return fail(error.message, applying ? 409 : error.status);
    }
  }

  private buildTeamFollowUpPreview(value: unknown, actorId: string, hooks: WorkloadHooks): AutomaticSchedulePreview {
    const input = parseTeamFollowUpInput(value);
    return this.store.transaction(() => {
      this.prune();
      const { scope, teamFollowUp, workflow, terminal } = this.followUpContext(input, hooks, false);
      const projectIds = [...new Set(scope.issues.map(issue => issue.projectId))].sort();
      const calendars = new Map(projectIds.map(id => [id, this.calendars.get(id)]));
      const calendarMath = new Map(projectIds.map(id => [id, createCalendarMath(calendars.get(id)!)]));
      const projectVersions = projectIds.map(projectId => ({ projectId, calendar: calendars.get(projectId)!.version,
        workflow: workflow(projectId).version, schema: this.issueSchemaVersion(projectId) }));
      const planned = calculateTeamFollowUpSchedule(scope, id => calendarMath.get(id)!, terminal);
      const issuesById = new Map(scope.issues.map(issue => [issue.id, issue]));
      const blockers = [...planned.blocking];
      for (const change of planned.changes) {
        const reason = hooks.validateChange(issuesById.get(change.id)!, toMutation(change));
        if (reason) blockers.push(`${change.key}: ${reason}`);
      }
      const timestamp = Date.now(), createdAt = new Date(timestamp).toISOString();
      const previewId = randomUUID(), expiresAt = new Date(timestamp + AUTO_PREVIEW_TTL_MS).toISOString();
      const preview: AutomaticSchedulePreview = { ...planned, previewId, expiresAt, teamFollowUp,
        calendarVersions: Object.fromEntries(projectVersions.map(({ projectId, calendar }) => [projectId, calendar])),
        blocking: [...new Set(blockers)] };
      const proposal: TeamFollowUpProposal = { id: previewId, actorId, createdAt, expiresAt, preview, used: false, teamFollowUp, projectVersions,
        issueVersions: followUpReadset(scope.issues), dependencyHash: dependencyHash(scope.dependencies) };
      this.store.put('automatic_schedule_previews', proposal);
      return preview;
    });
  }

  private buildTeamWorkloadPreview(value: unknown, actorId: string, hooks: WorkloadHooks): TeamWorkloadLevelPreview {
    return this.store.transaction(() => {
      this.prune();
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('프로젝트 간 과부하 조정 조건을 확인해 주세요.');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['projectIds', 'startDate', 'endDate', 'userIds'].includes(key))) {
        fail('프로젝트 간 과부하 조정 조건을 확인해 주세요.');
      }
      const movableProjectIds = uniqueIds(input.projectIds, '조정할 프로젝트', MAX_TEAM_WORKLOAD_PROJECTS);
      if (!movableProjectIds) fail('일정을 조정할 프로젝트를 선택해 주세요.');
      const { startDate, endDate, span } = validateWorkloadRange(input.startDate, input.endDate);
      const projectIds = this.teamProjectIds();
      if (projectIds.length > MAX_TEAM_WORKLOAD_PROJECTS) fail('프로젝트 간 조정은 전체 프로젝트 100개 이하에서 계산할 수 있습니다.', 422);
      const knownProjects = new Set(projectIds);
      if (movableProjectIds.some(id => !knownProjects.has(id))) fail('선택한 프로젝트를 찾을 수 없습니다.', 404);
      const issues = this.teamIssues(), dependencies = this.teamDependencies();
      if (issues.length > MAX_WORKLOAD_LEVEL_ISSUES || dependencies.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) {
        fail('프로젝트 간 조정은 전체 업무 10,000개와 연결 50,000개 이하에서 계산할 수 있습니다.', 422);
      }
      const userIds = this.workloadUsers(input.userIds, issues, span);
      const byProject = new Map<string, Issue[]>(projectIds.map(id => [id, []]));
      for (const issue of issues) byProject.get(issue.projectId)!.push(issue);
      const projects = projectIds.map(id => ({ calendar: this.calendars.get(id), workflow: hooks.workflow(id), issues: byProject.get(id)! }));
      const capacity = hooks.teamCapacity();
      const plan = levelTeamWorkload({ startDate, endDate, projects, capacity, dependencies, userIds, movableProjectIds });
      const teamVersions = projects.map(({ calendar, workflow }) => ({
        projectId: calendar.projectId, calendar: calendar.version, workflow: workflow.version, schema: this.issueSchemaVersion(calendar.projectId),
      }));
      const { createdAt, preview } = prepareWorkloadPreview({ ...plan, movableProjectIds }, new Map(issues.map(issue => [issue.id, issue])),
        Object.fromEntries(teamVersions.map(({ projectId, calendar }) => [projectId, calendar])), hooks.validateChange);
      const proposal: TeamProposal = {
        id: preview.previewId, actorId, createdAt, expiresAt: preview.expiresAt, preview, used: false,
        issueVersions: readset(issues), dependencyHash: dependencyHash(dependencies), teamVersions, teamCapacityVersion: capacity.version,
      };
      this.store.put('automatic_schedule_previews', proposal);
      return preview;
    });
  }

  private proposal(previewId: unknown, actorId: string, scope: ProposalScope): StoredProposal {
    if (typeof previewId !== 'string' || !previewId) fail('미리보기 ID가 필요합니다.');
    const proposal = this.store.get<StoredProposal>('automatic_schedule_previews', previewId);
    if (!proposal) fail('미리보기가 없거나 만료·복원으로 초기화되었습니다.', 404);
    const actualScope = 'teamFollowUp' in proposal ? 'team-follow-up' : 'teamVersions' in proposal ? 'team-workload'
      : proposal.capacityVersion === undefined ? 'automatic' : 'project-workload';
    if (scope !== actualScope) fail('미리보기가 없거나 만료·복원으로 초기화되었습니다.', 404);
    if (proposal.actorId !== actorId) fail(scope === 'automatic' ? '다른 작업자의 미리보기를 적용할 수 없습니다.' : '다른 작업자의 미리보기를 확인하거나 적용할 수 없습니다.', 409);
    return proposal;
  }

  private checkIssues(proposal: ProposalReceipt, issues: Issue[]) {
    if (JSON.stringify(readset(issues)) !== JSON.stringify(proposal.issueVersions)) {
      fail('업무 또는 고정 선행 일정이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
    }
  }

  private checkProjectVersions(expected: ProjectScheduleVersions, hooks: WorkloadHooks) {
    if (this.calendars.get(expected.projectId).version !== expected.calendar) fail('작업 달력이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
    if (hooks.workflow(expected.projectId).version !== expected.workflow) fail('업무 상태·필수 속성 규칙이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
    if (this.issueSchemaVersion(expected.projectId) !== expected.schema) fail('업무 유형·사용자 정의 필드가 변경되었습니다. 다시 미리 확인해 주세요.', 409);
  }

  private checkProposal(proposal: StoredProposal, hooks: WorkloadHooks) {
    if ('teamFollowUp' in proposal) {
      const { scope, teamFollowUp } = this.followUpContext(proposal.teamFollowUp, hooks, true);
      if (teamFollowUp.sourceIssueId !== proposal.teamFollowUp.sourceIssueId || teamFollowUp.targetIssueId !== proposal.teamFollowUp.targetIssueId ||
          JSON.stringify(followUpReadset(scope.issues)) !== JSON.stringify(proposal.issueVersions)) {
        fail('업무 또는 고정 선행 일정이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
      }
      if (dependencyHash(scope.dependencies) !== proposal.dependencyHash) fail('업무 의존성이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
      for (const versions of proposal.projectVersions) this.checkProjectVersions(versions, hooks);
      return;
    }
    let dependencies: Dependency[];
    if ('teamVersions' in proposal) {
      const projectIds = this.teamProjectIds();
      const previousProjects = proposal.teamVersions.map(version => version.projectId);
      if (JSON.stringify(projectIds) !== JSON.stringify(previousProjects)) fail('프로젝트 목록이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
      if (hooks.teamCapacity().version !== proposal.teamCapacityVersion) fail('팀 가용 시간이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
      this.checkIssues(proposal, this.teamIssues());
      for (const versions of proposal.teamVersions) this.checkProjectVersions(versions, hooks);
      dependencies = this.teamDependencies();
    } else {
      const issues = this.issues(proposal.projectId);
      this.checkIssues(proposal, issues);
      this.checkProjectVersions({ projectId: proposal.projectId, calendar: proposal.calendarVersion,
        workflow: proposal.workflowVersion, schema: proposal.issueSchemaVersion ?? 1 }, hooks);
      if (proposal.capacityVersion !== undefined && hooks.capacity(proposal.projectId).version !== proposal.capacityVersion) {
        fail('담당자 가용 시간이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
      }
      dependencies = this.dependencies(issues);
    }
    if (dependencyHash(dependencies) !== proposal.dependencyHash) fail('업무 의존성이 변경되었습니다. 다시 미리 확인해 주세요.', 409);
  }

  private apply(request: Request, previewId: unknown, scope: ProposalScope, hooks: Hooks, workload: WorkloadHooks): AutomaticScheduleResult {
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.proposal(previewId, actorId, scope);
      if (proposal.used && proposal.result) return proposal.result;
      if (!Number.isFinite(Date.parse(proposal.expiresAt)) || Date.parse(proposal.expiresAt) <= Date.now()) fail('미리보기가 만료되었습니다. 다시 계산해 주세요.', 409);
      if (proposal.preview.blocking.length) {
        const label = scope === 'automatic' ? '자동 일정을 적용' : scope === 'team-follow-up' ? '프로젝트 간 후속 일정을 적용' : '과부하 일정을 조정';
        fail(`${label}하기 전에 막힌 항목을 해결해 주세요.`, 422, { blocking: proposal.preview.blocking });
      }
      this.checkProposal(proposal, workload);
      if (!proposal.preview.changes.length) fail('적용할 일정 변경이 없습니다.');
      const committed = hooks.commitChanges(request, proposal.preview.changes.map(toMutation));
      const result = scope === 'team-follow-up' ? { ...committed,
        warnings: [...new Set([...proposal.preview.warnings, ...(committed.warnings ?? [])])] } : committed;
      this.store.put('automatic_schedule_previews', { ...proposal, used: true, appliedAt: new Date().toISOString(), result });
      return result;
    });
  }

  registerRoutes(app: Express, hooks: Hooks, workload: WorkloadHooks) {
    app.post('/api/schedule/auto-preview', (req, res) => res.set('Cache-Control', 'no-store').json(this.preview(req.body, hooks.actor(req), workload.validateChange)));
    app.post('/api/schedule/workload-preview', (req, res) => res.json(this.buildWorkloadPreview(req.body, hooks.actor(req), workload)));
    app.post('/api/schedule/team-workload-preview', (req, res) => res.json(this.buildTeamWorkloadPreview(req.body, hooks.actor(req), workload)));
    app.post('/api/schedule/team-follow-up-preview', (req, res) =>
      res.set('Cache-Control', 'no-store').json(this.buildTeamFollowUpPreview(req.body, hooks.actor(req), workload)));
    for (const [path, scope] of [['auto', 'automatic'], ['workload', 'project-workload'], ['team-workload', 'team-workload'], ['team-follow-up', 'team-follow-up']] as const) {
      app.post(`/api/schedule/${path}-apply`, (req, res) => {
        if (scope === 'team-follow-up') {
          if (!req.body || Object.keys(req.body).length !== 1) fail('적용할 미리보기 ID를 확인해 주세요.');
          res.set('Cache-Control', 'no-store');
        }
        res.json(this.apply(req, req.body.previewId, scope, hooks, workload));
      });
      app.get(`/api/schedule/${path}-result/:previewId`, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const proposal = this.proposal(req.params.previewId, hooks.actor(req), scope);
        if (!proposal.used && Date.parse(proposal.expiresAt) <= Date.now()) fail('미리보기가 만료되었습니다. 다시 계산해 주세요.', 409);
        res.json(proposal.result ?? { applied: false });
      });
    }
  }
}
