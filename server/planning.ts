import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { Issue, PlanningItem, PlanningKind, PlanningStatus, PlanScheduleDates, Project, SavedView, User } from '../shared/types.js';
import { planningAssignmentBlock, planningFields, PLANNING_META } from '../shared/planning-helpers.js';
import { Store } from './store.js';

export class PlanningError extends Error {constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new PlanningError(status,message,details);}
const kinds:PlanningKind[]=['cycle','module','release'];
const statuses:PlanningStatus[]=['planned','active','completed','archived'];
const now=()=>new Date().toISOString();
const key=(projectId:string,kind:PlanningKind,name:string)=>JSON.stringify([projectId,kind,name]);
function object(value:unknown):Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value))fail('계획 항목은 객체여야 합니다.');return value as Record<string,any>;}
function name(value:unknown,label='이름',max=120){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(`${label}을(를) 확인해 주세요.`);return value;}
function date(value:unknown,label:string):string|null{
  if(value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(`${label}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  return value;
}
function version(value:unknown,current:number){if(!Number.isSafeInteger(value)||Number(value)<1)fail('expectedVersion이 필요합니다.');if(value!==current)fail('다른 작업자가 변경했습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.',409,{currentVersion:current});}
function validTime(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function parseItem(value:unknown,projects:Project[],users:User[]):PlanningItem{
  const v=object(value);const id=name(v.id,'계획 ID',100),projectId=name(v.projectId,'프로젝트 ID',100);
  if(!projects.some(project=>project.id===projectId))fail('계획 항목의 프로젝트를 찾을 수 없습니다.');
  if(!kinds.includes(v.kind))fail('사이클·모듈·릴리스 중 하나를 선택해 주세요.');
  if(!statuses.includes(v.status))fail('계획 항목의 상태를 확인해 주세요.');
  if(typeof v.description!=='string'||v.description.length>20000)fail('설명은 20,000자 이하여야 합니다.');
  if(v.ownerId!==null&&(typeof v.ownerId!=='string'||!users.some(user=>user.id===v.ownerId)))fail('책임자를 찾을 수 없습니다.');
  const startDate=date(v.startDate,'시작일'),endDate=date(v.endDate,'종료일'),targetDate=date(v.targetDate,'목표일');
  if(startDate&&endDate&&startDate>endDate)fail('종료일은 시작일보다 빠를 수 없습니다.');
  if(!Number.isSafeInteger(v.version)||v.version<1||!validTime(v.createdAt)||!validTime(v.updatedAt))fail('계획 항목의 버전·작성 시간을 확인해 주세요.');
  return{id,projectId,kind:v.kind,name:name(v.name),description:v.description,status:v.status,ownerId:v.ownerId,startDate,endDate,targetDate,version:v.version,createdAt:v.createdAt,updatedAt:v.updatedAt};
}
function blankItem(projectId:string,kind:PlanningKind,label:string,timestamp:string):PlanningItem{
  return{id:randomUUID(),projectId,kind,name:label,description:'',status:'planned',ownerId:null,startDate:null,endDate:null,targetDate:null,version:1,createdAt:timestamp,updatedAt:timestamp};
}
type PlanFields=Pick<Issue,'cycle'|'module'|'release'|'cycleId'|'moduleId'|'releaseId'>;
const jiraImportedPlanIds = { release: /^jira_release_[a-f0-9]{64}$/, cycle: /^jira_sprint_[a-f0-9]{64}$/ };
function assertAssignable(item: PlanningItem): void {
  const block = planningAssignmentBlock(item);
  if (block === 'archived') fail('보관된 계획 항목에 새 업무를 배정할 수 없습니다.', 422);
  if (block === 'completed') fail('완료된 사이클에 새 업무를 배정할 수 없습니다.', 422);
}
type Hooks = {
  actor: (request: Request) => string;
  activity: (request: Request, resourceType: string, resourceId: string, action: string, detail?: string) => unknown;
  validateIssue: (next: Issue, previous?: Issue) => unknown;
  findSavedViewReference: (item: PlanningItem) => Pick<SavedView, 'id' | 'name'> | undefined;
};

/** Independent planning metadata; memberships never move dates or transition workflow states. */
export class PlanningService{
  constructor(private readonly store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS planning_items(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,name TEXT NOT NULL COLLATE BINARY,json TEXT NOT NULL,
    UNIQUE(project_id,kind,name)
  );CREATE INDEX IF NOT EXISTS planning_items_project_kind ON planning_items(project_id,kind);`);}
  all():PlanningItem[]{return this.store.all<PlanningItem>('planning_items');}
  forProject(projectId: string): PlanningItem[] {
    const rows = this.store.db.prepare('SELECT json FROM planning_items WHERE project_id=? ORDER BY rowid').all(projectId) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as PlanningItem);
  }
  private get(id:unknown):PlanningItem{if(typeof id!=='string')fail('계획 항목 ID를 확인해 주세요.');return this.store.get<PlanningItem>('planning_items',id)||fail('계획 항목을 찾을 수 없습니다.',404);}
  private put(item:PlanningItem){this.store.db.prepare('INSERT INTO planning_items(id,project_id,kind,name,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,kind=excluded.kind,name=excluded.name,json=excluded.json').run(item.id,item.projectId,item.kind,item.name,JSON.stringify(item));}
  private project(id:unknown){if(typeof id!=='string'||!this.store.get('projects',id))fail('프로젝트를 찾을 수 없습니다.',404);return id;}
  private parse(value:unknown){return parseItem(value,this.store.all<Project>('projects'),this.store.all<User>('users'));}
  private unique(item:PlanningItem){if(this.all().some(old=>old.id!==item.id&&key(old.projectId,old.kind,old.name)===key(item.projectId,item.kind,item.name)))fail('이 프로젝트에 같은 종류와 이름의 계획 항목이 있습니다.',409);}
  /** Only startup/legacy imports may create named entities from the old free text. */
  migrateLegacyIssues():void{
    this.store.transaction(()=>{
      const items=this.all(),lookup=new Map(items.map(item=>[key(item.projectId,item.kind,item.name),item]));
      for(const issue of this.store.all<Issue>('issues')){
        const next={...issue};let changed=false;
        for(const kind of kinds){const {idField,labelField}=planningFields(kind);let id=next[idField];
          if(id===undefined||id===null||id===''){const label=next[labelField];
            if(label!==null&&label!==undefined&&label!==''){
              const exact=name(label,`${PLANNING_META[kind].label} 이름`);let item=lookup.get(key(issue.projectId,kind,exact));
              if(!item){item=this.parse(blankItem(issue.projectId,kind,exact,validTime(issue.createdAt)?issue.createdAt:now()));this.put(item);items.push(item);lookup.set(key(item.projectId,item.kind,item.name),item);}
              id=item.id;
            }else id=null;
          }
          const item=id?items.find(item=>item.id===id):undefined;
          if(id&&(!item||item.kind!==kind||item.projectId!==issue.projectId))fail('기존 업무의 계획 항목 참조가 올바르지 않습니다.');
          const label=item?.name||null;
          if(next[idField]!==id||next[labelField]!==label){(next as any)[idField]=id;(next as any)[labelField]=label;changed=true;}
        }
        if(changed)this.store.put('issues',{...next,version:issue.version+1,updatedAt:now()});
      }
    });
  }
  resolveIssueFields(input:unknown,projectId:string,previous?:Issue,prospectiveCycle?:PlanningItem):PlanFields{
    const source=object(input),result={} as PlanFields,items=this.all();this.project(projectId);
    if(prospectiveCycle)items.push(prospectiveCycle);
    for(const kind of kinds){const {idField,labelField}=planningFields(kind);let id:string|null;
      if(Object.hasOwn(source,idField)){if(source[idField]!==null&&typeof source[idField]!=='string')fail(`${PLANNING_META[kind].label} ID를 확인해 주세요.`);id=source[idField];}
      else if(Object.hasOwn(source,labelField)){
        const label=source[labelField];if(label===null||label==='')id=null;
        else{const exact=name(label,`${PLANNING_META[kind].label} 이름`);const item=items.find(item=>key(item.projectId,item.kind,item.name)===key(projectId,kind,exact));if(!item)fail(`${PLANNING_META[kind].label}을(를) 먼저 만든 뒤 선택해 주세요.`);id=item.id;}
      }else id=previous?.[idField]||null;
      const item=id?items.find(item=>item.id===id):undefined;
      if(id!==null&&(!item||item.projectId!==projectId||item.kind!==kind))fail(`${PLANNING_META[kind].label}의 프로젝트·종류·ID가 올바르지 않습니다.`);
      if(item&&previous?.[idField]!==id)assertAssignable(item);
      (result as any)[idField]=id;(result as any)[labelField]=item?.name||null;
    }
    return result;
  }
  /** Mutates both IDs and derived labels so every issue write has one canonical reference. */
  validateIssueReferences(issue:Issue,previous?:Issue,options:{allowHistorical?:boolean | ReadonlySet<string>;prospectiveCycle?:PlanningItem}={}):void{
    const items=this.all();
    if(options.prospectiveCycle)items.push(options.prospectiveCycle);
    for(const kind of kinds){const {idField,labelField}=planningFields(kind),id=issue[idField];if(id===undefined||id===null){(issue as any)[idField]=null;(issue as any)[labelField]=null;continue;}
      if(typeof id!=='string')fail(`${PLANNING_META[kind].label} ID가 올바르지 않습니다.`);
      const item=items.find(item=>item.id===id);if(!item||item.projectId!==issue.projectId||item.kind!==kind)fail(`${PLANNING_META[kind].label}의 프로젝트·종류·ID가 올바르지 않습니다.`);
      const allowed = options.allowHistorical === true || (options.allowHistorical && options.allowHistorical.has(id));
      if(!allowed&&previous?.[idField]!==id)assertAssignable(item);
      (issue as any)[labelField]=item.name;
    }
  }
  /** Pure preparation: never writes or mutates the caller's backup objects. */
  prepareImport(value:unknown,projects:Project[],users:User[],issues:Issue[],options:{legacy:boolean}):{items:PlanningItem[];issues:Issue[]}{
    if(!Array.isArray(projects)||!Array.isArray(users)||!Array.isArray(issues))fail('프로젝트·팀원·업무 목록이 필요합니다.');
    const copies=issues.map(issue=>({...object(issue)}) as Issue);
    for(const issue of copies)if(typeof issue.id!=='string'||!projects.some(project=>project.id===issue.projectId))fail('계획과 연결된 업무의 프로젝트·ID가 올바르지 않습니다.');
    if(options.legacy){
      const items:PlanningItem[]=[],lookup=new Map<string,PlanningItem>();
      for(const issue of copies)for(const kind of kinds){const {idField,labelField}=planningFields(kind),original=issue[labelField];let item:PlanningItem|undefined;
        if(original!==null&&original!==undefined&&original!==''){const label=name(original,`${PLANNING_META[kind].label} 이름`),lookupKey=key(issue.projectId,kind,label);item=lookup.get(lookupKey);if(!item){item=parseItem(blankItem(issue.projectId,kind,label,validTime(issue.createdAt)?issue.createdAt:now()),projects,users);items.push(item);lookup.set(lookupKey,item);}}
        (issue as any)[idField]=item?.id||null;(issue as any)[labelField]=item?.name||null;
      }
      return{items,issues:copies};
    }
    if(!Array.isArray(value)||value.length>20000)fail('계획 항목 목록을 확인해 주세요.');
    const ids=new Set<string>(),names=new Set<string>();
    const items=value.map(raw=>{const item=parseItem(raw,projects,users),lookupKey=key(item.projectId,item.kind,item.name);if(ids.has(item.id)||names.has(lookupKey))fail('계획 항목 ID 또는 프로젝트·종류별 이름이 중복되었습니다.');ids.add(item.id);names.add(lookupKey);return item;});
    for(const issue of copies)for(const kind of kinds){const {idField,labelField}=planningFields(kind);if(!Object.hasOwn(issue,idField))fail('schemaVersion 4 업무에는 계획 ID 필드가 필요합니다.');const id=issue[idField];if(id!==null&&typeof id!=='string')fail('계획 ID는 문자열 또는 null이어야 합니다.');const item=id?items.find(item=>item.id===id):undefined;if(id!==null&&(!item||item.projectId!==issue.projectId||item.kind!==kind))fail('업무의 계획 항목 참조가 올바르지 않습니다.');(issue as any)[labelField]=item?.name||null;}
    return{items,issues:copies};
  }
  /** Caller owns the native import transaction and captures old versions before deletion. */
  replaceImported(items:PlanningItem[],previousVersions=new Map(this.all().map(item=>[item.id,item.version]))):void{
    this.store.db.exec('DELETE FROM planning_items');
    for(const item of items){const old=previousVersions.get(item.id);this.put({...item,version:old===undefined?item.version:Math.max(old,item.version)+1});}
  }
  /** Writes the reviewed Jira plans before issue references are validated in the same transaction. */
  persistMigratedJiraPlans(items: PlanningItem[], projectIds: ReadonlySet<string>): PlanningItem[] {
    if (!this.store.db.isTransaction) fail('Jira 계획 이관에는 적용 트랜잭션이 필요합니다.', 500);
    if (!Array.isArray(items) || items.length > 20_000) fail('이관할 Jira 사이클·릴리스 목록을 확인해 주세요.', 409);
    if (!items.length) return [];
    const projects = this.store.all<Project>('projects'), users = this.store.all<User>('users');
    const existing = this.all();
    const ids = new Set(existing.map(item => item.id));
    const names = new Set(existing.map(item => key(item.projectId, item.kind, item.name)));
    const plans = items.map(value => {
      const item = parseItem(value, projects, users);
      const nameKey = key(item.projectId, item.kind, item.name);
      if (item.kind === 'module' || !jiraImportedPlanIds[item.kind].test(item.id) || !projectIds.has(item.projectId) || item.version !== 1 ||
          ids.has(item.id) || names.has(nameKey)) {
        fail('이관할 Jira 사이클·릴리스의 대상 범위 또는 이름이 변경되었습니다. 새 미리보기를 만들어 주세요.', 409);
      }
      ids.add(item.id);
      names.add(nameKey);
      return item;
    });
    for (const item of plans) this.put(item);
    return plans;
  }
  historicalJiraPlanIds(imported: PlanningItem[], issues: Issue[]): ReadonlySet<string> {
    const ids = new Set(imported.filter(item => planningAssignmentBlock(item)).map(item => item.id));
    // An appended Jira migration can also reuse a previously imported sprint.
    for (const id of new Set(issues.map(issue => issue.cycleId))) {
      if (!id || ids.has(id) || !jiraImportedPlanIds.cycle.test(id)) continue;
      const item = this.store.get<PlanningItem>('planning_items', id);
      if (item?.kind === 'cycle' && item.status === 'completed') ids.add(id);
    }
    return ids;
  }
  /** The combined schedule apply/undo transaction owns this date-only write. */
  writeScheduleDates(id:string,expectedVersion:number,dates:PlanScheduleDates):PlanningItem{
    const old=this.get(id);
    version(expectedVersion,old.version);
    const updated=this.parse({...old,startDate:dates.startDate,endDate:dates.endDate,targetDate:dates.targetDate,version:old.version+1,updatedAt:now()});
    this.put(updated);
    return updated;
  }
  prepareCycleCopy(source: PlanningItem, name: string, dates: PlanScheduleDates, timestamp: string): PlanningItem {
    const copy = this.parse({ ...source, ...dates, id: randomUUID(), name, status: 'planned',
      version: 1, createdAt: timestamp, updatedAt: timestamp });
    this.unique(copy);
    return copy;
  }
  persistCycleCopy(copy: PlanningItem): void {
    if (!this.store.db.isTransaction) fail('사이클 복제에는 적용 트랜잭션이 필요합니다.', 500);
    this.put(copy);
  }
  completeCycle(id: string, expectedVersion: number, updatedAt: string): PlanningItem {
    if (!this.store.db.isTransaction) fail('사이클 완료에는 적용 트랜잭션이 필요합니다.', 500);
    const cycle = this.get(id);
    version(expectedVersion, cycle.version);
    if (cycle.kind !== 'cycle' || cycle.status !== 'active') fail('진행 중인 사이클을 다시 확인해 주세요.', 409);
    const completed = this.parse({ ...cycle, status: 'completed', version: cycle.version + 1, updatedAt });
    this.put(completed);
    return completed;
  }
  registerRoutes(app:Express,hooks:Hooks):void{
    const route=(handler:(req:Request,res:Response)=>unknown)=>(req:Request,res:Response,next:NextFunction)=>{try{handler(req,res);}catch(error){if(error instanceof PlanningError)return res.status(error.status).json({error:error.message,details:error.details});if(String((error as Error)?.message).includes('planning_items.project_id, planning_items.kind, planning_items.name'))return res.status(409).json({error:'같은 종류와 이름의 계획 항목이 이미 있습니다.'});next(error);}};
    app.get('/api/planning-items',route((req,res)=>{const projectId=this.project(req.query.projectId),kind=req.query.kind;if(kind!==undefined&&!kinds.includes(kind as PlanningKind))fail('계획 종류를 확인해 주세요.');res.json(this.forProject(projectId).filter(item=>kind===undefined||item.kind===kind).sort((a,b)=>a.name.localeCompare(b.name,'ko')));}));
    app.get('/api/planning-items/:id',route((req,res)=>res.json(this.get(req.params.id))));
    app.post('/api/planning-items',route((req,res)=>{
      hooks.actor(req);const timestamp=now(),item=this.parse({id:randomUUID(),projectId:req.body.projectId,kind:req.body.kind,name:req.body.name,description:Object.hasOwn(req.body,'description')?req.body.description:'',status:Object.hasOwn(req.body,'status')?req.body.status:'planned',ownerId:req.body.ownerId??null,startDate:req.body.startDate??null,endDate:req.body.endDate??null,targetDate:req.body.targetDate??null,version:1,createdAt:timestamp,updatedAt:timestamp});
      this.store.transaction(()=>{this.unique(item);this.put(item);hooks.activity(req,'planning',item.id,`${PLANNING_META[item.kind].label} 생성`,item.name);});res.status(201).json(item);
    }));
    app.patch('/api/planning-items/:id',route((req,res)=>{
      hooks.actor(req);const updated=this.store.transaction(()=>{const old=this.get(req.params.id);version(req.body.expectedVersion,old.version);if(('projectId'in req.body&&req.body.projectId!==old.projectId)||('kind'in req.body&&req.body.kind!==old.kind))fail('계획 항목의 프로젝트와 종류는 변경할 수 없습니다.');
        const fields=['name','description','status','ownerId','startDate','endDate','targetDate'];const item=this.parse({...old,...Object.fromEntries(fields.filter(field=>Object.hasOwn(req.body,field)).map(field=>[field,req.body[field]])),version:old.version+1,updatedAt:now()});this.unique(item);this.put(item);
        if(item.name!==old.name){const {idField,labelField}=planningFields(item.kind);for(const issue of this.store.all<Issue>('issues').filter(issue=>issue[idField]===item.id)){this.store.put('issues',{...issue,[labelField]:item.name,version:issue.version+1,updatedAt:now()});hooks.activity(req,'issue',issue.id,'계획 이름 갱신',`${old.name} → ${item.name}`);}}
        hooks.activity(req,'planning',item.id,`${PLANNING_META[item.kind].label} 변경`,item.name);return item;
      });res.json(updated);
    }));
    app.delete('/api/planning-items/:id', route((req, res) => {
      hooks.actor(req);
      this.store.transaction(() => {
        const item = this.get(req.params.id);
        version(Number(req.query.expectedVersion), item.version);
        if (this.store.all<Issue>('issues').some(issue => kinds.some(kind => issue[planningFields(kind).idField] === item.id))) {
          fail('업무가 연결된 계획 항목은 삭제할 수 없습니다. 연결을 해제하거나 보관해 주세요.', 409);
        }
        const view = hooks.findSavedViewReference(item);
        if (view) {
          fail(`저장된 보기 ‘${view.name}’에서 이 계획을 사용 중입니다. 보기에서 조건을 지우거나 계획을 보관해 주세요.`, 409, { viewId: view.id });
        }
        this.store.remove('planning_items', item.id);
        hooks.activity(req, 'planning', item.id, `${PLANNING_META[item.kind].label} 삭제`, item.name);
      });
      res.json({ ok: true });
    }));
    app.post('/api/planning-items/:id/issues',route((req,res)=>{
      hooks.actor(req);const assignments=req.body.assignments;if(!Array.isArray(assignments)||!assignments.length||assignments.length>1000)fail('배정할 업무는 1~1000개여야 합니다.');const seen=new Set();
      for(const value of assignments){const a=object(value);if(typeof a.issueId!=='string'||seen.has(a.issueId)||typeof a.assigned!=='boolean'||!Number.isSafeInteger(a.expectedVersion)||a.expectedVersion<1)fail('중복되지 않은 업무 ID·버전·배정 여부가 필요합니다.');seen.add(a.issueId);}
      const result=this.store.transaction(()=>{const item=this.get(req.params.id);version(req.body.expectedVersion,item.version);const {idField,labelField}=planningFields(item.kind),updated:Issue[]=[],previous=new Map<string,Issue>();
        for(const assignment of assignments){const old=this.store.get<Issue>('issues',assignment.issueId);if(!old)fail('배정할 업무를 찾을 수 없습니다.',404);if(old.projectId!==item.projectId)fail('같은 프로젝트의 업무만 배정할 수 있습니다.');version(assignment.expectedVersion,old.version);
          const current=old[idField]||null,nextId=assignment.assigned?item.id:(current===item.id?null:current);if(current===nextId)continue;
          const next={...old,[idField]:nextId,[labelField]:nextId?item.name:null,version:old.version+1,updatedAt:now()};this.validateIssueReferences(next,old);hooks.validateIssue(next,old);previous.set(old.id,old);updated.push(next);
        }
        for(const issue of updated){this.store.put('issues',issue);hooks.activity(req,'issue',issue.id,'계획 연결 변경',`${PLANNING_META[item.kind].label}: ${previous.get(issue.id)?.[labelField]||'미지정'} → ${issue[labelField]||'미지정'}`);}
        if(updated.length)hooks.activity(req,'planning',item.id,'업무 배정 변경',`${updated.length}개 업무`);return{item,updated};
      });res.json(result);
    }));
  }
}
