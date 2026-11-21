import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JiraMigrationIssueField,LegacyDataset,LegacyRecord,LegacyRecordKind,LegacyReference,LegacyValue } from '../shared/types.js';
import { addRecord,diagnostic,emptyDataset,record,LegacyImportError } from './legacy-import-model.js';
import { decodeLegacyText,parseLegacyXml,type LegacyXmlNode } from './legacy-import-archive.js';
import { JiraActivityPages, type JiraActivityKind } from './legacy-import-jira-activity-pages.js';
import { JiraDateProjection,jiraDatePickerProof,jiraRestDateProof,jiraScheduleDateRole,type JiraDateRole } from './legacy-import-jira-dates.js';
import { JiraSprintProjection,JIRA_SPRINT_FIELD_TYPE } from './legacy-import-jira-sprints.js';
import { isJiraCommentRestrictionAttribute } from './migration-jira-history.js';
import { jiraWorklogRestrictionAttribute } from './migration-worklog.js';
import { jiraIssueRelationSource, jiraRelationEndpoints, sameJiraRelationType } from './migration-jira-relations.js';

// Primary dialect references: Jira search export documentation, Importers JSON
// documentation, and Jira Server parser constants (Action/FileAttachment/ChangeGroup).
// https://confluence.atlassian.com/jirasoftware/working-with-search-results-1528533257.html
// https://confluence.atlassian.com/adminjiraserver100/importing-data-from-json-1442845835.html
// https://docs.atlassian.com/software/jira/docs/api/9.12.38/constant-values.html

type ObjectValue=Record<string,unknown>;
type ProjectedDateField = { role: JiraDateRole; sourceId: string };
const ambiguousDateValue = Symbol('ambiguous Jira date value');
const obj=(value:unknown):ObjectValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};
const str=(value:unknown):string=>typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const child=(node:LegacyXmlNode,name:string)=>node.children.find(value=>value.name===name);
const children=(node:LegacyXmlNode,name:string)=>node.children.filter(value=>value.name===name);
const text=(node:LegacyXmlNode|undefined):string=>node?node.text+node.children.map(value=>text(value)).join(''):'';
const ref=(kind:LegacyRecordKind,sourceId:unknown,relation:string):LegacyReference[]=>str(sourceId)?[{kind,sourceId:str(sourceId),relation}]:[];
const selected=(value:ObjectValue,names:string[]):Record<string,LegacyValue>=>Object.fromEntries(names.filter(name=>Object.hasOwn(value,name)&&value[name]!==undefined).map(name=>[name,str(value[name])]));
function jsonValue(value:unknown,depth=0):LegacyValue{if(depth>30)return'[nested value omitted]';if(value===null||typeof value==='string'||typeof value==='boolean')return value;if(typeof value==='number')return Number.isFinite(value)?value:null;if(Array.isArray(value))return value.map(item=>jsonValue(item,depth+1));return Object.fromEntries(Object.entries(obj(value)).filter(([key])=>!/(?:password|credential|secret|token|privatekey)/i.test(key)).map(([key,value])=>[key,jsonValue(value,depth+1)]));}

function jiraVisibilityMetadata(input: ObjectValue, syntheticId: boolean): Record<string, LegacyValue> {
  const metadata = Object.fromEntries(Object.entries(input).filter(([name]) => isJiraCommentRestrictionAttribute(name))
    .map(([name, value]) => [name, jsonValue(value)]));
  if (syntheticId) metadata.syntheticId = true;
  return metadata;
}

function stableHistoryId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
}

function jsonHistoryGroup(context: Context, raw: unknown, issueId: string, fallbackId: string, allowPageOverlap = false): LegacyRecord {
  const group = obj(raw);
  const groupId = str(group.id) || fallbackId;
  const authorId = context.identity(group.author);
  const metadata = { ...jiraVisibilityMetadata(group, !stableHistoryId(group.id)), items: list(group.items).map(rawItem => {
    const item = obj(rawItem);
    return { ...selected(item, ['id', 'field', 'fieldId', 'fieldtype', 'fieldType', 'from', 'fromString', 'to', 'toString']),
      ...jiraVisibilityMetadata(item, false) };
  }) };
  const previous = context.byId.get(`history:${groupId}`);
  if (allowPageOverlap && previous && stableHistoryId(group.id)) {
    if (previous.containerId === issueId && previous.authorId === authorId && previous.createdAt === (str(group.created) || null) &&
        isDeepStrictEqual(previous.metadata, metadata)) return previous;
    throw new LegacyImportError(400, '같은 Jira 변경 이력 ID의 업무 또는 원본 내용이 페이지마다 다릅니다.');
  }
  return context.put('history', groupId, { title: '변경 이력', containerId: issueId, authorId,
    createdAt: context.date(group.created, `history:${groupId}`), metadata,
    references: [...ref('issue', issueId, 'historyOf'), ...ref('identity', authorId, 'author')] });
}

function jsonWorklogMetadata(input: ObjectValue, syntheticId: boolean): Record<string, LegacyValue> {
  const metadata: Record<string, LegacyValue> = {
    kind: 'worklog', ...selected(input, ['started', 'startDate', 'startdate', 'timeSpent', 'timeSpentSeconds', 'timeworked']),
  };
  if (syntheticId) metadata.syntheticId = true;
  let hasVisibility = false;
  for (const [name, value] of Object.entries(input)) {
    const restriction = jiraWorklogRestrictionAttribute(name);
    if (!restriction) continue;
    metadata[name] = jsonValue(value);
    if (restriction === 'visibility') hasVisibility = true;
  }
  if (!hasVisibility) metadata.visibility = null;
  return metadata;
}

function jsonActivity(context: Context, kind: JiraActivityKind, raw: unknown, issueId: string, index: number, allowPageOverlap = false): void {
  const input = obj(raw);
  const originalId = str(input.id);
  const worklog = kind === 'worklog';
  const recordKind = worklog ? 'history' : 'comment';
  const sourceId = worklog ? `worklog:${originalId || `${issueId}:${index}`}` : originalId || `json:${issueId}:comment:${index}`;
  const recordId = `${recordKind}:${sourceId}`;
  const authorId = context.identity(input.author);
  const body = worklog ? input.comment : input.body;
  const richText = typeof body === 'object' && (worklog || body !== null);
  const textFormat = richText ? 'adf' : worklog ? 'plain' : 'jira-wiki';
  const created = worklog ? input.created || input.startDate || input.started || input.startdate : input.created;
  const metadata = worklog ? jsonWorklogMetadata(input, !originalId) : jiraVisibilityMetadata(input, !originalId);
  const previous = allowPageOverlap ? context.byId.get(recordId) : undefined;
  if (previous) {
    if (previous.containerId === issueId && previous.authorId === authorId && previous.createdAt === (str(created) || null) &&
        previous.updatedAt === (str(input.updated) || null) && previous.textFormat === textFormat &&
        isDeepStrictEqual(richText ? JSON.parse(previous.text) : previous.text, richText ? body : str(body)) &&
        isDeepStrictEqual(previous.metadata, metadata)) return;
    throw new LegacyImportError(400, '같은 Jira 댓글·작업 시간 ID의 업무 또는 원본 내용이 페이지마다 다릅니다.');
  }
  context.put(recordKind, sourceId, {
    title: worklog ? '작업 시간 기록' : '댓글', containerId: issueId, authorId,
    createdAt: context.date(created, worklog ? undefined : recordId), updatedAt: context.date(input.updated, worklog ? undefined : recordId),
    text: richText ? JSON.stringify(body) : str(body), textFormat, metadata,
    references: [...ref('issue', issueId, worklog ? 'worklogOf' : 'commentOn'), ...ref('identity', authorId, 'author')],
  });
}

function restIssueLocation(value: unknown, changelog = false): { alias: string; base: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const route = /^(.*?)\/rest\/api\/(?:2|3|latest)\/issue\/([1-9]\d*|[A-Z][A-Z0-9_]*-\d+)(\/changelog)?\/?$/.exec(url.pathname);
    return route && Boolean(route[3]) === changelog ? { alias: route[2], base: url.origin + route[1] } : null;
  } catch {
    return null;
  }
}

type JiraHistoryPage = {
  owner: ReturnType<typeof restIssueLocation>; path: string; start: number; total: number; groups: unknown[];
};
type JiraRestIssueHistory = {
  location: ReturnType<typeof restIssueLocation>; embeddedIds: string[]; embeddedTotal: number | null | undefined;
};

function historyPageCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function standaloneHistoryPage(root: ObjectValue, path: string): JiraHistoryPage | null {
  const owner = restIssueLocation(root.self, true);
  const { values, startAt, total } = root;
  if (!Array.isArray(values) || !values.every(value => Array.isArray(obj(value).items)) || !owner && !values.length ||
      typeof startAt !== 'number' || !Number.isSafeInteger(startAt) || startAt < 0 ||
      typeof total !== 'number' || !Number.isSafeInteger(total) || total < startAt || values.length > total - startAt) return null;
  return { owner, path, start: startAt, total, groups: values };
}

function applyStandaloneHistory(context: Context): void {
  if (!context.historyPages.length) return;
  const issuesByAlias = new Map<string, Set<LegacyRecord>>();
  for (const issue of context.restIssues.keys()) {
    for (const alias of [issue.sourceId, str(issue.metadata.key)]) {
      if (!alias) continue;
      const candidates = issuesByAlias.get(alias) ?? new Set<LegacyRecord>();
      candidates.add(issue);
      issuesByAlias.set(alias, candidates);
    }
  }
  const pagesByIssue = new Map<LegacyRecord, JiraHistoryPage[]>();
  for (const page of context.historyPages) {
    const candidates = page.owner && issuesByAlias.get(page.owner.alias);
    const issue = candidates && candidates.size === 1 ? candidates.values().next().value : undefined;
    const location = issue && context.restIssues.get(issue)?.location;
    if (!issue || !page.owner || !location || location.base !== page.owner.base ||
        ![issue.sourceId, issue.metadata.key].includes(location.alias)) {
      context.warn('HISTORY_PAGE_OWNER_UNRESOLVED', 'REST 변경 이력 페이지와 같은 원본의 이슈를 확인할 수 없습니다.', null, page.path);
      continue;
    }
    const pages = pagesByIssue.get(issue) ?? [];
    pages.push(page);
    pagesByIssue.set(issue, pages);
  }
  const completenessByIssue = new Map<string, boolean>();
  const issuesWithPartial = new Set(context.dataset.diagnostics.filter(item => item.code === 'HISTORY_PARTIAL').map(item => item.recordId));
  for (const [issue, pages] of pagesByIssue) {
    const byOffset = new Map<number, string>();
    const ids = new Set<string>();
    const total = pages[0].total;
    let consistent = true;
    for (const [pageIndex, page] of pages.entries()) {
      if (page.total !== total) consistent = false;
      for (const [index, raw] of page.groups.entries()) {
        const group = jsonHistoryGroup(context, raw, issue.sourceId, `json:${issue.sourceId}:history-page:${pageIndex}:${index}`, true);
        const offset = page.start + index;
        const before = byOffset.get(offset);
        if (group.metadata.syntheticId || before && before !== group.sourceId || !before && ids.has(group.sourceId)) consistent = false;
        byOffset.set(offset, group.sourceId);
        ids.add(group.sourceId);
      }
    }
    const embedded = context.restIssues.get(issue)!;
    const complete = consistent && byOffset.size === total && embedded.embeddedIds.every(id => ids.has(id)) &&
      (embedded.embeddedTotal === undefined || embedded.embeddedTotal === total);
    completenessByIssue.set(issue.id, complete);
    if (!complete && !issuesWithPartial.has(issue.id)) {
      context.warn('HISTORY_PARTIAL', '제공된 REST 변경 이력 페이지의 범위를 모두 확인하지 못했습니다.', issue.id, pages[0].path);
    }
  }
  context.dataset.diagnostics = context.dataset.diagnostics.filter(item => !item.recordId || !completenessByIssue.has(item.recordId) ||
    item.code !== 'HISTORY_NOT_PROVIDED' && !(item.code === 'HISTORY_PARTIAL' && completenessByIssue.get(item.recordId)));
}

const csvSnapshotFields = new Map<string, JiraMigrationIssueField>([
  ['description', 'description'], ['assignee', 'assigneeId'], ['labels', 'labels'],
  ['start date', 'startDate'], ['start', 'startDate'], ['end date', 'endDate'], ['end', 'endDate'],
  ['due date', 'dueDate'], ['due', 'dueDate'], ['estimate', 'estimate'],
]);

class Context{
  dataset:LegacyDataset;byId=new Map<string,LegacyRecord>();fileNames=new Map<string,string[]>();
  readonly scheduleDates=new JiraDateProjection((code,message,recordId,path)=>this.warn(code,message,recordId,path));
  readonly sprints=new JiraSprintProjection((code,message,recordId,path)=>this.warn(code,message,recordId,path));
  readonly fixVersionIds = new Map<LegacyRecord, Set<string>>();
  readonly restIssues = new Map<LegacyRecord, JiraRestIssueHistory>();
  private readonly repeatedLinks: { first: LegacyRecord; next: LegacyRecord; path: string }[] = [];
  readonly historyPages: JiraHistoryPage[] = [];
  readonly activityPages = new JiraActivityPages((code, message, recordId, path) => this.warn(code, message, recordId, path));
  constructor(readonly files:Map<string,Buffer>,instanceKey:string,format:LegacyDataset['source']['format']){this.dataset=emptyDataset({product:'jira',format,instanceKey,declaredVersion:null,timezone:null});for(const path of files.keys()){const name=posix.basename(path),values=this.fileNames.get(name)||[];values.push(path);this.fileNames.set(name,values);}}
  put(kind:LegacyRecordKind,id:unknown,value:Partial<LegacyRecord>={}):LegacyRecord{const sourceId=str(id);if(!sourceId)throw new LegacyImportError(400,'Jira 원본 식별자가 없습니다.');const result=record(kind,sourceId,value);addRecord(this.dataset,result);this.byId.set(result.id,result);return result;}
  ensure(kind:LegacyRecordKind,id:unknown,value:Partial<LegacyRecord>={}):LegacyRecord|undefined{const sourceId=str(id);if(!sourceId)return undefined;return this.byId.get(`${kind}:${sourceId}`)||this.put(kind,sourceId,value);}
  restIssueLink(id: string, input: Partial<LegacyRecord>, path: string) {
    const first = this.byId.get(`relation:${id}`);
    if (!first) this.put('relation', id, input);
    else this.repeatedLinks.push({ first, next: record('relation', id, input), path });
  }
  private checkRestIssueLinks(issueKeys: ReadonlyMap<string, string>) {
    const canonical = (alias: string) => issueKeys.get(alias) ?? alias;
    const endpoints = (source: NonNullable<ReturnType<typeof jiraIssueRelationSource>>) =>
      jiraRelationEndpoints(source, canonical(source.sourceAlias), canonical(source.targetAlias));
    for (const { first, next, path } of this.repeatedLinks) {
      if (first.metadata.jiraRelationConflict === true) continue;
      const left = jiraIssueRelationSource(first), right = jiraIssueRelationSource(next);
      if (left && right && sameJiraRelationType(left, right) && isDeepStrictEqual(endpoints(left), endpoints(right))) continue;
      first.metadata.jiraRelationConflict = true;
      this.warn('JIRA_RELATION_RECORD_CONFLICT', '같은 Jira 관계 ID의 업무 또는 유형이 REST 응답에서 다르게 나타납니다.', first.id, path);
    }
  }
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
  finish():LegacyDataset{
    applyStandaloneHistory(this);
    this.activityPages.finish((kind, raw, issue, _path, index) => jsonActivity(this, kind, raw, issue.sourceId, index, true));
    this.scheduleDates.apply();
    this.sprints.apply(this.dataset);
    for (const [issue, ids] of this.fixVersionIds) issue.metadata.jiraFixVersionIds = [...ids];
    const issueKeys=new Map(this.dataset.records.filter(item=>item.kind==='issue'&&item.metadata.key).map(item=>[str(item.metadata.key),item.sourceId]));this.checkRestIssueLinks(issueKeys);const validated=emptyDataset(this.dataset.source);for(const item of this.dataset.records){for(const reference of item.references)if(reference.kind==='issue')reference.sourceId=issueKeys.get(reference.sourceId)||reference.sourceId;item.references=[...new Map(item.references.map(reference=>[JSON.stringify(reference),reference])).values()];if(item.kind==='issue'&&item.parentId)item.parentId=issueKeys.get(item.parentId)||item.parentId;addRecord(validated,item);}this.dataset.records=validated.records;this.warn('PREVIEW_ONLY','이 패키지는 분석·보존 가능성 미리보기이며 Teamspace 업무로 적용하지 않았습니다.',null,null,'info');return this.dataset;
  }
}

const versionFieldId = 'builtin:versions';
const versionOptionId = (id: string) => `${versionFieldId}:${id}`;
function versionIdentifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value) ? value : '';
}
function versionFlag(value: unknown): boolean | undefined {
  if (value === true || /^(?:true|yes|y|1)$/i.test(str(value))) return true;
  if (value === false || /^(?:false|no|n|0)$/i.test(str(value))) return false;
}
type VersionDeclaration = { id: string; project: string; title: string; description: string; source: ObjectValue };
function declareVersion(context: Context, version: VersionDeclaration, path: string): void {
  const { id, project, title, description, source } = version;
  const sourceId = versionOptionId(id);
  const metadata: Record<string, LegacyValue> = { id };
  if (project) metadata.project = project;
  for (const key of ['released', 'archived'] as const) {
    const value = versionFlag(source[key]);
    if (value !== undefined) metadata[key] = value;
    else if (str(source[key]).trim()) metadata[key] = str(source[key]);
  }
  for (const [key, alias] of [['startdate', 'startDate'], ['releasedate', 'releaseDate']] as const) {
    const value = str(source[key] ?? source[alias]);
    if (value.trim()) metadata[key] = value;
  }
  const before = context.byId.get(`option:${sourceId}`);
  if (!before) {
    context.field(versionFieldId, 'Versions', 'jira-builtin');
    context.ensure('option', sourceId, { title: title.trim() ? title : id, containerId: versionFieldId,
      text: description, textFormat: description ? 'plain' : 'none',
      metadata: { ...metadata, ...(!title.trim() && { jiraVersionNameMissing: true }) },
      references: [...ref('field', versionFieldId, 'field'), ...ref('project', project, 'project')] });
    return;
  }
  const conflicting = title.trim() && before.title.trim() !== title.trim() && !before.metadata.jiraVersionNameMissing ||
    description && before.text && before.text !== description ||
    Object.entries(metadata).some(([key, value]) => Object.hasOwn(before.metadata, key) && before.metadata[key] !== value);
  if (conflicting) {
    before.metadata.jiraVersionAmbiguous = true;
    context.warn('JIRA_VERSION_DEFINITION_AMBIGUOUS', '같은 원본 버전 ID의 정의가 서로 달라 릴리스 변환을 보류합니다.', before.id, path);
    return;
  }
  if (title.trim() && before.metadata.jiraVersionNameMissing) {
    before.title = title;
    delete before.metadata.jiraVersionNameMissing;
  }
  if (description && !before.text) {
    before.text = description;
    before.textFormat = 'plain';
  }
  if (project && !before.metadata.project) before.references.push(...ref('project', project, 'project'));
  Object.assign(before.metadata, metadata);
}
function unresolvedFixVersion(context: Context, issue: LegacyRecord, path: string): void {
  issue.metadata.jiraFixVersionUnresolved = true;
  context.warn('JIRA_FIX_VERSION_UNRESOLVED', 'Jira 수정 버전의 원본 ID 또는 프로젝트를 확인할 수 없어 대상 릴리스 연결을 보류합니다.', issue.id, path);
}
function recordFixVersion(context: Context, issue: LegacyRecord, id?: string): void {
  const values = context.fixVersionIds.get(issue) ?? new Set<string>();
  if (id && !values.has(id)) {
    values.add(id);
    issue.references.push(...ref('option', versionOptionId(id), 'fixVersion'));
  }
  context.fixVersionIds.set(issue, values);
}

function readJsonFixVersions(context: Context, issue: LegacyRecord, fields: ObjectValue, path: string, importers: boolean): void {
  const provided = ['fixVersions', ...(importers ? ['fixedVersions'] : [])].filter(key => Object.hasOwn(fields, key));
  if (!provided.length) return;
  let observedIds: Set<string> | undefined;
  for (const key of provided) {
    const values = fields[key];
    if (!Array.isArray(values)) {
      unresolvedFixVersion(context, issue, path);
      continue;
    }
    recordFixVersion(context, issue);
    const ids = new Set<string>();
    for (const raw of values) {
      const version = obj(raw);
      const id = versionIdentifier(version.id);
      const explicitProject = version.projectId ?? obj(version.project).id ?? obj(version.project).key ??
        (typeof version.project === 'string' || typeof version.project === 'number' ? version.project : undefined);
      const project = explicitProject === undefined ? versionIdentifier(issue.containerId) : versionIdentifier(explicitProject);
      if (id && project) declareVersion(context, { id, project,
        title: typeof version.name === 'string' ? version.name : '',
        description: typeof version.description === 'string' ? version.description : '', source: version }, path);
      if (!id || !project || issue.containerId !== project) unresolvedFixVersion(context, issue, path);
      if (id) {
        ids.add(id);
        recordFixVersion(context, issue, id);
      }
    }
    const previousIds = observedIds;
    if (previousIds && (previousIds.size !== ids.size || [...ids].some(id => !previousIds.has(id)))) {
      unresolvedFixVersion(context, issue, path);
    }
    observedIds = ids;
  }
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
  const reporterColumns = headers.flatMap((name, index) => /^Reporter$/i.test(name) ? [index] : []);
  for (const name of customHeaders) context.field(`csv:${name}`, name, 'csv-unspecified');
  const fixVersionColumns = headers.flatMap((header, index) => /^Fix Version\/s$/i.test(header) ? [index] : []);
  const dateColumns = headers.flatMap((header, column) => {
    const role = jiraScheduleDateRole(/^Custom field \(([^()]+)\)$/i.exec(header)?.[1] ?? '');
    if (!role) return [];
    const sourceId = `csv:${header}`;
    context.scheduleDates.declare(role, sourceId, true, path);
    return [{ role, sourceId, column }];
  });
  for (const role of ['startDate', 'endDate'] as const) {
    if (dateColumns.filter(column => column.role === role).length > 1) context.scheduleDates.reject(role, path);
  }
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++){const row=rows[rowIndex];if(row.every(value=>!value))continue;if(row.length!==headers.length)context.warn('CSV_COLUMN_COUNT_MISMATCH','CSV 행의 열 개수가 헤더와 다릅니다.',null,`${path}:${rowIndex+2}`,'error');const get=(...names:string[])=>row[headers.findIndex(header=>names.some(name=>header.toLowerCase()===name.toLowerCase()))]||'',key=get('Issue key','Key'),id=get('Issue id')||key||`csv:${path}:${rowIndex+2}`,projectId=get('Project id','Project key')||key.replace(/-\d+$/,'');if(projectId)context.ensure('project',projectId,{title:get('Project name')||get('Project key')||projectId,metadata:{key:get('Project key')||key.replace(/-\d+$/,'')}});const authorId=context.identity(get('Creator','Reporter')),assignee=context.identity(get('Assignee')),parent=get('Parent id','Parent');const metadata:Record<string,LegacyValue>={key,dialect:'search-csv',fields:{},jiraSnapshotFields:[...new Set(headers.map(header=>csvSnapshotFields.get(header.toLowerCase())).filter(field=>field!==undefined))]};const item=context.put('issue',id,{title:get('Summary'),containerId:projectId||null,parentId:parent||null,authorId,createdAt:context.date(get('Created'),`issue:${id}`),updatedAt:context.date(get('Updated'),`issue:${id}`),text:get('Description'),textFormat:'jira-wiki',metadata,references:[...ref('project',projectId,'project'),...ref('identity',authorId,'creatorOrReporter'),...ref('identity',assignee,'assignee'),...ref('issue',parent,'parent')]});const fields=item.metadata.fields as Record<string,LegacyValue>;
    if (row.length === headers.length && reporterColumns.length === 1) {
      recordJiraReporter(item, reporterIdentity(context, row[reporterColumns[0]]));
    }
    if (row.length === headers.length && customFieldIds.length) item.metadata.jiraSnapshotCustomFields = customFieldIds;
    for(let column=0;column<headers.length;column++){const name=headers[column],value=row[column]||'';if(!value)continue;if(/^Comment$/i.test(name)){const parts=value.split(';'),structured=parts.length>=3;const commentId=`csv:${id}:comment:${column}`,actor=structured?context.identity(parts[1]):null;context.put('comment',commentId,{title:'댓글',containerId:id,authorId:actor,createdAt:structured?context.date(parts[0],`comment:${commentId}`):null,text:structured?parts.slice(2).join(';'):value,textFormat:'jira-wiki',metadata:{sourceColumn:column,structured,syntheticId:true},references:[...ref('issue',id,'commentOn'),...ref('identity',actor,'author')]});if(!structured)context.warn('CSV_COMMENT_ATTRIBUTION_UNRESOLVED','댓글 원문은 보존했지만 작성자·시각 구분 형식을 확인하지 못했습니다.',item.id);}
      else if(/^Attachment$/i.test(name)){const parts=value.split(';'),uri=parts.at(-1)||'',filename=parts.length>=4?parts.slice(2,-1).join(';'):uri.split('/').at(-1)||value;context.attachment(`csv:${id}:attachment:${column}`,id,{name:filename,uri,attacher:parts.length>=4?parts[1]:'',created:parts.length>=4?parts[0]:''});}
      else{const previous=Object.hasOwn(fields,name)?fields[name]:undefined;Object.defineProperty(fields,name,{value:previous===undefined?value:Array.isArray(previous)?[...previous,value]:[previous,value],enumerable:true,writable:true,configurable:true});if(/^(?:Status|Priority|Issue Type|Resolution|Component\/s|Fix Version\/s|Affects Version\/s)$/i.test(name)){const fieldId=`csv:${name}`;context.field(fieldId,name,'csv-label-only');const optionId=context.option(fieldId,value);item.references.push(...ref('option',optionId,name));}}
    }
    if (fixVersionColumns.some(column => row[column]?.trim())) unresolvedFixVersion(context, item, path);
    else if (fixVersionColumns.length && row.length === headers.length) recordFixVersion(context, item);
    if (row.length === headers.length) {
      for (const { role, sourceId, column } of dateColumns) {
        const value = row[column];
        context.scheduleDates.observe(item, role, sourceId, value.trim() ? value : null, path, true);
      }
    }
  }
  context.warn('CSV_HISTORY_NOT_PROVIDED','검색 CSV는 완전한 변경 이력이나 첨부 바이트를 보장하지 않습니다. 실제 제공된 댓글·첨부 열만 분석했습니다.',null,path);
}

function reporterIdentity(context: Context, raw: unknown): string | null | undefined {
  if (raw === null || typeof raw === 'string' && !raw.trim()) return null;
  const profile = obj(raw);
  const id = typeof raw === 'string' ? raw : profile.accountId || profile.key || profile.name || profile.username || profile.id;
  if (!(typeof id === 'string' && id.length <= 500 && id.trim() && id.isWellFormed() && !/\p{Cc}/u.test(id)) &&
      !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) return undefined;
  return context.identity(raw) ?? undefined;
}

function recordJiraReporter(item: LegacyRecord, reporter: string | null | undefined): void {
  if (reporter === undefined) return;
  item.metadata.jiraReporter = reporter;
  if (Array.isArray(item.metadata.jiraSnapshotFields)) item.metadata.jiraSnapshotFields.push('reporterId');
  if (reporter !== null && !item.references.some(reference => reference.kind === 'identity' &&
      reference.relation === 'reporter' && reference.sourceId === reporter)) {
    item.references.push(...ref('identity', reporter, 'reporter'));
  }
}

function jiraCustomUser(context: Context, value: unknown, fieldType: string): string | null {
  const profile = obj(value);
  const stableId = typeof profile.accountId === 'string' && profile.accountId.trim();
  const legacyId = [profile.key, profile.name, profile.username].some(id => typeof id === 'string' && id.trim());
  const legacyProfile = [profile.displayName, profile.emailAddress].some(label => typeof label === 'string' && label.trim());
  const typedUser = /(^|:)user(?:picker)?$/i.test(fieldType);
  return stableId || legacyId && (legacyProfile || typedUser) ? context.identity(profile) : null;
}

function issueJson(context:Context,input:ObjectValue,projectId:string,path:string,index:number,importers:boolean,dateFields:ProjectedDateField[]=[]):void{
  const fields=importers?input:obj(input.fields),id=str(input.id||input.externalId||input.key)||`json:${path}:${index}`,key=str(input.key),project=obj(fields.project),containerId=str(project.id||project.key)||projectId;
  if(containerId)context.ensure('project',containerId,{title:str(project.name)||containerId,metadata:{key:str(project.key)||projectId}});
  const authorId=context.identity(fields.creator||fields.reporter),assignee=context.identity(fields.assignee),parent=obj(fields.parent),parentId=str(parent.id||parent.key)||str(fields.parent),description=fields.description;
  const jiraSnapshotFields: JiraMigrationIssueField[] = [];
  if (description === null || typeof description === 'string' || Object.hasOwn(obj(description), 'type')) jiraSnapshotFields.push('description');
  if (fields.assignee === null || fields.assignee === '' || assignee) jiraSnapshotFields.push('assigneeId');
  const item=context.put('issue',id,{title:str(fields.summary),containerId:containerId||null,parentId:parentId||null,authorId,createdAt:context.date(fields.created,`issue:${id}`),updatedAt:context.date(fields.updated,`issue:${id}`),text:typeof description==='object'&&description!==null?JSON.stringify(description):str(description),textFormat:typeof description==='object'&&description!==null?'adf':'jira-wiki',metadata:{key,dialect:importers?'importers-json':'rest-json',...selected(fields,['resolutiondate','duedate','environment','originalEstimate','timeSpent','estimate']),jiraSnapshotFields,fields:{}},references:[...ref('project',containerId,'project'),...ref('identity',authorId,'creatorOrReporter'),...ref('identity',assignee,'assignee'),...ref('issue',parentId,'parent')]});
  if (Object.hasOwn(fields, 'reporter')) recordJiraReporter(item, reporterIdentity(context, fields.reporter));
  const readActivity = (kind: JiraActivityKind, envelope: unknown, rows: unknown[]) => {
    for (const [position, raw] of rows.entries()) jsonActivity(context, kind, raw, id, position);
    if (!importers) context.activityPages.track(item, input.self, kind, envelope, rows.map(raw => str(obj(raw).id) || null), path);
  };
  const values=item.metadata.fields as Record<string,LegacyValue>;
  const scheduleValues = ['startDate', 'endDate', 'dueDate', 'duedate', 'estimate'];
  const jiraScheduleFields = Object.fromEntries(scheduleValues.filter(name=>Object.hasOwn(fields,name) &&
    (fields[name] === null || typeof fields[name] === 'string' || typeof fields[name] === 'number')).map(name=>[name,jsonValue(fields[name])]));
  if (Object.keys(jiraScheduleFields).length) item.metadata.jiraScheduleFields = jiraScheduleFields;
  readJsonFixVersions(context, item, fields, path, importers);
  for (const { role, sourceId } of dateFields) {
    if (Object.hasOwn(fields, sourceId)) context.scheduleDates.observe(item, role, sourceId, fields[sourceId], path, true);
  }
  if(fields.security!==undefined&&fields.security!==null){const security=obj(fields.security);values.security=typeof fields.security==='boolean'?fields.security:typeof fields.security==='object'?{...selected(security,['id','name']),present:true}:str(fields.security)?{name:str(fields.security),present:true}:null;}
  for(const name of ['status','issuetype','issueType','priority','resolution','labels','components','fixVersions','fixedVersions','versions','affectedVersions','sprint','watches'])if(fields[name]!==undefined){values[name]=jsonValue(fields[name]);if(['status','issuetype','issueType','priority','resolution'].includes(name)){const fieldId=`builtin:${name==='issueType'?'issuetype':name}`;context.field(fieldId,name,'jira-builtin');const optionId=context.option(fieldId,fields[name]);item.references.push(...ref('option',optionId,name));}}
  if (!importers && Object.hasOwn(fields, 'closedSprints')) {
    const closedSprints = fields.closedSprints;
    const preserve = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return jsonValue(value);
      const { self, ...sprint } = obj(value);
      const url = context.url(self, item.id);
      return jsonValue({ ...sprint, ...(url ? { self: url } : {}) });
    };
    values.closedSprints = Array.isArray(closedSprints) ? closedSprints.map(preserve) : preserve(closedSprints);
  }
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
  readActivity('comment', fields.comment, list(importers ? fields.comments : obj(fields.comment).comments));
  for(let attachmentIndex=0;attachmentIndex<list(fields.attachments||fields.attachment).length;attachmentIndex++){const attachment=obj(list(fields.attachments||fields.attachment)[attachmentIndex]);context.attachment(str(attachment.id)||`json:${id}:attachment:${attachmentIndex}`,id,attachment);}
  const changelog = obj(input.changelog);
  const embedded = Array.isArray(changelog.histories) ? changelog.histories : Array.isArray(changelog.values) ? changelog.values : undefined;
  const history = importers ? list(fields.history) : embedded ?? [];
  const embeddedIds = history.map((group, index) => jsonHistoryGroup(context, group, id, `json:${id}:history:${index}`).sourceId);
  if (!importers) {
    const total = historyPageCount(changelog.total), startAt = historyPageCount(changelog.startAt);
    if (!embedded) {
      context.warn('HISTORY_NOT_PROVIDED', 'REST 문서에서 변경 이력 배열을 확인할 수 없습니다.', item.id, path);
    } else if (total !== undefined && total !== embedded.length || startAt !== undefined && startAt !== 0 ||
        embedded.some(group => !Array.isArray(obj(group).items))) {
      context.warn('HISTORY_PARTIAL', 'REST 변경 이력 페이지 일부만 확인할 수 있습니다.', item.id, path);
    }
    context.restIssues.set(item, { location: restIssueLocation(input.self), embeddedIds, embeddedTotal: total });
  }
  readActivity('worklog', fields.worklog, list(importers ? fields.worklogs : obj(fields.worklog).worklogs));
  for (const [linkIndex, value] of list(fields.issuelinks).entries()) {
    const link = obj(value), inward = obj(link.inwardIssue), outward = obj(link.outwardIssue), type = obj(link.type);
    const innerId = str(inward.id || inward.key), outerId = str(outward.id || outward.key);
    const linkId = str(link.id) || `json:${id}:link:${linkIndex}`;
    context.restIssueLink(linkId, { title: str(type.name) || '업무 연결', containerId: id,
      metadata: { direction: innerId ? 'inward' : 'outward', ...selected(type, ['id', 'name', 'inward', 'outward']),
        ...(innerId && outerId ? { jiraRelationConflict: true } : {}) },
      references: [...ref('issue', id, 'source'), ...ref('issue', innerId || outerId, 'target')],
    }, path);
    if (innerId && outerId) context.warn('JIRA_RELATION_RECORD_CONFLICT', '같은 Jira 관계 항목에 두 방향의 링크가 함께 있습니다.', `relation:${linkId}`, path);
  }
  const known=new Set(['project','summary','description','creator','reporter','assignee','parent','created','updated','resolutiondate','duedate','dueDate','startDate','endDate','environment','originalEstimate','timeSpent','estimate','status','issuetype','issueType','priority','resolution','security','labels','components','fixVersions','fixedVersions','versions','affectedVersions','sprint','closedSprints','watches','customFieldValues','comment','comments','attachment','attachments','history','issuelinks','worklog','worklogs','externalId','id','key']);
  for(const name of Object.keys(fields))if(!known.has(name)&&!/^customfield_\d+$/.test(name))context.unsupported(`json-field:${name}`);
}
function declareRestFields(context: Context, root: ObjectValue, path: string): ProjectedDateField[] {
  const names = obj(root.names), schemas = obj(root.schema);
  const trustedSprintFields = Object.keys(schemas).filter(id => {
    const custom = obj(schemas[id]).custom;
    return custom === JIRA_SPRINT_FIELD_TYPE || context.byId.get(`field:${id}`)?.metadata.fieldType === JIRA_SPRINT_FIELD_TYPE;
  });
  return [...new Set([...Object.keys(names), ...trustedSprintFields])].flatMap(sourceId => {
    if (!/^customfield_\d+$/.test(sourceId)) return [];
    const title = names[sourceId];
    const schema = obj(schemas[sourceId]), type = str(schema.type), custom = str(schema.custom);
    const field = context.field(sourceId, str(title) || sourceId, custom || type || 'unknown');
    const priorType = str(field.metadata.fieldType);
    if (custom === JIRA_SPRINT_FIELD_TYPE && ['unknown', 'rest-custom-unspecified', 'array'].includes(priorType)) {
      field.metadata.fieldType = JIRA_SPRINT_FIELD_TYPE;
      if (str(title)) field.title = str(title);
    } else if (custom && custom !== priorType && [custom, priorType].includes(JIRA_SPRINT_FIELD_TYPE)) {
      field.metadata.jiraSprintFieldAmbiguous = true;
    }
    const role = jiraScheduleDateRole(str(title));
    if (!role) return [];
    const proof = jiraRestDateProof(type, custom);
    context.scheduleDates.declare(role, sourceId, proof, path);
    return proof === true ? [{ role, sourceId }] : [];
  });
}

function parseJson(context:Context,path:string,source:string):void{
  let input:unknown;try{input=JSON.parse(source);}catch{throw new LegacyImportError(400,'Jira JSON 형식이 올바르지 않습니다.');}const root=obj(input);
  if(Array.isArray(root.projects)){
    context.warn('JSON_IMPORTERS_DIALECT','Jira Importers 입력 JSON을 분석했습니다. Jira 전체 내보내기와 동일한 형식은 아닙니다.',null,path,'info');
    for(const user of list(root.users))context.identity(user);
    for (const raw of root.projects) {
      const project=obj(raw),id=str(project.id||project.key||project.name);
      if (!id) { context.warn('PROJECT_ID_MISSING','JSON 프로젝트에 원본 식별자가 없습니다.',null,path,'error'); continue; }
      context.ensure('project',id,{title:str(project.name)||id,text:str(project.description),textFormat:'plain',metadata:selected(project,['key','type'])});
      for (const kind of ['versions','components']) for (const rawOption of list(project[kind])) {
        const option: ObjectValue = typeof rawOption === 'string' ? { name: rawOption } : obj(rawOption);
        const versionId = kind === 'versions' ? versionIdentifier(option.id) : '';
        if (versionId) {
          declareVersion(context, { id: versionId, project: id, title: str(option.name), description: str(option.description), source: option }, path);
        } else {
          context.field(`builtin:${kind}`,kind,'jira-builtin');
          context.option(`builtin:${kind}`,option);
        }
      }
      const issues = list(project.issues || project['work items']);
      for (let index = 0; index < issues.length; index++) issueJson(context, obj(issues[index]), id, path, index, true);
    }
    for(let index=0;index<list(root.links).length;index++){const link=obj(list(root.links)[index]),id=str(link.id)||`json:relation:${path}:${index}`;context.put('relation',id,{title:str(link.name)||'업무 연결',metadata:{name:str(link.name)},references:[...ref('issue',link.sourceId,'source'),...ref('issue',link.destinationId,'target')]});}
  }else if(Array.isArray(root.issues)){
    context.warn('JSON_REST_DIALECT','Jira REST 검색 응답 JSON을 분석했습니다. 별도 페이지·첨부 바이트는 자동 조회하지 않습니다.',null,path,'info');
    if(Number(root.startAt)>0||Number(root.total)>root.issues.length)context.warn('ISSUES_PARTIAL','검색 응답의 일부 페이지입니다. 전체 이슈 개수와 파일 묶음을 대조해야 합니다.',null,path);
    const dateFields=declareRestFields(context,root,path);
    for(let index=0;index<root.issues.length;index++)issueJson(context,obj(root.issues[index]),'',path,index,false,dateFields);
  }else if(root.fields&&(root.id||root.key)){context.warn('JSON_REST_DIALECT','단일 Jira REST 이슈 JSON을 분석했습니다.',null,path,'info');issueJson(context,root,'',path,0,false,declareRestFields(context,root,path));}
  else {
    const page = standaloneHistoryPage(root, path);
    if (page) context.historyPages.push(page);
    else if (!context.activityPages.read(root, path)) {
      context.warn('JSON_DIALECT_UNSUPPORTED','지원하는 Jira REST 업무·활동 페이지 또는 Importers JSON 구조가 아닙니다.',null,path,'error');
      context.unsupported('json:unrecognized-root');
    }
  }
}

function rssDateValue(custom: LegacyXmlNode): unknown {
  const containers = children(custom, 'customfieldvalues');
  if (!containers.length) return undefined;
  const [container] = containers;
  const [value] = container.children;
  if (containers.length > 1 || container.text.trim() || container.children.length > 1 ||
      value && (value.name !== 'customfieldvalue' || value.children.length)) return ambiguousDateValue;
  return value?.text;
}

function parseSearchXml(context:Context,root:LegacyXmlNode,path:string):void{
  const channel=child(root,'channel');if(!channel){context.warn('XML_SEARCH_CHANNEL_MISSING','검색 XML의 channel이 없습니다.',null,path,'error');return;}const items=children(channel,'item'),range=child(channel,'issue');if(range&&(Number(range.attributes.total)>items.length||Number(range.attributes.start)>0))context.warn('ISSUES_PARTIAL','검색 XML은 일부 검색 결과만 포함합니다.',null,path);
  for(let index=0;index<items.length;index++){
    const node=items[index],get=(name:string)=>text(child(node,name)),keyNode=child(node,'key'),key=text(keyNode),id=keyNode?.attributes.id||key||`xml:${path}:${index}`,project=child(node,'project'),projectId=project?.attributes.id||project?.attributes.key||key.replace(/-\d+$/,'');context.ensure('project',projectId,{title:text(project)||projectId,metadata:{key:project?.attributes.key||key.replace(/-\d+$/,'')}});
    const reporters=children(node,'reporter'),reporter=reporters[0],assignee=child(node,'assignee'),reporterAccount=reporter?.attributes.username||reporter?.attributes.accountid,authorId=context.identity(reporterAccount||text(reporter)),assigneeId=context.identity(assignee?.attributes.username||assignee?.attributes.accountid||text(assignee)),parentNode=child(node,'parent'),parentId=parentNode?.attributes.id||text(parentNode),fields:Record<string,LegacyValue>={};
    const jiraSnapshotFields: JiraMigrationIssueField[] = [];
    if (child(node,'description')) jiraSnapshotFields.push('description');
    if (assignee && (assigneeId || !text(assignee))) jiraSnapshotFields.push('assigneeId');
    const item=context.put('issue',id,{title:get('summary')||get('title'),containerId:projectId||null,parentId:parentId||null,authorId,createdAt:context.date(get('created'),`issue:${id}`),updatedAt:context.date(get('updated'),`issue:${id}`),text:get('description'),textFormat:'plain',metadata:{key,dialect:'rss-search-xml',descriptionFormat:'search-rendered-html',originalUrl:context.url(get('link')),jiraSnapshotFields,fields},references:[...ref('project',projectId,'project'),...ref('identity',authorId,'reporter'),...ref('identity',assigneeId,'assignee'),...ref('issue',parentId,'parent')]});
    if (reporters.length === 1 && !reporter.children.length) {
      if (reporterAccount) recordJiraReporter(item, reporterIdentity(context, reporterAccount));
      else if (!text(reporter).trim() && !Object.keys(reporter.attributes).length) recordJiraReporter(item, null);
    }
    for(const name of ['type','status','priority','resolution','security','due','resolved','environment','version','fixVersion','component','labels']){const matches=children(node,name);if(!matches.length)continue;const normalized=name==='type'?'issuetype':name,fieldId=`builtin:${normalized}`;fields[normalized]=matches.map(value=>({id:value.attributes.id||null,text:text(value)}));if(['type','status','priority','resolution'].includes(name)){context.field(fieldId,normalized,'jira-builtin');for(const value of matches){const option=context.option(fieldId,{id:value.attributes.id||text(value),name:text(value)});item.references.push(...ref('option',option,normalized));}}}
    for (const value of children(node, 'fixVersion')) {
      const versionId = versionIdentifier(value.attributes.id);
      const versionProject = versionIdentifier(project?.attributes.id ?? project?.attributes.key);
      if (versionId && versionProject && !value.children.length) {
        declareVersion(context, { id: versionId, project: versionProject, title: text(value), description: '', source: value.attributes }, path);
        recordFixVersion(context, item, versionId);
      } else unresolvedFixVersion(context, item, path);
    }
    const labelElements = children(node,'labels');
    if (labelElements.length && labelElements.every(container=>container.children.every(label=>label.name==='label') && !container.text.trim())) {
      item.metadata.jiraSnapshotLabels = labelElements.flatMap(container=>children(container,'label').map(label=>text(label)));
    }
    for(const comment of child(node,'comments')?.children||[]){if(comment.name!=='comment')continue;const sourceId=comment.attributes.id,commentId=sourceId||`xml:${id}:comment:${(child(node,'comments')?.children||[]).indexOf(comment)}`,author=context.identity(comment.attributes.author);context.put('comment',commentId,{title:'댓글',containerId:id,authorId:author,createdAt:context.date(comment.attributes.created,`comment:${commentId}`),updatedAt:context.date(comment.attributes.updated,`comment:${commentId}`),text:text(comment),textFormat:'plain',metadata:{...jiraVisibilityMetadata(comment.attributes,!sourceId),bodyFormat:'search-rendered-html'},references:[...ref('issue',id,'commentOn'),...ref('identity',author,'author')]});}
    for(const attachment of child(node,'attachments')?.children||[])if(attachment.name==='attachment')context.attachment(attachment.attributes.id||`xml:${id}:attachment:${(child(node,'attachments')?.children||[]).indexOf(attachment)}`,id,attachment.attributes);
    for (const custom of child(node,'customfields')?.children || []) {
      if (custom.name !== 'customfield') continue;
      const name = text(child(custom,'customfieldname'));
      const fieldId = custom.attributes.id || `named:${name}`;
      const values = (child(custom,'customfieldvalues')?.children || []).map(value=>text(value));
      context.field(fieldId,name || fieldId,custom.attributes.key || 'search-unspecified');
      fields[fieldId]=values;
      item.references.push(...ref('field',fieldId,'customField'));
      const role = jiraScheduleDateRole(name);
      if (!role || !custom.attributes.id) continue;
      const proof = jiraDatePickerProof(custom.attributes.key || '');
      context.scheduleDates.declare(role,fieldId,proof,path);
      if (proof === true) {
        const value = children(custom,'customfieldname').length === 1 ? rssDateValue(custom) : ambiguousDateValue;
        context.scheduleDates.observe(item,role,fieldId,value,path);
      }
    }
    for(const type of child(node,'issuelinks')?.children||[]){const typeId=type.attributes.id||text(child(type,'name'));for(const direction of ['inwardlinks','outwardlinks'])for(const link of child(type,direction)?.children||[]){const target=child(link,'issuekey'),targetId=target?.attributes.id||text(target);context.ensure('relation',`search:${id}:${typeId}:${direction}:${targetId}`,{title:text(child(type,'name'))||'업무 연결',containerId:id,metadata:{originalTypeId:typeId,direction,description:child(type,direction)?.attributes.description||'',syntheticId:true},references:[...ref('issue',id,'source'),...ref('issue',targetId,'target')]});}}
  }
  context.warn('SEARCH_XML_HISTORY_NOT_PROVIDED','검색 XML은 관리자 전체 백업이 아닙니다. 전체 상태 변경 이력·사용자 설정·첨부 바이트의 보존을 확정할 수 없습니다.',null,path);
}

function entityValues(node:LegacyXmlNode):ObjectValue{return{...node.attributes,...Object.fromEntries(node.children.map(value=>[value.name,text(value)]))};}
function adminXmlDateValue(node: LegacyXmlNode, value: ObjectValue): unknown {
  const dateNodes = children(node, 'datevalue'), [date] = dateNodes;
  if (dateNodes.length > 1 || date && (date.children.length || Object.hasOwn(node.attributes,'datevalue')) ||
      ['stringvalue','textvalue','numbervalue'].some(name=>str(value[name]).trim())) return ambiguousDateValue;
  return value.datevalue;
}

function parseBackupXml(context:Context,root:LegacyXmlNode,path:string):void{
  context.dataset.source.declaredVersion=root.attributes.version||null;
  const rows=root.children,values=rows.map(node=>({name:node.name,value:entityValues(node),node})),appUsers=new Map(values.filter(row=>row.name==='ApplicationUser').map(row=>[str(row.value.lowerUserName),str(row.value.userKey)]));
  const projectedFields = new Map<string,JiraDateRole>();
  for(const{ name,value:v }of values)if(['User','OSUser','CwdUser'].includes(name)){const username=str(v.userName||v.name||v.lowerUserName),id=appUsers.get(username.toLowerCase())||str(v.userKey)||username||str(v.id);context.ensure('identity',id,{title:str(v.displayName||v.fullName)||username||id,createdAt:context.date(v.createdDate),updatedAt:context.date(v.updatedDate),metadata:{...selected(v,['id','userName','name','lowerUserName','displayName','fullName','emailAddress','email','active']),identityIncomplete:false}});}
  for(const[username,id]of appUsers)context.ensure('identity',id,{title:username||id,metadata:{key:id,name:username,identityIncomplete:true}});
  const resolveActor=(value:unknown):string|null=>{const original=str(value);return context.identity(appUsers.get(original.toLowerCase())||original);};
  for(const{name,value:v}of values){if(name==='Project')context.put('project',v.id||v.key||v.pkey,{title:str(v.name),text:str(v.description),textFormat:'plain',authorId:resolveActor(v.lead),metadata:{...selected(v,['key','pkey','projecttype','assigneetype']),url:context.url(v.url)}});
    else if (name==='CustomField') {
      const field = context.put('field',v.id,{title:str(v.name)||str(v.cfname),text:str(v.description),textFormat:'plain',metadata:selected(v,['customfieldtypekey','customfieldsearcherkey','fieldtype','cfname'])});
      const role = jiraScheduleDateRole(field.title);
      if (role) {
        const proof = jiraDatePickerProof(str(v.customfieldtypekey || v.fieldtype));
        context.scheduleDates.declare(role,field.sourceId,proof,path);
        if (proof === true) projectedFields.set(field.sourceId,role);
      }
    }
    else if(['Status','IssueType','Priority','Resolution'].includes(name)){const fieldId=`builtin:${name.toLowerCase()}`;context.field(fieldId,name,'jira-builtin');context.ensure('option',`${fieldId}:${str(v.id)}`,{title:str(v.pname||v.name)||str(v.id),containerId:fieldId,metadata:selected(v,['id','description','sequence','style']),references:ref('field',fieldId,'field')});}
    else if(name==='CustomFieldOption')context.put('option',v.id,{title:str(v.value)||str(v.customvalue)||str(v.id),containerId:str(v.customfield)||null,parentId:str(v.parentoptionid)||null,metadata:selected(v,['sequence','disabled']),references:[...ref('field',v.customfield,'field'),...ref('option',v.parentoptionid,'parent')]});
    else if(name==='Workflow'){context.put('workflow',v.id||v.name,{title:str(v.name),authorId:resolveActor(v.creatorname),createdAt:context.date(v.created),updatedAt:context.date(v.updated),metadata:{descriptorPresent:!!(v.descriptor||v.workflow)}});if(v.descriptor||v.workflow)context.warn('WORKFLOW_DESCRIPTOR_NOT_CONVERTED','워크플로 이름·작성 정보만 분석했습니다. 실행 가능한 descriptor/플러그인 설정은 복사하지 않았습니다.',`workflow:${str(v.id||v.name)}`);}
  }
  for(const{name,value:v,node}of values)if(name==='Issue'){
    const id=str(v.id),projectId=str(v.project),project=context.byId.get(`project:${projectId}`),key=str(v.key||v.pkey)||`${str(project?.metadata.pkey||project?.metadata.key)}-${str(v.number||v.issuenum)}`,creator=resolveActor(v.creator||v.reporter),parent=str(v.parent),fields:Record<string,LegacyValue>=selected(v,['issuetype','status','priority','resolution','assignee','reporter','creator','duedate','resolutiondate','environment','votes','watches','timeoriginalestimate','timeestimate','timespent','security']);
    const jiraSnapshotFields: JiraMigrationIssueField[] = [];
    if (Object.hasOwn(v,'description')) jiraSnapshotFields.push('description');
    if (Object.hasOwn(v,'assignee')) jiraSnapshotFields.push('assigneeId');
    const reporter = resolveActor(v.reporter);
    const item = context.put('issue',id,{title:str(v.summary),containerId:projectId||null,parentId:parent||null,authorId:creator,createdAt:context.date(v.created,`issue:${id}`),updatedAt:context.date(v.updated,`issue:${id}`),text:str(v.description),textFormat:'jira-wiki',metadata:{key,fields,jiraSnapshotFields},references:[...ref('project',projectId,'project'),...ref('identity',creator,'creator'),...ref('identity',resolveActor(v.assignee),'assignee'),...ref('identity',reporter,'reporter'),...ref('issue',parent,'parent'),...['issuetype','status','priority','resolution'].flatMap(name=>ref('option',v[name]?`builtin:${name}:${str(v[name])}`:'',name))]});
    const reporterElements = children(node, 'reporter');
    if (Number(Object.hasOwn(node.attributes, 'reporter')) + reporterElements.length === 1 &&
        !reporterElements.some(element => element.children.length) && typeof v.reporter === 'string') {
      recordJiraReporter(item, v.reporter.trim() ? reporter ?? undefined : null);
    }
  }
  const linkTypes=new Map(values.filter(row=>row.name==='IssueLinkType').map(row=>[str(row.value.id),row.value]));
  const groups = new Map<string, ObjectValue>();
  const historyItems = new Map<string, LegacyValue[]>();
  for (const { name, value } of values) {
    if (name === 'ChangeGroup') {
      const groupId = str(value.id);
      if (groups.has(groupId)) throw new LegacyImportError(400, 'Jira 백업에 중복된 ChangeGroup ID가 있습니다.');
      groups.set(groupId, value);
    } else if (name === 'ChangeItem') {
      const { group, ...item } = value;
      const groupId = str(group);
      const items = historyItems.get(groupId) ?? [];
      items.push({ ...selected(item, ['id', 'field', 'fieldtype', 'fieldId', 'fieldType', 'oldvalue', 'oldstring', 'newvalue', 'newstring']),
        ...jiraVisibilityMetadata(item, false) });
      historyItems.set(groupId, items);
    }
  }
  for (const [groupId, value] of groups) {
    const authorId = resolveActor(value.author);
    context.put('history', groupId, { title: '변경 이력', containerId: str(value.issue) || null, authorId,
      createdAt: context.date(value.created, `history:${groupId}`),
      metadata: { ...jiraVisibilityMetadata(value, !stableHistoryId(value.id)), items: historyItems.get(groupId) ?? [] },
      references: [...ref('issue', value.issue, 'historyOf'), ...ref('identity', authorId, 'author')] });
  }
  for(const[groupId]of historyItems)if(!groups.has(groupId)){context.warn('CHANGE_GROUP_MISSING','변경 항목의 ChangeGroup이 없습니다.',null,path,'error');context.unsupported('orphan:ChangeItem',(historyItems.get(groupId)||[]).length);}
  const handled=new Set(['User','OSUser','CwdUser','ApplicationUser','Project','Issue','CustomField','CustomFieldOption','Status','IssueType','Priority','Resolution','Workflow','ChangeGroup','ChangeItem','IssueLinkType']);
  for(const{name,value:v,node}of values){
    if(name==='Action'){handled.add(name);if(str(v.type)!=='comment'){context.unsupported(`Action:${str(v.type)||'unknown'}`);continue;}const id=str(v.id),author=resolveActor(v.author);context.put('comment',id,{title:'댓글',containerId:str(v.issue)||null,authorId:author,createdAt:context.date(v.created,`comment:${id}`),updatedAt:context.date(v.updated,`comment:${id}`),text:str(v.body),textFormat:'jira-wiki',metadata:{...selected(v,['updateauthor']),...jiraVisibilityMetadata(v,false)},references:[...ref('issue',v.issue,'commentOn'),...ref('identity',author,'author')]});}
    else if(name==='FileAttachment'){handled.add(name);context.attachment(str(v.id),str(v.issue||v.issueid),{...selected(v,['filename','filesize','mimetype','created','version']),...jiraVisibilityMetadata(v,false),author:resolveActor(v.author)});}
    else if(name==='CustomFieldValue'){handled.add(name);const issue=context.byId.get(`issue:${str(v.issue)}`),fieldId=str(v.customfield);if(!issue){context.warn('CUSTOM_FIELD_ISSUE_MISSING','사용자 정의 필드 값의 이슈가 없습니다.',null,path,'error');continue;}const fields=issue.metadata.fields as Record<string,LegacyValue>,value=jsonValue(Object.fromEntries(['stringvalue','textvalue','numbervalue','datevalue','parentkey','valuetype'].filter(name=>v[name]!==undefined).map(name=>[name,v[name]]))),previous=fields[fieldId];fields[fieldId]=previous===undefined?[value]:[...(Array.isArray(previous)?previous:[previous]),value];issue.references.push(...ref('field',fieldId,'customField'));if(!Object.keys(obj(value)).length)context.warn('CUSTOM_FIELD_VALUE_EMPTY','필드 값 행은 있지만 실제 값이 비어 있습니다.',issue.id);
      const role = projectedFields.get(fieldId);
      if (role) context.scheduleDates.observe(issue,role,fieldId,adminXmlDateValue(node,v),path);
    }
    else if(name==='IssueLink'){handled.add(name);const type=linkTypes.get(str(v.linktype)),sourceId=str(v.source),targetId=str(v.destination);context.put('relation',v.id,{title:str(type?.linkname||type?.name)||'업무 연결',containerId:sourceId||null,metadata:{typeId:str(v.linktype),...selected(type||{},['inward','outward','style'])},references:[...ref('issue',sourceId,'source'),...ref('issue',targetId,'target')]});if(str(type?.style)==='jira_subtask'){const target=context.byId.get(`issue:${targetId}`);if(target){target.parentId=sourceId;target.references.push(...ref('issue',sourceId,'parent'));}}}
    else if(name==='RemoteIssueLink'){handled.add(name);const url=context.url(v.url),author=resolveActor(v.author);const references=ref('issue',v.issueid||v.issue,'source');if(url){const pageId=new URL(url).searchParams.get('pageId');if(pageId)references.push(...ref('page',pageId,'externalDocument'));}context.put('relation',`remote:${str(v.id)}`,{title:str(v.title)||'외부 연결',authorId:author,containerId:str(v.issueid||v.issue)||null,metadata:{url,relationship:str(v.relationship),globalId:str(v.globalid)},references});}
    else if(name==='Worklog'){handled.add(name);const author=resolveActor(v.author);context.put('history',`worklog:${str(v.id)}`,{title:'작업 시간 기록',containerId:str(v.issue)||null,authorId:author,createdAt:context.date(v.created),updatedAt:context.date(v.updated),text:str(v.body),textFormat:'plain',metadata:{kind:'worklog',...selected(v,['started','startDate','startdate','timeworked','timeSpentSeconds','timeSpent','role','roleId','roleKey','rolelevel','roleLevel','group','groupId','groupKey','groupName','grouplevel','groupLevel','visibility','restriction','restrictions','restricted','isRestricted','hasRestrictions','restrictionType','restrictionValue','viewRole','viewRoleLevel','viewGroup','viewGroupLevel','permissions'])},references:[...ref('issue',v.issue,'worklogOf'),...ref('identity',author,'author')]});}
    else if(name==='Label'){handled.add(name);const issue=context.byId.get(`issue:${str(v.issue)}`);if(issue){const fields=issue.metadata.fields as Record<string,LegacyValue>;fields.labels=[...(Array.isArray(fields.labels)?fields.labels:[]),str(v.label)];}else context.warn('LABEL_ISSUE_MISSING','라벨의 이슈가 없습니다.',null,path);}
    else if (name === 'Version' || name === 'ProjectVersion') {
      handled.add(name);
      const id = versionIdentifier(v.id);
      if (id) declareVersion(context, { id, project: versionIdentifier(v.project), title: str(v.vname || v.name),
        description: str(v.description), source: v }, path);
      else context.warn('JIRA_VERSION_ID_MISSING', 'Jira 버전의 원본 ID를 확인할 수 없어 릴리스 변환을 보류합니다.', null, path);
    }
    else if (name === 'Component') {handled.add(name);const fieldId='builtin:components';context.field(fieldId,name,'jira-builtin');context.ensure('option',`${fieldId}:${str(v.id)}`,{title:str(v.cname||v.name)||str(v.id),containerId:fieldId,text:str(v.description),textFormat:'plain',metadata:selected(v,['id','project','released','archived','startdate','releasedate']),references:[...ref('field',fieldId,'field'),...ref('project',v.project,'project')]});}
    else if (name === 'NodeAssociation') {
      handled.add(name);
      const destination=str(v.sinkNodeId||v.destNodeId), source=str(v.sourceNodeId), kind=str(v.sinkNodeEntity||v.destNodeEntity);
      const isVersion = kind === 'Version' || kind === 'ProjectVersion';
      context.put('relation',`association:${source}:${kind}:${destination}:${str(v.associationType)}`,{title:str(v.associationType)||'항목 연결',metadata:selected(v,['sourceNodeEntity','sinkNodeEntity','destNodeEntity','associationType']),references:[...ref('issue',source,'source'),...ref('option',kind==='Component'?`builtin:components:${destination}`:isVersion?versionOptionId(destination):destination,'target')]});
      const issue = context.byId.get(`issue:${source}`);
      if (issue && v.associationType === 'IssueFixVersion') {
        const id = versionIdentifier(destination);
        const unambiguousTarget = (!v.sinkNodeId || !v.destNodeId || v.sinkNodeId === v.destNodeId) &&
          (!v.sinkNodeEntity || !v.destNodeEntity || v.sinkNodeEntity === v.destNodeEntity);
        if (v.sourceNodeEntity === 'Issue' && isVersion && id && unambiguousTarget) recordFixVersion(context, issue, id);
        else unresolvedFixVersion(context, issue, path);
      }
    }
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
  for (const path of paths.filter(path => posix.basename(path).toLowerCase() === 'activeobjects.xml')) {
    const root = parseLegacyXml(decodeLegacyText(files.get(path)!));
    const sprintTables = root.name === 'backup' && context.dataset.source.format === 'jira-backup-xml'
      ? root.children.filter(node => context.sprints.readActiveObjects(node, path)) : [];
    const consumed = new Set(sprintTables);
    const pending = [root];
    let unsupported = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (consumed.has(node)) continue;
      if (node.attributes.tableName || node.name === 'table') {
        const table = node.attributes.tableName || node.attributes.name || 'table';
        if (!sprintTables.length || table !== 'AO_60DB71_SPRINT' || node.name !== 'table') {
          context.unsupported(`activeobjects:${table}`, Math.max(1, node.children.filter(child => child.name === 'row').length));
          unsupported++;
        }
      }
      for (const child of node.children) pending.push(child);
    }
    if (!unsupported && !sprintTables.length) context.unsupported('activeobjects.xml');
    if (unsupported || !sprintTables.length) context.warn('ACTIVEOBJECTS_NOT_CONVERTED', '추가 Active Objects 플러그인 데이터의 종류와 개수를 기록했습니다.', null, path);
  }
  if(context.dataset.unsupported.some(item=>item.type.startsWith('json-field:')))context.warn('JSON_FIELDS_NOT_NORMALIZED','일부 JSON 필드는 정규화하지 않았으며 종류·개수를 별도로 기록했습니다.');
  return context.finish();
}
