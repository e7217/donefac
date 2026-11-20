import type { Express,Request } from 'express';
import { ISSUE_TYPES,type CustomFieldDefinition,type CustomFieldKind,type CustomFieldValue,type Issue,type IssueTypeDefinition,type Project,type ProjectIssueSchema,type ProjectWorkflow,type SavedView,type User } from '../shared/types.js';
import { defaultIssueSchema,fieldApplies,hasCustomValue } from '../shared/issue-schema.js';
import { isCalendarDate } from '../shared/calendar.js';
import { Store } from './store.js';

export class IssueSchemaError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new IssueSchemaError(status,message,details);}
const fieldKinds=['text','number','date','select','multi_select','checkbox','user','url'];
const reserved=new Set(['__proto__','constructor','prototype']);
function object(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label}은(는) 객체여야 합니다.`);return value as Record<string,unknown>;}
function fieldKind(value:unknown):CustomFieldKind{if(typeof value!=='string'||!fieldKinds.includes(value))fail('지원하지 않는 사용자 정의 필드 종류입니다.');return value as CustomFieldKind;}
function name(value:unknown,label:string,max=120):string{if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label}은(는) 1~${max}자여야 합니다.`);return value.trim();}
function id(value:unknown,label:string,type=false):string{if(typeof value!=='string'||reserved.has(value)||(type&&value==='all')||(!/^[a-z][a-z0-9_-]{0,47}$/.test(value)&&!(type&&ISSUE_TYPES.includes(value as typeof ISSUE_TYPES[number]))))fail(`${label} ID는 예약어를 제외한 영문 소문자 시작 48자 이내의 영문·숫자·밑줄·하이픈이어야 합니다.`);return value;}
function flag(value:unknown,label:string):boolean{if(typeof value!=='boolean')fail(`${label}을(를) 확인해 주세요.`);return value;}
function unique(values:{id:string;name:string}[],label:string){if(new Set(values.map(v=>v.id)).size!==values.length||new Set(values.map(v=>v.name)).size!==values.length)fail(`${label}의 ID 또는 이름이 중복되었습니다.`);}
function parseSchema(projectId:string,value:unknown,version:number,updatedAt:string):ProjectIssueSchema{
  const source=object(value,'업무 스키마');
  if(!Array.isArray(source.issueTypes)||!source.issueTypes.length||source.issueTypes.length>50)fail('업무 유형은 1~50개여야 합니다.');
  const issueTypes:IssueTypeDefinition[]=source.issueTypes.map((raw:unknown)=>{const v=object(raw,'업무 유형');if(typeof v.color!=='string'||!/^#[a-f\d]{6}$/i.test(v.color))fail('업무 유형 색상은 #RRGGBB 형식이어야 합니다.');return{id:id(v.id,'업무 유형',true),name:name(v.name,'업무 유형 이름'),color:v.color,archived:flag(v.archived,'유형 보관 여부')};});
  unique(issueTypes,'업무 유형');if(!issueTypes.some(type=>!type.archived))fail('최소 한 개의 활성 업무 유형이 필요합니다.');const typeIds=new Set(issueTypes.map(type=>type.id));
  if(!Array.isArray(source.fields)||source.fields.length>100)fail('사용자 정의 필드는 100개 이하여야 합니다.');
  const fields:CustomFieldDefinition[]=source.fields.map((raw:unknown)=>{const v=object(raw,'사용자 정의 필드');
    const kind=fieldKind(v.kind);if(typeof v.description!=='string'||v.description.length>20000)fail('필드 설명은 20,000자 이하여야 합니다.');
    if(!Array.isArray(v.issueTypes)||v.issueTypes.some((type:unknown)=>typeof type!=='string'||!typeIds.has(type))||new Set(v.issueTypes).size!==v.issueTypes.length)fail('필드를 적용할 업무 유형을 확인해 주세요.');
    if(!Array.isArray(v.options)||v.options.length>200)fail('필드 선택지는 200개 이하여야 합니다.');
    const options=v.options.map((raw:unknown)=>{const option=object(raw,'선택지');return{id:id(option.id,'선택지'),name:name(option.name,'선택지 이름'),archived:flag(option.archived,'선택지 보관 여부')};});unique(options,'선택지');
    const archived=flag(v.archived,'필드 보관 여부');if(!['select','multi_select'].includes(kind)&&options.length)fail('선택형 이외의 필드에는 선택지를 지정할 수 없습니다.');if(['select','multi_select'].includes(kind)&&!archived&&!options.some((option:{archived:boolean})=>!option.archived))fail('활성 선택형 필드에는 최소 한 개의 활성 선택지가 필요합니다.');
    return{id:id(v.id,'필드'),name:name(v.name,'필드 이름'),description:v.description,kind,required:flag(v.required,'필수 입력 여부'),issueTypes:[...v.issueTypes],options,archived};
  });unique(fields,'필드');return{id:projectId,projectId,version,issueTypes,fields,updatedAt};
}
function ownValue(values:Issue['customFields']|undefined,id:string):CustomFieldValue|undefined{return values&&Object.hasOwn(values,id)?values[id]:undefined;}
function equal(a:CustomFieldValue|undefined,b:CustomFieldValue|undefined){if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());return a===b;}
function normalizeValue(field:CustomFieldDefinition,value:unknown,previous:CustomFieldValue|undefined,users:User[]|undefined,allowArchived:boolean):CustomFieldValue{
  if(value===null||value===undefined||value==='')return null;
  switch(field.kind){
    case'text':if(typeof value!=='string'||value.length>20000)fail(`${field.name}: 텍스트는 20,000자 이하여야 합니다.`);return value.trim()?value:null;
    case'number':if(typeof value!=='number'||!Number.isFinite(value))fail(`${field.name}: 유한한 숫자가 필요합니다.`);return value;
    case'checkbox':if(typeof value!=='boolean')fail(`${field.name}: 예·아니요 값이 필요합니다.`);return value;
    case'date':if(!isCalendarDate(value))fail(`${field.name}: 유효한 YYYY-MM-DD 날짜가 필요합니다.`);return value;
    case'user':if(typeof value!=='string'||(users!==undefined&&!users.some(user=>user.id===value)))fail(`${field.name}: 팀원을 찾을 수 없습니다.`);return value;
    case'url':{if(typeof value!=='string'||value.length>4000)fail(`${field.name}: URL을 확인해 주세요.`);let url:URL;try{url=new URL(value.trim());}catch{fail(`${field.name}: 절대 http(s) URL이 필요합니다.`);}if(!['http:','https:'].includes(url!.protocol)||url!.username||url!.password)fail(`${field.name}: 인증 정보가 없는 http(s) URL이 필요합니다.`);return value.trim();}
    case'select':{if(typeof value!=='string')fail(`${field.name}: 선택지 ID가 필요합니다.`);const option=field.options.find(option=>option.id===value);if(!option)fail(`${field.name}: 알 수 없는 선택지입니다.`);if(option.archived&&!allowArchived&&previous!==value)fail(`${field.name}: 보관된 선택지를 새로 지정할 수 없습니다.`,422);return value;}
    case'multi_select':{if(!Array.isArray(value)||value.length>200||value.some(id=>typeof id!=='string')||new Set(value).size!==value.length)fail(`${field.name}: 중복되지 않은 선택지 ID 목록이 필요합니다.`);const before=new Set(Array.isArray(previous)?previous:[]);for(const optionId of value){const option=field.options.find(option=>option.id===optionId);if(!option)fail(`${field.name}: 알 수 없는 선택지입니다.`);if(option.archived&&!allowArchived&&!before.has(optionId))fail(`${field.name}: 보관된 선택지를 새로 지정할 수 없습니다.`,422);}return[...value];}
  }
}
function validateValues(schema:ProjectIssueSchema,next:Issue,previous:Issue|undefined,options:{checkFields?:boolean;allowArchived?:boolean;users?:User[]}):void{
  const type=schema.issueTypes.find(type=>type.id===next.type);if(!type)fail('프로젝트에 없는 업무 유형입니다.');if(type.archived&&!options.allowArchived&&previous?.type!==next.type)fail('보관된 업무 유형은 새로 지정할 수 없습니다.',422);
  const source=next.customFields===undefined?{}:object(next.customFields,'사용자 정의 필드 값'),normalized:Record<string,CustomFieldValue>={};
  for(const[fieldId,raw]of Object.entries(source)){const field=schema.fields.find(field=>field.id===fieldId);if(!field)fail(`알 수 없는 사용자 정의 필드입니다: ${fieldId}`);const before=ownValue(previous?.customFields,fieldId),value=normalizeValue(field,raw,before,options.users,!!options.allowArchived);
    if(hasCustomValue(value)&&!options.allowArchived&&(field.archived||!fieldApplies(field,next.type))&&!equal(value,before))fail(`${field.name}: 보관되었거나 현재 유형에 적용되지 않아 기존 값을 유지하거나 비울 수만 있습니다.`,422);
    Object.defineProperty(normalized,fieldId,{value,writable:true,enumerable:true,configurable:true});
  }
  next.customFields=normalized;
  if(options.checkFields!==false){const missing=schema.fields.filter(field=>field.required&&!field.archived&&fieldApplies(field,next.type)&&!hasCustomValue(ownValue(normalized,field.id)));if(missing.length)fail(`필수 속성을 입력해 주세요: ${missing.map(field=>field.name).join(', ')}`,422,{requiredFields:missing.map(field=>`custom:${field.id}`)});}
}
type Hooks={actor:(request:Request)=>string;activity:(request:Request,type:string,id:string,action:string,detail?:string)=>unknown};

export class IssueSchemaService{
  constructor(private readonly store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS issue_schemas(id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL)');}
  get(projectId:string):ProjectIssueSchema{const project=this.store.get<Project>('projects',projectId);if(!project)fail('프로젝트를 찾을 수 없습니다.',404);return this.store.get<ProjectIssueSchema>('issue_schemas',projectId)||defaultIssueSchema(projectId,project.createdAt);}
  snapshot():ProjectIssueSchema[]{return this.store.all<Project>('projects').map(project=>this.get(project.id));}
  validateIssue(next:Issue,previous?:Issue,options:{checkFields?:boolean;allowArchived?:boolean}={}):void{validateValues(this.get(next.projectId),next,previous,{...options,users:this.store.all<User>('users')});}
  private rows<T>(table:string):T[]{return this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)?this.store.all<T>(table):[];}
  save(projectId:string,input:unknown,expectedVersion:unknown,afterSave?:(schema:ProjectIssueSchema)=>void):ProjectIssueSchema{
    return this.store.transaction(()=>{const old=this.get(projectId);if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1)fail('expectedVersion이 필요합니다.');if(expectedVersion!==old.version)fail('업무 유형·필드 설정이 변경되었습니다. 최신 설정을 확인해 주세요.',409,{currentVersion:old.version});const next=parseSchema(projectId,input,old.version+1,new Date().toISOString());
      const issues=this.store.all<Issue>('issues').filter(issue=>issue.projectId===projectId),workflows=this.rows<ProjectWorkflow>('workflows').filter(workflow=>workflow.projectId===projectId),views=this.rows<SavedView>('saved_views').filter(view=>view.projectId===projectId);
      type RuleReference=Pick<import('../shared/types.js').AutomationRule,'projectId'|'issueTypes'>;
      const automation=[...this.rows<RuleReference>('automation_rules'),...this.rows<RuleReference>('issue_assignment_rules')].filter(rule=>rule.projectId===projectId);
      const typeReferences=new Set([...issues.map(issue=>issue.type),...workflows.flatMap(workflow=>[...workflow.transitions.flatMap(edge=>edge.issueTypes),...workflow.fieldRules.map(rule=>rule.issueType).filter(type=>type!=='*')]),...views.map(view=>view.filters.type).filter(type=>type!=='all'),...automation.flatMap(rule=>rule.issueTypes)]);
      for(const type of old.issueTypes)if(!next.issueTypes.some(candidate=>candidate.id===type.id)&&typeReferences.has(type.id))fail(`참조 중인 업무 유형을 삭제할 수 없습니다: ${type.name}`,409);
      const requiredReferences=new Set(workflows.flatMap(workflow=>[...workflow.transitions.flatMap(edge=>edge.requiredFields),...workflow.fieldRules.flatMap(rule=>rule.requiredFields)]).filter(field=>field.startsWith('custom:')).map(field=>field.slice(7)));
      const viewReferences = new Map<string, Set<string>>();
      for (const view of views) for (const rule of view.filters.fieldFilter?.rules ?? []) {
        const values = viewReferences.get(rule.fieldId) ?? new Set<string>();
        if (typeof rule.value === 'string') values.add(rule.value);
        viewReferences.set(rule.fieldId, values);
      }
      for(const field of old.fields){const updated=next.fields.find(candidate=>candidate.id===field.id),used=issues.some(issue=>hasCustomValue(ownValue(issue.customFields,field.id)));
        if(updated&&updated.kind!==field.kind)fail(`기존 필드 종류는 변경할 수 없습니다: ${field.name}`);
        if(!updated&&viewReferences.has(field.id))fail(`저장된 보기에서 사용하는 필드는 삭제할 수 없습니다: ${field.name}`,409);
        if(!updated&&(used||requiredReferences.has(field.id)))fail(`값 또는 워크플로 참조가 있는 필드는 삭제할 수 없습니다: ${field.name}`,409);
        if(updated?.archived&&requiredReferences.has(field.id))fail(`워크플로에서 필수로 사용하는 필드는 규칙을 수정한 뒤 보관해 주세요: ${field.name}`,409);
        if(updated)for(const option of field.options)if(!updated.options.some(candidate=>candidate.id===option.id)){
          if(viewReferences.get(field.id)?.has(option.id))fail(`저장된 보기에서 사용하는 선택지는 삭제할 수 없습니다: ${option.name}`,409);
          if(issues.some(issue=>{const value=ownValue(issue.customFields,field.id);return Array.isArray(value)?value.includes(option.id):value===option.id;}))fail(`사용 중인 선택지는 삭제할 수 없습니다: ${option.name}`,409);
        }
      }
      for(const fieldId of requiredReferences)if(!next.fields.some(field=>field.id===fieldId&&!field.archived))fail('워크플로에서 사용하는 필수 필드를 유지해 주세요.',409);
      const removed=new Set(old.fields.filter(field=>!next.fields.some(candidate=>candidate.id===field.id)).map(field=>field.id));
      for(const issue of issues){if(!issue.customFields||!Object.keys(issue.customFields).some(id=>removed.has(id)))continue;const customFields=Object.fromEntries(Object.entries(issue.customFields).filter(([id])=>!removed.has(id)));this.store.put('issues',{...issue,customFields,version:issue.version+1,updatedAt:next.updatedAt});}
      this.store.put('issue_schemas',next);afterSave?.(next);return next;
    });
  }
  validateImport(value:unknown,projects:Project[],issues:Issue[],options:{legacy?:boolean;users?:User[]}={}):ProjectIssueSchema[]{
    if(!Array.isArray(value))fail('업무 유형·필드 스키마 목록이 필요합니다.');let schemas:ProjectIssueSchema[];
    if(options.legacy)schemas=projects.map(project=>defaultIssueSchema(project.id,project.createdAt));
    else{if(value.length!==projects.length)fail('프로젝트별 업무 유형·필드 스키마가 하나씩 필요합니다.');const seen=new Set<string>();schemas=value.map(raw=>{const v=object(raw,'업무 스키마');if(typeof v.projectId!=='string'||v.id!==v.projectId||seen.has(v.projectId)||!projects.some(project=>project.id===v.projectId)||!Number.isSafeInteger(v.version)||Number(v.version)<1||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.updatedAt)))fail('업무 스키마의 ID·프로젝트·버전·수정 시간을 확인해 주세요.');seen.add(v.projectId);return parseSchema(v.projectId,v,Number(v.version),v.updatedAt);});}
    for(const issue of issues){const schema=schemas.find(schema=>schema.projectId===issue.projectId);if(!schema)fail('업무 스키마의 프로젝트를 찾을 수 없습니다.');validateValues(schema,{...issue},undefined,{checkFields:false,allowArchived:true,users:options.users});}return schemas;
  }
  replaceImported(schemas:ProjectIssueSchema[],previousVersions=new Map(this.snapshot().map(schema=>[schema.projectId,schema.version]))):void{this.store.db.exec('DELETE FROM issue_schemas');for(const schema of schemas){const previous=previousVersions.get(schema.projectId);this.store.put('issue_schemas',{...schema,version:previous===undefined?schema.version:Math.max(previous,schema.version)+1});}}
  registerRoutes(app:Express,hooks:Hooks):void{app.get('/api/projects/:projectId/issue-schema',(req,res)=>res.json(this.get(String(req.params.projectId))));app.patch('/api/projects/:projectId/issue-schema',(req,res)=>{hooks.actor(req);res.json(this.save(String(req.params.projectId),req.body,req.body.expectedVersion,schema=>hooks.activity(req,'project',schema.projectId,'업무 유형·필드 설정 변경',`버전 ${schema.version}`)));});}
}
