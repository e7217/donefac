import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { JiraMigrationIssueField,LegacyDataset,LegacyRecord,LegacyRecordKind,LegacyReference,LegacyValue } from '../shared/types.js';
import { addRecord,diagnostic,emptyDataset,record,LegacyImportError } from './legacy-import-model.js';
import { decodeLegacyText,parseLegacyXml,type LegacyXmlNode } from './legacy-import-archive.js';
import { isJiraCommentRestrictionAttribute } from './migration-jira-history.js';

// Primary dialect references: Jira search export documentation, Importers JSON
// documentation, and Jira Server parser constants (Action/FileAttachment/ChangeGroup).
// https://confluence.atlassian.com/jirasoftware/working-with-search-results-1528533257.html
// https://confluence.atlassian.com/adminjiraserver100/importing-data-from-json-1442845835.html
// https://docs.atlassian.com/software/jira/docs/api/9.12.38/constant-values.html

type ObjectValue=Record<string,unknown>;
const obj=(value:unknown):ObjectValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};
const str=(value:unknown):string=>typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const child=(node:LegacyXmlNode,name:string)=>node.children.find(value=>value.name===name);
const children=(node:LegacyXmlNode,name:string)=>node.children.filter(value=>value.name===name);
const text=(node:LegacyXmlNode|undefined):string=>node?node.text+node.children.map(value=>text(value)).join(''):'';
const ref=(kind:LegacyRecordKind,sourceId:unknown,relation:string):LegacyReference[]=>str(sourceId)?[{kind,sourceId:str(sourceId),relation}]:[];
const selected=(value:ObjectValue,names:string[]):Record<string,LegacyValue>=>Object.fromEntries(names.filter(name=>value[name]!==undefined).map(name=>[name,str(value[name])]));
function jsonValue(value:unknown,depth=0):LegacyValue{if(depth>30)return'[nested value omitted]';if(value===null||typeof value==='string'||typeof value==='boolean')return value;if(typeof value==='number')return Number.isFinite(value)?value:null;if(Array.isArray(value))return value.map(item=>jsonValue(item,depth+1));return Object.fromEntries(Object.entries(obj(value)).filter(([key])=>!/(?:password|credential|secret|token|privatekey)/i.test(key)).map(([key,value])=>[key,jsonValue(value,depth+1)]));}

function jiraVisibilityMetadata(input: ObjectValue, syntheticId: boolean): Record<string, LegacyValue> {
  const metadata = Object.fromEntries(Object.entries(input).filter(([name]) => isJiraCommentRestrictionAttribute(name))
    .map(([name, value]) => [name, jsonValue(value)]));
  if (syntheticId) metadata.syntheticId = true;
  return metadata;
}

const csvSnapshotFields = new Map<string, JiraMigrationIssueField>([
  ['description', 'description'], ['assignee', 'assigneeId'], ['labels', 'labels'],
  ['start date', 'startDate'], ['start', 'startDate'], ['end date', 'endDate'], ['end', 'endDate'],
  ['due date', 'dueDate'], ['due', 'dueDate'], ['estimate', 'estimate'],
]);

class Context{
  dataset:LegacyDataset;byId=new Map<string,LegacyRecord>();fileNames=new Map<string,string[]>();
  constructor(readonly files:Map<string,Buffer>,instanceKey:string,format:LegacyDataset['source']['format']){this.dataset=emptyDataset({product:'jira',format,instanceKey,declaredVersion:null,timezone:null});for(const path of files.keys()){const name=posix.basename(path),values=this.fileNames.get(name)||[];values.push(path);this.fileNames.set(name,values);}}
  put(kind:LegacyRecordKind,id:unknown,value:Partial<LegacyRecord>={}):LegacyRecord{const sourceId=str(id);if(!sourceId)throw new LegacyImportError(400,'Jira 원본 식별자가 없습니다.');const result=record(kind,sourceId,value);addRecord(this.dataset,result);this.byId.set(result.id,result);return result;}
  ensure(kind:LegacyRecordKind,id:unknown,value:Partial<LegacyRecord>={}):LegacyRecord|undefined{const sourceId=str(id);if(!sourceId)return undefined;return this.byId.get(`${kind}:${sourceId}`)||this.put(kind,sourceId,value);}
  warn(code:string,message:string,recordId:string|null=null,path:string|null=null,severity:'info'|'warning'|'error'='warning'){diagnostic(this.dataset,{severity,code,message,recordId,path});}
  unsupported(type:string,count=1){const existing=this.dataset.unsupported.find(value=>value.type===type);if(existing)existing.count+=count;else this.dataset.unsupported.push({type,count});}
  identity(value:unknown):string|null{if(typeof value==='string'){if(value)this.ensure('identity',value,{title:value,metadata:{identityIncomplete:true}});return value||null;}const input=obj(value),id=str(input.accountId||input.key||input.name||input.username||input.id);if(!id)return null;const profileName=str(input.displayName||input.fullname||input.name||input.username),profile=selected(input,['accountId','key','name','username','emailAddress','email','active']),existing=this.byId.get(`identity:${id}`);if(existing){if(profileName&&existing.metadata.identityIncomplete){existing.title=profileName;existing.metadata.identityIncomplete=false;}Object.assign(existing.metadata,profile);return id;}const identity=this.ensure('identity',id,{title:profileName||id,metadata:{...profile,identityIncomplete:!profileName}})!;return identity.sourceId;}
  field(id:string,name:string,type='unknown'){return this.ensure('field',id,{title:name,metadata:{fieldType:type,...(/^(?:csv|named):/.test(id)?{syntheticId:true}:{})}})!;}
  option(fieldId:string,value:unknown):string|null{const input=obj(value),id=str(input.id)||str(input.value)||str(input.name)||str(value);if(!id)return null;const sourceId=`${fieldId}:${id}`;this.ensure('option',sourceId,{title:str(input.name||input.value)||id,containerId:fieldId,metadata:{originalId:str(input.id)||null,syntheticId:!str(input.id)},references:ref('field',fieldId,'field')});return sourceId;}
  date(value:unknown,recordId?:string):string|null{const result=str(value);if(!result)return null;if(!/(?:Z|[+-]\d\d:?\d\d|\bUTC\b|\bGMT\b)(?:\s*\([^)]*\))?$/.test(result))this.warn('DATE_TIMEZONE_UNRESOLVED','원본 시각의 시간대 또는 상대 날짜 기준을 확정하지 않았습니다.',recordId||null);return result;}
  url(value:unknown,recordId?:string):string|null{const raw=str(value);if(!raw)return null;try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol))return null;let removed=!!(url.username||url.password);url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(!['pageId','spaceKey','title','version','attachmentId','focusedCommentId'].includes(key)){url.searchParams.delete(key);removed=true;}if(removed)this.warn('URL_AUTH_PARAMETERS_OMITTED','URL 인증 정보와 허용 목록 밖의 쿼리 매개변수를 미리보기에서 제외했습니다.',recordId||null);return url.toString();}catch{return null;}}
  attachment(id: string, issueId: string, input: ObjectValue): LegacyRecord {
    const uri = str(input.content || input.uri || input.url);
    const recoveredId = uri.match(/\/(?:secure\/)?attachment\/(\d+)(?:\/|$)/)?.[1];
    if (recoveredId && /^(?:csv|json|xml):/.test(id)) id = recoveredId;
    const filename = str(input.filename || input.name) || id;
    const authorId = this.identity(input.author || input.attacher);
    const candidates = new Set<string>();
    for (const name of [id, `${id}_${filename}`]) {
      for (const path of this.fileNames.get(name) ?? []) {
        if (/(?:^|\/)attachments?\//i.test(path)) candidates.add(path);
      }
    }
    if (uri && !/^https?:/i.test(uri)) {
      const path = uri.replace(/^file:\/\//, '').replace(/^\/+/, '');
      if (this.files.has(path)) candidates.add(path);
    }
    const path = candidates.size === 1 ? [...candidates][0] : null;
    const bytes = path ? this.files.get(path)! : null;
    const item = this.put('attachment', id, {
      title: filename, containerId: issueId, authorId, createdAt: this.date(input.created, `attachment:${id}`),
      metadata: { ...jiraVisibilityMetadata(input, /^(?:csv|json|xml):/.test(id)), filename,
        size: typeof input.size === 'number' ? input.size : str(input.filesize || input.size) || null,
        mimeType: str(input.mimeType || input.mimetype) || null, version: str(input.version) || null,
        originalUrl: this.url(uri, `attachment:${id}`), path, bytesPresent: Boolean(bytes), actualSize: bytes?.length ?? null,
        sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
      },
      references: [...ref('issue', issueId, 'attachedTo'), ...ref('identity', authorId, 'author')],
    });
    if (!bytes) this.warn(candidates.size > 1 ? 'ATTACHMENT_PATH_AMBIGUOUS' : 'ATTACHMENT_BYTES_MISSING', candidates.size > 1
      ? '첨부 ID에 대응하는 파일이 여러 개여서 선택하지 않았습니다.' : '첨부 메타데이터는 보존했지만 패키지 안의 파일 바이트를 찾지 못했습니다.', item.id);
    return item;
  }
  finish():LegacyDataset{const issueKeys=new Map(this.dataset.records.filter(item=>item.kind==='issue'&&item.metadata.key).map(item=>[str(item.metadata.key),item.sourceId]));const validated=emptyDataset(this.dataset.source);for(const item of this.dataset.records){for(const reference of item.references)if(reference.kind==='issue')reference.sourceId=issueKeys.get(reference.sourceId)||reference.sourceId;item.references=[...new Map(item.references.map(reference=>[JSON.stringify(reference),reference])).values()];if(item.kind==='issue'&&item.parentId)item.parentId=issueKeys.get(item.parentId)||item.parentId;addRecord(validated,item);}this.dataset.records=validated.records;this.warn('PREVIEW_ONLY','이 패키지는 분석·보존 가능성 미리보기이며 Teamspace 업무로 적용하지 않았습니다.',null,null,'info');return this.dataset;}
}

function csvRows(source:string,delimiter:string):string[][]{
  const rows:string[][]=[];let row:string[]=[],cell='',state:'start'|'unquoted'|'quoted'|'after-quote'='start';
  for(let index=0;index<source.length;index++){
    const character=source[index];
    if(state==='quoted'){
      if(character==='"'&&source[index+1]==='"'){cell+='"';index++;}
      else if(character==='"')state='after-quote';
      else cell+=character;
      continue;
    }
    if(character===delimiter){row.push(cell);cell='';state='start';}
    else if(character==='\n'||character==='\r'){if(character==='\r'&&source[index+1]==='\n')index++;row.push(cell);rows.push(row);row=[];cell='';state='start';}
    else if(state==='after-quote')throw new LegacyImportError(400,'CSV 닫는 따옴표 뒤에는 구분자 또는 줄바꿈만 올 수 있습니다.');
    else if(character==='"'){if(state!=='start')throw new LegacyImportError(400,'CSV 미인용 필드 안에 따옴표가 있습니다.');state='quoted';}
    else{cell+=character;state='unquoted';}
  }
  if(state==='quoted')throw new LegacyImportError(400,'CSV 따옴표가 닫히지 않았습니다.');
  if(state!=='start'||cell||row.length){row.push(cell);rows.push(row);}return rows;
}
function parseCsv(context:Context,path:string,source:string):void{
  const first=source.split(/\r?\n/,1)[0],delimiter=['\t',';',','].sort((a,b)=>first.split(b).length-first.split(a).length)[0],rows=csvRows(source.replace(/^\uFEFF/,''),delimiter),headers=rows.shift()?.map(value=>value.trim())||[];if(!headers.some(header=>/^(?:Issue key|Issue id|Key)$/i.test(header))){context.warn('CSV_ISSUE_IDENTIFIER_MISSING','Jira CSV의 Issue key/Issue id 열을 찾지 못했습니다.',null,path,'error');return;}
  const customHeaders = [...new Set(headers.filter(name => /^Custom field\s*\(/i.test(name)))];
  const customFieldIds = customHeaders.map(name => `csv:${name}`);
  for (const name of customHeaders) context.field(`csv:${name}`, name, 'csv-unspecified');
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++){const row=rows[rowIndex];if(row.every(value=>!value))continue;if(row.length!==headers.length)context.warn('CSV_COLUMN_COUNT_MISMATCH','CSV 행의 열 개수가 헤더와 다릅니다.',null,`${path}:${rowIndex+2}`,'error');const get=(...names:string[])=>row[headers.findIndex(header=>names.some(name=>header.toLowerCase()===name.toLowerCase()))]||'',key=get('Issue key','Key'),id=get('Issue id')||key||`csv:${path}:${rowIndex+2}`,projectId=get('Project id','Project key')||key.replace(/-\d+$/,'');if(projectId)context.ensure('project',projectId,{title:get('Project name')||get('Project key')||projectId,metadata:{key:get('Project key')||key.replace(/-\d+$/,'')}});const authorId=context.identity(get('Creator','Reporter')),assignee=context.identity(get('Assignee')),parent=get('Parent id','Parent');const metadata:Record<string,LegacyValue>={key,dialect:'search-csv',fields:{},jiraSnapshotFields:[...new Set(headers.map(header=>csvSnapshotFields.get(header.toLowerCase())).filter(field=>field!==undefined))]};const item=context.put('issue',id,{title:get('Summary'),containerId:projectId||null,parentId:parent||null,authorId,createdAt:context.date(get('Created'),`issue:${id}`),updatedAt:context.date(get('Updated'),`issue:${id}`),text:get('Description'),textFormat:'jira-wiki',metadata,references:[...ref('project',projectId,'project'),...ref('identity',authorId,'reporter'),...ref('identity',assignee,'assignee'),...ref('issue',parent,'parent')]});const fields=item.metadata.fields as Record<string,LegacyValue>;
    if (row.length === headers.length && customFieldIds.length) item.metadata.jiraSnapshotCustomFields = customFieldIds;
    for(let column=0;column<headers.length;column++){const name=headers[column],value=row[column]||'';if(!value)continue;if(/^Comment$/i.test(name)){const parts=value.split(';'),structured=parts.length>=3;const commentId=`csv:${id}:comment:${column}`,actor=structured?context.identity(parts[1]):null;context.put('comment',commentId,{title:'댓글',containerId:id,authorId:actor,createdAt:structured?context.date(parts[0],`comment:${commentId}`):null,text:structured?parts.slice(2).join(';'):value,textFormat:'jira-wiki',metadata:{sourceColumn:column,structured,syntheticId:true},references:[...ref('issue',id,'commentOn'),...ref('identity',actor,'author')]});if(!structured)context.warn('CSV_COMMENT_ATTRIBUTION_UNRESOLVED','댓글 원문은 보존했지만 작성자·시각 구분 형식을 확인하지 못했습니다.',item.id);}
      else if(/^Attachment$/i.test(name)){const parts=value.split(';'),uri=parts.at(-1)||'',filename=parts.length>=4?parts.slice(2,-1).join(';'):uri.split('/').at(-1)||value;context.attachment(`csv:${id}:attachment:${column}`,id,{name:filename,uri,attacher:parts.length>=4?parts[1]:'',created:parts.length>=4?parts[0]:''});}
      else{const previous=Object.hasOwn(fields,name)?fields[name]:undefined;Object.defineProperty(fields,name,{value:previous===undefined?value:Array.isArray(previous)?[...previous,value]:[previous,value],enumerable:true,writable:true,configurable:true});if(/^(?:Status|Priority|Issue Type|Resolution|Component\/s|Fix Version\/s|Affects Version\/s)$/i.test(name)){const fieldId=`csv:${name}`;context.field(fieldId,name,'csv-label-only');const optionId=context.option(fieldId,value);item.references.push(...ref('option',optionId,name));}}
    }
  }
  context.warn('CSV_HISTORY_NOT_PROVIDED','검색 CSV는 완전한 변경 이력이나 첨부 바이트를 보장하지 않습니다. 실제 제공된 댓글·첨부 열만 분석했습니다.',null,path);
}

function jiraCustomUser(context: Context, value: unknown, fieldType: string): string | null {
  const profile = obj(value);
  const stableId = typeof profile.accountId === 'string' && profile.accountId.trim();
  const legacyId = [profile.key, profile.name, profile.username].some(id => typeof id === 'string' && id.trim());
  const legacyProfile = [profile.displayName, profile.emailAddress].some(label => typeof label === 'string' && label.trim());
  const typedUser = /(^|:)user(?:picker)?$/i.test(fieldType);
  return stableId || legacyId && (legacyProfile || typedUser) ? context.identity(profile) : null;
}

function issueJson(context:Context,input:ObjectValue,projectId:string,path:string,index:number,importers:boolean):void{
  const fields=importers?input:obj(input.fields),id=str(input.id||input.externalId||input.key)||`json:${path}:${index}`,key=str(input.key),project=obj(fields.project),containerId=str(project.id||project.key)||projectId;
  if(containerId)context.ensure('project',containerId,{title:str(project.name)||containerId,metadata:{key:str(project.key)||projectId}});
  const authorId=context.identity(fields.creator||fields.reporter),assignee=context.identity(fields.assignee),parent=obj(fields.parent),parentId=str(parent.id||parent.key)||str(fields.parent),description=fields.description;
  const jiraSnapshotFields: JiraMigrationIssueField[] = [];
  if (description === null || typeof description === 'string' || Object.hasOwn(obj(description), 'type')) jiraSnapshotFields.push('description');
  if (fields.assignee === null || fields.assignee === '' || assignee) jiraSnapshotFields.push('assigneeId');
  const item=context.put('issue',id,{title:str(fields.summary),containerId:containerId||null,parentId:parentId||null,authorId,createdAt:context.date(fields.created,`issue:${id}`),updatedAt:context.date(fields.updated,`issue:${id}`),text:typeof description==='object'&&description!==null?JSON.stringify(description):str(description),textFormat:typeof description==='object'&&description!==null?'adf':'jira-wiki',metadata:{key,dialect:importers?'importers-json':'rest-json',...selected(fields,['resolutiondate','duedate','environment','originalEstimate','timeSpent','estimate']),jiraSnapshotFields,fields:{}},references:[...ref('project',containerId,'project'),...ref('identity',authorId,'creatorOrReporter'),...ref('identity',assignee,'assignee'),...ref('issue',parentId,'parent')]});
  const values=item.metadata.fields as Record<string,LegacyValue>;
  const scheduleValues = ['startDate', 'endDate', 'dueDate', 'duedate', 'estimate'];
  const jiraScheduleFields = Object.fromEntries(scheduleValues.filter(name=>Object.hasOwn(fields,name) &&
    (fields[name] === null || typeof fields[name] === 'string' || typeof fields[name] === 'number')).map(name=>[name,jsonValue(fields[name])]));
  if (Object.keys(jiraScheduleFields).length) item.metadata.jiraScheduleFields = jiraScheduleFields;
  if(fields.security!==undefined&&fields.security!==null){const security=obj(fields.security);values.security=typeof fields.security==='boolean'?fields.security:typeof fields.security==='object'?{...selected(security,['id','name']),present:true}:str(fields.security)?{name:str(fields.security),present:true}:null;}
  for(const name of ['status','issuetype','issueType','priority','resolution','labels','components','fixVersions','fixedVersions','versions','affectedVersions','sprint','watches'])if(fields[name]!==undefined){values[name]=jsonValue(fields[name]);if(['status','issuetype','issueType','priority','resolution'].includes(name)){const fieldId=`builtin:${name==='issueType'?'issuetype':name}`;context.field(fieldId,name,'jira-builtin');const optionId=context.option(fieldId,fields[name]);item.references.push(...ref('option',optionId,name));}}
  for (const [name, value] of Object.entries(fields)) {
    if (!/^customfield_\d+$/.test(name)) continue;
    values[name] = jsonValue(value);
    const field = context.field(name, name, 'rest-custom-unspecified');
    item.references.push(...ref('field', name, 'customField'));
    for (const option of Array.isArray(value) ? value : [value]) {
      const identity = jiraCustomUser(context, option, str(field.metadata.fieldType));
      if (identity) item.references.push(...ref('identity', identity, 'customFieldUser'));
      else if (Object.hasOwn(obj(option), 'value')) item.references.push(...ref('option', context.option(name, option), 'customOption'));
    }
  }
  for (const raw of list(fields.customFieldValues)) {
    const custom = obj(raw), fieldId = str(custom.fieldId || custom.id) || `named:${str(custom.fieldName)}`;
    const field = context.field(fieldId, str(custom.fieldName) || fieldId, str(custom.fieldType));
    item.references.push(...ref('field', fieldId, 'customField'));
    if (!Object.hasOwn(custom, 'value')) continue;
    const value = custom.value;
    values[fieldId] = jsonValue(value);
    for (const profile of Array.isArray(value) ? value : [value]) {
      item.references.push(...ref('identity', jiraCustomUser(context, profile, str(field.metadata.fieldType)), 'customFieldUser'));
    }
  }
  const commentEnvelope=obj(fields.comment),comments=importers?list(fields.comments):list(commentEnvelope.comments);
  if(Number(commentEnvelope.total)>comments.length||Number(commentEnvelope.startAt)>0)context.warn('COMMENTS_PARTIAL','REST 댓글 페이지 일부만 제공되었습니다.',item.id,path);
  for(let commentIndex=0;commentIndex<comments.length;commentIndex++){const comment=obj(comments[commentIndex]),sourceId=str(comment.id),commentId=sourceId||`json:${id}:comment:${commentIndex}`,author=context.identity(comment.author),body=comment.body;context.put('comment',commentId,{title:'댓글',containerId:id,authorId:author,createdAt:context.date(comment.created,`comment:${commentId}`),updatedAt:context.date(comment.updated,`comment:${commentId}`),text:typeof body==='object'&&body!==null?JSON.stringify(body):str(body),textFormat:typeof body==='object'&&body!==null?'adf':'jira-wiki',metadata:jiraVisibilityMetadata(comment,!sourceId),references:[...ref('issue',id,'commentOn'),...ref('identity',author,'author')]});}
  for(let attachmentIndex=0;attachmentIndex<list(fields.attachments||fields.attachment).length;attachmentIndex++){const attachment=obj(list(fields.attachments||fields.attachment)[attachmentIndex]);context.attachment(str(attachment.id)||`json:${id}:attachment:${attachmentIndex}`,id,attachment);}
  const changelog=obj(input.changelog),history=importers?list(fields.history):list(changelog.histories||changelog.values);
  if(Number(changelog.total)>history.length||Number(changelog.startAt)>0)context.warn('HISTORY_PARTIAL','REST 변경 이력 페이지 일부만 제공되었습니다.',item.id,path);
  if(!importers&&!input.changelog)context.warn('HISTORY_NOT_PROVIDED','REST 문서에 changelog가 없습니다. 변경 이력 보존을 확정할 수 없습니다.',item.id,path);
  for(let historyIndex=0;historyIndex<history.length;historyIndex++){const group=obj(history[historyIndex]),groupId=str(group.id)||`json:${id}:history:${historyIndex}`,author=context.identity(group.author);context.put('history',groupId,{title:'변경 이력',containerId:id,authorId:author,createdAt:context.date(group.created,`history:${groupId}`),metadata:{items:list(group.items).map(raw=>selected(obj(raw),['field','fieldId','fieldtype','fieldType','from','fromString','to','toString']))},references:[...ref('issue',id,'historyOf'),...ref('identity',author,'author')]});}
  const worklogEnvelope=obj(fields.worklog),worklogs=importers?list(fields.worklogs):list(worklogEnvelope.worklogs);if(Number(worklogEnvelope.total)>worklogs.length||Number(worklogEnvelope.startAt)>0)context.warn('WORKLOGS_PARTIAL','REST 작업 시간 기록 페이지 일부만 제공되었습니다.',item.id,path);
  for(let index=0;index<worklogs.length;index++){
    const worklog=obj(worklogs[index]),sourceId=str(worklog.id),worklogId=`worklog:${sourceId||`${id}:${index}`}`,author=context.identity(worklog.author);
    context.put('history',worklogId,{title:'작업 시간 기록',containerId:id,authorId:author,createdAt:context.date(worklog.created||worklog.startDate||worklog.started||worklog.startdate),updatedAt:context.date(worklog.updated),text:typeof worklog.comment==='object'?JSON.stringify(worklog.comment):str(worklog.comment),textFormat:typeof worklog.comment==='object'?'adf':'plain',metadata:{
      kind:'worklog',...(!sourceId?{syntheticId:true}:{}),...selected(worklog,['started','startDate','startdate','timeSpent','timeSpentSeconds','timeworked']),
      ...Object.fromEntries(['role','roleId','roleKey','rolelevel','roleLevel','group','groupId','groupKey','groupName','grouplevel','groupLevel','restriction','restrictions','restricted','isRestricted','hasRestrictions','restrictionType','restrictionValue','viewRole','viewRoleLevel','viewGroup','viewGroupLevel','permissions'].filter(name=>Object.hasOwn(worklog,name)).map(name=>[name,jsonValue(worklog[name])])),
      visibility:jsonValue(worklog.visibility??null),
    },references:[...ref('issue',id,'worklogOf'),...ref('identity',author,'author')]});
  }
  for(let linkIndex=0;linkIndex<list(fields.issuelinks).length;linkIndex++){const link=obj(list(fields.issuelinks)[linkIndex]),inward=obj(link.inwardIssue),outward=obj(link.outwardIssue),type=obj(link.type),other=str(inward.id||inward.key||outward.id||outward.key),linkId=str(link.id)||`json:${id}:link:${linkIndex}`;context.ensure('relation',linkId,{title:str(type.name)||'업무 연결',containerId:id,metadata:{direction:link.inwardIssue?'inward':'outward',...selected(type,['id','name','inward','outward'])},references:[...ref('issue',id,'source'),...ref('issue',other,'target')]});}
  const known=new Set(['project','summary','description','creator','reporter','assignee','parent','created','updated','resolutiondate','duedate','dueDate','startDate','endDate','environment','originalEstimate','timeSpent','estimate','status','issuetype','issueType','priority','resolution','security','labels','components','fixVersions','fixedVersions','versions','affectedVersions','sprint','watches','customFieldValues','comment','comments','attachment','attachments','history','issuelinks','worklog','worklogs','externalId','id','key']);
  for(const name of Object.keys(fields))if(!known.has(name)&&!/^customfield_\d+$/.test(name))context.unsupported(`json-field:${name}`);
}
function parseJson(context:Context,path:string,source:string):void{
  let input:unknown;try{input=JSON.parse(source);}catch{throw new LegacyImportError(400,'Jira JSON 형식이 올바르지 않습니다.');}const root=obj(input);
  if(Array.isArray(root.projects)){
    context.warn('JSON_IMPORTERS_DIALECT','Jira Importers 입력 JSON을 분석했습니다. Jira 전체 내보내기와 동일한 형식은 아닙니다.',null,path,'info');
    for(const user of list(root.users))context.identity(user);
    for(const raw of root.projects){const project=obj(raw),id=str(project.id||project.key||project.name);if(!id){context.warn('PROJECT_ID_MISSING','JSON 프로젝트에 원본 식별자가 없습니다.',null,path,'error');continue;}context.ensure('project',id,{title:str(project.name)||id,text:str(project.description),textFormat:'plain',metadata:selected(project,['key','type'])});for(const kind of ['versions','components'])for(const rawOption of list(project[kind])){const option=typeof rawOption==='string'?{name:rawOption}:obj(rawOption);context.field(`builtin:${kind}`,kind,'jira-builtin');context.option(`builtin:${kind}`,option);}const issues=list(project.issues||project['work items']);for(let index=0;index<issues.length;index++)issueJson(context,obj(issues[index]),id,path,index,true);}
    for(let index=0;index<list(root.links).length;index++){const link=obj(list(root.links)[index]),id=str(link.id)||`json:relation:${path}:${index}`;context.put('relation',id,{title:str(link.name)||'업무 연결',metadata:{name:str(link.name)},references:[...ref('issue',link.sourceId,'source'),...ref('issue',link.destinationId,'target')]});}
  }else if(Array.isArray(root.issues)){
    context.warn('JSON_REST_DIALECT','Jira REST 검색 응답 JSON을 분석했습니다. 별도 페이지·첨부 바이트는 자동 조회하지 않습니다.',null,path,'info');
    if(Number(root.startAt)>0||Number(root.total)>root.issues.length)context.warn('ISSUES_PARTIAL','검색 응답의 일부 페이지입니다. 전체 이슈 개수와 파일 묶음을 대조해야 합니다.',null,path);
    const names=obj(root.names),schemas=obj(root.schema);for(const[name,title]of Object.entries(names)){if(/^customfield_\d+$/.test(name))context.field(name,str(title)||name,str(obj(schemas[name]).custom||obj(schemas[name]).type)||'unknown');}
    for(let index=0;index<root.issues.length;index++)issueJson(context,obj(root.issues[index]),'',path,index,false);
  }else if(root.fields&&(root.id||root.key)){context.warn('JSON_REST_DIALECT','단일 Jira REST 이슈 JSON을 분석했습니다.',null,path,'info');issueJson(context,root,'',path,0,false);}
  else{context.warn('JSON_DIALECT_UNSUPPORTED','지원하는 Jira REST 검색/단일 이슈 또는 Importers JSON 구조가 아닙니다.',null,path,'error');context.unsupported('json:unrecognized-root');}
}

function parseSearchXml(context:Context,root:LegacyXmlNode,path:string):void{
  const channel=child(root,'channel');if(!channel){context.warn('XML_SEARCH_CHANNEL_MISSING','검색 XML의 channel이 없습니다.',null,path,'error');return;}const items=children(channel,'item'),range=child(channel,'issue');if(range&&(Number(range.attributes.total)>items.length||Number(range.attributes.start)>0))context.warn('ISSUES_PARTIAL','검색 XML은 일부 검색 결과만 포함합니다.',null,path);
  for(let index=0;index<items.length;index++){
    const node=items[index],get=(name:string)=>text(child(node,name)),keyNode=child(node,'key'),key=text(keyNode),id=keyNode?.attributes.id||key||`xml:${path}:${index}`,project=child(node,'project'),projectId=project?.attributes.id||project?.attributes.key||key.replace(/-\d+$/,'');context.ensure('project',projectId,{title:text(project)||projectId,metadata:{key:project?.attributes.key||key.replace(/-\d+$/,'')}});
    const reporter=child(node,'reporter'),assignee=child(node,'assignee'),authorId=context.identity(reporter?.attributes.username||reporter?.attributes.accountid||text(reporter)),assigneeId=context.identity(assignee?.attributes.username||assignee?.attributes.accountid||text(assignee)),parentNode=child(node,'parent'),parentId=parentNode?.attributes.id||text(parentNode),fields:Record<string,LegacyValue>={};
    const jiraSnapshotFields: JiraMigrationIssueField[] = [];
    if (child(node,'description')) jiraSnapshotFields.push('description');
    if (assignee && (assigneeId || !text(assignee))) jiraSnapshotFields.push('assigneeId');
    const item=context.put('issue',id,{title:get('summary')||get('title'),containerId:projectId||null,parentId:parentId||null,authorId,createdAt:context.date(get('created'),`issue:${id}`),updatedAt:context.date(get('updated'),`issue:${id}`),text:get('description'),textFormat:'plain',metadata:{key,dialect:'rss-search-xml',descriptionFormat:'search-rendered-html',originalUrl:context.url(get('link')),jiraSnapshotFields,fields},references:[...ref('project',projectId,'project'),...ref('identity',authorId,'reporter'),...ref('identity',assigneeId,'assignee'),...ref('issue',parentId,'parent')]});
    for(const name of ['type','status','priority','resolution','security','due','resolved','environment','version','fixVersion','component','labels']){const matches=children(node,name);if(!matches.length)continue;const normalized=name==='type'?'issuetype':name,fieldId=`builtin:${normalized}`;fields[normalized]=matches.map(value=>({id:value.attributes.id||null,text:text(value)}));if(['type','status','priority','resolution'].includes(name)){context.field(fieldId,normalized,'jira-builtin');for(const value of matches){const option=context.option(fieldId,{id:value.attributes.id||text(value),name:text(value)});item.references.push(...ref('option',option,normalized));}}}
    const labelElements = children(node,'labels');
    if (labelElements.length && labelElements.every(container=>container.children.every(label=>label.name==='label') && !container.text.trim())) {
      item.metadata.jiraSnapshotLabels = labelElements.flatMap(container=>children(container,'label').map(label=>text(label)));
    }
    for(const comment of child(node,'comments')?.children||[]){if(comment.name!=='comment')continue;const sourceId=comment.attributes.id,commentId=sourceId||`xml:${id}:comment:${(child(node,'comments')?.children||[]).indexOf(comment)}`,author=context.identity(comment.attributes.author);context.put('comment',commentId,{title:'댓글',containerId:id,authorId:author,createdAt:context.date(comment.attributes.created,`comment:${commentId}`),updatedAt:context.date(comment.attributes.updated,`comment:${commentId}`),text:text(comment),textFormat:'plain',metadata:{...jiraVisibilityMetadata(comment.attributes,!sourceId),bodyFormat:'search-rendered-html'},references:[...ref('issue',id,'commentOn'),...ref('identity',author,'author')]});}
    for(const attachment of child(node,'attachments')?.children||[])if(attachment.name==='attachment')context.attachment(attachment.attributes.id||`xml:${id}:attachment:${(child(node,'attachments')?.children||[]).indexOf(attachment)}`,id,attachment.attributes);
    for(const custom of child(node,'customfields')?.children||[]){if(custom.name!=='customfield')continue;const fieldId=custom.attributes.id||`named:${text(child(custom,'customfieldname'))}`,values=(child(custom,'customfieldvalues')?.children||[]).map(value=>text(value));context.field(fieldId,text(child(custom,'customfieldname'))||fieldId,custom.attributes.key||'search-unspecified');fields[fieldId]=values;item.references.push(...ref('field',fieldId,'customField'));}
    for(const type of child(node,'issuelinks')?.children||[]){const typeId=type.attributes.id||text(child(type,'name'));for(const direction of ['inwardlinks','outwardlinks'])for(const link of child(type,direction)?.children||[]){const target=child(link,'issuekey'),targetId=target?.attributes.id||text(target);context.ensure('relation',`search:${id}:${typeId}:${direction}:${targetId}`,{title:text(child(type,'name'))||'업무 연결',containerId:id,metadata:{originalTypeId:typeId,direction,description:child(type,direction)?.attributes.description||'',syntheticId:true},references:[...ref('issue',id,'source'),...ref('issue',targetId,'target')]});}}
  }
  context.warn('SEARCH_XML_HISTORY_NOT_PROVIDED','검색 XML은 관리자 전체 백업이 아닙니다. 전체 상태 변경 이력·사용자 설정·첨부 바이트의 보존을 확정할 수 없습니다.',null,path);
}

function entityValues(node:LegacyXmlNode):ObjectValue{return{...node.attributes,...Object.fromEntries(node.children.map(value=>[value.name,text(value)]))};}
function parseBackupXml(context:Context,root:LegacyXmlNode,path:string):void{
  context.dataset.source.declaredVersion=root.attributes.version||null;
  const rows=root.children,values=rows.map(node=>({name:node.name,value:entityValues(node)})),appUsers=new Map(values.filter(row=>row.name==='ApplicationUser').map(row=>[str(row.value.lowerUserName),str(row.value.userKey)]));
  for(const{ name,value:v }of values)if(['User','OSUser','CwdUser'].includes(name)){const username=str(v.userName||v.name||v.lowerUserName),id=appUsers.get(username.toLowerCase())||str(v.userKey)||username||str(v.id);context.ensure('identity',id,{title:str(v.displayName||v.fullName)||username||id,createdAt:context.date(v.createdDate),updatedAt:context.date(v.updatedDate),metadata:{...selected(v,['id','userName','name','lowerUserName','displayName','fullName','emailAddress','email','active']),identityIncomplete:false}});}
  for(const[username,id]of appUsers)context.ensure('identity',id,{title:username||id,metadata:{key:id,name:username,identityIncomplete:true}});
  const resolveActor=(value:unknown):string|null=>{const original=str(value);return context.identity(appUsers.get(original.toLowerCase())||original);};
  for(const{name,value:v}of values){if(name==='Project')context.put('project',v.id||v.key||v.pkey,{title:str(v.name),text:str(v.description),textFormat:'plain',authorId:resolveActor(v.lead),metadata:{...selected(v,['key','pkey','projecttype','assigneetype']),url:context.url(v.url)}});
    else if(name==='CustomField')context.put('field',v.id,{title:str(v.name)||str(v.cfname),text:str(v.description),textFormat:'plain',metadata:selected(v,['customfieldtypekey','customfieldsearcherkey','fieldtype','cfname'])});
    else if(['Status','IssueType','Priority','Resolution'].includes(name)){const fieldId=`builtin:${name.toLowerCase()}`;context.field(fieldId,name,'jira-builtin');context.ensure('option',`${fieldId}:${str(v.id)}`,{title:str(v.pname||v.name)||str(v.id),containerId:fieldId,metadata:selected(v,['id','description','sequence','style']),references:ref('field',fieldId,'field')});}
    else if(name==='CustomFieldOption')context.put('option',v.id,{title:str(v.value)||str(v.customvalue)||str(v.id),containerId:str(v.customfield)||null,parentId:str(v.parentoptionid)||null,metadata:selected(v,['sequence','disabled']),references:[...ref('field',v.customfield,'field'),...ref('option',v.parentoptionid,'parent')]});
    else if(name==='Workflow'){context.put('workflow',v.id||v.name,{title:str(v.name),authorId:resolveActor(v.creatorname),createdAt:context.date(v.created),updatedAt:context.date(v.updated),metadata:{descriptorPresent:!!(v.descriptor||v.workflow)}});if(v.descriptor||v.workflow)context.warn('WORKFLOW_DESCRIPTOR_NOT_CONVERTED','워크플로 이름·작성 정보만 분석했습니다. 실행 가능한 descriptor/플러그인 설정은 복사하지 않았습니다.',`workflow:${str(v.id||v.name)}`);}
  }
  for(const{name,value:v}of values)if(name==='Issue'){
    const id=str(v.id),projectId=str(v.project),project=context.byId.get(`project:${projectId}`),key=str(v.key||v.pkey)||`${str(project?.metadata.pkey||project?.metadata.key)}-${str(v.number||v.issuenum)}`,creator=resolveActor(v.creator||v.reporter),parent=str(v.parent),fields:Record<string,LegacyValue>=selected(v,['issuetype','status','priority','resolution','assignee','reporter','creator','duedate','resolutiondate','environment','votes','watches','timeoriginalestimate','timeestimate','timespent','security']);
    const jiraSnapshotFields: JiraMigrationIssueField[] = [];
    if (Object.hasOwn(v,'description')) jiraSnapshotFields.push('description');
    if (Object.hasOwn(v,'assignee')) jiraSnapshotFields.push('assigneeId');
    context.put('issue',id,{title:str(v.summary),containerId:projectId||null,parentId:parent||null,authorId:creator,createdAt:context.date(v.created,`issue:${id}`),updatedAt:context.date(v.updated,`issue:${id}`),text:str(v.description),textFormat:'jira-wiki',metadata:{key,fields,jiraSnapshotFields},references:[...ref('project',projectId,'project'),...ref('identity',creator,'creator'),...ref('identity',resolveActor(v.assignee),'assignee'),...ref('identity',resolveActor(v.reporter),'reporter'),...ref('issue',parent,'parent'),...['issuetype','status','priority','resolution'].flatMap(name=>ref('option',v[name]?`builtin:${name}:${str(v[name])}`:'',name))]});
  }
  const linkTypes=new Map(values.filter(row=>row.name==='IssueLinkType').map(row=>[str(row.value.id),row.value])),groups=new Map(values.filter(row=>row.name==='ChangeGroup').map(row=>[str(row.value.id),row.value]));
  const historyItems=new Map<string,LegacyValue[]>();for(const{name,value:v}of values)if(name==='ChangeItem'){const group=str(v.group),items=historyItems.get(group)||[];items.push(selected(v,['id','field','fieldtype','oldvalue','oldstring','newvalue','newstring']));historyItems.set(group,items);}
  for(const[groupId,v]of groups){const author=resolveActor(v.author);context.put('history',groupId,{title:'변경 이력',containerId:str(v.issue)||null,authorId:author,createdAt:context.date(v.created,`history:${groupId}`),metadata:{items:historyItems.get(groupId)||[]},references:[...ref('issue',v.issue,'historyOf'),...ref('identity',author,'author')]});}
  for(const[groupId]of historyItems)if(!groups.has(groupId)){context.warn('CHANGE_GROUP_MISSING','변경 항목의 ChangeGroup이 없습니다.',null,path,'error');context.unsupported('orphan:ChangeItem',(historyItems.get(groupId)||[]).length);}
  const handled=new Set(['User','OSUser','CwdUser','ApplicationUser','Project','Issue','CustomField','CustomFieldOption','Status','IssueType','Priority','Resolution','Workflow','ChangeGroup','ChangeItem','IssueLinkType']);
  for(const{name,value:v}of values){
    if(name==='Action'){handled.add(name);if(str(v.type)!=='comment'){context.unsupported(`Action:${str(v.type)||'unknown'}`);continue;}const id=str(v.id),author=resolveActor(v.author);context.put('comment',id,{title:'댓글',containerId:str(v.issue)||null,authorId:author,createdAt:context.date(v.created,`comment:${id}`),updatedAt:context.date(v.updated,`comment:${id}`),text:str(v.body),textFormat:'jira-wiki',metadata:{...selected(v,['updateauthor']),...jiraVisibilityMetadata(v,false)},references:[...ref('issue',v.issue,'commentOn'),...ref('identity',author,'author')]});}
    else if(name==='FileAttachment'){handled.add(name);context.attachment(str(v.id),str(v.issue||v.issueid),{...selected(v,['filename','filesize','mimetype','created','version']),...jiraVisibilityMetadata(v,false),author:resolveActor(v.author)});}
    else if(name==='CustomFieldValue'){handled.add(name);const issue=context.byId.get(`issue:${str(v.issue)}`),fieldId=str(v.customfield);if(!issue){context.warn('CUSTOM_FIELD_ISSUE_MISSING','사용자 정의 필드 값의 이슈가 없습니다.',null,path,'error');continue;}const fields=issue.metadata.fields as Record<string,LegacyValue>,value=jsonValue(Object.fromEntries(['stringvalue','textvalue','numbervalue','datevalue','parentkey','valuetype'].filter(name=>v[name]!==undefined).map(name=>[name,v[name]]))),previous=fields[fieldId];fields[fieldId]=previous===undefined?[value]:[...(Array.isArray(previous)?previous:[previous]),value];issue.references.push(...ref('field',fieldId,'customField'));if(!Object.keys(obj(value)).length)context.warn('CUSTOM_FIELD_VALUE_EMPTY','필드 값 행은 있지만 실제 값이 비어 있습니다.',issue.id);}
    else if(name==='IssueLink'){handled.add(name);const type=linkTypes.get(str(v.linktype)),sourceId=str(v.source),targetId=str(v.destination);context.put('relation',v.id,{title:str(type?.linkname||type?.name)||'업무 연결',containerId:sourceId||null,metadata:{typeId:str(v.linktype),...selected(type||{},['inward','outward','style'])},references:[...ref('issue',sourceId,'source'),...ref('issue',targetId,'target')]});if(str(type?.style)==='jira_subtask'){const target=context.byId.get(`issue:${targetId}`);if(target){target.parentId=sourceId;target.references.push(...ref('issue',sourceId,'parent'));}}}
    else if(name==='RemoteIssueLink'){handled.add(name);const url=context.url(v.url),author=resolveActor(v.author);const references=ref('issue',v.issueid||v.issue,'source');if(url){const pageId=new URL(url).searchParams.get('pageId');if(pageId)references.push(...ref('page',pageId,'externalDocument'));}context.put('relation',`remote:${str(v.id)}`,{title:str(v.title)||'외부 연결',authorId:author,containerId:str(v.issueid||v.issue)||null,metadata:{url,relationship:str(v.relationship),globalId:str(v.globalid)},references});}
    else if(name==='Worklog'){handled.add(name);const author=resolveActor(v.author);context.put('history',`worklog:${str(v.id)}`,{title:'작업 시간 기록',containerId:str(v.issue)||null,authorId:author,createdAt:context.date(v.created),updatedAt:context.date(v.updated),text:str(v.body),textFormat:'plain',metadata:{kind:'worklog',...selected(v,['started','startDate','startdate','timeworked','timeSpentSeconds','timeSpent','role','roleId','roleKey','rolelevel','roleLevel','group','groupId','groupKey','groupName','grouplevel','groupLevel','visibility','restriction','restrictions','restricted','isRestricted','hasRestrictions','restrictionType','restrictionValue','viewRole','viewRoleLevel','viewGroup','viewGroupLevel','permissions'])},references:[...ref('issue',v.issue,'worklogOf'),...ref('identity',author,'author')]});}
    else if(name==='Label'){handled.add(name);const issue=context.byId.get(`issue:${str(v.issue)}`);if(issue){const fields=issue.metadata.fields as Record<string,LegacyValue>;fields.labels=[...(Array.isArray(fields.labels)?fields.labels:[]),str(v.label)];}else context.warn('LABEL_ISSUE_MISSING','라벨의 이슈가 없습니다.',null,path);}
    else if(['Version','ProjectVersion','Component'].includes(name)){handled.add(name);const fieldId=`builtin:${name==='Component'?'components':'versions'}`;context.field(fieldId,name,'jira-builtin');context.ensure('option',`${fieldId}:${str(v.id)}`,{title:str(v.vname||v.cname||v.name)||str(v.id),containerId:fieldId,text:str(v.description),textFormat:'plain',metadata:selected(v,['id','project','released','archived','startdate','releasedate']),references:[...ref('field',fieldId,'field'),...ref('project',v.project,'project')]});}
    else if(name==='NodeAssociation'){handled.add(name);const destination=str(v.sinkNodeId||v.destNodeId),source=str(v.sourceNodeId),kind=str(v.sinkNodeEntity||v.destNodeEntity);context.put('relation',`association:${source}:${kind}:${destination}:${str(v.associationType)}`,{title:str(v.associationType)||'항목 연결',metadata:selected(v,['sourceNodeEntity','sinkNodeEntity','destNodeEntity','associationType']),references:[...ref('issue',source,'source'),...ref('option',kind==='Component'?`builtin:components:${destination}`:kind==='Version'?`builtin:versions:${destination}`:destination,'target')]});}
  }
  for(const{name}of values)if(!handled.has(name))context.unsupported(name);
  if(context.dataset.unsupported.length)context.warn('UNSUPPORTED_ADMIN_ENTITIES','지원하지 않는 관리자/플러그인 객체는 종류와 개수만 기록했습니다. 자격 증명·시스템 설정의 원시 속성은 미리보기에 복사하지 않았습니다.',null,path);
}

export function parseJira(files:Map<string,Buffer>,instanceKey:string):LegacyDataset{
  const paths=[...files.keys()].filter(path=>!/(?:^|\/)attachments?\//i.test(path)),entities=paths.find(path=>posix.basename(path).toLowerCase()==='entities.xml');
  const inputs=entities?[entities]:paths.filter(path=>/\.(?:csv|json|xml)$/i.test(path)&&posix.basename(path).toLowerCase()!=='activeobjects.xml').sort();
  const first=inputs[0]||'',format:LegacyDataset['source']['format']=entities?'jira-backup-xml':/\.csv$/i.test(first)?'jira-csv':/\.json$/i.test(first)?'jira-json':'jira-search-xml',context=new Context(files,instanceKey,format);
  if(!inputs.length){context.warn('JIRA_INPUT_NOT_FOUND','Jira XML·CSV·JSON 분석 파일을 찾지 못했습니다.',null,null,'error');return context.finish();}
  if(entities)for(const path of paths)if(path!==entities&&/\.(?:json|csv|xml)$/i.test(path)&&posix.basename(path).toLowerCase()!=='activeobjects.xml'){context.warn('ADDITIONAL_METADATA_NOT_PARSED','관리자 XML 외의 추가 메타데이터 파일은 자동 병합하지 않았습니다.',null,path);context.unsupported('additional-input');}
  for(const path of inputs){if(!entities&&((format==='jira-csv'&&!/\.csv$/i.test(path))||(format==='jira-json'&&!/\.json$/i.test(path))||(format==='jira-search-xml'&&!/\.xml$/i.test(path)))){context.warn('MIXED_DIALECT_NOT_COMBINED','서로 다른 입력 형식은 하나의 분석 결과로 자동 병합하지 않았습니다.',null,path);context.unsupported('mixed-input');continue;}const source=decodeLegacyText(files.get(path)!);if(/\.csv$/i.test(path))parseCsv(context,path,source);else if(/\.json$/i.test(path))parseJson(context,path,source);else{const root=parseLegacyXml(source);if(root.name==='entity-engine-xml'){context.dataset.source.format='jira-backup-xml';parseBackupXml(context,root,path);}else if(root.name==='rss'){context.dataset.source.format='jira-search-xml';parseSearchXml(context,root,path);}else{context.warn('XML_DIALECT_UNSUPPORTED','Jira 관리자 백업 또는 RSS 검색 XML 루트가 아닙니다.',null,path,'error');context.unsupported(`xml-root:${root.name}`);}}}
  for(const path of paths.filter(path=>posix.basename(path).toLowerCase()==='activeobjects.xml')){const root=parseLegacyXml(decodeLegacyText(files.get(path)!)),pending=[root];let counted=0;while(pending.length){const node=pending.pop()!;if(node.attributes.tableName||node.name==='table'){context.unsupported(`activeobjects:${node.attributes.tableName||node.attributes.name||'table'}`,Math.max(1,node.children.filter(child=>child.name==='row').length));counted++;}pending.push(...node.children);}if(!counted)context.unsupported('activeobjects.xml');context.warn('ACTIVEOBJECTS_NOT_CONVERTED','Active Objects 플러그인 데이터는 종류·개수만 분석했습니다. 원시 행이나 자격 증명은 복사하지 않았습니다.',null,path);}
  if(context.dataset.unsupported.some(item=>item.type.startsWith('json-field:')))context.warn('JSON_FIELDS_NOT_NORMALIZED','일부 JSON 필드는 정규화하지 않았으며 종류·개수를 별도로 기록했습니다.');
  return context.finish();
}
