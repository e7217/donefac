import { createHash,randomUUID } from 'node:crypto';
import type { AttachmentVersion,CustomFieldDefinition,CustomFieldKind,CustomFieldValue,Issue,LegacyRecord,MigrationConfiguration,MigrationNotice,MigrationOptions,MigrationValueOption,Project,ProjectIssueSchema,ProjectWorkflow,SourceRecordArchive,StatusCategory } from '../shared/types.js';
import { ISSUE_TYPES } from '../shared/types.js';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import { isCalendarDate } from '../shared/calendar.js';
import { contentReferences } from '../shared/document-nodes.js';
import { convertLegacyContent } from './migration-content.js';
import { isJiraWorklog,isRestrictedJiraWorklog,parseJiraWorklog } from './migration-worklog.js';
import type { MigrationPageIdentity, MigrationReferenceInput } from './migration-content.js';
import { safeFilename } from './attachments.js';
import type { MigrationPackage,MigrationPlanningInput,PreparedMigration } from './migration-contracts.js';
import { isWithinMigrationOrigin, migrationOriginLink, parseMigrationOriginBase, type MigrationOriginBase } from './migration-origin-links.js';

const MAX_PACKAGES=20,MAX_RECORDS=100000,MAX_EXPANDED_BYTES=256*1024*1024,MAX_PROJECTS=100,MAX_FILE_BYTES=20*1024*1024;
const categories:StatusCategory[]=['backlog','todo','in_progress','review','done','cancelled'];
const fieldKinds:CustomFieldKind[]=['text','number','date','select','multi_select','checkbox','user','url'];
const hash=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const optionId=(packageId:string,kind:string,value:string)=>`option_${hash(packageId,kind,value).slice(0,40)}`;
const qualified=(packageId:string,row:LegacyRecord)=>`${packageId}/${row.id}`;
const string=(value:unknown)=>typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const scalar=(value:unknown):unknown=>Array.isArray(value)&&value.length===1?scalar(value[0]):value;
const fieldMap=(row:LegacyRecord)=>object(row.metadata.fields);
const normalizedName=(value:string)=>value.replace(/[\s_/-]/g,'').toLowerCase();
function sourceField(row:LegacyRecord,...names:string[]):unknown{const fields=fieldMap(row);const name=Object.keys(fields).find(name=>names.some(candidate=>normalizedName(name)===normalizedName(candidate)));return name===undefined?undefined:fields[name];}
function builtin(pkg:MigrationPackage,row:LegacyRecord,kind:'status'|'issuetype',index?:Map<string,LegacyRecord>):{value:string;label:string}{
  const raw=scalar(sourceField(row,kind,kind==='issuetype'?'Issue Type':'Status',kind==='issuetype'?'type':'status')??row.metadata[kind]),item=object(raw),value=string(item.id)||string(item.value)||string(item.name)||string(item.text)||string(raw)||'__unspecified__';
  const option=index?index.get(`option:builtin:${kind}:${value}`):pkg.dataset.records.find(option=>option.kind==='option'&&option.sourceId===`builtin:${kind}:${value}`);return{value,label:string(item.name||item.text||item.value)||option?.title||(value==='__unspecified__'?(kind==='status'?'상태 미지정':'유형 미지정'):value)};
}
function customField(row:LegacyRecord){return row.kind==='field'&&!row.sourceId.startsWith('builtin:')&&row.metadata.fieldType!=='csv-label-only';}
function suggestedKind(row:LegacyRecord):CustomFieldKind|'archive'{const type=string(row.metadata.fieldType||row.metadata.customfieldtypekey||row.metadata.fieldtype).toLowerCase();if(/multi.*user|cascad|group|version|project/.test(type))return'archive';if(/multi.*select|multi.*checkbox/.test(type))return'multi_select';if(/select|radio/.test(type))return'select';if(/checkbox|boolean/.test(type))return'checkbox';if(/float|number|decimal|integer/.test(type))return'number';if(/date/.test(type))return'date';if(/userpicker|user$/.test(type))return'user';if(/url/.test(type))return'url';if(/text|string/.test(type))return'text';return'archive';}
function suggestCategory(label:string):StatusCategory{if(/cancel|취소|폐기/i.test(label))return'cancelled';if(/done|closed|resolved|완료|종료|해결/i.test(label))return'done';if(/review|검토|검수|승인/i.test(label))return'review';if(/progress|진행|작업 중/i.test(label))return'in_progress';if(/backlog|대기열/i.test(label))return'backlog';return'todo';}
function packageIndex(pkg:MigrationPackage){return new Map(pkg.dataset.records.map(row=>[row.id,row]));}
function containerFor(pkg:MigrationPackage,row:LegacyRecord,index=packageIndex(pkg)):string{
  const pending=[row],seen=new Set<string>();for(let cursor=0;cursor<pending.length;cursor++){const current=pending[cursor];if(seen.has(current.id))continue;seen.add(current.id);if(current.kind==='project')return current.sourceId;const declared=current.references.find(ref=>ref.kind==='project');if(declared)return declared.sourceId;if(current.containerId&&index.get(`project:${current.containerId}`))return current.containerId;for(const ref of current.references)if(['container-content','current-version','original-version','body-owner','attachedTo','commentOn','historyOf','worklogOf'].includes(ref.relation)){const owner=index.get(`${ref.kind}:${ref.sourceId}`);if(owner)pending.push(owner);}if(current.kind==='issue'||current.kind==='page')return current.containerId||'__unassigned__';}return'__unassigned__';
}
function proposedKey(value:string,id:string):string{const key=value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);return/^[A-Z][A-Z0-9]{1,11}$/.test(key)?key:`MIG${hash(id).slice(0,6).toUpperCase()}`;}

export function buildMigrationOptions(packages:MigrationPackage[]):MigrationOptions{
  const containers:MigrationOptions['containers']=[],identities:MigrationOptions['identities']=[],statuses:MigrationValueOption[]=[],issueTypes:MigrationValueOption[]=[],fields:MigrationOptions['fields']=[];
  for(const pkg of packages){const index=packageIndex(pkg),containerRows=new Map<string,{issueCount:number;documentCount:number}>(),identityIds=new Set<string>(),statusValues=new Map<string,string>(),typeValues=new Map<string,string>();
    for(const row of pkg.dataset.records){if(row.kind==='project')containerRows.set(row.sourceId,{issueCount:0,documentCount:0});if(row.kind==='identity')identityIds.add(row.sourceId);if(row.authorId)identityIds.add(row.authorId);for(const ref of row.references)if(ref.kind==='identity')identityIds.add(ref.sourceId);}
    for(const row of pkg.dataset.records){if(row.kind==='issue'||row.kind==='page'){const id=containerFor(pkg,row,index),count=containerRows.get(id)||{issueCount:0,documentCount:0};if(row.kind==='issue'){count.issueCount++;const state=builtin(pkg,row,'status',index),type=builtin(pkg,row,'issuetype',index);statusValues.set(state.value,state.label);typeValues.set(type.value,type.label);}else count.documentCount++;containerRows.set(id,count);}if(customField(row))fields.push({id:optionId(pkg.summary.id,'field',row.sourceId),packageId:pkg.summary.id,sourceValue:row.sourceId,label:row.title||row.sourceId,suggestedKind:suggestedKind(row)});}
    for(const[sourceProjectId,count]of containerRows){const row=index.get(`project:${sourceProjectId}`),name=row?.title||(sourceProjectId==='__unassigned__'?'원본 프로젝트 미지정':sourceProjectId);containers.push({id:optionId(pkg.summary.id,'container',sourceProjectId),packageId:pkg.summary.id,sourceProjectId,name,proposedKey:proposedKey(string(row?.metadata.key||row?.metadata.pkey||row?.metadata.spaceKey)||sourceProjectId,pkg.summary.id+sourceProjectId),...count});}
    for(const id of identityIds){const row=index.get(`identity:${id}`);identities.push({id:optionId(pkg.summary.id,'identity',id),packageId:pkg.summary.id,sourceValue:id,label:row?.title||id,email:string(row?.metadata.emailAddress||row?.metadata.email)||null});}
    for(const[value,label]of statusValues)statuses.push({id:optionId(pkg.summary.id,'status',value),packageId:pkg.summary.id,sourceValue:value,label});for(const[value,label]of typeValues)issueTypes.push({id:optionId(pkg.summary.id,'issuetype',value),packageId:pkg.summary.id,sourceValue:value,label});
  }
  const defaultConfiguration:MigrationConfiguration={packageIds:packages.map(pkg=>pkg.summary.id),projects:containers.map(container=>({containerId:container.id,key:container.proposedKey,name:container.name})),users:Object.fromEntries(identities.map(identity=>[identity.id,null])),statuses:Object.fromEntries(statuses.map(state=>[state.id,suggestCategory(state.label)])),issueTypes:Object.fromEntries(issueTypes.map(type=>[type.id,null])),fields:Object.fromEntries(fields.map(field=>[field.id,field.suggestedKind])),sourceBaseUrls:Object.fromEntries(packages.map(pkg=>[pkg.summary.id,null])),timezone:'UTC',datePolicy:'block',excludedRecords:[]};
  return{packages:packages.map(pkg=>structuredClone(pkg.summary)),containers,identities,statuses,issueTypes,fields,defaultConfiguration};
}

function utcParts(year:number,month:number,day:number,hour=0,minute=0,second=0,millis=0):number{const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,millis);return date.getTime();}
function localDate(value:string,timezone:string):string|null{
  const match=/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?)?$/.exec(value);if(!match||!isCalendarDate(value.slice(0,10)))return null;const[y,m,d,h,min,s,ms]=[Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4]||0),Number(match[5]||0),Number(match[6]||0),Number((match[7]||'').padEnd(3,'0'))];if(h>23||min>59||s>59)return null;const naive=utcParts(y,m,d,h,min,s,ms),formatter=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(time:number)=>Object.fromEntries(formatter.formatToParts(new Date(time)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));const offsets=new Set<number>();for(const difference of [-36,0,36]){const time=naive+difference*3600000,p=parts(time);offsets.add(utcParts(p.year,p.month,p.day,p.hour,p.minute,p.second)-Math.floor(time/1000)*1000);}const candidates:number[]=[];for(const offset of offsets){const candidate=naive-offset,p=parts(candidate);if(p.year===y&&p.month===m&&p.day===d&&p.hour===h&&p.minute===min&&p.second===s)candidates.push(candidate);}return candidates.length===1?new Date(candidates[0]).toISOString():null;
}
// Explicit English month names avoid guessing numeric locale order. Jira's
// documented dd/MMM/yy h:mm a export format requires a reviewed century policy.
// https://confluence.atlassian.com/jirakb/date-format-changes-after-exporting-to-excel-119799961.html
function jiraEnglishDate(value:string):{local:string;century:boolean}|null{
  const match=/^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s+(AM|PM))?)?$/i.exec(value);if(!match)return null;const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase())+1;if(!month)return null;let hour=Number(match[4]||0);if(match[8]){if(hour<1||hour>12)return null;hour=hour%12+(match[8].toUpperCase()==='PM'?12:0);}const century=match[3].length===2,year=century?2000+Number(match[3]):Number(match[3]),local=`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${match[1].padStart(2,'0')} ${String(hour).padStart(2,'0')}:${match[5]||'00'}:${match[6]||'00'}${match[7]?`.${match[7]}`:''}`;return{local,century};
}

interface Entry{pkg:MigrationPackage;row:LegacyRecord;key:string;container:string}
type Binding={type:'project'|'issue'|'document'|'comment'|'revision'|'attachment';id:string;projectId:string|null};
class Planner{
  options:MigrationOptions;result:PreparedMigration;entries:Entry[]=[];entryByKey=new Map<string,Entry>();bindings=new Map<string,Binding>();excluded=new Set<string>();projectsByContainer=new Map<string,Project>();schemas=new Map<string,ProjectIssueSchema>();workflows=new Map<string,ProjectWorkflow>();notices:MigrationNotice[]=[];noticeKeys=new Set<string>();timezoneValid=true;archiveIds=new Map<string,string>();ownerCache=new Map<string,Entry|null>();indexes=new Map<string,Map<string,LegacyRecord>>();issueById=new Map<string,Issue>();documentById=new Map<string,PreparedMigration['documents'][number]>();primaryById=new Map<string,Entry>();referenceIndex=new Map<string,Entry[]>();resolutionCache=new Map<string,{id:string;label:string;url?:string}|null>();fieldOptions=new Map<string,Map<string,MigrationOptions['fields'][number]>>();sourceOptions=new Map<string,Map<string,LegacyRecord[]>>();
  originBases = new Map<string, MigrationOriginBase>();
  private attachmentRoots = new Map<string, Entry | null>();
  private attachmentVersionsById = new Map<string, AttachmentVersion>();
  private confluenceSpacesByKey = new Map<string, Entry[]>();
  constructor(readonly input:MigrationPlanningInput){this.options=buildMigrationOptions(input.packages);const configuration=structuredClone(input.configuration);this.result={preview:{id:input.id,version:1,actorId:input.actorId,createdAt:input.now,expiresAt:new Date(Date.parse(input.now)+30*60000).toISOString(),configuration,projects:[],counts:{},notices:this.notices,requiredAcknowledgements:[],canApply:false,samples:[]},sourceImport:{id:input.id,version:1,createdAt:input.now,actorId:input.actorId,projectIds:[],configuration,packages:input.packages.map(pkg=>({stagingId:pkg.summary.id,filename:pkg.summary.filename,sha256:pkg.summary.sha256,source:structuredClone(pkg.dataset.source)})),counts:{}},sourceRecords:[],projects:[],workflows:[],issueSchemas:[],issues:[],documents:[],comments:[],revisions:[],worklogs:[],attachments:[],attachmentVersions:[],fileCopies:[],resourceLinks:[],issueRelations:[],atlassianLinks:[]};for(const pkg of input.packages){const index=packageIndex(pkg);this.indexes.set(pkg.summary.id,index);const options=new Map<string,MigrationOptions['fields'][number]>();for(const option of this.options.fields.filter(option=>option.packageId===pkg.summary.id)){options.set(option.sourceValue,option);options.set(option.sourceValue.replace(/^csv:/,''),option);}this.fieldOptions.set(pkg.summary.id,options);const sourceOptions=new Map<string,LegacyRecord[]>();for(const row of pkg.dataset.records){const entry={pkg,row,key:qualified(pkg.summary.id,row),container:containerFor(pkg,row,index)};this.entries.push(entry);this.entryByKey.set(entry.key,entry);if(row.kind==='option'&&row.containerId){const values=sourceOptions.get(row.containerId)||[];values.push(row);sourceOptions.set(row.containerId,values);}if(['page','issue','attachment'].includes(row.kind)){for(const alias of [row.sourceId,...(row.kind==='issue'&&row.metadata.key?[string(row.metadata.key)]:[])]){const key=JSON.stringify([row.kind,'id',alias]),values=this.referenceIndex.get(key)||[];if(!values.includes(entry))values.push(entry);this.referenceIndex.set(key,values);}const key=JSON.stringify([row.kind,'title',row.title]),values=this.referenceIndex.get(key)||[];values.push(entry);this.referenceIndex.set(key,values);}}this.sourceOptions.set(pkg.summary.id,sourceOptions);}}
  notice(code:string,message:string,severity:MigrationNotice['severity']='warning',entry?:Entry,ack=false){if(this.notices.length>=9999){if(this.notices.length===9999)this.notices.push({severity:'error',code:'NOTICE_LIMIT',message:'진단이10000건 한도에 도달했습니다. 누락된 진단을 승인으로 간주하지 않으며 패키지를 나누거나 매핑·제외 조건을 먼저 수정해야 합니다.',recordId:null,requiresAcknowledgement:false});return;}const recordId=entry?.key||null,key=JSON.stringify([code,recordId,message]);if(this.noticeKeys.has(key))return;this.noticeKeys.add(key);this.notices.push({severity,code,message:message.length>2000?`${message.slice(0,1950)} [진단 일부만 표시]`:message,recordId,requiresAcknowledgement:ack});}
  get configuration(){return this.result.preview.configuration;}
  sourceEntry(entry:Entry,kind:string,id:string){return this.entryByKey.get(`${entry.pkg.summary.id}/${kind}:${id}`);}
  mappedAuthor(entry:Entry,id=entry.row.authorId):string|null {
    if(!id)return null;
    const option=optionId(entry.pkg.summary.id,'identity',id),mapped=this.configuration.users[option];
    return typeof mapped==='string'&&this.input.users.some(user=>user.id===mapped)?mapped:null;
  }
  author(entry:Entry,id=entry.row.authorId):string{return this.mappedAuthor(entry,id)??this.input.actorId;}
  time(value:string|null,entry:Entry,required=true):string|null{if(!value){if(!required)return null;return this.unknownTime(entry,'원본 시각이 없습니다.');}let result:string|null=null;const english=jiraEnglishDate(value);if(english&&this.timezoneValid){result=localDate(english.local,this.configuration.timezone);if(result&&english.century)this.notice('DATE_TWO_DIGIT_CENTURY','Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.','warning',entry,true);}else if(/(?:Z|[+-]\d\d:?\d\d|\bUTC\b|\bGMT\b)(?:\s*\([^)]*\))?$/.test(value)){const parsed=/^\d{4}-\d\d-\d\d/.test(value)&&!isCalendarDate(value.slice(0,10))?NaN:Date.parse(value.replace(/ UTC$/,'Z').replace(/^(\d{4}-\d\d-\d\d) /,'$1T'));if(Number.isFinite(parsed))result=new Date(parsed).toISOString();}else if(this.timezoneValid)result=localDate(value,this.configuration.timezone);return result||this.unknownTime(entry,'원본 시각을 지정 시간대에서 유일하게 해석할 수 없습니다.');}
  unknownTime(entry:Entry,message:string):string{if(this.configuration.datePolicy==='import-time'){this.notice('DATE_IMPORT_TIME',`${message} 현재 이관 시각을 사용하며 원본 문자열은 보존합니다.`,'warning',entry,true);}else this.notice('DATE_UNRESOLVED',message,'error',entry);return this.input.now;}
  project(entry:Entry):Project|undefined{return this.projectsByContainer.get(optionId(entry.pkg.summary.id,'container',entry.container));}
  run():PreparedMigration{this.initialize();if(!this.notices.some(notice=>notice.severity==='error')){this.createPrimary();this.createOriginLinks();this.createFiles();this.convertDocuments();this.createSecondary();this.createWorklogs();this.createRelations();this.validateGraph();}this.archive();return this.finish();}
  initializeOriginBases(): void {
    const suppliedBases = this.configuration.sourceBaseUrls;
    const packages = this.input.packages;
    const packageIds = new Set(packages.map(pkg => pkg.summary.id));
    if (Object.keys(suppliedBases).some(id => !packageIds.has(id))) {
      this.notice('SOURCE_BASE_URL_UNKNOWN_PACKAGE', '원본 기준 주소는 선택한 패키지별로 지정해 주세요.', 'error');
    }
    this.configuration.sourceBaseUrls = Object.fromEntries(packages.map(({ summary, dataset }) => {
      const value = Object.hasOwn(suppliedBases, summary.id) ? suppliedBases[summary.id] : null;
      if (value == null) return [summary.id, null];
      const base = parseMigrationOriginBase(dataset.source.product, value);
      if (!base) {
        this.notice('SOURCE_BASE_URL_INVALID', `${summary.filename}의 원본 기준 주소를 확인해 주세요. HTTP(S) 서버 주소와 서비스 경로만 입력해 주세요.`, 'error');
        return [summary.id, null];
      }
      this.originBases.set(summary.id, base);
      return [summary.id, `${base.origin}${base.contextPath}`];
    }));
  }
  createOriginLinks(): void {
    const missingBases = new Map<string, { firstEntry: Entry; count: number }>();
    const unavailableLocators = new Map<string, { firstEntry: Entry; count: number }>();
    for (const [targetId, entry] of this.primaryById) {
      const { summary, dataset } = entry.pkg;
      const base = this.originBases.get(summary.id);
      if (!base) {
        const match = missingBases.get(summary.id);
        if (match) match.count++;
        else missingBases.set(summary.id, { firstEntry: entry, count: 1 });
        continue;
      }
      const product = dataset.source.product;
      const url = migrationOriginLink(base, product, entry.row);
      if (!url) {
        const match = unavailableLocators.get(summary.id);
        if (match) match.count++;
        else unavailableLocators.set(summary.id, { firstEntry: entry, count: 1 });
        continue;
      }
      const targetType = entry.row.kind === 'issue' ? 'issue' : 'document';
      this.result.atlassianLinks.push({ targetType, targetId, product, url });
    }
    for (const { summary } of this.input.packages) {
      const missing = missingBases.get(summary.id);
      if (missing) this.notice('SOURCE_LINK_BASE_MISSING', `${summary.filename}의 원본 기준 주소가 비어 있어 ${missing.count}개 항목을 연결 없이 이관합니다.`, 'info', missing.firstEntry);
      const unavailable = unavailableLocators.get(summary.id);
      if (unavailable) {
        this.notice('SOURCE_LINK_LOCATOR_UNAVAILABLE', `${summary.filename}에서 열 수 있는 원본 업무·페이지 주소를 확인하지 못한 ${unavailable.count}개 항목을 연결 없이 이관합니다.`, 'warning', unavailable.firstEntry);
      }
    }
  }
  ownerEntry(entry:Entry):Entry|null{
    if(this.ownerCache.has(entry.key))return this.ownerCache.get(entry.key)!;const pending=[entry],seen=new Set<string>();let owner:Entry|null=null;
    for(let cursor=0;cursor<pending.length&&!owner;cursor++){const current=pending[cursor];if(seen.has(current.key))continue;seen.add(current.key);if(current.row.kind==='issue'||current.row.kind==='page'){owner=current;break;}const currentId=string(current.row.metadata.currentVersionId);if(currentId){const candidate=this.sourceEntry(current,current.row.kind==='revision'?'page':current.row.kind,currentId)||this.sourceEntry(current,'revision',currentId);if(candidate)pending.push(candidate);}for(const reference of current.row.references)if(['container-content','current-version','body-owner','attachedTo','commentOn','historyOf','worklogOf','source'].includes(reference.relation)){const candidate=this.sourceEntry(current,reference.kind,reference.sourceId);if(candidate)pending.push(candidate);}if(current.row.containerId)for(const kind of ['issue','page','revision','comment','attachment']){const candidate=this.sourceEntry(current,kind,current.row.containerId);if(candidate)pending.push(candidate);}}
    this.ownerCache.set(entry.key,owner);return owner;
  }
  initialize():void{
    const config=this.configuration,sourceCount=this.entries.length;
    if(this.input.packages.length>MAX_PACKAGES||sourceCount>MAX_RECORDS||this.input.packages.reduce((sum,pkg)=>sum+pkg.summary.expandedBytes,0)>MAX_EXPANDED_BYTES)this.notice('PLAN_LIMIT','한 이관은20개 패키지·100000개 원본 객체·총256MiB 확장 크기 이하여야 합니다.','error');
    if(!this.input.users.some(user=>user.id===this.input.actorId))this.notice('ACTOR_INVALID','이관 작업자를 찾을 수 없습니다.','error');
    if(!Array.isArray(config.packageIds)||new Set(config.packageIds).size!==config.packageIds.length||config.packageIds.length!==this.input.packages.length||this.input.packages.some(pkg=>!config.packageIds.includes(pkg.summary.id)))this.notice('PACKAGE_SELECTION_INVALID','선택한 패키지 목록과 이관 구성이 일치하지 않습니다.','error');
    try{if(!config.timezone)throw new Error();new Intl.DateTimeFormat('en',{timeZone:config.timezone}).format(0);}catch{this.timezoneValid=false;this.notice('TIMEZONE_INVALID','유효한 원본 IANA 시간대를 지정해 주세요.','error');}
    if(!['block','import-time'].includes(config.datePolicy))this.notice('DATE_POLICY_INVALID','날짜 처리 방식을 확인해 주세요.','error');
    this.initializeOriginBases();
    for(const key of config.excludedRecords||[]){if(!this.entryByKey.has(key))this.notice('EXCLUSION_INVALID','제외 대상 원본 객체를 찾을 수 없습니다.','error');else this.excluded.add(key);}
    const explicitCount=this.excluded.size,children=new Map<string,string[]>();
    for(const entry of this.entries){this.archiveIds.set(entry.key,randomUUID());const row=entry.row,parents:string[]=[];if(row.parentId)parents.push(`${entry.pkg.summary.id}/${row.kind==='issue'?'issue':row.kind==='page'?'page':row.kind}:${row.parentId}`);if(row.kind==='issue'||row.kind==='page')parents.push(`${entry.pkg.summary.id}/project:${entry.container}`);else{const owner=this.ownerEntry(entry);if(owner&&owner!==entry)parents.push(owner.key);const current=string(row.metadata.currentVersionId);if(current)parents.push(`${entry.pkg.summary.id}/${row.kind==='revision'?'page':row.kind}:${current}`);}for(const parent of parents){const values=children.get(parent)||[];values.push(entry.key);children.set(parent,values);}}
    const queue=[...this.excluded];for(let cursor=0;cursor<queue.length;cursor++)for(const child of children.get(queue[cursor])||[])if(!this.excluded.has(child)){this.excluded.add(child);queue.push(child);}
    this.result.preview.counts.explicitExcludedRecords=explicitCount;this.result.preview.counts.excludedDescendants=this.excluded.size-explicitCount;
    if(this.excluded.size)this.notice('RECORDS_EXCLUDED',`원본 ${this.excluded.size}개를 적용 대상에서 제외합니다(명시적 ${explicitCount}개, 하위 ${this.excluded.size-explicitCount}개). 원문 보관은 유지합니다.`,'warning',undefined,true);
    for(const option of this.options.identities){if(!Object.hasOwn(config.users,option.id))this.notice('USER_MAPPING_REQUIRED',`원본 사용자 매핑을 선택해 주세요: ${option.label}`,'error');else if(config.users[option.id]!==null&&!this.input.users.some(user=>user.id===config.users[option.id]))this.notice('USER_MAPPING_INVALID','매핑한 팀원을 찾을 수 없습니다.','error');}
    if(this.options.identities.some(option=>config.users[option.id]===null))this.notice('SOURCE_IDENTITIES_ARCHIVED','매핑하지 않은 원본 사용자 신원은 그대로 보관하고, 현재 댓글·문서·첨부의 작성자는 이관 작업자로 기록합니다.','warning',undefined,true);
    for(const option of this.options.statuses)if(!categories.includes(config.statuses[option.id]))this.notice('STATUS_MAPPING_REQUIRED',`원본 상태의 분류를 선택해 주세요: ${option.label}`,'error');
    for(const option of this.options.issueTypes)if(!Object.hasOwn(config.issueTypes,option.id)||config.issueTypes[option.id]!==null&&!ISSUE_TYPES.includes(config.issueTypes[option.id] as typeof ISSUE_TYPES[number]))this.notice('TYPE_MAPPING_REQUIRED',`원본 유형을 기존 유형 또는 새 유형에 매핑해 주세요: ${option.label}`,'error');
    for(const option of this.options.fields)if(config.fields[option.id]!=='archive'&&!fieldKinds.includes(config.fields[option.id] as CustomFieldKind))this.notice('FIELD_MAPPING_REQUIRED',`원본 필드의 처리 방식을 선택해 주세요: ${option.label}`,'error');
    const projectConfigs=new Map<string,MigrationConfiguration['projects'][number]>();for(const mapping of config.projects){if(projectConfigs.has(mapping.containerId)||!this.options.containers.some(container=>container.id===mapping.containerId))this.notice('PROJECT_MAPPING_INVALID','프로젝트 매핑이 중복되거나 원본 컨테이너가 없습니다.','error');projectConfigs.set(mapping.containerId,mapping);}
    const activeContainers=new Set(this.entries.filter(entry=>!this.excluded.has(entry.key)&&(entry.row.kind==='issue'||entry.row.kind==='page')).map(entry=>optionId(entry.pkg.summary.id,'container',entry.container)));const grouped=new Map<string,Project>();for(const container of this.options.containers){const active=activeContainers.has(container.id);if(!active)continue;const mapping=projectConfigs.get(container.id);if(!mapping){this.notice('PROJECT_MAPPING_REQUIRED',`새 프로젝트를 지정해 주세요: ${container.name}`,'error');continue;}const key=string(mapping.key).trim().toUpperCase(),name=string(mapping.name).trim();if(!/^[A-Z][A-Z0-9]{1,11}$/.test(key)||!name||name.length>100){this.notice('PROJECT_MAPPING_INVALID','프로젝트 키는2~12자 영문·숫자, 이름은1~100자여야 합니다.','error');continue;}if(this.input.existingProjectKeys.some(existing=>existing.toUpperCase()===key)){this.notice('PROJECT_KEY_CONFLICT',`기존 프로젝트 키와 충돌합니다: ${key}`,'error');continue;}let project=grouped.get(key);if(project&&project.name!==name){this.notice('PROJECT_NAME_CONFLICT',`같은 프로젝트 키 ${key}에 서로 다른 이름을 지정했습니다.`,'error');continue;}if(!project){project={id:randomUUID(),key,name,description:'기존 도구에서 이관한 프로젝트',color:'#668899',createdAt:this.input.now};grouped.set(key,project);this.result.projects.push(project);}this.projectsByContainer.set(container.id,project);}
    if(this.result.projects.length>MAX_PROJECTS)this.notice('PROJECT_LIMIT','한 번에 새 프로젝트100개까지 이관할 수 있습니다.','error');
    for (const entry of this.entries) {
      if (entry.row.kind !== 'project') continue;
      if (entry.pkg.dataset.source.product === 'confluence') {
        const keys = new Set([entry.row.metadata.spaceKey, entry.row.metadata.key, entry.row.metadata.pkey]);
        for (const key of keys) {
          if (typeof key !== 'string' || !key) continue;
          const spaces = this.confluenceSpacesByKey.get(key) ?? [];
          spaces.push(entry);
          this.confluenceSpacesByKey.set(key, spaces);
        }
      }
      const project = this.projectsByContainer.get(optionId(entry.pkg.summary.id, 'container', entry.row.sourceId));
      if (project && !this.excluded.has(entry.key)) this.bindings.set(entry.key, { type: 'project', id: project.id, projectId: project.id });
    }
    if(this.result.projects.length)this.notice('PROJECT_ACCESS_NOT_REPRODUCED','원본 Jira/Confluence 프로젝트·공간 권한 체계는 새 팀 프로젝트에 재현하지 않습니다. 제한된 개별 콘텐츠는 제외 전까지 차단하며 원래 권한 자료는 보관합니다.','warning',undefined,true);
    const sourceAliases=new Map<string,string>();for(const entry of this.entries)if(!this.excluded.has(entry.key)&&['issue','page','project'].includes(entry.row.kind)){const target=this.bindings.get(entry.key)?.id;for(const alias of [entry.row.sourceId,...(entry.row.kind==='issue'&&entry.row.metadata.key?[string(entry.row.metadata.key)]:[])]){const key=JSON.stringify([entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,entry.row.kind,alias]),previous=sourceAliases.get(key);if(previous&&previous!==entry.key&&!(target&&target===this.bindings.get(previous)?.id))this.notice('SOURCE_BINDING_AMBIGUOUS','같은 원본 인스턴스·ID가 여러 적용 대상으로 존재합니다. 겹치는 내보내기를 제외해 주세요.','error',entry);else sourceAliases.set(key,entry.key);}}
    for(const entry of this.entries)if(!this.excluded.has(entry.key)&&this.restricted(entry))this.notice('RESTRICTED_CONTENT','권한 또는 공개 범위가 제한된 원본은 현재 서비스에 그대로 공개할 수 없습니다. 해당 객체를 제외해 주세요.','error',entry);
    for(const pkg of this.input.packages){for(const diagnostic of pkg.dataset.diagnostics){const recordKey=diagnostic.recordId?`${pkg.summary.id}/${diagnostic.recordId}`:null;if(recordKey&&this.excluded.has(recordKey))continue;const missingBytes=/ATTACHMENT_BYTES_MISSING/.test(diagnostic.code);if(diagnostic.severity==='error'&&!missingBytes)this.notice(`SOURCE_${diagnostic.code}`,diagnostic.message,'error',recordKey?this.entryByKey.get(recordKey):undefined);}
      for(const warning of pkg.dataset.diagnostics.filter(notice=>notice.severity==='warning')){if(warning.recordId&&this.excluded.has(`${pkg.summary.id}/${warning.recordId}`))continue;if(['DATE_TIMEZONE_UNRESOLVED','CONFLUENCE_TIMEZONE_UNKNOWN','MISSING_REFERENCE','CONFLUENCE_STORAGE_REFERENCES_UNRESOLVED'].includes(warning.code))continue;this.notice(`SOURCE_${warning.code}`,warning.message,'warning',warning.recordId?this.entryByKey.get(`${pkg.summary.id}/${warning.recordId}`):undefined,true);}
      if(pkg.dataset.unsupported.length)this.notice('UNSUPPORTED_SOURCE_RECORDS',`원본 ${pkg.summary.filename}의 미지원 객체/필드는 보관 가능한 분석 결과만 남으며 실행 기능을 재현하지 않습니다.`,'warning',undefined,true);
    }
  }
  restricted(entry:Entry):boolean{
    const row=entry.row,metadata=row.metadata;
    if(entry.pkg.dataset.source.product==='jira'&&isRestrictedJiraWorklog(row))return true;
    if((row.kind==='page'||row.kind==='comment')&&(metadata.restricted===true||metadata.hasRestrictions===true||Array.isArray(metadata.restrictions)&&metadata.restrictions.length>0||Array.isArray(metadata.permissions)&&metadata.permissions.length>0))return true;
    if(row.kind==='comment'){if(string(metadata.level)||string(metadata.rolelevel)||string(metadata.groupLevel)||string(metadata.roleLevel))return true;const visibility=object(metadata.visibility);if(Object.keys(visibility).length)return true;if(Array.isArray(metadata.visibility)&&metadata.visibility.some(value=>{const property=object(value);return property.key==='sd.public.comment'&&['true',true].includes(object(property.value).internal as string|boolean);}))return true;}
    if(row.kind==='issue'){const security=scalar(sourceField(row,'security','Security Level','Issue Security Level'));if(security!==undefined&&security!==null&&security!==false&&(typeof security==='object'?Object.keys(object(security)).some(key=>!!object(security)[key]):!!string(security)))return true;}
    return false;
  }
  createPrimary():void{
    for(const project of this.result.projects){this.schemas.set(project.id,{...defaultIssueSchema(project.id,this.input.now),issueTypes:[],fields:[]});this.workflows.set(project.id,{...defaultWorkflow(project.id,this.input.now),statuses:[],transitions:[],fieldRules:[]});}
    const issueNumbers=new Map<string,number>();
    for(const entry of this.entries){if(this.excluded.has(entry.key)||!['issue','page'].includes(entry.row.kind))continue;const project=this.project(entry);if(!project)continue;const row=entry.row,id=randomUUID();if(!row.title.trim()||row.title.trim().length>300)this.notice('TITLE_INVALID','제목이 비어 있거나300자를 넘습니다. 원본은 보존하지만 현재 객체로 적용할 수 없습니다.','error',entry);const title=row.title.trim().slice(0,300)||'제목 없음',createdAt=this.time(row.createdAt,entry)!,updatedAt=this.time(row.updatedAt,entry,false)||createdAt;
      if(row.kind==='page'){this.result.documents.push({id,projectId:project.id,parentId:null,title,content:{type:'doc',content:[{type:'paragraph'}]},plainText:'',icon:'📄',status:'published',version:1,authorId:this.author(entry),createdAt,updatedAt});this.documentById.set(id,this.result.documents[this.result.documents.length-1]);this.primaryById.set(id,entry);this.bindings.set(entry.key,{type:'document',id,projectId:project.id});}
      else{const state=builtin(entry.pkg,row,'status',this.indexes.get(entry.pkg.summary.id)),category=this.configuration.statuses[optionId(entry.pkg.summary.id,'status',state.value)],stateId=`s_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,state.value).slice(0,24)}`,workflow=this.workflows.get(project.id)!;
        if(state.label.length>40)this.notice('STATUS_LABEL_LIMIT','원본 상태 이름이 현재40자 제한을 넘습니다.','error',entry);const existingState=workflow.statuses.find(status=>status.id===stateId);if(existingState&&existingState.category!==category)this.notice('STATUS_MAPPING_CONFLICT','같은 원본 상태를 서로 다른 분류로 매핑했습니다.','error',entry);else if(!existingState)workflow.statuses.push({id:stateId,label:state.label,color:'#668899',category});
        const sourceType=builtin(entry.pkg,row,'issuetype',this.indexes.get(entry.pkg.summary.id)),mappedType=this.configuration.issueTypes[optionId(entry.pkg.summary.id,'issuetype',sourceType.value)],typeId=mappedType||`t_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,sourceType.value).slice(0,24)}`,schema=this.schemas.get(project.id)!,typeName=mappedType||sourceType.label;
        if(typeName.length>120)this.notice('TYPE_NAME_LIMIT','원본 유형 이름이 현재120자 제한을 넘습니다.','error',entry);if(!schema.issueTypes.some(type=>type.id===typeId))schema.issueTypes.push({id:typeId,name:typeName,color:'#668899',archived:false});
        const number=(issueNumbers.get(project.id)||0)+1;issueNumbers.set(project.id,number);const assigneeRef=row.references.find(reference=>reference.kind==='identity'&&reference.relation==='assignee'),assigneeSource=assigneeRef?.sourceId||string(scalar(sourceField(row,'assignee'))),mappedAssignee=assigneeSource?this.configuration.users[optionId(entry.pkg.summary.id,'identity',assigneeSource)]:null;
        const labelsRaw=sourceField(row,'labels')??row.metadata.labels,labels=(Array.isArray(labelsRaw)?labelsRaw:typeof labelsRaw==='string'?labelsRaw.split(/[;,]/):[]).map(value=>string(value));if(labels.some(label=>label.length>60))this.notice('LABEL_LIMIT','원본 라벨이 현재60자 제한을 넘습니다.','error',entry);
        const start=this.issueDate(sourceField(row,'startDate','Start date','Start'),entry),end=this.issueDate(sourceField(row,'endDate','End date','End'),entry),due=this.issueDate(sourceField(row,'dueDate','due','duedate'),entry);if(start&&end&&start>end)this.notice('ISSUE_DATE_RANGE','시작일이 종료일보다 늦습니다.','error',entry);
        const rawEstimate=sourceField(row,'estimate'),estimate=rawEstimate===undefined||rawEstimate===null||rawEstimate===''?null:Number(rawEstimate);if(estimate!==null&&(!Number.isFinite(estimate)||estimate<0||estimate>100000))this.notice('ESTIMATE_ARCHIVED','예상 작업량의 단위/범위를 현재 숫자로 옮기지 않고 원본으로 보관합니다.','warning',entry,true);
        const issue:Issue={id,key:`${project.key}-${number}`,projectId:project.id,title,description:'',type:typeId,status:stateId,priority:this.priority(sourceField(row,'priority')),assigneeId:typeof mappedAssignee==='string'?mappedAssignee:null,collaboratorIds:[],parentId:null,labels:[...new Set(labels)],startDate:start,endDate:end,dueDate:due,estimate:estimate!==null&&Number.isFinite(estimate)&&estimate>=0&&estimate<=100000?estimate:null,cycle:null,module:null,release:null,cycleId:null,moduleId:null,releaseId:null,customFields:{},version:1,createdAt,updatedAt,completedAt:category==='done'?(this.time(string(sourceField(row,'resolutiondate','resolved'))||row.updatedAt,entry,false)||updatedAt):null};this.result.issues.push(issue);this.issueById.set(id,issue);this.primaryById.set(id,entry);this.bindings.set(entry.key,{type:'issue',id,projectId:project.id});
        for(const option of new Set(Object.keys(fieldMap(row)).map(name=>this.fieldOptions.get(entry.pkg.summary.id)?.get(name)).filter((option):option is MigrationOptions['fields'][number]=>!!option))){const sourceDefinition=this.sourceEntry(entry,'field',option.sourceValue)?.row;if(!sourceDefinition)continue;const fields=fieldMap(row),raw=Object.hasOwn(fields,option.sourceValue)?fields[option.sourceValue]:fields[option.sourceValue.replace(/^csv:/,'')];if(raw===undefined)continue;const kind=this.configuration.fields[option.id];if(kind==='archive'){this.notice('FIELD_ARCHIVED',`필드 '${option.label}' 값은 원본 보관함에만 유지합니다.`,'warning',entry,true);continue;}const fieldId=`f_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,option.sourceValue).slice(0,24)}`;let definition=schema.fields.find(field=>field.id===fieldId);if(definition&&definition.kind!==kind)this.notice('FIELD_MAPPING_CONFLICT','같은 원본 필드를 다른 자료형으로 매핑했습니다.','error',entry);if(!definition){definition={id:fieldId,name:option.label,description:sourceDefinition.text.slice(0,20000),kind:kind as CustomFieldKind,required:false,issueTypes:[],options:[],archived:false};if(kind==='select'||kind==='multi_select')definition.options=(this.sourceOptions.get(entry.pkg.summary.id)?.get(option.sourceValue)||[]).map(row=>({id:`o_${hash(fieldId,string(row.metadata.originalId)||row.sourceId).slice(0,24)}`,name:row.title,archived:['Y','true','1'].includes(string(row.metadata.disabled))}));schema.fields.push(definition);}issue.customFields![fieldId]=this.convertField(entry,option.sourceValue,definition,raw);}
        if(row.textFormat!=='plain'&&row.textFormat!=='none')this.notice('ISSUE_DESCRIPTION_PLAIN_TEXT','업무 설명은 현재 일반 텍스트로 변환합니다. 원래 서식·본문은 원본 보관함에 유지합니다.','warning',entry,true);
      }
    }
    for(const project of this.result.projects){const schema=this.schemas.get(project.id)!,workflow=this.workflows.get(project.id)!;if(!schema.issueTypes.length)schema.issueTypes=defaultIssueSchema(project.id).issueTypes;if(!workflow.statuses.length)Object.assign(workflow,defaultWorkflow(project.id,this.input.now));else{workflow.initialStatusId=workflow.statuses.find(status=>status.category==='todo')?.id||workflow.statuses[0].id;workflow.transitions=workflow.statuses.flatMap(from=>workflow.statuses.filter(to=>to.id!==from.id).map(to=>({from:from.id,to:to.id,issueTypes:[],requiredFields:[]})));this.notice('WORKFLOW_RULES_NOT_REPRODUCED','원본 워크플로의 조건·검증기·후처리를 재현하지 않습니다. 매핑한 상태 사이의 전이를 허용하는 새 흐름을 만듭니다.','warning',undefined,true);}if(workflow.statuses.length>40||schema.issueTypes.length>50||schema.fields.length>100)this.notice('SCHEMA_LIMIT','프로젝트별 상태40개·유형50개·필드100개 제한을 넘습니다.','error');if(new Set(schema.issueTypes.map(type=>type.name)).size!==schema.issueTypes.length)this.notice('TYPE_NAME_CONFLICT','새 프로젝트 안에 같은 이름의 서로 다른 유형이 있습니다. 유형 매핑을 조정해 주세요.','error');if(schema.fields.some(field=>!field.name.trim()||field.name.length>120)||new Set(schema.fields.map(field=>field.name)).size!==schema.fields.length)this.notice('FIELD_NAME_CONFLICT','필드 이름이 중복되거나120자 제한을 넘습니다. 매핑 또는 보관 방식을 조정해 주세요.','error');this.result.issueSchemas.push(schema);this.result.workflows.push(workflow);}
  }
  issueDate(value:unknown,entry:Entry):string|null{value=scalar(value);if(value===undefined||value===null||value==='')return null;const raw=string(value);if(isCalendarDate(raw))return raw;const timestamp=this.time(raw,entry,false);if(!timestamp)return null;const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:this.timezoneValid?this.configuration.timezone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}),parts=Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return`${parts.year}-${parts.month}-${parts.day}`;}
  priority(value:unknown):Issue['priority']{value=scalar(value);const label=string(object(value).name||object(value).text||value);if(/urgent|highest|blocker|긴급/i.test(label))return'urgent';if(/high|critical|높음/i.test(label))return'high';if(/low|minor|trivial|낮음/i.test(label))return'low';return'medium';}
  convertField(entry:Entry,sourceId:string,definition:CustomFieldDefinition,input:unknown):CustomFieldValue{
    const unwrap=(value:unknown):unknown=>{const objectValue=object(value);for(const name of ['numbervalue','stringvalue','textvalue','datevalue'])if(Object.hasOwn(objectValue,name))return objectValue[name];return value;};let value=Array.isArray(input)?input.map(unwrap):unwrap(input);if(definition.kind!=='multi_select')value=scalar(value);if(value===null||value===undefined||value==='')return null;
    const bad=()=>{this.notice('FIELD_VALUE_INVALID',`필드 '${definition.name}' 값을 선택한 ${definition.kind} 자료형으로 손실 없이 변환할 수 없습니다. 보관 방식을 선택하거나 매핑을 고쳐 주세요.`,'error',entry);return null;};
    if(definition.kind==='text'){if(typeof value==='object')return bad();const result=string(value);return result.length<=20000?result:bad();}
    if(definition.kind==='number'){const result=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;return Number.isFinite(result)?result:bad();}
    if(definition.kind==='checkbox'){if(value===true||value===false)return value;if(value==='true'||value==='1'||value===1)return true;if(value==='false'||value==='0'||value===0)return false;return bad();}
    if(definition.kind==='date'){const raw=string(value);return isCalendarDate(raw)?raw:this.issueDate(raw,entry);}
    if(definition.kind==='user'){const id=string(object(value).accountId||object(value).key||object(value).name||value),mapped=this.configuration.users[optionId(entry.pkg.summary.id,'identity',id)];return typeof mapped==='string'?mapped:bad();}
    if(definition.kind==='url'){try{const url=new URL(string(value));return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.toString().length<=4000?url.toString():bad();}catch{return bad();}}
    const choose=(raw:unknown):string|null=>{const objectValue=object(raw),id=string(objectValue.id||objectValue.value||objectValue.name||raw);if(!id)return null;const direct=this.sourceEntry(entry,'option',id)?.row,original=direct?.containerId===sourceId?direct:this.sourceEntry(entry,'option',`${sourceId}:${id}`)?.row,label=string(objectValue.value||objectValue.name)||original?.title||id,optionId=`o_${hash(definition.id,id).slice(0,24)}`;if(label.length>120){bad();return null;}if(!definition.options.some(option=>option.id===optionId))definition.options.push({id:optionId,name:label,archived:false});if(definition.options.length>200||new Set(definition.options.map(option=>option.name)).size!==definition.options.length){bad();return null;}return optionId;};
    if(definition.kind==='multi_select'){const values=Array.isArray(value)?value:[value],result=values.map(choose);return result.some(value=>value===null)?bad():[...new Set(result as string[])];}return Array.isArray(value)?bad():choose(value);
  }
  private attachmentRoot(entry: Entry): Entry | null {
    const visited = new Set<string>();
    let current = entry;
    let root: Entry | null = null;
    while (!visited.has(current.key)) {
      if (this.attachmentRoots.has(current.key)) {
        root = this.attachmentRoots.get(current.key)!;
        break;
      }
      visited.add(current.key);
      const nextId = string(current.row.metadata.currentVersionId);
      const next = nextId && this.sourceEntry(current, 'attachment', nextId);
      if (!next) {
        root = current;
        break;
      }
      current = next;
    }
    for (const key of visited) this.attachmentRoots.set(key, root);
    return root;
  }
  createFiles():void{
    const groups = new Map<string, Entry[]>();
    for (const entry of this.entries) {
      if (entry.row.kind !== 'attachment' || this.excluded.has(entry.key)) continue;
      const root = this.attachmentRoot(entry);
      if (!root) {
        this.notice('ATTACHMENT_VERSION_CYCLE', '첨부 버전 관계가 순환합니다.', 'error', entry);
        continue;
      }
      const group = groups.get(root.key) ?? [];
      group.push(entry);
      groups.set(root.key, group);
    }
    for(const[rootKey,versions]of groups){const ownerEntry=this.ownerEntry(versions[0]),owner=ownerEntry?this.bindings.get(ownerEntry.key):undefined;if(!owner||!['issue','document'].includes(owner.type)){this.notice('ATTACHMENT_OWNER_MISSING','첨부 파일의 현재 업무·문서 소유자를 확정할 수 없습니다.','error',versions[0]);continue;}
      const ordered=[...versions].sort((a,b)=>{if(a.key===rootKey)return-1;if(b.key===rootKey)return 1;return Number(b.row.metadata.attachmentVersion||b.row.metadata.version||0)-Number(a.row.metadata.attachmentVersion||a.row.metadata.version||0)||a.key.localeCompare(b.key);});
      const available:{entry:Entry;value:AttachmentVersion}[]=[];
      for(const entry of ordered){const metadata=entry.row.metadata,path=string(metadata.packagePath||metadata.path),verified=path?this.input.fileInfo?.[entry.pkg.summary.id]?.[path]:undefined,size=verified?.size??Number(metadata.actualSize??metadata.size),sha=verified?.sha256||string(metadata.sha256),filePresent=path&&/^[a-f\d]{64}$/.test(sha)&&Number.isSafeInteger(size)&&(this.input.fileInfo===undefined||!!verified);
        if(!filePresent){this.notice('ATTACHMENT_BYTES_MISSING','이 첨부 버전의 파일 바이트를 확정할 수 없습니다. 메타데이터·원문만 보존하며 가짜 파일은 만들지 않습니다.','warning',entry,true);continue;}
        if(size===0){this.notice('ATTACHMENT_EMPTY_ARCHIVED','0바이트 첨부는 현재 첨부 기능에 추가하지 않고 원본 메타데이터로 보관합니다.','warning',entry,true);continue;}if(size<0||size>MAX_FILE_BYTES){this.notice('ATTACHMENT_FILE_LIMIT','현재 첨부 파일은20MiB 이하여야 합니다. 해당 버전을 제외하거나 패키지를 검토해 주세요.','error',entry);continue;}
        if(metadata.sha256&&string(metadata.sha256)!==sha)this.notice('ATTACHMENT_HASH_MISMATCH','원본 분석 메타데이터와 검증한 파일 해시가 다릅니다.','error',entry);
        let filename=entry.row.title||string(metadata.filename||metadata.fileName);try{filename=safeFilename(filename);}catch{this.notice('ATTACHMENT_FILENAME_INVALID','원본 파일명이 현재 첨부 파일명 제한에 맞지 않습니다.','error',entry);continue;}
        const versionLabel=string(metadata.attachmentVersion||metadata.version)||'unknown',id=randomUUID();if(versionLabel.length>100)this.notice('ATTACHMENT_VERSION_LABEL_LIMIT','첨부 버전 이름이100자를 넘습니다.','error',entry);const value:AttachmentVersion={id,attachmentId:'',resourceType:owner.type as 'issue'|'document',resourceId:owner.id,filename,mimeType:verified?.mimeType||'application/octet-stream',size,sha256:sha,authorId:this.author(entry),createdAt:this.time(entry.row.createdAt,entry)!,versionLabel,sourceImportId:this.input.id,sourceRecordId:this.archiveIds.get(entry.key)!};available.push({entry,value});this.result.fileCopies.push({fileId:id,packageId:entry.pkg.summary.id,path,size,sha256:sha});
      }
      if(!available.length)continue;const current=available[0];if(current.entry.key!==ordered[0].key)this.notice('ATTACHMENT_LATEST_MISSING',`최신 원본 첨부 버전의 바이트가 없어 가용 버전 '${current.value.versionLabel}'을 현재 첨부로 사용합니다. 더 최신 누락 버전은 별도 원본 기록으로 유지합니다.`,'warning',ordered[0],true);
      this.result.attachments.push({id:current.value.id,resourceType:current.value.resourceType,resourceId:current.value.resourceId,filename:current.value.filename,mimeType:current.value.mimeType,size:current.value.size,sha256:current.value.sha256,authorId:current.value.authorId,createdAt:current.value.createdAt});
      for(const item of available){item.value.attachmentId=current.value.id;this.result.attachmentVersions.push(item.value);this.attachmentVersionsById.set(item.value.id,item.value);this.bindings.set(item.entry.key,{type:'attachment',id:item.value.id,projectId:owner.projectId});}
    }
    if(this.result.fileCopies.reduce((sum,file)=>sum+file.size,0)>MAX_EXPANDED_BYTES)this.notice('ATTACHMENT_TOTAL_LIMIT','한 이관의 첨부 바이트 합계는256MiB 이하여야 합니다.','error');
  }
  private isConfluenceStorageReference(entry: Entry, request: MigrationReferenceInput): boolean {
    return entry.pkg.dataset.source.product === 'confluence' && entry.row.textFormat === 'confluence-storage'
      && (request.kind === 'page' || request.kind === 'attachment') && (!request.url || request.attachmentOwner !== undefined);
  }
  private confluenceSpace(entry: Entry): string | null {
    const declared = entry.row.references.find(reference => reference.kind === 'project' && reference.relation === 'space')?.sourceId;
    const sourceSpace = declared ?? this.ownerEntry(entry)?.container;
    return sourceSpace && sourceSpace !== '__unassigned__' ? sourceSpace : null;
  }
  private originIdentity(entry: Entry): string | undefined {
    const base = this.originBases.get(entry.pkg.summary.id);
    return base && `${base.origin}${base.contextPath}`;
  }
  private inConfluenceSource(entry: Entry, candidates: Entry[]): Entry[] {
    const origin = this.originIdentity(entry);
    return candidates.filter(candidate => {
      const source = candidate.pkg.dataset.source;
      const candidateOrigin = this.originIdentity(candidate);
      return source.product === 'confluence' && source.instanceKey === entry.pkg.dataset.source.instanceKey
        && (!origin || !candidateOrigin || candidateOrigin === origin);
    });
  }
  private confluenceCandidates(entry: Entry, kind: 'page' | 'attachment', sourceId: string | undefined, title: string | undefined): Entry[] {
    if (!sourceId && !title) return [];
    const candidates = this.referenceIndex.get(JSON.stringify([kind, sourceId ? 'id' : 'title', sourceId || title])) ?? [];
    return this.inConfluenceSource(entry, candidates);
  }
  private uniqueConfluenceOrigin(candidates: Entry[]): boolean {
    return new Set(candidates.map(candidate => this.originIdentity(candidate)).filter(Boolean)).size <= 1;
  }
  private inSpace(candidate: Entry, spaceKey: string): boolean {
    const project = this.sourceEntry(candidate, 'project', candidate.container)?.row;
    return [project?.metadata.spaceKey, project?.metadata.key, project?.metadata.pkey].includes(spaceKey);
  }
  private confluencePage(entry: Entry, { sourceId, title, spaceKey }: MigrationPageIdentity): Entry | null {
    let candidates = this.confluenceCandidates(entry, 'page', sourceId, title);
    if (spaceKey || !sourceId) {
      let spaceId: string | null;
      let spaceOrigin: string | undefined;
      if (spaceKey) {
        const spaces = this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? []);
        const spaceIds = new Set(spaces.map(space => space.row.sourceId));
        if (spaceIds.size !== 1 || !this.uniqueConfluenceOrigin(spaces)) return null;
        spaceId = spaces[0].row.sourceId;
        spaceOrigin = spaces.map(space => this.originIdentity(space)).find(Boolean);
      } else spaceId = this.confluenceSpace(entry);
      if (!spaceId) return null;
      candidates = candidates.filter(candidate => {
        const origin = this.originIdentity(candidate);
        return candidate.container === spaceId && (!spaceOrigin || !origin || spaceOrigin === origin);
      });
    }
    // Excluding a document does not make another source document with the same title its target.
    if (new Set(candidates.map(candidate => candidate.row.sourceId)).size !== 1 || !this.uniqueConfluenceOrigin(candidates)) return null;
    const imported = candidates.filter(candidate => this.bindings.get(candidate.key)?.type === 'document');
    return imported.length === 1 ? imported[0] : null;
  }
  private confluenceAttachment(entry: Entry, request: MigrationReferenceInput): Entry | null {
    const { attachmentOwner, sourceId, title } = request;
    if (attachmentOwner === null) return null;
    let candidates = this.confluenceCandidates(entry, 'attachment', sourceId, title);
    let ownerId: string | undefined;
    if (attachmentOwner || !sourceId) {
      const owner = attachmentOwner ? this.confluencePage(entry, attachmentOwner) : this.ownerEntry(entry);
      if (owner?.row.kind !== 'page') return null;
      const binding = this.bindings.get(owner.key);
      if (binding?.type !== 'document') return null;
      ownerId = binding.id;
      const origin = this.originIdentity(owner);
      candidates = candidates.filter(candidate => {
        const parent = this.ownerEntry(candidate);
        const candidateOrigin = this.originIdentity(candidate);
        return parent?.row.kind === 'page' && parent.row.sourceId === owner.row.sourceId
          && (!origin || !candidateOrigin || origin === candidateOrigin);
      });
    }
    if (!this.uniqueConfluenceOrigin(candidates)) return null;
    if (!sourceId) {
      const roots = new Set(candidates.map(candidate => this.attachmentRoot(candidate)?.row.sourceId));
      if (roots.size !== 1 || roots.has(undefined)) return null;
    }
    const imported = candidates.filter(candidate => {
      const binding = this.bindings.get(candidate.key);
      if (!binding) return false;
      const version = this.attachmentVersionsById.get(binding.id);
      return version && (!ownerId || version.resourceId === ownerId) && (sourceId || version.attachmentId === version.id);
    });
    return imported.length === 1 ? imported[0] : null;
  }
  private resolvedReference(candidate: Entry): { id: string; label: string; url?: string } {
    const binding = this.bindings.get(candidate.key)!;
    if (binding.type !== 'attachment') return { id: binding.id, label: candidate.row.title };
    const version = this.attachmentVersionsById.get(binding.id);
    const inline = version && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(version.mimeType);
    return { id: binding.id, label: candidate.row.title, url: `/api/attachments/${binding.id}/content${inline ? '?inline=1' : ''}` };
  }
  resolve(entry: Entry, request: MigrationReferenceInput): { id: string; label: string; url?: string } | null {
    const scoped = this.isConfluenceStorageReference(entry, request);
    const space = scoped ? this.confluenceSpace(entry) : null;
    const owner = request.kind === 'attachment' ? this.ownerEntry(entry)?.key : null;
    const key = JSON.stringify([entry.pkg.summary.id, scoped, space, owner, request]);
    if (this.resolutionCache.has(key)) return this.resolutionCache.get(key)!;
    let value: { id: string; label: string; url?: string } | null;
    if (scoped) {
      const candidate = request.kind === 'page' ? this.confluencePage(entry, request) : this.confluenceAttachment(entry, request);
      value = candidate ? this.resolvedReference(candidate) : null;
    } else value = this.resolveUncached(entry, request);
    this.resolutionCache.set(key, value);
    return value;
  }
  resolveUncached(entry:Entry,request:MigrationReferenceInput):{id:string;label:string;url?:string}|null{
    let requestedId=request.sourceId||'',requestedUrl:URL|null=null;const requestedTitle=request.title||'';if(request.url){try{const url=new URL(request.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;requestedUrl=url;requestedId=requestedId||url.searchParams.get('pageId')||url.pathname.match(/\/browse\/([^/]+)$/)?.[1]||url.pathname.match(/\/pages\/(\d+)/)?.[1]||'';}catch{return null;}}
    let candidates=(this.referenceIndex.get(JSON.stringify([request.kind,requestedId?'id':'title',requestedId||requestedTitle]))||[]).filter(candidate=>!this.excluded.has(candidate.key)&&this.bindings.has(candidate.key));
    if(requestedUrl)candidates=candidates.filter(candidate=>{const base=this.originBases.get(candidate.pkg.summary.id);return base!==undefined&&isWithinMigrationOrigin(requestedUrl!,base);});
    if(requestedId)candidates=candidates.filter(candidate=>candidate.row.sourceId===requestedId||request.kind==='issue'&&candidate.row.metadata.key===requestedId);else if(requestedTitle)candidates=candidates.filter(candidate=>candidate.row.title===requestedTitle);else return null;
    if(request.spaceKey)candidates=candidates.filter(candidate=>this.inSpace(candidate,request.spaceKey!));
    if(request.kind==='attachment'&&!requestedId){const owner=this.ownerEntry(entry);candidates=candidates.filter(candidate=>this.ownerEntry(candidate)?.key===owner?.key);const currents=new Set(this.result.attachments.map(attachment=>attachment.id));candidates=candidates.filter(candidate=>currents.has(this.bindings.get(candidate.key)!.id));}
    const local=candidates.filter(candidate=>candidate.pkg.summary.id===entry.pkg.summary.id);if(local.length===1)candidates=local;return candidates.length===1?this.resolvedReference(candidates[0]):null;
  }
  converted(entry:Entry){const result=convertLegacyContent(entry.row,{resolveReference:request=>this.resolve(entry,request)});for(const diagnostic of result.diagnostics)this.notice(diagnostic.code,diagnostic.message,diagnostic.severity,entry,diagnostic.severity==='warning');return result;}
  convertDocuments():void{
    for(const entry of this.entries){if(this.excluded.has(entry.key))continue;const binding=this.bindings.get(entry.key);if(binding?.type==='issue'){const issue=this.issueById.get(binding.id)!,converted=this.converted(entry);issue.description=converted.plainText;if(issue.description.length>200000)this.notice('ISSUE_DESCRIPTION_LIMIT','일반 텍스트 설명이 현재200000자 제한을 넘습니다.','error',entry);}else if(binding?.type==='document'){const document=this.documentById.get(binding.id)!,converted=this.converted(entry);document.content=converted.content;document.plainText=converted.plainText;}}
    for(const entry of this.entries){if(this.excluded.has(entry.key)||!['issue','page'].includes(entry.row.kind))continue;const binding=this.bindings.get(entry.key);if(!binding)continue;const parentId=entry.row.parentId;if(!parentId)continue;const parent=this.sourceEntry(entry,entry.row.kind,parentId),parentBinding=parent?this.bindings.get(parent.key):undefined;if(!parentBinding||parentBinding.type!==binding.type){this.notice('PARENT_NOT_IMPORTED','원본 상위 항목이 적용 대상에 없어 현재 항목은 최상위로 배치합니다. 원래 계층은 보관합니다.','warning',entry,true);continue;}if(parentBinding.projectId!==binding.projectId){this.notice('PARENT_PROJECT_CONFLICT','부모와 자식 항목이 서로 다른 새 프로젝트로 매핑되었습니다.','error',entry);continue;}if(binding.type==='issue')this.issueById.get(binding.id)!.parentId=parentBinding.id;else this.documentById.get(binding.id)!.parentId=parentBinding.id;}
  }
  createSecondary():void{
    const revisions=new Map<string,Entry[]>();for(const entry of this.entries){if(this.excluded.has(entry.key))continue;const ownerEntry=this.ownerEntry(entry),owner=ownerEntry?this.bindings.get(ownerEntry.key):undefined;if(entry.row.kind==='revision'){if(!owner||owner.type!=='document'){this.notice('REVISION_OWNER_MISSING','원본 문서 버전의 현재 문서를 찾을 수 없습니다.','error',entry);continue;}const values=revisions.get(owner.id)||[];values.push(entry);revisions.set(owner.id,values);}else if(entry.row.kind==='comment'){if(!owner||!['issue','document'].includes(owner.type)){this.notice('COMMENT_OWNER_MISSING','댓글의 현재 업무·문서 소유자를 찾을 수 없습니다.','error',entry);continue;}const converted=this.converted(entry),body=converted.plainText;if(!body.trim()||body.length>20000)this.notice('COMMENT_BODY_LIMIT','댓글이 비어 있거나 현재20000자 제한을 넘습니다.','error',entry);if(!['plain','none'].includes(entry.row.textFormat))this.notice('COMMENT_FORMAT_PLAIN_TEXT','댓글은 일반 텍스트로 변환하며 원래 서식과 작성자·변경 시각은 원본 보관함에 유지합니다.','warning',entry,true);const id=randomUUID();this.result.comments.push({id,resourceType:owner.type as 'issue'|'document',resourceId:owner.id,authorId:this.author(entry),body,createdAt:this.time(entry.row.createdAt,entry)!});this.bindings.set(entry.key,{type:'comment',id,projectId:owner.projectId});}}
    for(const document of this.result.documents){const current=this.primaryById.get(document.id)!,entries=(revisions.get(document.id)||[]).sort((a,b)=>Number(a.row.metadata.version||0)-Number(b.row.metadata.version||0)||string(a.row.createdAt).localeCompare(string(b.row.createdAt))||a.key.localeCompare(b.key));let highest=0;
      for(const entry of entries){let version=Number(entry.row.metadata.version);if(!Number.isSafeInteger(version)||version<1||version>1000000000||version<=highest){version=highest+1;this.notice('REVISION_VERSION_RENUMBERED','원본 버전 번호가 없거나 중복되어 현재 이력에는 순서를 부여했습니다. 원래 번호는 보관합니다.','warning',entry,true);}highest=version;const id=randomUUID(),converted=this.converted(entry);this.result.revisions.push({id,documentId:document.id,version,title:entry.row.title||document.title,content:converted.content,plainText:converted.plainText,authorId:this.author(entry),createdAt:this.time(entry.row.updatedAt||entry.row.createdAt,entry)!,summary:string(entry.row.metadata.versionComment)||`원본 버전 ${string(entry.row.metadata.version)||version}`});this.bindings.set(entry.key,{type:'revision',id,projectId:document.projectId});}
      const sourceVersion=Number(current.row.metadata.version);document.version=Number.isSafeInteger(sourceVersion)&&sourceVersion>highest&&sourceVersion<=1000000000?sourceVersion:highest+1;this.result.revisions.push({id:randomUUID(),documentId:document.id,version:document.version,title:document.title,content:document.content,plainText:document.plainText,authorId:document.authorId,createdAt:document.updatedAt,summary:'원본 현재 문서 이관'});
    }
  }
  createRelations():void{
    const resourcePairs=new Set<string>(),issuePairs=new Set<string>();
    const resource=(issueId:string,documentId:string)=>{const key=JSON.stringify([issueId,documentId]);if(resourcePairs.has(key))return;resourcePairs.add(key);this.result.resourceLinks.push({id:randomUUID(),issueId,documentId,kind:'related'});};
    for(const document of this.result.documents)for(const reference of contentReferences(document.content))if(reference.type==='issue')resource(reference.id,document.id);
    for(const entry of this.entries){if(this.excluded.has(entry.key))continue;const binding=this.bindings.get(entry.key);if(binding?.type==='document')for(const reference of entry.row.references.filter(reference=>reference.kind==='issue')){const target=this.resolve(entry,{kind:'issue',sourceId:reference.sourceId});if(target)resource(target.id,binding.id);}
      if(entry.row.kind!=='relation')continue;const issueRefs=entry.row.references.filter(reference=>reference.kind==='issue'),pageRefs=entry.row.references.filter(reference=>reference.kind==='page'),issueTargets=issueRefs.map(reference=>this.resolve(entry,{kind:'issue',sourceId:reference.sourceId}));
      if(issueRefs.length>=2){if(issueTargets.some(target=>!target)){this.notice('ISSUE_RELATION_UNRESOLVED','업무 연결의 일부 대상이 적용 대상에 없습니다. 원본 연결은 보관합니다.','warning',entry,true);continue;}const type=entry.row.title||string(entry.row.metadata.name||entry.row.metadata.relationship)||'related';if(type.length>120)this.notice('ISSUE_RELATION_TYPE_LIMIT','원본 연결 이름이 현재120자 제한을 넘습니다.','error',entry);const[source,target]=issueTargets as {id:string;label:string}[],key=JSON.stringify([source.id,target.id,type]);if(source.id===target.id)this.notice('ISSUE_RELATION_SELF','자기 자신을 가리키는 업무 연결은 현재 연결 모델에 적용할 수 없습니다.','error',entry);else if(!issuePairs.has(key)){issuePairs.add(key);this.result.issueRelations.push({id:randomUUID(),sourceIssueId:source.id,targetIssueId:target.id,type,version:1,createdAt:this.time(entry.row.createdAt,entry,false)||this.input.now});}}
      if(issueRefs.length&&pageRefs.length){for(const issue of issueTargets)for(const page of pageRefs){const target=this.resolve(entry,{kind:'page',sourceId:page.sourceId,url:string(entry.row.metadata.url)||undefined});if(issue&&target)resource(issue.id,target.id);else this.notice('DOCUMENT_ISSUE_LINK_UNRESOLVED','업무·문서 연결의 원본 ID/주소를 유일하게 확인하지 못해 임의 연결하지 않았습니다.','warning',entry,true);}}
    }
    if(this.result.issueRelations.length)this.notice('ISSUE_RELATIONS_PRESERVED','원본 업무 연결은 별도 관계로 보존합니다. blocks/relates 같은 연결을 일정 FS 종속성으로 바꾸지 않습니다.','info');
  }
  validateGraph():void{
    const cyclic=(rows:{id:string;parentId:string|null}[])=>{const incoming=new Map(rows.map(row=>[row.id,0])),children=new Map<string,string[]>();for(const row of rows)if(row.parentId){incoming.set(row.id,(incoming.get(row.id)||0)+1);const values=children.get(row.parentId)||[];values.push(row.id);children.set(row.parentId,values);}const queue=[...incoming].filter(([,count])=>!count).map(([id])=>id);for(let cursor=0;cursor<queue.length;cursor++)for(const child of children.get(queue[cursor])||[]){const count=incoming.get(child)!-1;incoming.set(child,count);if(!count)queue.push(child);}return queue.length!==rows.length;};
    if(cyclic(this.result.issues))this.notice('ISSUE_PARENT_CYCLE','이관할 업무 계층에 순환 관계가 있습니다.','error');if(cyclic(this.result.documents))this.notice('DOCUMENT_PARENT_CYCLE','이관할 문서 계층에 순환 관계가 있습니다.','error');
    const issueIds=new Set(this.result.issues.map(issue=>issue.id)),documentIds=new Set(this.result.documents.map(document=>document.id)),incoming=new Map([...documentIds].map(id=>[id,0])),edges=new Map<string,string[]>();for(const document of this.result.documents){const targets:string[]=[];for(const reference of contentReferences(document.content)){if(!(reference.type==='issue'?issueIds:documentIds).has(reference.id))this.notice('CONTENT_REFERENCE_MISSING','변환한 본문의 참조 대상이 적용 계획에 없습니다.','error');if(reference.kind==='include'){targets.push(reference.id);incoming.set(reference.id,(incoming.get(reference.id)||0)+1);}}edges.set(document.id,targets);}const queue=[...incoming].filter(([,count])=>!count).map(([id])=>id);for(let cursor=0;cursor<queue.length;cursor++)for(const target of edges.get(queue[cursor])||[]){const count=incoming.get(target)!-1;incoming.set(target,count);if(!count)queue.push(target);}if(queue.length!==incoming.size)this.notice('DOCUMENT_INCLUDE_CYCLE','이관할 문서 포함 관계에 순환이 있습니다. 원본을 제외하거나 매핑을 검토해 주세요.','error');
    for(const schema of this.result.issueSchemas)for(const field of schema.fields)if((field.kind==='select'||field.kind==='multi_select')&&(!field.options.some(option=>!option.archived)||field.options.length>200||field.options.some(option=>!option.name.trim()||option.name.length>120)||new Set(field.options.map(option=>option.name)).size!==field.options.length))this.notice('FIELD_OPTIONS_INVALID',`선택형 필드 '${field.name}'의 활성 선택지·이름·개수 제한을 확인해 주세요.`,'error');
  }
  createWorklogs():void {
    const included = new Set<string>();
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product!=='jira'||!isJiraWorklog(entry.row)||this.excluded.has(entry.key)) continue;
      const owner = this.ownerEntry(entry);
      const binding = owner ? this.bindings.get(owner.key) : undefined;
      const issue = binding?.type==='issue' ? this.issueById.get(binding.id) : undefined;
      if (!issue) {
        this.notice('WORKLOG_OWNER_UNRESOLVED','현재 이관 계획에서 업무를 찾을 수 없어 작업 시간을 원본에 보관합니다.','warning',entry,true);
        continue;
      }
      const authorId = this.mappedAuthor(entry);
      if (!authorId) {
        this.notice('WORKLOG_AUTHOR_UNMAPPED','작성자를 팀원에게 매핑하면 작업 시간에 반영할 수 있습니다. 현재 계획에서는 원본으로 보관합니다.','warning',entry,true);
        continue;
      }
      const parsed = parseJiraWorklog(entry.row,this.configuration.timezone);
      if ('code' in parsed) {
        this.notice(parsed.code,parsed.message,'warning',entry,true);
        continue;
      }
      const identity = JSON.stringify([entry.pkg.dataset.source.instanceKey,entry.row.sourceId]);
      if (included.has(identity)) {
        this.notice('WORKLOG_SOURCE_DUPLICATE','같은 Jira 작업 기록이 여러 원본에 들어 있습니다. 겹치는 기록을 제외해 주세요.','error',entry);
        continue;
      }
      included.add(identity);
      let note = '';
      if (entry.row.text && entry.row.text!=='null') {
        const converted = this.converted(entry);
        if (converted.plainText.trim().length<=2000) note=converted.plainText.trim();
        else this.notice('WORKLOG_NOTE_ARCHIVED','작업 메모가 2,000자를 초과합니다. 작업 시간은 적용하고 전체 메모는 원본에 보관합니다.','warning',entry,true);
      }
      this.result.worklogs.push({
        id:randomUUID(),issueId:issue.id,projectId:issue.projectId,issueKey:issue.key,issueTitle:issue.title,
        authorId,workDate:parsed.workDate,minutes:parsed.durationSeconds/60,durationSeconds:parsed.durationSeconds,
        note,version:1,createdAt:this.input.now,updatedAt:this.input.now,sourceRecordId:this.archiveIds.get(entry.key)!,
      });
    }
  }
  archive():void{
    for(const entry of this.entries){const binding=this.excluded.has(entry.key)?undefined:this.bindings.get(entry.key),ownerEntry=this.excluded.has(entry.key)?null:this.ownerEntry(entry),owner=ownerEntry?this.bindings.get(ownerEntry.key):undefined;const value:SourceRecordArchive={id:this.archiveIds.get(entry.key)||randomUUID(),sourceImportId:this.input.id,packageSha256:entry.pkg.summary.sha256,source:structuredClone(entry.pkg.dataset.source),record:structuredClone(entry.row),targetType:binding?.type||null,targetId:binding?.id||null,targetProjectId:binding?.projectId||owner?.projectId||null,ownerType:owner&&['issue','document'].includes(owner.type)?owner.type as 'issue'|'document':null,ownerId:owner&&['issue','document'].includes(owner.type)?owner.id:null};if(entry.row.kind==='project'||entry.row.kind==='identity'){value.ownerType=null;value.ownerId=null;}this.result.sourceRecords.push(value);}
  }
  finish():PreparedMigration{
    const counts={...this.result.preview.counts,sourceRecords:this.entries.length,excludedRecords:this.excluded.size,projects:this.result.projects.length,issues:this.result.issues.length,documents:this.result.documents.length,comments:this.result.comments.length,revisions:this.result.revisions.length,attachments:this.result.attachments.length,attachmentVersions:this.result.attachmentVersions.length,fileCopies:this.result.fileCopies.length,attachmentBytes:this.result.fileCopies.reduce((sum,file)=>sum+file.size,0),resourceLinks:this.result.resourceLinks.length,issueRelations:this.result.issueRelations.length};
    const atlassianLinks = this.result.atlassianLinks.length;
    Object.assign(counts, { atlassianLinks, unlinkedAtlassianRecords: this.primaryById.size - atlassianLinks });
    const sourceWorklogs = this.entries.filter(entry=>entry.pkg.dataset.source.product==='jira'&&isJiraWorklog(entry.row)).length;
    if (sourceWorklogs) Object.assign(counts,{worklogs:this.result.worklogs.length,archivedWorklogs:sourceWorklogs-this.result.worklogs.length});
    if(Object.entries(counts).filter(([key])=>['issues','documents','comments','revisions','attachmentVersions','resourceLinks','issueRelations','worklogs'].includes(key)).reduce((sum,[,value])=>sum+value,0)>MAX_RECORDS)this.notice('CANONICAL_RECORD_LIMIT','생성할 현재 객체·이력·파일 버전 합계가100000개를 넘습니다.','error');
    this.result.preview.projects=this.result.projects.map(project=>({id:project.id,key:project.key,name:project.name,issueCount:this.result.issues.filter(issue=>issue.projectId===project.id).length,documentCount:this.result.documents.filter(document=>document.projectId===project.id).length}));
    const origins = new Map(this.result.atlassianLinks.map(link => [link.targetId, link.url]));
    for (const entry of this.entries) {
      if (this.result.preview.samples.length >= 12) break;
      const binding = this.bindings.get(entry.key);
      if (binding?.type !== 'issue' && binding?.type !== 'document') continue;
      const item = binding.type === 'issue' ? this.issueById.get(binding.id)! : this.documentById.get(binding.id)!;
      const plainText = 'description' in item ? item.description : item.plainText;
      const sourceUrl = origins.get(binding.id);
      this.result.preview.samples.push({
        recordId: entry.key, targetType: binding.type, title: item.title,
        plainText: plainText.slice(0, 3000) + (plainText.length > 3000 ? '\n[미리보기 일부만 표시]' : ''),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
    }
    this.result.preview.counts=counts;this.result.sourceImport.counts=counts;this.result.sourceImport.projectIds=this.result.projects.map(project=>project.id);this.result.preview.requiredAcknowledgements=[...new Set(this.notices.filter(notice=>notice.requiresAcknowledgement).map(notice=>notice.code))];this.result.preview.canApply=!this.notices.some(notice=>notice.severity==='error');return this.result;
  }
}

/** Pure planning: IDs are allocated once and persisted by the caller with its immutable preview. */
export function buildMigrationPlan(input:MigrationPlanningInput):PreparedMigration{return new Planner(input).run();}
