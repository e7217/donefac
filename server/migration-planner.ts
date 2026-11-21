import { createHash,randomUUID } from 'node:crypto';
import type { AttachmentVersion,ConfluenceMigrationDocumentField,ConfluenceMigrationDocumentReview,ConfluenceMigrationDocumentValues,ConfluenceMigrationPageFieldHashes,CustomFieldDefinition,CustomFieldKind,CustomFieldValue,DocPage,Issue,JiraMigrationCustomFieldHashes,JiraMigrationIssueField,JiraMigrationIssueFieldHashes,JiraMigrationIssueReview,JiraMigrationIssueValues,LegacyRecord,LegacyValue,MigrationConfiguration,MigrationNotice,MigrationOptions,MigrationValueOption,Project,ProjectIssueSchema,ProjectWorkflow,RichContent,SourceRecordArchive,StatusCategory } from '../shared/types.js';
import { CONFLUENCE_MIGRATION_DOCUMENT_FIELDS,ISSUE_TYPES,JIRA_MIGRATION_ISSUE_FIELDS,PRIORITY } from '../shared/types.js';
import { defaultIssueSchema, fieldApplies, fieldValueLabel, visibleIssueFieldIds } from '../shared/issue-schema.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import { isCalendarDate } from '../shared/calendar.js';
import { documentLabelKey, MAX_DOCUMENT_LABELS, normalizeDocumentLabel, normalizeDocumentLabels } from '../shared/document-labels.js';
import { contentReferences } from '../shared/document-nodes.js';
import { convertLegacyContent } from './migration-content.js';
import { confluenceSectionAliases, legacySectionId } from './migration-confluence-sections.js';
import { isJiraWorklog,parseJiraWorklog, type ParsedJiraWorklog } from './migration-worklog.js';
import type { MigrationPageIdentity, MigrationReferenceInput } from './migration-content.js';
import { safeFilename } from './attachments.js';
import type { MigrationConfluenceKnownAttachment,MigrationJiraRefreshCandidate,MigrationPackage,MigrationPageAppendContext,MigrationPlanningInput,PreparedMigration } from './migration-contracts.js';
import { isWithinMigrationOrigin, migrationOriginLink, parseMigrationOriginBase, type MigrationOriginBase } from './migration-origin-links.js';
import { confluenceHistoryPage } from './source-preservation.js';
import { jiraCustomRawField, jiraCustomSourceFieldAliases, jiraCustomSourceFieldId, jiraCustomValueDigest } from './migration-jira-fields.js';
import { jiraRenderedHtmlDescription, projectJiraDescription } from './migration-jira-description.js';
import { jiraAdministratorFixAssociation, jiraReleaseVersionId, planJiraReleases } from './migration-jira-releases.js';
import { jiraSprintCatalogId, planJiraSprints } from './migration-jira-sprints.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import { isRestrictedJiraAttachment, isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, isRestrictedJiraStatusHistory, jiraAttachmentFileEvidence, jiraAttachmentOwnerAliases, jiraAttachmentSourceId, jiraHistoryKind, jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import { jiraIssueRelationSource, jiraRelationEndpoints, sameJiraRelationType, type JiraIssueRelationSource } from './migration-jira-relations.js';
import { isTeamspaceIssueRelation } from '../shared/issue-relations.js';
import type { MigrationPreview } from '../shared/types.js';

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
const jiraScheduleEndpoints = ['startDate', 'endDate'] as const;
type JiraScheduleEndpoint = typeof jiraScheduleEndpoints[number];
const jiraScheduleLabels = { startDate: '시작일', endDate: '종료일' } satisfies Record<JiraScheduleEndpoint, string>;
const projectedJiraDate = (row: LegacyRecord, field: JiraScheduleEndpoint): unknown => object(row.metadata.jiraProjectedDates)[field];
function sourceField(row:LegacyRecord,...names:string[]):unknown{const fields=fieldMap(row);const name=Object.keys(fields).find(name=>names.some(candidate=>normalizedName(name)===normalizedName(candidate)));return name===undefined?undefined:fields[name];}
function sourceBuiltin(row: LegacyRecord, kind: 'status' | 'issuetype') {
  const raw = scalar(sourceField(row, kind, kind === 'issuetype' ? 'type' : 'status') ?? row.metadata[kind]);
  const item = object(raw);
  return { value: string(item.id) || string(item.value) || string(item.name) || string(item.text) || string(raw) || '__unspecified__',
    label: string(item.name || item.text || item.value) };
}
function builtin(pkg:MigrationPackage,row:LegacyRecord,kind:'status'|'issuetype',index?:Map<string,LegacyRecord>):{value:string;label:string}{
  const { value, label } = sourceBuiltin(row, kind);
  const option=index?index.get(`option:builtin:${kind}:${value}`):pkg.dataset.records.find(option=>option.kind==='option'&&option.sourceId===`builtin:${kind}:${value}`);return{value,label:label||option?.title||(value==='__unspecified__'?(kind==='status'?'상태 미지정':'유형 미지정'):value)};
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
    const projectedSources = new Map<string, JiraScheduleEndpoint>();
    if (pkg.dataset.source.product === 'jira') for (const row of pkg.dataset.records) {
      for (const field of jiraScheduleEndpoints) {
        const id = object(row.metadata.jiraProjectedDateSources)[field];
        if (typeof id === 'string') projectedSources.set(id, field);
      }
    }
    for(const row of pkg.dataset.records){if(row.kind==='project')containerRows.set(row.sourceId,{issueCount:0,documentCount:0});if(row.kind==='identity')identityIds.add(row.sourceId);if(row.authorId)identityIds.add(row.authorId);for(const ref of row.references)if(ref.kind==='identity')identityIds.add(ref.sourceId);}
    for(const row of pkg.dataset.records){if(row.kind==='issue'||row.kind==='page'){const id=containerFor(pkg,row,index),count=containerRows.get(id)||{issueCount:0,documentCount:0};if(row.kind==='issue'){count.issueCount++;const state=builtin(pkg,row,'status',index),type=builtin(pkg,row,'issuetype',index);statusValues.set(state.value,state.label);typeValues.set(type.value,type.label);}else count.documentCount++;containerRows.set(id,count);}if(customField(row)){
      const projectedDate = projectedSources.get(row.sourceId);
      fields.push({ id: optionId(pkg.summary.id,'field',row.sourceId), packageId:pkg.summary.id,
        sourceValue:row.sourceId, label:row.title||row.sourceId, suggestedKind: projectedDate ? 'archive' : suggestedKind(row),
        ...(projectedDate ? { projectedDate } : {}) });
    }}
    for(const[sourceProjectId,count]of containerRows){const row=index.get(`project:${sourceProjectId}`),name=row?.title||(sourceProjectId==='__unassigned__'?'원본 프로젝트 미지정':sourceProjectId);containers.push({id:optionId(pkg.summary.id,'container',sourceProjectId),packageId:pkg.summary.id,sourceProjectId,name,proposedKey:proposedKey(string(row?.metadata.key||row?.metadata.pkey||row?.metadata.spaceKey)||sourceProjectId,pkg.summary.id+sourceProjectId),...count});}
    for(const id of identityIds){const row=index.get(`identity:${id}`);identities.push({id:optionId(pkg.summary.id,'identity',id),packageId:pkg.summary.id,sourceValue:id,label:row?.title||id,email:string(row?.metadata.emailAddress||row?.metadata.email)||null});}
    for(const[value,label]of statusValues)statuses.push({id:optionId(pkg.summary.id,'status',value),packageId:pkg.summary.id,sourceValue:value,label});for(const[value,label]of typeValues)issueTypes.push({id:optionId(pkg.summary.id,'issuetype',value),packageId:pkg.summary.id,sourceValue:value,label});
  }
  const defaultConfiguration:MigrationConfiguration={packageIds:packages.map(pkg=>pkg.summary.id),projects:containers.map(container=>({containerId:container.id,key:container.proposedKey,name:container.name})),users:Object.fromEntries(identities.map(identity=>[identity.id,null])),statuses:Object.fromEntries(statuses.map(state=>[state.id,suggestCategory(state.label)])),issueTypes:Object.fromEntries(issueTypes.map(type=>[type.id,null])),fields:Object.fromEntries(fields.map(field=>[field.id,field.suggestedKind])),sourceBaseUrls:Object.fromEntries(packages.map(pkg=>[pkg.summary.id,null])),timezone:'UTC',datePolicy:'block',excludedRecords:[]};
  return{packages:packages.map(pkg=>structuredClone(pkg.summary)),containers,identities,statuses,issueTypes,fields,defaultConfiguration};
}

function confluenceSourceVersion(row: LegacyRecord): number | null {
  const raw = string(row.metadata.version);
  const version = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(version) && version > 0 ? version : null;
}

function newerConfluencePage(next: LegacyRecord, previous: LegacyRecord, timezone: string, previousTimezone: string): boolean {
  const nextVersion = confluenceSourceVersion(next), previousVersion = confluenceSourceVersion(previous);
  if (nextVersion !== null && previousVersion !== null) return nextVersion > previousVersion;
  const nextTime = sourceTimestamp(next.updatedAt, timezone), previousTime = sourceTimestamp(previous.updatedAt, previousTimezone);
  return nextTime !== null && previousTime !== null && nextTime > previousTime;
}

function sameConfluencePageRevision(next: LegacyRecord, previous: LegacyRecord, timezone: string, previousTimezone: string): boolean {
  const version = confluenceSourceVersion(next);
  if (version === null || version !== confluenceSourceVersion(previous)) return false;
  // A label-only checkpoint becomes the latest raw page for the next refresh.
  if (next.title.trim() !== previous.title.trim() || hasConfluenceBody(next) !== hasConfluenceBody(previous) || next.text !== previous.text) return false;
  if (next.updatedAt === null && previous.updatedAt === null) return true;
  const nextTime = sourceTimestamp(next.updatedAt, timezone), previousTime = sourceTimestamp(previous.updatedAt, previousTimezone);
  return nextTime !== null && previousTime !== null && nextTime >= previousTime;
}

function confluencePageFieldDigest(field: ConfluenceMigrationDocumentField, value: DocPage[ConfluenceMigrationDocumentField]): string {
  return hash(field, JSON.stringify(field === 'labels' ? value ?? [] : value));
}

function confluencePageFieldDigests(values: ConfluenceMigrationDocumentValues): ConfluenceMigrationPageFieldHashes {
  const hashes: ConfluenceMigrationPageFieldHashes = {};
  for (const field of CONFLUENCE_MIGRATION_DOCUMENT_FIELDS) {
    const value = values[field];
    if (value !== undefined) hashes[field] = confluencePageFieldDigest(field, value);
  }
  return hashes;
}

const confluenceRefreshBodyErrors = new Set(['CONFLUENCE_BODY_RELATION_CONFLICT', 'CONFLUENCE_MULTIPLE_BODIES', 'CONFLUENCE_NON_SCALAR_BODY']);
const lossyConfluenceCalloutConversions = new Set([
  'CALLOUT_PRESENTATION_UNSUPPORTED', 'CALLOUT_TITLE_UNSUPPORTED',
  'STATUS_COLOR_UNSUPPORTED', 'STATUS_LABEL_UNSUPPORTED', 'STATUS_PRESENTATION_UNSUPPORTED',
]);
const lossyConfluenceExcerptConversions = new Set([
  'EXCERPT_PARAMETERS_UNSUPPORTED', 'EXCERPT_FIRST_DEFINITION_UNAVAILABLE',
  'EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED', 'UNRESOLVED_EXCERPT_INCLUDE',
]);
const lossyConfluenceConversions = new Set([
  'RAW_CONTENT_FALLBACK', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_MACRO', 'REMOTE_IMAGE_NOT_EMBEDDED', 'UNSAFE_URL',
  'LINK_TARGET_SHOWN_AS_TEXT', 'ANCHOR_FLATTENED', 'SECTION_LINK_UNRESOLVED', 'TOC_PARAMETERS_UNSUPPORTED',
  'LABEL_LIST_PARAMETERS_UNSUPPORTED', 'LABEL_LIST_SCOPE_UNRESOLVED', 'LEGACY_TOC_REPRESENTATION',
  'LEGACY_LABEL_LIST_REPRESENTATION', 'CHILD_LIST_PARAMETERS_UNSUPPORTED', 'CHILD_LIST_SCOPE_UNRESOLVED',
  'CHILD_LIST_EXCERPT_UNSUPPORTED', 'LEGACY_CHILD_LIST_REPRESENTATION', 'LEGACY_EXCERPT_REPRESENTATION',
  ...lossyConfluenceCalloutConversions, ...lossyConfluenceExcerptConversions,
]);

function usableConfluenceBody(converted: ReturnType<typeof convertLegacyContent>): boolean {
  return !converted.diagnostics.some(item => item.severity === 'error' || item.code.startsWith('UNRESOLVED_') ||
    lossyConfluenceConversions.has(item.code));
}

function hasConfluenceBody(record: LegacyRecord): boolean {
  return record.textFormat === 'confluence-storage' && (record.metadata.bodyPresent === true || record.text.length > 0);
}

function hasConfluenceExcerptMacro(record: LegacyRecord): boolean {
  const macros = record.metadata.macros;
  return Array.isArray(macros) && macros.some(macro => {
    const { name } = object(macro);
    return name === 'excerpt' || name === 'excerpt-include';
  });
}

function previousConfluencePageFieldDigests(archive: SourceRecordArchive, currentContent: DocPage['content']): ConfluenceMigrationPageFieldHashes {
  if (archive.confluencePageFieldHashes) return archive.confluencePageFieldHashes;
  const { record } = archive;
  const title = record.title.trim();
  const values: ConfluenceMigrationDocumentValues = {};
  if (title && title.length <= 300) values.title = title;
  if (hasConfluenceBody(record)) {
    // A legacy archive has no canonical checkpoint. Reconstruct only what can be verified
    // without guessing any of the original page, issue or attachment mappings.
    const resolveReference = () => null;
    const converted = convertLegacyContent(record, { resolveReference });
    if (usableConfluenceBody(converted)) values.content = converted.content;
    const currentHash = confluencePageFieldDigest('content', currentContent);
    if (!values.content || confluencePageFieldDigest('content', values.content) !== currentHash) {
      // An older document can still exactly match a former renderer's conversion.
      const earlierContent = { legacyDocumentChildList: true, legacySectionBaseline: true, legacyDocumentToc: true, legacyDocumentLabelList: true };
      const legacyOptions = [
        ...(hasConfluenceExcerptMacro(record) ? [{}] : []),
        { legacyDocumentChildList: true }, earlierContent, { ...earlierContent, legacyAnnotations: true },
      ];
      for (const options of legacyOptions) {
        const legacy = convertLegacyContent(record, { resolveReference, legacyDocumentExcerpt: true, ...options });
        const exactOldContent = confluencePageFieldDigest('content', legacy.content) === currentHash;
        const safeOldContent = usableConfluenceBody({ ...legacy, diagnostics: legacy.diagnostics.filter(item =>
          !['ANCHOR_FLATTENED', 'ANCHOR_DECLARATION_FLATTENED', 'LEGACY_TOC_REPRESENTATION',
            'LEGACY_LABEL_LIST_REPRESENTATION', 'LEGACY_CHILD_LIST_REPRESENTATION', 'LEGACY_EXCERPT_REPRESENTATION'].includes(item.code)) });
        if (exactOldContent && safeOldContent) { values.content = legacy.content; break; }
      }
    }
  }
  return confluencePageFieldDigests(values);
}

function confluenceReviewExcerpt(value: string): string {
  return value.length > 300 ? `${value.slice(0, 297)}…` : value;
}

function sourceCalendarDate(raw: string, timezone: string): string | null {
  if (isCalendarDate(raw)) return raw;
  const timestamp = sourceTimestamp(raw, timezone);
  if (!timestamp) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function jiraFieldDigest(field: JiraMigrationIssueField, value: Issue[JiraMigrationIssueField], format?: JiraMigrationIssueValues['descriptionFormat']): string {
  // Text-only descriptions keep the same digest as checkpoints written by older versions.
  if (field === 'description' && format === 'markdown') return hash(field, JSON.stringify(['markdown', value]));
  return hash(field, JSON.stringify(Array.isArray(value) ? [...new Set(value)].sort() : value));
}

function jiraFieldDigests(values: JiraMigrationIssueValues): JiraMigrationIssueFieldHashes {
  const result: JiraMigrationIssueFieldHashes = {};
  for (const field of JIRA_MIGRATION_ISSUE_FIELDS) {
    const value = values[field];
    if (value !== undefined) result[field] = jiraFieldDigest(field, value, values.descriptionFormat);
  }
  return result;
}

const jiraCalendarFields = {
  startDate: ['startDate', 'Start date', 'Start'], endDate: ['endDate', 'End date', 'End'], dueDate: ['dueDate', 'due', 'duedate'],
} as const;

function jiraAssignee(row: LegacyRecord): string {
  return row.references.find(reference => reference.kind === 'identity' && reference.relation === 'assignee')?.sourceId ||
    string(scalar(sourceField(row, 'assignee')));
}

function jiraSnapshotValue(row: LegacyRecord, names: readonly string[]): unknown {
  const recent = object(row.metadata.jiraScheduleFields);
  for (const fields of [recent, fieldMap(row), row.metadata]) {
    const key = Object.keys(fields).find(name => names.some(alias => normalizedName(alias) === normalizedName(name)));
    if (key !== undefined) return scalar(fields[key]);
  }
}

function jiraCalendarValue(row: LegacyRecord, field: keyof typeof jiraCalendarFields): unknown {
  const standard = jiraSnapshotValue(row, jiraCalendarFields[field]);
  return standard === undefined && field !== 'dueDate' ? projectedJiraDate(row, field) : standard;
}

function jiraLabels(row: LegacyRecord): unknown {
  if (Array.isArray(row.metadata.jiraSnapshotLabels)) return row.metadata.jiraSnapshotLabels;
  const raw = sourceField(row, 'labels');
  return raw === undefined ? row.metadata.labels : raw;
}

function jiraLabelValues(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return [];
  const labels = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[;,]/) : null;
  if (!labels || !labels.every(label => typeof label === 'string' && label.length <= 60)) return null;
  return [...new Set(labels.filter(label => label.length > 0))];
}

function sameJiraSourceField(field: JiraMigrationIssueField, current: LegacyRecord, previous: LegacyRecord): boolean {
  if (field === 'status' || field === 'type') {
    const kind = field === 'status' ? 'status' : 'issuetype';
    const incoming = sourceBuiltin(current, kind), archived = sourceBuiltin(previous, kind);
    return incoming.value === archived.value || !incoming.label && incoming.value === archived.label ||
      !archived.label && archived.value === incoming.label;
  }
  const identity = (row: LegacyRecord): unknown => {
    switch (field) {
      case 'title': return row.title.trim();
      case 'description': return [row.textFormat, jiraRenderedHtmlDescription(row), row.text];
      case 'priority': {
        const raw = scalar(sourceField(row, 'priority'));
        const item = object(raw);
        return string(item.id || item.name || item.text || raw);
      }
      case 'assigneeId': return jiraAssignee(row);
      case 'labels': {
        const raw = jiraLabels(row);
        return jiraLabelValues(raw)?.sort() ?? raw;
      }
      case 'startDate': case 'endDate': case 'dueDate': {
        const value = jiraCalendarValue(row, field);
        if (value === '') return null;
        const observed = row.metadata.jiraSnapshotFields;
        return value === undefined && Array.isArray(observed) && observed.includes(field) ? null : value;
      }
      case 'estimate': return jiraSnapshotValue(row, ['estimate']) ?? '';
    }
  };
  return JSON.stringify(identity(current)) === JSON.stringify(identity(previous));
}

interface Entry{pkg:MigrationPackage;row:LegacyRecord;key:string;container:string}
type Binding={type:'project'|'issue'|'document'|'comment'|'revision'|'attachment';id:string;projectId:string|null};
type JiraHistoryIssue=Pick<Issue,'id'|'projectId'|'key'|'title'>;
type JiraChildScope = { durable: Map<string, string>; blocked: Set<string>; sourceErrors: Set<string> };
type JiraCustomFieldOption = MigrationOptions['fields'][number];
type JiraCustomFieldReview = NonNullable<JiraMigrationIssueReview['customFields']>[number];
interface JiraCustomFieldConversion {
  timezone: string;
  stagingId: string;
  users: MigrationConfiguration['users'];
  previousValue?: CustomFieldValue;
  originalMapping?: 'generated' | 'existing';
}
type KnownIssue = { issueId: string; projectId: string | null };
type KnownPage = MigrationPageAppendContext['knownPages'][number];
type LabelListProjectScope = { source: string; origin?: string };
type ResolvedReference = { id: string; label: string; url?: string };
type AttachmentOwner = Binding & {type: 'issue' | 'document'};
interface ConfluenceAttachmentSeries {
  sourceRootId: string;
  known: MigrationConfluenceKnownAttachment[];
  entries: Entry[];
}
type PlannedAttachment = { entry: Entry; value: AttachmentVersion; path: string };
type ConfluenceHistoryCandidate = { entry: Entry; sourcePageId: string; owner: KnownPage; version: number | null };
const pageOwnerRelations = new Set(['container-content', 'current-version', 'body-owner']);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function confluenceAttachmentRevision(row: LegacyRecord): number | null {
  const label = string(row.metadata.attachmentVersion ?? row.metadata.version);
  const revision = Number(label);
  return /^\d+$/.test(label) && Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function attachmentFilename(row: LegacyRecord): string {
  return row.title || string(row.metadata.filename || row.metadata.fileName);
}

function attachmentReference(version: AttachmentVersion, label = version.filename): ResolvedReference {
  const inline = imageTypes.has(version.mimeType);
  return { id: version.id, label, url: `/api/attachments/${version.id}/content${inline ? '?inline=1' : ''}` };
}

function confluenceAttachmentLocation(sourcePageId: string, sourceRootId: string): string {
  return JSON.stringify([sourcePageId, sourceRootId]);
}
class Planner{
  options:MigrationOptions;result:PreparedMigration;entries:Entry[]=[];entryByKey=new Map<string,Entry>();bindings=new Map<string,Binding>();excluded=new Set<string>();projectsByContainer=new Map<string,Project>();schemas=new Map<string,ProjectIssueSchema>();workflows=new Map<string,ProjectWorkflow>();notices:MigrationNotice[]=[];noticeKeys=new Set<string>();timezoneValid=true;archiveIds=new Map<string,string>();ownerCache=new Map<string,Entry|null>();indexes=new Map<string,Map<string,LegacyRecord>>();issueById=new Map<string,Issue>();documentById=new Map<string,PreparedMigration['documents'][number]>();primaryById=new Map<string,Entry>();referenceIndex=new Map<string,Entry[]>();resolutionCache=new Map<string,{id:string;label:string;url?:string}|null>();fieldOptions=new Map<string,Map<string,MigrationOptions['fields'][number]>>();sourceOptions=new Map<string,Map<string,LegacyRecord[]>>();
  originBases = new Map<string, MigrationOriginBase>();
  private attachmentRoots = new Map<string, Entry | null>();
  private attachmentVersionsById = new Map<string, AttachmentVersion>();
  private confluenceAttachmentSeries = new Map<string, Map<string, ConfluenceAttachmentSeries>>();
  private confluenceAttachmentPages = new Map<string, string>();
  private excludedConfluenceAttachmentPages = new Set<string>();
  private confluenceAttachmentOwners = new Map<string, AttachmentOwner>();
  private recognizedConfluenceAttachmentEntries = new Map<string, AttachmentVersion>();
  private borrowedAttachmentVersions = new Map<string, AttachmentVersion>();
  private confluenceSpacesByKey = new Map<string, Entry[]>();
  private retainedEntries = new Set<string>();
  private jiraRefreshCheckpoints = new Map<string, { issue: Issue; hashes?: JiraMigrationIssueFieldHashes; customHashes?: JiraMigrationCustomFieldHashes }>();
  private jiraHistoryOwners = new Map<string, JiraHistoryIssue>();
  private knownJiraHistory = new Set<string>();
  private jiraAttachmentOwners = new Map<string, AttachmentOwner>();
  private knownJiraAttachments = new Set<string>();
  private jiraRelationIds = new Map<string, string>();
  private confluenceRefreshCheckpoints = new Map<string, { document: DocPage; hashes: ConfluenceMigrationPageFieldHashes }>();
  private confluenceHistoryOwners = new Map<string, AttachmentOwner>();
  private deferredPrimaryNotices: { message: string; entry?: Entry }[] = [];
  private boundIssues = new Map<string, KnownIssue>();
  private boundPages = new Map<string, KnownPage>();
  private boundPagesByDocument = new Map<string, KnownPage>();
  private confluenceSectionProjections = new Map<Entry, ReadonlyMap<string, string>>();
  private confluenceRefreshSections = new Map<string, Entry[]>();
  private boundPageIdsByTitle = new Map<string, Set<string>>();
  private boundPageTargets = new Set<string>();
  private retainedPageOwners = new Map<string, string | null>();
  private restrictedSourcePages = new Set<string>();
  private labelListProjectScopes?: Map<string, LabelListProjectScope | null>;
  constructor(readonly input:MigrationPlanningInput){this.options=buildMigrationOptions(input.packages);const configuration=structuredClone(input.configuration);this.result={preview:{id:input.id,version:1,actorId:input.actorId,createdAt:input.now,expiresAt:new Date(Date.parse(input.now)+30*60000).toISOString(),configuration,projects:[],counts:{},notices:this.notices,requiredAcknowledgements:[],canApply:false,samples:[]},sourceImport:{id:input.id,version:1,createdAt:input.now,actorId:input.actorId,projectIds:[],configuration,packages:input.packages.map(pkg=>({stagingId:pkg.summary.id,filename:pkg.summary.filename,sha256:pkg.summary.sha256,source:structuredClone(pkg.dataset.source)})),counts:{}},sourceRecords:[],projects:[],workflows:[],issueSchemas:[],issues:[],documents:[],comments:[],revisions:[],worklogs:[],attachments:[],attachmentVersions:[],fileCopies:[],resourceLinks:[],issueRelations:[],atlassianLinks:[]};for(const pkg of input.packages){const index=packageIndex(pkg);this.indexes.set(pkg.summary.id,index);const options=new Map<string,MigrationOptions['fields'][number]>();for(const option of this.options.fields.filter(option=>option.packageId===pkg.summary.id)){options.set(option.sourceValue,option);options.set(option.sourceValue.replace(/^csv:/,''),option);}this.fieldOptions.set(pkg.summary.id,options);const sourceOptions=new Map<string,LegacyRecord[]>();for(const row of pkg.dataset.records){const entry={pkg,row,key:qualified(pkg.summary.id,row),container:containerFor(pkg,row,index)};this.entries.push(entry);this.entryByKey.set(entry.key,entry);if(row.kind==='option'&&row.containerId){const values=sourceOptions.get(row.containerId)||[];values.push(row);sourceOptions.set(row.containerId,values);}if(['page','issue','attachment'].includes(row.kind)){for(const alias of [row.sourceId,...(row.kind==='issue'&&row.metadata.key?[string(row.metadata.key)]:[])]){const key=JSON.stringify([row.kind,'id',alias]),values=this.referenceIndex.get(key)||[];if(!values.includes(entry))values.push(entry);this.referenceIndex.set(key,values);}const key=JSON.stringify([row.kind,'title',row.title]),values=this.referenceIndex.get(key)||[];values.push(entry);this.referenceIndex.set(key,values);}}this.sourceOptions.set(pkg.summary.id,sourceOptions);}}
  notice(code:string,message:string,severity:MigrationNotice['severity']='warning',entry?:Entry,ack=false){if(this.notices.length>=9999){if(this.notices.length===9999)this.notices.push({severity:'error',code:'NOTICE_LIMIT',message:'진단이10000건 한도에 도달했습니다. 누락된 진단을 승인으로 간주하지 않으며 패키지를 나누거나 매핑·제외 조건을 먼저 수정해야 합니다.',recordId:null,requiresAcknowledgement:false});return;}const recordId=entry?.key||null,key=JSON.stringify([code,recordId,message]);if(this.noticeKeys.has(key))return;this.noticeKeys.add(key);this.notices.push({severity,code,message:message.length>2000?`${message.slice(0,1950)} [진단 일부만 표시]`:message,recordId,requiresAcknowledgement:ack});}
  get configuration(){return this.result.preview.configuration;}
  sourceEntry(entry:Entry,kind:string,id:string){return this.entryByKey.get(`${entry.pkg.summary.id}/${kind}:${id}`);}
  private skip(entry: Entry): boolean { return this.excluded.has(entry.key) || this.retainedEntries.has(entry.key); }
  private originalIssue(alias: string): Binding | undefined {
    const issue = this.boundIssues.get(alias);
    return issue && issue.projectId && issue.projectId === this.input.append?.project.id
      ? { type: 'issue', id: issue.issueId, projectId: issue.projectId } : undefined;
  }
  private initializeAppend(): void {
    const append = this.input.append;
    const mapping = this.configuration.appendTo;
    if (!mapping && !append) return;
    if (!mapping || !append || append.project.id !== mapping.projectId) {
      this.notice('APPEND_TARGET_INVALID', '추가 이관할 기존 프로젝트를 확인해 주세요.', 'error');
      return;
    }
    this.result.append = { projectId: append.project.id, token: append.token, startIssueNumber: append.nextIssueNumber };
    for (const { alias, ...issue } of append.knownIssues) this.boundIssues.set(alias, issue);
    for (const container of this.options.containers) {
      if (container.issueCount) this.projectsByContainer.set(container.id, append.project);
    }
    const retainedAliases = new Map<string, KnownIssue>();
    const newRows: Entry[] = [];
    for (const entry of this.entries) {
      if (entry.row.kind !== 'issue' || this.excluded.has(entry.key)) continue;
      const byId = this.boundIssues.get(entry.row.sourceId);
      const key = string(entry.row.metadata.key);
      const byKey = this.boundIssues.get(key);
      if (byId && byKey && byId.issueId !== byKey.issueId) {
        this.notice('SOURCE_BINDING_AMBIGUOUS', 'Jira 원본 ID와 키가 서로 다른 업무에 연결되어 있습니다.', 'error', entry);
      }
      if ([byId, byKey].some(issue => issue?.projectId && issue.projectId !== append.project.id)) {
        this.notice('SOURCE_BINDING_CONFLICT', 'Jira 원본 업무가 다른 팀 프로젝트에 연결되어 있습니다.', 'error', entry);
      }
      const known = byId ?? byKey;
      if (!known) {
        newRows.push(entry);
        continue;
      }
      this.retainedEntries.add(entry.key);
      for (const alias of [entry.row.sourceId, key].filter(Boolean)) {
        const prior = retainedAliases.get(alias);
        if (prior && prior.issueId !== known.issueId) {
          this.notice('SOURCE_BINDING_AMBIGUOUS', '같은 Jira 원본 ID 또는 키가 서로 다른 업무에 연결되어 있습니다.', 'error', entry);
        }
        retainedAliases.set(alias, known);
      }
    }
    for (const entry of newRows) {
      if ([entry.row.sourceId, string(entry.row.metadata.key)].some(alias => retainedAliases.has(alias))) {
        this.notice('SOURCE_BINDING_AMBIGUOUS', '같은 Jira 원본 ID 또는 키의 새 레코드와 기존 레코드가 함께 있습니다.', 'error', entry);
      }
    }
    // A retained row can carry an additional alias when the export format changes.
    // Use it for references within the plan without creating a new source binding.
    for (const [alias, issue] of retainedAliases) if (!this.boundIssues.has(alias)) this.boundIssues.set(alias, issue);
    const retainedIssues = this.retainedEntries.size;
    if (mapping.refreshHistory === true) for (const { kind, sourceId } of append.knownHistory ?? []) {
      this.knownJiraHistory.add(JSON.stringify([kind, sourceId]));
    }
    if (mapping.refreshAttachments === true) for (const { sourceId } of append.knownAttachments ?? []) {
      this.knownJiraAttachments.add(sourceId);
    }
    for (const entry of this.entries) {
      if (entry.row.kind === 'issue' || entry.row.kind === 'relation' || this.excluded.has(entry.key)) continue;
      const owner = this.ownerEntry(entry);
      if (mapping.refreshHistory === true && entry.pkg.dataset.source.product === 'jira' && jiraHistoryKind(entry.row)) {
        const identity = jiraHistorySourceKey(entry.row);
        if (!owner || identity && this.knownJiraHistory.has(JSON.stringify([identity.kind, identity.sourceId]))) {
          this.retainedEntries.add(entry.key);
          continue;
        }
      }
      if (mapping.refreshAttachments === true && entry.pkg.dataset.source.product === 'jira' && entry.row.kind === 'attachment' &&
          (!owner || this.knownJiraAttachments.has(entry.row.sourceId))) {
        this.retainedEntries.add(entry.key);
        continue;
      }
      if (owner ? this.retainedEntries.has(owner.key) : this.hasRetainedOwner(entry)) this.retainedEntries.add(entry.key);
    }
    this.result.preview.counts.retainedIssues = retainedIssues;
    this.result.preview.counts.retainedRecords = this.retainedEntries.size;
    if (retainedIssues) this.notice('APPEND_PRIOR_ISSUES_RETAINED', `이미 이관한 업무 ${retainedIssues}개와 해당 내보내기 원본을 보존합니다.`, 'info');
  }
  private hasRetainedOwner(entry: Entry): boolean {
    const { row } = entry;
    if (!['attachment', 'comment', 'history', 'revision'].includes(row.kind)) return false;
    const ownerReferences = row.references.filter(reference => reference.kind === 'issue' &&
      ['container-content', 'body-owner', 'attachedTo', 'commentOn', 'historyOf', 'worklogOf'].includes(reference.relation));
    return ownerReferences.length
      ? ownerReferences.every(reference => this.boundIssues.has(reference.sourceId))
      : !!row.containerId && this.boundIssues.has(row.containerId);
  }
  private originalJiraIssueDigests(previous: MigrationJiraRefreshCandidate['previous']): JiraMigrationIssueFieldHashes {
    const { archive, stagingId, configuration } = previous;
    if (archive.jiraIssueFieldHashes) return archive.jiraIssueFieldHashes;
    const { record, source } = archive;
    const previousAppend = configuration.appendTo;
    const values: JiraMigrationIssueValues = {};
    if (record.title.trim() && record.title.trim().length <= 300) values.title = record.title.trim();
    const description = convertLegacyContent(record, { resolveReference: () => null, legacyAnnotations: true });
    if (!description.diagnostics.some(item => item.severity === 'error' || item.code === 'RAW_CONTENT_FALLBACK' || item.code.startsWith('UNRESOLVED_'))) {
      values.description = description.plainText;
    }
    const sourceState = sourceBuiltin(record, 'status').value;
    const sourceType = sourceBuiltin(record, 'issuetype').value;
    const stateOption = optionId(stagingId, 'status', sourceState);
    const typeOption = optionId(stagingId, 'issuetype', sourceType);
    if (previousAppend) {
      if (previousAppend.statuses[stateOption]) values.status = previousAppend.statuses[stateOption];
      if (previousAppend.issueTypes[typeOption]) values.type = previousAppend.issueTypes[typeOption];
    } else {
      if (Object.hasOwn(configuration.statuses, stateOption)) values.status = `s_${hash(source.product, source.instanceKey, sourceState).slice(0, 24)}`;
      if (Object.hasOwn(configuration.issueTypes, typeOption)) {
        values.type = configuration.issueTypes[typeOption] || `t_${hash(source.product, source.instanceKey, sourceType).slice(0, 24)}`;
      }
    }
    values.priority = this.priority(sourceField(record, 'priority'));
    const assignee = jiraAssignee(record);
    values.assigneeId = assignee ? configuration.users[optionId(stagingId, 'identity', assignee)] ?? null : null;
    const labels = sourceField(record, 'labels') ?? record.metadata.labels;
    values.labels = [...new Set((Array.isArray(labels) ? labels : typeof labels === 'string' ? labels.split(/[;,]/) : []).map(value => string(value)))];
    for (const [field, names] of Object.entries(jiraCalendarFields) as [keyof typeof jiraCalendarFields, readonly string[]][]) {
      const raw = scalar(sourceField(record, ...names));
      if (raw === undefined || raw === null || raw === '') values[field] = null;
      else {
        const date = sourceCalendarDate(string(raw), configuration.timezone);
        if (date) values[field] = date;
      }
    }
    const rawEstimate = sourceField(record, 'estimate');
    const estimate = rawEstimate === undefined || rawEstimate === null || rawEstimate === '' ? null : Number(rawEstimate);
    values.estimate = estimate !== null && Number.isFinite(estimate) && estimate >= 0 && estimate <= 100000 ? estimate : null;
    return jiraFieldDigests(values);
  }
  private jiraDescription(entry: Entry, issueId: string) {
    return projectJiraDescription(entry.row, {
      resolveReference: request => this.resolve(entry, request),
      ownsAttachment: id => {
        const attachment = this.attachmentVersionsById.get(id);
        return attachment?.resourceType === 'issue' && attachment.resourceId === issueId;
      },
    });
  }
  private jiraRefreshValues(entry: Entry, issueId: string): JiraMigrationIssueValues {
    const { row, pkg } = entry;
    const mapping = this.configuration.appendTo!;
    const { schema, workflow } = this.input.append!;
    const values: JiraMigrationIssueValues = {};
    const hasSnapshotFields = Array.isArray(row.metadata.jiraSnapshotFields);
    const explicit = hasSnapshotFields ? row.metadata.jiraSnapshotFields as unknown[] : [];
    const unavailable = (field: string) => this.notice('JIRA_REFRESH_FIELD_UNAVAILABLE',
      `원본 '${field}' 값을 확인하거나 현재 프로젝트에 매핑할 수 없어 해당 필드를 보존합니다.`, 'warning', entry);
    const title = row.title.trim();
    if (title && title.length <= 300) values.title = title;
    else if (title) unavailable('제목');
    if (explicit.includes('description') || !hasSnapshotFields && (row.text || sourceField(row, 'description') !== undefined)) {
      const description = this.jiraDescription(entry, issueId);
      if (!description.reliable || description.description.length > 200000) unavailable('설명');
      else {
        values.description = description.description;
        values.descriptionFormat = description.descriptionFormat ?? 'plain';
        for (const item of description.diagnostics) this.notice(item.code, item.message, item.severity, entry, item.severity === 'warning');
      }
    }
    const state = sourceBuiltin(row, 'status').value;
    if (state !== '__unspecified__') {
      const id = mapping.statuses[optionId(pkg.summary.id, 'status', state)];
      if (workflow.statuses.some(status => status.id === id)) values.status = id;
      else unavailable('상태');
    }
    const type = sourceBuiltin(row, 'issuetype').value;
    if (type !== '__unspecified__') {
      const id = mapping.issueTypes[optionId(pkg.summary.id, 'issuetype', type)];
      if (schema.issueTypes.some(issueType => issueType.id === id && !issueType.archived)) values.type = id;
      else unavailable('업무 유형');
    }
    const rawPriority = scalar(sourceField(row, 'priority'));
    if (rawPriority !== undefined && rawPriority !== null && rawPriority !== '') {
      const item = object(rawPriority);
      const option = this.sourceEntry(entry, 'option', `builtin:priority:${string(item.id || rawPriority)}`);
      const label = string(item.name || item.text || option?.row.title || rawPriority);
      const priority = this.priority(label);
      if (priority !== 'medium' || /^(?:medium|normal|major|보통|중간)$/i.test(label.trim())) values.priority = priority;
      else unavailable('우선순위');
    }
    const sourceAssignee = jiraAssignee(row);
    if (sourceAssignee) {
      const mapped = this.mappedAuthor(entry, sourceAssignee);
      if (mapped) values.assigneeId = mapped;
      else unavailable('담당자');
    } else if (explicit.includes('assigneeId')) values.assigneeId = null;
    const rawLabels = jiraLabels(row);
    if (rawLabels !== undefined || explicit.includes('labels')) {
      const labels = jiraLabelValues(rawLabels);
      if (labels) values.labels = labels;
      else unavailable('라벨');
    }
    for (const field of [...jiraScheduleEndpoints, 'dueDate'] as const) {
      const raw = jiraCalendarValue(row, field);
      if (raw === undefined && !explicit.includes(field)) continue;
      if (raw === undefined || raw === null || raw === '') values[field] = null;
      else {
        const projected = field !== 'dueDate' && jiraSnapshotValue(row, jiraCalendarFields[field]) === undefined;
        const date = projected ? this.parseProjectedJiraDate(entry, field, raw, 'warning') :
          sourceCalendarDate(string(raw), this.configuration.timezone);
        if (date) values[field] = date;
        else if (!projected) unavailable(field === 'dueDate' ? '마감일' : jiraScheduleLabels[field]);
      }
    }
    const rawEstimate = jiraSnapshotValue(row, ['estimate']);
    if (rawEstimate !== undefined || explicit.includes('estimate')) {
      if (rawEstimate === undefined || rawEstimate === null || rawEstimate === '') values.estimate = null;
      else if ((typeof rawEstimate === 'number' || typeof rawEstimate === 'string') && Number.isFinite(Number(rawEstimate)) &&
          !!String(rawEstimate).trim() && Number(rawEstimate) >= 0 && Number(rawEstimate) <= 100000) values.estimate = Number(rawEstimate);
      else unavailable('예상 작업량');
    }
    return values;
  }
  private jiraReviewValue(field: JiraMigrationIssueField, value: Issue[JiraMigrationIssueField], format?: JiraMigrationIssueValues['descriptionFormat']): string {
    if (value === null || value === '' || Array.isArray(value) && value.length === 0) return '비어 있음';
    const append = this.input.append!;
    let label = Array.isArray(value) ? value.join(', ') : String(value);
    if (field === 'status') label = append.workflow.statuses.find(status => status.id === value)?.label ?? label;
    if (field === 'type') label = append.schema.issueTypes.find(type => type.id === value)?.name ?? label;
    if (field === 'assigneeId') label = this.input.users.find(user => user.id === value)?.name ?? label;
    if (field === 'priority') label = PRIORITY[value as Issue['priority']];
    if (field === 'description' && format === 'markdown') label = `[Markdown]\n${label}`;
    return label.length > 300 ? `${label.slice(0, 297)}…` : label;
  }
  private jiraCustomSourceOptions(entry: Entry, explicitEmpty = false): JiraCustomFieldOption[] {
    const options = this.fieldOptions.get(entry.pkg.summary.id);
    const keys = Object.keys(fieldMap(entry.row));
    const observed = entry.row.metadata.jiraSnapshotCustomFields;
    if (explicitEmpty && Array.isArray(observed)) keys.push(...observed.filter((key): key is string => typeof key === 'string'));
    return [...new Set(keys.map(name => options?.get(name)))].filter(
      (option): option is JiraCustomFieldOption => option !== undefined && jiraCustomRawField(entry.row, option.sourceValue, explicitEmpty) !== undefined,
    );
  }
  private initialJiraCustomFieldHashes(entry: Entry, issue: Issue): JiraMigrationCustomFieldHashes | undefined {
    const definitions = this.schemas.get(issue.projectId)?.fields ?? [];
    const mapping = this.configuration.appendTo?.fields;
    const hashes: JiraMigrationCustomFieldHashes = {};
    const seen = new Set<string>();
    for (const option of this.jiraCustomSourceOptions(entry, true)) {
      const fieldId = mapping ? mapping[option.id] : `f_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,option.sourceValue).slice(0,24)}`;
      const field = definitions.find(field => field.id === fieldId);
      if (!field || field.archived || !fieldApplies(field, issue.type) || !mapping && this.configuration.fields[option.id] !== field.kind) continue;
      const canonical = issue.customFields && Object.hasOwn(issue.customFields, field.id) ? issue.customFields[field.id] : undefined;
      const raw = jiraCustomRawField(entry.row, option.sourceValue);
      const converted = canonical !== undefined && raw !== undefined;
      const observedBlank = canonical === undefined && raw === undefined && jiraCustomRawField(entry.row, option.sourceValue, true) === null;
      if (!converted && !observedBlank) continue;
      if (seen.has(field.id)) { delete hashes[field.id]; continue; }
      seen.add(field.id);
      hashes[field.id] = { sourceFieldId: option.sourceValue, hash: jiraCustomValueDigest(field, canonical) };
    }
    return Object.keys(hashes).length ? hashes : undefined;
  }
  private originalJiraCustomFieldHashes(entry: Entry, previous: MigrationJiraRefreshCandidate['previous'],
    definitions: ReadonlyMap<string, CustomFieldDefinition>): JiraMigrationCustomFieldHashes {
    const { archive, configuration, stagingId } = previous;
    if (archive.jiraCustomFieldHashes) {
      return Object.fromEntries(Object.entries(archive.jiraCustomFieldHashes).filter(([fieldId]) => definitions.has(fieldId)));
    }
    const mappings = new Map<string, { field: CustomFieldDefinition; sourceFieldId: string; raw: LegacyValue }[]>();
    const sourceFields = new Set(Object.keys(fieldMap(archive.record)).flatMap(name => [name, `csv:${name}`]));
    const observed = archive.record.metadata.jiraSnapshotCustomFields;
    if (Array.isArray(observed)) for (const sourceFieldId of observed) if (typeof sourceFieldId === 'string') sourceFields.add(sourceFieldId);
    for (const sourceFieldId of sourceFields) {
      const raw = jiraCustomRawField(archive.record, sourceFieldId, true);
      if (raw === undefined) continue;
      const archivedOptionId = optionId(stagingId, 'field', sourceFieldId);
      const fieldId = configuration.appendTo ? configuration.appendTo.fields[archivedOptionId]
        : `f_${hash(archive.source.product,archive.source.instanceKey,sourceFieldId).slice(0,24)}`;
      const field = fieldId && definitions.get(fieldId);
      if (!field || !configuration.appendTo && configuration.fields[archivedOptionId] !== field.kind) continue;
      const values = mappings.get(field.id) ?? [];
      values.push({ field, sourceFieldId, raw });
      mappings.set(field.id, values);
    }
    const hashes: JiraMigrationCustomFieldHashes = {};
    const conversion: JiraCustomFieldConversion = { timezone: configuration.timezone, stagingId, users: configuration.users,
      originalMapping: configuration.appendTo ? 'existing' : 'generated' };
    for (const candidates of mappings.values()) {
      if (candidates.length !== 1) continue;
      const [{ field, sourceFieldId, raw }] = candidates;
      const value = this.convertField(entry, sourceFieldId, field, raw, conversion);
      if (value !== undefined) hashes[field.id] = { sourceFieldId, hash: jiraCustomValueDigest(field, value) };
    }
    return hashes;
  }
  private reviewJiraCustomFields(entry: Entry, issue: Issue, changes: JiraMigrationIssueValues,
    previous: MigrationJiraRefreshCandidate['previous'], definitions: ReadonlyMap<string, CustomFieldDefinition>):
    { rows: JiraCustomFieldReview[]; hashes?: JiraMigrationCustomFieldHashes; updated: number; conflicts: number } {
    const mapping = this.configuration.appendTo!;
    const schema = this.input.append!.schema;
    const hashes = this.originalJiraCustomFieldHashes(entry, previous, definitions);
    const groups = new Map<string, JiraCustomFieldOption[]>();
    for (const option of this.jiraCustomSourceOptions(entry, true)) {
      const fieldId = mapping.fields[option.id];
      if (!fieldId) continue;
      const group = groups.get(fieldId) ?? [];
      group.push(option);
      groups.set(fieldId, group);
    }
    const currentValues = issue.customFields ?? {};
    const eligible: { field: CustomFieldDefinition; sourceFieldId: string; value: CustomFieldValue; digest: string }[] = [];
    const rows: JiraCustomFieldReview[] = [];
    let reviewed = false, conflicts = 0;
    const label = (field: CustomFieldDefinition, value: CustomFieldValue | undefined): string => {
      const display = fieldValueLabel(field, value, this.input.users) || '비어 있음';
      return display.length > 300 ? `${display.slice(0, 297)}…` : display;
    };
    const unavailable = (name: string) => this.notice('JIRA_REFRESH_CUSTOM_FIELD_UNAVAILABLE',
      `원본 사용자 정의 필드 '${name}' 값을 확인하거나 현재 프로젝트의 필드에 매핑할 수 없어 기존 값을 보존합니다.`, 'warning', entry);
    for (const [fieldId, options] of groups) {
      const [option] = options;
      const field = definitions.get(fieldId);
      if (!field || field.archived || !fieldApplies(field, changes.type ?? issue.type) || options.length !== 1) {
        unavailable(field?.name ?? option.label);
        continue;
      }
      const sourceFieldId = option.sourceValue;
      const raw = jiraCustomRawField(entry.row, sourceFieldId, true)!;
      const before = Object.hasOwn(currentValues, fieldId) ? currentValues[fieldId] : undefined;
      const value = this.convertField(entry, sourceFieldId, field, raw, { timezone: this.configuration.timezone,
        stagingId: entry.pkg.summary.id, users: this.configuration.users, previousValue: before });
      if (value === undefined) { unavailable(field.name); continue; }
      const incomingDigest = jiraCustomValueDigest(field, value);
      const currentDigest = jiraCustomValueDigest(field, before);
      const checkpoint = Object.hasOwn(hashes, fieldId) ? hashes[fieldId] : undefined;
      if (!checkpoint || jiraCustomSourceFieldId(checkpoint.sourceFieldId) !== jiraCustomSourceFieldId(sourceFieldId)) {
        this.notice('JIRA_REFRESH_CUSTOM_FIELD_ORIGIN_UNCONFIRMED',
          `사용자 정의 필드 '${field.name}'의 이전 원본 연결을 확인할 수 없어 기존 값을 보존합니다.`, 'warning', entry);
        continue;
      }
      if (checkpoint.hash === incomingDigest || this.jiraCustomRawAlreadyReviewed(entry, previous, field, checkpoint, raw)) {
        reviewed = true;
        continue;
      }
      if (currentDigest === incomingDigest) {
        hashes[fieldId] = { sourceFieldId, hash: incomingDigest };
        reviewed = true;
        continue;
      }
      if (currentDigest !== checkpoint.hash) {
        rows.push({ fieldId, label: field.name, current: label(field, before), incoming: label(field, value), decision: 'conflict' });
        conflicts++;
        continue;
      }
      eligible.push({ field, sourceFieldId, value, digest: incomingDigest });
    }
    // Conditional fields use the values and workflow state that will actually be applied together.
    const proposed = { ...issue, ...changes, customFields: { ...currentValues, ...Object.fromEntries(eligible.map(({ field, value }) => [field.id, value])) } };
    const visible = visibleIssueFieldIds(schema, proposed);
    const patch: Record<string, CustomFieldValue> = {};
    for (const { field, sourceFieldId, value, digest } of eligible) {
      if (!visible.has(field.id)) { unavailable(field.name); continue; }
      rows.push({ fieldId: field.id, label: field.name, current: label(field, currentValues[field.id]), incoming: label(field, value), decision: 'apply' });
      Object.defineProperty(patch, field.id, { value, enumerable: true });
      hashes[field.id] = { sourceFieldId, hash: digest };
      reviewed = true;
    }
    const updated = Object.keys(patch).length;
    if (updated) changes.customFields = patch;
    return { rows, ...(reviewed && Object.keys(hashes).length ? { hashes } : {}), updated, conflicts };
  }
  private jiraCustomRawAlreadyReviewed(entry: Entry, previous: MigrationJiraRefreshCandidate['previous'], field: CustomFieldDefinition,
    checkpoint: JiraMigrationCustomFieldHashes[string], raw: LegacyValue): boolean {
    const { archive, configuration, stagingId } = previous;
    const candidates = jiraCustomSourceFieldAliases(checkpoint.sourceFieldId).map(sourceFieldId =>
      ({ sourceFieldId, value: jiraCustomRawField(archive.record, sourceFieldId, true) })).filter(candidate => candidate.value !== undefined);
    if (candidates.length !== 1 || JSON.stringify(candidates[0].value) !== JSON.stringify(raw)) return false;
    const { sourceFieldId, value } = candidates[0];
    const archivedOptionId = optionId(stagingId, 'field', sourceFieldId);
    if (configuration.appendTo ? configuration.appendTo.fields[archivedOptionId] !== field.id : configuration.fields[archivedOptionId] !== field.kind) return false;
    // A prior receipt can archive a conflicting incoming value while carrying the older canonical hash forward.
    const previousValue = this.convertField(entry, sourceFieldId, field, value, { timezone: configuration.timezone, stagingId,
      users: configuration.users, originalMapping: configuration.appendTo ? 'existing' : 'generated' });
    return previousValue !== undefined && jiraCustomValueDigest(field, previousValue) === checkpoint.hash;
  }
  private createJiraRefreshes(): void {
    const mapping = this.configuration.appendTo;
    if ((!mapping?.refreshExisting && !mapping?.refreshCustomFields) || !this.input.append) return;
    const append = this.input.append;
    const definitions = new Map(append.schema.fields.map(field => [field.id, field]));
    const candidates = new Map(append.refreshIssues?.map(candidate => [candidate.issue.id, candidate]));
    const sourceErrors = new Set(this.input.packages.flatMap(pkg => pkg.dataset.diagnostics
      .filter(item => item.recordId && item.severity === 'error').map(item => `${pkg.summary.id}/${item.recordId}`)));
    const sourceDateWarnings = new Map<string, string[]>();
    for (const pkg of this.input.packages) for (const diagnostic of pkg.dataset.diagnostics) {
      if (diagnostic.recordId && diagnostic.code === 'JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS') {
        const key = `${pkg.summary.id}/${diagnostic.recordId}`;
        const messages = sourceDateWarnings.get(key) ?? [];
        messages.push(diagnostic.message);
        sourceDateWarnings.set(key, messages);
      }
    }
    const review: JiraMigrationIssueReview[] = [];
    const updates: NonNullable<PreparedMigration['issueUpdates']> = [];
    const seen = new Set<string>();
    let updatedFields = 0, conflictingFields = 0, updatedCustomFields = 0, conflictingCustomFields = 0, skippedIssueUpdates = 0;
    for (const entry of this.entries) {
      if (entry.row.kind !== 'issue' || !this.retainedEntries.has(entry.key)) continue;
      const sourceKey = string(entry.row.metadata.key) || entry.row.sourceId;
      const binding = this.originalIssue(entry.row.sourceId) ?? this.originalIssue(sourceKey);
      const candidate = binding && candidates.get(binding.id);
      if (!candidate || sourceErrors.has(entry.key) || this.restricted(entry)) {
        skippedIssueUpdates++;
        this.notice('JIRA_REFRESH_ISSUE_UNAVAILABLE', '현재 업무 연결이나 접근 범위 또는 원본 자료를 확인할 수 없어 변경분은 적용하지 않습니다.', 'warning', entry);
        continue;
      }
      const { issue, previous, previousCustom } = candidate;
      if (seen.has(issue.id)) {
        this.notice('JIRA_REFRESH_OVERLAPPING_ISSUE', '같은 기존 업무의 기록이 겹칩니다. 패키지에서 적용할 기록 하나를 남겨 주세요.', 'error', entry);
        continue;
      }
      seen.add(issue.id);
      const incomingTimestamp = sourceTimestamp(entry.row.updatedAt, this.configuration.timezone);
      const newer = (source: typeof previous) => {
        const oldTimestamp = sourceTimestamp(source.archive.record.updatedAt, source.configuration.timezone);
        return oldTimestamp !== null && incomingTimestamp !== null && incomingTimestamp > oldTimestamp;
      };
      const customBaseline = previousCustom ?? (previous.archive.jiraCustomFieldHashes ? previous : undefined);
      const reviewStandard = mapping.refreshExisting === true && newer(previous);
      const reviewCustom = mapping.refreshCustomFields === true && customBaseline !== undefined && newer(customBaseline);
      if (!reviewStandard && !reviewCustom) {
        skippedIssueUpdates++;
        this.notice('JIRA_REFRESH_SOURCE_NOT_NEWER', '이관한 원본보다 새로운 수정 시각을 확인할 수 없어 변경분은 적용하지 않습니다.', 'info', entry);
        continue;
      }
      if (reviewStandard) for (const message of sourceDateWarnings.get(entry.key) ?? []) {
        this.notice('SOURCE_JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS', message, 'warning', entry, true);
      }
      if ([reviewStandard ? previous.archive.record.updatedAt : null, reviewCustom ? customBaseline.archive.record.updatedAt : null,
        entry.row.updatedAt].some(value => value && jiraEnglishDate(value)?.century)) {
        this.notice('DATE_TWO_DIGIT_CENTURY','Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.','warning',entry,true);
      }
      const values = reviewStandard ? this.jiraRefreshValues(entry, issue.id) : {};
      const hashes = reviewStandard ? { ...this.originalJiraIssueDigests(previous) } : {};
      const accepted: JiraMigrationIssueValues = {};
      const fields: JiraMigrationIssueReview['fields'] = [];
      let canCheckpoint = false;
      for (const field of JIRA_MIGRATION_ISSUE_FIELDS) {
        const next = values[field];
        if (next === undefined) continue;
        const current = issue[field];
        const incomingHash = jiraFieldDigest(field, next, values.descriptionFormat);
        const currentHash = jiraFieldDigest(field, current, issue.descriptionFormat);
        if (sameJiraSourceField(field, entry.row, previous.archive.record)) {
          canCheckpoint = true;
          continue;
        }
        if (hashes[field] === incomingHash) {
          canCheckpoint = true;
          continue;
        }
        if (currentHash === incomingHash) {
          hashes[field] = incomingHash;
          canCheckpoint = true;
          continue;
        }
        const decision = currentHash === hashes[field] ? 'apply' : 'conflict';
        fields.push({ field, current: this.jiraReviewValue(field, current, issue.descriptionFormat),
          incoming: this.jiraReviewValue(field, next, values.descriptionFormat), decision });
        if (decision === 'apply') {
          Object.assign(accepted, { [field]: next });
          if (field === 'description') accepted.descriptionFormat = values.descriptionFormat ?? 'plain';
          hashes[field] = incomingHash;
          canCheckpoint = true;
          updatedFields++;
        } else conflictingFields++;
      }
      if (accepted.startDate !== undefined || accepted.endDate !== undefined) {
        const start = accepted.startDate === undefined ? issue.startDate : accepted.startDate;
        const end = accepted.endDate === undefined ? issue.endDate : accepted.endDate;
        if (start && end && start > end) {
          this.notice('ISSUE_DATE_RANGE', '현재 업무와 반영할 날짜를 합치면 시작일이 종료일보다 늦습니다.', 'error', entry);
        }
      }
      const custom = reviewCustom ? this.reviewJiraCustomFields(entry, issue, accepted, customBaseline, definitions) : undefined;
      if (custom) { updatedCustomFields += custom.updated; conflictingCustomFields += custom.conflicts; }
      if (fields.length || custom?.rows.length) review.push({ issueId: issue.id, key: issue.key, sourceKey, fields,
        ...(custom?.rows.length ? { customFields: custom.rows } : {}) });
      if (Object.keys(accepted).length) updates.push({ issueId: issue.id, expectedVersion: issue.version, changes: accepted });
      if (canCheckpoint || custom?.hashes) this.jiraRefreshCheckpoints.set(entry.key, { issue,
        ...(canCheckpoint ? { hashes } : {}), ...(custom?.hashes ? { customHashes: custom.hashes } : {}) });
    }
    if (conflictingFields) {
      this.notice('JIRA_REFRESH_LOCAL_CONFLICT', `팀에서 수정한 필드 ${conflictingFields}개를 보존합니다.`, 'warning', undefined, true);
    }
    if (conflictingCustomFields) {
      this.notice('JIRA_REFRESH_CUSTOM_FIELD_CONFLICT', `팀에서 수정한 사용자 정의 필드 ${conflictingCustomFields}개를 보존합니다.`, 'warning', undefined, true);
    }
    this.result.preview.issueRefresh = review;
    this.result.issueUpdates = updates;
    Object.assign(this.result.preview.counts, { updatedIssues: updates.length, updatedFields, conflictingFields, skippedIssueUpdates });
    if (mapping.refreshCustomFields) Object.assign(this.result.preview.counts, { updatedCustomFields, conflictingCustomFields });
  }
  private originalPage(sourceId: string): KnownPage | undefined {
    const append = this.input.appendPages;
    const page = this.boundPages.get(sourceId);
    return append && page?.projectId === append.project.id && page.sourceSpaceId === append.sourceSpaceId ? page : undefined;
  }
  private createConfluenceRefreshes(): void {
    const append = this.input.appendPages;
    if (!append || this.configuration.appendPagesTo?.refreshExisting !== true) return;
    const candidates = new Map(append.refreshDocuments?.map(candidate => [candidate.document.id, candidate]));
    const sourceErrors = new Set<string>(), sourceBodyErrors = new Set<string>();
    for (const pkg of this.input.packages) for (const item of pkg.dataset.diagnostics) {
      if (!item.recordId || item.severity !== 'error') continue;
      const errors = confluenceRefreshBodyErrors.has(item.code) ? sourceBodyErrors : sourceErrors;
      errors.add(`${pkg.summary.id}/${item.recordId}`);
    }
    const review: ConfluenceMigrationDocumentReview[] = [];
    const updates: NonNullable<PreparedMigration['documentUpdates']> = [];
    const seen = new Set<string>();
    const excludedLabels = this.excludedConfluencePageLabels();
    let updatedDocumentFields = 0, conflictingDocumentFields = 0, skippedDocumentUpdates = 0;
    for (const entry of this.entries) {
      const { row } = entry;
      if (row.kind !== 'page' || !this.retainedEntries.has(entry.key)) continue;
      const binding = this.originalPage(row.sourceId);
      const candidate = binding && candidates.get(binding.documentId);
      if (!candidate || candidate.document.projectId !== append.project.id || candidate.previous.targetId !== binding.documentId ||
          candidate.previous.source.product !== 'confluence' || candidate.previous.source.instanceKey !== entry.pkg.dataset.source.instanceKey ||
          candidate.previous.record.sourceId !== row.sourceId || sourceErrors.has(entry.key) ||
          this.restrictedSourcePages.has(row.sourceId) || this.restricted(entry)) {
        skippedDocumentUpdates++;
        this.notice('CONFLUENCE_REFRESH_PAGE_UNAVAILABLE', '현재 문서 연결이나 접근 범위 또는 원본 자료를 확인할 수 없어 원본만 보관합니다.', 'warning', entry);
        continue;
      }
      const { document, previous, previousTimezone } = candidate;
      if (seen.has(document.id)) {
        this.notice('CONFLUENCE_REFRESH_OVERLAPPING_PAGE', '같은 기존 문서의 기록이 겹칩니다. 패키지에서 적용할 페이지 기록 하나를 남겨 주세요.', 'error', entry);
        continue;
      }
      seen.add(document.id);
      const timezone = this.configuration.timezone;
      const newer = newerConfluencePage(row, previous.record, timezone, previousTimezone);
      const sameRevision = !newer && row.metadata.labelSetComplete === true && !sourceBodyErrors.has(entry.key) &&
        sameConfluencePageRevision(row, previous.record, timezone, previousTimezone);
      if (!newer && !sameRevision) {
        skippedDocumentUpdates++;
        this.notice('CONFLUENCE_REFRESH_SOURCE_NOT_NEWER', '이관한 원본보다 새로운 버전 또는 수정 시각을 확인할 수 없어 원본만 보관합니다.', 'info', entry);
        continue;
      }
      const title = row.title.trim();
      if (newer && (!title || title.length > 300)) {
        this.notice('CONFLUENCE_REFRESH_TITLE_UNAVAILABLE', '원본 제목이 비어 있거나 300자를 초과해 현재 제목을 보존합니다.', 'warning', entry);
      }
      const needsBodyReview = newer && hasConfluenceBody(row) &&
        (!hasConfluenceBody(previous.record) || row.text !== previous.record.text || hasConfluenceExcerptMacro(row));
      const converted = needsBodyReview && !sourceBodyErrors.has(entry.key)
        ? convertLegacyContent(row, { resolveReference: request => this.resolve(entry, request), sectionLinks: this.confluenceSectionLinks(entry, document.id),
          resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, append.project.id),
          resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, append.project.id) }) : null;
      const safeBody = converted && usableConfluenceBody(converted) ? converted : null;
      if (needsBodyReview && !safeBody) {
        this.notice('CONFLUENCE_REFRESH_BODY_UNAVAILABLE', '본문을 안전하게 변환하거나 원본 참조·첨부를 확인할 수 없어 현재 본문을 보존합니다.', 'warning', entry, true);
        for (const diagnostic of converted?.diagnostics ?? []) {
          if (lossyConfluenceCalloutConversions.has(diagnostic.code) || lossyConfluenceExcerptConversions.has(diagnostic.code) ||
            ['SECTION_LINK_UNRESOLVED', 'TOC_PARAMETERS_UNSUPPORTED',
            'LABEL_LIST_PARAMETERS_UNSUPPORTED', 'LABEL_LIST_SCOPE_UNRESOLVED', 'CHILD_LIST_PARAMETERS_UNSUPPORTED',
            'CHILD_LIST_SCOPE_UNRESOLVED', 'CHILD_LIST_EXCERPT_UNSUPPORTED'].includes(diagnostic.code)) {
            this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry);
          }
        }
      }
      const values: ConfluenceMigrationDocumentValues = {};
      if (newer && title && title.length <= 300) values.title = title;
      if (safeBody) {
        values.content = safeBody.content;
        for (const diagnostic of safeBody.diagnostics) this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
      }
      const hashes = { ...previousConfluencePageFieldDigests(previous, document.content) };
      const currentLabels = document.labels ?? [];
      const status = string(row.metadata.contentStatus).trim().toLowerCase();
      const labels = !status || status === 'current'
        ? this.confluenceDocumentLabels(entry, excludedLabels.get(entry.key), true) : { values: [], complete: false };
      if (labels.complete) values.labels = labels.values;
      else if (newer && labels.values.length) {
        const present = new Set(currentLabels.map(documentLabelKey));
        const additions = labels.values.filter(label => !present.has(documentLabelKey(label)));
        if (additions.length) {
          const combined = normalizeDocumentLabels([...currentLabels, ...additions]);
          if (combined) values.labels = combined;
          else this.notice('CONFLUENCE_REFRESH_LABEL_LIMIT', '기존 문서 라벨을 유지한 채 추가하면 개수 제한을 넘으므로 현재 라벨을 보존합니다.', 'warning', entry, true);
        }
      }
      const accepted: ConfluenceMigrationDocumentValues = {};
      const fields: ConfluenceMigrationDocumentReview['fields'] = [];
      let checkpoint = false;
      for (const field of CONFLUENCE_MIGRATION_DOCUMENT_FIELDS) {
        const incoming = values[field];
        if (incoming === undefined) continue;
        const currentHash = confluencePageFieldDigest(field, document[field]);
        const incomingHash = confluencePageFieldDigest(field, incoming);
        if (hashes[field] === incomingHash || field === 'title' && title === previous.record.title.trim()) {
          checkpoint = true;
          continue;
        }
        if (incomingHash === currentHash) {
          hashes[field] = incomingHash;
          checkpoint = true;
          continue;
        }
        const decision = currentHash === hashes[field] ? 'apply' : 'conflict';
        const current = field === 'title' ? document.title : field === 'labels' ? currentLabels.join('\n') || '—' : document.plainText;
        const incomingText = field === 'title' ? title : field === 'labels' ? values.labels!.join('\n') || '—' : safeBody!.plainText;
        fields.push({ field, current: field === 'labels' ? current : confluenceReviewExcerpt(current),
          incoming: field === 'labels' ? incomingText : confluenceReviewExcerpt(incomingText), decision,
          ...(field === 'content' && current === incomingText ? { formatOnly: true } : {}) });
        if (field === 'labels' && sameRevision && decision === 'apply') this.notice('CONFLUENCE_REFRESH_LABEL_SAME_REVISION',
          '같은 페이지 버전에서 라벨 목록만 비교했습니다. 반영 전에 내보내기 순서를 확인해 주세요.', 'warning', entry, true);
        if (decision === 'apply') {
          Object.assign(accepted, { [field]: incoming });
          hashes[field] = incomingHash;
          checkpoint = true;
          updatedDocumentFields++;
        } else conflictingDocumentFields++;
      }
      if (fields.length) review.push({ documentId: document.id, title: document.title, sourceId: row.sourceId, recordId: entry.key, fields });
      if (Object.keys(accepted).length) updates.push({ documentId: document.id, expectedVersion: document.version, changes: accepted });
      if (checkpoint) this.confluenceRefreshCheckpoints.set(entry.key, { document, hashes });
    }
    if (conflictingDocumentFields) {
      this.notice('CONFLUENCE_REFRESH_LOCAL_CONFLICT', `팀에서 수정한 문서 필드 ${conflictingDocumentFields}개를 보존합니다.`, 'warning', undefined, true);
    }
    this.result.preview.documentRefresh = review;
    this.result.documentUpdates = updates;
    Object.assign(this.result.preview.counts, { updatedDocuments: updates.length, updatedDocumentFields, conflictingDocumentFields, skippedDocumentUpdates });
  }
  private initializePageAppend(): void {
    const append = this.input.appendPages;
    const mapping = this.configuration.appendPagesTo;
    if (!append && !mapping) return;
    const instance = this.input.packages[0]?.dataset.source.instanceKey;
    const containers = this.options.containers.filter(container => container.documentCount > 0);
    if (!append || !mapping || this.configuration.appendTo || append.project.id !== mapping.projectId || !instance ||
        this.input.packages.some(({ dataset }) => dataset.source.product !== 'confluence' || dataset.source.instanceKey !== instance) ||
        (!containers.length && mapping.refreshHistory !== true) || containers.some(container => container.sourceProjectId !== append.sourceSpaceId)) {
      this.notice('APPEND_PAGE_TARGET_INVALID', '같은 Confluence 공간에 연결된 기존 프로젝트를 확인해 주세요.', 'error');
      return;
    }
    this.result.appendPages = { projectId: append.project.id, token: append.token,
      ...(append.labelListScope ? { labelListInventory: true } : {}),
      ...(append.sectionInventory ? { sectionInventory: true } : {}) };
    for (const page of append.knownPages) {
      this.boundPages.set(page.sourceId, page);
      if (page.sourceSpaceId !== append.sourceSpaceId) continue;
      if (page.projectId === append.project.id) {
        this.boundPageTargets.add(page.documentId);
        this.boundPagesByDocument.set(page.documentId, page);
      }
      if (!page.sourceTitle) continue;
      const ids = this.boundPageIdsByTitle.get(page.sourceTitle) ?? new Set<string>();
      ids.add(page.sourceId);
      this.boundPageIdsByTitle.set(page.sourceTitle, ids);
    }
    for (const container of this.options.containers) {
      if (container.sourceProjectId === append.sourceSpaceId) this.projectsByContainer.set(container.id, append.project);
    }

    const refreshByDocument = new Map(append.refreshDocuments?.map(candidate => [candidate.document.id, candidate]));
    for (const entry of this.entries) {
      if (entry.row.kind !== 'page' || this.excluded.has(entry.key)) continue;
      const page = this.boundPages.get(entry.row.sourceId);
      if (!page) continue;
      if (page.sourceSpaceId && page.sourceSpaceId !== append.sourceSpaceId) {
        this.notice('SOURCE_PAGE_SPACE_CONFLICT', '같은 Confluence 페이지 ID가 다른 원본 공간에 연결되어 있습니다.', 'error', entry);
      }
      this.retainedEntries.add(entry.key);
      const refresh = refreshByDocument.get(page.documentId);
      if (refresh && hasConfluenceBody(entry.row) && entry.row.text !== refresh.previous.record.text &&
          newerConfluencePage(entry.row, refresh.previous.record, this.configuration.timezone, refresh.previousTimezone)) {
        const refreshes = this.confluenceRefreshSections.get(page.documentId) ?? [];
        refreshes.push(entry);
        this.confluenceRefreshSections.set(page.documentId, refreshes);
      }
    }
    const retainedPages = this.retainedEntries.size;
    const refreshHistory = mapping.refreshHistory === true;
    const knownHistoryIds = new Set(refreshHistory ? append.knownHistory?.map(row => JSON.stringify([row.kind, row.sourceId])) : []);
    for (const entry of this.entries) {
      if (!['attachment', 'comment', 'revision'].includes(entry.row.kind) || this.excluded.has(entry.key)) continue;
      const owner = this.ownerEntry(entry);
      const history = refreshHistory && (entry.row.kind === 'comment' || entry.row.kind === 'revision');
      const knownHistory = history && knownHistoryIds.has(JSON.stringify([entry.row.kind, entry.row.sourceId]));
      const originalOwner = history && confluenceHistoryPage(entry.row, (kind, id) => this.sourceEntry(entry, kind, id)?.row);
      if (knownHistory || (originalOwner && this.boundPages.has(originalOwner)) || (history && !owner) ||
          (owner ? this.retainedEntries.has(owner.key) : this.retainedPageOwner(entry))) this.retainedEntries.add(entry.key);
    }
    this.result.preview.counts.retainedPages = retainedPages;
    this.result.preview.counts.retainedRecords = this.retainedEntries.size;
    if (this.retainedEntries.size) this.notice('APPEND_PRIOR_PAGES_RETAINED', `기존 페이지 ${retainedPages}개를 포함한 원본 기록 ${this.retainedEntries.size}건을 보관합니다.`, 'info');
    this.indexConfluenceRestrictions();
  }
  private indexConfluenceRestrictions(): void {
    const children = new Map<string, string[]>();
    for (const entry of this.entries) {
      if (entry.row.kind !== 'page') continue;
      const { sourceId, parentId, references } = entry.row;
      if (this.restricted(entry)) this.restrictedSourcePages.add(sourceId);
      const ancestors = new Set(references.filter(reference => reference.kind === 'page' && reference.relation === 'ancestor').map(reference => reference.sourceId));
      if (parentId) ancestors.add(parentId);
      for (const ancestor of ancestors) {
        const values = children.get(ancestor) ?? [];
        values.push(sourceId);
        children.set(ancestor, values);
      }
    }
    // Confluence analysis propagates restrictions within one export. A parent and child may be in separate selected exports.
    const queue = [...this.restrictedSourcePages];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const child of children.get(queue[cursor]) ?? []) {
        if (this.restrictedSourcePages.has(child)) continue;
        this.restrictedSourcePages.add(child);
        queue.push(child);
      }
    }
  }
  private retainedPageOwner(entry: Entry): boolean {
    if (this.retainedPageOwners.has(entry.key)) return this.retainedPageOwners.get(entry.key) !== null;
    const pending = [entry], visited = new Set<string>(), owners = new Set<string>();
    for (let index = 0; index < pending.length && owners.size < 2; index++) {
      const candidate = pending[index];
      if (visited.has(candidate.key)) continue;
      visited.add(candidate.key);
      const cached = this.retainedPageOwners.get(candidate.key);
      if (cached) {
        owners.add(cached);
        continue;
      }
      for (const reference of candidate.row.references) {
        if (!pageOwnerRelations.has(reference.relation)) continue;
        if (reference.kind === 'page') owners.add(reference.sourceId);
        else {
          const owner = this.sourceEntry(candidate, reference.kind, reference.sourceId);
          if (owner) pending.push(owner);
        }
      }
      const { orphan, ownerClass, ownerId } = candidate.row.metadata;
      if (orphan === true && typeof ownerId === 'string' && (ownerClass === 'Page' || ownerClass === 'BlogPost')) owners.add(ownerId);
    }
    const ownerId = owners.size === 1 ? [...owners][0] : null;
    const known = ownerId ? this.boundPages.get(ownerId) : undefined;
    const retainedId = known?.sourceSpaceId === this.input.appendPages?.sourceSpaceId ? ownerId : null;
    this.retainedPageOwners.set(entry.key, retainedId);
    return retainedId !== null;
  }
  mappedAuthor(entry:Entry,id=entry.row.authorId):string|null {
    if(!id)return null;
    const option=optionId(entry.pkg.summary.id,'identity',id),mapped=this.configuration.users[option];
    return typeof mapped==='string'&&this.input.users.some(user=>user.id===mapped)?mapped:null;
  }
  author(entry:Entry,id=entry.row.authorId):string{return this.mappedAuthor(entry,id)??this.input.actorId;}
  time(value: string | null, entry: Entry, required = true): string | null {
    if (!value) return required ? this.unknownTime(entry, '원본 시각이 없습니다.') : null;
    const parsed = sourceTimestamp(value, this.configuration.timezone);
    if (parsed && jiraEnglishDate(value)?.century) {
      this.notice('DATE_TWO_DIGIT_CENTURY', 'Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.', 'warning', entry, true);
    }
    return parsed ?? this.unknownTime(entry, '원본 시각을 지정 시간대에서 유일하게 해석할 수 없습니다.');
  }
  unknownTime(entry:Entry,message:string):string{if(this.configuration.datePolicy==='import-time'){this.notice('DATE_IMPORT_TIME',`${message} 현재 이관 시각을 사용하며 원본 문자열은 보존합니다.`,'warning',entry,true);}else this.notice('DATE_UNRESOLVED',message,'error',entry);return this.input.now;}
  project(entry:Entry):Project|undefined{return this.projectsByContainer.get(optionId(entry.pkg.summary.id,'container',entry.container));}
  run():PreparedMigration{this.initialize();if(!this.notices.some(notice=>notice.severity==='error')){this.createPrimary();this.createJiraReleases();this.createJiraSprints();this.createOriginLinks();this.createFiles();this.convertDocuments();this.createJiraRefreshes();this.createConfluenceRefreshes();this.createJiraHistory();this.createSecondary();this.createConfluenceHistory();this.createWorklogs();this.createRelations();this.validateGraph();}this.archive();return this.finish();}
  private jiraPlanningSelections(field: 'jiraReleaseSelections' | 'jiraSprintSelections', code: string, label: string): Record<string, string | null> {
    const choices = this.configuration[field];
    const selections = Object.fromEntries(Object.entries(choices ?? {}).filter(([key]) => {
      const entry = this.entryByKey.get(key);
      if (!entry || entry.row.kind !== 'issue' || entry.pkg.dataset.source.product !== 'jira') {
        this.notice(code, `대표 ${label} 선택의 Jira 원본 업무를 찾을 수 없습니다.`, 'error');
        return false;
      }
      return !this.skip(entry);
    }));
    if (choices) this.configuration[field] = selections;
    return selections;
  }
  private createJiraReleases(): void {
    const selections = this.jiraPlanningSelections('jiraReleaseSelections', 'JIRA_RELEASE_SELECTION_INVALID', '릴리스');
    const catalog: Parameters<typeof planJiraReleases>[0]['catalog'][number][] = [];
    const administratorLinks = new Map<string, string[]>();
    for (const entry of this.entries) {
      const { pkg, row, key } = entry;
      if (pkg.dataset.source.product !== 'jira') continue;
      const association = !this.excluded.has(key) && jiraAdministratorFixAssociation(row);
      if (association) {
        const issueKey = `${pkg.summary.id}/issue:${association.issueId}`;
        const versions = administratorLinks.get(issueKey) ?? [];
        versions.push(association.versionId);
        administratorLinks.set(issueKey, versions);
      }
      if (!jiraReleaseVersionId(row)) continue;
      const sourceProjectId = string(row.metadata.project) || row.references.find(ref => ref.kind === 'project' && ref.relation === 'project')?.sourceId;
      if (!sourceProjectId) continue;
      const target = this.projectsByContainer.get(optionId(pkg.summary.id, 'container', sourceProjectId));
      if (!target) continue;
      const sourceProject = this.sourceEntry(entry, 'project', sourceProjectId);
      catalog.push({ record: row, recordId: key, sourceProjectId, instanceKey: pkg.dataset.source.instanceKey,
        projectId: target.id, excluded: this.excluded.has(key) || Boolean(sourceProject && this.excluded.has(sourceProject.key)) });
    }
    const issues = this.result.issues.flatMap(issue => {
      const entry = this.primaryById.get(issue.id);
      if (!entry || entry.pkg.dataset.source.product !== 'jira') return [];
      return [{ issue, record: entry.row, recordId: entry.key, sourceProjectId: entry.container, projectId: issue.projectId,
        instanceKey: entry.pkg.dataset.source.instanceKey,
        ...(entry.pkg.dataset.source.format === 'jira-backup-xml' ? { administratorIds: administratorLinks.get(entry.key) ?? [] } : {}) }];
    });
    if (!issues.length && !catalog.length) return;
    const { planningItems, choices: releaseChoices, links, unassigned } = planJiraReleases({
      catalog, issues, selections, existing: this.input.append?.planningItems ?? [], append: Boolean(this.input.append),
      now: this.input.now, calendarDate: value => sourceCalendarDate(value, this.configuration.timezone),
      notice: value => this.notice(value.code, value.message, value.severity, this.entryByKey.get(value.recordId), value.severity === 'warning'),
    });
    if (planningItems.length > 20_000) {
      this.notice('JIRA_RELEASE_LIMIT', '한 번에 이관할 수 있는 릴리스 20,000개를 초과했습니다.', 'error');
    }
    if (planningItems.length) this.result.planningItems = planningItems;
    if (releaseChoices.length) this.result.preview.jiraReleaseChoices = releaseChoices;
    if (planningItems.length || links || unassigned) {
      Object.assign(this.result.preview.counts, { jiraReleases: planningItems.length, jiraReleaseLinks: links, jiraReleaseUnassigned: unassigned });
      if (this.result.append && this.input.append?.planningToken) this.result.append.planningToken = this.input.append.planningToken;
    }
  }
  private createJiraSprints(): void {
    const selections = this.jiraPlanningSelections('jiraSprintSelections', 'JIRA_SPRINT_SELECTION_INVALID', '사이클');
    const issues = this.result.issues.flatMap(issue => {
      const entry = this.primaryById.get(issue.id);
      return entry?.pkg.dataset.source.product === 'jira'
        ? [{ issue, record: entry.row, recordId: entry.key, instanceKey: entry.pkg.dataset.source.instanceKey }] : [];
    });
    if (!issues.length) return;
    const catalog = this.entries.flatMap(entry => {
      if (entry.pkg.dataset.source.product !== 'jira' || !jiraSprintCatalogId(entry.row)) return [];
      return [{ record: entry.row, recordId: entry.key, instanceKey: entry.pkg.dataset.source.instanceKey, excluded: this.excluded.has(entry.key) }];
    });
    const { planningItems, choices, links, unassigned, historyOnly } = planJiraSprints({
      catalog, issues, selections, existing: this.input.append?.cyclePlanningItems ?? [],
      now: this.input.now, calendarDate: value => sourceCalendarDate(value, this.configuration.timezone),
      notice: (recordId, code, message, severity = 'warning') =>
        this.notice(code, message, severity, this.entryByKey.get(recordId), severity === 'warning'),
    });
    if (planningItems.length) {
      this.result.planningItems = [...(this.result.planningItems ?? []), ...planningItems];
      if (this.result.planningItems.length > 20_000) {
        this.notice('JIRA_PLANNING_LIMIT', '한 번에 이관할 수 있는 사이클·릴리스 20,000개를 초과했습니다.', 'error');
      }
    }
    if (choices.length) this.result.preview.jiraSprintChoices = choices;
    if (planningItems.length || links || unassigned || historyOnly) {
      Object.assign(this.result.preview.counts, {
        jiraSprints: planningItems.length, jiraSprintLinks: links, jiraSprintUnassigned: unassigned, jiraSprintHistoryOnly: historyOnly,
      });
      if (this.result.append && this.input.append?.cyclePlanningToken) this.result.append.cyclePlanningToken = this.input.append.cyclePlanningToken;
    }
  }
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
    this.initializeAppend();
    this.initializePageAppend();
    if (!config.appendTo && !config.appendPagesTo) {
      for(const option of this.options.statuses)if(!categories.includes(config.statuses[option.id]))this.notice('STATUS_MAPPING_REQUIRED',`원본 상태의 분류를 선택해 주세요: ${option.label}`,'error');
      for(const option of this.options.issueTypes)if(!Object.hasOwn(config.issueTypes,option.id)||config.issueTypes[option.id]!==null&&!ISSUE_TYPES.includes(config.issueTypes[option.id] as typeof ISSUE_TYPES[number]))this.notice('TYPE_MAPPING_REQUIRED',`원본 유형을 기존 유형 또는 새 유형에 매핑해 주세요: ${option.label}`,'error');
      for(const option of this.options.fields)if(config.fields[option.id]!=='archive'&&!fieldKinds.includes(config.fields[option.id] as CustomFieldKind))this.notice('FIELD_MAPPING_REQUIRED',`원본 필드의 처리 방식을 선택해 주세요: ${option.label}`,'error');
      const projectConfigs=new Map<string,MigrationConfiguration['projects'][number]>();for(const mapping of config.projects){if(projectConfigs.has(mapping.containerId)||!this.options.containers.some(container=>container.id===mapping.containerId))this.notice('PROJECT_MAPPING_INVALID','프로젝트 매핑이 중복되거나 원본 컨테이너가 없습니다.','error');projectConfigs.set(mapping.containerId,mapping);}
      const activeContainers=new Set(this.entries.filter(entry=>!this.excluded.has(entry.key)&&(entry.row.kind==='issue'||entry.row.kind==='page')).map(entry=>optionId(entry.pkg.summary.id,'container',entry.container)));const grouped=new Map<string,Project>();for(const container of this.options.containers){const active=activeContainers.has(container.id);if(!active)continue;const mapping=projectConfigs.get(container.id);if(!mapping){this.notice('PROJECT_MAPPING_REQUIRED',`새 프로젝트를 지정해 주세요: ${container.name}`,'error');continue;}const key=string(mapping.key).trim().toUpperCase(),name=string(mapping.name).trim();if(!/^[A-Z][A-Z0-9]{1,11}$/.test(key)||!name||name.length>100){this.notice('PROJECT_MAPPING_INVALID','프로젝트 키는2~12자 영문·숫자, 이름은1~100자여야 합니다.','error');continue;}if(this.input.existingProjectKeys.some(existing=>existing.toUpperCase()===key)){this.notice('PROJECT_KEY_CONFLICT',`기존 프로젝트 키와 충돌합니다: ${key}`,'error');continue;}let project=grouped.get(key);if(project&&project.name!==name){this.notice('PROJECT_NAME_CONFLICT',`같은 프로젝트 키 ${key}에 서로 다른 이름을 지정했습니다.`,'error');continue;}if(!project){project={id:randomUUID(),key,name,description:'기존 도구에서 이관한 프로젝트',color:'#668899',createdAt:this.input.now};grouped.set(key,project);this.result.projects.push(project);}this.projectsByContainer.set(container.id,project);}
    }
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
    if(this.result.appendPages)this.notice('CONFLUENCE_APPEND_ACCESS_NOT_REPRODUCED','추가하는 페이지는 대상 프로젝트의 접근 범위를 따릅니다. 원본에 접근 제한이 있는 콘텐츠는 제외 전까지 적용을 차단합니다.','warning',undefined,true);
    const sourceAliases=new Map<string,string>();for(const entry of this.entries)if(!this.skip(entry)&&['issue','page','project'].includes(entry.row.kind)){const target=this.bindings.get(entry.key)?.id;for(const alias of [entry.row.sourceId,...(entry.row.kind==='issue'&&entry.row.metadata.key?[string(entry.row.metadata.key)]:[])]){const key=JSON.stringify([entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,entry.row.kind,alias]),previous=sourceAliases.get(key);if(previous&&previous!==entry.key&&!(target&&target===this.bindings.get(previous)?.id))this.notice('SOURCE_BINDING_AMBIGUOUS','같은 원본 인스턴스·ID가 여러 적용 대상으로 존재합니다. 겹치는 내보내기를 제외해 주세요.','error',entry);else sourceAliases.set(key,entry.key);}}
    for(const entry of this.entries)if(!this.skip(entry)&&(this.restricted(entry)||entry.row.kind==='page'&&this.restrictedSourcePages.has(entry.row.sourceId)))this.notice('RESTRICTED_CONTENT','권한 또는 공개 범위가 제한된 원본은 현재 서비스에 그대로 공개할 수 없습니다. 해당 객체를 제외해 주세요.','error',entry);
    for(const pkg of this.input.packages){for(const diagnostic of pkg.dataset.diagnostics){
      const recordKey = diagnostic.recordId ? `${pkg.summary.id}/${diagnostic.recordId}` : null;
      if (recordKey && (this.excluded.has(recordKey) || this.retainedEntries.has(recordKey))) continue;
      if (diagnostic.severity !== 'error' || /ATTACHMENT_BYTES_MISSING/.test(diagnostic.code)) continue;
      const entry = recordKey ? this.entryByKey.get(recordKey) : undefined;
      if (diagnostic.code === 'NO_PRIMARY_CONTENT' && (this.result.appendPages && config.appendPagesTo?.refreshHistory === true ||
          this.result.append && (config.appendTo?.refreshHistory === true || config.appendTo?.refreshAttachments === true || config.appendTo?.refreshRelations === true) &&
          pkg.dataset.source.format === 'jira-backup-xml')) {
        this.deferredPrimaryNotices.push({ message: diagnostic.message, entry });
      } else this.notice(`SOURCE_${diagnostic.code}`, diagnostic.message, 'error', entry);
    }
      for(const warning of pkg.dataset.diagnostics.filter(notice=>notice.severity==='warning')){const key=warning.recordId?`${pkg.summary.id}/${warning.recordId}`:null;if(key&&(this.excluded.has(key)||this.retainedEntries.has(key)))continue;if(['DATE_TIMEZONE_UNRESOLVED','CONFLUENCE_TIMEZONE_UNKNOWN','MISSING_REFERENCE','CONFLUENCE_STORAGE_REFERENCES_UNRESOLVED'].includes(warning.code))continue;this.notice(`SOURCE_${warning.code}`,warning.message,'warning',warning.recordId?this.entryByKey.get(`${pkg.summary.id}/${warning.recordId}`):undefined,true);}
      if(pkg.dataset.unsupported.length)this.notice('UNSUPPORTED_SOURCE_RECORDS',`원본 ${pkg.summary.filename}의 미지원 객체/필드는 보관 가능한 분석 결과만 남으며 실행 기능을 재현하지 않습니다.`,'warning',undefined,true);
    }
  }
  restricted(entry:Entry):boolean{
    const row=entry.row,metadata=row.metadata;
    if(entry.pkg.dataset.source.product==='jira'&&(isRestrictedJiraHistory(row)||isRestrictedJiraStatusHistory(row)||isRestrictedJiraAttachment(row)))return true;
    if((row.kind==='page'||row.kind==='comment')&&(metadata.restricted===true||metadata.hasRestrictions===true||Array.isArray(metadata.restrictions)&&metadata.restrictions.length>0||Array.isArray(metadata.permissions)&&metadata.permissions.length>0))return true;
    if(row.kind==='comment'){if(string(metadata.level)||string(metadata.rolelevel)||string(metadata.groupLevel)||string(metadata.roleLevel))return true;const visibility=object(metadata.visibility);if(Object.keys(visibility).length)return true;if(Array.isArray(metadata.visibility)&&metadata.visibility.some(value=>{const property=object(value);return property.key==='sd.public.comment'&&['true',true].includes(object(property.value).internal as string|boolean);}))return true;}
    if(row.kind==='issue'){const security=scalar(sourceField(row,'security','Security Level','Issue Security Level'));if(security!==undefined&&security!==null&&security!==false&&(typeof security==='object'?Object.keys(object(security)).some(key=>!!object(security)[key]):!!string(security)))return true;}
    return false;
  }
  private excludedConfluencePageLabels(): Map<string, Set<string>> {
    const labels = new Map<string, Set<string>>();
    for (const key of this.excluded) {
      const entry = this.entryByKey.get(key);
      if (!entry || entry.pkg.dataset.source.product !== 'confluence' || entry.row.kind !== 'relation' ||
          !['Labelling', 'ContentLabel'].includes(string(entry.row.metadata.sourceClass))) continue;
      const page = entry.row.references.find(reference => reference.kind === 'page' && ['content', 'contentEntity'].includes(reference.relation));
      const label = entry.row.references.find(reference => reference.kind === 'option' && reference.relation === 'label');
      if (!page || !label) continue;
      const pageKey = `${entry.pkg.summary.id}/page:${page.sourceId}`;
      const excluded = labels.get(pageKey) ?? new Set<string>();
      excluded.add(label.sourceId);
      labels.set(pageKey, excluded);
    }
    return labels;
  }
  private confluenceDocumentLabels(entry: Entry, excludedLabels: ReadonlySet<string> | undefined, refreshing = false): { values: string[]; complete: boolean } {
    if (entry.pkg.dataset.source.product !== 'confluence') return { values: [], complete: false };
    const labels = new Map<string, string>();
    const rawIds = entry.row.metadata.confirmedLabelIds;
    const confirmed = refreshing ? new Set(Array.isArray(rawIds) ? rawIds.filter(id => typeof id === 'string') : []) : null;
    let complete = entry.row.metadata.labelSetComplete === true;
    let archivedScope = false, archivedValue = false;
    for (const reference of entry.row.references) {
      if (reference.kind !== 'option' || reference.relation !== 'label') continue;
      const option = this.sourceEntry(entry, 'option', reference.sourceId);
      if (!option || this.skip(option) || excludedLabels?.has(reference.sourceId) || confirmed && !confirmed.has(reference.sourceId)) {
        complete = false;
        continue;
      }
      const { sourceClass, namespace, owner, ownerReference } = option.row.metadata;
      if (sourceClass !== 'Label' || namespace !== 'global' || (owner != null && owner !== '') || ownerReference !== undefined) {
        archivedScope = true;
        continue;
      }
      const label = normalizeDocumentLabel(option.row.title);
      if (label === null) {
        archivedValue = true;
        continue;
      }
      const key = documentLabelKey(label);
      if (labels.has(key)) continue;
      if (labels.size >= MAX_DOCUMENT_LABELS) {
        archivedValue = true;
        continue;
      }
      labels.set(key, label);
    }
    if (archivedScope) this.notice('CONFLUENCE_LABEL_SCOPE_ARCHIVED', '개인용 또는 공용 범위를 확인할 수 없는 문서 라벨은 원본으로 보관합니다.', 'warning', entry, true);
    if (archivedValue) this.notice('CONFLUENCE_LABEL_VALUE_ARCHIVED', '이름이나 개수 제한을 충족하지 않는 문서 라벨은 원본으로 보관합니다.', 'warning', entry, true);
    return { values: [...labels.keys()].sort().map(key => labels.get(key)!), complete: complete && !archivedScope && !archivedValue };
  }
  createPrimary():void{
    for(const project of this.result.projects){this.schemas.set(project.id,{...defaultIssueSchema(project.id,this.input.now),issueTypes:[],fields:[]});this.workflows.set(project.id,{...defaultWorkflow(project.id,this.input.now),statuses:[],transitions:[],fieldRules:[]});}
    const append = this.input.append;
    const mapping = this.configuration.appendTo;
    const issueNumbers=new Map<string,number>();
    const excludedLabels = this.excludedConfluencePageLabels();
    if (append) {
      this.schemas.set(append.project.id, append.schema);
      this.workflows.set(append.project.id, append.workflow);
      issueNumbers.set(append.project.id, append.nextIssueNumber - 1);
    }
    for(const entry of this.entries){if(this.skip(entry)||!['issue','page'].includes(entry.row.kind))continue;const project=this.project(entry);if(!project)continue;const row=entry.row,id=randomUUID();if(!row.title.trim()||row.title.trim().length>300)this.notice('TITLE_INVALID','제목이 비어 있거나300자를 넘습니다. 원본은 보존하지만 현재 객체로 적용할 수 없습니다.','error',entry);const title=row.title.trim().slice(0,300)||'제목 없음',createdAt=this.time(row.createdAt,entry)!,updatedAt=this.time(row.updatedAt,entry,false)||createdAt;
      if (row.kind === 'page') {
        const { values: labels } = this.confluenceDocumentLabels(entry, excludedLabels.get(entry.key));
        const document: DocPage = {
          id, projectId: project.id, parentId: null, title, content: { type: 'doc', content: [{ type: 'paragraph' }] },
          plainText: '', icon: '📄', status: 'published', version: 1, authorId: this.author(entry), createdAt, updatedAt,
          ...(labels.length ? { labels } : {}),
        };
        this.result.documents.push(document);
        this.documentById.set(id, document);
        this.primaryById.set(id, entry);
        this.bindings.set(entry.key, { type: 'document', id, projectId: project.id });
      } else {
        const state = builtin(entry.pkg, row, 'status', this.indexes.get(entry.pkg.summary.id));
        const statusOption = optionId(entry.pkg.summary.id, 'status', state.value);
        const stateId = mapping ? mapping.statuses[statusOption] : `s_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,state.value).slice(0,24)}`;
        const workflow = this.workflows.get(project.id)!;
        const existingState = workflow.statuses.find(status => status.id === stateId);
        const category = mapping ? existingState?.category : this.configuration.statuses[statusOption];
        if (!category) {
          this.notice('APPEND_STATUS_REQUIRED', `원본 상태 '${state.label}'를 기존 프로젝트의 상태에 연결해 주세요.`, 'error', entry);
          continue;
        }
        if (!mapping) {
          if (state.label.length > 40) this.notice('STATUS_LABEL_LIMIT','원본 상태 이름이 현재40자 제한을 넘습니다.','error',entry);
          if (existingState && existingState.category !== category) this.notice('STATUS_MAPPING_CONFLICT','같은 원본 상태를 서로 다른 분류로 매핑했습니다.','error',entry);
          else if (!existingState) workflow.statuses.push({id:stateId,label:state.label,color:'#668899',category});
        }
        const sourceType = builtin(entry.pkg, row, 'issuetype', this.indexes.get(entry.pkg.summary.id));
        const typeOption = optionId(entry.pkg.summary.id, 'issuetype', sourceType.value);
        const mappedType = mapping ? mapping.issueTypes[typeOption] : this.configuration.issueTypes[typeOption];
        const typeId = mapping ? mappedType : mappedType || `t_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,sourceType.value).slice(0,24)}`;
        const schema = this.schemas.get(project.id)!;
        const existingType = schema.issueTypes.find(type => type.id === typeId);
        if (mapping && (!typeId || !existingType || existingType.archived)) {
          this.notice('APPEND_TYPE_REQUIRED', `원본 유형 '${sourceType.label}'를 기존 프로젝트의 활성 업무 유형에 연결해 주세요.`, 'error', entry);
          continue;
        }
        if (!typeId) continue;
        if (!mapping) {
          const typeName = mappedType || sourceType.label;
          if (typeName.length > 120) this.notice('TYPE_NAME_LIMIT','원본 유형 이름이 현재120자 제한을 넘습니다.','error',entry);
          if (!existingType) schema.issueTypes.push({id:typeId,name:typeName,color:'#668899',archived:false});
        }
        const number = (issueNumbers.get(project.id) || 0) + 1;
        if (append && !Number.isSafeInteger(number + 1)) {
          this.notice('APPEND_ISSUE_NUMBER_LIMIT', '프로젝트 업무 번호의 허용 범위를 초과합니다.', 'error', entry);
          continue;
        }
        issueNumbers.set(project.id, number);
        const assigneeRef=row.references.find(reference=>reference.kind==='identity'&&reference.relation==='assignee'),assigneeSource=assigneeRef?.sourceId||string(scalar(sourceField(row,'assignee'))),mappedAssignee=assigneeSource?this.configuration.users[optionId(entry.pkg.summary.id,'identity',assigneeSource)]:null;
        const labelsRaw=sourceField(row,'labels')??row.metadata.labels,labels=(Array.isArray(labelsRaw)?labelsRaw:typeof labelsRaw==='string'?labelsRaw.split(/[;,]/):[]).map(value=>string(value));if(labels.some(label=>label.length>60))this.notice('LABEL_LIMIT','원본 라벨이 현재60자 제한을 넘습니다.','error',entry);
        const start = this.initialJiraScheduleDate(entry, 'startDate');
        const end = this.initialJiraScheduleDate(entry, 'endDate');
        const due = this.issueDate(sourceField(row, 'dueDate', 'due', 'duedate'), entry);
        if (start && end && start > end) this.notice('ISSUE_DATE_RANGE','시작일이 종료일보다 늦습니다.','error',entry);
        const rawEstimate=sourceField(row,'estimate'),estimate=rawEstimate===undefined||rawEstimate===null||rawEstimate===''?null:Number(rawEstimate);if(estimate!==null&&(!Number.isFinite(estimate)||estimate<0||estimate>100000))this.notice('ESTIMATE_ARCHIVED','예상 작업량의 단위/범위를 현재 숫자로 옮기지 않고 원본으로 보관합니다.','warning',entry,true);
        const issue:Issue={id,key:`${project.key}-${number}`,projectId:project.id,title,description:'',type:typeId,status:stateId,priority:this.priority(sourceField(row,'priority')),assigneeId:typeof mappedAssignee==='string'?mappedAssignee:null,collaboratorIds:[],parentId:null,labels:[...new Set(labels)],startDate:start,endDate:end,dueDate:due,estimate:estimate!==null&&Number.isFinite(estimate)&&estimate>=0&&estimate<=100000?estimate:null,cycle:null,module:null,release:null,cycleId:null,moduleId:null,releaseId:null,customFields:{},version:1,createdAt,updatedAt,completedAt:category==='done'?(this.time(string(sourceField(row,'resolutiondate','resolved'))||row.updatedAt,entry,false)||updatedAt):null};this.result.issues.push(issue);this.issueById.set(id,issue);this.primaryById.set(id,entry);this.bindings.set(entry.key,{type:'issue',id,projectId:project.id});
        if (mapping) this.mapAppendFields(entry, issue, schema, mapping.fields);
        else for(const option of new Set(Object.keys(fieldMap(row)).map(name=>this.fieldOptions.get(entry.pkg.summary.id)?.get(name)).filter((option):option is MigrationOptions['fields'][number]=>!!option))){const sourceDefinition=this.sourceEntry(entry,'field',option.sourceValue)?.row;if(!sourceDefinition)continue;const fields=fieldMap(row),raw=Object.hasOwn(fields,option.sourceValue)?fields[option.sourceValue]:fields[option.sourceValue.replace(/^csv:/,'')];if(raw===undefined)continue;const kind=this.configuration.fields[option.id];if(kind==='archive'){this.noticeArchivedCustomField(entry, option);continue;}const fieldId=`f_${hash(entry.pkg.dataset.source.product,entry.pkg.dataset.source.instanceKey,option.sourceValue).slice(0,24)}`;let definition=schema.fields.find(field=>field.id===fieldId);if(definition&&definition.kind!==kind)this.notice('FIELD_MAPPING_CONFLICT','같은 원본 필드를 다른 자료형으로 매핑했습니다.','error',entry);if(!definition){definition={id:fieldId,name:option.label,description:sourceDefinition.text.slice(0,20000),kind:kind as CustomFieldKind,required:false,issueTypes:[],options:[],archived:false};if(kind==='select'||kind==='multi_select')definition.options=(this.sourceOptions.get(entry.pkg.summary.id)?.get(option.sourceValue)||[]).map(row=>({id:`o_${hash(fieldId,string(row.metadata.originalId)||row.sourceId).slice(0,24)}`,name:row.title,archived:['Y','true','1'].includes(string(row.metadata.disabled))}));schema.fields.push(definition);}issue.customFields![fieldId]=this.convertField(entry,option.sourceValue,definition,raw);}
        if(row.textFormat!=='plain'&&row.textFormat!=='none')this.notice('ISSUE_DESCRIPTION_PLAIN_TEXT','업무 설명은 현재 일반 텍스트로 변환합니다. 원래 서식·본문은 원본 보관함에 유지합니다.','warning',entry,true);
      }
    }
    for(const project of this.result.projects){const schema=this.schemas.get(project.id)!,workflow=this.workflows.get(project.id)!;if(!schema.issueTypes.length)schema.issueTypes=defaultIssueSchema(project.id).issueTypes;if(!workflow.statuses.length)Object.assign(workflow,defaultWorkflow(project.id,this.input.now));else{workflow.initialStatusId=workflow.statuses.find(status=>status.category==='todo')?.id||workflow.statuses[0].id;workflow.transitions=workflow.statuses.flatMap(from=>workflow.statuses.filter(to=>to.id!==from.id).map(to=>({from:from.id,to:to.id,issueTypes:[],requiredFields:[]})));this.notice('WORKFLOW_RULES_NOT_REPRODUCED','원본 워크플로의 조건·검증기·후처리를 재현하지 않습니다. 매핑한 상태 사이의 전이를 허용하는 새 흐름을 만듭니다.','warning',undefined,true);}if(workflow.statuses.length>40||schema.issueTypes.length>50||schema.fields.length>100)this.notice('SCHEMA_LIMIT','프로젝트별 상태40개·유형50개·필드100개 제한을 넘습니다.','error');if(new Set(schema.issueTypes.map(type=>type.name)).size!==schema.issueTypes.length)this.notice('TYPE_NAME_CONFLICT','새 프로젝트 안에 같은 이름의 서로 다른 유형이 있습니다. 유형 매핑을 조정해 주세요.','error');if(schema.fields.some(field=>!field.name.trim()||field.name.length>120)||new Set(schema.fields.map(field=>field.name)).size!==schema.fields.length)this.notice('FIELD_NAME_CONFLICT','필드 이름이 중복되거나120자 제한을 넘습니다. 매핑 또는 보관 방식을 조정해 주세요.','error');this.result.issueSchemas.push(schema);this.result.workflows.push(workflow);}
  }
  private mapAppendFields(entry: Entry, issue: Issue, schema: ProjectIssueSchema, fieldMappings: Record<string, string | null>): void {
    const fields = fieldMap(entry.row);
    const options = this.fieldOptions.get(entry.pkg.summary.id);
    const seen = new Set<string>();
    for (const name of Object.keys(fields)) {
      const option = options?.get(name);
      if (!option || seen.has(option.id)) continue;
      seen.add(option.id);
      const raw = Object.hasOwn(fields, option.sourceValue) ? fields[option.sourceValue] : fields[option.sourceValue.replace(/^csv:/, '')];
      if (raw === undefined) continue;
      const fieldId = fieldMappings[option.id];
      if (fieldId === null || fieldId === undefined && option.projectedDate) {
        this.noticeArchivedCustomField(entry, option);
        continue;
      }
      const field = schema.fields.find(value => value.id === fieldId);
      if (!field || field.archived || !fieldApplies(field, issue.type)) {
        this.notice('APPEND_FIELD_REQUIRED', `원본 필드 '${option.label}'를 적용할 활성 필드를 선택하거나 원문에 보관해 주세요.`, 'error', entry);
        continue;
      }
      if (Object.hasOwn(issue.customFields!, field.id)) {
        this.notice('APPEND_FIELD_AMBIGUOUS', `같은 업무의 여러 원본 필드가 '${field.name}'에 연결되어 있습니다.`, 'error', entry);
        continue;
      }
      issue.customFields![field.id] = this.convertField(entry, option.sourceValue, field, raw);
    }
  }
  private noticeArchivedCustomField(entry: Entry, option: MigrationOptions['fields'][number]): void {
    const consumed = option.projectedDate && jiraSnapshotValue(entry.row, jiraCalendarFields[option.projectedDate]) === undefined &&
      object(entry.row.metadata.jiraProjectedDateSources)[option.projectedDate] === option.sourceValue;
    if (!consumed) this.notice('FIELD_ARCHIVED', `필드 '${option.label}' 값은 원본 보관함에만 유지합니다.`, 'warning', entry, true);
  }
  private initialJiraScheduleDate(entry: Entry, field: JiraScheduleEndpoint): string | null {
    const standard = jiraSnapshotValue(entry.row, jiraCalendarFields[field]);
    if (standard !== undefined) return this.issueDate(standard, entry);
    const raw = projectedJiraDate(entry.row, field);
    if (raw === undefined || raw === null) return null;
    return this.parseProjectedJiraDate(entry, field, raw, 'error');
  }
  private parseProjectedJiraDate(entry: Entry, field: JiraScheduleEndpoint, raw: unknown, severity: 'warning' | 'error'): string | null {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const date = value && this.timezoneValid ? sourceCalendarDate(value, this.configuration.timezone) : null;
    if (!date) this.notice('JIRA_SCHEDULE_DATE_INVALID', `Jira 원본의 일정 ${jiraScheduleLabels[field]} 값을 날짜로 해석할 수 없습니다.`, severity, entry);
    else if (jiraEnglishDate(value)?.century) {
      this.notice('DATE_TWO_DIGIT_CENTURY', 'Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.', 'warning', entry, true);
    }
    return date || null;
  }
  issueDate(value:unknown,entry:Entry):string|null{value=scalar(value);if(value===undefined||value===null||value==='')return null;const raw=string(value);if(isCalendarDate(raw))return raw;const timestamp=this.time(raw,entry,false);if(!timestamp)return null;const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:this.timezoneValid?this.configuration.timezone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}),parts=Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));return`${parts.year}-${parts.month}-${parts.day}`;}
  priority(value:unknown):Issue['priority']{value=scalar(value);const label=string(object(value).name||object(value).text||value);if(/urgent|highest|blocker|긴급/i.test(label))return'urgent';if(/high|critical|높음/i.test(label))return'high';if(/low|minor|trivial|낮음/i.test(label))return'low';return'medium';}
  convertField(entry: Entry, sourceId: string, definition: CustomFieldDefinition, input: unknown): CustomFieldValue;
  convertField(entry: Entry, sourceId: string, definition: CustomFieldDefinition, input: unknown,
    refresh: JiraCustomFieldConversion): CustomFieldValue | undefined;
  convertField(entry: Entry, sourceId: string, definition: CustomFieldDefinition, input: unknown,
    refresh?: JiraCustomFieldConversion): CustomFieldValue | undefined {
    const unwrap = (value: unknown): unknown => {
      const field = object(value);
      for (const name of ['numbervalue','stringvalue','textvalue','datevalue']) if (Object.hasOwn(field, name)) return field[name];
      return value;
    };
    let value = Array.isArray(input) ? input.map(unwrap) : unwrap(input);
    const empty = (value: unknown) => value === null || value === undefined || typeof value === 'string' && !value.trim();
    if (refresh) {
      if (Array.isArray(value)) value = value.filter(item => !empty(item));
      if (empty(value) || Array.isArray(value) && !value.length) return null;
    }
    if (definition.kind !== 'multi_select') value = scalar(value);
    if (value === null || value === undefined || value === '') return null;
    const bad = () => {
      if (refresh) return undefined;
      this.notice('FIELD_VALUE_INVALID', `필드 '${definition.name}' 값을 선택한 ${definition.kind} 자료형으로 손실 없이 변환할 수 없습니다. 보관 방식을 선택하거나 매핑을 고쳐 주세요.`, 'error', entry);
      return null;
    };
    if(definition.kind==='text'){if(typeof value==='object')return bad();const result=string(value);return result.length<=20000?result:bad();}
    if(definition.kind==='number'){const result=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;return Number.isFinite(result)?result:bad();}
    if(definition.kind==='checkbox'){if(value===true||value===false)return value;if(value==='true'||value==='1'||value===1)return true;if(value==='false'||value==='0'||value===0)return false;return bad();}
    if (definition.kind === 'date') {
      const raw = string(value);
      if (!refresh) return isCalendarDate(raw) ? raw : this.issueDate(raw, entry);
      const date = sourceCalendarDate(raw, refresh.timezone);
      if (date && !refresh.originalMapping && jiraEnglishDate(raw)?.century) {
        this.notice('DATE_TWO_DIGIT_CENTURY','Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.','warning',entry,true);
      }
      return date ?? bad();
    }
    if (definition.kind === 'user') {
      const id = string(object(value).accountId || object(value).key || object(value).name || object(value).username || value);
      const mapped = (refresh?.users ?? this.configuration.users)[optionId(refresh?.stagingId ?? entry.pkg.summary.id, 'identity', id)];
      return typeof mapped === 'string' && (!refresh || this.input.users.some(user => user.id === mapped)) ? mapped : bad();
    }
    if(definition.kind==='url'){try{const url=new URL(string(value));return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.toString().length<=4000?url.toString():bad();}catch{return bad();}}
    const choose = (raw: unknown): string | null | undefined => {
      const objectValue = object(raw), id = string(objectValue.id || objectValue.value || objectValue.name || raw);
      if (!id) return null;
      const direct = this.sourceEntry(entry, 'option', id)?.row;
      const original = direct?.containerId === sourceId ? direct : this.sourceEntry(entry, 'option', `${sourceId}:${id}`)?.row;
      const label = string(objectValue.value || objectValue.name) || original?.title || id;
      const optionId = `o_${hash(definition.id,id).slice(0,24)}`;
      if (refresh?.originalMapping === 'generated') return optionId;
      if (this.input.append) {
        const keyed = definition.options.filter(option => option.id === id || option.id === optionId);
        const matches = keyed.length || refresh?.originalMapping === 'existing' ? keyed : definition.options.filter(option => option.name === label);
        if (matches.length !== 1) return bad();
        const { archived, id: matchedId } = matches[0];
        if (archived && !refresh?.originalMapping) {
          const previous = refresh?.previousValue;
          if (Array.isArray(previous) ? !previous.includes(matchedId) : previous !== matchedId) return bad();
        }
        return matches[0].id;
      }
      if (label.length > 120) return bad();
      if (!definition.options.some(option => option.id === optionId)) definition.options.push({id:optionId,name:label,archived:false});
      if (definition.options.length > 200 || new Set(definition.options.map(option => option.name)).size !== definition.options.length) return bad();
      return optionId;
    };
    if (definition.kind === 'multi_select') {
      const values = Array.isArray(value) ? value : [value];
      const result = values.map(choose);
      return result.some(value => value == null) ? bad() : [...new Set(result as string[])];
    }
    const result = Array.isArray(value) ? bad() : choose(value);
    return result === null && refresh ? undefined : result;
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
  private fileInfo(entry: Entry) {
    const metadata = entry.row.metadata;
    const path = string(metadata.packagePath || metadata.path);
    const verified = path ? this.input.fileInfo?.[entry.pkg.summary.id]?.[path] : undefined;
    const size = verified?.size ?? Number(metadata.actualSize ?? metadata.size);
    const sha = verified?.sha256 || string(metadata.sha256);
    const present = Boolean(path && /^[a-f\d]{64}$/.test(sha) && Number.isSafeInteger(size) &&
      (this.input.fileInfo === undefined || verified));
    return { path, size, sha, present, mimeType: verified?.mimeType || 'application/octet-stream' };
  }

  private planAttachmentFile(entry: Entry, owner: AttachmentOwner, sourceRevision?: number): PlannedAttachment | null {
    const metadata = entry.row.metadata;
    const { path, size, sha, present, mimeType } = this.fileInfo(entry);
    if (!present) {
      this.notice('ATTACHMENT_BYTES_MISSING', '이 첨부 버전의 파일 바이트를 확정할 수 없습니다. 메타데이터·원문만 보존하며 가짜 파일은 만들지 않습니다.', 'warning', entry, true);
      return null;
    }
    if (size === 0) {
      this.notice('ATTACHMENT_EMPTY_ARCHIVED', '0바이트 첨부는 현재 첨부 기능에 추가하지 않고 원본 메타데이터로 보관합니다.', 'warning', entry, true);
      return null;
    }
    if (size < 0 || size > MAX_FILE_BYTES) {
      this.notice('ATTACHMENT_FILE_LIMIT', '현재 첨부 파일은20MiB 이하여야 합니다. 해당 버전을 제외하거나 패키지를 검토해 주세요.', 'error', entry);
      return null;
    }
    if (metadata.sha256 && string(metadata.sha256) !== sha) {
      this.notice('ATTACHMENT_HASH_MISMATCH', '원본 분석 메타데이터와 검증한 파일 해시가 다릅니다.', 'error', entry);
      return null;
    }
    let filename: string;
    try { filename = safeFilename(attachmentFilename(entry.row)); }
    catch {
      this.notice('ATTACHMENT_FILENAME_INVALID', '원본 파일명이 현재 첨부 파일명 제한에 맞지 않습니다.', 'error', entry);
      return null;
    }
    const versionLabel = sourceRevision === undefined ? string(metadata.attachmentVersion || metadata.version) || 'unknown' : String(sourceRevision);
    if (versionLabel.length > 100) this.notice('ATTACHMENT_VERSION_LABEL_LIMIT', '첨부 버전 이름이100자를 넘습니다.', 'error', entry);
    const value: AttachmentVersion = {
      id: randomUUID(), attachmentId: '', resourceType: owner.type, resourceId: owner.id, filename, mimeType, size,
      sha256: sha, authorId: this.author(entry), createdAt: this.time(entry.row.createdAt, entry)!, versionLabel,
      sourceImportId: this.input.id, sourceRecordId: this.archiveIds.get(entry.key)!,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
    };
    return { entry, value, path };
  }

  private storePlannedAttachment(item: PlannedAttachment, attachmentId: string, owner: AttachmentOwner): void {
    const { entry, value, path } = item;
    value.attachmentId = attachmentId;
    this.result.attachmentVersions.push(value);
    this.result.fileCopies.push({ fileId: value.id, packageId: entry.pkg.summary.id, path, size: value.size, sha256: value.sha256 });
    this.attachmentVersionsById.set(value.id, value);
    this.bindings.set(entry.key, { type: 'attachment', id: value.id, projectId: owner.projectId });
  }

  private createAttachmentGroup(root: Entry, entries: Entry[], owner: AttachmentOwner): void {
    const ordered = [...entries].sort((a, b) => {
      if (a.key === root.key) return -1;
      if (b.key === root.key) return 1;
      return Number(b.row.metadata.attachmentVersion || b.row.metadata.version || 0) -
        Number(a.row.metadata.attachmentVersion || a.row.metadata.version || 0) || a.key.localeCompare(b.key);
    });
    const available = ordered.flatMap(entry => {
      const item = this.planAttachmentFile(entry, owner);
      return item ? [item] : [];
    });
    const current = available[0];
    if (!current) return;
    if (current.entry.key !== ordered[0].key) this.notice('ATTACHMENT_LATEST_MISSING',
      `최신 원본 첨부 버전의 바이트가 없어 가용 버전 '${current.value.versionLabel}'을 현재 첨부로 사용합니다. 더 최신 누락 버전은 별도 원본 기록으로 유지합니다.`,
      'warning', ordered[0], true);
    const { id, resourceType, resourceId, filename, mimeType, size, sha256, authorId, createdAt } = current.value;
    this.result.attachments.push({ id, resourceType, resourceId, filename, mimeType, size, sha256, authorId, createdAt });
    for (const item of available) this.storePlannedAttachment(item, id, owner);
  }

  private getConfluenceAttachmentSeries(pageId: string, sourceRootId: string): ConfluenceAttachmentSeries {
    let page = this.confluenceAttachmentSeries.get(pageId);
    if (!page) this.confluenceAttachmentSeries.set(pageId, page = new Map());
    let series = page.get(sourceRootId);
    if (!series) page.set(sourceRootId, series = { sourceRootId, known: [], entries: [] });
    return series;
  }

  private indexConfluenceAttachmentSeries(): void {
    const append = this.input.appendPages;
    if (!append) return;
    for (const page of append.knownPages) {
      if (this.originalPage(page.sourceId)) this.confluenceAttachmentPages.set(page.documentId, page.sourceId);
    }
    for (const file of append.knownAttachments ?? []) {
      if (this.originalPage(file.sourcePageId)?.documentId === file.documentId) {
        const scoped = !file.version || file.version.resourceType === 'document' && file.version.resourceId === file.documentId;
        this.getConfluenceAttachmentSeries(file.sourcePageId, file.sourceRootId).known.push(scoped ? file : { ...file, version: null });
      }
    }
    for (const entry of this.entries) {
      if (entry.row.kind === 'page' && this.excluded.has(entry.key)) this.excludedConfluenceAttachmentPages.add(entry.row.sourceId);
      if (entry.row.kind !== 'attachment' || entry.pkg.dataset.source.product !== 'confluence') continue;
      const root = this.attachmentRoot(entry);
      const pageIds = new Set<string>();
      for (const candidate of [entry, ...(root && root !== entry ? [root] : [])]) {
        for (const ref of candidate.row.references) if (ref.kind === 'page' && ref.relation === 'container-content') pageIds.add(ref.sourceId);
        const owner = this.ownerEntry(candidate);
        if (owner?.row.kind === 'page') pageIds.add(owner.row.sourceId);
      }
      if (!root || pageIds.size !== 1) continue;
      const [pageId] = pageIds;
      if (!this.originalPage(pageId)) continue;
      const sourceRootId = string(root.row.metadata.currentVersionId) || root.row.sourceId;
      this.getConfluenceAttachmentSeries(pageId, sourceRootId).entries.push(entry);
    }
  }

  private confluenceAttachmentAllowed(entry: Entry, sourcePageId: string, sourceErrors: Set<string>): boolean {
    return !this.excluded.has(entry.key) && !this.restricted(entry) && entry.row.metadata.restricted !== true &&
      !this.restrictedSourcePages.has(sourcePageId) && !this.excludedConfluenceAttachmentPages.has(sourcePageId) && !sourceErrors.has(entry.key);
  }

  private matchesKnownAttachment(entry: Entry, version: AttachmentVersion): boolean {
    const { present, size, sha } = this.fileInfo(entry);
    const claimedHash = string(entry.row.metadata.sha256);
    return (!claimedHash || claimedHash === version.sha256) && (!present || size === version.size && sha === version.sha256);
  }

  private refreshConfluenceAttachmentSeries(sourcePageId: string, series: ConfluenceAttachmentSeries, owner: AttachmentOwner,
    sourceErrors: Set<string>, sourceLocations: Map<string, Set<string>>): void {
    const incoming = series.entries.filter(entry => this.confluenceAttachmentAllowed(entry, sourcePageId, sourceErrors));
    if (!incoming.length || !this.uniqueConfluenceOrigin(incoming)) return;
    const location = confluenceAttachmentLocation(sourcePageId, series.sourceRootId);
    const aliases = [series.sourceRootId, ...incoming.map(entry => entry.row.sourceId)];
    if (aliases.some(alias => [...sourceLocations.get(alias) ?? []].some(previous => previous !== location))) {
      this.notice('CONFLUENCE_ATTACHMENT_OWNER_CONFLICT', '첨부 원본이 다른 파일 또는 문서와 연결되어 있어 원본 기록만 보관합니다.', 'warning', incoming[0], true);
      return;
    }
    const refresh = this.configuration.appendPagesTo?.refreshAttachments === true;
    if (!series.known.length) {
      if (!refresh) return;
      const roots = incoming.filter(entry => entry.row.sourceId === series.sourceRootId && !entry.row.metadata.currentVersionId);
      // A new attachment must have exactly one source series and current record.
      if (roots.length !== 1 || incoming.some(entry => entry.pkg !== roots[0].pkg)) {
        this.notice('CONFLUENCE_ATTACHMENT_SERIES_UNAVAILABLE', '새 첨부의 원본 파일과 버전 계보를 확정할 수 없어 원본 기록만 보관합니다.', 'warning', incoming[0], true);
        return;
      }
      const count = this.result.attachments.length;
      this.createAttachmentGroup(roots[0], incoming, owner);
      if (this.result.attachments.length > count) {
        this.result.preview.counts.newConfluenceAttachments++;
        for (const entry of incoming) if (this.bindings.has(entry.key)) this.confluenceAttachmentOwners.set(entry.key, owner);
      }
      return;
    }

    const live = series.known.flatMap(file => file.version ? [file.version] : []);
    const anchorIds = new Set(live.map(file => file.attachmentId));
    const knownByRevision = new Map<number, MigrationConfluenceKnownAttachment[]>();
    for (const file of series.known) {
      if (file.sourceRevision === null) continue;
      const matches = knownByRevision.get(file.sourceRevision) ?? [];
      matches.push(file);
      knownByRevision.set(file.sourceRevision, matches);
    }
    let newestKnown = 0;
    for (const revision of knownByRevision.keys()) newestKnown = Math.max(newestKnown, revision);
    const newRevisions = new Map<number, Entry[]>();
    for (const entry of incoming) {
      const revision = confluenceAttachmentRevision(entry.row);
      const previous = revision === null ? series.known.filter(item => item.sourceId === entry.row.sourceId && item.sourceRevision === null)
        : knownByRevision.get(revision) ?? [];
      if (previous.length) {
        const matches = previous.flatMap(item => item.version && this.matchesKnownAttachment(entry, item.version) ? [item.version] : []);
        if (anchorIds.size === 1 && matches.length === previous.length && new Set(matches.map(file => file.id)).size === 1) {
          this.recognizedConfluenceAttachmentEntries.set(entry.key, matches[0]);
        } else if (refresh) {
          this.notice('CONFLUENCE_ATTACHMENT_VERSION_CONFLICT', '이전 첨부의 같은 원본 버전을 확인할 수 없어 기존 파일을 보존합니다.', 'warning', entry, true);
        }
        continue;
      }
      if (!refresh) continue;
      if (anchorIds.size !== 1 || revision === null || !newestKnown || revision <= newestKnown ||
          series.known.some(file => file.version && file.version.id === file.version.attachmentId && file.sourceRevision === null)) {
        this.notice('CONFLUENCE_ATTACHMENT_VERSION_SKIPPED', '현재 첨부의 원본 버전보다 새로운 파일인지 확인할 수 없어 원본 기록만 보관합니다.', 'warning', entry, true);
        continue;
      }
      const candidates = newRevisions.get(revision) ?? [];
      candidates.push(entry);
      newRevisions.set(revision, candidates);
    }

    const [attachmentId] = anchorIds;
    for (const [revision, entries] of [...newRevisions].sort(([a], [b]) => a - b)) {
      const supplied = entries.filter(entry => this.fileInfo(entry).present);
      const signatures = new Set(supplied.map(entry => {
        const file = this.fileInfo(entry);
        return JSON.stringify([file.size, file.sha]);
      }));
      if (signatures.size > 1) {
        this.notice('CONFLUENCE_ATTACHMENT_VERSION_CONFLICT', '겹치는 내보내기의 같은 첨부 버전에 서로 다른 파일이 있어 원본 기록만 보관합니다.', 'warning', entries[0], true);
        continue;
      }
      const item = this.planAttachmentFile(supplied[0] ?? entries[0], owner, revision);
      if (!item) continue;
      this.storePlannedAttachment(item, attachmentId, owner);
      this.confluenceAttachmentOwners.set(item.entry.key, owner);
      for (const entry of entries) {
        if (entry !== item.entry && this.matchesKnownAttachment(entry, item.value)) {
          this.recognizedConfluenceAttachmentEntries.set(entry.key, item.value);
        }
      }
      this.result.preview.counts.newConfluenceAttachmentVersions++;
      if (series.known.some(file => file.hasLocalVersions)) this.notice('CONFLUENCE_ATTACHMENT_LOCAL_HEAD_RETAINED',
        'Teamspace에서 따로 추가한 최신 파일을 유지하고 새 원본 버전은 첨부 이력에 보관합니다.', 'info', item.entry);
    }
  }

  private confluenceAttachmentLocations(): Map<string, Set<string>> {
    const locations = new Map<string, Set<string>>();
    const track = (alias: string, location: string) => {
      const matches = locations.get(alias) ?? new Set<string>();
      matches.add(location);
      locations.set(alias, matches);
    };
    for (const previous of this.input.appendPages?.knownAttachments ?? []) {
      const location = confluenceAttachmentLocation(previous.sourcePageId, previous.sourceRootId);
      track(previous.sourceId, location);
      track(previous.sourceRootId, location);
    }
    for (const [sourcePageId, page] of this.confluenceAttachmentSeries) for (const series of page.values()) {
      const location = confluenceAttachmentLocation(sourcePageId, series.sourceRootId);
      for (const entry of series.entries) track(entry.row.sourceId, location);
      if (series.entries.length) track(series.sourceRootId, location);
    }
    return locations;
  }

  private createExistingConfluenceFiles(sourceLocations: Map<string, Set<string>>): void {
    const append = this.input.appendPages;
    if (!append) return;
    this.result.preview.counts.newConfluenceAttachments = 0;
    this.result.preview.counts.newConfluenceAttachmentVersions = 0;
    const sourceErrors = new Set(this.input.packages.flatMap(pkg => pkg.dataset.diagnostics
      .filter(item => item.recordId && item.severity === 'error' && !item.code.endsWith('ATTACHMENT_BYTES_MISSING'))
      .map(item => `${pkg.summary.id}/${item.recordId}`)));
    for (const [sourcePageId, page] of this.confluenceAttachmentSeries) {
      const original = this.originalPage(sourcePageId);
      if (!original) continue;
      const owner: AttachmentOwner = { type: 'document', id: original.documentId, projectId: append.project.id };
      for (const series of page.values()) this.refreshConfluenceAttachmentSeries(sourcePageId, series, owner, sourceErrors, sourceLocations);
    }
    this.result.confluenceAttachmentOwners = [...new Set([...this.confluenceAttachmentOwners.values()].map(owner => owner.id))];
  }

  private createExistingJiraFiles(): void {
    const append = this.input.append;
    if (!append || this.configuration.appendTo?.refreshAttachments !== true) return;
    const issues = new Map(append.attachmentIssues?.filter(issue => issue.projectId === append.project.id).map(issue => [issue.id, issue]));
    const scope = this.jiraChildScope(append);
    const groups = new Map<string, Entry[]>();
    let rawOnly = 0;
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product !== 'jira' || entry.row.kind !== 'attachment' || this.excluded.has(entry.key)) continue;
      const sourceId = jiraAttachmentSourceId(entry.row);
      if (!sourceId) {
        if (this.retainedEntries.has(entry.key)) rawOnly++;
        continue;
      }
      if (this.knownJiraAttachments.has(sourceId)) continue;
      const entries = groups.get(sourceId) ?? [];
      entries.push(entry);
      groups.set(sourceId, entries);
    }
    for (const entries of groups.values()) {
      const retained = entries.filter(entry => this.retainedEntries.has(entry.key));
      if (!retained.length) continue;
      if (retained.length !== entries.length) {
        // One Jira attachment cannot refer to both a new and an existing issue.
        for (const entry of entries) this.retainedEntries.add(entry.key);
        rawOnly += entries.length;
        continue;
      }
      const [first] = retained;
      const issue = this.resolveJiraChildOwner(first, jiraAttachmentOwnerAliases(first.row), issues, scope);
      if (!issue) {
        rawOnly += retained.length;
        continue;
      }
      const verified = retained.map(entry => {
        const evidence = jiraAttachmentFileEvidence(entry.row);
        if (!evidence) return null;
        const file = this.input.fileInfo?.[entry.pkg.summary.id]?.[evidence.path];
        if (!file || file.size !== evidence.size || file.sha256 !== evidence.sha256 || file.size > MAX_FILE_BYTES ||
            this.resolveJiraChildOwner(entry, jiraAttachmentOwnerAliases(entry.row), issues, scope)?.id !== issue.id) return null;
        return JSON.stringify([attachmentFilename(entry.row), file.size, file.sha256, file.mimeType, entry.row.createdAt, this.author(entry)]);
      });
      if (!verified[0] || verified.some(signature => signature !== verified[0])) {
        rawOnly += retained.length;
        continue;
      }
      const owner: AttachmentOwner = { type: 'issue', id: issue.id, projectId: issue.projectId };
      this.createAttachmentGroup(first, [first], owner);
      if (this.bindings.has(first.key)) this.jiraAttachmentOwners.set(first.key, owner);
    }
    if (rawOnly) this.notice('JIRA_ATTACHMENT_RAW_ONLY',
      `업무 연결, 원본 ID, 접근 범위 또는 파일 바이트를 확인할 수 없는 Jira 첨부 ${rawOnly}건은 원문과 메타데이터로 보관합니다.`, 'warning', undefined, true);
    this.result.jiraAttachmentOwners = [...new Set([...this.jiraAttachmentOwners.values()].map(owner => owner.id))];
    Object.assign(this.result.preview.counts, { newJiraAttachments: this.jiraAttachmentOwners.size, retainedRecords: this.retainedEntries.size });
  }

  createFiles():void{
    this.createExistingJiraFiles();
    this.indexConfluenceAttachmentSeries();
    const sourceLocations = this.confluenceAttachmentLocations();
    const groups = new Map<Entry, Entry[]>();
    for (const entry of this.entries) {
      if (entry.row.kind !== 'attachment' || this.skip(entry)) continue;
      const root = this.attachmentRoot(entry);
      if (!root) {
        this.notice('ATTACHMENT_VERSION_CYCLE', '첨부 버전 관계가 순환합니다.', 'error', entry);
        continue;
      }
      const group = groups.get(root) ?? [];
      group.push(entry);
      groups.set(root, group);
    }
    for (const [root, versions] of groups) {
      const ownerEntry = this.ownerEntry(versions[0]);
      const owner = ownerEntry && this.bindings.get(ownerEntry.key);
      if (!owner || owner.type !== 'issue' && owner.type !== 'document') {
        this.notice('ATTACHMENT_OWNER_MISSING', '첨부 파일의 현재 업무·문서 소유자를 확정할 수 없습니다.', 'error', versions[0]);
        continue;
      }
      if (this.input.appendPages && ownerEntry?.row.kind === 'page') {
        const sourceRootId = string(root.row.metadata.currentVersionId) || root.row.sourceId;
        const location = confluenceAttachmentLocation(ownerEntry.row.sourceId, sourceRootId);
        const aliases = [sourceRootId, ...versions.map(entry => entry.row.sourceId)];
        if (aliases.some(alias => [...sourceLocations.get(alias) ?? []].some(previous => previous !== location)) ||
            versions.some(entry => this.ownerEntry(entry)?.row.sourceId !== ownerEntry.row.sourceId)) {
          this.notice('CONFLUENCE_ATTACHMENT_OWNER_CONFLICT', '첨부 원본이 다른 파일 또는 문서와 연결되어 있어 원본 기록만 보관합니다.', 'warning', root, true);
          continue;
        }
      }
      this.createAttachmentGroup(root, versions, { ...owner, type: owner.type });
    }
    this.createExistingConfluenceFiles(sourceLocations);
    if (this.result.fileCopies.reduce((sum, file) => sum + file.size, 0) > MAX_EXPANDED_BYTES) {
      this.notice('ATTACHMENT_TOTAL_LIMIT','한 이관의 첨부 바이트 합계는256MiB 이하여야 합니다.','error');
    }
  }
  private isConfluenceStorageReference(entry: Entry, request: MigrationReferenceInput): boolean {
    return entry.pkg.dataset.source.product === 'confluence' && entry.row.textFormat === 'confluence-storage'
      && (request.kind === 'page' || request.kind === 'attachment') && (!request.url || request.attachmentOwner !== undefined);
  }
  private confluenceSpace(entry: Entry): string | null {
    const declared = entry.row.references.find(reference => reference.kind === 'project' && reference.relation === 'space')?.sourceId;
    const sourceSpace = declared ?? this.ownerEntry(entry)?.container;
    if (sourceSpace && sourceSpace !== '__unassigned__') return sourceSpace;
    const retainedPage = this.configuration.appendPagesTo?.refreshHistory && this.retainedPageOwners.get(entry.key);
    return retainedPage ? this.originalPage(retainedPage)?.sourceSpaceId ?? null : null;
  }
  private sourceLabelListScope(entry: Entry) {
    const { product, instanceKey } = entry.pkg.dataset.source;
    const spaceId = product === 'confluence' && entry.row.metadata.sourceClass === 'Page' ? this.confluenceSpace(entry) : null;
    return spaceId ? { spaceId, source: JSON.stringify([instanceKey, spaceId]), origin: this.originIdentity(entry) } : null;
  }
  private isolatedLabelListScopes() {
    if (this.labelListProjectScopes) return this.labelListProjectScopes;
    const scopes = new Map<string, LabelListProjectScope | null>();
    for (const page of this.result.documents) {
      if (!page.projectId) continue;
      const entry = this.primaryById.get(page.id);
      const current = entry && this.sourceLabelListScope(entry);
      const known = scopes.get(page.projectId);
      if (!current || known === null || known &&
          (known.source !== current.source || known.origin && current.origin && known.origin !== current.origin)) {
        scopes.set(page.projectId, null);
      } else {
        scopes.set(page.projectId, { source: current.source, origin: known?.origin ?? current.origin });
      }
    }
    this.labelListProjectScopes = scopes;
    return scopes;
  }
  private confluenceLabelListProject(entry: Entry, spaceKey: string | null, projectId?: string | null): string | null {
    if (!projectId) return null;
    const scope = this.sourceLabelListScope(entry);
    if (!scope) return null;
    const append = this.input.appendPages;
    const sourceSpace = this.sourceEntry(entry, 'project', scope.spaceId);
    if (sourceSpace && this.excluded.has(sourceSpace.key) || !sourceSpace && !append) return null;
    const key = string(sourceSpace?.row.metadata.spaceKey || sourceSpace?.row.metadata.key || append?.sourceSpaceKey);
    if (key.startsWith('~') || string(sourceSpace?.row.metadata.spaceType).toLowerCase() === 'personal') return null;
    if (spaceKey && (spaceKey !== key || this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? [])
      .some(candidate => candidate.row.sourceId !== scope.spaceId))) return null;

    const projected = this.isolatedLabelListScopes().get(projectId);
    if (projected === null || projected && (projected.source !== scope.source ||
        projected.origin && scope.origin && projected.origin !== scope.origin)) return null;
    if (append && (append.labelListScope !== 'isolated' || append.project.id !== projectId || append.sourceSpaceId !== scope.spaceId)) return null;
    return append || projected ? projectId : null;
  }
  private confluenceChildListProject(entry: Entry, spaceKey: string | null, projectId?: string | null): string | null {
    const current = this.confluenceLabelListProject(entry, spaceKey, projectId);
    if (current || !spaceKey || this.input.appendPages || !this.sourceLabelListScope(entry)) return current;
    const candidates = this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? []);
    const spaceIds = new Set(candidates.map(candidate => candidate.row.sourceId));
    if (spaceKey.startsWith('~') || spaceIds.size !== 1 || !this.uniqueConfluenceOrigin(candidates) ||
        candidates.some(candidate => this.excluded.has(candidate.key) || string(candidate.row.metadata.spaceType).toLowerCase() === 'personal')) return null;
    const source = JSON.stringify([entry.pkg.dataset.source.instanceKey, [...spaceIds][0]]);
    const origin = candidates.map(candidate => this.originIdentity(candidate)).find(Boolean);
    const projects = [...this.isolatedLabelListScopes()].filter(([, scope]) =>
      scope?.source === source && (!origin || !scope.origin || scope.origin === origin));
    return projects.length === 1 ? projects[0][0] : null;
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
  private confluencePage(entry: Entry, { sourceId, title, spaceKey }: MigrationPageIdentity): { entry?: Entry; reference: ResolvedReference } | null {
    const append = this.input.appendPages;
    let candidates = this.confluenceCandidates(entry, 'page', sourceId, title);
    let spaceId: string | null = null;
    if (spaceKey || !sourceId || append) {
      let spaceOrigin: string | undefined;
      if (spaceKey) {
        const spaces = this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? []);
        const spaceIds = new Set(spaces.map(space => space.row.sourceId));
        if (append && spaceKey === append.sourceSpaceKey) spaceIds.add(append.sourceSpaceId);
        if (spaceIds.size !== 1 || !this.uniqueConfluenceOrigin(spaces)) return null;
        spaceId = [...spaceIds][0];
        spaceOrigin = spaces.map(space => this.originIdentity(space)).find(Boolean);
      } else spaceId = this.confluenceSpace(entry);
      if (!spaceId) return null;
      candidates = candidates.filter(candidate => {
        const origin = this.originIdentity(candidate);
        return candidate.container === spaceId && (!spaceOrigin || !origin || spaceOrigin === origin);
      });
    }
    // Excluding a document does not make another source document with the same title its target.
    const ids = new Set(candidates.map(candidate => candidate.row.sourceId));
    if (append && spaceId === append.sourceSpaceId) {
      if (sourceId && this.boundPages.get(sourceId)?.sourceSpaceId === spaceId) ids.add(sourceId);
      else if (!sourceId && title) for (const id of this.boundPageIdsByTitle.get(title) ?? []) ids.add(id);
    }
    if (ids.size !== 1 || !this.uniqueConfluenceOrigin(candidates)) return null;
    const [id] = ids;
    if (this.restrictedSourcePages.has(id)) return null;
    const imported = candidates.filter(candidate => this.bindings.get(candidate.key)?.type === 'document');
    if (imported.length === 1) return { entry: imported[0], reference: this.resolvedReference(imported[0]) };
    if (imported.length || candidates.some(candidate => this.excluded.has(candidate.key) || this.restricted(candidate))) return null;
    const known = this.originalPage(id);
    return known ? { reference: { id: known.documentId, label: title || known.sourceTitle || known.sourceId } } : null;
  }
  private confluenceSectionProjection(entry: Entry, documentId: string): ReadonlyMap<string, string> {
    const cached = this.confluenceSectionProjections.get(entry);
    if (cached) return cached;
    const converted = convertLegacyContent(entry.row, {
      resolveReference: request => this.resolve(entry, request), sectionLinks: { documentId },
    });
    const sections = converted.sectionTargets ?? new Map<string, string>();
    this.confluenceSectionProjections.set(entry, sections);
    return sections;
  }
  private confluenceSectionPage(entry: Entry, request: MigrationReferenceInput) {
    if (!request.url) return this.confluencePage(entry, request);
    const base = this.originBases.get(entry.pkg.summary.id);
    if (!base) return null;
    try {
      const url = new URL(request.url, base.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.searchParams.has('focusedCommentId') || !isWithinMigrationOrigin(url, base)) return null;
      const sourceId = url.searchParams.get('pageId') || /\/pages\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      if (sourceId) return this.confluencePage(entry, { sourceId });
      const display = /\/display\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
      if (display) return this.confluencePage(entry, {
        spaceKey: decodeURIComponent(display[1]),
        title: decodeURIComponent(display[2].replaceAll('+', ' ')),
      });
    } catch { /* Leave invalid or unverified source URLs visible as text. */ }
    return null;
  }
  private confluenceSectionLinks(entry: Entry, documentId: string) {
    return {
      documentId,
      resolvePageSection: (request: MigrationReferenceInput, fragment: string, fromUrl: boolean) => {
        const target = this.confluenceSectionPage(entry, request);
        if (!target) return null;
        const { id, label } = target.reference;
        const known = this.boundPagesByDocument.get(id);
        const aliases = fromUrl ? confluenceSectionAliases(fragment, target.entry?.row.title || known?.sourceTitle || label) : [fragment];
        const lookup = (sections: ReadonlyMap<string, string>) => aliases.map(alias => sections.get(alias)).filter((value): value is string => Boolean(value));
        let matches: string[];
        if (target.entry) matches = lookup(this.confluenceSectionProjection(target.entry, id));
        else if (known?.sectionIds) {
          const present = new Set(known.sectionIds);
          matches = aliases.flatMap(alias => [legacySectionId(alias, 'heading'), legacySectionId(alias, 'anchor')]).filter(sectionId => present.has(sectionId));
          // A simultaneous refresh can remove sections. Only link to IDs present in both versions.
          for (const incoming of this.confluenceRefreshSections.get(id) ?? []) {
            const incomingMatches = new Set(lookup(this.confluenceSectionProjection(incoming, id)));
            matches = matches.filter(sectionId => incomingMatches.has(sectionId));
          }
        } else return null;
        const unique = new Set(matches);
        return unique.size === 1 ? { documentId: id, sectionId: [...unique][0] } : null;
      },
    };
  }
  private confluenceAttachment(entry: Entry, request: MigrationReferenceInput): Entry | null {
    const { attachmentOwner, sourceId, title } = request;
    if (attachmentOwner === null) return null;
    let candidates = this.confluenceCandidates(entry, 'attachment', sourceId, title);
    let ownerId: string | undefined;
    if (attachmentOwner || !sourceId) {
      const owner = attachmentOwner ? this.confluencePage(entry, attachmentOwner)?.entry : this.ownerEntry(entry);
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
  private boundConfluenceAttachmentPage(entry: Entry, request: MigrationReferenceInput): string | undefined {
    if (request.attachmentOwner) {
      const owner = this.confluencePage(entry, request.attachmentOwner);
      return owner ? this.confluenceAttachmentPages.get(owner.reference.id) : undefined;
    }
    const owner = this.ownerEntry(entry);
    if (owner?.row.kind === 'page' && this.originalPage(owner.row.sourceId)) return owner.row.sourceId;
  }

  private localConfluenceAttachmentRows(from: Entry, candidates: Entry[]): Entry[] {
    const eligible = this.inConfluenceSource(from, candidates);
    if (!this.uniqueConfluenceOrigin(eligible)) return [];
    const local = eligible.filter(candidate => candidate.pkg.summary.id === from.pkg.summary.id);
    return local.length ? local : eligible;
  }

  private confluenceCurrentAttachmentRows(from: Entry, candidates: Entry[]): Entry[] {
    const eligible = this.localConfluenceAttachmentRows(from, candidates);
    if (eligible.length <= 1) return eligible;
    const revisions = eligible.map(entry => confluenceAttachmentRevision(entry.row));
    if (revisions.some(revision => revision === null)) return [];
    const newest = Math.max(...revisions.map(revision => revision ?? 0));
    return eligible.filter((_, index) => revisions[index] === newest);
  }

  private uniquelyResolvedAttachment(versions: (AttachmentVersion | null | undefined)[]): AttachmentVersion | null {
    const [first] = versions;
    return first && versions.every(version => version?.id === first.id) ? first : null;
  }

  private incomingAttachmentVersions(entries: Entry[]): AttachmentVersion | null {
    return this.uniquelyResolvedAttachment(entries.map(entry => {
      const binding = this.bindings.get(entry.key);
      return binding ? this.attachmentVersionsById.get(binding.id) : this.recognizedConfluenceAttachmentEntries.get(entry.key);
    }));
  }

  private knownCurrentAttachments(series: ConfluenceAttachmentSeries): MigrationConfluenceKnownAttachment[] {
    let highest = 0;
    for (const file of series.known) highest = Math.max(highest, file.sourceRevision ?? 0);
    return series.known.filter(file => file.sourceId === series.sourceRootId && (file.sourceRevision ?? 0) === highest);
  }

  private lookupBoundConfluenceAttachment(entry: Entry, sourcePageId: string, request: MigrationReferenceInput): ResolvedReference | null {
    if (this.restrictedSourcePages.has(sourcePageId) || this.excludedConfluenceAttachmentPages.has(sourcePageId)) return null;
    const seriesForPage = this.confluenceAttachmentSeries.get(sourcePageId);
    if (!seriesForPage) return null;
    const { sourceId, title } = request;
    let version: AttachmentVersion | null;
    if (sourceId) {
      const lines = [...seriesForPage.values()].filter(series => series.entries.some(row => row.row.sourceId === sourceId) ||
        series.known.some(file => file.sourceId === sourceId));
      if (lines.length !== 1) return null;
      const [series] = lines;
      const present = series.entries.filter(candidate => candidate.row.sourceId === sourceId);
      if (present.length) {
        const scoped = sourceId === series.sourceRootId ? this.confluenceCurrentAttachmentRows(entry, present)
          : this.localConfluenceAttachmentRows(entry, present);
        version = this.incomingAttachmentVersions(scoped);
      } else {
        const known = sourceId === series.sourceRootId ? this.knownCurrentAttachments(series)
          : series.known.filter(file => file.sourceId === sourceId);
        version = this.uniquelyResolvedAttachment(known.map(file => file.version));
      }
    } else if (title) {
      const candidates: (AttachmentVersion | null)[] = [];
      for (const series of seriesForPage.values()) {
        const roots = series.entries.filter(row => row.row.sourceId === series.sourceRootId && !row.row.metadata.currentVersionId);
        const current = this.confluenceCurrentAttachmentRows(entry, roots);
        if (roots.length) {
          if ((current.length ? current : roots).some(row => attachmentFilename(row.row) === title)) {
            candidates.push(current.every(row => attachmentFilename(row.row) === title) ? this.incomingAttachmentVersions(current) : null);
          }
          continue;
        }
        const known = this.knownCurrentAttachments(series);
        if (!known.length) {
          if (series.known.some(file => file.sourceId === series.sourceRootId && file.filename === title)) candidates.push(null);
          continue;
        }
        if (!known.some(file => file.filename === title)) continue;
        const latestKnown = known[0]?.sourceRevision ?? 0;
        const suppliedNewer = series.entries.some(row => (confluenceAttachmentRevision(row.row) ?? 0) > latestKnown);
        candidates.push(!suppliedNewer && known.every(file => file.filename === title) ? this.uniquelyResolvedAttachment(known.map(file => file.version)) : null);
      }
      version = candidates.length === 1 ? candidates[0] : null;
    } else return null;

    if (!version) return null;
    if (!this.attachmentVersionsById.has(version.id)) this.borrowedAttachmentVersions.set(version.id, version);
    return attachmentReference(version, title || version.filename);
  }

  private resolvedReference(candidate: Entry): ResolvedReference {
    const binding = this.bindings.get(candidate.key)!;
    if (binding.type !== 'attachment') return { id: binding.id, label: candidate.row.title };
    const version = this.attachmentVersionsById.get(binding.id);
    return version ? attachmentReference(version, candidate.row.title) : { id: binding.id, label: candidate.row.title, url: `/api/attachments/${binding.id}/content` };
  }
  resolve(entry: Entry, request: MigrationReferenceInput): ResolvedReference | null {
    const scoped = this.isConfluenceStorageReference(entry, request);
    const space = scoped ? this.confluenceSpace(entry) : null;
    const owner = request.kind === 'attachment' ? this.ownerEntry(entry)?.key : null;
    const key = JSON.stringify([entry.pkg.summary.id, scoped, space, owner, request]);
    if (this.resolutionCache.has(key)) return this.resolutionCache.get(key)!;
    let value: ResolvedReference | null;
    if (scoped && request.kind === 'page') value = this.confluencePage(entry, request)?.reference ?? null;
    else if (scoped) {
      const boundPageId = this.boundConfluenceAttachmentPage(entry, request);
      if (boundPageId) value = this.lookupBoundConfluenceAttachment(entry, boundPageId, request);
      else {
        const candidate = this.confluenceAttachment(entry, request);
        value = candidate ? this.resolvedReference(candidate) : null;
      }
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
    const local=candidates.filter(candidate=>candidate.pkg.summary.id===entry.pkg.summary.id);if(local.length===1)candidates=local;
    if (!candidates.length && request.kind === 'issue' && requestedId && this.input.append) {
      const base = this.originBases.get(entry.pkg.summary.id);
      if (requestedUrl && (!base || !isWithinMigrationOrigin(requestedUrl, base))) return null;
      const sourceMatches = this.referenceIndex.get(JSON.stringify(['issue', 'id', requestedId])) ?? [];
      if (sourceMatches.some(candidate => this.excluded.has(candidate.key))) return null;
      const existing = this.originalIssue(requestedId);
      if (existing) return { id: existing.id, label: requestedId };
    }
    if (!candidates.length && request.kind === 'page' && requestedId && requestedUrl && this.input.appendPages) {
      const base = this.originBases.get(entry.pkg.summary.id);
      if (base && isWithinMigrationOrigin(requestedUrl, base)) {
        return this.confluencePage(entry, { sourceId: requestedId, spaceKey: request.spaceKey })?.reference ?? null;
      }
    }
    return candidates.length===1?this.resolvedReference(candidates[0]):null;
  }
  converted(entry: Entry, { legacyAnnotations = false, documentId }: { legacyAnnotations?: boolean; documentId?: string } = {}) {
    const result = convertLegacyContent(entry.row, {
      resolveReference: request => this.resolve(entry, request), legacyAnnotations,
      sectionLinks: documentId && entry.pkg.dataset.source.product === 'confluence' ? this.confluenceSectionLinks(entry, documentId) : undefined,
      resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, this.project(entry)?.id),
      resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, this.project(entry)?.id),
    });
    for (const diagnostic of result.diagnostics) this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
    return result;
  }
  private parentBinding(entry: Entry, parentId: string): Binding | undefined {
    if (entry.row.kind === 'page' && this.input.appendPages) {
      const parent = this.confluencePage(entry, { sourceId: parentId });
      return parent ? { type: 'document', id: parent.reference.id, projectId: this.input.appendPages.project.id } : undefined;
    }
    const parent = this.sourceEntry(entry, entry.row.kind, parentId);
    const binding = parent && this.bindings.get(parent.key);
    return binding ?? (entry.row.kind === 'issue' && (!parent || !this.excluded.has(parent.key)) ? this.originalIssue(parentId) : undefined);
  }
  convertDocuments():void{
    for (const entry of this.entries) {
      if (this.excluded.has(entry.key)) continue;
      const binding = this.bindings.get(entry.key);
      if (binding?.type === 'issue') {
        const issue = this.issueById.get(binding.id)!;
        const description = this.jiraDescription(entry, issue.id);
        issue.description = description.description;
        if (description.descriptionFormat) issue.descriptionFormat = description.descriptionFormat;
        for (const diagnostic of description.diagnostics) this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
        if (issue.description.length > 200000) this.notice('ISSUE_DESCRIPTION_LIMIT', '업무 설명이 현재 200000자 제한을 넘습니다.', 'error', entry);
      } else if (binding?.type === 'document') {
        const document = this.documentById.get(binding.id)!;
        const converted = this.converted(entry, { documentId: document.id });
        document.content = converted.content;
        document.plainText = converted.plainText;
      }
    }
    for (const entry of this.entries) {
      if (this.skip(entry) || !['issue', 'page'].includes(entry.row.kind)) continue;
      const binding = this.bindings.get(entry.key);
      const { parentId } = entry.row;
      if (!binding || !parentId) continue;
      const parent = this.parentBinding(entry, parentId);
      if (!parent || parent.type !== binding.type) {
        this.notice('PARENT_NOT_IMPORTED', '원본 상위 항목이 적용 대상에 없어 현재 항목은 최상위로 배치합니다. 원래 계층은 보관합니다.', 'warning', entry, true);
        continue;
      }
      if (parent.projectId !== binding.projectId) {
        this.notice('PARENT_PROJECT_CONFLICT', '부모와 자식 항목이 서로 다른 새 프로젝트로 매핑되었습니다.', 'error', entry);
        continue;
      }
      if (binding.type === 'issue') this.issueById.get(binding.id)!.parentId = parent.id;
      else this.documentById.get(binding.id)!.parentId = parent.id;
    }
  }
  createSecondary():void{
    const revisions = new Map<string, Entry[]>();
    for (const entry of this.entries) {
      if (this.skip(entry)) continue;
      const ownerEntry = this.ownerEntry(entry), owner = ownerEntry ? this.bindings.get(ownerEntry.key) : undefined;
      if (entry.row.kind === 'revision') {
        if (!owner || owner.type !== 'document') {
          this.notice('REVISION_OWNER_MISSING', '원본 문서 버전의 현재 문서를 찾을 수 없습니다.', 'error', entry);
          continue;
        }
        const values = revisions.get(owner.id) || [];
        values.push(entry);
        revisions.set(owner.id, values);
      } else if (entry.row.kind === 'comment') {
        if (!owner || !['issue', 'document'].includes(owner.type)) {
          this.notice('COMMENT_OWNER_MISSING', '댓글의 현재 업무·문서 소유자를 찾을 수 없습니다.', 'error', entry);
          continue;
        }
        const body = this.converted(entry, { legacyAnnotations: true }).plainText;
        if (!body.trim() || body.length > 20000) this.notice('COMMENT_BODY_LIMIT', '댓글이 비어 있거나 현재20000자 제한을 넘습니다.', 'error', entry);
        if (!['plain', 'none'].includes(entry.row.textFormat)) {
          this.notice('COMMENT_FORMAT_PLAIN_TEXT', '댓글은 일반 텍스트로 변환하며 원래 서식과 작성자·변경 시각은 원본 보관함에 유지합니다.', 'warning', entry, true);
        }
        const id = randomUUID();
        this.result.comments.push({ id, resourceType: owner.type as 'issue' | 'document', resourceId: owner.id,
          authorId: this.author(entry), body, createdAt: this.time(entry.row.createdAt, entry)! });
        this.bindings.set(entry.key, { type: 'comment', id, projectId: owner.projectId });
      }
    }
    for(const document of this.result.documents){const current=this.primaryById.get(document.id)!,entries=(revisions.get(document.id)||[]).sort((a,b)=>Number(a.row.metadata.version||0)-Number(b.row.metadata.version||0)||string(a.row.createdAt).localeCompare(string(b.row.createdAt))||a.key.localeCompare(b.key));let highest=0;
      for(const entry of entries){let version=Number(entry.row.metadata.version);if(!Number.isSafeInteger(version)||version<1||version>1000000000||version<=highest){version=highest+1;this.notice('REVISION_VERSION_RENUMBERED','원본 버전 번호가 없거나 중복되어 현재 이력에는 순서를 부여했습니다. 원래 번호는 보관합니다.','warning',entry,true);}highest=version;const id=randomUUID(),converted=this.converted(entry);this.result.revisions.push({id,documentId:document.id,version,title:entry.row.title||document.title,content:converted.content,plainText:converted.plainText,authorId:this.author(entry),createdAt:this.time(entry.row.updatedAt||entry.row.createdAt,entry)!,summary:string(entry.row.metadata.versionComment)||`원본 버전 ${string(entry.row.metadata.version)||version}`});this.bindings.set(entry.key,{type:'revision',id,projectId:document.projectId});}
      const sourceVersion=Number(current.row.metadata.version);document.version=Number.isSafeInteger(sourceVersion)&&sourceVersion>highest&&sourceVersion<=1000000000?sourceVersion:highest+1;this.result.revisions.push({id:randomUUID(),documentId:document.id,version:document.version,title:document.title,content:document.content,plainText:document.plainText,authorId:document.authorId,createdAt:document.updatedAt,summary:'원본 현재 문서 이관'});
    }
  }

  private confluenceHistoryRestrictions(): Set<string> {
    const restricted = new Set<string>();
    const children = new Map<string, string[]>();
    for (const entry of this.entries) {
      const { kind, sourceId, references } = entry.row;
      if (kind !== 'page' && kind !== 'comment' && kind !== 'revision') continue;
      const key = JSON.stringify([kind, sourceId]);
      if (this.restricted(entry) || entry.row.metadata.restricted === true || kind === 'page' && this.restrictedSourcePages.has(sourceId)) {
        restricted.add(key);
      }
      if (kind === 'page') continue;
      for (const reference of references) {
        if (!pageOwnerRelations.has(reference.relation) && reference.relation !== 'original-version' &&
            !(reference.kind === 'comment' && reference.relation === 'parent')) continue;
        const parent = JSON.stringify([reference.kind, reference.sourceId]);
        const descendants = children.get(parent) ?? [];
        descendants.push(key);
        children.set(parent, descendants);
      }
    }
    // An export may only contain a reply while another selected export declares the parent's restrictions.
    for (const parent of restricted) for (const child of children.get(parent) ?? []) restricted.add(child);
    return restricted;
  }

  private confluenceHistoryCandidate(entry: Entry, sourceErrors: Set<string>, restricted: Set<string>): ConfluenceHistoryCandidate | null {
    const append = this.input.appendPages!;
    const { row } = entry;
    const blocked = (candidate: Entry) => this.excluded.has(candidate.key) || sourceErrors.has(candidate.key) ||
      restricted.has(JSON.stringify([candidate.row.kind, candidate.row.sourceId])) ||
      candidate.row.references.some(ref => ref.kind === 'project' && ref.relation === 'space' && ref.sourceId !== append.sourceSpaceId);
    if (!this.retainedEntries.has(entry.key) || blocked(entry)) return null;
    const sourcePageId = confluenceHistoryPage(row, (kind, id) => {
      const candidate = this.sourceEntry(entry, kind, id);
      return candidate && !blocked(candidate) ? candidate.row : undefined;
    });
    if (!sourcePageId || this.restrictedSourcePages.has(sourcePageId) || this.excludedConfluenceAttachmentPages.has(sourcePageId)) return null;
    const owner = this.originalPage(sourcePageId);
    if (!owner || (!hasConfluenceBody(row) && !(row.kind === 'comment' && row.textFormat === 'plain' && row.text.trim()))) return null;
    this.retainedPageOwners.set(entry.key, sourcePageId);
    if (row.kind === 'comment') return { entry, sourcePageId, owner, version: null };
    const version = confluenceSourceVersion(row);
    const current = this.sourceEntry(entry, 'page', sourcePageId);
    const currentVersion = current ? confluenceSourceVersion(current.row) : null;
    if (version === null || version >= Number.MAX_SAFE_INTEGER || row.sourceId === sourcePageId || (currentVersion !== null && version >= currentVersion)) return null;
    return { entry, sourcePageId, owner, version };
  }

  private historicalConfluenceAttachment(entry: Entry, sourcePageId: string, request: MigrationReferenceInput): ResolvedReference | null {
    if (request.attachmentOwner === null) return null;
    const owner = request.attachmentOwner === undefined ? sourcePageId : this.boundConfluenceAttachmentPage(entry, request);
    if (!owner || !request.sourceId) return null;
    const series = [...this.confluenceAttachmentSeries.get(owner)?.values() ?? []].filter(line =>
      line.entries.some(row => row.row.sourceId === request.sourceId) || line.known.some(file => file.sourceId === request.sourceId));
    // A filename and the current attachment ID can both point to new bytes in a later export.
    if (series.length !== 1 || series[0].sourceRootId === request.sourceId) return null;
    return this.lookupBoundConfluenceAttachment(entry, owner, request);
  }

  private createConfluenceHistory(): void {
    const append = this.input.appendPages;
    if (!append || this.configuration.appendPagesTo?.refreshHistory !== true) return;
    const versionKey = (sourcePageId: string, version: number) => JSON.stringify([sourcePageId, version]);
    const knownIds = new Set<string>(), knownVersions = new Set<string>(), sourceErrors = new Set<string>();
    for (const row of append.knownHistory ?? []) {
      knownIds.add(JSON.stringify([row.kind, row.sourceId]));
      if (row.kind === 'revision' && row.sourceVersion !== null && row.sourcePageId && this.originalPage(row.sourcePageId)?.documentId === row.documentId) {
        knownVersions.add(versionKey(row.sourcePageId, row.sourceVersion));
      }
    }
    for (const pkg of this.input.packages) for (const diagnostic of pkg.dataset.diagnostics) {
      if (diagnostic.severity === 'error' && diagnostic.recordId) sourceErrors.add(`${pkg.summary.id}/${diagnostic.recordId}`);
    }
    const groups = new Map<string, Entry[]>();
    for (const entry of this.entries) {
      if (entry.row.kind !== 'comment' && entry.row.kind !== 'revision') continue;
      const key = JSON.stringify([entry.row.kind, entry.row.sourceId]);
      if (knownIds.has(key)) continue;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const candidates: ConfluenceHistoryCandidate[] = [], versionCounts = new Map<string, number>();
    const restricted = this.confluenceHistoryRestrictions();
    let rawOnly = 0;
    for (const group of groups.values()) {
      const retained = group.filter(entry => this.retainedEntries.has(entry.key));
      if (!retained.length) continue;
      const candidate = this.confluenceHistoryCandidate(retained[0], sourceErrors, restricted);
      const original = retained.length > 1 ? JSON.stringify(retained[0].row) : null;
      if (!candidate || !this.uniqueConfluenceOrigin(group) || group.length !== retained.length || retained.slice(1).some(entry =>
        JSON.stringify(entry.row) !== original || this.confluenceHistoryCandidate(entry, sourceErrors, restricted)?.sourcePageId !== candidate.sourcePageId)) {
        rawOnly += retained.length;
        continue;
      }
      if (candidate.version !== null) {
        const key = versionKey(candidate.sourcePageId, candidate.version);
        if (knownVersions.has(key)) continue;
        versionCounts.set(key, (versionCounts.get(key) ?? 0) + 1);
      }
      candidates.push(candidate);
    }

    const owners = new Set<string>();
    let newConfluenceComments = 0, newConfluenceRevisions = 0;
    for (const { entry, sourcePageId, owner, version } of candidates) {
      if (version !== null && versionCounts.get(versionKey(sourcePageId, version)) !== 1) {
        rawOnly++;
        continue;
      }
      const { row } = entry;
      const title = row.title.trim() || owner.sourceTitle?.trim() || row.sourceId;
      if (version !== null && title.length > 300) {
        rawOnly++;
        continue;
      }
      const converted = convertLegacyContent(row, {
        resolveReference: request => version !== null && request.kind === 'attachment'
          ? this.historicalConfluenceAttachment(entry, sourcePageId, request) : this.resolve(entry, request),
        legacyAnnotations: version === null,
        resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, owner.projectId),
        resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, owner.projectId),
      });
      const createdAt = version !== null ? row.updatedAt || row.createdAt : row.createdAt;
      const invalidBody = version === null
        ? !converted.plainText.trim() || converted.plainText.length > 20000 || converted.diagnostics.some(item => item.severity === 'error')
        : !usableConfluenceBody(converted);
      if (invalidBody || (this.configuration.datePolicy !== 'import-time' && !sourceTimestamp(createdAt, this.configuration.timezone))) {
        rawOnly++;
        continue;
      }
      const id = randomUUID(), projectId = append.project.id, authorId = this.author(entry);
      const timestamp = this.time(createdAt, entry)!;
      if (version === null) {
        if (row.textFormat !== 'plain') this.notice('COMMENT_FORMAT_PLAIN_TEXT', '댓글은 일반 텍스트로 변환하며 원래 서식과 작성자·변경 시각은 원본 보관함에 유지합니다.', 'warning', entry, true);
        this.result.comments.push({ id, resourceType: 'document', resourceId: owner.documentId, authorId, body: converted.plainText, createdAt: timestamp });
        this.bindings.set(entry.key, { type: 'comment', id, projectId });
        newConfluenceComments++;
      } else {
        this.result.revisions.push({ id, documentId: owner.documentId, version, confluenceSourceVersion: version,
          title, content: converted.content, plainText: converted.plainText,
          authorId, createdAt: timestamp, summary: string(row.metadata.versionComment) || `원본 버전 ${version}` });
        this.bindings.set(entry.key, { type: 'revision', id, projectId });
        newConfluenceRevisions++;
      }
      this.confluenceHistoryOwners.set(entry.key, { type: 'document', id: owner.documentId, projectId });
      owners.add(owner.documentId);
    }
    if (rawOnly) this.notice('CONFLUENCE_HISTORY_RAW_ONLY', `소유 문서, 접근 범위, 버전, 제목, 본문 또는 날짜 문제로 댓글·이력 ${rawOnly}건은 원본으로 보관합니다.`, 'warning', undefined, true);
    this.result.confluenceHistoryOwners = [...owners];
    Object.assign(this.result.preview.counts, { newConfluenceComments, newConfluenceRevisions });
  }

  createRelations():void{
    const resourcePairs=new Set<string>(),issuePairs=new Set<string>();
    const resource=(issueId:string,documentId:string)=>{const key=JSON.stringify([issueId,documentId]);if(resourcePairs.has(key))return;resourcePairs.add(key);this.result.resourceLinks.push({id:randomUUID(),issueId,documentId,kind:'related'});};
    for(const document of this.result.documents)for(const reference of contentReferences(document.content))if(reference.type==='issue')resource(reference.id,document.id);
    for(const entry of this.entries){if(this.excluded.has(entry.key))continue;const binding=this.bindings.get(entry.key);if(binding?.type==='document')for(const reference of entry.row.references.filter(reference=>reference.kind==='issue')){const target=this.resolve(entry,{kind:'issue',sourceId:reference.sourceId});if(target)resource(target.id,binding.id);}
      if(entry.row.kind!=='relation'||entry.row.metadata.jiraRelationConflict===true)continue;const issueRefs=entry.row.references.filter(reference=>reference.kind==='issue'),pageRefs=entry.row.references.filter(reference=>reference.kind==='page'),issueTargets=issueRefs.map(reference=>this.resolve(entry,{kind:'issue',sourceId:reference.sourceId}));
      if(this.input.append&&!issueTargets.some(target=>target&&this.issueById.has(target.id)))continue;
      if (issueRefs.length >= 2) {
        if (issueTargets.some(target => !target)) {
          this.notice('ISSUE_RELATION_UNRESOLVED', '업무 연결의 일부 대상을 확인할 수 없습니다. 원본 연결은 보관합니다.', 'warning', entry, true);
          continue;
        }
        const [source, target] = issueTargets as { id: string; label: string }[];
        const link = entry.pkg.dataset.source.product === 'jira' ? jiraIssueRelationSource(entry.row) : null;
        const type = link?.typeName ?? (entry.row.title || string(entry.row.metadata.name || entry.row.metadata.relationship) || 'related');
        const [sourceId, targetId] = !link ? [source.id, target.id] : jiraRelationEndpoints(link,
          link.sourceAlias === link.storedSourceAlias ? source.id : target.id,
          link.targetAlias === link.storedTargetAlias ? target.id : source.id);
        const key = JSON.stringify([sourceId, targetId, type]);
        if (type.length > 120) this.notice('ISSUE_RELATION_TYPE_LIMIT', '원본 연결 이름이 현재 120자 제한을 넘습니다.', 'error', entry);
        if (sourceId === targetId) this.notice('ISSUE_RELATION_SELF', '자기 자신을 가리키는 업무 연결은 현재 연결 모델에 적용할 수 없습니다.', 'error', entry);
        else if (!issuePairs.has(key)) {
          issuePairs.add(key);
          const traceable = link && this.tracedJiraEndpoint(entry, link.storedSourceAlias, source.id) &&
            this.tracedJiraEndpoint(entry, link.storedTargetAlias, target.id);
          this.addIssueRelation(entry, source.id, target.id, type, Boolean(traceable));
        }
      }
      if(issueRefs.length&&pageRefs.length){for(const issue of issueTargets)for(const page of pageRefs){const target=this.resolve(entry,{kind:'page',sourceId:page.sourceId,url:string(entry.row.metadata.url)||undefined});if(issue&&target)resource(issue.id,target.id);else this.notice('DOCUMENT_ISSUE_LINK_UNRESOLVED','업무·문서 연결의 원본 ID/주소를 유일하게 확인하지 못해 임의 연결하지 않았습니다.','warning',entry,true);}}
    }
    this.createJiraRelationRefresh();
    if (this.result.issueRelations.length) this.notice('ISSUE_RELATIONS_PRESERVED', '원본 업무 연결을 관계로 보존합니다. 같은 프로젝트의 차단 관계는 이관 후 티켓에서 일정 연결을 검토할 수 있습니다.', 'info');
  }
  private tracedJiraEndpoint(entry: Entry, alias: string, issueId: string): boolean {
    if (this.originalIssue(alias)?.id === issueId) return true;
    const candidates = this.referenceIndex.get(JSON.stringify(['issue', 'id', alias])) ?? [];
    return candidates.some(candidate => candidate.pkg.dataset.source.product === 'jira' &&
      candidate.pkg.dataset.source.instanceKey === entry.pkg.dataset.source.instanceKey &&
      !this.excluded.has(candidate.key) && this.bindings.get(candidate.key)?.id === issueId);
  }
  private addIssueRelation(entry: Entry, sourceIssueId: string, targetIssueId: string, type: string, jira: boolean) {
    const id = randomUUID();
    this.result.issueRelations.push({ id, sourceIssueId, targetIssueId, type, version: 1,
      createdAt: this.time(entry.row.createdAt, entry, false) || this.input.now });
    if (jira) this.jiraRelationIds.set(entry.key, id);
  }

  private createJiraRelationRefresh(): void {
    const append = this.input.append;
    if (!append || this.configuration.appendTo?.refreshRelations !== true) return;
    const context = append.relationRefresh;
    if (!context) return;
    const issues = new Map(context.issues.map(issue => [issue.id, issue]));
    const scope = this.jiraChildScope(append);
    const pair = (source: string, target: string) => JSON.stringify([source, target]);
    const stored = new Set(context.active.filter(relation => relation.origin === undefined)
      .map(relation => JSON.stringify([relation.sourceIssueId, relation.targetIssueId, relation.type])));
    const liveImported = new Set(context.active.map(relation => relation.id));
    const native = new Set(context.active.filter(isTeamspaceIssueRelation)
      .map(relation => JSON.stringify([relation.sourceIssueId, relation.targetIssueId, relation.type])));
    const knownIds = new Set<string>();
    const knownPairs = new Map<string, { link: JiraIssueRelationSource; active: boolean }[]>();
    const remember = (link: JiraIssueRelationSource, source: string, target: string, active: boolean) => {
      const key = pair(...jiraRelationEndpoints(link, source, target));
      const entries = knownPairs.get(key) ?? [];
      entries.push({ link, active });
      knownPairs.set(key, entries);
    };
    for (const { record, relationId } of context.previouslyApplied) {
      const link = jiraIssueRelationSource(record);
      if (!link) continue;
      if (link.stableSourceId) knownIds.add(link.stableSourceId);
      const source = this.originalIssue(link.sourceAlias)?.id;
      const target = this.originalIssue(link.targetAlias)?.id;
      if (source && target) remember(link, source, target, liveImported.has(relationId));
    }
    for (const record of context.legacy) {
      const link = jiraIssueRelationSource(record);
      if (!link) continue;
      const source = this.originalIssue(link.storedSourceAlias)?.id;
      const target = this.originalIssue(link.storedTargetAlias)?.id;
      if (!source || !target || !stored.has(JSON.stringify([source, target, link.typeName]))) continue;
      if (link.stableSourceId) knownIds.add(link.stableSourceId);
      remember(link, link.sourceAlias === link.storedSourceAlias ? source : target,
        link.targetAlias === link.storedTargetAlias ? target : source, true);
    }

    const candidates: { entry: Entry; link: JiraIssueRelationSource; sourceId: string; targetId: string }[] = [];
    const layouts = new Map<string, { link: JiraIssueRelationSource; endpoints: [string, string] }>();
    const ambiguousIds = new Set<string>();
    let skipped = 0;
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product !== 'jira' || this.excluded.has(entry.key)) continue;
      if (entry.row.kind === 'relation' && entry.row.metadata.jiraRelationConflict === true) {
        ambiguousIds.add(entry.row.sourceId);
        skipped++;
        continue;
      }
      const link = jiraIssueRelationSource(entry.row);
      if (!link) continue;
      const resolved = [link.sourceAlias, link.targetAlias].map(sourceId => this.resolve(entry, { kind: 'issue', sourceId }));
      if (link.stableSourceId) {
        const identity = (alias: string, resolvedId?: string) => {
          const id = this.boundIssues.get(alias)?.issueId ?? resolvedId;
          return id ? `issue:${id}` : `jira:${alias}`;
        };
        const endpoints: [string, string] = [identity(link.sourceAlias, resolved[0]?.id), identity(link.targetAlias, resolved[1]?.id)];
        const prior = layouts.get(link.stableSourceId);
        if (!prior) layouts.set(link.stableSourceId, { link, endpoints });
        else {
          const symmetric = prior.link.nativeType === 'related' || link.nativeType === 'related';
          const [source, target] = prior.endpoints;
          const sameEndpoints = (source === endpoints[0] && target === endpoints[1]) ||
            (symmetric && source === endpoints[1] && target === endpoints[0]);
          if (!sameEndpoints || !sameJiraRelationType(prior.link, link)) ambiguousIds.add(link.stableSourceId);
        }
      }
      if (resolved.some(issue => issue && this.issueById.has(issue.id))) continue;
      const source = this.resolveJiraChildOwner(entry, [link.sourceAlias], issues, scope);
      const target = this.resolveJiraChildOwner(entry, [link.targetAlias], issues, scope);
      if (!source || !target || source.id === target.id) {
        skipped++;
        this.notice('JIRA_RELATION_SCOPE_UNRESOLVED', '같은 원본 프로젝트에 연결된 두 업무를 확인할 수 없어 원본 관계를 보관합니다.', 'warning', entry, true);
        continue;
      }
      const [sourceId, targetId] = jiraRelationEndpoints(link, source.id, target.id);
      const candidate = { entry, link, sourceId, targetId };
      candidates.push(candidate);
    }

    const preview: NonNullable<MigrationPreview['jiraRelationRefresh']> = [];
    let added = 0;
    for (const { entry, link, sourceId, targetId } of candidates) {
      const stable = link.stableSourceId;
      if (stable && ambiguousIds.has(stable)) {
        skipped++;
        this.notice('JIRA_RELATION_ID_CONFLICT', '같은 Jira 관계 ID의 대상 또는 유형이 여러 원본에서 달라 관계를 보관합니다.', 'warning', entry, true);
        continue;
      }
      const matches = knownPairs.get(pair(sourceId, targetId))?.some(evidence => sameJiraRelationType(evidence.link, link) &&
        (evidence.active || !evidence.link.stableSourceId || !stable));
      const nativeMatch = link.nativeType && native.has(JSON.stringify([sourceId, targetId, link.nativeType]));
      if ((stable && knownIds.has(stable)) || matches || nativeMatch) {
        skipped++;
        continue;
      }
      this.addIssueRelation(entry, sourceId, targetId, link.typeName, true);
      added++;
      if (stable) knownIds.add(stable);
      remember(link, sourceId, targetId, true);
      if (preview.length < 20) preview.push({ recordId: entry.key, sourceKey: issues.get(sourceId)!.key,
        targetKey: issues.get(targetId)!.key, type: link.typeName });
    }
    if (preview.length) this.result.preview.jiraRelationRefresh = preview;
    if (skipped) this.notice('JIRA_RELATIONS_RETAINED', '이미 처리한 관계와 현재 연결은 유지합니다. 확인이 필요한 링크는 원본 기록에서 검토할 수 있습니다.', 'info');
    Object.assign(this.result.preview.counts, { newJiraRelations: added, skippedJiraRelations: skipped });
  }
  validateGraph():void{
    const cyclic=(rows:{id:string;parentId:string|null}[], appended:boolean)=>{const incoming=new Map(rows.map(row=>[row.id,0])),children=new Map<string,string[]>();for(const row of rows)if(row.parentId&&(!appended||incoming.has(row.parentId))){incoming.set(row.id,(incoming.get(row.id)||0)+1);const values=children.get(row.parentId)||[];values.push(row.id);children.set(row.parentId,values);}const queue=[...incoming].filter(([,count])=>!count).map(([id])=>id);for(let cursor=0;cursor<queue.length;cursor++)for(const child of children.get(queue[cursor])||[]){const count=incoming.get(child)!-1;incoming.set(child,count);if(!count)queue.push(child);}return queue.length!==rows.length;};
    if(cyclic(this.result.issues, Boolean(this.input.append)))this.notice('ISSUE_PARENT_CYCLE','이관할 업무 계층에 순환 관계가 있습니다.','error');if(cyclic(this.result.documents, Boolean(this.input.appendPages)))this.notice('DOCUMENT_PARENT_CYCLE','이관할 문서 계층에 순환 관계가 있습니다.','error');
    const issueIds = new Set(this.result.issues.map(issue => issue.id));
    const bodies = new Map(this.result.documents.map(document => [document.id, document.content]));
    for (const update of this.result.documentUpdates ?? []) if (update.changes.content) bodies.set(update.documentId, update.changes.content);
    const incoming = new Map([...bodies.keys()].map(id => [id, 0]));
    const edges = new Map<string, string[]>();
    for (const [documentId, body] of bodies) {
      const targets: string[] = [];
      for (const reference of contentReferences(body)) {
        const present = reference.type === 'issue' ? issueIds.has(reference.id) : incoming.has(reference.id) || this.boundPageTargets.has(reference.id);
        if (!present) this.notice('CONTENT_REFERENCE_MISSING', '변환한 본문의 참조 대상이 적용 계획에 없습니다.', 'error');
        if (reference.kind === 'include' && incoming.has(reference.id)) {
          targets.push(reference.id);
          incoming.set(reference.id, incoming.get(reference.id)! + 1);
        }
      }
      edges.set(documentId, targets);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const target of edges.get(queue[cursor]) ?? []) {
        const count = incoming.get(target)! - 1;
        incoming.set(target, count);
        if (count === 0) queue.push(target);
      }
    }
    if (queue.length !== incoming.size) this.notice('DOCUMENT_INCLUDE_CYCLE', '이관할 문서 포함 관계에 순환이 있습니다. 원본을 제외하거나 매핑을 검토해 주세요.', 'error');
    for(const schema of this.result.issueSchemas)for(const field of schema.fields)if((field.kind==='select'||field.kind==='multi_select')&&(!field.options.some(option=>!option.archived)||field.options.length>200||field.options.some(option=>!option.name.trim()||option.name.length>120)||new Set(field.options.map(option=>option.name)).size!==field.options.length))this.notice('FIELD_OPTIONS_INVALID',`선택형 필드 '${field.name}'의 활성 선택지·이름·개수 제한을 확인해 주세요.`,'error');
  }
  createWorklogs():void {
    const included = new Set<string>();
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product!=='jira'||!isJiraWorklog(entry.row)||this.skip(entry)) continue;
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
        const converted = this.converted(entry, { legacyAnnotations: true });
        if (converted.plainText.trim().length<=2000) note=converted.plainText.trim();
        else this.notice('WORKLOG_NOTE_ARCHIVED','작업 메모가 2,000자를 초과합니다. 작업 시간은 적용하고 전체 메모는 원본에 보관합니다.','warning',entry,true);
      }
      this.addJiraWorklog(entry, issue, authorId, parsed, note);
    }
  }
  private addJiraWorklog(entry: Entry, issue: JiraHistoryIssue, authorId: string, parsed: ParsedJiraWorklog, note: string): void {
    this.result.worklogs.push({
      id: randomUUID(), issueId: issue.id, projectId: issue.projectId, issueKey: issue.key, issueTitle: issue.title,
      authorId, workDate: parsed.workDate, minutes: parsed.durationSeconds / 60, durationSeconds: parsed.durationSeconds,
      note, version: 1, createdAt: this.input.now, updatedAt: this.input.now, sourceRecordId: this.archiveIds.get(entry.key)!,
    });
  }
  private resolveJiraChildOwner<T extends Pick<Issue, 'id' | 'projectId'>>(entry: Entry, aliases: string[] | null,
    issues: ReadonlyMap<string, T>, { durable, blocked, sourceErrors }: JiraChildScope): T | undefined {
    if (sourceErrors.has(entry.key) || this.restricted(entry)) return undefined;
    if (!aliases) return undefined;
    const [ownerId, ...others] = aliases.map(alias => this.originalIssue(alias)?.id);
    if (!ownerId || blocked.has(ownerId) || others.some(id => id !== ownerId)) return undefined;
    for (const alias of aliases) {
      const packageRows = (this.referenceIndex.get(JSON.stringify(['issue', 'id', alias])) ?? [])
        .filter(issue => issue.pkg.summary.id === entry.pkg.summary.id);
      if (packageRows.length > 1) return undefined;
      const [row] = packageRows;
      if (row && (!this.retainedEntries.has(row.key) || !row.row.containerId)) return undefined;
      // A temporary alias can use its own export's Issue row as proof. A child in a
      // different package needs an earlier durable binding for the supplied alias.
      const matches = [durable.get(alias), ...(row ? [durable.get(row.row.sourceId), durable.get(string(row.row.metadata.key))] : [])]
        .filter((target): target is string => target !== undefined);
      if (!matches.length || matches.some(target => target !== ownerId)) return undefined;
    }
    return issues.get(ownerId);
  }
  private jiraChildScope(append: NonNullable<MigrationPlanningInput['append']>): JiraChildScope {
    const durable = new Map(append.knownIssues.filter(issue => issue.projectId === append.project.id).map(issue => [issue.alias, issue.issueId]));
    const blocked = new Set<string>();
    const sourceErrors = new Set(this.input.packages.flatMap(({ summary, dataset }) => dataset.diagnostics
      .filter(diagnostic => diagnostic.severity === 'error' && diagnostic.recordId)
      .map(diagnostic => `${summary.id}/${diagnostic.recordId}`)));
    for (const entry of this.entries) {
      const { row } = entry;
      if (entry.pkg.dataset.source.product !== 'jira' || row.kind !== 'issue' ||
          !(this.excluded.has(entry.key) || sourceErrors.has(entry.key) || isRestrictedJiraHistoryOwner(row) || this.restricted(entry))) continue;
      for (const alias of [row.sourceId, string(row.metadata.key)]) {
        const issueId = this.originalIssue(alias)?.id;
        if (issueId) blocked.add(issueId);
      }
    }
    return { durable, blocked, sourceErrors };
  }
  private createJiraHistory(): void {
    const append = this.input.append;
    if (!append || this.configuration.appendTo?.refreshHistory !== true) return;
    const issues = new Map(append.historyIssues?.filter(issue => issue.projectId === append.project.id).map(issue => [issue.id, issue]));
    const scope = this.jiraChildScope(append);
    const groups = new Map<string, { kind: 'comment' | 'worklog'; entries: Entry[] }>();
    let rawOnly = 0;
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product !== 'jira') continue;
      const { row } = entry;
      if (this.excluded.has(entry.key) || !jiraHistoryKind(row)) continue;
      const source = jiraHistorySourceKey(row);
      if (!source) {
        if (this.retainedEntries.has(entry.key)) rawOnly++;
        continue;
      }
      const key = JSON.stringify([source.kind, source.sourceId]);
      if (this.knownJiraHistory.has(key)) continue;
      const group = groups.get(key) ?? { kind: source.kind, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    }
    let newJiraComments = 0, newJiraWorklogs = 0;
    for (const { kind, entries } of groups.values()) {
      const retained = entries.filter(entry => this.retainedEntries.has(entry.key));
      if (entries.length > 1 && retained.length !== entries.length) {
        for (const entry of entries) this.retainedEntries.add(entry.key);
        rawOnly += entries.length;
        continue;
      }
      if (!retained.length) continue;
      const [entry, ...duplicates] = retained;
      const owner = this.resolveJiraChildOwner(entry, jiraHistoryOwnerAliases(entry.row), issues, scope);
      const authorId = this.mappedAuthor(entry);
      const raw = duplicates.length ? JSON.stringify(entry.row) : null;
      if (!owner || !authorId || duplicates.some(duplicate =>
        JSON.stringify(duplicate.row) !== raw || this.mappedAuthor(duplicate) !== authorId ||
        this.resolveJiraChildOwner(duplicate, jiraHistoryOwnerAliases(duplicate.row), issues, scope)?.id !== owner.id)) {
        rawOnly += retained.length;
        continue;
      }
      const { row } = entry;
      if (kind === 'comment') {
        const createdAt = sourceTimestamp(row.createdAt, this.configuration.timezone);
        const converted = convertLegacyContent(row, { resolveReference: request => this.resolve(entry, request), legacyAnnotations: true });
        if (!createdAt || !converted.plainText.trim() || converted.plainText.length > 20_000 ||
            converted.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
          rawOnly++;
          continue;
        }
        if (row.createdAt && jiraEnglishDate(row.createdAt)?.century) this.notice('DATE_TWO_DIGIT_CENTURY',
          'Jira 두 자리 연도를 2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.', 'warning', entry, true);
        if (row.textFormat !== 'plain') this.notice('COMMENT_FORMAT_PLAIN_TEXT',
          '댓글은 일반 텍스트로 변환하며 원래 서식과 작성자·변경 시각은 원본 보관함에 유지합니다.', 'warning', entry, true);
        const id = randomUUID();
        this.result.comments.push({ id, resourceType: 'issue', resourceId: owner.id, authorId, body: converted.plainText, createdAt });
        this.bindings.set(entry.key, { type: 'comment', id, projectId: owner.projectId });
        newJiraComments++;
      } else {
        const parsed = parseJiraWorklog(row, this.configuration.timezone);
        if ('code' in parsed) {
          this.notice(parsed.code, parsed.message, 'warning', entry, true);
          rawOnly++;
          continue;
        }
        let note = '';
        if (row.text && row.text !== 'null') {
          const converted = convertLegacyContent(row, { resolveReference: request => this.resolve(entry, request), legacyAnnotations: true });
          const body = converted.plainText.trim();
          if (body.length <= 2000 && !converted.diagnostics.some(diagnostic => diagnostic.severity === 'error')) note = body;
          else this.notice('WORKLOG_NOTE_ARCHIVED', '작업 시간은 적용하고 변환할 수 없는 메모는 원본으로 보관합니다.', 'warning', entry, true);
        }
        this.addJiraWorklog(entry, owner, authorId, parsed, note);
        newJiraWorklogs++;
      }
      this.jiraHistoryOwners.set(entry.key, owner);
    }
    if (rawOnly) this.notice('JIRA_HISTORY_RAW_ONLY', `업무 연결, 원본 ID, 접근 범위, 작성자, 날짜 또는 본문을 확인할 수 없는 댓글·작업 시간 ${rawOnly}건은 원본으로 보관합니다.`, 'warning', undefined, true);
    this.result.jiraHistoryOwners = [...new Set([...this.jiraHistoryOwners.values()].map(issue => issue.id))];
    Object.assign(this.result.preview.counts, { newJiraComments, newJiraWorklogs, retainedRecords: this.retainedEntries.size });
  }
  archive():void{
    for (const entry of this.entries) {
      const excluded = this.excluded.has(entry.key);
      const issueCheckpoint = this.jiraRefreshCheckpoints.get(entry.key);
      const pageCheckpoint = this.confluenceRefreshCheckpoints.get(entry.key);
      const binding = issueCheckpoint ? { type: 'issue' as const, id: issueCheckpoint.issue.id, projectId: issueCheckpoint.issue.projectId }
        : pageCheckpoint ? { type: 'document' as const, id: pageCheckpoint.document.id, projectId: pageCheckpoint.document.projectId }
        : excluded ? undefined : this.bindings.get(entry.key);
      const restrictedJiraHistory = entry.pkg.dataset.source.product === 'jira' && isRestrictedJiraStatusHistory(entry.row);
      const ownerEntry = excluded || restrictedJiraHistory ? null : this.ownerEntry(entry);
      const jiraHistoryOwner = this.jiraHistoryOwners.get(entry.key);
      const jiraAttachmentOwner = this.jiraAttachmentOwners.get(entry.key);
      const owner = issueCheckpoint || pageCheckpoint ? binding : jiraHistoryOwner ? { type: 'issue' as const, id: jiraHistoryOwner.id, projectId: jiraHistoryOwner.projectId } :
        jiraAttachmentOwner ?? this.confluenceAttachmentOwners.get(entry.key) ?? this.confluenceHistoryOwners.get(entry.key) ??
        (ownerEntry ? this.bindings.get(ownerEntry.key) : undefined);
      const ownerType = owner?.type === 'issue' || owner?.type === 'document' ? owner.type : null;
      const createdIssue = binding?.type === 'issue' ? this.issueById.get(binding.id) : undefined;
      const issueHashes = issueCheckpoint?.hashes ??
        (createdIssue && entry.pkg.dataset.source.product === 'jira' ? jiraFieldDigests(createdIssue) : undefined);
      const customHashes = issueCheckpoint?.customHashes ??
        (createdIssue && entry.pkg.dataset.source.product === 'jira' ? this.initialJiraCustomFieldHashes(entry, createdIssue) : undefined);
      const createdPage = binding?.type === 'document' ? this.documentById.get(binding.id) : undefined;
      const pageHashes = pageCheckpoint?.hashes ??
        (createdPage && entry.pkg.dataset.source.product === 'confluence' ? confluencePageFieldDigests({ ...createdPage, labels: createdPage.labels ?? [] }) : undefined);
      const value: SourceRecordArchive = {
        id: this.archiveIds.get(entry.key) || randomUUID(), sourceImportId: this.input.id,
        packageSha256: entry.pkg.summary.sha256, source: structuredClone(entry.pkg.dataset.source), record: structuredClone(entry.row),
        targetType: binding?.type ?? null, targetId: binding?.id ?? null, targetProjectId: binding?.projectId ?? owner?.projectId ?? null,
        ownerType, ownerId: ownerType ? owner!.id : null,
        ...(excluded ? { excluded: true } : {}),
        ...(jiraHistoryOwner ? { jiraHistoryAppend: true } : {}),
        ...(jiraAttachmentOwner ? { jiraAttachmentAppend: true } : {}),
        ...(this.jiraRelationIds.has(entry.key) ? { jiraRelationId: this.jiraRelationIds.get(entry.key)! } : {}),
        ...(issueHashes ? { jiraIssueFieldHashes: issueHashes } : {}),
        ...(customHashes ? { jiraCustomFieldHashes: customHashes } : {}),
        ...(pageHashes && Object.keys(pageHashes).length ? { confluencePageFieldHashes: pageHashes } : {}),
      };
      if (entry.row.kind === 'project' || entry.row.kind === 'identity') {
        value.ownerType = null;
        value.ownerId = null;
      }
      this.result.sourceRecords.push(value);
    }
  }
  private collectReusedAttachmentVersions(): void {
    if (!this.input.appendPages) return;
    const versions = new Map<string, AttachmentVersion>();
    const collect = (value: unknown) => {
      if (typeof value !== 'string') return;
      const match = /^\/api\/attachments\/([^/?]+)\/content(?:\?inline=1)?$/.exec(value);
      const version = match && this.borrowedAttachmentVersions.get(match[1]);
      if (version) versions.set(version.id, version);
    };
    const pending: RichContent[] = [...this.result.documents, ...this.result.revisions].map(document => document.content);
    for (const update of this.result.documentUpdates ?? []) if (update.changes.content) pending.push(update.changes.content);
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'image') collect(node.attrs?.src);
      for (const mark of node.marks ?? []) if (mark.type === 'link') collect(mark.attrs?.href);
      for (const child of node.content ?? []) pending.push(child);
    }
    this.result.reusedAttachmentVersions = [...versions.values()];
    this.result.preview.counts.reusedConfluenceAttachmentVersions = versions.size;
  }

  finish():PreparedMigration{
    this.collectReusedAttachmentVersions();
    if (!this.result.confluenceHistoryOwners?.length && !this.result.jiraHistoryOwners?.length && !this.result.jiraAttachmentOwners?.length &&
        this.result.preview.counts.newJiraRelations === undefined) for (const { message, entry } of this.deferredPrimaryNotices) {
      this.notice('SOURCE_NO_PRIMARY_CONTENT', message, 'error', entry);
    }
    const counts:Record<string,number>={...this.result.preview.counts,sourceRecords:this.entries.length,excludedRecords:this.excluded.size,projects:this.result.projects.length,issues:this.result.issues.length,documents:this.result.documents.length,comments:this.result.comments.length,revisions:this.result.revisions.length,attachments:this.result.attachments.length,attachmentVersions:this.result.attachmentVersions.length,fileCopies:this.result.fileCopies.length,attachmentBytes:this.result.fileCopies.reduce((sum,file)=>sum+file.size,0),resourceLinks:this.result.resourceLinks.length,issueRelations:this.result.issueRelations.length};
    const atlassianLinks = this.result.atlassianLinks.length;
    Object.assign(counts, { atlassianLinks, unlinkedAtlassianRecords: this.primaryById.size - atlassianLinks });
    const sourceWorklogs = this.entries.filter(entry=>entry.pkg.dataset.source.product==='jira'&&isJiraWorklog(entry.row)).length;
    if (sourceWorklogs) Object.assign(counts,{worklogs:this.result.worklogs.length,archivedWorklogs:sourceWorklogs-this.result.worklogs.length});
    if(Object.entries(counts).filter(([key])=>['issues','documents','comments','revisions','attachmentVersions','resourceLinks','issueRelations','worklogs'].includes(key)).reduce((sum,[,value])=>sum+value,0)>MAX_RECORDS)this.notice('CANONICAL_RECORD_LIMIT','생성할 현재 객체·이력·파일 버전 합계가100000개를 넘습니다.','error');
    const target = this.input.append?.project ?? this.input.appendPages?.project;
    const projects = target ? [target] : this.result.projects;
    this.result.preview.projects=projects.map(project=>({id:project.id,key:project.key,name:project.name,issueCount:this.result.issues.filter(issue=>issue.projectId===project.id).length,documentCount:this.result.documents.filter(document=>document.projectId===project.id).length}));
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
        ...('startDate' in item && (item.startDate || item.endDate) ? { schedule: { startDate: item.startDate, endDate: item.endDate } } : {}),
      });
    }
    if (this.input.append && !this.result.issues.length && !this.result.issueUpdates?.length && !this.result.jiraHistoryOwners?.length && !this.result.jiraAttachmentOwners?.length && !counts.newJiraRelations && !this.notices.some(notice => notice.severity === 'error')) {
      if (this.configuration.appendTo?.refreshRelations) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 업무 관계나 다른 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshAttachments) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 첨부나 다른 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshHistory) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 업무·댓글·작업 시간이나 기존 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshExisting || this.configuration.appendTo?.refreshCustomFields) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 업무나 기존 업무 변경분이 없습니다.', 'error');
      }
      else this.notice('APPEND_NO_NEW_ISSUES', '이 프로젝트에 추가할 새 Jira 업무가 없습니다.', 'error');
    }
    if (this.input.appendPages && !this.result.documents.length && !this.result.documentUpdates?.length && !this.result.confluenceAttachmentOwners?.length && !this.result.confluenceHistoryOwners?.length && !this.notices.some(notice => notice.severity === 'error')) {
      if (this.configuration.appendPagesTo?.refreshExisting || this.configuration.appendPagesTo?.refreshAttachments || this.configuration.appendPagesTo?.refreshHistory) {
        this.notice('CONFLUENCE_REFRESH_NO_CHANGES', '적용할 새 Confluence 문서·첨부·댓글·이력이나 기존 문서 변경분이 없습니다.', 'error');
      }
      else this.notice('APPEND_NO_NEW_PAGES', '이 프로젝트에 추가할 새 Confluence 페이지가 없습니다.', 'error');
    }
    this.result.preview.counts=counts;this.result.sourceImport.counts=counts;this.result.sourceImport.projectIds=projects.map(project=>project.id);this.result.preview.requiredAcknowledgements=[...new Set(this.notices.filter(notice=>notice.requiresAcknowledgement).map(notice=>notice.code))];this.result.preview.canApply=!this.notices.some(notice=>notice.severity==='error');return this.result;
  }
}

/** Pure planning: IDs are allocated once and persisted by the caller with its immutable preview. */
export function buildMigrationPlan(input:MigrationPlanningInput):PreparedMigration{return new Planner(input).run();}
