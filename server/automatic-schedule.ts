import { createHash,randomUUID } from 'node:crypto';
import type { Express,Request } from 'express';
import type { AutomaticSchedulePreview,Dependency,Issue,ProjectWorkflow,ScheduleChange } from '../shared/types.js';
import { createCalendarMath,isCalendarDate,CalendarError } from '../shared/calendar.js';
import { isTerminalStatus } from '../shared/workflow-helpers.js';
import { CalendarService } from './calendars.js';
import { Store } from './store.js';

export class AutomaticScheduleError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new AutomaticScheduleError(status,message,details);}
export interface AutomaticScheduleMutation{id:string;expectedVersion:number;startDate:string|null;endDate:string|null}
export interface AutomaticScheduleResult{undoId:string;updated:Issue[];warnings?:string[]}
type Hooks={actor:(request:Request)=>string;commitChanges:(request:Request,changes:AutomaticScheduleMutation[])=>AutomaticScheduleResult};
export const AUTO_PREVIEW_TTL_MS=30*60*1000,AUTO_RESULT_RETENTION_MS=7*24*60*60*1000;
interface Proposal{id:string;projectId:string;actorId:string;createdAt:string;expiresAt:string;issueVersions:[string,number][];calendarVersion:number;workflowVersion:number;dependencyHash:string;preview:AutomaticSchedulePreview;used:boolean;appliedAt?:string;result?:AutomaticScheduleResult}
function date(value:unknown,label:string):string|null{if(value===null)return null;if(!isCalendarDate(value))fail(`${label}은(는) YYYY-MM-DD 형식이어야 합니다.`);return value;}
const readset=(issues:Issue[]):[string,number][]=>issues.map(issue=>[issue.id,issue.version] as [string,number]).sort((a,b)=>a[0].localeCompare(b[0]));
function dependencyHash(dependencies:Dependency[]){return createHash('sha256').update(JSON.stringify(dependencies.map(d=>[d.id,d.predecessorId,d.successorId,d.type,d.lagDays]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex');}

/** Persisted, actor-bound proposals. Apply uses one transaction including the root undo/audit hook. */
export class AutomaticScheduleService{
  constructor(private readonly store:Store,private readonly calendars:CalendarService){store.db.exec('CREATE TABLE IF NOT EXISTS automatic_schedule_previews(id TEXT PRIMARY KEY,json TEXT NOT NULL)');this.prune();}
  private prune(){const timestamp=new Date().toISOString(),cutoff=new Date(Date.now()-AUTO_RESULT_RETENTION_MS).toISOString();this.store.db.prepare("DELETE FROM automatic_schedule_previews WHERE (json_extract(json,'$.used')=0 AND json_extract(json,'$.expiresAt')<=?) OR (json_extract(json,'$.used')=1 AND COALESCE(json_extract(json,'$.appliedAt'),json_extract(json,'$.createdAt'))<=?)").run(timestamp,cutoff);}
  private issues(projectId:string){return this.store.all<Issue>('issues').filter(issue=>issue.projectId===projectId);}
  private dependencies(issues:Issue[]){const ids=new Set(issues.map(issue=>issue.id));return this.store.all<Dependency>('dependencies').filter(dependency=>ids.has(dependency.predecessorId)||ids.has(dependency.successorId));}
  preview(value:unknown,actorId:string):AutomaticSchedulePreview{return this.store.transaction(()=>this.buildPreview(value,actorId));}
  private buildPreview(value:unknown,actorId:string):AutomaticSchedulePreview{
    this.prune();
    if(!this.store.get('users',actorId))fail('작업자를 찾을 수 없습니다.');if(!value||typeof value!=='object'||Array.isArray(value))fail('자동 일정 미리보기 설정이 필요합니다.');const input=value as Record<string,any>;
    if(typeof input.projectId!=='string'||!this.store.get('projects',input.projectId))fail('프로젝트를 찾을 수 없습니다.',404);
    const projectId=input.projectId,issues=this.issues(projectId),byId=new Map(issues.map(issue=>[issue.id,issue]));if(issues.length>10000)fail('자동 일정은 프로젝트 업무 10,000개 이하에서 계산해 주세요.');
    const calendar=this.calendars.get(projectId),math=createCalendarMath(calendar),dependencies=this.dependencies(issues);
    const selected=new Set<string>();
    if(input.issueIds!==undefined){if(!Array.isArray(input.issueIds)||!input.issueIds.length||input.issueIds.length>1000||input.issueIds.some((id:unknown)=>typeof id!=='string')||new Set(input.issueIds).size!==input.issueIds.length)fail('중복되지 않은 대상 업무 1~1000개가 필요합니다.');for(const id of input.issueIds){if(!byId.has(id))fail('선택한 업무가 프로젝트에 없습니다.',404);selected.add(id);}}
    else issues.forEach(issue=>selected.add(issue.id));
    let anchorDate:string|null=null;if(input.anchorDate!==undefined&&input.anchorDate!==null)anchorDate=date(input.anchorDate,'기준일');
    let defaultDuration:number|null=null;if(input.defaultDuration!==undefined&&input.defaultDuration!==null){if(!Number.isSafeInteger(input.defaultDuration)||input.defaultDuration<1||input.defaultDuration>3650)fail('기본 작업 기간은 1~3650 작업일이어야 합니다.');defaultDuration=input.defaultDuration;}
    const seeds=new Map<string,{startDate:string|null;endDate:string|null}>();
    if(input.seedChanges!==undefined){if(!Array.isArray(input.seedChanges)||input.seedChanges.length>1000)fail('초기 일정 변경은 1000개 이하여야 합니다.');for(const raw of input.seedChanges){if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||seeds.has(raw.id)||!Object.hasOwn(raw,'startDate')||!Object.hasOwn(raw,'endDate'))fail('초기 일정 변경의 ID·날짜를 확인해 주세요.');const issue=byId.get(raw.id);if(!issue)fail('초기 일정 업무가 프로젝트에 없습니다.');if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion!==issue.version)fail('초기 일정 업무가 변경되었습니다. 다시 미리 확인해 주세요.',409);const startDate=date(raw.startDate,'시작일'),endDate=date(raw.endDate,'종료일');if(startDate&&endDate&&startDate>endDate)fail('초기 일정의 종료일은 시작일보다 빠를 수 없습니다.');seeds.set(issue.id,{startDate,endDate});selected.add(issue.id);}}
    const successors=new Map<string,Dependency[]>(),predecessors=new Map<string,Dependency[]>();
    for(const dependency of dependencies){successors.set(dependency.predecessorId,[...(successors.get(dependency.predecessorId)||[]),dependency]);predecessors.set(dependency.successorId,[...(predecessors.get(dependency.successorId)||[]),dependency]);}
    const pending=[...selected];while(pending.length){const id=pending.pop()!;for(const dependency of successors.get(id)||[])if(!selected.has(dependency.successorId)){if(!byId.has(dependency.successorId))fail('프로젝트를 벗어난 의존성이 있습니다.');selected.add(dependency.successorId);pending.push(dependency.successorId);}}
    const indegree=new Map([...selected].map(id=>[id,(predecessors.get(id)||[]).filter(d=>selected.has(d.predecessorId)).length]));const queue=[...selected].filter(id=>indegree.get(id)===0).sort();const order:string[]=[];
    for(let index=0;index<queue.length;index++){const id=queue[index];order.push(id);for(const dependency of successors.get(id)||[])if(selected.has(dependency.successorId)){const remaining=indegree.get(dependency.successorId)!-1;indegree.set(dependency.successorId,remaining);if(remaining===0)queue.push(dependency.successorId);}}
    const warnings:string[]=[],blocking:string[]=[],blocked=new Set<string>(),effective=new Map<string,{startDate:string|null;endDate:string|null}>();
    const workflowTable=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'").get();const workflows=workflowTable?this.store.all<ProjectWorkflow>('workflows'):[];
    const block=(issue:Issue,message:string)=>{blocked.add(issue.id);blocking.push(`${issue.key}: ${message}`);};
    const changes:ScheduleChange[]=[];
    for(const id of order){
      const issue=byId.get(id)!;const terminal=isTerminalStatus({workflows},issue.projectId,issue.status),seed=seeds.get(id),basis=terminal?{startDate:issue.startDate,endDate:issue.endDate}:seed||{startDate:issue.startDate,endDate:issue.endDate};effective.set(id,basis);
      if(terminal&&seed&&(seed.startDate!==issue.startDate||seed.endDate!==issue.endDate))block(issue,'완료·취소 업무는 고정 일정입니다. 초기 일정 변경을 적용할 수 없습니다.');
      let requiredStart:string|null=null;
      for(const dependency of predecessors.get(id)||[]){
        const predecessor=byId.get(dependency.predecessorId);if(!predecessor){block(issue,'프로젝트 밖의 선행 업무를 확인해 주세요.');continue;}
        if(dependency.type!=='FS'||!Number.isSafeInteger(dependency.lagDays)||dependency.lagDays<0){block(issue,`${predecessor.key} 연결에 지원하지 않는 종류 또는 음수 지연일이 있습니다.`);continue;}
        if(blocked.has(predecessor.id)){block(issue,`${predecessor.key}의 일정이 막혀 후속 일정을 계산할 수 없습니다.`);continue;}
        const end=(effective.get(predecessor.id)||predecessor).endDate;if(!end){block(issue,`${predecessor.key}의 종료일이 없어 선후행 조건을 계산할 수 없습니다.`);continue;}
        try{const bound=math.shift(end,dependency.lagDays+1);if(!requiredStart||bound>requiredStart)requiredStart=bound;}catch(error){if(!(error instanceof CalendarError))throw error;block(issue,`${predecessor.key}: ${error.message}`);}
      }
      if(terminal){
        if(requiredStart&&(!basis.startDate||basis.startDate<requiredStart))block(issue,`고정 시작일 ${basis.startDate||'미정'}과 선후행 조건 ${requiredStart}이 충돌합니다.`);
        if(!basis.startDate||!basis.endDate)warnings.push(`${issue.key}: 완료·취소 업무의 미정 일정은 변경하지 않습니다.`);
        continue;
      }
      if(blocked.has(id))continue;
      let start=basis.startDate,end=basis.endDate,duration:number;
      if((start===null)!==(end===null)){block(issue,'시작일과 종료일 중 하나만 있어 기간을 계산하지 않았습니다.');continue;}
      if(!start&&!end){if(!anchorDate||defaultDuration===null){block(issue,'일정이 없습니다. 기준일과 기본 작업 기간을 명시하거나 날짜를 먼저 입력해 주세요.');continue;}start=anchorDate;duration=defaultDuration;end=null;}
      else{try{duration=math.count(start!,end!);}catch(error){if(!(error instanceof CalendarError))throw error;block(issue,error.message);continue;}if(duration<1){block(issue,'기존 일정에 작업일이 없어 기간을 임의로 만들지 않았습니다.');continue;}if(duration>3650){block(issue,'기존 작업 기간이 3650 작업일을 초과합니다. 범위를 나누어 계획해 주세요.');continue;}}
      try{
        const originalStart=start,originalEnd=end;start=math.onOrAfter(start!);if(start!==originalStart)warnings.push(`${issue.key}: 비작업 시작일 ${originalStart}을 다음 작업일 ${start}로 조정합니다.`);
        if(requiredStart&&requiredStart>start)start=requiredStart;
        if(end===null||start!==originalStart){end=math.shift(start,duration-1);if(originalEnd&&end<originalEnd)end=originalEnd;}
        effective.set(id,{startDate:start,endDate:end});
        if(start!==issue.startDate||end!==issue.endDate)changes.push({id:issue.id,key:issue.key,title:issue.title,version:issue.version,fromStart:issue.startDate,fromEnd:issue.endDate,toStart:start,toEnd:end});
      }catch(error){if(!(error instanceof CalendarError))throw error;block(issue,error.message);}
    }
    for(const id of selected)if(!order.includes(id))block(byId.get(id)!,'의존성 순환으로 일정을 계산할 수 없습니다.');
    if(changes.length>1000)blocking.push('한 번에 변경할 수 있는 업무는 1000개입니다. 범위를 나누어 미리 확인해 주세요.');
    const createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+AUTO_PREVIEW_TTL_MS).toISOString(),previewId=randomUUID();
    const preview:AutomaticSchedulePreview={previewId,changes,warnings:[...new Set(warnings)],blocking:[...new Set(blocking)],calendarVersions:{[projectId]:calendar.version},expiresAt};
    const proposal:Proposal={id:previewId,projectId,actorId,createdAt,expiresAt,issueVersions:readset(issues),calendarVersion:calendar.version,workflowVersion:workflows.find(workflow=>workflow.projectId===projectId)?.version||1,dependencyHash:dependencyHash(dependencies),preview,used:false};this.store.put('automatic_schedule_previews',proposal);return preview;
  }
  apply(request:Request,previewId:unknown,hooks:Hooks):AutomaticScheduleResult{
    const actorId=hooks.actor(request);if(typeof previewId!=='string'||!previewId)fail('미리보기 ID가 필요합니다.');
    return this.store.transaction(()=>{const proposal=this.store.get<Proposal>('automatic_schedule_previews',previewId);if(!proposal)fail('미리보기가 없거나 만료·복원으로 초기화되었습니다.',404);if(proposal.actorId!==actorId)fail('다른 작업자의 미리보기를 적용할 수 없습니다.',409);if(proposal.used&&proposal.result)return proposal.result;
      if(!Number.isFinite(Date.parse(proposal.expiresAt))||Date.parse(proposal.expiresAt)<=Date.now())fail('미리보기가 만료되었습니다. 다시 계산해 주세요.',409);
      if(proposal.preview.blocking.length)fail('자동 일정을 적용하기 전에 막힌 항목을 해결해 주세요.',422,{blocking:proposal.preview.blocking});
      const issues=this.issues(proposal.projectId);if(JSON.stringify(readset(issues))!==JSON.stringify(proposal.issueVersions))fail('업무 또는 고정 선행 일정이 변경되었습니다. 다시 미리 확인해 주세요.',409);
      if(this.calendars.get(proposal.projectId).version!==proposal.calendarVersion)fail('작업 달력이 변경되었습니다. 다시 미리 확인해 주세요.',409);
      const workflowTable=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'").get();const workflowVersion=workflowTable?this.store.get<ProjectWorkflow>('workflows',proposal.projectId)?.version||1:1;if(workflowVersion!==proposal.workflowVersion)fail('업무 상태·필수 속성 규칙이 변경되었습니다. 다시 미리 확인해 주세요.',409);
      if(dependencyHash(this.dependencies(issues))!==proposal.dependencyHash)fail('업무 의존성이 변경되었습니다. 다시 미리 확인해 주세요.',409);
      if(!proposal.preview.changes.length)fail('적용할 일정 변경이 없습니다.');
      const mutations=proposal.preview.changes.map(change=>({id:change.id,expectedVersion:change.version,startDate:change.toStart,endDate:change.toEnd}));const result=hooks.commitChanges(request,mutations);
      this.store.put('automatic_schedule_previews',{...proposal,used:true,appliedAt:new Date().toISOString(),result});return result;
    });
  }
  registerRoutes(app:Express,hooks:Hooks){app.post('/api/schedule/auto-preview',(req,res)=>res.json(this.preview(req.body,hooks.actor(req))));app.post('/api/schedule/auto-apply',(req,res)=>res.json(this.apply(req,req.body.previewId,hooks)));}
}
