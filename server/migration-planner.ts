import { createHash,randomUUID } from 'node:crypto';
import type { AttachmentVersion,ConfluenceMigrationDocumentField,ConfluenceMigrationDocumentReview,ConfluenceMigrationDocumentValues,ConfluenceMigrationPageFieldHashes,CustomFieldDefinition,CustomFieldKind,CustomFieldValue,DocPage,DocumentSourceSelection,Issue,JiraMigrationCustomFieldHashes,JiraMigrationIssueField,JiraMigrationIssueFieldHashes,JiraMigrationIssueSourceFieldHashes,JiraMigrationIssueReview,JiraMigrationIssueValues,LegacyRecord,LegacyValue,MigrationConfiguration,MigrationNotice,MigrationOptions,MigrationValueOption,Project,ProjectIssueSchema,ProjectWorkflow,RichContent,SourceRecordArchive,StatusCategory } from '../shared/types.js';
import { CONFLUENCE_MIGRATION_DOCUMENT_FIELDS,ISSUE_TYPES,JIRA_MIGRATION_ISSUE_FIELDS,MIGRATION_AUTHOR_KINDS,PRIORITY } from '../shared/types.js';
import { isJiraHierarchyIssueId, jiraParentEvidence } from './migration-jira-hierarchy.js';
import { defaultIssueSchema, fieldApplies, fieldValueLabel, visibleIssueFieldIds } from '../shared/issue-schema.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import { isCalendarDate } from '../shared/calendar.js';
import { MAX_PLANNED_EFFORT_MINUTES } from '../shared/project-workload.js';
import { documentChildLists } from '../shared/document-child-list.js';
import { documentPropertyReports } from '../shared/document-properties.js';
import { documentLabelKey, MAX_DOCUMENT_LABELS, normalizeDocumentLabel, normalizeDocumentLabels } from '../shared/document-labels.js';
import { documentSectionHash } from '../shared/document-sections.js';
import { contentReferences } from '../shared/document-nodes.js';
import { isJiraIssueKey } from '../shared/atlassian-links.js';
import { readDocumentSelection } from './document-content.js';
import { convertLegacyContent, hasConfluenceEngineeringEntity } from './migration-content.js';
import { confluenceParentEvidence, confluencePositionEvidence } from './migration-confluence-hierarchy.js';
import { confluenceSectionAliases, legacySectionId } from './migration-confluence-sections.js';
import { hasConfluencePropertyMacro, hasConfluencePropertyReportMacro } from './migration-confluence-properties.js';
import { isJiraWorklog,parseJiraWorklog, type ParsedJiraWorklog } from './migration-worklog.js';
import { jiraWorklogNoteHash, jiraWorklogProjectedNote, jiraWorklogSourceUpdatedAt } from './jira-worklog-corrections.js';
import { jiraCommentBodyHash, jiraCommentProjectedBody, jiraCommentSourceUpdatedAt } from './jira-comment-corrections.js';
import type { MigrationContentContext, MigrationPageIdentity, MigrationReferenceInput } from './migration-content.js';
import { safeFilename } from './attachments.js';
import type { MigrationConfluenceKnownAttachment,MigrationJiraRefreshCandidate,MigrationPackage,MigrationPageAppendContext,MigrationPlanningInput,PreparedMigration } from './migration-contracts.js';
import { confluenceMigrationPageAddress, confluenceMigrationPageKey, isWithinMigrationOrigin, migrationOriginLink, parseMigrationOriginBase,
  type ConfluenceMigrationPageAddress, type MigrationOriginBase } from './migration-origin-links.js';
import type { RetainedJiraResourceLink, RetainedResourcePage } from './migration-retained-resource-links.js';
import { confluenceHistoryPage } from './source-preservation.js';
import { jiraCustomRawField, jiraCustomSourceFieldAliases, jiraCustomSourceFieldId, jiraCustomValueDigest } from './migration-jira-fields.js';
import { jiraMigrationIssueAddress, jiraRenderedHtmlDescription, projectJiraDescription } from './migration-jira-description.js';
import { jiraAdministratorFixAssociation, jiraReleaseVersionId, planJiraReleases } from './migration-jira-releases.js';
import { jiraSprintCatalogId, planJiraSprints } from './migration-jira-sprints.js';
import { JIRA_COMPONENTS_FIELD_ID, JIRA_RAW_COMPONENTS_FIELD_ID } from './legacy-import-jira-components.js';
import { readJiraStatusCategory, type JiraStatusCategory } from './legacy-jira-status-category.js';
import { buildJiraComponentOptions } from './migration-jira-component-options.js';
import { jiraEnglishDate, sourceTimestamp } from './migration-source-time.js';
import { confluenceIdentityEmailEvidence, jiraIdentityEmailEvidence } from './migration-identity-email.js';
import { hasRestrictedJiraServiceDeskComment, isRestrictedJiraAttachment, isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, isRestrictedJiraStatusHistory, jiraAttachmentFileEvidence, jiraAttachmentOwnerAliases, jiraAttachmentSourceId, jiraHistoryKind, jiraHistoryOwnerAliases, jiraHistorySourceKey, jiraServiceDeskAttachmentNames, jiraStatusHistoryOwnerAliases, jiraStatusTransitions } from './migration-jira-history.js';
import { jiraIssueRelationSource, jiraRelationEndpoints, sameJiraRelationType, type JiraIssueRelationSource } from './migration-jira-relations.js';
import { isDonefacIssueRelation } from '../shared/issue-relations.js';
import { migrationOptionId as optionId } from './migration-option-id.js';
import type { JiraMigrationCommentReview, JiraMigrationWorklogReview, LegacySource, MigrationAuthorExpectation, MigrationAuthorKind, MigrationAuthorStatus, MigrationJiraObservedTransition, MigrationJiraObservedWorkflow, MigrationJiraWorkflow, MigrationJiraWorkflowStatus, MigrationPreview, MigrationPreviewProject, MigrationPreviewProjectSource } from '../shared/types.js';

const MAX_PACKAGES=20,MAX_RECORDS=100000,MAX_EXPANDED_BYTES=256*1024*1024,MAX_PROJECTS=100,MAX_FILE_BYTES=20*1024*1024;
const MAX_COMMENT_CORRECTION_REVIEW = 1000;
const MAX_WORKLOG_CORRECTION_REVIEW = 1000;
const categories:StatusCategory[]=['backlog','todo','in_progress','review','done','cancelled'];
const fieldKinds:CustomFieldKind[]=['text','number','date','select','multi_select','checkbox','user','url'];
const hash=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const importedStatusId = (source: LegacySource, value: string) => `s_${hash(source.product, source.instanceKey, value).slice(0, 24)}`;
export const importedIssueTypeId = (source: LegacySource, value: string) => `t_${hash(source.product, source.instanceKey, value).slice(0, 24)}`;
export const importedCustomFieldId = (source: Pick<LegacySource, 'product' | 'instanceKey'>, value: string) =>
  `f_${hash(source.product, source.instanceKey, value).slice(0, 24)}`;
export const importedCustomFieldOptionId = (fieldId: string, value: string) => `o_${hash(fieldId, value).slice(0, 24)}`;
export { optionId as migrationOptionId };
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
function jiraCompletionTime(row: LegacyRecord): string {
  const value = scalar(sourceField(row, 'resolutiondate', 'resolved'));
  return string(object(value).text ?? value) || string(row.metadata.resolutiondate) || row.updatedAt || '';
}
export function recognizedJiraPriority(label: string): Issue['priority'] | null {
  if (/urgent|highest|blocker|긴급/i.test(label)) return 'urgent';
  if (/high|critical|높음/i.test(label)) return 'high';
  if (/low|minor|trivial|낮음/i.test(label)) return 'low';
  return /^(?:medium|normal|major|보통|중간)$/i.test(label.trim()) ? 'medium' : null;
}
export function jiraSourcePriorityRaw(row: LegacyRecord): unknown {
  const fields = Object.entries(fieldMap(row)).filter(([name]) => normalizedName(name) === 'priority');
  if (fields.length > 1) return fields.map(([, value]) => value);
  return scalar(fields[0]?.[1]);
}
function sourceBuiltin(row: LegacyRecord, kind: 'status' | 'issuetype') {
  const raw = scalar(sourceField(row, kind, kind === 'issuetype' ? 'type' : 'status') ?? row.metadata[kind]);
  const item = object(raw);
  return { value: string(item.id) || string(item.value) || string(item.name) || string(item.text) || string(raw) || '__unspecified__',
    label: string(item.name || item.text || item.value) };
}
export { sourceBuiltin as jiraSourceBuiltin };
function jiraOriginalStatusId(source: LegacySource, row: LegacyRecord): string | undefined {
  const raw = scalar(sourceField(row, 'status'));
  // Administrator XML puts the original status ID in Issue.status. Other
  // formats must explicitly provide an ID, since their status may be a name.
  const id = object(raw).id ?? (source.format === 'jira-backup-xml' ? raw : undefined);
  const value = typeof id === 'string' ? id : typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : '';
  return value && value !== '__unspecified__' && value.length <= 200 && value === value.trim() && value.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}
function builtin(pkg:MigrationPackage,row:LegacyRecord,kind:'status'|'issuetype',index?:Map<string,LegacyRecord>):{value:string;label:string}{
  const { value, label } = sourceBuiltin(row, kind);
  const option=index?index.get(`option:builtin:${kind}:${value}`):pkg.dataset.records.find(option=>option.kind==='option'&&option.sourceId===`builtin:${kind}:${value}`);return{value,label:label||option?.title||(value==='__unspecified__'?(kind==='status'?'상태 미지정':'유형 미지정'):value)};
}
function customField(row:LegacyRecord){return row.kind==='field'&&!row.sourceId.startsWith('builtin:')&&row.metadata.fieldType!=='csv-label-only';}
function suggestedKind(row:LegacyRecord):CustomFieldKind|'archive'{const type=string(row.metadata.fieldType||row.metadata.customfieldtypekey||row.metadata.fieldtype).toLowerCase();if(/multi.*user|cascad|group|version|project/.test(type))return'archive';if(/multi.*select|multi.*checkbox/.test(type))return'multi_select';if(/select|radio/.test(type))return'select';if(/checkbox|boolean/.test(type))return'checkbox';if(/float|number|decimal|integer/.test(type))return'number';if(/date/.test(type))return'date';if(/userpicker|user$/.test(type))return'user';if(/url/.test(type))return'url';if(/text|string/.test(type))return'text';return'archive';}
function suggestCategory(label:string):StatusCategory{if(/cancel|취소|폐기/i.test(label))return'cancelled';if(/done|closed|resolved|완료|종료|해결/i.test(label))return'done';if(/review|검토|검수|승인/i.test(label))return'review';if(/progress|진행|작업 중/i.test(label))return'in_progress';if(/backlog|대기열/i.test(label))return'backlog';return'todo';}

const statusFamily: Record<StatusCategory, JiraStatusCategory> = {
  backlog: 'new', todo: 'new', in_progress: 'indeterminate', review: 'indeterminate', done: 'done', cancelled: 'done',
};
const categoryDefaults: Record<JiraStatusCategory, StatusCategory> = { new: 'todo', indeterminate: 'in_progress', done: 'done' };
type JiraStatusGroup = { category?: JiraStatusCategory | null; nameSuggestions: Set<StatusCategory> };

function nativeJiraCategory(source: LegacySource, row: LegacyRecord, statusId: string, index: Map<string, LegacyRecord>) {
  if (source.format === 'jira-json' && row.metadata.dialect === 'rest-json') {
    const status = object(fieldMap(row).status);
    if (string(status.id) !== statusId) return;
    const category = object(status.statusCategory);
    return readJiraStatusCategory(category.key, category.id);
  }
  if (source.format === 'jira-search-xml') {
    const evidence = object(row.metadata.jiraStatusCategory);
    if (evidence.statusId === statusId) return evidence.category === null ? null : readJiraStatusCategory(evidence.category, undefined);
  }
  if (source.format === 'jira-backup-xml') {
    const option = index.get(`option:builtin:status:${statusId}`);
    const category = option?.metadata.jiraStatusCategory;
    return category === null ? null : readJiraStatusCategory(category, undefined);
  }
}

function packageIndex(pkg:MigrationPackage){return new Map(pkg.dataset.records.map(row=>[row.id,row]));}
function containerFor(pkg:MigrationPackage,row:LegacyRecord,index=packageIndex(pkg)):string{
  const pending=[row],seen=new Set<string>();for(let cursor=0;cursor<pending.length;cursor++){const current=pending[cursor];if(seen.has(current.id))continue;seen.add(current.id);if(current.kind==='project')return current.sourceId;const declared=current.references.find(ref=>ref.kind==='project');if(declared)return declared.sourceId;if(current.containerId&&index.get(`project:${current.containerId}`))return current.containerId;for(const ref of current.references)if(['container-content','current-version','original-version','body-owner','attachedTo','commentOn','historyOf','worklogOf'].includes(ref.relation)){const owner=index.get(`${ref.kind}:${ref.sourceId}`);if(owner)pending.push(owner);}if(current.kind==='issue'||current.kind==='page')return current.containerId||'__unassigned__';}return'__unassigned__';
}
function proposedKey(value:string,id:string):string{const key=value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);return/^[A-Z][A-Z0-9]{1,11}$/.test(key)?key:`MIG${hash(id).slice(0,6).toUpperCase()}`;}

type HistoricalJiraStatus = { id: string; label: string; category?: JiraStatusCategory; catalog: Map<string, JiraStatusCategory | undefined> };
type HistoricalJiraTransition = { ownerKey: string; historyKey: string; group: string; containerId: string; from: HistoricalJiraStatus; to: HistoricalJiraStatus };
type HistoricalJiraWorkflow = { statuses: Map<string, MigrationJiraWorkflowStatus>; transitions: Map<string, Pick<MigrationJiraObservedTransition, 'from' | 'to'>[]> };

function historicalJiraTransitions(packages: MigrationPackage[]): HistoricalJiraTransition[] {
  if (!packages.some(pkg => pkg.dataset.source.format === 'jira-backup-xml')) return [];
  const scope = (source: LegacySource, id: string) => JSON.stringify([source.instanceKey, id]);
  const catalogs = new Map<string, HistoricalJiraStatus | null>();
  const owners = new Map<string, { key: string; containerId: string; verified: boolean } | null>();
  for (const pkg of packages) {
    if (pkg.dataset.source.product !== 'jira') continue;
    const { source, records } = pkg.dataset;
    const native = source.format === 'jira-backup-xml';
    const projects = new Set(records.filter(row => row.kind === 'project' && row.metadata.jiraComponentProjectAmbiguous !== true).map(row => row.sourceId));
    for (const row of records) {
      if (row.kind === 'issue' && row.metadata.syntheticId !== true && isJiraHierarchyIssueId(row.sourceId)) {
        const key = scope(source, row.sourceId), project = row.containerId ?? '';
        const references = row.references.filter(ref => ref.kind === 'project');
        const verified = native && isJiraHierarchyIssueId(project) && projects.has(project) &&
          row.metadata.jiraComponentProjectAmbiguous !== true && !isRestrictedJiraHistoryOwner(row) &&
          references.length === 1 && references[0].relation === 'project' && references[0].sourceId === project;
        owners.set(key, owners.has(key) ? null : { key: qualified(pkg.summary.id, row), containerId: optionId(pkg.summary.id, 'container', project), verified });
      }
      const prefix = 'builtin:status:';
      if (!native || row.kind !== 'option' || row.containerId !== 'builtin:status' || !row.sourceId.startsWith(prefix)) continue;
      const id = row.sourceId.slice(prefix.length);
      if (!isJiraHierarchyIssueId(id)) continue;
      const key = scope(source, id), previous = catalogs.get(key);
      const { jiraWorkflowStatusLabel, jiraStatusCategory } = row.metadata;
      if (jiraWorkflowStatusLabel === undefined) continue;
      const label = jiraWorkflowStatusLabel;
      const category = readJiraStatusCategory(jiraStatusCategory, undefined);
      if (previous === null || jiraStatusCategory === null || row.metadata.id !== id || typeof label !== 'string' ||
          !label.length || label.length > 40 || label === id || label !== label.trim() || !label.isWellFormed() || /\p{Cc}/u.test(label) ||
          previous && (previous.label !== label || previous.category && category && previous.category !== category)) {
        catalogs.set(key, null);
        continue;
      }
      const status: HistoricalJiraStatus = previous ?? { id: importedStatusId(source, id), label, catalog: new Map() };
      status.category ??= category ?? undefined;
      status.catalog.set(qualified(pkg.summary.id, row), category ?? undefined);
      catalogs.set(key, status);
    }
  }
  if (!catalogs.size) return [];

  const observations: HistoricalJiraTransition[] = [];
  const groups = new Map<string, string | null>();
  for (const pkg of packages) {
    const { source, records } = pkg.dataset;
    if (source.format !== 'jira-backup-xml') continue;
    for (const row of records) {
      if (row.kind !== 'history' || !isJiraHierarchyIssueId(row.sourceId) || row.metadata.syntheticId === true) continue;
      const aliases = jiraStatusHistoryOwnerAliases(row);
      const positions = row.metadata.jiraWorkflowStatusChangePositions;
      const exactPositions = new Set(Array.isArray(positions) ? positions : []);
      const changes = jiraStatusTransitions(row).filter(change => exactPositions.has(change.position));
      const group = scope(source, row.sourceId);
      const signature = JSON.stringify([aliases, changes.map(change => [change.from.id, change.to.id])]);
      const prior = groups.get(group);
      groups.set(group, prior === undefined || prior === signature ? signature : null);
      if (aliases?.length !== 1 || !isJiraHierarchyIssueId(aliases[0])) continue;
      const owner = owners.get(scope(source, aliases[0]));
      if (!owner?.verified) continue;
      const historyKey = qualified(pkg.summary.id, row);
      for (const change of changes) {
        const from = change.from.id && catalogs.get(scope(source, change.from.id));
        const to = change.to.id && catalogs.get(scope(source, change.to.id));
        if (!from || !to || from.id === to.id) continue;
        observations.push({ ownerKey: owner.key, historyKey, group, containerId: owner.containerId, from, to });
      }
    }
  }
  return observations.filter(({ group }) => groups.get(group) !== null);
}

function migrationOptionDetails(packages: MigrationPackage[]) {
  const containers:MigrationOptions['containers']=[],identities:MigrationOptions['identities']=[],statuses:MigrationValueOption[]=[],issueTypes:MigrationValueOption[]=[],fields:MigrationOptions['fields']=[];
  const jiraWorkflowStates = new Map<string, { label: string; containerIds: Set<string> }>();
  // The imported status identity is shared across selections in one source instance.
  const jiraStatusGroups = new Map<string, JiraStatusGroup>();
  const jiraStatusOptions = new Map<string, string>();
  const unidentifiedOptions = new Set<string>();
  for(const pkg of packages){const index=packageIndex(pkg),containerRows=new Map<string,{issueCount:number;documentCount:number}>(),identityIds=new Set<string>(),statusValues=new Map<string,string>(),typeValues=new Map<string,string>();
    const projectedSources = new Map<string, JiraScheduleEndpoint>();
    if (pkg.dataset.source.product === 'jira') for (const row of pkg.dataset.records) {
      for (const field of jiraScheduleEndpoints) {
        const id = object(row.metadata.jiraProjectedDateSources)[field];
        if (typeof id === 'string') projectedSources.set(id, field);
      }
    }
    for(const row of pkg.dataset.records){if(row.kind==='project')containerRows.set(row.sourceId,{issueCount:0,documentCount:0});if(row.kind==='identity')identityIds.add(row.sourceId);if(row.authorId)identityIds.add(row.authorId);for(const ref of row.references)if(ref.kind==='identity')identityIds.add(ref.sourceId);}
    for (const row of pkg.dataset.records) {
      if (row.kind === 'issue' || row.kind === 'page') {
        const id = containerFor(pkg, row, index);
        const count = containerRows.get(id) ?? { issueCount: 0, documentCount: 0 };
        if (row.kind === 'issue') {
          count.issueCount++;
          const state = builtin(pkg, row, 'status', index), type = builtin(pkg, row, 'issuetype', index);
          statusValues.set(state.value, state.label);
          typeValues.set(type.value, type.label);
          if (pkg.dataset.source.product === 'jira') {
            const statusId = importedStatusId(pkg.dataset.source, state.value);
            const option = optionId(pkg.summary.id, 'status', state.value);
            const originalStatusId = jiraOriginalStatusId(pkg.dataset.source, row);
            if (originalStatusId === state.value && isJiraHierarchyIssueId(originalStatusId)) {
              const group: JiraStatusGroup = jiraStatusGroups.get(statusId) ?? { nameSuggestions: new Set() };
              const category = nativeJiraCategory(pkg.dataset.source, row, originalStatusId, index);
              if (category !== undefined) group.category = group.category === undefined || group.category === category ? category : null;
              group.nameSuggestions.add(suggestCategory(state.label));
              jiraStatusGroups.set(statusId, group);
              jiraStatusOptions.set(option, statusId);
            } else unidentifiedOptions.add(option);
            let workflowState = jiraWorkflowStates.get(statusId);
            if (!workflowState) {
              workflowState = { label: state.label, containerIds: new Set() };
              jiraWorkflowStates.set(statusId, workflowState);
            }
            workflowState.containerIds.add(optionId(pkg.summary.id, 'container', id));
          }
        } else {
          count.documentCount++;
        }
        containerRows.set(id, count);
      }
      if (customField(row) && !(pkg.dataset.source.product === 'jira' && row.metadata.jiraEpicLinkField === true)) {
        const projectedDate = projectedSources.get(row.sourceId);
        const jiraComponents = pkg.dataset.source.product === 'jira' && row.sourceId === JIRA_COMPONENTS_FIELD_ID;
        const jiraAdminLabels = pkg.dataset.source.format === 'jira-backup-xml' && row.metadata.jiraAdminLabelField === true;
        fields.push({ id: optionId(pkg.summary.id,'field',row.sourceId), packageId:pkg.summary.id,
          sourceValue:row.sourceId, label:row.title||row.sourceId, suggestedKind: projectedDate ? 'archive' : jiraAdminLabels ? 'multi_select' : suggestedKind(row),
          ...(projectedDate ? { projectedDate } : {}), ...(jiraComponents || jiraAdminLabels ? { requiredKind: 'multi_select' } : {}) });
      }
    }
    for(const[sourceProjectId,count]of containerRows){const row=index.get(`project:${sourceProjectId}`),name=row?.title||(sourceProjectId==='__unassigned__'?'원본 프로젝트 미지정':sourceProjectId);containers.push({id:optionId(pkg.summary.id,'container',sourceProjectId),packageId:pkg.summary.id,sourceProjectId,name,proposedKey:proposedKey(string(row?.metadata.key||row?.metadata.pkey||row?.metadata.spaceKey)||sourceProjectId,pkg.summary.id+sourceProjectId),...count});}
    const isJira = pkg.dataset.source.product === 'jira';
    const confluenceEmailEvidence = isJira ? undefined : confluenceIdentityEmailEvidence(index);
    for (const id of identityIds) {
      const row = index.get(`identity:${id}`);
      const emailEvidence = isJira ? jiraIdentityEmailEvidence(row) : confluenceEmailEvidence?.get(id);
      const accountKind = row?.metadata.migrationAccountKind;
      const accountKey = row?.metadata.migrationAccountKey;
      const verifiedKind = isJira && (accountKind === 'jira-account-id' || accountKind === 'jira-user-key') ||
        !isJira && accountKind === 'confluence-user-key';
      identities.push({ id: optionId(pkg.summary.id, 'identity', id), packageId: pkg.summary.id, sourceValue: id,
        label: row?.title || id, email: string(row?.metadata.emailAddress || row?.metadata.email) || null,
        ...(emailEvidence !== undefined ? { emailEvidence } : {}),
        ...(verifiedKind && accountKey === id ? { accountEvidence: { kind: accountKind, key: id } } : {}),
      });
    }
    for(const[value,label]of statusValues)statuses.push({id:optionId(pkg.summary.id,'status',value),packageId:pkg.summary.id,sourceValue:value,label});for(const[value,label]of typeValues)issueTypes.push({id:optionId(pkg.summary.id,'issuetype',value),packageId:pkg.summary.id,sourceValue:value,label});
  }
  const defaultStatuses: MigrationConfiguration['statuses'] = {};
  const nativeCategories = new Map<string, JiraStatusCategory | null>();
  for (const state of statuses) {
    const group = jiraStatusGroups.get(jiraStatusOptions.get(state.id) ?? '');
    if (!group || group.category === undefined) {
      defaultStatuses[state.id] = suggestCategory(state.label);
      continue;
    }
    const { category, nameSuggestions } = group;
    if (category === null || unidentifiedOptions.has(state.id)) {
      nativeCategories.set(state.id, null);
      continue;
    }
    nativeCategories.set(state.id, category);
    const [suggestion] = nameSuggestions;
    defaultStatuses[state.id] = nameSuggestions.size === 1 && statusFamily[suggestion] === category ? suggestion : categoryDefaults[category];
  }
  const defaultConfiguration:MigrationConfiguration={packageIds:packages.map(pkg=>pkg.summary.id),projects:containers.map(container=>({containerId:container.id,key:container.proposedKey,name:container.name})),users:Object.fromEntries(identities.map(identity=>[identity.id,null])),statuses:defaultStatuses,issueTypes:Object.fromEntries(issueTypes.map(type=>[type.id,null])),fields:Object.fromEntries(fields.map(field=>[field.id,field.suggestedKind])),sourceBaseUrls:Object.fromEntries(packages.map(pkg=>[pkg.summary.id,null])),timezone:'UTC',datePolicy:'block',excludedRecords:[]};
  const historicalTransitions = historicalJiraTransitions(packages);
  for (const { containerId, from, to } of historicalTransitions) for (const { id, label } of [from, to]) {
    const state = jiraWorkflowStates.get(id) ?? { label, containerIds: new Set<string>() };
    state.containerIds.add(containerId);
    jiraWorkflowStates.set(id, state);
  }
  const jiraWorkflowStatuses = [...jiraWorkflowStates].map(([id, { label, containerIds }]) => ({ id, label, containerIds: [...containerIds] }));
  const options: MigrationOptions = { packages: packages.map(pkg=>structuredClone(pkg.summary)), containers, identities, statuses, issueTypes, fields,
    defaultConfiguration, ...(jiraWorkflowStatuses.length ? { jiraWorkflowStatuses } : {}) };
  return { options, nativeCategories, historicalTransitions };
}

export function buildMigrationOptions(packages: MigrationPackage[]): MigrationOptions {
  return migrationOptionDetails(packages).options;
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

function laterConfluenceHierarchy(next: LegacyRecord, previous: LegacyRecord, timezone: string, previousTimezone: string): boolean {
  const version = confluenceSourceVersion(next);
  if (version === null || version !== confluenceSourceVersion(previous) || next.title.trim() !== previous.title.trim() ||
      hasConfluenceBody(next) && hasConfluenceBody(previous) && next.text !== previous.text) return false;
  const nextTime = sourceTimestamp(next.updatedAt, timezone), previousTime = sourceTimestamp(previous.updatedAt, previousTimezone);
  return nextTime !== null && previousTime !== null && nextTime > previousTime;
}

function sameConfluencePageRevision(next: LegacyRecord, previous: LegacyRecord, timezone: string, previousTimezone: string): boolean {
  const version = confluenceSourceVersion(next);
  if (version === null || version !== confluenceSourceVersion(previous)) return false;
  // A same-version checkpoint becomes the latest raw page for the next refresh.
  if (next.title.trim() !== previous.title.trim() || hasConfluenceBody(next) !== hasConfluenceBody(previous) || next.text !== previous.text) return false;
  if (next.updatedAt === null && previous.updatedAt === null) return true;
  const nextTime = sourceTimestamp(next.updatedAt, timezone), previousTime = sourceTimestamp(previous.updatedAt, previousTimezone);
  return nextTime !== null && previousTime !== null && nextTime >= previousTime;
}

export function confluencePageFieldDigest(field: ConfluenceMigrationDocumentField, value: DocPage[ConfluenceMigrationDocumentField]): string {
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
const lossyConfluencePropertyConversions = new Set([
  'DOCUMENT_PROPERTIES_PARAMETERS_UNSUPPORTED', 'DOCUMENT_PROPERTIES_TABLE_UNSUPPORTED', 'DOCUMENT_PROPERTIES_VALUES_UNSUPPORTED',
  'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED', 'DOCUMENT_PROPERTY_REPORT_SCOPE_UNRESOLVED', 'DOCUMENT_PROPERTY_BLOCK_LIMIT',
]);
const lossyConfluenceConversions = new Set([
  'RAW_CONTENT_FALLBACK', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_MACRO', 'REMOTE_IMAGE_NOT_EMBEDDED', 'UNSAFE_URL',
  'LINK_TARGET_SHOWN_AS_TEXT', 'ANCHOR_FLATTENED', 'SECTION_LINK_UNRESOLVED', 'TOC_PARAMETERS_UNSUPPORTED',
  'LABEL_LIST_PARAMETERS_UNSUPPORTED', 'LABEL_LIST_SCOPE_UNRESOLVED', 'LEGACY_TOC_REPRESENTATION',
  'LEGACY_LABEL_LIST_REPRESENTATION', 'CHILD_LIST_PARAMETERS_UNSUPPORTED', 'CHILD_LIST_SCOPE_UNRESOLVED',
  'CHILD_LIST_EXCERPT_UNSUPPORTED', 'LEGACY_CHILD_LIST_REPRESENTATION', 'LEGACY_EXCERPT_REPRESENTATION',
  'LAYOUT_STRUCTURE_UNSUPPORTED', 'LEGACY_LAYOUT_REPRESENTATION', 'LEGACY_DOCUMENT_PROPERTIES_REPRESENTATION',
  'CONFLUENCE_FILE_PREVIEW_UNSUPPORTED',
  ...lossyConfluenceCalloutConversions, ...lossyConfluenceExcerptConversions, ...lossyConfluencePropertyConversions,
]);

function usableConfluenceBody(converted: ReturnType<typeof convertLegacyContent>): boolean {
  return !converted.diagnostics.some(item => item.severity === 'error' || item.code.startsWith('UNRESOLVED_') ||
    lossyConfluenceConversions.has(item.code));
}

function formerConfluenceChildListOrderDigest(record: LegacyRecord, context: MigrationContentContext): string | undefined {
  const legacy = convertLegacyContent(record, { ...context, legacyChildListDefaultOrder: true });
  if (usableConfluenceBody(legacy) && legacy.diagnostics.some(item => item.code === 'CHILD_LIST_DEFAULT_ORDER_CONVERTED')) {
    return confluencePageFieldDigest('content', legacy.content);
  }
}

function formerConfluenceHeadingDepthDigest(record: LegacyRecord, context: MigrationContentContext): string | undefined {
  if (!hasConfluenceHeadingDepth(record)) return;
  const legacy = convertLegacyContent(record, { ...context, legacyDocumentHeadingLevels: true });
  if (usableConfluenceBody(legacy) && legacy.diagnostics.some(item =>
    item.code === 'HEADING_LEVEL_NORMALIZED' || item.code === 'LEGACY_TOC_DEPTH_REPRESENTATION')) {
    return confluencePageFieldDigest('content', legacy.content);
  }
}

function hasConfluenceBody(record: LegacyRecord): boolean {
  return record.textFormat === 'confluence-storage' && (record.metadata.bodyPresent === true || record.text.length > 0);
}

export function confluenceInlineCommentPageId(record: LegacyRecord): string | undefined {
  const { metadata, references } = record;
  if (record.kind !== 'comment' || metadata.sourceClass !== 'Comment' || typeof metadata.confluenceInlineMarkerRef !== 'string' ||
      !metadata.confluenceInlineMarkerRef || record.parentId || metadata.confluenceParentCommentSourceId || metadata.confluenceCommentParentUnresolved === true ||
      metadata.currentVersionId || metadata.orphan === true || metadata.bodyVariant === true ||
      (metadata.originalVersionId && metadata.originalVersionId !== record.sourceId) ||
      !['', 'current'].includes(string(metadata.contentStatus).trim().toLowerCase()) ||
      references.some(ref => ref.kind === 'comment' && (ref.relation === 'parent' ||
        ref.sourceId !== record.sourceId && ['current-version', 'original-version'].includes(ref.relation)))) return;
  const owners = references.filter(ref => ref.relation === 'container-content');
  if (owners.length === 1 && owners[0].kind === 'page' && owners[0].sourceId === record.containerId) return owners[0].sourceId;
}

function hasConfluenceHeadingDepth(record: LegacyRecord): boolean {
  return hasConfluenceBody(record) && /<h[4-6](?=[\s/>])|<ac:(?:structured-macro|macro)\s[^<>]*\bac:name\s*=\s*(?:"toc"|'toc')/u.test(record.text);
}

function hasOriginalConfluenceRawFallback(record: LegacyRecord, current: DocPage['content']): boolean {
  if (!hasConfluenceBody(record) || current.content?.length !== 1) return false;
  const [block] = current.content;
  const [value] = block.content ?? [];
  return block.type === 'codeBlock' && block.attrs?.language == null && block.content?.length === 1 &&
    value.type === 'text' && value.text === record.text;
}

function hasConfluenceExcerptMacro(record: LegacyRecord): boolean {
  const macros = record.metadata.macros;
  return Array.isArray(macros) && macros.some(macro => {
    const { name } = object(macro);
    return name === 'excerpt' || name === 'excerpt-include';
  });
}

function hasConfluenceColumnLayout(record: LegacyRecord): boolean {
  return /<ac:layout(?=[\s/>])|<ac:(?:structured-macro|macro)\s[^<>]*\bac:name\s*=\s*(?:"section"|'section')/u.test(record.text);
}

function hasConfluenceTableColumns(record: LegacyRecord): boolean {
  return /<colgroup(?=[\s/>])/u.test(record.text);
}

function confluencePageBodySourceHash(record: LegacyRecord): string | undefined {
  return hasConfluenceBody(record) ? hash('confluence-source-body', record.text) : undefined;
}

function reviewNewerConfluenceBody(record: LegacyRecord, previous: SourceRecordArchive, documentId: string): {
  review: boolean; acceptedSourceHash?: string;
} {
  const incoming = confluencePageBodySourceHash(record);
  const accepted = previous.confluencePageBodySourceHash;
  if (!incoming) return { review: false, acceptedSourceHash: accepted };
  if (accepted) return { review: incoming !== accepted, acceptedSourceHash: accepted };
  if (!hasConfluenceBody(previous.record) || record.text !== previous.record.text) return { review: true };

  // Older receipts lack accepted raw bytes. Prove an identical body against its field hash
  // using only the storage text and its local sections, without remapping workspace references.
  const previousContentHash = previous.confluencePageFieldHashes?.content;
  if (previousContentHash) {
    const context = { resolveReference: () => null, sectionLinks: { documentId } };
    const standalone = convertLegacyContent(record, context);
    if (usableConfluenceBody(standalone)) {
      const unchanged = confluencePageFieldDigest('content', standalone.content) === previousContentHash ||
        formerConfluenceHeadingDepthDigest(record, context) === previousContentHash ||
        documentChildLists(standalone.content).some(options => options.sort === 'manual') &&
        formerConfluenceChildListOrderDigest(record, context) === previousContentHash;
      return unchanged ? { review: false, acceptedSourceHash: incoming } : { review: true };
    }
  }
  return { review: hasConfluenceExcerptMacro(record) || hasConfluenceColumnLayout(record) || hasConfluenceHeadingDepth(record) };
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
    if (formerConfluenceHeadingDepthDigest(record, { resolveReference }) === currentHash ||
        documentChildLists(currentContent).some(options => options.sort === 'title') &&
        formerConfluenceChildListOrderDigest(record, { resolveReference }) === currentHash) {
      values.content = currentContent;
    }
    if (!values.content || confluencePageFieldDigest('content', values.content) !== currentHash) {
      // An older document can still exactly match a former renderer's conversion.
      const earlierContent = { legacyDocumentChildList: true, legacySectionBaseline: true, legacyDocumentToc: true,
        legacyDocumentLabelList: true, legacyDocumentHeadingLevels: true };
      const legacyLayout = hasConfluenceColumnLayout(record) ? { legacyDocumentLayout: true } : {};
      const legacyProperties = hasConfluencePropertyMacro(record.text) ? { legacyDocumentProperties: true } : {};
      const legacyOptions = [
        ...(legacyProperties.legacyDocumentProperties ? [legacyProperties] : []),
        ...(legacyLayout.legacyDocumentLayout ? [legacyLayout] : []),
        ...(hasConfluenceTableColumns(record) ? [{ legacyConfluenceTableColumns: true }] : []),
        ...(hasConfluenceExcerptMacro(record) ? [{ ...legacyLayout, legacyDocumentExcerpt: true }] : []),
        ...[{ legacyDocumentChildList: true }, earlierContent, { ...earlierContent, legacyAnnotations: true }]
          .map(options => ({ ...options, ...legacyLayout, legacyDocumentExcerpt: true })),
      ];
      for (const options of legacyOptions) {
        const legacy = convertLegacyContent(record, { resolveReference, ...options, ...legacyProperties });
        const exactOldContent = confluencePageFieldDigest('content', legacy.content) === currentHash;
        const safeOldContent = usableConfluenceBody({ ...legacy, diagnostics: legacy.diagnostics.filter(item =>
          !['ANCHOR_FLATTENED', 'ANCHOR_DECLARATION_FLATTENED', 'LEGACY_TOC_REPRESENTATION',
            'LEGACY_LABEL_LIST_REPRESENTATION', 'LEGACY_CHILD_LIST_REPRESENTATION', 'LEGACY_EXCERPT_REPRESENTATION',
            'LEGACY_LAYOUT_REPRESENTATION', 'LEGACY_DOCUMENT_PROPERTIES_REPRESENTATION'].includes(item.code) &&
          // The old transformer rendered default table column declarations as inert XML inside the disclosure.
          !(legacyProperties.legacyDocumentProperties && item.code === 'UNSUPPORTED_CONTENT')) });
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

export function jiraFieldDigest(field: JiraMigrationIssueField, value: Issue[JiraMigrationIssueField], format?: JiraMigrationIssueValues['descriptionFormat']): string {
  // Text-only descriptions keep the same digest as checkpoints written by older versions.
  if (field === 'description' && format === 'markdown') return hash(field, JSON.stringify(['markdown', value]));
  if (value === undefined) return hash(field, 'undefined');
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

export function jiraAssignee(row: LegacyRecord): string {
  return row.references.find(reference => reference.kind === 'identity' && reference.relation === 'assignee')?.sourceId ||
    string(scalar(sourceField(row, 'assignee')));
}

export function jiraReporter(row: LegacyRecord): string | null | undefined {
  // Older CSV and REST analysis could store a creator as the issue's author. The explicit marker distinguishes the source field.
  const observed = row.metadata.jiraReporter;
  if (observed !== null && typeof observed !== 'string') return undefined;
  const identities = new Set(row.references.filter(reference => reference.kind === 'identity' && reference.relation === 'reporter')
    .map(reference => reference.sourceId));
  if (observed === null) return identities.size === 0 ? null : undefined;
  return identities.size === 1 && identities.has(observed) ? observed : undefined;
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

const jiraEpicParentHash = hash('jira-source:parentId', 'epic-link-source');

export function jiraSourceFieldHashes(field: JiraMigrationIssueField, row: LegacyRecord): [string] | [string, string] {
  // Epic membership has a separate source from the standard parent. Its applied value is tracked by the canonical field digest.
  if (field === 'parentId' && row.metadata.jiraEpicParentObserved === true) return [jiraEpicParentHash];
  const digest = (value: unknown) => hash(`jira-source:${field}`, JSON.stringify(value) ?? 'undefined');
  if (field === 'status' || field === 'type') {
    const { value, label } = sourceBuiltin(row, field === 'status' ? 'status' : 'issuetype');
    return label ? [digest(value), digest(label)] : [digest(value)];
  }
  const identity = (): unknown => {
    switch (field) {
      case 'title': return row.title.trim();
      case 'description': return [row.textFormat, jiraRenderedHtmlDescription(row), row.text];
      case 'priority': {
        const raw = scalar(sourceField(row, 'priority'));
        const item = object(raw);
        return string(item.id || item.name || item.text || raw);
      }
      case 'assigneeId': return jiraAssignee(row);
      case 'reporterId': return jiraReporter(row);
      case 'parentId': {
        const parent = jiraParentEvidence(row);
        return parent === null ? null : parent?.[0];
      }
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
      case 'plannedEffortMinutes': return row.metadata.jiraOriginalEstimateSeconds;
    }
  };
  return [digest(identity())];
}

function sameJiraSourceField(incoming: [string] | [string, string], accepted?: [string] | [string, string]): boolean {
  return !!accepted && (incoming[0] === accepted[0] || incoming.length === 1 && incoming[0] === accepted[1] ||
    accepted.length === 1 && accepted[0] === incoming[1]);
}

function matchedJiraSourceFieldHashes(row: LegacyRecord, applied: JiraMigrationIssueFieldHashes,
  projected: JiraMigrationIssueFieldHashes = applied): JiraMigrationIssueSourceFieldHashes {
  const result: JiraMigrationIssueSourceFieldHashes = {};
  if (row.metadata.jiraEpicParentObserved === true && applied.parentId !== undefined &&
      applied.parentId !== jiraFieldDigest('parentId', null) && jiraParentEvidence(row)) {
    result.parentId = [jiraEpicParentHash];
  }
  for (const field of JIRA_MIGRATION_ISSUE_FIELDS) {
    // An initial raw parent may have been outside the import, leaving a canonical root.
    if (field === 'parentId') continue;
    if (applied[field] !== undefined && applied[field] === projected[field]) result[field] = jiraSourceFieldHashes(field, row);
  }
  return result;
}

interface Entry{pkg:MigrationPackage;row:LegacyRecord;key:string;container:string}
type Binding={type:'project'|'issue'|'document'|'comment'|'revision'|'attachment';id:string;projectId:string|null};
type JiraHistoryIssue=Pick<Issue,'id'|'projectId'|'key'|'title'>;
type JiraChildScope = { durable: Map<string, string>; resolveId: (alias: string) => string | undefined; blocked: Set<string>; sourceErrors: Set<string> };
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
type ResolvedConfluencePage = { sourceId: string; entry?: Entry; reference: ResolvedReference };
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
  private readonly jiraIssuesByAddress = new Map<string, Entry[]>();
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
  private movedOutEntries = new Set<string>();
  private jiraRefreshCheckpoints = new Map<string, { issue: Issue; hashes?: JiraMigrationIssueFieldHashes;
    sourceHashes?: JiraMigrationIssueSourceFieldHashes; customHashes?: JiraMigrationCustomFieldHashes }>();
  private jiraHistoryOwners = new Map<string, JiraHistoryIssue>();
  private jiraCommentCorrections = new Map<string, { owner: JiraHistoryIssue; marker: NonNullable<SourceRecordArchive['jiraCommentCorrection']> }>();
  private jiraWorklogCorrections = new Map<string, { owner: JiraHistoryIssue; marker: NonNullable<SourceRecordArchive['jiraWorklogCorrection']> }>();
  private knownJiraHistory = new Set<string>();
  private jiraAttachmentOwners = new Map<string, AttachmentOwner>();
  private knownJiraAttachments = new Set<string>();
  private jiraRelationIds = new Map<string, string>();
  private jiraRelationProjectIds = new Set<string>();
  private confluenceRefreshCheckpoints = new Map<string, { document: DocPage; hashes: ConfluenceMigrationPageFieldHashes }>();
  private hierarchyDocuments = new Map<string, Pick<DocPage, 'id' | 'parentId' | 'title'>>();
  private confluenceBodySourceHashes = new Map<string, string>();
  private confluenceBodyReviews = new Map<string, ReturnType<typeof reviewNewerConfluenceBody>>();
  private confluenceHistoryOwners = new Map<string, AttachmentOwner>();
  private confluenceInlineClaims = new Map<string, Map<string, Entry | null>>();
  private confluenceInlineSourceErrors = new Set<string>();
  private confluenceInlineProjections = new Map<string, { bodyHash: string; anchors: ReadonlyMap<string, DocumentSourceSelection> } | null>();
  private confluenceInlineRefreshedBodyHashes = new Map<string, string>();
  private deferredPrimaryNotices: { message: string; entry?: Entry }[] = [];
  private boundIssues = new Map<string, KnownIssue>();
  private retainedIssuesByJiraKey = new Map<string, KnownIssue | null>();
  private boundPages = new Map<string, KnownPage>();
  private boundPagesByDocument = new Map<string, KnownPage>();
  private confluenceSectionProjections = new Map<Entry, ReadonlyMap<string, string>>();
  private confluenceRefreshSections = new Map<string, Entry[]>();
  private boundPageIdsByTitle = new Map<string, Set<string>>();
  private boundPageTargets = new Set<string>();
  private retainedPageOwners = new Map<string, string | null>();
  private restrictedSourcePages = new Set<string>();
  private restrictedJiraServiceDeskEntries = new Set<string>();
  private labelListProjectScopes?: Map<string, LabelListProjectScope | null>;
  private readonly nativeJiraStatusCategories: ReadonlyMap<string, JiraStatusCategory | null>;
  private readonly historicalJiraTransitions: readonly HistoricalJiraTransition[];
  constructor(readonly input:MigrationPlanningInput, private readonly confirmedConfluenceRestrictions?: ReadonlyMap<string, ReadonlySet<string>>){
    const { options, nativeCategories, historicalTransitions } = migrationOptionDetails(input.packages);
    this.options = options;
    this.nativeJiraStatusCategories = nativeCategories;
    this.historicalJiraTransitions = historicalTransitions;
    const configuration=structuredClone(input.configuration);this.result={preview:{id:input.id,version:1,actorId:input.actorId,createdAt:input.now,expiresAt:new Date(Date.parse(input.now)+30*60000).toISOString(),configuration,projects:[],counts:{},notices:this.notices,requiredAcknowledgements:[],canApply:false,samples:[]},sourceImport:{id:input.id,version:1,createdAt:input.now,actorId:input.actorId,projectIds:[],configuration,packages:input.packages.map(pkg=>({stagingId:pkg.summary.id,filename:pkg.summary.filename,sha256:pkg.summary.sha256,source:structuredClone(pkg.dataset.source)})),counts:{}},sourceRecords:[],projects:[],workflows:[],issueSchemas:[],issues:[],documents:[],comments:[],revisions:[],worklogs:[],attachments:[],attachmentVersions:[],fileCopies:[],resourceLinks:[],issueRelations:[],atlassianLinks:[]};for(const pkg of input.packages){const index=packageIndex(pkg);this.indexes.set(pkg.summary.id,index);const options=new Map<string,MigrationOptions['fields'][number]>();for(const option of this.options.fields.filter(option=>option.packageId===pkg.summary.id)){options.set(option.sourceValue,option);options.set(option.sourceValue.replace(/^csv:/,''),option);}this.fieldOptions.set(pkg.summary.id,options);const sourceOptions=new Map<string,LegacyRecord[]>();for(const row of pkg.dataset.records){const entry={pkg,row,key:qualified(pkg.summary.id,row),container:containerFor(pkg,row,index)};this.entries.push(entry);this.entryByKey.set(entry.key,entry);if(row.kind==='option'&&row.containerId){const values=sourceOptions.get(row.containerId)||[];values.push(row);sourceOptions.set(row.containerId,values);}if(['page','issue','attachment'].includes(row.kind)){for(const alias of [row.sourceId,...(row.kind==='issue'&&row.metadata.key?[string(row.metadata.key)]:[])]){const key=JSON.stringify([row.kind,'id',alias]),values=this.referenceIndex.get(key)||[];if(!values.includes(entry))values.push(entry);this.referenceIndex.set(key,values);}const key=JSON.stringify([row.kind,'title',row.title]),values=this.referenceIndex.get(key)||[];values.push(entry);this.referenceIndex.set(key,values);}}this.sourceOptions.set(pkg.summary.id,sourceOptions);}}
  notice(code:string,message:string,severity:MigrationNotice['severity']='warning',entry?:Entry,ack=false){if(this.notices.length>=9999){if(this.notices.length===9999)this.notices.push({severity:'error',code:'NOTICE_LIMIT',message:'진단이10000건 한도에 도달했습니다. 누락된 진단을 승인으로 간주하지 않으며 패키지를 나누거나 매핑·제외 조건을 먼저 수정해야 합니다.',recordId:null,requiresAcknowledgement:false});return;}const recordId=entry?.key||null,key=JSON.stringify([code,recordId,message]);if(this.noticeKeys.has(key))return;this.noticeKeys.add(key);this.notices.push({severity,code,message:message.length>2000?`${message.slice(0,1950)} [진단 일부만 표시]`:message,recordId,requiresAcknowledgement:ack});}
  get configuration(){return this.result.preview.configuration;}
  sourceEntry(entry:Entry,kind:string,id:string){return this.entryByKey.get(`${entry.pkg.summary.id}/${kind}:${id}`);}
  private skip(entry: Entry): boolean { return this.excluded.has(entry.key) || this.retainedEntries.has(entry.key); }
  private originalIssue(alias: string): Binding | undefined {
    const issue = this.boundIssues.get(alias);
    return issue && issue.projectId && issue.projectId === this.input.append?.project.id
      ? { type: 'issue', id: issue.issueId, projectId: issue.projectId } : undefined;
  }
  private jiraHierarchyIssues = new Map<string, Pick<Issue, 'id' | 'parentId' | 'key' | 'title'>>();
  private initializeAppend(): void {
    const append = this.input.append;
    const mapping = this.configuration.appendTo;
    if (!mapping && !append) return;
    if (!mapping || !append || append.project.id !== mapping.projectId) {
      this.notice('APPEND_TARGET_INVALID', '추가 이관할 기존 프로젝트를 확인해 주세요.', 'error');
      return;
    }
    this.result.append = { projectId: append.project.id, token: append.token, startIssueNumber: append.nextIssueNumber };
    for (const issue of append.hierarchyIssues ?? []) this.jiraHierarchyIssues.set(issue.id, issue);
    for (const { alias, ...issue } of append.knownIssues) this.boundIssues.set(alias, issue);
    for (const container of this.options.containers) {
      if (container.issueCount) this.projectsByContainer.set(container.id, append.project);
    }
    const retainedAliases = new Map<string, KnownIssue>();
    const movedOutAliases = new Set(append.movedOutIssueAliases);
    const newRows: Entry[] = [];
    for (const entry of this.entries) {
      if (entry.row.kind !== 'issue' || this.excluded.has(entry.key)) continue;
      const byId = this.boundIssues.get(entry.row.sourceId);
      const key = string(entry.row.metadata.key);
      const byKey = this.boundIssues.get(key);
      if (byId && byKey && byId.issueId !== byKey.issueId) {
        this.notice('SOURCE_BINDING_AMBIGUOUS', 'Jira 원본 ID와 키가 서로 다른 업무에 연결되어 있습니다.', 'error', entry);
      }
      const elsewhere = ([[entry.row.sourceId, byId], [key, byKey]] as const)
        .filter(([, issue]) => issue?.projectId && issue.projectId !== append.project.id);
      if (elsewhere.some(([alias]) => !movedOutAliases.has(alias))) {
        this.notice('SOURCE_BINDING_CONFLICT', 'Jira 원본 업무가 다른 팀 프로젝트에 연결되어 있습니다.', 'error', entry);
      } else if (elsewhere.length) {
        this.movedOutEntries.add(entry.key);
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
    for (const [alias, issue] of this.boundIssues) {
      if (!isJiraIssueKey(alias)) continue;
      const key = alias.toUpperCase();
      const previous = this.retainedIssuesByJiraKey.get(key);
      if (previous === undefined) this.retainedIssuesByJiraKey.set(key, issue);
      else if (previous?.issueId !== issue.issueId || previous.projectId !== issue.projectId) this.retainedIssuesByJiraKey.set(key, null);
    }
    const retainedIssues = this.retainedEntries.size;
    if (mapping.refreshHistory === true || mapping.refreshComments === true || mapping.refreshWorklogs === true) for (const { kind, sourceId } of append.knownHistory ?? []) {
      this.knownJiraHistory.add(JSON.stringify([kind, sourceId]));
    }
    if (mapping.refreshAttachments === true) for (const { sourceId } of append.knownAttachments ?? []) {
      this.knownJiraAttachments.add(sourceId);
    }
    for (const entry of this.entries) {
      if (entry.row.kind === 'issue' || entry.row.kind === 'relation' || this.excluded.has(entry.key)) continue;
      const owner = this.ownerEntry(entry);
      if ((mapping.refreshHistory === true || mapping.refreshComments === true && entry.row.kind === 'comment' ||
           mapping.refreshWorklogs === true && isJiraWorklog(entry.row)) &&
          entry.pkg.dataset.source.product === 'jira' && jiraHistoryKind(entry.row)) {
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
    if (this.movedOutEntries.size) this.notice('JIRA_MOVED_ISSUES_ARCHIVED',
      `다른 프로젝트로 이동한 업무의 원본 기록 ${this.movedOutEntries.size}건을 보관합니다. 이동한 업무의 필드와 댓글·작업 시간·첨부·관계는 현재 프로젝트에 유지합니다.`, 'warning', undefined, true);
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
      if (Object.hasOwn(configuration.statuses, stateOption)) values.status = importedStatusId(source, sourceState);
      if (Object.hasOwn(configuration.issueTypes, typeOption)) {
        values.type = configuration.issueTypes[typeOption] || importedIssueTypeId(source, sourceType);
      }
    }
    // Receipts without an accepted value predate administrator option lookup during creation.
    const oldPriority = scalar(sourceField(record, 'priority'));
    const oldPriorityLabel = string(object(oldPriority).name || object(oldPriority).text || oldPriority);
    values.priority = recognizedJiraPriority(oldPriorityLabel) ?? 'medium';
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
  private originalJiraSourceFieldHashes(entry: Entry, issueId: string, previous: MigrationJiraRefreshCandidate['previous'],
    applied: JiraMigrationIssueFieldHashes): JiraMigrationIssueSourceFieldHashes {
    if (previous.archive.jiraIssueSourceFieldHashes) return { ...previous.archive.jiraIssueSourceFieldHashes };
    // A legacy refresh receipt may carry earlier applied hashes alongside a newer, conflicting raw record.
    const projected = previous.configuration.appendTo?.refreshExisting && previous.archive.jiraIssueFieldHashes
      ? jiraFieldDigests(this.jiraRefreshValues(entry, issueId, previous)) : applied;
    return matchedJiraSourceFieldHashes(previous.archive.record, applied, projected);
  }
  private jiraPlannedEffort(entry: Entry, row = entry.row, warn = true): number | null | undefined {
    const seconds = row.metadata.jiraOriginalEstimateSeconds;
    if (seconds === undefined || seconds === null) return seconds;
    if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 && seconds % 60 === 0 &&
        seconds / 60 <= MAX_PLANNED_EFFORT_MINUTES) return seconds / 60;
    if (warn) {
      const maximum = MAX_PLANNED_EFFORT_MINUTES.toLocaleString('ko-KR');
      this.notice('JIRA_ORIGINAL_ESTIMATE_ARCHIVED',
        `Jira 원래 추정치는 초 단위 원본에 보관합니다. 계획 작업 시간은 0~${maximum} 사이의 정수 분으로만 이관합니다.`, 'warning', entry, true);
    }
    return undefined;
  }
  private jiraDescription(entry: Entry, issueId: string, row = entry.row) {
    return projectJiraDescription(row, {
      resolveReference: request => this.resolve(entry, request),
      resolvePageHref: href => this.jiraConfluenceHref(entry, href),
      ownsAttachment: id => {
        const attachment = this.attachmentVersionsById.get(id);
        return attachment?.resourceType === 'issue' && attachment.resourceId === issueId;
      },
    });
  }
  private jiraRefreshValues(entry: Entry, issueId: string, previous?: MigrationJiraRefreshCandidate['previous']): JiraMigrationIssueValues {
    const row = previous?.archive.record ?? entry.row;
    const stagingId = previous?.stagingId ?? entry.pkg.summary.id;
    const configuration = previous?.configuration ?? this.configuration;
    const mapping = configuration.appendTo!;
    const { schema, workflow } = this.input.append!;
    const values: JiraMigrationIssueValues = {};
    const hasSnapshotFields = Array.isArray(row.metadata.jiraSnapshotFields);
    const explicit = hasSnapshotFields ? row.metadata.jiraSnapshotFields as unknown[] : [];
    const unavailable = (field: string) => {
      if (!previous) this.notice('JIRA_REFRESH_FIELD_UNAVAILABLE',
        `원본 '${field}' 값을 확인하거나 현재 프로젝트에 매핑할 수 없어 해당 필드를 보존합니다.`, 'warning', entry);
    };
    const mappedIdentity = (id: string) => previous ? configuration.users[optionId(stagingId, 'identity', id)] ?? null : this.mappedAuthor(entry, id);
    const title = row.title.trim();
    if (title && title.length <= 300) values.title = title;
    else if (title) unavailable('제목');
    if (explicit.includes('description') || !hasSnapshotFields && (row.text || sourceField(row, 'description') !== undefined)) {
      const description = this.jiraDescription(entry, issueId, row);
      if (!description.reliable || description.description.length > 200000) unavailable('설명');
      else {
        values.description = description.description;
        values.descriptionFormat = description.descriptionFormat ?? 'plain';
        if (!previous) for (const item of description.diagnostics) this.notice(item.code, item.message, item.severity, entry, item.severity === 'warning');
      }
    }
    const state = sourceBuiltin(row, 'status').value;
    if (state !== '__unspecified__') {
      const id = mapping.statuses[optionId(stagingId, 'status', state)];
      if (id && (previous || workflow.statuses.some(status => status.id === id))) values.status = id;
      else unavailable('상태');
    }
    const type = sourceBuiltin(row, 'issuetype').value;
    if (type !== '__unspecified__') {
      const id = mapping.issueTypes[optionId(stagingId, 'issuetype', type)];
      if (id && (previous || schema.issueTypes.some(issueType => issueType.id === id && !issueType.archived))) values.type = id;
      else unavailable('업무 유형');
    }
    const priority = this.jiraPriorityValue(entry, previous);
    if (priority === null) unavailable('우선순위');
    else if (priority !== undefined) values.priority = priority;
    const sourceAssignee = jiraAssignee(row);
    if (sourceAssignee) {
      const mapped = mappedIdentity(sourceAssignee);
      if (mapped) values.assigneeId = mapped;
      else unavailable('담당자');
    } else if (explicit.includes('assigneeId')) values.assigneeId = null;
    const reporter = jiraReporter(row);
    if (reporter === null) values.reporterId = null;
    else if (reporter !== undefined) {
      const mapped = mappedIdentity(reporter);
      if (mapped) values.reporterId = mapped;
      else unavailable('요청자');
    }
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
        const date = projected && !previous ? this.parseProjectedJiraDate(entry, field, raw, 'warning') :
          sourceCalendarDate(projected ? string(raw).trim() : string(raw), configuration.timezone);
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
    const plannedEffortMinutes = this.jiraPlannedEffort(entry, row, !previous);
    if (plannedEffortMinutes !== undefined) values.plannedEffortMinutes = plannedEffortMinutes;
    return values;
  }
  private jiraReviewValue(field: JiraMigrationIssueField, value: Issue[JiraMigrationIssueField], format?: JiraMigrationIssueValues['descriptionFormat']): string {
    if (field === 'parentId' && value === null) return '최상위 업무';
    if (value === null || value === undefined || value === '' || Array.isArray(value) && value.length === 0) return '비어 있음';
    if (field === 'plannedEffortMinutes' && typeof value === 'number') return `${value.toLocaleString('ko-KR')}분`;
    const append = this.input.append!;
    let label = Array.isArray(value) ? value.join(', ') : String(value);
    if (field === 'parentId') {
      const parent = this.issueById.get(label) ?? this.jiraHierarchyIssues.get(label);
      label = parent ? `${parent.key} · ${parent.title}` : '상위 업무 확인 불가';
    }
    if (field === 'status') label = append.workflow.statuses.find(status => status.id === value)?.label ?? label;
    if (field === 'type') label = append.schema.issueTypes.find(type => type.id === value)?.name ?? label;
    if (field === 'assigneeId' || field === 'reporterId') label = this.input.users.find(user => user.id === value)?.name ?? label;
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
      const fieldId = mapping ? mapping[option.id] : importedCustomFieldId(entry.pkg.dataset.source, option.sourceValue);
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
        : importedCustomFieldId(archive.source, sourceFieldId);
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
      const projection = option.requiredKind && this.sourceEntry(entry, 'field', sourceFieldId);
      if (option.requiredKind && (field.kind !== option.requiredKind || !projection || this.skip(projection))) {
        unavailable(field.name);
        continue;
      }
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
  private jiraRefreshParent(entry: Entry, aliases: string[], known: ReadonlyMap<string, string>, sourceErrors: ReadonlySet<string>): string | undefined {
    const targets = new Set<string>();
    for (const alias of aliases) {
      const stored = known.get(alias);
      const bound = this.boundIssues.get(alias);
      if (stored) targets.add(stored);
      const matches = this.referenceIndex.get(JSON.stringify(['issue', 'id', alias])) ?? [];
      for (const match of matches) {
        if (match.pkg.dataset.source.product !== 'jira' || match.pkg.dataset.source.instanceKey !== entry.pkg.dataset.source.instanceKey ||
            match.container !== entry.container || this.excluded.has(match.key) || this.restricted(match) || sourceErrors.has(match.key)) return;
        const binding = this.bindings.get(match.key);
        if (binding?.type === 'issue' && binding.projectId === this.input.append?.project.id) targets.add(binding.id);
      }
      if (bound && bound.issueId !== stored && bound.projectId === this.input.append?.project.id) {
        // A retained row may supply the ID of an issue previously imported using only its key.
        const alternate = matches.some(match => [match.row.sourceId, string(match.row.metadata.key)].some(value => known.get(value) === bound.issueId));
        if (!alternate) return;
        targets.add(bound.issueId);
      } else if (bound && bound.issueId !== stored) return;
    }
    if (targets.size === 1) return [...targets][0];
  }
  private jiraHierarchySourceErrors(): Set<string> {
    return new Set(this.input.packages.flatMap(pkg => pkg.dataset.diagnostics
      .filter(item => item.recordId && item.severity === 'error').map(item => `${pkg.summary.id}/${item.recordId}`)));
  }
  private createJiraRefreshes(): void {
    const mapping = this.configuration.appendTo;
    if ((!mapping?.refreshExisting && !mapping?.refreshCustomFields) || !this.input.append) return;
    const append = this.input.append;
    const definitions = new Map(append.schema.fields.map(field => [field.id, field]));
    const candidates = new Map(append.refreshIssues?.map(candidate => [candidate.issue.id, candidate]));
    const hierarchyAliases = new Map(append.hierarchyIssueAliases?.map(({ alias, issueId }) => [alias, issueId]));
    const sourceErrors = this.jiraHierarchySourceErrors();
    const sourceFieldWarnings = new Map<string, Pick<MigrationNotice, 'code' | 'message'>[]>();
    for (const pkg of this.input.packages) for (const diagnostic of pkg.dataset.diagnostics) {
      if (diagnostic.recordId && diagnostic.severity === 'warning' &&
          (diagnostic.code === 'JIRA_PROJECTED_DATE_VALUE_AMBIGUOUS' || diagnostic.code === 'JIRA_ORIGINAL_ESTIMATE_UNRESOLVED')) {
        const key = `${pkg.summary.id}/${diagnostic.recordId}`;
        const warnings = sourceFieldWarnings.get(key) ?? [];
        warnings.push({ code: diagnostic.code, message: diagnostic.message });
        sourceFieldWarnings.set(key, warnings);
      }
    }
    const review: JiraMigrationIssueReview[] = [];
    const updates: NonNullable<PreparedMigration['issueUpdates']> = [];
    const seen = new Set<string>();
    let updatedFields = 0, conflictingFields = 0, updatedCustomFields = 0, conflictingCustomFields = 0, skippedIssueUpdates = 0;
    for (const entry of this.entries) {
      if (entry.row.kind !== 'issue' || !this.retainedEntries.has(entry.key)) continue;
      if (this.movedOutEntries.has(entry.key)) { skippedIssueUpdates++; continue; }
      const sourceKey = string(entry.row.metadata.key) || entry.row.sourceId;
      const binding = this.originalIssue(entry.row.sourceId) ?? this.originalIssue(sourceKey);
      const candidate = binding && candidates.get(binding.id);
      if (!candidate || sourceErrors.has(entry.key) || this.restricted(entry)) {
        skippedIssueUpdates++;
        this.notice('JIRA_REFRESH_ISSUE_UNAVAILABLE', '현재 업무 연결이나 접근 범위 또는 원본 자료를 확인할 수 없어 변경분은 적용하지 않습니다.', 'warning', entry);
        continue;
      }
      const { issue, previous, previousCustom, initialParentId } = candidate;
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
      if (reviewStandard) for (const { code, message } of sourceFieldWarnings.get(entry.key) ?? []) {
        this.notice(`SOURCE_${code}`, message, 'warning', entry, true);
      }
      if ([reviewStandard ? previous.archive.record.updatedAt : null, reviewCustom ? customBaseline.archive.record.updatedAt : null,
        entry.row.updatedAt].some(value => value && jiraEnglishDate(value)?.century)) {
        this.notice('DATE_TWO_DIGIT_CENTURY','Jira 두 자리 연도를2000~2099년으로 해석했습니다. 세기 가정을 확인해야 하며 원본 날짜 문자열은 그대로 보관합니다.','warning',entry,true);
      }
      const values = reviewStandard ? this.jiraRefreshValues(entry, issue.id) : {};
      const hashes = reviewStandard ? { ...this.originalJiraIssueDigests(previous) } : {};
      const sourceHashes = reviewStandard ? this.originalJiraSourceFieldHashes(entry, issue.id, previous, hashes) : {};
      if (reviewStandard) {
        if (entry.row.metadata.jiraEpicParentUnresolved === true) {
          this.notice('JIRA_REFRESH_EPIC_PARENT_UNRESOLVED', '새 원본의 에픽 연결을 확인할 수 없어 해당 연결은 원본에 보관합니다.', 'warning', entry, true);
        }
        const evidence = jiraParentEvidence(entry.row);
        const epic = entry.row.metadata.jiraEpicParentObserved === true;
        const previousEpic = sourceHashes.parentId?.[0] === jiraEpicParentHash;
        // A blank value can clear only the hierarchy last applied from that source.
        if (evidence === null && (epic === previousEpic || entry.row.metadata.jiraDirectParentClearObserved === true)) values.parentId = null;
        else if (evidence) {
          const parent = this.jiraRefreshParent(entry, evidence, hierarchyAliases, sourceErrors);
          if (parent) values.parentId = parent;
          else this.notice('JIRA_REFRESH_PARENT_UNAVAILABLE', `원본 상위 업무 ${evidence.join(' / ')}의 같은 프로젝트 내 연결을 확인할 수 없어 현재 상위 업무를 보존합니다.`, 'warning', entry, true);
        }
        if (hashes.parentId === undefined && initialParentId !== undefined) hashes.parentId = jiraFieldDigest('parentId', initialParentId);
      }
      const accepted: JiraMigrationIssueValues = {};
      const fields: JiraMigrationIssueReview['fields'] = [];
      let canCheckpoint = false;
      for (const field of JIRA_MIGRATION_ISSUE_FIELDS) {
        const next = values[field];
        if (next === undefined) continue;
        const current = issue[field];
        const plannedEffortWithoutBaseline = field === 'plannedEffortMinutes' && hashes.plannedEffortMinutes === undefined;
        if (plannedEffortWithoutBaseline && current === undefined && next === null) continue;
        const incomingHash = jiraFieldDigest(field, next, values.descriptionFormat);
        const currentHash = jiraFieldDigest(field, current, issue.descriptionFormat);
        const incomingSourceHashes = jiraSourceFieldHashes(field, entry.row);
        const reporterWithoutBaseline = field === 'reporterId' && hashes.reporterId === undefined;
        if (incomingSourceHashes[0] !== jiraEpicParentHash && sameJiraSourceField(incomingSourceHashes, sourceHashes[field])) {
          if (incomingSourceHashes.length === 2) sourceHashes[field] = incomingSourceHashes;
          canCheckpoint = true;
          continue;
        }
        if (hashes[field] === incomingHash) {
          sourceHashes[field] = incomingSourceHashes;
          canCheckpoint = true;
          continue;
        }
        if (currentHash === incomingHash) {
          hashes[field] = incomingHash;
          sourceHashes[field] = incomingSourceHashes;
          canCheckpoint = true;
          continue;
        }
        // Older imports did not populate this field. An explicit local clear is null and is kept without a baseline.
        const canFillPreviouslyUnset = current === undefined && (reporterWithoutBaseline || plannedEffortWithoutBaseline && typeof next === 'number');
        const decision = currentHash === hashes[field] || canFillPreviouslyUnset ? 'apply' : 'conflict';
        fields.push({ field, current: this.jiraReviewValue(field, current, issue.descriptionFormat),
          incoming: this.jiraReviewValue(field, next, values.descriptionFormat), decision });
        if (decision === 'apply') {
          Object.assign(accepted, { [field]: next });
          if (field === 'description') accepted.descriptionFormat = values.descriptionFormat ?? 'plain';
          hashes[field] = incomingHash;
          sourceHashes[field] = incomingSourceHashes;
          canCheckpoint = true;
          updatedFields++;
        } else {
          if (field === 'parentId' && hashes.parentId === undefined) this.notice('JIRA_REFRESH_PARENT_BASELINE_UNAVAILABLE',
            '이전 이관의 상위 업무를 확인할 수 없어 현재 상위 업무를 보존합니다.', 'warning', entry, true);
          if (plannedEffortWithoutBaseline) this.notice('JIRA_REFRESH_PLANNED_EFFORT_BASELINE_UNAVAILABLE',
            '이전 이관의 계획 작업 시간 기준을 확인할 수 없어 현재 값을 보존합니다.', 'warning', entry, true);
          conflictingFields++;
        }
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
      if (Object.keys(accepted).length) updates.push({ issueId: issue.id, expectedVersion: issue.version, changes: accepted,
        ...(accepted.description !== undefined ? { contentReview: { recordId: entry.key, title: accepted.title ?? issue.title } } : {}) });
      if (canCheckpoint || custom?.hashes) this.jiraRefreshCheckpoints.set(entry.key, { issue,
        ...(canCheckpoint ? { hashes, sourceHashes } : {}), ...(custom?.hashes ? { customHashes: custom.hashes } : {}) });
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
  private confluenceParentLabel(id: string | null, fallback = '상위 문서 확인 불가',
    changes?: ReadonlyMap<string, ConfluenceMigrationDocumentValues>): string {
    if (id === null) return '최상위';
    const path: string[] = [];
    let pathLength = 0;
    const seen = new Set<string>();
    for (let current: string | null = id; current !== null && !seen.has(current);) {
      seen.add(current);
      const document: Pick<DocPage, 'parentId' | 'title'> | undefined = this.documentById.get(current) ?? this.hierarchyDocuments.get(current);
      if (!document) break;
      const update: ConfluenceMigrationDocumentValues | undefined = changes?.get(current);
      const title = update?.title ?? document.title;
      const nextLength = pathLength + title.length + (path.length ? 3 : 0);
      if (path.length && nextLength > 300) {
        path.push('…');
        break;
      }
      path.push(title);
      pathLength = nextLength;
      current = update?.parentId === undefined ? document.parentId : update.parentId;
    }
    return path.length ? path.reverse().join(' / ') : fallback;
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
    const parentLabels: { field: ConfluenceMigrationDocumentReview['fields'][number]; destination: string | null; fallback?: string }[] = [];
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
      const { document, previous, previousTimezone, initialParentId } = candidate;
      if (seen.has(document.id)) {
        this.notice('CONFLUENCE_REFRESH_OVERLAPPING_PAGE', '같은 기존 문서의 기록이 겹칩니다. 패키지에서 적용할 페이지 기록 하나를 남겨 주세요.', 'error', entry);
        continue;
      }
      seen.add(document.id);
      const timezone = this.configuration.timezone;
      const newer = newerConfluencePage(row, previous.record, timezone, previousTimezone);
      const originalRawFallback = hasOriginalConfluenceRawFallback(previous.record, document.content);
      const originalChecklistFallback = originalRawFallback && /<ac:task-list(?=[\s/>])/u.test(previous.record.text);
      const originalEngineeringFallback = originalRawFallback && hasConfluenceEngineeringEntity(previous.record.text);
      const canRepairRawFallback = originalChecklistFallback || originalEngineeringFallback;
      const propertiesProjection = hasConfluenceBody(row) && hasConfluencePropertyMacro(row.text);
      const sameSourceRevision = !newer && !sourceBodyErrors.has(entry.key) &&
        sameConfluencePageRevision(row, previous.record, timezone, previousTimezone);
      const bodyReview = this.confluenceBodyReviews.get(entry.key);
      let acceptedBody = bodyReview?.acceptedSourceHash ?? previous.confluencePageBodySourceHash;
      const incomingBody = confluencePageBodySourceHash(row);
      const contentContext = this.confluencePageContentContext(entry, document.id, append.project.id);
      let childListBaseline: string | undefined;
      let headingDepthBaseline: string | undefined;
      const canCheckFormerBody = (newer || sameSourceRevision) && !sourceBodyErrors.has(entry.key) &&
        incomingBody !== undefined && (!acceptedBody || incomingBody === acceptedBody) &&
        hasConfluenceBody(previous.record) && row.text === previous.record.text;
      const hasOldChildList = canCheckFormerBody && documentChildLists(document.content).some(options => options.sort === 'title');
      const hasHeadingDepth = canCheckFormerBody && hasConfluenceHeadingDepth(row);
      if (hasOldChildList || hasHeadingDepth) {
        // Compare the complete previously accepted body before upgrading conversion behavior.
        const currentHash = confluencePageFieldDigest('content', document.content);
        const isOriginalBody = (former?: string): former is string => Boolean(former && former === currentHash &&
          (!previous.confluencePageFieldHashes || previous.confluencePageFieldHashes.content === former));
        if (hasOldChildList) {
          const former = formerConfluenceChildListOrderDigest(row, contentContext);
          if (isOriginalBody(former)) childListBaseline = former;
        }
        if (hasHeadingDepth) {
          const formerHeading = formerConfluenceHeadingDepthDigest(row, contentContext);
          if (isOriginalBody(formerHeading)) headingDepthBaseline = formerHeading;
          else if (hasOldChildList && !childListBaseline) {
            const former = formerConfluenceHeadingDepthDigest(row, { ...contentContext, legacyChildListDefaultOrder: true });
            if (isOriginalBody(former)) {
              headingDepthBaseline = former;
              childListBaseline = former;
            }
          }
        }
      }
      let recoveredBody: { baseline: string; projection: ReturnType<typeof convertLegacyContent>; diagnostics: Set<string> } | undefined;
      const mayHaveLegacyReport = canCheckFormerBody && hasConfluencePropertyReportMacro(row.text);
      const mayHaveLegacyJiraLink = canCheckFormerBody && row.text.includes('/browse/');
      const mayHaveLegacyTableColumns = canCheckFormerBody && hasConfluenceTableColumns(row);
      if (mayHaveLegacyReport || mayHaveLegacyJiraLink || mayHaveLegacyTableColumns) {
        const projection = convertLegacyContent(row, contentContext);
        const baseline = previous.confluencePageFieldHashes?.content ?? confluencePageFieldDigest('content', document.content);
        if (usableConfluenceBody(projection) && confluencePageFieldDigest('content', projection.content) !== baseline) {
          const recoveries: { options: Partial<MigrationContentContext>; diagnostic: string }[] = [];
          if (mayHaveLegacyReport && documentPropertyReports(projection.content).some(report => Array.isArray(report.projectIds))) {
            recoveries.push({ options: { resolvePropertyReportSpaceProject: undefined, legacyMultiSpacePropertyReports: true },
              diagnostic: 'LEGACY_MULTI_SPACE_PROPERTY_REPORT' });
          }
          if (mayHaveLegacyJiraLink) {
            recoveries.push({ options: { legacyConfluenceJiraAnchorProjection: true }, diagnostic: 'LEGACY_CONFLUENCE_JIRA_ANCHOR' });
          }
          if (mayHaveLegacyTableColumns) {
            recoveries.push({ options: { legacyConfluenceTableColumns: true }, diagnostic: 'LEGACY_CONFLUENCE_TABLE_COLUMNS' });
          }
          const candidates: (typeof recoveries)[] = [];
          for (const recovery of recoveries) {
            candidates.push([recovery], ...candidates.map(candidate => [...candidate, recovery]));
          }
          candidates.sort((a, b) => a.length - b.length);
          for (const candidate of candidates) {
            const options = Object.assign({}, ...candidate.map(item => item.options)) as Partial<MigrationContentContext>;
            const former = convertLegacyContent(row, { ...contentContext, ...options });
            const allowed = new Set(candidate.map(item => item.diagnostic));
            if (!candidate.every(item => former.diagnostics.some(diagnostic => diagnostic.code === item.diagnostic))) continue;
            const diagnostics = former.diagnostics.filter(item => !allowed.has(item.code));
            if (usableConfluenceBody({ ...former, diagnostics }) && confluencePageFieldDigest('content', former.content) === baseline) {
              recoveredBody = { baseline, projection, diagnostics: allowed };
              break;
            }
          }
        }
      }
      const sameRevision = sameSourceRevision && (row.metadata.labelSetComplete === true || canRepairRawFallback ||
        propertiesProjection || childListBaseline !== undefined || headingDepthBaseline !== undefined || recoveredBody !== undefined);
      const sourceParent = confluenceParentEvidence(row);
      const reviewParent = sourceParent !== undefined && (newer || laterConfluenceHierarchy(row, previous.record, timezone, previousTimezone));
      if (!newer && !sameRevision && !reviewParent) {
        skippedDocumentUpdates++;
        this.notice('CONFLUENCE_REFRESH_SOURCE_NOT_NEWER', '이관한 원본보다 새로운 버전 또는 수정 시각을 확인할 수 없어 원본만 보관합니다.', 'info', entry);
        continue;
      }
      const title = row.title.trim();
      if (newer && (!title || title.length > 300)) {
        this.notice('CONFLUENCE_REFRESH_TITLE_UNAVAILABLE', '원본 제목이 비어 있거나 300자를 초과해 현재 제목을 보존합니다.', 'warning', entry);
      }
      const needsBodyReview = (newer || sameRevision) && incomingBody !== undefined && (canRepairRawFallback ||
        childListBaseline !== undefined || headingDepthBaseline !== undefined || recoveredBody !== undefined ||
        incomingBody !== acceptedBody && (propertiesProjection || bodyReview?.review));
      const converted = needsBodyReview && !sourceBodyErrors.has(entry.key)
        ? recoveredBody?.projection ?? convertLegacyContent(row, contentContext) : null;
      const safeBody = converted && usableConfluenceBody(converted) ? converted : null;
      if (needsBodyReview && !safeBody) {
        this.notice('CONFLUENCE_REFRESH_BODY_UNAVAILABLE', '본문을 안전하게 변환하거나 원본 참조·첨부를 확인할 수 없어 현재 본문을 보존합니다.', 'warning', entry, true);
        for (const diagnostic of converted?.diagnostics ?? []) {
          if (lossyConfluenceCalloutConversions.has(diagnostic.code) || lossyConfluenceExcerptConversions.has(diagnostic.code) ||
            lossyConfluencePropertyConversions.has(diagnostic.code) ||
            ['SECTION_LINK_UNRESOLVED', 'TOC_PARAMETERS_UNSUPPORTED',
            'LABEL_LIST_PARAMETERS_UNSUPPORTED', 'LABEL_LIST_SCOPE_UNRESOLVED', 'CHILD_LIST_PARAMETERS_UNSUPPORTED',
            'CHILD_LIST_SCOPE_UNRESOLVED', 'CHILD_LIST_EXCERPT_UNSUPPORTED', 'LAYOUT_STRUCTURE_UNSUPPORTED'].includes(diagnostic.code)) {
            this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry);
          }
        }
      }
      const values: ConfluenceMigrationDocumentValues = {};
      if (newer && title && title.length <= 300) values.title = title;
      let sourceParentLabel: string | undefined;
      if (reviewParent) {
        if (sourceParent === null) values.parentId = null;
        else {
          const resolved = this.confluencePage(entry, { sourceId: sourceParent });
          const resolvedClass = resolved?.entry
            ? resolved.entry.row.metadata.sourceClass : resolved && this.originalPage(resolved.sourceId)?.sourceClass;
          if (resolved && resolvedClass === 'Page') {
            values.parentId = resolved.reference.id;
            sourceParentLabel = resolved.reference.label;
          } else {
            this.notice('CONFLUENCE_REFRESH_PARENT_UNAVAILABLE',
              `원본 상위 페이지 ${sourceParent}의 같은 공간 내 연결을 확인할 수 없어 현재 위치를 보존합니다.`, 'warning', entry, true);
          }
        }
      }
      if (safeBody) {
        values.content = safeBody.content;
        for (const diagnostic of safeBody.diagnostics) this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
      }
      const hashes = { ...previousConfluencePageFieldDigests(previous, document.content) };
      if (childListBaseline) hashes.content = childListBaseline;
      if (headingDepthBaseline) hashes.content = headingDepthBaseline;
      if (recoveredBody) hashes.content = recoveredBody.baseline;
      if (hashes.parentId === undefined && initialParentId !== undefined) hashes.parentId = confluencePageFieldDigest('parentId', initialParentId);
      if (canRepairRawFallback && !previous.confluencePageFieldHashes?.content) {
        // For old receipts, the full original code block is the only proven baseline.
        hashes.content = confluencePageFieldDigest('content', document.content);
      }
      const currentLabels = document.labels ?? [];
      const status = string(row.metadata.contentStatus).trim().toLowerCase();
      const labels = !status || status === 'current'
        ? this.confluenceDocumentLabels(entry, excludedLabels.get(entry.key), true) : { values: [], complete: false };
      if ((newer || sameRevision) && labels.complete) values.labels = labels.values;
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
        if (hashes[field] === incomingHash) {
          if (field === 'content') acceptedBody = incomingBody;
          checkpoint = true;
          continue;
        }
        if (incomingHash === currentHash) {
          if (field === 'content') acceptedBody = incomingBody;
          hashes[field] = incomingHash;
          checkpoint = true;
          continue;
        }
        const decision = currentHash === hashes[field] ? 'apply' : 'conflict';
        const current = field === 'title' ? document.title : field === 'labels' ? currentLabels.join('\n') || '—'
          : field === 'parentId' ? this.confluenceParentLabel(document.parentId) : document.plainText;
        const incomingText = field === 'title' ? title : field === 'labels' ? values.labels!.join('\n') || '—'
          : field === 'parentId' ? '' : safeBody!.plainText;
        const reviewField: ConfluenceMigrationDocumentReview['fields'][number] = { field, current: field === 'labels' || field === 'parentId' ? current : confluenceReviewExcerpt(current),
          incoming: field === 'labels' ? incomingText : confluenceReviewExcerpt(incomingText), decision,
          ...(field === 'content' && current === incomingText ? { formatOnly: true } : {}) };
        fields.push(reviewField);
        if (field === 'parentId') parentLabels.push({ field: reviewField, destination: values.parentId ?? null, fallback: sourceParentLabel });
        if (field === 'labels' && sameRevision && decision === 'apply') this.notice('CONFLUENCE_REFRESH_LABEL_SAME_REVISION',
          '같은 페이지 버전의 라벨 목록을 비교했습니다. 반영 전에 내보내기 순서를 확인해 주세요.', 'warning', entry, true);
        if (decision === 'apply') {
          if (field === 'content' && sameRevision && originalChecklistFallback) this.notice('CONFLUENCE_REFRESH_CHECKLIST_RESTORED',
            '원문 블록으로 보관된 본문을 편집 가능한 체크리스트가 있는 본문으로 바꿉니다.', 'warning', entry, true);
          if (field === 'content' && sameRevision && originalEngineeringFallback) this.notice('CONFLUENCE_REFRESH_ENGINEERING_ENTITIES_RESTORED',
            '원문 블록으로 보관된 기호와 단위 표기가 편집 가능한 본문에 표시됩니다.', 'warning', entry, true);
          if (field === 'content' && sameRevision && propertiesProjection && !childListBaseline) this.notice('CONFLUENCE_REFRESH_DOCUMENT_PROPERTIES_RESTORED',
            '같은 원본 버전의 속성 표나 보고서를 편집 가능한 문서 블록으로 바꿉니다.', 'warning', entry, true);
          if (field === 'content' && sameRevision && childListBaseline) this.notice('CONFLUENCE_REFRESH_CHILD_LIST_ORDER_RESTORED',
            '같은 원본 버전의 하위 문서 목록에 수동 순서가 있으면 반영합니다.', 'info', entry);
          if (field === 'content' && sameRevision && headingDepthBaseline) this.notice('CONFLUENCE_REFRESH_HEADING_DEPTH_RESTORED',
            '같은 원본 버전에서 확인한 제목 단계와 목차 범위를 복원합니다.', 'warning', entry, true);
          if (field === 'content' && recoveredBody?.diagnostics.has('LEGACY_CONFLUENCE_JIRA_ANCHOR')) this.notice('CONFLUENCE_REFRESH_JIRA_ANCHORS_RESTORED',
            '글자로 남아 있던 Jira 주소를 원본 링크로 복원합니다.', 'warning', entry, true);
          if (field === 'content' && recoveredBody?.diagnostics.has('LEGACY_CONFLUENCE_TABLE_COLUMNS')) this.notice('CONFLUENCE_REFRESH_TABLE_COLUMNS_RESTORED',
            '표 앞의 열 너비 XML 코드를 제거하고 편집 가능한 표에 열 너비를 반영합니다.', 'warning', entry, true);
          Object.assign(accepted, { [field]: incoming });
          hashes[field] = incomingHash;
          if (field === 'content') acceptedBody = incomingBody;
          checkpoint = true;
          updatedDocumentFields++;
        } else {
          if (field === 'parentId' && hashes.parentId === undefined) this.notice('CONFLUENCE_REFRESH_PARENT_BASELINE_UNAVAILABLE',
            '이전 이관에서 저장한 위치를 확인할 수 없어 현재 위치를 보존합니다.', 'warning', entry, true);
          conflictingDocumentFields++;
        }
      }
      if (fields.length) review.push({ documentId: document.id, title: document.title, sourceId: row.sourceId, recordId: entry.key, fields });
      if (Object.keys(accepted).length) updates.push({ documentId: document.id, expectedVersion: document.version, changes: accepted,
        ...(accepted.content !== undefined ? { contentReview: { recordId: entry.key, title: accepted.title ?? document.title } } : {}) });
      if (accepted.content && this.confluenceInlineClaims.has(entry.key)) {
        this.confluenceInlineRefreshedBodyHashes.set(document.id, confluencePageFieldDigest('content', accepted.content));
      }
      if (checkpoint) {
        this.confluenceRefreshCheckpoints.set(entry.key, { document, hashes });
        if (acceptedBody) this.confluenceBodySourceHashes.set(entry.key, acceptedBody);
      }
    }
    if (parentLabels.length) {
      const changes = new Map(updates.map(update => [update.documentId, update.changes]));
      for (const { field, destination, fallback } of parentLabels) {
        field.incoming = this.confluenceParentLabel(destination, fallback, changes);
      }
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
    this.hierarchyDocuments = new Map((append.hierarchyDocuments ?? []).map(document => [document.id, document]));
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
      if (refresh && newerConfluencePage(entry.row, refresh.previous.record, this.configuration.timezone, refresh.previousTimezone)) {
        const review = reviewNewerConfluenceBody(entry.row, refresh.previous, page.documentId);
        this.confluenceBodyReviews.set(entry.key, review);
        if (!review.review) continue;
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
    for (const sourceId of this.confirmedConfluenceRestrictions?.get(instance) ?? []) this.restrictedSourcePages.add(sourceId);
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
  run():PreparedMigration{this.initialize();if(!this.notices.some(notice=>notice.severity==='error')){this.createPrimary();this.createJiraReleases();this.createJiraSprints();this.createOriginLinks();this.createFiles();this.indexConfluenceInlineComments();this.convertDocuments();this.createJiraRefreshes();this.createConfluenceRefreshes();this.createConfluenceDocumentOrders();this.createJiraHistory();this.reviewJiraCommentCorrections();this.reviewJiraWorklogCorrections();this.createSecondary();this.createConfluenceHistory();this.planConfluenceCommentReplies();this.createWorklogs();this.createRelations();this.validateGraph();}this.archive();return this.finish();}
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
    for (const entry of this.entries) {
      const key = entry.row.metadata.key;
      const base = this.originBases.get(entry.pkg.summary.id);
      if (entry.row.kind !== 'issue' || entry.pkg.dataset.source.product !== 'jira' || !base || !isJiraIssueKey(key)) continue;
      const locator = JSON.stringify([base.origin, base.contextPath, key.toUpperCase()]);
      const candidates = this.jiraIssuesByAddress.get(locator);
      if (candidates) candidates.push(entry);
      else this.jiraIssuesByAddress.set(locator, [entry]);
    }
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
  private indexConfirmedConfluenceRestrictions(exclusionChildren: Map<string, string[]>): Set<string> {
    const confirmed = this.confirmedConfluenceRestrictions;
    const restrictedRecords = new Set<string>();
    if (!confirmed?.size) return restrictedRecords;

    const sourceKey = (instance: string, kind: string, id: string) => JSON.stringify([instance, kind, id]);
    const eligibleKinds = new Set(['page', 'attachment', 'comment', 'revision']);
    const records = new Map<string, Entry[]>();
    const children = new Map<string, { key: string; entry: Entry }[]>();
    for (const entry of this.entries) {
      const { product, instanceKey } = entry.pkg.dataset.source;
      const { kind, sourceId, parentId, references, metadata } = entry.row;
      if (product !== 'confluence' || !confirmed.get(instanceKey)?.size || !eligibleKinds.has(kind)) continue;
      const key = sourceKey(instanceKey, kind, sourceId);
      const copies = records.get(key) ?? [];
      copies.push(entry);
      records.set(key, copies);

      const parents = new Set<string>();
      for (const reference of references) {
        if (!eligibleKinds.has(reference.kind)) continue;
        const isPageAncestor = kind === 'page' && reference.kind === 'page' && ['ancestor', 'parent'].includes(reference.relation);
        const isContentOwner = kind !== 'page' && (pageOwnerRelations.has(reference.relation) ||
          kind === 'revision' && reference.relation === 'original-version' ||
          kind === 'comment' && reference.kind === 'comment' && reference.relation === 'parent');
        if (isPageAncestor || isContentOwner) parents.add(sourceKey(instanceKey, reference.kind, reference.sourceId));
      }
      if ((kind === 'page' || kind === 'comment') && parentId) parents.add(sourceKey(instanceKey, kind, parentId));
      if (kind === 'attachment' && typeof metadata.currentVersionId === 'string') {
        parents.add(sourceKey(instanceKey, kind, metadata.currentVersionId));
      }
      if (kind !== 'page') {
        const owner = this.ownerEntry(entry);
        if (owner?.row.kind === 'page') parents.add(sourceKey(instanceKey, 'page', owner.row.sourceId));
        if (metadata.orphan === true && typeof metadata.ownerId === 'string' &&
            (metadata.ownerClass === 'Page' || metadata.ownerClass === 'BlogPost')) {
          parents.add(sourceKey(instanceKey, 'page', metadata.ownerId));
        }
      }
      parents.delete(key);
      for (const parent of parents) {
        const descendants = children.get(parent) ?? [];
        descendants.push({ key, entry });
        children.set(parent, descendants);
      }
    }

    // An excluded page also covers associated records in other ZIPs from its source instance.
    // A page absent from all selected ZIPs still blocks each affected record until its exclusion.
    const queue: string[] = [];
    for (const [instance, pages] of confirmed) for (const page of pages) queue.push(sourceKey(instance, 'page', page));
    const seen = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor];
      const descendants = children.get(key) ?? [];
      for (const record of records.get(key) ?? []) {
        restrictedRecords.add(record.key);
        if (!descendants.length) continue;
        const linked = exclusionChildren.get(record.key) ?? [];
        for (const child of descendants) linked.push(child.entry.key);
        exclusionChildren.set(record.key, linked);
      }
      for (const child of descendants) {
        if (seen.has(child.key)) continue;
        seen.add(child.key);
        queue.push(child.key);
      }
    }
    return restrictedRecords;
  }

  private indexJiraServiceDeskRestrictions(): void {
    const sourceKey = (entry: Entry, id: string) => JSON.stringify([entry.pkg.dataset.source.instanceKey, id]);
    const commentIds = new Set<string>();
    for (const entry of this.entries) {
      const { row } = entry;
      if (entry.pkg.dataset.source.product !== 'jira' || !hasRestrictedJiraServiceDeskComment(row.metadata)) continue;
      if (row.kind === 'comment' && row.metadata.syntheticId !== true && isJiraHierarchyIssueId(row.sourceId)) {
        commentIds.add(sourceKey(entry, row.sourceId));
      } else if (entry.pkg.dataset.source.format === 'jira-backup-xml' && row.kind === 'relation' &&
          row.metadata.jiraServiceDeskCommentProperty === true) {
        for (const ref of row.references) {
          if (ref.kind === 'comment' && ref.relation === 'commentVisibility' && isJiraHierarchyIssueId(ref.sourceId)) {
            commentIds.add(sourceKey(entry, ref.sourceId));
          }
        }
      }
    }
    if (!commentIds.size) return;

    const namesByIssue = new Map<string, Set<string>>();
    for (const entry of this.entries) {
      const { row } = entry;
      if (entry.pkg.dataset.source.product !== 'jira' || row.kind !== 'comment' || row.metadata.syntheticId === true ||
          !commentIds.has(sourceKey(entry, row.sourceId))) continue;
      this.restrictedJiraServiceDeskEntries.add(entry.key);
      const { containerId } = row;
      if (!containerId || !isJiraHierarchyIssueId(containerId) || jiraHistoryOwnerAliases(row)?.length !== 1) continue;
      const key = sourceKey(entry, containerId);
      for (const name of jiraServiceDeskAttachmentNames(row)) {
        const names = namesByIssue.get(key) ?? new Set<string>();
        names.add(name);
        namesByIssue.set(key, names);
      }
    }
    if (!namesByIssue.size) return;

    for (const entry of this.entries) {
      const { row } = entry;
      if (entry.pkg.dataset.source.product !== 'jira' || row.kind !== 'attachment' || !row.containerId ||
          typeof row.metadata.filename !== 'string' || !namesByIssue.get(sourceKey(entry, row.containerId))?.has(row.metadata.filename) ||
          jiraAttachmentOwnerAliases(row)?.length !== 1) continue;
      this.restrictedJiraServiceDeskEntries.add(entry.key);
    }
  }

  initialize():void{
    const config=this.configuration,sourceCount=this.entries.length;
    if(this.input.packages.length>MAX_PACKAGES||sourceCount>MAX_RECORDS||this.input.packages.reduce((sum,pkg)=>sum+pkg.summary.expandedBytes,0)>MAX_EXPANDED_BYTES)this.notice('PLAN_LIMIT','한 이관은20개 패키지·100000개 원본 객체·총256MiB 확장 크기 이하여야 합니다.','error');
    if(!this.input.users.some(user=>user.id===this.input.actorId))this.notice('ACTOR_INVALID','이관 작업자를 찾을 수 없습니다.','error');
    if(!Array.isArray(config.packageIds)||new Set(config.packageIds).size!==config.packageIds.length||config.packageIds.length!==this.input.packages.length||this.input.packages.some(pkg=>!config.packageIds.includes(pkg.summary.id)))this.notice('PACKAGE_SELECTION_INVALID','선택한 패키지 목록과 이관 구성이 일치하지 않습니다.','error');
    try{if(!config.timezone)throw new Error();new Intl.DateTimeFormat('en',{timeZone:config.timezone}).format(0);}catch{this.timezoneValid=false;this.notice('TIMEZONE_INVALID','유효한 원본 IANA 시간대를 지정해 주세요.','error');}
    if(!['block','import-time'].includes(config.datePolicy))this.notice('DATE_POLICY_INVALID','날짜 처리 방식을 확인해 주세요.','error');
    this.initializeOriginBases();
    this.indexJiraServiceDeskRestrictions();
    for(const key of config.excludedRecords||[]){if(!this.entryByKey.has(key))this.notice('EXCLUSION_INVALID','제외 대상 원본 객체를 찾을 수 없습니다.','error');else this.excluded.add(key);}
    const explicitCount=this.excluded.size,children=new Map<string,string[]>();
    for(const entry of this.entries){this.archiveIds.set(entry.key,randomUUID());const row=entry.row,parents:string[]=[];if(row.parentId)parents.push(`${entry.pkg.summary.id}/${row.kind==='issue'?'issue':row.kind==='page'?'page':row.kind}:${row.parentId}`);if(row.kind==='issue'||row.kind==='page')parents.push(`${entry.pkg.summary.id}/project:${entry.container}`);else{const owner=this.ownerEntry(entry);if(owner&&owner!==entry)parents.push(owner.key);const current=string(row.metadata.currentVersionId);if(current)parents.push(`${entry.pkg.summary.id}/${row.kind==='revision'?'page':row.kind}:${current}`);}for(const parent of parents){const values=children.get(parent)||[];values.push(entry.key);children.set(parent,values);}}
    const confirmedRestrictions = this.indexConfirmedConfluenceRestrictions(children);
    const queue=[...this.excluded];for(let cursor=0;cursor<queue.length;cursor++)for(const child of children.get(queue[cursor])||[])if(!this.excluded.has(child)){this.excluded.add(child);queue.push(child);}
    this.result.preview.counts.explicitExcludedRecords=explicitCount;this.result.preview.counts.excludedDescendants=this.excluded.size-explicitCount;
    if(this.excluded.size)this.notice('RECORDS_EXCLUDED',`원본 ${this.excluded.size}개를 적용 대상에서 제외합니다(명시적 ${explicitCount}개, 하위 ${this.excluded.size-explicitCount}개). 원문 보관은 유지합니다.`,'warning',undefined,true);
    for(const option of this.options.identities){if(!Object.hasOwn(config.users,option.id))this.notice('USER_MAPPING_REQUIRED',`원본 사용자 매핑을 선택해 주세요: ${option.label}`,'error');else if(config.users[option.id]!==null&&!this.input.users.some(user=>user.id===config.users[option.id]))this.notice('USER_MAPPING_INVALID','매핑한 팀원을 찾을 수 없습니다.','error');}
    if(this.options.identities.some(option=>config.users[option.id]===null))this.notice('SOURCE_IDENTITIES_ARCHIVED','매핑하지 않은 원본 사용자 신원은 그대로 보관하고, 현재 댓글·문서·첨부의 작성자는 이관 작업자로 기록합니다.','warning',undefined,true);
    this.initializeAppend();
    this.initializePageAppend();
    if (!config.appendTo && !config.appendPagesTo) {
      for (const option of this.options.statuses) {
        const chosen = config.statuses[option.id];
        const valid = categories.includes(chosen);
        const sourceCategory = this.nativeJiraStatusCategories.get(option.id);
        if (sourceCategory === null) {
          this.notice('JIRA_STATUS_CATEGORY_CONFLICT', valid
            ? `원본 Jira 상태 '${option.label}'의 분류 근거가 서로 다릅니다. 직접 선택한 분류를 확인해 주세요.`
            : `원본 Jira 상태 '${option.label}'의 분류 근거가 서로 다릅니다. 상태 매핑에서 분류를 선택해 주세요.`, valid ? 'warning' : 'error', undefined, valid);
        } else if (!valid) {
          this.notice('STATUS_MAPPING_REQUIRED', `원본 상태의 분류를 선택해 주세요: ${option.label}`, 'error');
        } else if (sourceCategory && statusFamily[chosen] !== sourceCategory) {
          this.notice('JIRA_STATUS_CATEGORY_OVERRIDE', `원본 Jira 상태 '${option.label}'의 분류를 변경합니다. 선택한 분류를 확인해 주세요.`, 'warning', undefined, true);
        }
      }
      for(const option of this.options.issueTypes)if(!Object.hasOwn(config.issueTypes,option.id)||config.issueTypes[option.id]!==null&&!ISSUE_TYPES.includes(config.issueTypes[option.id] as typeof ISSUE_TYPES[number]))this.notice('TYPE_MAPPING_REQUIRED',`원본 유형을 기존 유형 또는 새 유형에 매핑해 주세요: ${option.label}`,'error');
      for (const option of this.options.fields) {
        const kind = config.fields[option.id] ?? (option.requiredKind ? 'archive' : undefined);
        if (kind === 'archive') continue;
        if (!kind || !fieldKinds.includes(kind)) {
          this.notice('FIELD_MAPPING_REQUIRED', `원본 필드의 처리 방식을 선택해 주세요: ${option.label}`, 'error');
        } else if (option.requiredKind && kind !== option.requiredKind) {
          this.noticeRequiredFieldKind(option);
        }
      }
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
    for (const entry of this.entries) {
      if (this.excluded.has(entry.key)) continue;
      if (confirmedRestrictions.has(entry.key) || !this.retainedEntries.has(entry.key) &&
          (this.restricted(entry) || entry.row.kind === 'page' && this.restrictedSourcePages.has(entry.row.sourceId))) {
        this.notice('RESTRICTED_CONTENT', '권한 또는 공개 범위가 제한된 원본은 현재 서비스에 그대로 공개할 수 없습니다. 해당 객체를 제외해 주세요.', 'error', entry);
      }
    }
    for(const pkg of this.input.packages){for(const diagnostic of pkg.dataset.diagnostics){
      const recordKey = diagnostic.recordId ? `${pkg.summary.id}/${diagnostic.recordId}` : null;
      if (recordKey && (this.excluded.has(recordKey) || this.retainedEntries.has(recordKey))) continue;
      if (diagnostic.severity !== 'error' || /ATTACHMENT_BYTES_MISSING/.test(diagnostic.code)) continue;
      const entry = recordKey ? this.entryByKey.get(recordKey) : undefined;
      if (diagnostic.code === 'NO_PRIMARY_CONTENT' && (this.result.appendPages && config.appendPagesTo?.refreshHistory === true ||
          this.result.append && (config.appendTo?.refreshHistory === true || config.appendTo?.refreshComments === true || config.appendTo?.refreshWorklogs === true ||
            config.appendTo?.refreshAttachments === true || config.appendTo?.refreshRelations === true) &&
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
    if(entry.pkg.dataset.source.product==='jira'&&(this.restrictedJiraServiceDeskEntries.has(entry.key)||isRestrictedJiraHistory(row)||isRestrictedJiraStatusHistory(row)||isRestrictedJiraAttachment(row)))return true;
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
    if (!append) this.createJiraComponentFields();
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
        const stateId = mapping ? mapping.statuses[statusOption] : importedStatusId(entry.pkg.dataset.source, state.value);
        const workflow = this.workflows.get(project.id)!;
        const existingState = workflow.statuses.find(status => status.id === stateId);
        const category = mapping ? existingState?.category : this.configuration.statuses[statusOption];
        if (!category) {
          if (mapping) this.notice('APPEND_STATUS_REQUIRED', `원본 상태 '${state.label}'를 기존 프로젝트의 상태에 연결해 주세요.`, 'error', entry);
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
        const typeId = mapping ? mappedType : mappedType || importedIssueTypeId(entry.pkg.dataset.source, sourceType.value);
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
        const priority = this.jiraPriorityValue(entry);
        if (priority === null) this.notice('JIRA_PRIORITY_UNRESOLVED', '원본 우선순위를 확인할 수 없어 보통으로 이관합니다. 원본 값은 보존합니다.', 'warning', entry, true);
        const assigneeRef=row.references.find(reference=>reference.kind==='identity'&&reference.relation==='assignee'),assigneeSource=assigneeRef?.sourceId||string(scalar(sourceField(row,'assignee'))),mappedAssignee=assigneeSource?this.configuration.users[optionId(entry.pkg.summary.id,'identity',assigneeSource)]:null;
        const reporter = jiraReporter(row);
        const reporterId = typeof reporter === 'string' ? this.mappedAuthor(entry, reporter) ?? undefined : reporter;
        const labelsRaw=sourceField(row,'labels')??row.metadata.labels,labels=(Array.isArray(labelsRaw)?labelsRaw:typeof labelsRaw==='string'?labelsRaw.split(/[;,]/):[]).map(value=>string(value));if(labels.some(label=>label.length>60))this.notice('LABEL_LIMIT','원본 라벨이 현재60자 제한을 넘습니다.','error',entry);
        const start = this.initialJiraScheduleDate(entry, 'startDate');
        const end = this.initialJiraScheduleDate(entry, 'endDate');
        const due = this.issueDate(jiraCalendarValue(row, 'dueDate'), entry);
        if (start && end && start > end) this.notice('ISSUE_DATE_RANGE','시작일이 종료일보다 늦습니다.','error',entry);
        const rawEstimate=sourceField(row,'estimate'),estimate=rawEstimate===undefined||rawEstimate===null||rawEstimate===''?null:Number(rawEstimate);if(estimate!==null&&(!Number.isFinite(estimate)||estimate<0||estimate>100000))this.notice('ESTIMATE_ARCHIVED','예상 작업량의 단위/범위를 현재 숫자로 옮기지 않고 원본으로 보관합니다.','warning',entry,true);
        const issue:Issue={id,key:`${project.key}-${number}`,projectId:project.id,title,description:'',type:typeId,status:stateId,priority:priority??'medium',assigneeId:typeof mappedAssignee==='string'?mappedAssignee:null,collaboratorIds:[],parentId:null,labels:[...new Set(labels)],startDate:start,endDate:end,dueDate:due,estimate:estimate!==null&&Number.isFinite(estimate)&&estimate>=0&&estimate<=100000?estimate:null,cycle:null,module:null,release:null,cycleId:null,moduleId:null,releaseId:null,customFields:{},version:1,createdAt,updatedAt,completedAt:category==='done'?(this.time(jiraCompletionTime(row),entry,false)||updatedAt):null};this.result.issues.push(issue);this.issueById.set(id,issue);this.primaryById.set(id,entry);this.bindings.set(entry.key,{type:'issue',id,projectId:project.id});
        if (reporterId !== undefined) issue.reporterId = reporterId;
        if (entry.pkg.dataset.source.product === 'jira') {
          const plannedEffortMinutes = this.jiraPlannedEffort(entry);
          if (plannedEffortMinutes !== undefined) issue.plannedEffortMinutes = plannedEffortMinutes;
        }
        if (mapping) this.mapAppendFields(entry, issue, schema, mapping.fields);
        else this.mapNewIssueFields(entry, issue, schema);
        if(row.textFormat!=='plain'&&row.textFormat!=='none')this.notice('ISSUE_DESCRIPTION_PLAIN_TEXT','업무 설명은 현재 일반 텍스트로 변환합니다. 원래 서식·본문은 원본 보관함에 유지합니다.','warning',entry,true);
      }
    }
    const historicalWorkflows = this.eligibleHistoricalJiraWorkflows();
    const overrides = this.configuration.jiraWorkflows ?? {};
    const reviewedProjects = new Set<string>();
    for (const project of this.result.projects) {
      const schema = this.schemas.get(project.id)!, workflow = this.workflows.get(project.id)!;
      if (!schema.issueTypes.length) schema.issueTypes = defaultIssueSchema(project.id).issueTypes;
      if (Object.hasOwn(overrides, project.key)) {
        reviewedProjects.add(project.key);
        this.reviewJiraWorkflow(project.key, workflow, overrides[project.key], historicalWorkflows.get(project.id)?.statuses);
      } else if (!workflow.statuses.length) {
        Object.assign(workflow, defaultWorkflow(project.id, this.input.now));
      } else {
        workflow.initialStatusId = (workflow.statuses.find(status => status.category === 'todo') ??
          workflow.statuses.find(status => status.category === 'backlog') ??
          workflow.statuses.find(status => status.category !== 'done' && status.category !== 'cancelled') ?? workflow.statuses[0]).id;
        if (workflow.statuses.length <= 40) {
          workflow.transitions = workflow.statuses.flatMap(from => workflow.statuses.filter(to => to.id !== from.id)
            .map(to => ({ from: from.id, to: to.id, issueTypes: [], requiredFields: [] })));
        }
        this.notice('WORKFLOW_RULES_NOT_REPRODUCED','원본 워크플로의 조건·검증기·후처리를 재현하지 않습니다. 매핑한 상태 사이의 전이를 허용하는 새 흐름을 만듭니다.','warning',undefined,true);
      }
      if (workflow.statuses.length > 40 || schema.issueTypes.length > 50 || schema.fields.length > 100) {
        this.notice('SCHEMA_LIMIT', '프로젝트별 상태40개·유형50개·필드100개 제한을 넘습니다.', 'error');
      }
      if (new Set(schema.issueTypes.map(type => type.name)).size !== schema.issueTypes.length) {
        this.notice('TYPE_NAME_CONFLICT', '새 프로젝트 안에 같은 이름의 서로 다른 유형이 있습니다. 유형 매핑을 조정해 주세요.', 'error');
      }
      if (schema.fields.some(field => !field.name.trim() || field.name.length > 120) ||
        new Set(schema.fields.map(field => field.name)).size !== schema.fields.length) {
        this.notice('FIELD_NAME_CONFLICT', '필드 이름이 중복되거나120자 제한을 넘습니다. 매핑 또는 보관 방식을 조정해 주세요.', 'error');
      }
      this.result.issueSchemas.push(schema);
      this.result.workflows.push(workflow);
    }
    for (const key of Object.keys(overrides)) {
      if (!reviewedProjects.has(key)) {
        this.notice('JIRA_WORKFLOW_PROJECT_INVALID', `${key}의 워크플로는 Jira 업무를 옮길 새 프로젝트에 지정해 주세요.`, 'error');
      }
    }
    if (!append && !this.input.appendPages) this.observeJiraWorkflows(historicalWorkflows);
  }
  private eligibleHistoricalJiraWorkflows(): Map<string, HistoricalJiraWorkflow> {
    const results = new Map<string, HistoricalJiraWorkflow>();
    if (this.input.append || this.input.appendPages) return results;
    const catalog = new Map<HistoricalJiraStatus, MigrationJiraWorkflowStatus | null>();
    const status = (value: HistoricalJiraStatus): MigrationJiraWorkflowStatus | null => {
      if (!catalog.has(value)) {
        const evidence = [...value.catalog].filter(([key]) => !this.excluded.has(key));
        const native = evidence.find(([, category]) => category !== undefined)?.[1];
        const suggested = suggestCategory(value.label);
        const category = native && statusFamily[suggested] !== native ? categoryDefaults[native] : suggested;
        catalog.set(value, evidence.length ? { id: value.id, label: value.label, category } : null);
      }
      return catalog.get(value) ?? null;
    };
    for (const { ownerKey, historyKey, from, to } of this.historicalJiraTransitions) {
      const owner = this.entryByKey.get(ownerKey), history = this.entryByKey.get(historyKey), binding = this.bindings.get(ownerKey);
      if (!owner || !history || !binding || binding.type !== 'issue' || !binding.projectId ||
          this.skip(owner) || this.skip(history) || this.restricted(owner) || this.restricted(history)) continue;
      const fromStatus = status(from), toStatus = status(to);
      if (!fromStatus || !toStatus) continue;
      const workflow: HistoricalJiraWorkflow = results.get(binding.projectId) ?? { statuses: new Map(), transitions: new Map() };
      workflow.statuses.set(fromStatus.id, fromStatus);
      workflow.statuses.set(toStatus.id, toStatus);
      const transitions = workflow.transitions.get(ownerKey) ?? [];
      transitions.push({ from: fromStatus.id, to: toStatus.id });
      workflow.transitions.set(ownerKey, transitions);
      results.set(binding.projectId, workflow);
    }
    return results;
  }

  private observeJiraWorkflows(historical: ReadonlyMap<string, HistoricalJiraWorkflow>): void {
    const history = this.entries.filter(entry => entry.pkg.dataset.source.product === 'jira' && entry.row.kind === 'history' && !this.skip(entry));
    if (!history.length) return;
    const keyFor = (instance: string, sourceId: string) => JSON.stringify([instance, sourceId]);
    const packages = new Map<string, Map<string, Entry | null>>();
    const owners = new Map<Entry, Issue>();
    const destinations = new Map(this.result.projects.flatMap(project => {
      const workflow = this.workflows.get(project.id)!;
      if (workflow.statuses.length > 40 || !workflow.statuses.some(status => status.id === workflow.initialStatusId)) return [];
      return [[project.id, { projectKey: project.key, workflow, statusIds: new Map<string, string>(),
        transitions: new Map<string, MigrationJiraObservedTransition>(),
      }] as const];
    }));
    if (!destinations.size) return;
    for (const entry of this.entries) {
      const { pkg, row } = entry;
      const source = pkg.dataset.source;
      if (source.product !== 'jira' || row.kind !== 'issue') continue;
      let aliases = packages.get(pkg.summary.id);
      if (!aliases) {
        aliases = new Map();
        packages.set(pkg.summary.id, aliases);
      }
      // Check alias ambiguity across all original package rows, including exclusions.
      for (const alias of [row.sourceId, typeof row.metadata.key === 'string' ? row.metadata.key : '']) {
        if (!alias) continue;
        const previous = aliases.get(alias);
        if (previous !== entry) aliases.set(alias, previous === undefined ? entry : null);
      }
      const binding = this.bindings.get(entry.key);
      const issue = binding?.type === 'issue' ? this.issueById.get(binding.id) : undefined;
      const destination = issue && destinations.get(issue.projectId);
      if (!issue || !destination || this.skip(entry) || this.restricted(entry) || isRestrictedJiraHistoryOwner(row)) continue;
      // Generated export row IDs cannot establish an original Jira issue's identity.
      if (row.metadata.syntheticId === true || !row.metadata.key && /^(?:json|xml|csv):.+:\d+$/u.test(row.sourceId)) continue;
      owners.set(entry, issue);
      const originalStatus = jiraOriginalStatusId(source, row);
      if (originalStatus && issue.status === importedStatusId(source, originalStatus)) {
        destination.statusIds.set(keyFor(source.instanceKey, originalStatus), issue.status);
      }
    }

    const historyByOwner = new Map<Entry, LegacyRecord[]>();
    for (const { pkg, row } of history) {
      const aliases = jiraStatusHistoryOwnerAliases(row);
      const packageOwners = packages.get(pkg.summary.id);
      if (!aliases || !packageOwners) continue;
      const owner = packageOwners.get(aliases[0]);
      if (!owner || !owners.has(owner) || aliases.some(alias => packageOwners.get(alias) !== owner)) continue;
      const records = historyByOwner.get(owner);
      if (records) records.push(row);
      else historyByOwner.set(owner, [row]);
    }

    // The new-project planner rejects overlapping live source issue IDs for
    // the same source instance before binding. Deduplicate only within each owner.
    for (const [owner, issue] of owners) {
      const records = historyByOwner.get(owner) ?? [];
      const { statusIds, transitions } = destinations.get(issue.projectId)!;
      const instance = owner.pkg.dataset.source.instanceKey;
      const seen = new Set<string>();
      const count = ({ from, to }: Pick<MigrationJiraObservedTransition, 'from' | 'to'>) => {
        const pair = JSON.stringify([from, to]);
        if (seen.has(pair)) return;
        seen.add(pair);
        const transition = transitions.get(pair);
        if (transition) transition.issueCount++;
        else transitions.set(pair, { from, to, issueCount: 1 });
      };
      for (const row of records) {
        for (const change of jiraStatusTransitions(row)) {
          const from = change.from.id && statusIds.get(keyFor(instance, change.from.id));
          const to = change.to.id && statusIds.get(keyFor(instance, change.to.id));
          if (!from || !to || from === to) continue;
          count({ from, to });
        }
      }
      for (const edge of historical.get(issue.projectId)?.transitions.get(owner.key) ?? []) count(edge);
    }

    const observed: MigrationJiraObservedWorkflow[] = [];
    for (const [projectId, { projectKey, workflow, transitions }] of destinations) {
      const { initialStatusId, statuses } = workflow;
      if (!transitions.size) continue;
      const observedStatuses = new Map(historical.get(projectId)?.statuses);
      for (const { id, label, category } of statuses) observedStatuses.set(id, { id, label, category });
      observed.push({ projectKey, initialStatusId,
        statuses: [...observedStatuses.values()].sort((left, right) => left.id.localeCompare(right.id)),
        transitions: [...transitions.values()]
          .sort((left, right) => right.issueCount - left.issueCount || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
      });
    }
    if (observed.length) this.result.preview.jiraObservedWorkflows = observed.sort((left, right) => left.projectKey.localeCompare(right.projectKey));
  }
  private reviewJiraWorkflow(projectKey: string, workflow: ProjectWorkflow, review: MigrationJiraWorkflow,
    historical?: ReadonlyMap<string, MigrationJiraWorkflowStatus>): void {
    if (!workflow.statuses.length) {
      this.notice('JIRA_WORKFLOW_PROJECT_INVALID', `${projectKey}의 워크플로를 구성할 이관 대상 Jira 업무가 없습니다.`, 'error');
      return;
    }
    const additional = review.additionalStatuses ?? [];
    const statusIds = new Set(workflow.statuses.map(status => status.id));
    const selected = new Set([review.initialStatusId, ...review.transitions.flatMap(({ from, to }) => [from, to])]);
    const observed = [...selected].flatMap(id => {
      const status = historical?.get(id);
      return status && !statusIds.has(id) ? [status] : [];
    });
    if (workflow.statuses.length + observed.length + additional.length > 40) {
      this.notice('JIRA_WORKFLOW_STATUS_LIMIT', `${projectKey} 워크플로의 이관·추가 상태는 모두 40개까지 설정할 수 있습니다.`, 'error');
      return;
    }
    const statuses = [...workflow.statuses];
    for (const status of observed) {
      statusIds.add(status.id);
      statuses.push({ ...status, color: '#668899' });
    }
    for (const { id, label, category } of additional) {
      const name = label.trim();
      if (!/^s_new_(?:[1-9]|[1-3][0-9]|40)$/.test(id) || !name || name.length > 40 ||
        !categories.includes(category) || statusIds.has(id)) {
        this.notice('JIRA_WORKFLOW_ADDITIONAL_STATUS_INVALID', `${projectKey} 워크플로에 추가할 상태의 이름·분류와 ID 중복 여부를 확인해 주세요.`, 'error');
        return;
      }
      statusIds.add(id);
      statuses.push({ id, label: name, category, color: '#668899' });
    }
    if (!statusIds.has(review.initialStatusId)) {
      this.notice('JIRA_WORKFLOW_INITIAL_STATUS_INVALID', `${projectKey}의 시작 상태는 이관되는 업무의 상태 또는 직접 추가한 상태 중에서 선택해 주세요.`, 'error');
      return;
    }
    const pairs = new Set<string>();
    const transitions: ProjectWorkflow['transitions'] = [];
    for (const { from, to } of review.transitions) {
      const key = `${from}:${to}`;
      if (from === to || !statusIds.has(from) || !statusIds.has(to) || pairs.has(key)) {
        this.notice('JIRA_WORKFLOW_TRANSITION_INVALID', `${projectKey}의 허용 전이에서 출발·도착 상태와 중복 여부를 확인해 주세요.`, 'error');
        return;
      }
      pairs.add(key);
      transitions.push({ from, to, issueTypes: [], requiredFields: [] });
    }
    workflow.statuses = statuses;
    workflow.initialStatusId = review.initialStatusId;
    workflow.transitions = transitions;
    const reviews = this.result.preview.jiraWorkflows ??= [];
    reviews.push({ projectKey, initialStatusId: workflow.initialStatusId,
      statuses: statuses.map(({ id, label, category }) => ({ id, label, category })),
      transitions: transitions.map(({ from, to }) => ({ from, to })) });
    this.notice('JIRA_WORKFLOW_REVIEW_REQUIRED', '검토한 시작 상태와 허용 전이를 적용합니다. Jira의 유형별 전이 조건·검증기·후처리는 별도 검토가 필요합니다.', 'warning', undefined, true);
  }
  private createJiraComponentFields(): void {
    const catalogs = new Map<ProjectIssueSchema, Map<string, {
      instance: string; label: string; description: string; choices: { id: string; name: string; scope: string }[];
    }>>();
    const numericOwners = new Map<string, string>();
    for (const entry of this.entries) {
      const { pkg, row } = entry;
      if (pkg.dataset.source.product !== 'jira' || row.kind !== 'option' || row.containerId !== JIRA_COMPONENTS_FIELD_ID ||
          this.jiraComponentOptionExcluded(entry)) continue;
      const option = this.fieldOptions.get(pkg.summary.id)?.get(JIRA_COMPONENTS_FIELD_ID);
      const definition = this.sourceEntry(entry, 'field', JIRA_COMPONENTS_FIELD_ID);
      if (!option || !definition || this.skip(definition) || this.configuration.fields[option.id] !== 'multi_select') continue;
      const rawId = string(row.metadata.originalId);
      if (!rawId) continue;
      const instance = pkg.dataset.source.instanceKey;
      const fieldId = importedCustomFieldId(pkg.dataset.source, JIRA_COMPONENTS_FIELD_ID);
      for (const reference of row.references) {
        if (reference.kind !== 'project' || reference.relation !== 'project') continue;
        const project = this.projectsByContainer.get(optionId(pkg.summary.id, 'container', reference.sourceId));
        const schema = project && this.schemas.get(project.id);
        if (!schema) continue;
        const source = this.sourceEntry(entry, 'project', reference.sourceId)?.row;
        const scope = string(source?.metadata.key || source?.metadata.pkey) || source?.title || reference.sourceId;
        const identity = string(source?.metadata.id) || reference.sourceId;
        if (/^[1-9]\d*$/.test(identity)) {
          const key = JSON.stringify([instance, rawId]);
          const previous = numericOwners.get(key);
          if (previous && previous !== identity) {
            this.notice('JIRA_COMPONENT_OWNER_CONFLICT', '같은 Jira 컴포넌트 ID의 원본 프로젝트가 패키지마다 다릅니다. 원본을 다시 확인하거나 값을 보관해 주세요.', 'error', entry);
            continue;
          }
          numericOwners.set(key, identity);
        }
        let projectCatalogs = catalogs.get(schema);
        if (!projectCatalogs) catalogs.set(schema, projectCatalogs = new Map());
        let catalog = projectCatalogs.get(fieldId);
        if (!catalog) projectCatalogs.set(fieldId, catalog = {
          instance, label: option.label, description: definition.row.text.slice(0, 20000), choices: [],
        });
        catalog.choices.push({ id: importedCustomFieldOptionId(fieldId, rawId), name: row.title, scope });
      }
    }
    for (const [schema, grouped] of catalogs) {
      for (const [id, { instance, label, description, choices }] of grouped) {
        const name = grouped.size === 1 ? label : `${label} · ${instance.slice(0, 70).toWellFormed()} · ${id.slice(-8)}`;
        schema.fields.push({ id, name, description, kind: 'multi_select', required: false, issueTypes: [],
          options: buildJiraComponentOptions(choices), archived: false });
      }
    }
  }

  private jiraComponentOptionExcluded(entry: Entry): boolean {
    return this.skip(entry) || entry.row.references.some(ref => {
      if (ref.kind !== 'option' || ref.relation !== 'sourceDefinition') return false;
      const definition = this.sourceEntry(entry, 'option', ref.sourceId);
      return Boolean(definition && this.skip(definition));
    });
  }

  private jiraComponentMembershipExcluded(issue: Entry, sourceId: string): boolean {
    return issue.row.references.some(ref => {
      if (ref.kind !== 'relation' || ref.relation !== 'jiraComponentMembership') return false;
      const membership = this.sourceEntry(issue, 'relation', ref.sourceId);
      return Boolean(membership && this.skip(membership) && membership.row.references.some(target =>
        target.kind === 'option' && target.relation === 'target' && target.sourceId === `${JIRA_RAW_COMPONENTS_FIELD_ID}:${sourceId}`));
    });
  }

  private mapNewIssueFields(entry: Entry, issue: Issue, schema: ProjectIssueSchema): void {
    for (const option of this.jiraCustomSourceOptions(entry)) {
      const source = this.sourceEntry(entry, 'field', option.sourceValue);
      if (!source) continue;
      const kind = this.configuration.fields[option.id];
      if (!kind || kind === 'archive' || option.requiredKind && this.skip(source)) {
        this.noticeArchivedCustomField(entry, option);
        continue;
      }
      const fieldId = importedCustomFieldId(entry.pkg.dataset.source, option.sourceValue);
      let definition = schema.fields.find(field => field.id === fieldId);
      if (definition && definition.kind !== kind) {
        this.notice('FIELD_MAPPING_CONFLICT', '같은 원본 필드를 다른 자료형으로 매핑했습니다.', 'error', entry);
        continue;
      }
      if (!definition) {
        if (option.sourceValue === JIRA_COMPONENTS_FIELD_ID) {
          this.notice('JIRA_COMPONENT_CATALOG_MISSING', '이 업무의 Jira 컴포넌트 선택지를 확인할 수 없습니다. 적용할 원본 범위와 제외 항목을 확인해 주세요.', 'error', entry);
          continue;
        }
        definition = { id: fieldId, name: option.label, description: source.row.text.slice(0, 20000), kind,
          required: false, issueTypes: [], options: [], archived: false };
        if (kind === 'select' || kind === 'multi_select') {
          definition.options = (this.sourceOptions.get(entry.pkg.summary.id)?.get(option.sourceValue) ?? []).map(row => ({
            id: importedCustomFieldOptionId(fieldId, string(row.metadata.originalId) || row.sourceId), name: row.title,
            archived: ['Y', 'true', '1'].includes(string(row.metadata.disabled)),
          }));
        }
        schema.fields.push(definition);
      }
      issue.customFields![fieldId] = this.convertField(entry, option.sourceValue, definition, jiraCustomRawField(entry.row, option.sourceValue));
    }
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
      const projection = option.requiredKind && this.sourceEntry(entry, 'field', option.sourceValue);
      if (fieldId === null || fieldId === undefined && (option.projectedDate || option.requiredKind) || projection && this.skip(projection)) {
        this.noticeArchivedCustomField(entry, option);
        continue;
      }
      const field = schema.fields.find(value => value.id === fieldId);
      if (!field || field.archived || !fieldApplies(field, issue.type)) {
        this.notice('APPEND_FIELD_REQUIRED', `원본 필드 '${option.label}'를 적용할 활성 필드를 선택하거나 원문에 보관해 주세요.`, 'error', entry);
        continue;
      }
      if (option.requiredKind && field.kind !== option.requiredKind) {
        this.noticeRequiredFieldKind(option, entry);
        continue;
      }
      if (Object.hasOwn(issue.customFields!, field.id)) {
        this.notice('APPEND_FIELD_AMBIGUOUS', `같은 업무의 여러 원본 필드가 '${field.name}'에 연결되어 있습니다.`, 'error', entry);
        continue;
      }
      issue.customFields![field.id] = this.convertField(entry, option.sourceValue, field, raw);
    }
  }
  private noticeRequiredFieldKind(option: MigrationOptions['fields'][number], entry?: Entry) {
    if (option.sourceValue === JIRA_COMPONENTS_FIELD_ID) {
      this.notice('JIRA_COMPONENT_FIELD_KIND', 'Jira 컴포넌트는 여러 선택 필드로 이관하거나 원본에 보관해 주세요.', 'error', entry);
    } else {
      this.notice('JIRA_LABEL_FIELD_KIND', 'Jira 사용자 정의 라벨은 여러 선택 필드로 이관하거나 원본에 보관해 주세요.', 'error', entry);
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
  private jiraPriorityValue(entry: Entry, previous?: MigrationJiraRefreshCandidate['previous']): Issue['priority'] | null | undefined {
    const row = previous?.archive.record ?? entry.row;
    if (row.metadata.jiraPriorityAmbiguous === true) return null;
    const raw = scalar(sourceField(row, 'priority'));
    if (raw === undefined || raw === null || raw === '') return;
    const value = object(raw);
    const label = string(value.name || value.text);
    if (label) return recognizedJiraPriority(label);
    const optionId = `builtin:priority:${string(value.id || raw)}`;
    if (previous) {
      const option = previous.priorityOption?.sourceId === optionId ? previous.priorityOption : undefined;
      return option?.ambiguous ? null : recognizedJiraPriority(option?.title || string(raw));
    }
    const boundOption = row.references.some(ref => ref.kind === 'option' && ref.relation === 'priority' && ref.sourceId === optionId);
    const option = boundOption ? this.sourceEntry(entry, 'option', optionId) : undefined;
    if (option?.row.metadata.jiraPriorityAmbiguous === true || option && this.excluded.has(option.key)) return null;
    return recognizedJiraPriority(option?.row.title || string(raw));
  }
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
      const optionEntry = this.sourceEntry(entry, 'option', direct?.containerId === sourceId ? id : `${sourceId}:${id}`);
      const original = optionEntry?.row;
      const label = string(objectValue.value || objectValue.name) || original?.title || id;
      const optionId = importedCustomFieldOptionId(definition.id, id);
      if (refresh?.originalMapping === 'generated') return optionId;
      const jiraComponent = sourceId === JIRA_COMPONENTS_FIELD_ID;
      if (jiraComponent && !refresh?.originalMapping && (!optionEntry ||
          this.jiraComponentOptionExcluded(optionEntry) || this.jiraComponentMembershipExcluded(entry, id))) return bad();
      if (this.input.append) {
        const keyed = definition.options.filter(option => option.id === id || option.id === optionId);
        const matches = keyed.length || refresh?.originalMapping === 'existing' ? keyed : definition.options.filter(option =>
          option.name === label && (!jiraComponent || !/^o_[a-f0-9]{24}$/.test(option.id)));
        if (matches.length !== 1) return bad();
        const { archived, id: matchedId } = matches[0];
        if (archived && !refresh?.originalMapping) {
          const previous = refresh?.previousValue;
          if (Array.isArray(previous) ? !previous.includes(matchedId) : previous !== matchedId) return bad();
        }
        return matches[0].id;
      }
      if (jiraComponent) return definition.options.some(option => option.id === optionId) ? optionId : bad();
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
        'Donefac에서 따로 추가한 최신 파일을 유지하고 새 원본 버전은 첨부 이력에 보관합니다.', 'info', item.entry);
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
  private confluencePropertyReportProject(entry: Entry, spaceKey: string | null, projectId?: string | null): string | null {
    const projected = this.confluenceChildListProject(entry, spaceKey, projectId);
    if (spaceKey === null || !this.sourceLabelListScope(entry)) return projected;
    const instanceKey = entry.pkg.dataset.source.instanceKey;
    const origin = this.originIdentity(entry);
    const retained = (this.input.retainedConfluencePropertyScopes ?? []).filter(scope =>
      scope.instanceKey === instanceKey && scope.spaceKey === spaceKey && (!origin || !scope.origin || origin === scope.origin));
    if (!retained.length) return projected;
    const staged = this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? []);
    if (staged.some(candidate => this.excluded.has(candidate.key) ||
      string(candidate.row.metadata.spaceType).toLowerCase() === 'personal') || retained.some(scope => !scope.isolated)) return null;
    const sourceIds = new Set([...staged.map(candidate => candidate.row.sourceId), ...retained.map(scope => scope.spaceId)]);
    const origins = new Set([...staged.map(candidate => this.originIdentity(candidate)), ...retained.map(scope => scope.origin)].filter(Boolean));
    const projects = new Set([...retained.map(scope => scope.projectId), ...(projected ? [projected] : [])]);
    if (sourceIds.size !== 1 || origins.size > 1 || projects.size !== 1) return null;
    return [...projects][0];
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
  private confluencePage(entry: Entry, { sourceId, title, spaceKey }: MigrationPageIdentity, verifiedOrigin?: string): ResolvedConfluencePage | null {
    const append = this.input.appendPages;
    const atOrigin = (candidate: Entry) => verifiedOrigin === undefined || this.originIdentity(candidate) === verifiedOrigin;
    let candidates = this.confluenceCandidates(entry, 'page', sourceId, title).filter(atOrigin);
    let spaceId: string | null = null;
    if (spaceKey || !sourceId || append) {
      let spaceOrigin: string | undefined;
      if (spaceKey) {
        const spaces = this.inConfluenceSource(entry, this.confluenceSpacesByKey.get(spaceKey) ?? []).filter(atOrigin);
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
    if (this.restrictedSourcePages.has(id) || candidates.some(candidate => this.restricted(candidate))) return null;
    const imported = candidates.filter(candidate => this.bindings.get(candidate.key)?.type === 'document');
    if (imported.length === 1) return { sourceId: id, entry: imported[0], reference: this.resolvedReference(imported[0]) };
    if (imported.length || candidates.some(candidate => this.excluded.has(candidate.key))) return null;
    const known = this.originalPage(id);
    return known ? { sourceId: id, reference: { id: known.documentId, label: title || known.sourceTitle || known.sourceId } } : null;
  }
  private confluenceSectionProjection(entry: Entry, documentId: string): ReadonlyMap<string, string> {
    const cached = this.confluenceSectionProjections.get(entry);
    if (cached) return cached;
    const converted = convertLegacyContent(entry.row, {
      resolveReference: request => this.resolve(entry, request), sectionLinks: { documentId },
      confluenceOrigin: this.originBases.get(entry.pkg.summary.id),
    });
    const sections = converted.sectionTargets ?? new Map<string, string>();
    this.confluenceSectionProjections.set(entry, sections);
    return sections;
  }
  private confluenceSectionPage(entry: Entry, request: MigrationReferenceInput) {
    if (!request.url) return this.confluencePage(entry, request);
    const target = this.confluenceHrefTarget(entry, request.url);
    return target && !target.address.hasExtraQuery ? target.page : null;
  }
  private confluenceAbsoluteCandidates(address: ConfluenceMigrationPageAddress): Entry[] | null {
    const origin = `${address.origin}${address.contextPath}`;
    const atAddress = (candidate: Entry) => candidate.pkg.dataset.source.product === 'confluence'
      && this.originIdentity(candidate) === origin;
    const sourceKey = (candidate: Entry, sourceId: string) => JSON.stringify([candidate.pkg.dataset.source.instanceKey, sourceId]);
    const { sourceId, spaceKey, title } = address.identity;
    const indexKey = JSON.stringify(['page', sourceId ? 'id' : 'title', sourceId ?? title]);
    let candidates = (this.referenceIndex.get(indexKey) ?? []).filter(atAddress);
    if (spaceKey) {
      const spaces = (this.confluenceSpacesByKey.get(spaceKey) ?? []).filter(atAddress);
      const ids = new Set(spaces.map(space => sourceKey(space, space.row.sourceId)));
      if (ids.size > 1) return null;
      candidates = candidates.filter(candidate => ids.has(sourceKey(candidate, candidate.container)));
    }
    return candidates;
  }
  private confluenceAbsolutePage(address: ConfluenceMigrationPageAddress, candidates = this.confluenceAbsoluteCandidates(address)): ResolvedConfluencePage | null {
    if (!candidates) return null;
    const identities = new Set(candidates.map(candidate => JSON.stringify([candidate.pkg.dataset.source.instanceKey, candidate.row.sourceId])));
    if (identities.size !== 1 || candidates.some(candidate => this.restricted(candidate))) return null;
    const imported = candidates.filter(candidate => !this.excluded.has(candidate.key) && this.bindings.get(candidate.key)?.type === 'document');
    if (imported.length !== 1) return null;
    const [entry] = imported;
    return { sourceId: entry.row.sourceId, entry, reference: this.resolvedReference(entry) };
  }
  private confluenceHrefTarget(entry: Entry, url: string) {
    const base = entry.pkg.dataset.source.product === 'confluence' ? this.originBases.get(entry.pkg.summary.id) : undefined;
    const local = base && confluenceMigrationPageAddress(url, base);
    const address = local || confluenceMigrationPageAddress(url);
    if (!address) return null;
    const page = local
      ? this.confluencePage(entry, address.identity, `${address.origin}${address.contextPath}`)
      : this.confluenceAbsolutePage(address);
    return page ? { address, page } : null;
  }
  private confluencePageHref(entry: Entry, url: string, declaredSourceId?: string): ResolvedReference | null {
    const target = this.confluenceHrefTarget(entry, url);
    return target && (!declaredSourceId || target.page.sourceId === declaredSourceId) ? target.page.reference : null;
  }
  private jiraConfluenceHref(entry: Entry, href: string): string | undefined {
    const target = this.confluenceHrefTarget(entry, href);
    if (!target || target.address.hasExtraQuery) return;
    const { page, address: { fragment } } = target;
    const { id } = page.reference;
    if (!fragment) return `/#/all/documents/${encodeURIComponent(id)}`;
    const sectionId = this.confluencePageSectionId(page, fragment, true);
    return sectionId ? `/${documentSectionHash(id, sectionId)}` : undefined;
  }
  private confluencePageSectionId(target: ResolvedConfluencePage, fragment: string, fromUrl: boolean): string | undefined {
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
    } else return;
    const unique = new Set(matches);
    return unique.size === 1 ? [...unique][0] : undefined;
  }
  private confluenceSectionLinks(entry: Entry, documentId: string) {
    return {
      documentId,
      resolvePageSection: (request: MigrationReferenceInput, fragment: string, fromUrl: boolean) => {
        const target = this.confluenceSectionPage(entry, request);
        if (!target) return null;
        const sectionId = this.confluencePageSectionId(target, fragment, fromUrl);
        return sectionId ? { documentId: target.reference.id, sectionId } : null;
      },
    };
  }
  private explicitConfluenceAttachmentOwner(entry: Entry, request: MigrationReferenceInput, verifiedOrigin?: string): ResolvedConfluencePage | null {
    const owner = request.attachmentOwner;
    if (!owner) return null;
    const page = this.confluencePage(entry, owner, verifiedOrigin);
    if (request.exactAttachment && page && owner.sourceId && owner.title &&
        owner.title !== (page.entry?.row.title ?? this.originalPage(page.sourceId)?.sourceTitle)) return null;
    return page;
  }
  private confluenceAttachment(entry: Entry, request: MigrationReferenceInput): Entry | null {
    const { attachmentOwner, sourceId, title, attachmentVersion, exactAttachment } = request;
    if (attachmentOwner === null) return null;
    const downloadOrigin = request.url ? this.originIdentity(entry) : undefined;
    let candidates = this.confluenceCandidates(entry, 'attachment', sourceId, title);
    if (downloadOrigin) candidates = candidates.filter(candidate => this.originIdentity(candidate) === downloadOrigin);
    let ownerId: string | undefined;
    if (attachmentOwner || !sourceId || exactAttachment) {
      const owner = attachmentOwner ? this.explicitConfluenceAttachmentOwner(entry, request, downloadOrigin)?.entry : this.ownerEntry(entry);
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
      if (!version || ownerId && version.resourceId !== ownerId) return false;
      if (exactAttachment && version.filename !== title) return false;
      if (exactAttachment && entry.row.kind === 'revision' && (!sourceId || this.attachmentRoot(candidate) === candidate)) return false;
      if (attachmentVersion !== undefined) return confluenceAttachmentRevision(candidate.row) === attachmentVersion;
      if (request.url && this.attachmentRoot(candidate) !== candidate) return false;
      return sourceId || version.attachmentId === version.id;
    });
    return imported.length === 1 ? imported[0] : null;
  }
  private boundConfluenceAttachmentPage(entry: Entry, request: MigrationReferenceInput): string | undefined {
    if (request.attachmentOwner) {
      const owner = this.explicitConfluenceAttachmentOwner(entry, request, request.url ? this.originIdentity(entry) : undefined);
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

  private boundConfluenceAttachmentRevision(entry: Entry, series: Iterable<ConfluenceAttachmentSeries>,
    title: string, revision: number): AttachmentVersion | null {
    const origin = this.originIdentity(entry);
    const matches = [...series].filter(line => line.entries.some(row => this.originIdentity(row) === origin && attachmentFilename(row.row) === title) ||
      line.known.some(file => file.filename === title));
    if (matches.length !== 1) return null;
    const [line] = matches;
    const present = this.localConfluenceAttachmentRows(entry, line.entries.filter(row =>
      this.originIdentity(row) === origin && confluenceAttachmentRevision(row.row) === revision));
    const known = line.known.filter(file => file.sourceRevision === revision);
    if (present.some(row => attachmentFilename(row.row) !== title) || known.some(file => file.filename !== title)) return null;
    if (present.length) return this.incomingAttachmentVersions(present);
    return this.uniquelyResolvedAttachment(known.map(file => file.version));
  }

  private lookupBoundConfluenceAttachment(entry: Entry, sourcePageId: string, request: MigrationReferenceInput): ResolvedReference | null {
    if (this.restrictedSourcePages.has(sourcePageId) || this.excludedConfluenceAttachmentPages.has(sourcePageId)) return null;
    const seriesForPage = this.confluenceAttachmentSeries.get(sourcePageId);
    if (!seriesForPage) return null;
    const { sourceId, title, attachmentVersion } = request;
    let version: AttachmentVersion | null;
    if (attachmentVersion !== undefined && title) {
      version = this.boundConfluenceAttachmentRevision(entry, seriesForPage.values(), title, attachmentVersion);
    } else if (sourceId) {
      const lines = [...seriesForPage.values()].filter(series => series.entries.some(row => row.row.sourceId === sourceId) ||
        series.known.some(file => file.sourceId === sourceId));
      if (lines.length !== 1) return null;
      const [series] = lines;
      if (request.exactAttachment && entry.row.kind === 'revision' && sourceId === series.sourceRootId) return null;
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
      const downloadOrigin = request.url ? this.originIdentity(entry) : undefined;
      for (const series of seriesForPage.values()) {
        const roots = series.entries.filter(row => row.row.sourceId === series.sourceRootId && !row.row.metadata.currentVersionId &&
          (!downloadOrigin || this.originIdentity(row) === downloadOrigin));
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

    if (!version || request.exactAttachment && version.filename !== title) return null;
    if (!this.attachmentVersionsById.has(version.id)) this.borrowedAttachmentVersions.set(version.id, version);
    return attachmentReference(version, title || version.filename);
  }

  private resolvedReference(candidate: Entry): ResolvedReference {
    const binding = this.bindings.get(candidate.key)!;
    if (binding.type !== 'attachment') return { id: binding.id, label: candidate.row.title };
    const version = this.attachmentVersionsById.get(binding.id);
    return version ? attachmentReference(version, candidate.row.title) : { id: binding.id, label: candidate.row.title, url: `/api/attachments/${binding.id}/content` };
  }
  private jiraIssueHref(entry: Entry, href: string, sourceId?: string): ResolvedReference | null {
    const address = jiraMigrationIssueAddress(href);
    if (!address || (sourceId && sourceId.toUpperCase() !== address.issueKey)) return null;
    const locator = JSON.stringify([address.origin, address.contextPath, address.issueKey]);
    const candidates = this.jiraIssuesByAddress.get(locator) ?? [];
    if (candidates.some(candidate => this.excluded.has(candidate.key) || this.restricted(candidate))) return null;
    const identities = new Set(candidates.map(candidate => JSON.stringify([candidate.pkg.dataset.source.instanceKey, candidate.row.sourceId])));
    if (identities.size > 1) return null;
    const imported = new Map<string, Entry>();
    for (const candidate of candidates) {
      const binding = this.bindings.get(candidate.key);
      if (binding?.type === 'issue') imported.set(binding.id, candidate);
    }
    if (imported.size > 1) return null;
    const current = imported.values().next().value;
    const append = this.input.append;
    if (!append || this.originIdentity(entry) !== `${address.origin}${address.contextPath}`) {
      return current ? this.resolvedReference(current) : null;
    }
    const known = this.retainedIssuesByJiraKey.get(address.issueKey);
    if (known === null || (known && known.projectId !== append.project.id)) return null;
    if (current) return !known || this.bindings.get(current.key)?.id === known.issueId ? this.resolvedReference(current) : null;
    const retained = candidates[0];
    if (retained && !this.retainedEntries.has(retained.key)) return null;
    const byId = retained ? this.originalIssue(retained.row.sourceId) : undefined;
    if (byId && known && byId.id !== known.issueId) return null;
    const issueId = byId?.id ?? known?.issueId;
    return issueId ? { id: issueId, label: address.issueKey } : null;
  }
  resolve(entry: Entry, request: MigrationReferenceInput): ResolvedReference | null {
    if (entry.row.kind === 'revision' && request.exactAttachment && !request.sourceId) return null;
    if (entry.row.kind === 'revision' && request.kind === 'attachment' && request.url &&
        request.attachmentOwner && request.attachmentVersion === undefined) return null;
    const scoped = this.isConfluenceStorageReference(entry, request);
    const pageHref = request.kind === 'page' ? request.url : undefined;
    const space = scoped || (pageHref && entry.pkg.dataset.source.product === 'confluence') ? this.confluenceSpace(entry) : null;
    const owner = request.kind === 'attachment' ? this.ownerEntry(entry)?.key : null;
    const key = JSON.stringify([entry.pkg.summary.id, scoped, space, owner, request]);
    if (this.resolutionCache.has(key)) return this.resolutionCache.get(key)!;
    let value: ResolvedReference | null;
    if (request.kind === 'issue' && request.url) value = this.jiraIssueHref(entry, request.url, request.sourceId);
    else if (pageHref) value = this.confluencePageHref(entry, pageHref, request.sourceId);
    else if (scoped && request.kind === 'page') value = this.confluencePage(entry, request)?.reference ?? null;
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
    return candidates.length===1?this.resolvedReference(candidates[0]):null;
  }
  private confluencePageContentContext(entry: Entry, documentId: string, projectId: string | undefined): MigrationContentContext {
    return {
      resolveReference: request => this.resolve(entry, request),
      confluenceOrigin: this.originBases.get(entry.pkg.summary.id),
      sectionLinks: this.confluenceSectionLinks(entry, documentId),
      resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, projectId),
      resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, projectId),
      resolvePropertyReportSpaceProject: space => this.confluencePropertyReportProject(entry, space, projectId),
    };
  }

  private indexConfluenceInlineComments(): void {
    for (const entry of this.entries) {
      if (entry.pkg.dataset.source.product !== 'confluence') continue;
      const pageId = confluenceInlineCommentPageId(entry.row);
      const page = pageId && this.sourceEntry(entry, 'page', pageId);
      if (!page) continue;
      const marker = entry.row.metadata.confluenceInlineMarkerRef as string;
      const claims = this.confluenceInlineClaims.get(page.key) ?? new Map<string, Entry | null>();
      claims.set(marker, claims.has(marker) ? null : entry);
      this.confluenceInlineClaims.set(page.key, claims);
    }
    if (!this.confluenceInlineClaims.size) return;
    for (const pkg of this.input.packages) for (const diagnostic of pkg.dataset.diagnostics) {
      if (diagnostic.severity === 'error' && diagnostic.recordId) this.confluenceInlineSourceErrors.add(pkg.summary.id + '/' + diagnostic.recordId);
    }
  }

  private rememberConfluenceInlineProjection(entry: Entry, converted: ReturnType<typeof convertLegacyContent>): void {
    if (!this.confluenceInlineClaims.has(entry.key)) return;
    const anchors = new Map<string, DocumentSourceSelection>();
    if (!converted.diagnostics.some(item => item.severity === 'error')) {
      for (const [marker, selection] of converted.inlineCommentAnchors ?? []) {
        if (this.confluenceInlineClaims.get(entry.key)?.get(marker) &&
            readDocumentSelection(converted.content, selection.from, selection.to) === selection.text) anchors.set(marker, selection);
      }
    }
    this.confluenceInlineProjections.set(entry.key, anchors.size ? { bodyHash: confluencePageFieldDigest('content', converted.content), anchors } : null);
  }

  private planConfluenceInlineComment(entry: Entry, documentId: string, commentId: string): void {
    const { row } = entry;
    const marker = row.metadata.confluenceInlineMarkerRef;
    if (entry.pkg.dataset.source.product !== 'confluence' || typeof marker !== 'string') return;
    const pageId = confluenceInlineCommentPageId(row);
    const page = pageId && this.sourceEntry(entry, 'page', pageId);
    const target = page ? this.bindings.get(page.key) : undefined;
    const existing = pageId ? this.originalPage(pageId) : undefined;
    if (page && (target?.type === 'document' && target.id === documentId || existing?.documentId === documentId) &&
        this.confluenceInlineClaims.get(page.key)?.get(marker) === entry && !this.excluded.has(page.key) &&
        !this.restrictedSourcePages.has(page.row.sourceId) && !this.restricted(page) && !this.restricted(entry) &&
        !this.confluenceInlineSourceErrors.has(entry.key) && !this.confluenceInlineSourceErrors.has(page.key) &&
        hasConfluenceBody(page.row) && ['', 'current'].includes(string(page.row.metadata.contentStatus).trim().toLowerCase())) {
      if (!this.confluenceInlineProjections.has(page.key) && existing) {
        const context = this.confluencePageContentContext(page, documentId, existing.projectId ?? undefined);
        this.rememberConfluenceInlineProjection(page, convertLegacyContent(page.row, { ...context, captureInlineCommentAnchors: true }));
      }
      const projection = this.confluenceInlineProjections.get(page.key);
      const selection = projection?.anchors.get(marker);
      const plannedBodyHash = existing ? this.confluenceInlineRefreshedBodyHashes.get(documentId) ??
        this.input.appendPages?.inlineCommentBodyHashes?.[documentId] : projection?.bodyHash;
      if (projection && selection && projection.bodyHash === plannedBodyHash) {
        (this.result.confluenceCommentAnchors ??= []).push({ commentId, bodyHash: projection.bodyHash, selection });
        this.result.preview.counts.confluenceInlineCommentsAnchored = this.result.confluenceCommentAnchors.length;
        return;
      }
    }
    this.result.preview.counts.confluenceInlineCommentsUnresolved = (this.result.preview.counts.confluenceInlineCommentsUnresolved ?? 0) + 1;
    this.notice('CONFLUENCE_INLINE_COMMENT_ANCHOR_UNRESOLVED', '현재 문서의 정확한 원문 위치를 확인할 수 없어 댓글을 문서 댓글로 옮깁니다.', 'warning', entry, true);
  }

  private planConfluenceCommentReplies(): void {
    const planned = new Map(this.result.comments.filter(comment => comment.resourceType === 'document').map(comment => [comment.id, comment]));
    if (!planned.size) return;
    const anchored = new Set(this.result.confluenceCommentAnchors?.map(({ commentId }) => commentId));
    const known = new Map(this.input.appendPages?.knownInlineCommentRoots?.map(root => [root.sourceId, root]));
    const counts = this.result.preview.counts;
    for (const entry of this.entries) {
      const { row } = entry;
      if (row.kind !== 'comment' || entry.pkg.dataset.source.product !== 'confluence') continue;
      const parentSourceId = row.metadata.confluenceParentCommentSourceId;
      if (typeof parentSourceId !== 'string' && row.metadata.confluenceCommentParentUnresolved !== true) continue;
      const binding = this.bindings.get(entry.key);
      const reply = binding?.type === 'comment' ? planned.get(binding.id) : undefined;
      if (!reply) continue;

      const pageSourceId = row.metadata.confluenceCommentPageSourceId;
      let parentId: string | undefined;
      if (typeof parentSourceId === 'string' && typeof pageSourceId === 'string') {
        const parent = this.sourceEntry(entry, 'comment', parentSourceId);
        const sourceIsRoot = !parent || parent.row.metadata.confluenceCommentPageSourceId === pageSourceId &&
          !parent.row.parentId && !parent.row.metadata.confluenceParentCommentSourceId &&
          parent.row.metadata.confluenceCommentParentUnresolved !== true && !this.excluded.has(parent.key) && !this.restricted(parent);
        if (sourceIsRoot) {
          const parentBinding = parent && this.bindings.get(parent.key);
          if (parentBinding?.type === 'comment') {
            const candidate = planned.get(parentBinding.id);
            if (candidate?.resourceId === reply.resourceId && anchored.has(candidate.id)) parentId = candidate.id;
          } else {
            const previous = known.get(parentSourceId);
            if (previous?.sourcePageId === pageSourceId && previous.documentId === reply.resourceId) parentId = previous.commentId;
          }
        }
      }
      if (parentId) {
        reply.parentCommentId = parentId;
        counts.confluenceInlineRepliesLinked = (counts.confluenceInlineRepliesLinked ?? 0) + 1;
      } else {
        counts.confluenceInlineRepliesUnresolved = (counts.confluenceInlineRepliesUnresolved ?? 0) + 1;
        this.notice('CONFLUENCE_COMMENT_REPLY_UNRESOLVED', '같은 문서에서 원문이 확인된 상위 문장 댓글을 찾을 수 없어 일반 댓글로 옮깁니다.', 'warning', entry, true);
      }
    }
  }

  converted(entry: Entry, { legacyAnnotations = false, documentId }: { legacyAnnotations?: boolean; documentId?: string } = {}) {
    const result = convertLegacyContent(entry.row, {
      resolveReference: request => this.resolve(entry, request), legacyAnnotations,
      confluenceOrigin: entry.pkg.dataset.source.product === 'confluence' ? this.originBases.get(entry.pkg.summary.id) : undefined,
      sectionLinks: documentId && entry.pkg.dataset.source.product === 'confluence' ? this.confluenceSectionLinks(entry, documentId) : undefined,
      resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, this.project(entry)?.id),
      resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, this.project(entry)?.id),
      resolvePropertyReportSpaceProject: space => this.confluencePropertyReportProject(entry, space, this.project(entry)?.id),
      captureInlineCommentAnchors: Boolean(documentId && this.confluenceInlineClaims.has(entry.key)),
    });
    if (documentId) this.rememberConfluenceInlineProjection(entry, result);
    for (const diagnostic of result.diagnostics) this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
    return result;
  }

  private projectJiraComment(entry: Entry) {
    const row = entry.row;
    const options = { resolveReference: (request: MigrationReferenceInput) => this.resolve(entry, request), legacyAnnotations: true };
    const rendered = row.textFormat === 'plain' && row.metadata.bodyFormat === 'search-rendered-html' && /<a(?=\s)[^<>]*?\shref\s*=/iu.test(row.text);
    // Rendered search XML was previously stored as plain text. Keep its original limit calculation.
    if (rendered && row.text.replace(/\r\n?/gu, '\n').length > 20_000) return convertLegacyContent(row, options);
    const source = rendered ? { ...row, textFormat: 'confluence-storage' as const } : row;
    const projected = convertLegacyContent(source, { ...options, preserveCommentWebLinks: true });
    const unsupported = projected.diagnostics.some(item => item.severity === 'error' || item.code === 'RAW_CONTENT_FALLBACK' ||
      (rendered && item.code === 'UNSUPPORTED_CONTENT'));
    if (projected.plainText.length <= 20_000 && !unsupported) {
      return projected;
    }
    const previous = convertLegacyContent(row, options);
    if (previous.plainText.trim() && previous.plainText.length <= 20_000 &&
        !previous.diagnostics.some(item => item.severity === 'error' || item.code === 'RAW_CONTENT_FALLBACK')) {
      this.notice('JIRA_COMMENT_LINKS_ARCHIVED', '댓글 링크를 안전하게 표시할 수 없거나 본문 한도를 초과해 기존 표시 본문을 사용합니다. 원래 링크는 원본 보관함에 남습니다.', 'warning', entry, true);
    }
    return previous;
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
  private epicParentBinding(entry: Entry, projectId: string, archivedAliases: ReadonlyMap<string, string>,
    sourceErrors: ReadonlySet<string>): Binding | undefined {
    const aliases = jiraParentEvidence(entry.row);
    if (!aliases || sourceErrors.has(entry.key)) return;
    if (this.input.append) {
      const id = this.jiraRefreshParent(entry, aliases, archivedAliases, sourceErrors);
      if (id) return { type: 'issue', id, projectId };
      return;
    }
    const targets = new Map<string, Binding>();
    for (const alias of aliases) {
      const matches = this.referenceIndex.get(JSON.stringify(['issue', 'id', alias])) ?? [];
      for (const candidate of matches) {
        if (candidate.pkg.dataset.source.instanceKey !== entry.pkg.dataset.source.instanceKey) continue;
        const binding = this.bindings.get(candidate.key);
        if (candidate.container !== entry.container || this.restricted(candidate) || sourceErrors.has(candidate.key) ||
            !binding || binding.type !== 'issue' || binding.projectId !== projectId) return;
        targets.set(binding.id, binding);
      }
    }
    if (targets.size === 1) return targets.values().next().value;
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
        if (entry.pkg.dataset.source.product === 'confluence' && usableConfluenceBody(converted)) {
          const sourceHash = confluencePageBodySourceHash(entry.row);
          if (sourceHash) this.confluenceBodySourceHashes.set(entry.key, sourceHash);
        }
      }
    }
    const archivedHierarchy = new Map(this.input.append?.hierarchyIssueAliases?.map(({ alias, issueId }) => [alias, issueId]));
    const hierarchyErrors = this.jiraHierarchySourceErrors();
    for (const entry of this.entries) {
      if (this.skip(entry) || !['issue', 'page'].includes(entry.row.kind)) continue;
      const binding = this.bindings.get(entry.key);
      const { parentId } = entry.row;
      if (!binding || !parentId) continue;
      const epic = binding.type === 'issue' && entry.row.metadata.jiraEpicParentObserved === true;
      const parent = epic && binding.projectId ? this.epicParentBinding(entry, binding.projectId, archivedHierarchy, hierarchyErrors)
        : this.parentBinding(entry, parentId);
      if (!parent || parent.type !== binding.type) {
        this.notice(epic ? 'JIRA_EPIC_PARENT_UNAVAILABLE' : 'PARENT_NOT_IMPORTED', epic
          ? '같은 Jira 프로젝트에서 에픽을 확인할 수 없어 업무를 최상위로 배치합니다. 원래 에픽 연결은 보관합니다.'
          : '원본 상위 항목이 적용 대상에 없어 현재 항목은 최상위로 배치합니다. 원래 계층은 보관합니다.', 'warning', entry, true);
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
  private createConfluenceDocumentOrders(): void {
    const groups = new Map<string, DocPage[]>();
    for (const document of this.result.documents) {
      const key = JSON.stringify([document.projectId, document.parentId]);
      const group = groups.get(key);
      if (group) group.push(document);
      else groups.set(key, [document]);
    }
    const existingMoveTargets = new Set((this.result.documentUpdates ?? []).map(update => update.changes.parentId));
    const orders: NonNullable<PreparedMigration['documentOrders']> = [];
    let unresolved = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const entries = group.map(document => this.primaryById.get(document.id)!);
      const positions = entries.map(({ row }) => confluencePositionEvidence(row));
      if (positions.every(position => position === null)) continue;

      const [{ projectId, parentId }] = group;
      const [first] = entries;
      const sourceSpace = first.row.containerId;
      const sourceInstance = first.pkg.dataset.source.instanceKey;
      const parent = parentId ? this.primaryById.get(parentId) : undefined;
      const sourceParent = parent?.row.sourceId ?? null;
      const sameSourceSpace = ({ pkg, row }: Entry) => pkg.dataset.source.product === 'confluence' &&
        pkg.dataset.source.format === 'confluence-xml' && pkg.dataset.source.instanceKey === sourceInstance &&
        row.kind === 'page' && row.metadata.sourceClass === 'Page' && row.containerId === sourceSpace;
      const positioned = group.flatMap(({ id }, index) => typeof positions[index] === 'number' ? [{ id, position: positions[index] }] : []);
      if (!projectId || !sourceSpace || (this.input.appendPages && !parentId) || existingMoveTargets.has(parentId) ||
          (parentId && (!parent || !sameSourceSpace(parent))) || !this.uniqueConfluenceOrigin(parent ? [...entries, parent] : entries) ||
          entries.some(entry => !sameSourceSpace(entry) || confluenceParentEvidence(entry.row) !== sourceParent) ||
          new Set(entries.map(entry => entry.row.sourceId)).size !== group.length || positioned.length !== group.length ||
          new Set(positioned.map(({ position }) => position)).size !== group.length) {
        unresolved++;
        continue;
      }
      positioned.sort((left, right) => left.position - right.position);
      orders.push({ projectId, parentId, documentIds: positioned.map(({ id }) => id) });
    }
    if (orders.length) {
      this.result.documentOrders = orders;
      this.result.preview.counts.confluenceOrderedSiblingGroups = orders.length;
    }
    if (unresolved) {
      this.result.preview.counts.confluenceUnresolvedSiblingGroups = unresolved;
      this.notice('CONFLUENCE_SIBLING_ORDER_UNRESOLVED', `형제 문서 ${unresolved}개 그룹의 순서는 원본에 보관합니다. 원본 위치와 계층을 모두 확인할 수 없는 그룹과 기존 문서가 있는 그룹은 현재 배치 방식을 유지합니다.`);
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
        const jiraComment = owner.type === 'issue' && entry.pkg.dataset.source.product === 'jira' ? this.projectJiraComment(entry) : null;
        for (const diagnostic of jiraComment?.diagnostics ?? []) {
          this.notice(diagnostic.code, diagnostic.message, diagnostic.severity, entry, diagnostic.severity === 'warning');
        }
        const body = jiraComment?.plainText ?? this.converted(entry, { legacyAnnotations: true }).plainText;
        if (!body.trim() || body.length > 20000) this.notice('COMMENT_BODY_LIMIT', '댓글이 비어 있거나 현재20000자 제한을 넘습니다.', 'error', entry);
        if (!['plain', 'none'].includes(entry.row.textFormat)) {
          this.notice('COMMENT_FORMAT_PLAIN_TEXT', '댓글은 일반 텍스트로 변환하며 원래 서식과 작성자·변경 시각은 원본 보관함에 유지합니다.', 'warning', entry, true);
        }
        const id = randomUUID();
        this.result.comments.push({ id, resourceType: owner.type as 'issue' | 'document', resourceId: owner.id,
          authorId: this.author(entry), body, createdAt: this.time(entry.row.createdAt, entry)! });
        this.bindings.set(entry.key, { type: 'comment', id, projectId: owner.projectId });
        if (owner.type === 'document') this.planConfluenceInlineComment(entry, owner.id, id);
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
    if (request.url && request.attachmentOwner) return this.resolve(entry, request);
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
        confluenceOrigin: this.originBases.get(entry.pkg.summary.id),
        legacyAnnotations: version === null,
        resolveLabelListProject: space => this.confluenceLabelListProject(entry, space, owner.projectId),
        resolveChildListSpaceProject: space => this.confluenceChildListProject(entry, space, owner.projectId),
        resolvePropertyReportSpaceProject: space => this.confluencePropertyReportProject(entry, space, owner.projectId),
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
        this.planConfluenceInlineComment(entry, owner.documentId, id);
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
    const retained = this.input.retainedResourceLinks;
    const resourcePairs = new Set(retained?.existingPairs.map(pair => JSON.stringify(pair)));
    const issuePairs = new Set<string>();
    const resource = (issueId: string, documentId: string) => {
      const key = JSON.stringify([issueId, documentId]);
      if (resourcePairs.has(key)) return false;
      resourcePairs.add(key);
      this.result.resourceLinks.push({ id: randomUUID(), issueId, documentId, kind: 'related' });
      return true;
    };
    const remoteLinks = Map.groupBy(this.entries.filter(({ row, pkg }) => pkg.dataset.source.product === 'jira' &&
      row.kind === 'relation' && row.metadata.jiraRestRemoteLink === true), entry => this.jiraRemoteLinkIdentity(entry));
    const archivedLinks = Map.groupBy(retained?.links ?? [], link => JSON.stringify([link.instanceKey, link.sourceId]));
    const retainedOrigins = new Set(retained?.pages.map(page => page.origin));
    const retainedPages = new Map<string, RetainedResourcePage[]>();
    for (const page of retained?.pages ?? []) {
      const { origin, sourceId, sourceSpaceKey: spaceKey, sourceTitle: title } = page;
      const keys = [confluenceMigrationPageKey(origin, { sourceId })];
      if (spaceKey) keys.push(confluenceMigrationPageKey(origin, { spaceKey, title }));
      for (const key of keys) {
        const matches = retainedPages.get(key) ?? [];
        matches.push(page);
        retainedPages.set(key, matches);
      }
    }
    const blockedPageKeys = new Set(retained?.blockedPageKeys);
    const retainedPagesAt = (address: ConfluenceMigrationPageAddress | null) => {
      const origin = address ? address.origin + address.contextPath : '';
      const key = address ? confluenceMigrationPageKey(origin, address.identity) : '';
      return { pages: retainedPages.get(key) ?? [], hasOrigin: retainedOrigins.has(origin), ambiguous: blockedPageKeys.has(key) };
    };
    const projectNames = new Map(this.result.projects.map(project => [project.id, project.name]));
    const destination = this.input.append?.project ?? this.input.appendPages?.project;
    if (destination) projectNames.set(destination.id, destination.name);
    type Review = NonNullable<PreparedMigration['preview']['retainedResourceLinks']>[number];
    const reviews: Review[] = [];
    let retainedCount = 0;
    const addRetained = (issue: Pick<Issue, 'id' | 'projectId' | 'key' | 'title'> & {projectName?: string},
      document: Pick<DocPage, 'id' | 'projectId' | 'title'> & {projectName?: string}) => {
      if (!resource(issue.id, document.id)) return;
      retainedCount++;
      if (reviews.length < 50) reviews.push({ issueKey: issue.key, issueTitle: issue.title,
        issueProjectName: issue.projectName ?? projectNames.get(issue.projectId) ?? '', documentTitle: document.title,
        documentProjectName: document.projectName ?? (document.projectId ? projectNames.get(document.projectId) ?? '' : '팀 공통') });
    };
    for(const document of this.result.documents)for(const reference of contentReferences(document.content))if(reference.type==='issue')resource(reference.id,document.id);
    for(const entry of this.entries){if(this.excluded.has(entry.key))continue;const binding=this.bindings.get(entry.key);if(binding?.type==='document')for(const reference of entry.row.references.filter(reference=>reference.kind==='issue')){const target=this.resolve(entry,{kind:'issue',sourceId:reference.sourceId});if(target)resource(target.id,binding.id);}
      if(entry.row.kind!=='relation'||entry.row.metadata.jiraRelationConflict===true)continue;
      if (entry.pkg.dataset.source.product === 'jira' && entry.row.metadata.jiraRestRemoteLink === true) {
        const identity = this.jiraRemoteLinkIdentity(entry);
        const address = confluenceMigrationPageAddress(string(entry.row.metadata.url));
        const prior = archivedLinks.get(identity) ?? [];
        const unique = remoteLinks.get(identity)?.length === 1 && prior.every(link => !link.conflict && link.ownerSourceId === entry.row.containerId &&
          link.url === entry.row.metadata.url && (link.pageId ?? '') === string(entry.row.metadata.remotePageId));
        const pair = this.jiraRestResourceLink(entry, unique, address, retainedPagesAt(address));
        if (pair?.retained) {
          const issue = this.issueById.get(pair.issueId);
          if (issue) addRetained(issue, pair.retained);
        } else if (pair) resource(pair.issueId, pair.documentId);
        continue;
      }
      const issueRefs=entry.row.references.filter(reference=>reference.kind==='issue'),pageRefs=entry.row.references.filter(reference=>reference.kind==='page'),issueTargets=issueRefs.map(reference=>this.resolve(entry,{kind:'issue',sourceId:reference.sourceId}));
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
    let unresolved = 0;
    for (const [identity, records] of archivedLinks) {
      if (remoteLinks.has(identity)) continue;
      const link = records.find(record => record.issue);
      if (!link?.issue) continue;
      const address = confluenceMigrationPageAddress(link.url);
      if (!address || address.hasExtraQuery) continue;
      const candidates = this.confluenceAbsoluteCandidates(address);
      if (candidates?.length === 0) continue;
      const previousPages = retainedPagesAt(address);
      const exact = !previousPages.ambiguous && records.every(other => this.sameArchivedJiraRemoteLink(link, other));
      const page = exact ? this.confluenceAbsolutePage(address, candidates) : null;
      const document = page && (!link.pageId || page.sourceId === link.pageId) ? this.documentById.get(page.reference.id) : undefined;
      if (!document || previousPages.pages.some(previous => previous.document && previous.document.id !== document.id ||
          previous.instanceKey !== page?.entry?.pkg.dataset.source.instanceKey || previous.sourceId !== page?.sourceId)) {
        unresolved++;
        continue;
      }
      addRetained(link.issue, document);
    }
    if (unresolved) this.notice('RETAINED_DOCUMENT_ISSUE_LINK_UNRESOLVED', `이전에 이관한 Jira의 연결 ${unresolved}건은 이번 Confluence 페이지를 유일하게 확인할 수 없어 원본에 보관합니다.`, 'warning', undefined, true);
    if (retainedCount) {
      this.result.preview.counts.retainedResourceLinks = retainedCount;
      this.result.preview.retainedResourceLinks = reviews;
      this.notice('RETAINED_DOCUMENT_ISSUE_LINKS', `이번에 이관하는 항목과 기존 업무·문서 사이에 연결 ${retainedCount}건을 추가합니다.`, 'warning', undefined, true);
    }
    this.createJiraRelationRefresh();
    if (this.result.issueRelations.length) this.notice('ISSUE_RELATIONS_PRESERVED', '원본 업무 연결을 관계로 보존합니다. 같은 프로젝트의 차단 관계는 이관 후 티켓에서 일정 연결을 검토할 수 있습니다.', 'info');
  }
  private jiraRemoteLinkIdentity({ pkg, row }: Entry) {
    return JSON.stringify([pkg.dataset.source.instanceKey, row.sourceId]);
  }
  private sameArchivedJiraRemoteLink(link: RetainedJiraResourceLink, other: RetainedJiraResourceLink): boolean {
    return link.issue?.id === other.issue?.id && link.ownerSourceId === other.ownerSourceId && link.url === other.url && link.pageId === other.pageId;
  }
  private jiraRestResourceLink(entry: Entry, unique: boolean, address: ConfluenceMigrationPageAddress | null,
    { pages: retained, hasOrigin, ambiguous }: { pages: RetainedResourcePage[]; hasOrigin: boolean; ambiguous: boolean }):
    { issueId: string; documentId: string; retained?: NonNullable<RetainedResourcePage['document']> } | null {
    const { containerId, metadata, references } = entry.row;
    const pageId = string(metadata.remotePageId);
    const knownConfluenceOrigin = hasOrigin || ambiguous || address && this.input.packages.some(pkg => {
      const base = this.originBases.get(pkg.summary.id);
      return pkg.dataset.source.product === 'confluence' && base?.origin === address.origin && base.contextPath === address.contextPath;
    });
    if (!knownConfluenceOrigin && metadata.remoteApplicationType !== 'com.atlassian.confluence' && !pageId) return null;
    const owner = containerId && this.sourceEntry(entry, 'issue', containerId);
    const [source] = references;
    const binding = unique && owner && !this.excluded.has(owner.key) && !this.restricted(owner) && references.length === 1 &&
      source?.kind === 'issue' && source.relation === 'source' && source.sourceId === containerId ? this.bindings.get(owner.key) : undefined;
    if (binding?.type === 'issue' && address && !ambiguous && !address.hasExtraQuery && metadata.jiraRemoteLinkConflict !== true) {
      const candidates = this.confluenceAbsoluteCandidates(address);
      if (candidates?.length) {
        const page = this.confluenceAbsolutePage(address, candidates);
        if (page && (!pageId || page.sourceId === pageId) && retained.every(previous => previous.sourceId === page.sourceId &&
            previous.instanceKey === page.entry?.pkg.dataset.source.instanceKey && (!previous.document || previous.document.id === page.reference.id))) {
          return { issueId: binding.id, documentId: page.reference.id };
        }
      } else if (candidates && retained.length && this.issueById.has(binding.id)) {
        const chosen = retained[0];
        const spaceKey = address.identity.spaceKey;
        const conflictingSpace = spaceKey && (this.confluenceSpacesByKey.get(spaceKey) ?? []).some(space =>
          this.originIdentity(space) === chosen.origin &&
          (space.pkg.dataset.source.instanceKey !== chosen.instanceKey || space.row.sourceId !== chosen.sourceSpaceId));
        if (chosen.document && !conflictingSpace && (!pageId || chosen.sourceId === pageId) && retained.every(page => page.sourceId === chosen.sourceId &&
            page.instanceKey === chosen.instanceKey && page.document?.id === chosen.document?.id)) {
          return { issueId: binding.id, documentId: chosen.document.id, retained: chosen.document };
        }
      }
    }
    this.notice('DOCUMENT_ISSUE_LINK_UNRESOLVED', 'Jira 원격 연결의 업무 또는 Confluence 페이지 주소를 유일하게 확인하지 못해 원본에 보관합니다.', 'warning', entry, true);
    return null;
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
    const scope = this.jiraChildScope(append, context.provenAliases);
    const issueForAlias = (alias: string) => {
      const id = scope.resolveId(alias);
      return id && issues.has(id) ? id : undefined;
    };
    const pair = (source: string, target: string) => JSON.stringify([source, target]);
    const stored = new Set(context.active.filter(relation => relation.origin === undefined)
      .map(relation => JSON.stringify([relation.sourceIssueId, relation.targetIssueId, relation.type])));
    const liveImported = new Set(context.active.map(relation => relation.id));
    const native = new Set(context.active.filter(isDonefacIssueRelation)
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
      const source = issueForAlias(link.sourceAlias);
      const target = issueForAlias(link.targetAlias);
      if (source && target) remember(link, source, target, liveImported.has(relationId));
    }
    for (const record of context.legacy) {
      const link = jiraIssueRelationSource(record);
      if (!link) continue;
      const source = issueForAlias(link.storedSourceAlias);
      const target = issueForAlias(link.storedTargetAlias);
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
      if (!source || !target || source.id === target.id ||
          (source.projectId !== append.project.id && target.projectId !== append.project.id)) {
        skipped++;
        this.notice('JIRA_RELATION_SCOPE_UNRESOLVED', '선택한 원본 프로젝트와 연결된 양쪽 업무의 이관 기록을 확인할 수 없어 원본 관계를 보관합니다.', 'warning', entry, true);
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
      const source = issues.get(sourceId)!;
      const target = issues.get(targetId)!;
      this.jiraRelationProjectIds.add(source.projectId);
      this.jiraRelationProjectIds.add(target.projectId);
      added++;
      if (stable) knownIds.add(stable);
      remember(link, sourceId, targetId, true);
      if (preview.length < 20) preview.push({ recordId: entry.key, sourceKey: source.key, targetKey: target.key, type: link.typeName,
        ...(source.projectId === target.projectId ? {} : { sourceProjectName: source.projectName, targetProjectName: target.projectName }) });
    }
    if (preview.length) this.result.preview.jiraRelationRefresh = preview;
    if (skipped) this.notice('JIRA_RELATIONS_RETAINED', '이미 처리한 관계와 현재 연결은 유지합니다. 확인이 필요한 링크는 원본 기록에서 검토할 수 있습니다.', 'info');
    Object.assign(this.result.preview.counts, { newJiraRelations: added, skippedJiraRelations: skipped });
  }
  validateGraph():void{
    const cyclic=(rows:{id:string;parentId:string|null}[], appended:boolean)=>{const incoming=new Map(rows.map(row=>[row.id,0])),children=new Map<string,string[]>();for(const row of rows)if(row.parentId&&(!appended||incoming.has(row.parentId))){incoming.set(row.id,(incoming.get(row.id)||0)+1);const values=children.get(row.parentId)||[];values.push(row.id);children.set(row.parentId,values);}const queue=[...incoming].filter(([,count])=>!count).map(([id])=>id);for(let cursor=0;cursor<queue.length;cursor++)for(const child of children.get(queue[cursor])||[]){const count=incoming.get(child)!-1;incoming.set(child,count);if(!count)queue.push(child);}return queue.length!==rows.length;};
    const issueMoves = this.result.issueUpdates?.filter(update => update.changes.parentId !== undefined) ?? [];
    const hierarchy = new Map((issueMoves.length ? [...this.jiraHierarchyIssues.values()] : [])
      .map(({ id, parentId }) => [id, { id, parentId }]));
    for (const issue of this.result.issues) hierarchy.set(issue.id, issue);
    for (const { issueId, changes } of issueMoves) hierarchy.set(issueId, { id: issueId, parentId: changes.parentId ?? null });
    if(cyclic([...hierarchy.values()], Boolean(this.input.append)))this.notice('ISSUE_PARENT_CYCLE','이관할 업무 계층에 순환 관계가 있습니다.','error');if(cyclic(this.result.documents, Boolean(this.input.appendPages)))this.notice('DOCUMENT_PARENT_CYCLE','이관할 문서 계층에 순환 관계가 있습니다.','error');
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
    for (const schema of this.result.issueSchemas) {
      if (new Set(schema.fields.map(field => field.name.trim())).size !== schema.fields.length) {
        this.notice('FIELD_NAME_CONFLICT', '대상 프로젝트의 필드 이름이 중복됩니다. 원본 필드 매핑을 확인해 주세요.', 'error');
      }
      for (const field of schema.fields) {
        if (field.kind !== 'select' && field.kind !== 'multi_select') continue;
        if (!field.options.some(option => !option.archived) || field.options.length > 200 ||
            field.options.some(option => !option.name.trim() || option.name.length > 120) ||
            new Set(field.options.map(option => option.name)).size !== field.options.length) {
          this.notice('FIELD_OPTIONS_INVALID', `선택형 필드 '${field.name}'의 활성 선택지·이름·개수 제한을 확인해 주세요.`, 'error');
        }
      }
    }
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
    issues: ReadonlyMap<string, T>, { durable, resolveId, blocked, sourceErrors }: JiraChildScope): T | undefined {
    if (sourceErrors.has(entry.key) || this.restricted(entry)) return undefined;
    if (!aliases) return undefined;
    const [ownerId, ...others] = aliases.map(resolveId);
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
  private jiraChildScope(append: NonNullable<MigrationPlanningInput['append']>,
    provenRelations?: readonly { alias: string; issueId: string }[]): JiraChildScope {
    const known = provenRelations ?? append.knownIssues.filter(issue => issue.projectId === append.project.id);
    const durable = new Map(known.map(issue => [issue.alias, issue.issueId]));
    const resolveId = provenRelations ? (alias: string) => this.boundIssues.get(alias)?.issueId : (alias: string) => this.originalIssue(alias)?.id;
    const blocked = new Set<string>();
    const sourceErrors = new Set(this.input.packages.flatMap(({ summary, dataset }) => dataset.diagnostics
      .filter(diagnostic => diagnostic.severity === 'error' && diagnostic.recordId)
      .map(diagnostic => `${summary.id}/${diagnostic.recordId}`)));
    for (const entry of this.entries) {
      const { row } = entry;
      if (entry.pkg.dataset.source.product !== 'jira' || row.kind !== 'issue' ||
          !(this.excluded.has(entry.key) || sourceErrors.has(entry.key) || isRestrictedJiraHistoryOwner(row) || this.restricted(entry))) continue;
      for (const alias of [row.sourceId, string(row.metadata.key)]) {
        const issueId = resolveId(alias);
        if (issueId) blocked.add(issueId);
      }
    }
    return { durable, resolveId, blocked, sourceErrors };
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
        const converted = this.projectJiraComment(entry);
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
  private reviewJiraCommentCorrections(): void {
    const append = this.input.append;
    if (!append || this.configuration.appendTo?.refreshComments !== true) return;
    const issues = new Map(append.historyIssues?.map(issue => [issue.id, issue]));
    const scope = this.jiraChildScope(append);
    const candidates = Map.groupBy(append.jiraCommentCandidates ?? [], comment => comment.sourceId);
    const entries = this.entries.filter(entry => entry.pkg.dataset.source.product === 'jira' && entry.row.kind === 'comment' &&
      this.retainedEntries.has(entry.key) && !this.excluded.has(entry.key));
    const groups = Map.groupBy(entries, entry => jiraHistorySourceKey(entry.row)?.sourceId ?? entry.key);
    const planned: JiraMigrationCommentReview[] = [], retained: JiraMigrationCommentReview[] = [];
    const updates: NonNullable<PreparedMigration['jiraCommentUpdates']> = [];
    const counts = { updatedJiraComments: 0, confirmedJiraComments: 0, conflictingJiraComments: 0, archivedJiraCommentCorrections: 0 };
    for (const [entry, ...duplicates] of groups.values()) {
      const { row } = entry;
      const known = candidates.get(row.sourceId);
      if (!known?.length && this.jiraHistoryOwners.has(entry.key)) continue;
      const owner = this.resolveJiraChildOwner(entry, jiraHistoryOwnerAliases(row), issues, scope);
      const authorId = this.mappedAuthor(entry);
      const addReview = (decision: JiraMigrationCommentReview['decision'], reason: string,
        values: Pick<JiraMigrationCommentReview, 'before' | 'after'> = {}) => {
        counts[decision === 'apply' ? 'updatedJiraComments' : decision === 'confirm' ? 'confirmedJiraComments' :
          decision === 'local-conflict' ? 'conflictingJiraComments' : 'archivedJiraCommentCorrections']++;
        const review = decision === 'apply' || decision === 'confirm' ? planned : retained;
        if (review.length < MAX_COMMENT_CORRECTION_REVIEW) {
          review.push({ recordId: entry.key, sourceId: row.sourceId, issueKey: owner?.key, decision, reason, ...values });
        }
      };
      const raw = duplicates.length ? JSON.stringify(row) : null;
      if (!jiraHistorySourceKey(row) || known?.length !== 1 || !owner || duplicates.some(duplicate =>
        JSON.stringify(duplicate.row) !== raw || this.mappedAuthor(duplicate) !== authorId ||
        this.resolveJiraChildOwner(duplicate, jiraHistoryOwnerAliases(duplicate.row), issues, scope)?.id !== owner.id)) {
        addReview('archive-only', '이미 적용한 댓글과 이번 원본의 ID·업무·접근 범위를 확인할 수 없습니다.');
        continue;
      }
      const [{ current, previous, originalRecordId, previousRecordId }] = known;
      const createdAt = jiraCommentSourceUpdatedAt({ ...row, updatedAt: row.createdAt }, this.configuration.timezone);
      if (current.resourceType !== 'issue' || current.resourceId !== owner.id || current.projectId !== owner.projectId ||
          !authorId || authorId !== current.authorId || !createdAt || createdAt !== current.createdAt) {
        addReview('archive-only', '댓글의 원래 업무, 작성자 또는 작성 시각이 이전 이관 기록과 일치하지 않습니다.');
        continue;
      }
      const updatedAt = jiraCommentSourceUpdatedAt(row, this.configuration.timezone);
      const body = jiraCommentProjectedBody(row);
      if (!previous || !updatedAt || updatedAt < createdAt || body === undefined) {
        addReview('archive-only', '이전 적용 본문이나 원본의 수정 시각·표시 본문을 확인할 수 없습니다.');
        continue;
      }
      const bodySha256 = jiraCommentBodyHash(body);
      const confirmed = bodySha256 === previous.bodySha256;
      if (updatedAt <= previous.updatedAt) {
        if (!confirmed) addReview('archive-only', 'Jira 수정 시각이 확인한 마지막 원본보다 최신인지 확인할 수 없습니다.');
        continue;
      }
      const editVersion = current.editVersion ?? 0;
      if (editVersion !== previous.editVersion || current.mentions?.length) {
        addReview('local-conflict', '팀에서 수정한 댓글을 유지합니다.', { before: current.body, after: body });
        continue;
      }
      if (jiraCommentBodyHash(current.body) !== previous.bodySha256) {
        addReview('archive-only', '저장된 댓글이 이전 이관 본문과 정확하게 일치하는지 확인할 수 없습니다.');
        continue;
      }
      const nextEditVersion = editVersion + Number(!confirmed);
      if (!Number.isSafeInteger(nextEditVersion)) {
        addReview('archive-only', '댓글의 수정 버전 한도에 도달했습니다.');
        continue;
      }
      addReview(confirmed ? 'confirm' : 'apply', confirmed ? '같은 본문을 확인한 최근 Jira 수정 시각을 기록합니다.' :
        '최근 Jira 수정본을 기존 댓글에 반영합니다.', { before: current.body, after: body });
      if (updates.length >= MAX_COMMENT_CORRECTION_REVIEW) continue;
      updates.push({ id: current.id, issueId: owner.id, projectId: owner.projectId, expectedEditVersion: editVersion,
        sourceRecordId: this.archiveIds.get(entry.key)!, body });
      this.jiraCommentCorrections.set(entry.key, { owner, marker: { commentId: current.id, originalRecordId, previousRecordId,
        bodySha256, editVersion: nextEditVersion, ...(confirmed ? { confirmed: true } : {}) } });
    }
    if (counts.updatedJiraComments + counts.confirmedJiraComments > updates.length) {
      this.notice('JIRA_COMMENT_CORRECTIONS_LIMIT', '한 번에 검토할 댓글 수정분은 1,000건입니다. 원본을 나누어 이관해 주세요.', 'error');
    }
    if (counts.updatedJiraComments) this.notice('JIRA_COMMENT_CORRECTIONS',
      '미리보기에서 현재 댓글과 Jira 수정본을 대조해 반영할 본문을 확인해 주세요.', 'warning', undefined, true);
    const review = [...planned, ...retained.slice(0, MAX_COMMENT_CORRECTION_REVIEW - planned.length)];
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) > review.length) {
      this.notice('JIRA_COMMENT_REVIEW_LIMIT', '댓글 수정분은 앞의 1,000건까지 목록에 표시합니다.', 'info');
    }
    this.result.jiraCommentUpdates = updates;
    this.result.preview.jiraCommentReview = review;
    Object.assign(this.result.preview.counts, counts);
  }
  private reviewJiraWorklogCorrections(): void {
    const append = this.input.append;
    if (!append || this.configuration.appendTo?.refreshWorklogs !== true) return;
    const issues = new Map(append.historyIssues?.map(issue => [issue.id, issue]));
    const scope = this.jiraChildScope(append);
    const candidates = Map.groupBy(append.jiraWorklogCandidates ?? [], worklog => worklog.sourceId);
    const entries = this.entries.filter(entry => entry.pkg.dataset.source.product === 'jira' && isJiraWorklog(entry.row) &&
      this.retainedEntries.has(entry.key) && !this.excluded.has(entry.key));
    const groups = Map.groupBy(entries, entry => jiraHistorySourceKey(entry.row)?.sourceId ?? entry.key);
    const planned: JiraMigrationWorklogReview[] = [], retained: JiraMigrationWorklogReview[] = [];
    const updates: NonNullable<PreparedMigration['jiraWorklogUpdates']> = [];
    const counts = { updatedJiraWorklogs: 0, confirmedJiraWorklogs: 0, conflictingJiraWorklogs: 0, archivedJiraWorklogCorrections: 0 };
    const archiveOnly = 'archive-only', localConflict = 'local-conflict';
    for (const group of groups.values()) {
      const [entry, ...duplicates] = group;
      const { row } = entry;
      const known = candidates.get(row.sourceId);
      if (!known?.length && this.jiraHistoryOwners.has(entry.key)) continue;
      const owner = this.resolveJiraChildOwner(entry, jiraHistoryOwnerAliases(row), issues, scope);
      const addReview = (decision: JiraMigrationWorklogReview['decision'], reason: string,
        values: Pick<JiraMigrationWorklogReview, 'before' | 'after'> = {}) => {
        counts[decision === 'apply' ? 'updatedJiraWorklogs' : decision === 'confirm' ? 'confirmedJiraWorklogs' :
          decision === localConflict ? 'conflictingJiraWorklogs' : 'archivedJiraWorklogCorrections']++;
        const review = decision === 'apply' || decision === 'confirm' ? planned : retained;
        if (review.length < MAX_WORKLOG_CORRECTION_REVIEW) {
          review.push({ recordId: entry.key, sourceId: row.sourceId, issueKey: owner?.key, decision, reason, ...values });
        }
      };
      if (known?.length !== 1 || !owner || duplicates.some(duplicate =>
        JSON.stringify(duplicate.row) !== JSON.stringify(row) || this.mappedAuthor(duplicate) !== this.mappedAuthor(entry) ||
        this.resolveJiraChildOwner(duplicate, jiraHistoryOwnerAliases(duplicate.row), issues, scope)?.id !== owner.id)) {
        addReview(archiveOnly, '이전에 이관한 작업 시간과 이번 원본의 업무·ID를 확인할 수 없습니다.');
        continue;
      }
      const [{ current, previous, originalRecordId, previousRecordId }] = known;
      if (owner.id !== current.issueId || this.mappedAuthor(entry) !== current.authorId) {
        addReview(archiveOnly, '이전 기록과 Jira 수정본의 소유 업무 또는 작성자 연결이 다릅니다.');
        continue;
      }
      const parsed = parseJiraWorklog(row, this.configuration.timezone);
      const updatedAt = jiraWorklogSourceUpdatedAt(row, this.configuration.timezone);
      if ('code' in parsed || !updatedAt || !previous) {
        addReview(archiveOnly, '이전 적용값이나 Jira 수정 시각·작업일·시간을 확인할 수 없습니다.');
        continue;
      }
      const projectedNote = jiraWorklogProjectedNote(row);
      const noteSha256 = projectedNote === undefined ? previous.noteSha256 : jiraWorklogNoteHash(projectedNote);
      const confirmed = parsed.workDate === previous.workDate && parsed.durationSeconds === previous.durationSeconds &&
        noteSha256 === previous.noteSha256;
      if (updatedAt <= previous.updatedAt) {
        if (!confirmed) addReview(archiveOnly, 'Jira 수정 시각이 마지막으로 확인한 원본보다 최신임을 확인할 수 없습니다.');
        continue;
      }
      const before = { workDate: current.workDate, durationSeconds: current.durationSeconds, note: current.note };
      const after = { workDate: parsed.workDate, durationSeconds: parsed.durationSeconds, note: projectedNote ?? current.note };
      if (current.deletedAt !== null || current.workDate !== previous.workDate || current.durationSeconds !== previous.durationSeconds ||
          jiraWorklogNoteHash(current.note) !== previous.noteSha256) {
        addReview(localConflict, current.deletedAt ? '팀에서 삭제한 기록을 유지합니다.' : '팀에서 수정한 기록을 유지합니다.',
          current.deletedAt ? {} : { before, ...(projectedNote === undefined ? {} : { after }) });
        continue;
      }
      addReview(confirmed ? 'confirm' : 'apply', confirmed ? '같은 값이 담긴 최신 Jira 원본의 수정 시각을 기록합니다.' :
        '최근 Jira 수정본을 기존 작업 시간 기록에 반영합니다.', { before, after });
      if (updates.length >= MAX_WORKLOG_CORRECTION_REVIEW) continue;
      updates.push({ id: current.id, issueId: owner.id, projectId: owner.projectId, expectedVersion: current.version,
        sourceRecordId: this.archiveIds.get(entry.key)!, changes: after });
      this.jiraWorklogCorrections.set(entry.key, { owner, marker: { worklogId: current.id, originalRecordId, previousRecordId, noteSha256,
        ...(confirmed ? { confirmed: true } : {}) } });
    }
    if (counts.updatedJiraWorklogs + counts.confirmedJiraWorklogs > updates.length) {
      this.notice('JIRA_WORKLOG_CORRECTIONS_LIMIT', '한 번에 수정할 수 있는 작업 시간은 1,000건입니다. 날짜 범위를 나누어 이관해 주세요.', 'error');
    }
    const review = [...planned, ...retained.slice(0, MAX_WORKLOG_CORRECTION_REVIEW - planned.length)];
    if (Object.values(counts).reduce((sum, value) => sum + value, 0) > review.length) {
      this.notice('JIRA_WORKLOG_REVIEW_LIMIT', '작업 시간 수정분은 앞의 1,000건까지 목록에 표시합니다.', 'info');
    }
    this.result.jiraWorklogUpdates = updates;
    this.result.preview.jiraWorklogReview = review;
    Object.assign(this.result.preview.counts, counts);
  }
  private authorExpectation(entry: Entry, binding: Binding | undefined, worklogId: string | undefined): MigrationAuthorExpectation | undefined {
    const retainedPage = this.confluenceRefreshCheckpoints.get(entry.key);
    if (retainedPage) return { kind: 'document', targetId: retainedPage.document.id,
      expectedAuthorId: retainedPage.document.authorId, disposition: 'retained' };

    const kind = worklogId ? 'worklog' : binding?.type;
    const targetId = worklogId ?? binding?.id;
    if (!targetId || !kind || kind === 'project' || kind === 'issue') return;
    const mapped = this.mappedAuthor(entry);
    return { kind, targetId, expectedAuthorId: mapped ?? this.input.actorId,
      disposition: mapped !== null ? 'mapped' : entry.row.authorId ? 'unmapped-fallback' : 'missing-fallback' };
  }

  archive():void{
    const packages = new Map<string, Map<MigrationAuthorKind, Record<MigrationAuthorStatus, number>>>();
    const worklogs = new Map(this.result.worklogs.map(value => [value.sourceRecordId, value.id]));
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
      const jiraCommentCorrection = this.jiraCommentCorrections.get(entry.key);
      const jiraWorklogCorrection = this.jiraWorklogCorrections.get(entry.key);
      const jiraAttachmentOwner = this.jiraAttachmentOwners.get(entry.key);
      const jiraActivityOwner = jiraHistoryOwner ?? jiraCommentCorrection?.owner ?? jiraWorklogCorrection?.owner;
      const owner = issueCheckpoint || pageCheckpoint ? binding : jiraActivityOwner ? { type: 'issue' as const, id: jiraActivityOwner.id, projectId: jiraActivityOwner.projectId } :
        jiraAttachmentOwner ?? this.confluenceAttachmentOwners.get(entry.key) ?? this.confluenceHistoryOwners.get(entry.key) ??
        (ownerEntry ? this.bindings.get(ownerEntry.key) : undefined);
      const ownerType = owner?.type === 'issue' || owner?.type === 'document' ? owner.type : null;
      const createdIssue = binding?.type === 'issue' ? this.issueById.get(binding.id) : undefined;
      const issueHashes = issueCheckpoint?.hashes ??
        (createdIssue && entry.pkg.dataset.source.product === 'jira' ? jiraFieldDigests(createdIssue) : undefined);
      const issueSourceHashes = issueCheckpoint?.sourceHashes ?? (issueHashes?.plannedEffortMinutes !== undefined ?
        matchedJiraSourceFieldHashes(entry.row, issueHashes) : undefined);
      const customHashes = issueCheckpoint?.customHashes ??
        (createdIssue && entry.pkg.dataset.source.product === 'jira' ? this.initialJiraCustomFieldHashes(entry, createdIssue) : undefined);
      const createdPage = binding?.type === 'document' ? this.documentById.get(binding.id) : undefined;
      const pageHashes = pageCheckpoint?.hashes ??
        (createdPage && entry.pkg.dataset.source.product === 'confluence' ? confluencePageFieldDigests({ ...createdPage, labels: createdPage.labels ?? [] }) : undefined);
      const pageBodySourceHash = this.confluenceBodySourceHashes.get(entry.key);
      const id = this.archiveIds.get(entry.key) || randomUUID();
      const authorAttribution = excluded ? undefined : this.authorExpectation(entry, binding, worklogs.get(id));
      if (authorAttribution) {
        const packageId = entry.pkg.summary.id;
        let kinds = packages.get(packageId);
        if (!kinds) packages.set(packageId, kinds = new Map());
        let counts = kinds.get(authorAttribution.kind);
        if (!counts) {
          counts = { mapped: 0, 'unmapped-fallback': 0, 'missing-fallback': 0, retained: 0, unavailable: 0, mismatch: 0 };
          kinds.set(authorAttribution.kind, counts);
        }
        counts[authorAttribution.disposition]++;
      }
      const value: SourceRecordArchive = {
        id, sourceImportId: this.input.id,
        packageSha256: entry.pkg.summary.sha256, source: structuredClone(entry.pkg.dataset.source), record: structuredClone(entry.row),
        targetType: binding?.type ?? null, targetId: binding?.id ?? null, targetProjectId: binding?.projectId ?? owner?.projectId ?? null,
        ownerType, ownerId: ownerType ? owner!.id : null,
        ...(excluded ? { excluded: true } : {}),
        ...(jiraHistoryOwner ? { jiraHistoryAppend: true } : {}),
        ...(jiraCommentCorrection ? { jiraCommentCorrection: jiraCommentCorrection.marker } : {}),
        ...(jiraWorklogCorrection ? { jiraWorklogCorrection: jiraWorklogCorrection.marker } : {}),
        ...(jiraAttachmentOwner ? { jiraAttachmentAppend: true } : {}),
        ...(this.jiraRelationIds.has(entry.key) ? { jiraRelationId: this.jiraRelationIds.get(entry.key)! } : {}),
        ...(issueHashes ? { jiraIssueFieldHashes: issueHashes } : {}),
        ...(issueSourceHashes ? { jiraIssueSourceFieldHashes: issueSourceHashes } : {}),
        ...(customHashes ? { jiraCustomFieldHashes: customHashes } : {}),
        ...(pageHashes && Object.keys(pageHashes).length ? { confluencePageFieldHashes: pageHashes } : {}),
        ...(pageBodySourceHash ? { confluencePageBodySourceHash: pageBodySourceHash } : {}),
        ...(authorAttribution ? { authorAttribution } : {}),
      };
      if (entry.row.kind === 'project' || entry.row.kind === 'identity') {
        value.ownerType = null;
        value.ownerId = null;
      }
      this.result.sourceRecords.push(value);
    }
    this.result.sourceImport.authorAttributionVersion = 1;
    this.result.preview.authorAttribution = this.input.packages.flatMap(({ summary }) => {
      const grouped = packages.get(summary.id);
      if (!grouped) return [];
      const kinds = MIGRATION_AUTHOR_KINDS.flatMap(kind => {
        const counts = grouped.get(kind);
        return counts ? [{ kind, counts }] : [];
      });
      return [{ packageId: summary.id, kinds }];
    });
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
    if (!this.result.confluenceHistoryOwners?.length && !this.result.jiraHistoryOwners?.length &&
        !this.result.jiraCommentUpdates?.length && !this.result.jiraWorklogUpdates?.length &&
        !this.result.jiraAttachmentOwners?.length &&
        this.result.preview.counts.newJiraRelations === undefined) for (const { message, entry } of this.deferredPrimaryNotices) {
      this.notice('SOURCE_NO_PRIMARY_CONTENT', message, 'error', entry);
    }
    const counts:Record<string,number>={...this.result.preview.counts,sourceRecords:this.entries.length,excludedRecords:this.excluded.size,projects:this.result.projects.length,issues:this.result.issues.length,documents:this.result.documents.length,comments:this.result.comments.length,revisions:this.result.revisions.length,attachments:this.result.attachments.length,attachmentVersions:this.result.attachmentVersions.length,fileCopies:this.result.fileCopies.length,attachmentBytes:this.result.fileCopies.reduce((sum,file)=>sum+file.size,0),resourceLinks:this.result.resourceLinks.length,issueRelations:this.result.issueRelations.length};
    const jiraPlannedEffortIssues = this.result.issues.filter(issue => typeof issue.plannedEffortMinutes === 'number').length;
    if (jiraPlannedEffortIssues) counts.jiraPlannedEffortIssues = jiraPlannedEffortIssues;
    const atlassianLinks = this.result.atlassianLinks.length;
    Object.assign(counts, { atlassianLinks, unlinkedAtlassianRecords: this.primaryById.size - atlassianLinks });
    const sourceWorklogs = this.entries.filter(entry=>entry.pkg.dataset.source.product==='jira'&&isJiraWorklog(entry.row)).length;
    if (sourceWorklogs) Object.assign(counts,{worklogs:this.result.worklogs.length,
      archivedWorklogs:sourceWorklogs-this.result.worklogs.length-(this.result.jiraWorklogUpdates?.length ?? 0)});
    if(Object.entries(counts).filter(([key])=>['issues','documents','comments','revisions','attachmentVersions','resourceLinks','issueRelations','worklogs'].includes(key)).reduce((sum,[,value])=>sum+value,0)>MAX_RECORDS)this.notice('CANONICAL_RECORD_LIMIT','생성할 현재 객체·이력·파일 버전 합계가100000개를 넘습니다.','error');
    const target = this.input.append?.project ?? this.input.appendPages?.project;
    const projects = target ? [target] : this.result.projects;
    this.result.preview.projects = this.previewProjects(projects, !target);
    if (this.result.preview.projects.some(project => project.mergesSources)) {
      this.notice('PROJECT_SOURCE_MERGE', '한 대상에 여러 원본이 연결됐습니다. 대상 프로젝트별 원본 목록을 확인해 주세요.', 'warning', undefined, true);
    }
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
    if (this.input.append && !this.result.issues.length && !this.result.issueUpdates?.length && !this.result.jiraHistoryOwners?.length &&
        !this.result.jiraCommentUpdates?.length && !this.result.jiraWorklogUpdates?.length && !this.result.jiraAttachmentOwners?.length && !counts.newJiraRelations &&
        !this.notices.some(notice => notice.severity === 'error')) {
      if (this.configuration.appendTo?.refreshRelations) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 업무 관계나 다른 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshAttachments) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 첨부나 다른 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshHistory) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 새 Jira 업무·댓글·작업 시간이나 기존 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshComments) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 Jira 댓글 수정분이나 다른 업무 변경분이 없습니다.', 'error');
      } else if (this.configuration.appendTo?.refreshWorklogs) {
        this.notice('JIRA_REFRESH_NO_CHANGES', '적용할 Jira 작업 시간 수정이나 다른 업무 변경분이 없습니다.', 'error');
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
    const receiptProjects = [...new Set([...projects.map(project => project.id), ...this.jiraRelationProjectIds])];
    if (receiptProjects.length > MAX_PROJECTS) {
      this.notice('MIGRATION_PROJECT_LIMIT', `한 번에 이관 영수증에 기록할 프로젝트는 ${MAX_PROJECTS}개입니다. 패키지를 나누어 주세요.`, 'error');
    }
    this.result.preview.counts=counts;this.result.sourceImport.counts=counts;this.result.sourceImport.projectIds=receiptProjects;this.result.preview.requiredAcknowledgements=[...new Set(this.notices.filter(notice=>notice.requiresAcknowledgement).map(notice=>notice.code))];this.result.preview.canApply=!this.notices.some(notice=>notice.severity==='error');return this.result;
  }

  private previewProjects(projects: readonly Project[], reviewMerge: boolean): MigrationPreviewProject[] {
    const summaries = new Map(projects.map(({ id, key, name }) => [id, {
      project: { id, key, name, issueCount: 0, documentCount: 0 } as MigrationPreviewProject,
      sources: new Map<string, MigrationPreviewProjectSource>(),
      origins: new Set<string>(),
    }]));
    const containers = new Map(this.options.containers.map(container =>
      [JSON.stringify([container.packageId, container.sourceProjectId]), container]));

    // Only primary rows projected into the target contribute to its membership.
    // For new projects, there can be at most one membership row per configured container.
    for (const entry of this.primaryById.values()) {
      const projectId = this.bindings.get(entry.key)?.projectId;
      const summary = projectId && summaries.get(projectId);
      if (!summary) continue;
      const packageId = entry.pkg.summary.id;
      const containerKey = JSON.stringify([packageId, entry.container]);
      let source = summary.sources.get(containerKey);
      if (!source) {
        const sourceProjectId = entry.container === '__unassigned__' ? null : entry.container;
        const container = containers.get(containerKey);
        const record = this.indexes.get(packageId)?.get(`project:${entry.container}`);
        const { product, instanceKey } = entry.pkg.dataset.source;
        // Jira key-only exports can infer the project from a ticket key. A numeric project ID
        // with a declared project row, or an explicit Confluence space, can be compared across files.
        const confirmed = sourceProjectId !== null && record?.kind === 'project' && record.sourceId === sourceProjectId && record.metadata.syntheticId !== true &&
          (product === 'jira' ? /^[1-9]\d{0,19}$/u.test(sourceProjectId) && record.metadata.jiraComponentProjectAmbiguous !== true
            : record.metadata.sourceClass === 'Space' && record.metadata.originalId === sourceProjectId);
        source = { packageId, sourceProjectId, name: container?.name ?? (sourceProjectId || '원본 프로젝트 미지정'),
          issueCount: 0, documentCount: 0, ...(confirmed ? {} : { identityUnconfirmed: true }) };
        summary.sources.set(containerKey, source);
        summary.origins.add(confirmed ? JSON.stringify(['source', product, instanceKey, sourceProjectId]) : JSON.stringify(['package', containerKey]));
      }
      const counter = entry.row.kind === 'issue' ? 'issueCount' : 'documentCount';
      source[counter]++;
      summary.project[counter]++;
    }

    return [...summaries.values()].map(({ project, sources, origins }) => sources.size ? { ...project, sources: [...sources.values()],
      sourceOriginCount: origins.size, ...(reviewMerge && origins.size > 1 ? { mergesSources: true } : {}) } : project);
  }
}

/** Pure planning: IDs are allocated once and persisted by the caller with its immutable preview. */
export function buildMigrationPlan(
  input: MigrationPlanningInput,
  restrictedConfluencePages?: ReadonlyMap<string, ReadonlySet<string>>,
): PreparedMigration {
  return new Planner(input, restrictedConfluencePages).run();
}
