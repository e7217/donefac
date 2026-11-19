export type StatusCategory = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';
export interface ReportingCoverage {
  id: string;
  startedAt: string;
  endedAt: string | null;
  reason: 'initial' | 'restore';
}
export interface ReportIssueState {
  issueId: string;
  projectId: string;
  key: string;
  title: string;
  type: string;
  statusId: string;
  statusLabel: string;
  category: StatusCategory;
  assigneeId: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
}
export interface IssueReportEvent {
  id: string;
  sequence: number;
  coverageId: string;
  projectId: string;
  issueId: string;
  occurredAt: string;
  kind: 'baseline' | 'created' | 'changed' | 'reclassified' | 'deleted';
  actorId: string | null;
  origin: MutationOrigin;
  workflowVersion: number;
  before: ReportIssueState | null;
  after: ReportIssueState | null;
}
export interface ReportingLedgerData { coverage: ReportingCoverage[]; events: IssueReportEvent[] }
export interface ReportQuery {
  projectId: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  issueType: string | null;
  assigneeId: string | null;
}
export interface ReportDay {
  date: string;
  coverage: 'complete' | 'partial' | 'unobserved';
  state: Record<StatusCategory, number> | null;
  created: number;
  completed: number;
  reopened: number;
}
export interface ReportIssueMetric {
  issue: ReportIssueState;
  completed: number;
  reopened: number;
  lastCompletedAt: string | null;
  cycleHours: number | null;
  deleted: boolean;
}
export interface ProjectReport {
  definitionVersion: 1;
  query: ReportQuery;
  generatedAt: string;
  rangeStartAt: string;
  rangeEndAt: string;
  observedThrough: string | null;
  coverage: ReportingCoverage[];
  current: {
    total: number;
    state: Record<StatusCategory, number>;
    overdue: number;
    dueSoon: number;
  };
  period: {
    created: number;
    deleted: number;
    completedIssues: number;
    completionTransitions: number;
    repeatedCompletions: number;
    reopened: number;
    reclassified: number;
    medianCycleHours: number | null;
    cycleSamples: number;
  };
  days: ReportDay[];
  issues: ReportIssueMetric[];
}
export interface ReportSnapshot {
  id: string;
  projectId: string;
  actorId: string;
  title: string;
  createdAt: string;
  documentId: string;
  report: ProjectReport;
}
export type ReportSnapshotSummary = Omit<ReportSnapshot, 'report'> & { query: ReportQuery };
export interface WorkflowStatus { id: string; label: string; color: string; category: StatusCategory }
export const STATUS: Record<string, Omit<WorkflowStatus, 'id'>> = {
  backlog: { label: '백로그', color: '#8b93a5', category: 'backlog' },
  todo: { label: '할 일', color: '#677386', category: 'todo' },
  in_progress: { label: '진행 중', color: '#5778ef', category: 'in_progress' },
  review: { label: '검토', color: '#a175d3', category: 'review' },
  done: { label: '완료', color: '#31a27e', category: 'done' },
  cancelled: { label: '취소', color: '#a2a8b4', category: 'cancelled' },
};
export type IssueStatus = string;
export const PRIORITY = { urgent: '긴급', high: '높음', medium: '보통', low: '낮음' } as const;
export type Priority = keyof typeof PRIORITY;
export const ISSUE_TYPES = ['큰틀', '작업', '부작업', '버그', '개선', '신규', '요구사항', '회의', '기획'] as const;
export interface User { id: string; name: string; email: string; color: string }
export type LegacyFormat = 'jira-backup-xml' | 'jira-search-xml' | 'jira-csv' | 'jira-json' | 'confluence-xml';
export type LegacyRecordKind = 'identity' | 'project' | 'issue' | 'page' | 'comment' | 'revision' | 'history' | 'attachment' | 'relation' | 'field' | 'option' | 'workflow';
export type LegacyValue = string | number | boolean | null | LegacyValue[] | {[key:string]:LegacyValue};
export interface LegacySource { product:'jira'|'confluence'; format:LegacyFormat; instanceKey:string; declaredVersion:string|null; timezone:string|null }
export interface LegacyReference { kind:LegacyRecordKind; sourceId:string; relation:string }
export interface LegacyRecord {
  id:string; kind:LegacyRecordKind; sourceId:string; title:string; containerId:string|null; parentId:string|null;
  authorId:string|null; createdAt:string|null; updatedAt:string|null; text:string;
  textFormat:'none'|'plain'|'jira-wiki'|'confluence-storage'|'adf'|'json';
  metadata:{[key:string]:LegacyValue}; references:LegacyReference[];
}
export interface LegacyDiagnostic { id:string; severity:'error'|'warning'|'info'; code:string; message:string; recordId:string|null; path:string|null }
export interface LegacyDataset { source:LegacySource; records:LegacyRecord[]; diagnostics:LegacyDiagnostic[]; unsupported:{type:string;count:number}[] }
export interface LegacyFile { path:string; size:number; sha256:string }
export interface LegacyPackageSummary {
  id:string; filename:string; sha256:string; size:number; version:number; createdAt:string; actorId:string;
  source:LegacySource; counts:Partial<Record<LegacyRecordKind,number>>; errors:number; warnings:number;
  fileCount:number; expandedBytes:number; applySupported:false;
}
export interface LegacyPackageDetail { summary:LegacyPackageSummary; files:LegacyFile[]; unsupported:{type:string;count:number}[] }
export type LegacyRecordSummary=Omit<LegacyRecord,'text'|'metadata'|'references'>&{textPreview:string;textBytes:number;referenceCount:number};
export interface LegacyRecordPage { records:LegacyRecordSummary[]; total:number; offset:number; limit:number }
export interface LegacyDiagnosticPage { diagnostics:LegacyDiagnostic[]; total:number; offset:number; limit:number }
export interface MigrationContainerOption { id:string;packageId:string;sourceProjectId:string;name:string;proposedKey:string;issueCount:number;documentCount:number }
export interface MigrationValueOption { id:string;packageId:string;sourceValue:string;label:string }
export interface MigrationIdentityOption extends MigrationValueOption { email:string|null }
export interface MigrationFieldOption extends MigrationValueOption { suggestedKind:CustomFieldKind|'archive' }
export interface MigrationOptions {
  packages:LegacyPackageSummary[];containers:MigrationContainerOption[];identities:MigrationIdentityOption[];
  statuses:MigrationValueOption[];issueTypes:MigrationValueOption[];fields:MigrationFieldOption[];
  defaultConfiguration:MigrationConfiguration;
}
export interface MigrationConfiguration {
  packageIds:string[];projects:{containerId:string;key:string;name:string}[];
  users:Record<string,string|null>;statuses:Record<string,StatusCategory>;issueTypes:Record<string,string|null>;
  fields:Record<string,CustomFieldKind|'archive'>;sourceBaseUrls:Record<string,string|null>;
  timezone:string;datePolicy:'block'|'import-time';excludedRecords:string[];
}
export interface MigrationNotice { severity:'error'|'warning'|'info';code:string;message:string;recordId:string|null;requiresAcknowledgement:boolean }
export interface MigrationPreview {
  id:string;version:number;actorId:string;createdAt:string;expiresAt:string;configuration:MigrationConfiguration;
  projects:{id:string;key:string;name:string;issueCount:number;documentCount:number}[];
  counts:Record<string,number>;notices:MigrationNotice[];requiredAcknowledgements:string[];canApply:boolean;
  samples:{recordId:string;targetType:'issue'|'document';title:string;plainText:string;content?:RichContent}[];
}
export interface SourceImport {
  id:string;version:number;createdAt:string;actorId:string;projectIds:string[];configuration:MigrationConfiguration;
  packages:{stagingId:string;filename:string;sha256:string;source:LegacySource}[];counts:Record<string,number>;
  notices?:MigrationNotice[];
}
export interface SourceRecordArchive {
  id:string;sourceImportId:string;packageSha256:string;source:LegacySource;record:LegacyRecord;
  targetType:'project'|'issue'|'document'|'comment'|'revision'|'attachment'|null;targetId:string|null;targetProjectId:string|null;
  ownerType:'issue'|'document'|null;ownerId:string|null;
}
export interface AttachmentVersion extends Attachment { attachmentId:string;versionLabel:string;sourceImportId:string|null;sourceRecordId:string|null }
export interface IssueRelation { id:string;sourceIssueId:string;targetIssueId:string;type:string;version:number;createdAt:string }
export interface MigrationApplyResult { import:SourceImport;duplicate:boolean }
export type SourceRecordSummary=Omit<SourceRecordArchive,'record'>&{record:LegacyRecordSummary;originalAuthorName:string|null};
export interface SourceRecordPage { records:SourceRecordSummary[];total:number;offset:number;limit:number }
export interface Project { id: string; key: string; name: string; description: string; color: string; createdAt: string }
export type PlanningKind = 'cycle' | 'module' | 'release';
export type PlanningStatus = 'planned' | 'active' | 'completed' | 'archived';
export interface PlanningItem {
  id: string; projectId: string; kind: PlanningKind; name: string; description: string;
  status: PlanningStatus; ownerId: string | null; startDate: string | null; endDate: string | null; targetDate: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export type ApiKeyAccess = 'read' | 'write';
export interface ApiKeyRecord {
  id: string; name: string; prefix: string; actorId: string; access: ApiKeyAccess; projectIds: string[] | null;
  version: number; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
}
export interface ApiKeyCreated { key: ApiKeyRecord; token: string }
export interface CalendarException { date: string; isWorking: boolean; label: string }
export interface WorkCalendar { id: string; projectId: string; name: string; workingWeekdays: number[]; exceptions: CalendarException[]; version: number; updatedAt: string }
export interface Milestone { id: string; projectId: string; title: string; description: string; date: string; status: 'open' | 'reached'; ownerId: string | null; issueIds: string[]; version: number; createdAt: string; updatedAt: string }
export interface BaselineIssue { issueId: string; key: string; title: string; startDate: string | null; endDate: string | null; sourceVersion: number }
export interface BaselineMilestone { milestoneId: string; title: string; date: string; status: 'open' | 'reached'; sourceVersion: number }
export interface ScheduleBaseline { id: string; projectId: string; name: string; description: string; authorId: string; version: number; createdAt: string; calendar: WorkCalendar; issues: BaselineIssue[]; milestones: BaselineMilestone[] }
export interface IssueTypeDefinition { id: string; name: string; color: string; archived: boolean }
export type CustomFieldKind = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'checkbox' | 'user' | 'url';
export interface CustomFieldOption { id: string; name: string; archived: boolean }
export interface CustomFieldDefinition { id: string; name: string; description: string; kind: CustomFieldKind; required: boolean; issueTypes: string[]; options: CustomFieldOption[]; archived: boolean }
export type CustomFieldValue = string | number | boolean | string[] | null;
export interface ProjectIssueSchema { id: string; projectId: string; version: number; issueTypes: IssueTypeDefinition[]; fields: CustomFieldDefinition[]; updatedAt: string }
export interface Issue {
  id: string; key: string; projectId: string; title: string; description: string;
  type: string; status: IssueStatus; priority: Priority; assigneeId: string | null;
  collaboratorIds: string[]; parentId: string | null; labels: string[];
  startDate: string | null; endDate: string | null; dueDate: string | null;
  estimate: number | null; cycle: string | null; module: string | null; release: string | null;
  cycleId?: string | null; moduleId?: string | null; releaseId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  version: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface RichContent { type: string; content?: RichContent[]; text?: string; attrs?: Record<string, unknown>; marks?: {type: string; attrs?: Record<string, unknown>}[] }
export interface ContentReference { type: 'issue' | 'document'; id: string; kind: 'reference' | 'include'; label: string }
export interface DocPage {
  id: string; projectId: string | null; parentId: string | null; title: string;
  content: RichContent; plainText: string; icon: string; status: 'draft' | 'published';
  version: number; authorId: string; createdAt: string; updatedAt: string;
}
export interface DocRevision { id: string; documentId: string; version: number; title: string; content: RichContent; plainText: string; authorId: string; createdAt: string; summary: string }
export interface Dependency { id: string; predecessorId: string; successorId: string; type: 'FS'; lagDays: number }
export interface ResourceLink { id: string; issueId: string; documentId: string; kind: string }
export interface Comment { id: string; resourceType: 'issue' | 'document'; resourceId: string; authorId: string; body: string; createdAt: string }
export interface Attachment { id: string; resourceType: 'issue' | 'document'; resourceId: string; filename: string; mimeType: string; size: number; sha256: string; authorId: string; createdAt: string; versionCount?: number }
export interface Activity { id: string; resourceType: string; resourceId: string; actorId: string; action: string; detail: string; createdAt: string }
export interface GitlabLink { id: string; issueId: string; projectId: number; iid: number; kind: 'merge_request' | 'commit' | 'pipeline'; title: string; webUrl: string; state: string; updatedAt: string; sourceBranch?: string; sourceSha?: string }
export interface GitlabSettings { baseUrl: string; projectIds: number[]; tokenConfigured: boolean; webhookSecretConfigured: boolean; signingTokenConfigured: boolean; version: number; lastSyncAt: string | null; lastError: string | null }
export type GitlabAutomationTrigger = 'merge_request.opened' | 'merge_request.merged' | 'merge_request.closed' | 'pipeline.succeeded' | 'pipeline.failed';
export interface AutomationRule {
  id: string; projectId: string; name: string; enabled: boolean; trigger: GitlabAutomationTrigger;
  gitlabProjectIds: number[]; branchPattern: string; issueTypes: string[]; fromStatuses: string[]; toStatusId: string;
  actorId: string; priority: number; gitlabBaseUrl: string; enabledAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export interface AutomationEvent {
  id: string; trigger: GitlabAutomationTrigger; gitlabProjectId: number; objectKind: 'merge_request' | 'pipeline'; objectId: string;
  branch: string; issueIds: string[]; occurredAt: string | null; receivedAt: string;
  disposition: 'fresh' | 'stale' | 'ambiguous' | 'unverified'; reason: string;
}
export interface AutomationOutcome {
  issueId: string; key: string; title: string; fromStatus: string; toStatus: string;
  outcome: 'changed' | 'no_op' | 'blocked' | 'ignored'; reason: string;
}
export interface AutomationRun extends AutomationOutcome {
  id: string; eventId: string; ruleId: string; projectId: string; actorId: string; createdAt: string; occurredAt: string | null;
}
export interface AutomationPreview { outcomes: AutomationOutcome[]; warnings: string[] }
export type OutboundEventType = 'issue.created' | 'issue.updated' | 'issue.deleted' | 'document.created' | 'document.updated' | 'document.deleted' | 'comment.created';
export type MutationOrigin = 'user' | 'gitlab' | 'automation' | 'system' | 'import';
export interface WebhookEndpoint {
  id: string; name: string; url: string; projectIds: string[] | null; eventTypes: OutboundEventType[];
  enabled: boolean; secretConfigured: boolean; version: number; createdAt: string; updatedAt: string;
}
export interface WebhookEndpointCreated { endpoint: WebhookEndpoint; secret: string }
export interface WebhookEnvelope {
  id: string; type: OutboundEventType; occurredAt: string; actorId: string | null; origin: MutationOrigin;
  projectId: string | null; sourceEventId: string | null; changedFields: string[];
  resource: { id: string; type: 'issue' | 'document' | 'comment'; key?: string; title?: string; status?: string; version?: number; parentType?: 'issue' | 'document'; parentId?: string };
  previous: { title?: string; status?: string; version?: number } | null;
}
export interface WebhookDelivery {
  id: string; endpointId: string; eventId: string; eventType: OutboundEventType; projectId: string | null; resourceId: string;
  status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'cancelled'; attempts: number; nextAttemptAt: string | null;
  lastAttemptAt: string | null; httpStatus: number | null; lastError: string | null; version: number; createdAt: string; updatedAt: string;
}
export type IssueRequiredField = 'title' | 'description' | 'assigneeId' | 'collaboratorIds' | 'startDate' | 'endDate' | 'dueDate' | 'estimate' | 'labels' | 'parentId' | 'cycle' | 'module' | 'release' | `custom:${string}`;
export interface WorkflowTransition { from: string; to: string; issueTypes: string[]; requiredFields: IssueRequiredField[] }
export interface WorkflowFieldRule { issueType: string; statusId: string; requiredFields: IssueRequiredField[] }
export interface ProjectWorkflow { id: string; projectId: string; version: number; initialStatusId: string; statuses: WorkflowStatus[]; transitions: WorkflowTransition[]; fieldRules: WorkflowFieldRule[]; updatedAt: string }
export interface SavedViewState { layout: 'list' | 'board'; filters: { query: string; status: string; assigneeId: string; type: string } }
export interface SavedView extends SavedViewState { id: string; projectId: string; name: string; authorId: string; version: number; createdAt: string; updatedAt: string }
export interface WorkspaceSnapshot {
  projects: Project[]; users: User[]; issues: Issue[]; documents: DocPage[]; workflows?: ProjectWorkflow[];
  dependencies: Dependency[]; resourceLinks: ResourceLink[]; activities: Activity[]; gitlabLinks: GitlabLink[]; savedViews?: SavedView[];
  planningItems?: PlanningItem[];
  calendars?: WorkCalendar[]; milestones?: Milestone[]; baselines?: ScheduleBaseline[];
  issueSchemas?: ProjectIssueSchema[];
}
export interface ScheduleChange { id: string; key: string; title: string; version: number; fromStart: string | null; fromEnd: string | null; toStart: string | null; toEnd: string | null }
export interface SchedulePreview { changes: ScheduleChange[]; warnings: string[]; calendarVersions?: Record<string, number>; previewId?: string; blocking?: string[]; expiresAt?: string }
export interface AutomaticSchedulePreview extends SchedulePreview { previewId: string; blocking: string[]; expiresAt: string }
export interface SchedulePasteDiagnostic { line: number | null; key?: string; message: string }
export interface SchedulePastePreview {
  projectId: string;
  previewId: string | null;
  expiresAt: string | null;
  changes: ScheduleChange[];
  warnings: string[];
  errors: SchedulePasteDiagnostic[];
  unchanged: number;
}
export interface SchedulePasteApplyResult { undoId: string; updated: Issue[]; warnings: string[] }
export interface FeatureProps {
  data: WorkspaceSnapshot; projectId: string; actorId: string;
  refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void;
  openIssue: (id: string) => void; openDocument: (id: string) => void;
}
