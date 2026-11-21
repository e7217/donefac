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
  kind: 'baseline' | 'created' | 'changed' | 'reclassified' | 'deleted' | 'restored' | 'moved_out' | 'moved_in';
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
  movedOut?: true;
}
export interface ReportStatusVisitMetric {
  statusId: string;
  statusLabel: string;
  category: StatusCategory;
  samples: number;
  unknownEntries: number;
  medianHours: number | null;
  maxHours: number | null;
}
export interface ReportOpenStatusIssue {
  issueId: string;
  key: string;
  title: string;
  statusId: string;
  statusLabel: string;
  category: StatusCategory;
  assigneeId: string | null;
  enteredAt: string | null;
  elapsedHours: number | null;
}
export const DELIVERY_BLOCKER_REASONS = ['issue_block', 'schedule_conflict', 'gitlab'] as const;
export type DeliveryBlockerReason = typeof DELIVERY_BLOCKER_REASONS[number];
export interface DeliveryBlockerDraftScope {
  savedViewId?: string;
  reason?: DeliveryBlockerReason;
}
export interface DeliveryBlockerDraftResult {
  document: DocPage;
  duplicate: boolean;
}

export interface DeliveryBlockerIssue extends Pick<Issue, 'id' | 'projectId' | 'key' | 'title' | 'status' | 'assigneeId' | 'version'> {
  statusLabel: string;
  assigneeName: string | null;
}

export interface DeliveryScheduleConflict {
  predecessor: DeliveryBlockerIssue;
  type: DependencyType;
  lagDays: number;
  endpoint: 'startDate' | 'endDate';
  scheduledDate: string;
  requiredDate: string;
}

export interface DeliveryBlockerRow {
  issue: DeliveryBlockerIssue;
  priority: Priority;
  deadline: { value: string; source: 'dueDate' | 'endDate' } | null;
  blockers: { total: number; items: DeliveryBlockerIssue[] };
  scheduleConflicts: { total: number; items: DeliveryScheduleConflict[] };
  gitlab: { blockedMergeRequests: number; failedPipelines: number };
}

export interface DeliveryBlockerCounts {
  open: number;
  affected: number;
  reasons: Record<DeliveryBlockerReason, number>;
}

export interface DeliveryBlockerReport {
  projectId: string;
  generatedAt: string;
  savedView: Pick<SavedView, 'id' | 'name' | 'version'> | null;
  reason: DeliveryBlockerReason | null;
  counts: DeliveryBlockerCounts;
  revision: string;
  total: number;
  offset: number;
  limit: number;
  items: DeliveryBlockerRow[];
}
export interface ReportStatusDuration {
  completedVisits: ReportStatusVisitMetric[];
  openIssues: ReportOpenStatusIssue[];
}
export interface ProjectReport {
  definitionVersion: 1 | 2;
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
  statusDuration?: ReportStatusDuration;
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
export interface WorkflowStatus { id: string; label: string; color: string; category: StatusCategory; wipLimit?: number | null }
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
export interface MigrationFieldOption extends MigrationValueOption {
  suggestedKind: CustomFieldKind | 'archive';
  projectedDate?: 'startDate' | 'endDate';
}
export interface MigrationAppendTarget {
  projectId: string; key: string; name: string; instanceKey: string; sourceProjectId: string;
  statuses: WorkflowStatus[]; issueTypes: IssueTypeDefinition[]; fields: CustomFieldDefinition[];
}
export interface MigrationAppendConfiguration {
  projectId: string;
  statuses: Record<string, string>;
  issueTypes: Record<string, string>;
  fields: Record<string, string | null>;
  refreshExisting?: true;
  refreshCustomFields?: true;
  refreshHistory?: true;
  refreshAttachments?: true;
  refreshRelations?: true;
}
export const JIRA_MIGRATION_ISSUE_FIELDS = ['title', 'description', 'type', 'status', 'priority', 'assigneeId', 'labels', 'startDate', 'endDate', 'dueDate', 'estimate'] as const;
export type JiraMigrationIssueField = typeof JIRA_MIGRATION_ISSUE_FIELDS[number];
export type JiraMigrationIssueValues = Partial<Pick<Issue, JiraMigrationIssueField>> & {
  descriptionFormat?: IssueDescriptionFormat;
  customFields?: Record<string, CustomFieldValue>;
};
export type JiraMigrationIssueFieldHashes = Partial<Record<JiraMigrationIssueField, string>>;
export type JiraMigrationCustomFieldHashes = Record<string, { sourceFieldId: string; hash: string }>;
export interface JiraMigrationIssueReview {
  issueId: string; key: string; sourceKey: string;
  fields: { field: JiraMigrationIssueField; current: string; incoming: string; decision: 'apply' | 'conflict' }[];
  customFields?: { fieldId: string; label: string; current: string; incoming: string; decision: 'apply' | 'conflict' }[];
}
export interface MigrationPageAppendTarget {
  projectId: string; key: string; name: string; instanceKey: string; sourceSpaceId: string; sourceSpaceKey?: string;
}
export interface MigrationPageAppendConfiguration {
  projectId: string;
  refreshExisting?: true;
  refreshAttachments?: true;
  refreshHistory?: true;
}
export const CONFLUENCE_MIGRATION_DOCUMENT_FIELDS = ['title', 'content', 'labels'] as const;
export type ConfluenceMigrationDocumentField = typeof CONFLUENCE_MIGRATION_DOCUMENT_FIELDS[number];
export type ConfluenceMigrationDocumentValues = Partial<Pick<DocPage, ConfluenceMigrationDocumentField>>;
export type ConfluenceMigrationPageFieldHashes = Partial<Record<ConfluenceMigrationDocumentField, string>>;
export interface ConfluenceMigrationDocumentReview {
  documentId: string; title: string; sourceId: string; recordId: string;
  fields: { field: ConfluenceMigrationDocumentField; current: string; incoming: string; decision: 'apply' | 'conflict'; formatOnly?: true }[];
}
export interface MigrationOptions {
  packages:LegacyPackageSummary[];containers:MigrationContainerOption[];identities:MigrationIdentityOption[];
  statuses:MigrationValueOption[];issueTypes:MigrationValueOption[];fields:MigrationFieldOption[];
  defaultConfiguration:MigrationConfiguration;
  appendTarget?: MigrationAppendTarget;
  appendPagesTarget?: MigrationPageAppendTarget;
}
export interface MigrationConfiguration {
  packageIds:string[];projects:{containerId:string;key:string;name:string}[];
  users:Record<string,string|null>;statuses:Record<string,StatusCategory>;issueTypes:Record<string,string|null>;
  fields:Record<string,CustomFieldKind|'archive'>;sourceBaseUrls:Record<string,string|null>;
  timezone:string;datePolicy:'block'|'import-time';excludedRecords:string[];
  jiraReleaseSelections?: Record<string, string | null>;
  jiraSprintSelections?: Record<string, string | null>;
  appendTo?: MigrationAppendConfiguration;
  appendPagesTo?: MigrationPageAppendConfiguration;
}
export const MIGRATION_MAPPING_FILE_MAX_BYTES = 16 * 1024 * 1024;
export interface MigrationMappingFile {
  format: 'teamspace-migration-mapping';
  version: 1;
  packages: {
    id: string;
    sha256: string;
    product: LegacySource['product'];
    instanceKey: string;
    format: LegacySource['format'];
  }[];
  configuration: MigrationConfiguration;
  mappedUsers: Record<string, string>;
}
export interface MigrationMappingRestore {
  options: MigrationOptions;
  configuration: MigrationConfiguration;
}
export interface MigrationNotice { severity:'error'|'warning'|'info';code:string;message:string;recordId:string|null;requiresAcknowledgement:boolean }
export interface MigrationJiraPlanningChoice {
  recordId: string; sourceKey: string; title: string;
  candidates: { sourceId: string; name: string }[]; selected: string | null;
}
export interface MigrationPreview {
  id:string;version:number;actorId:string;createdAt:string;expiresAt:string;configuration:MigrationConfiguration;
  projects:{id:string;key:string;name:string;issueCount:number;documentCount:number}[];
  counts:Record<string,number>;notices:MigrationNotice[];requiredAcknowledgements:string[];canApply:boolean;
  samples:{recordId:string;targetType:'issue'|'document';title:string;plainText:string;content?:RichContent;sourceUrl?:string;schedule?:Pick<Issue,'startDate'|'endDate'>}[];
  issueRefresh?: JiraMigrationIssueReview[];
  jiraRelationRefresh?: { recordId: string; sourceKey: string; targetKey: string; type: string }[];
  documentRefresh?: ConfluenceMigrationDocumentReview[];
  jiraReleaseChoices?: MigrationJiraPlanningChoice[];
  jiraSprintChoices?: MigrationJiraPlanningChoice[];
}
export interface SourceImport {
  id:string;version:number;createdAt:string;actorId:string;projectIds:string[];configuration:MigrationConfiguration;
  packages:{stagingId:string;filename:string;sha256:string;source:LegacySource}[];counts:Record<string,number>;
  notices?:MigrationNotice[];
  integrity?:SourceImportIntegrity;
}
export interface SourceImportIntegrityPackage {
  stagingId: string;
  recordCount: number;
  boundAttachmentCount: number;
  recordsSha256: string;
}
export interface SourceImportIntegrity {
  version: 1;
  packages: SourceImportIntegrityPackage[];
}
export interface SourceRecordArchive {
  id:string;sourceImportId:string;packageSha256:string;source:LegacySource;record:LegacyRecord;
  targetType:'project'|'issue'|'document'|'comment'|'revision'|'attachment'|null;targetId:string|null;targetProjectId:string|null;
  ownerType:'issue'|'document'|null;ownerId:string|null;
  excluded?:true;
  jiraIssueFieldHashes?: JiraMigrationIssueFieldHashes;
  jiraCustomFieldHashes?: JiraMigrationCustomFieldHashes;
  jiraHistoryAppend?: true;
  jiraAttachmentAppend?: true;
  jiraRelationId?: string;
  confluencePageFieldHashes?: ConfluenceMigrationPageFieldHashes;
}
export interface AttachmentVersion extends Attachment { attachmentId:string;versionLabel:string;sourceImportId:string|null;sourceRecordId:string|null;localRevision?:number;sourceRevision?:number }
export type IssueRelationType = 'related' | 'blocks' | 'duplicates';
export type IssueRelationDirection = 'outgoing' | 'incoming';
export interface IssueRelation { id:string;sourceIssueId:string;targetIssueId:string;type:string;version:number;createdAt:string;origin?:'teamspace' }
export type TeamScheduleBlocker = Pick<IssueRelation, 'id' | 'sourceIssueId' | 'targetIssueId' | 'version'>;
export interface MigrationApplyResult { import:SourceImport;duplicate:boolean }
export type SourceRecordSummary=Omit<SourceRecordArchive,'record'>&{record:LegacyRecordSummary;originalAuthorName:string|null};
export interface SourceRecordPage { records:SourceRecordSummary[];total:number;offset:number;limit:number }
export interface JiraIssueStatusValue {
  id: string | null;
  label: string | null;
}
export interface JiraIssueStatusHistoryEntry {
  id: string;
  sourceImportId: string;
  sourceRecordId: string;
  changedAt: string | null;
  originalChangedAt: string | null;
  originalAuthorName: string | null;
  from: JiraIssueStatusValue;
  to: JiraIssueStatusValue;
}
export interface JiraIssueStatusHistoryPage {
  entries: JiraIssueStatusHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}
export type SourceReconciliationStatus = 'linked' | 'trashed' | 'missing' | 'archive-only' | 'excluded';
export interface SourceReconciliationOwner {
  type: 'issue' | 'document'; id: string; label: string; projectId: string | null;
}
export interface SourceReconciliationTarget {
  type: NonNullable<SourceRecordArchive['targetType']> | 'worklog'; id: string;
  label: string; projectId: string | null; owner: SourceReconciliationOwner | null;
}
export interface SourceReconciliationRow {
  sourceRecordId: string; kind: LegacyRecordKind; sourceId: string; sourceKey: string | null;
  title: string; product: LegacySource['product']; sourceInstance: string;
  status: SourceReconciliationStatus; target: SourceReconciliationTarget | null;
}
export interface SourceReconciliationPage {
  importId: string; receiptVersion: number; counts: Record<SourceReconciliationStatus, number>;
  rows: SourceReconciliationRow[]; total: number; offset: number; limit: number;
}
export interface SourceReconciliationFileCheck {
  sourceRecordId: string; status: 'verified' | 'missing' | 'corrupt' | 'unbound';
  fileId: string | null; size: number | null; sha256: string | null;
}
export type SourceReconciliationAuditStatus = SourceReconciliationFileCheck['status'] | 'excluded' | 'unreadable';
export interface SourceReconciliationAuditAttachment extends Omit<SourceReconciliationFileCheck, 'status'> {
  sourceId: string;
  title: string;
  product: LegacySource['product'];
  sourceInstance: string;
  packageSha256: string;
  recordStatus: SourceReconciliationStatus;
  status: SourceReconciliationAuditStatus;
}
export interface SourceReconciliationIntegrityCount {
  expected: number | null;
  observed: number;
}
export interface SourceReconciliationIntegrityPackage {
  stagingId: string;
  filename: string;
  status: 'verified' | 'mismatch' | 'unavailable';
  records: SourceReconciliationIntegrityCount;
  boundAttachments: SourceReconciliationIntegrityCount;
  recordsSha256: { expected: string | null; observed: string };
}
export interface SourceReconciliationIntegrity {
  status: 'verified' | 'mismatch' | 'counts-only' | 'unavailable';
  records: SourceReconciliationIntegrityCount;
  boundAttachments: SourceReconciliationIntegrityCount;
  unmatchedRecords: number;
  columnMismatches: number;
  packages: SourceReconciliationIntegrityPackage[];
}
export interface SourceReconciliationContentDigest {
  count: number;
  sha256: string;
}
export interface SourceReconciliationTargetContent {
  version: 1;
  comments: SourceReconciliationContentDigest;
  revisions: SourceReconciliationContentDigest;
  worklogs: SourceReconciliationContentDigest;
  issueRelations: SourceReconciliationContentDigest;
}
export interface SourceReconciliationJiraStatusHistory {
  sourceChanges: number;
  projected: SourceReconciliationContentDigest;
  duplicate: number;
  excluded: number;
  restricted: number;
  unavailable: number;
  unresolvedTime: number;
  unresolvedAuthor: number;
}
export type SourceReconciliationJiraFinding = 'unavailable' | 'restricted' | 'excluded' | 'unresolved-time' | 'unresolved-author';
export interface SourceReconciliationJiraStatusFinding {
  sourceRecordId: string;
  sourceId: string;
  sourceInstance: string;
  sourceIssueId: string | null;
  changeCount: number;
  reason: 'issue-in-trash' | 'issue-unavailable' | 'ownership-unverified' | null;
}
export interface SourceReconciliationJiraStatusFindingsPage {
  importId: string;
  receiptVersion: number;
  finding: SourceReconciliationJiraFinding;
  rows: SourceReconciliationJiraStatusFinding[];
  total: number;
  totalChanges: number;
  offset: number;
  limit: number;
  fingerprint: string;
}
export interface SourceReconciliationAudit {
  importId: string;
  receiptVersion: number;
  startedAt: string;
  completedAt: string;
  integrity: SourceReconciliationIntegrity;
  recordCounts: SourceReconciliationPage['counts'];
  targetContent: SourceReconciliationTargetContent;
  jiraStatusHistory: SourceReconciliationJiraStatusHistory | null;
  attachmentCounts: Record<SourceReconciliationAuditStatus, number>;
  attachments: SourceReconciliationAuditAttachment[];
}
export interface Project { id: string; key: string; name: string; description: string; color: string; createdAt: string }
export type PlanningKind = 'cycle' | 'module' | 'release';
export type PlanningStatus = 'planned' | 'active' | 'completed' | 'archived';
export interface PlanningItem {
  id: string; projectId: string; kind: PlanningKind; name: string; description: string;
  status: PlanningStatus; ownerId: string | null; startDate: string | null; endDate: string | null; targetDate: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export type CycleCompletionPlan = Pick<PlanningItem, 'id' | 'name' | 'version'>;
export interface CycleCompletionCounts { carry: number; done: number; cancelled: number; blocked: number }
export interface CycleCompletionIssue {
  id: string; key: string; title: string; statusId: string; statusLabel: string;
  disposition: 'carry' | 'done' | 'cancelled'; blockedReason?: string;
}
export interface CycleCompletionPreview {
  previewId: string | null; expiresAt: string | null;
  cycle: CycleCompletionPlan; destination: CycleCompletionPlan | null;
  counts: CycleCompletionCounts; issues: CycleCompletionIssue[];
}
export interface CycleCompletionResult {
  cycle: PlanningItem; destination: CycleCompletionPlan | null; counts: CycleCompletionCounts;
  recordId?: string;
}
export interface CycleCompletionRecordSummary {
  id: string;
  projectId: string;
  cycle: CycleCompletionPlan & Pick<PlanningItem, 'startDate' | 'endDate' | 'targetDate'>;
  destination: CycleCompletionPlan | null;
  actorId: string;
  actorName: string;
  completedAt: string;
  counts: Pick<CycleCompletionCounts, 'carry' | 'done' | 'cancelled'>;
}
export type CycleCompletionRecordedIssue = Omit<CycleCompletionIssue, 'blockedReason'> & {
  assigneeId: string | null;
  assigneeName: string | null;
};
export interface CycleCompletionRecord extends CycleCompletionRecordSummary {
  issues: CycleCompletionRecordedIssue[];
}
export interface CycleCompletionRecordsPage {
  items: CycleCompletionRecordSummary[];
  nextCursor: string | null;
}
export type ApiKeyAccess = 'read' | 'write';
export interface ApiKeyRecord {
  id: string; name: string; prefix: string; actorId: string; access: ApiKeyAccess; projectIds: string[] | null;
  version: number; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
}
export interface ApiKeyCreated { key: ApiKeyRecord; token: string }
export interface CalendarException { date: string; isWorking: boolean; label: string }
export interface WorkCalendar { id: string; projectId: string; name: string; workingWeekdays: number[]; exceptions: CalendarException[]; version: number; updatedAt: string }
export interface WorkloadCapacityValues {
  defaultDailyMinutes: number;
  members: { userId: string; dailyMinutes: number }[];
  exceptions: { userId: string; date: string; availableMinutes: number }[];
}
export interface ProjectWorkloadCapacity extends WorkloadCapacityValues {
  id: string;
  projectId: string;
  version: number;
  updatedAt: string;
}
export interface TeamWorkloadCapacity extends WorkloadCapacityValues {
  version: number;
  updatedAt: string;
  workingWeekdays: number[];
  calendarExceptions: CalendarException[];
}
export type WorkloadIncompleteReason = 'unassigned' | 'missing-dates' | 'missing-effort' | 'no-working-days';
export interface ProjectWorkloadDay { date: string; working: boolean }
export interface WorkloadAllocation { issueId: string; minutes: number }
export interface ProjectWorkloadCell<Allocation extends WorkloadAllocation = WorkloadAllocation> {
  date: string;
  scheduledMinutes: number;
  availableMinutes: number;
  allocations: Allocation[];
}
export interface ProjectWorkloadRow<Allocation extends WorkloadAllocation = WorkloadAllocation> {
  userId: string;
  scheduledMinutes: number;
  availableMinutes: number;
  overloadedDays: number;
  days: ProjectWorkloadCell<Allocation>[];
}
export interface ProjectWorkloadResult {
  startDate: string;
  endDate: string;
  days: ProjectWorkloadDay[];
  rows: ProjectWorkloadRow[];
  incomplete: { issueId: string; reasons: WorkloadIncompleteReason[] }[];
  totalScheduledMinutes: number;
  totalAvailableMinutes: number;
  overloadedCells: number;
}
export interface TeamWorkloadAllocation extends WorkloadAllocation { projectId: string }
export interface TeamWorkloadResult extends Omit<ProjectWorkloadResult, 'rows' | 'incomplete'> {
  projectIds: string[];
  capacityVersion: number;
  rows: ProjectWorkloadRow<TeamWorkloadAllocation>[];
  incomplete: { issueId: string; projectId: string; reasons: WorkloadIncompleteReason[] }[];
}
export interface Milestone { id: string; projectId: string; title: string; description: string; date: string; status: 'open' | 'reached'; ownerId: string | null; issueIds: string[]; version: number; createdAt: string; updatedAt: string }
export interface BaselineIssue { issueId: string; key: string; title: string; startDate: string | null; endDate: string | null; sourceVersion: number }
export interface BaselineMilestone { milestoneId: string; title: string; date: string; status: 'open' | 'reached'; sourceVersion: number }
export interface ScheduleBaseline { id: string; projectId: string; name: string; description: string; authorId: string; version: number; createdAt: string; calendar: WorkCalendar; issues: BaselineIssue[]; milestones: BaselineMilestone[] }
export interface IssueTypeDefinition { id: string; name: string; color: string; archived: boolean }
export type CustomFieldKind = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'checkbox' | 'user' | 'url';
export interface CustomFieldOption { id: string; name: string; archived: boolean }
export interface CustomFieldVisibility {
  statusIds: string[];
  fieldMatch: { fieldId: string; value: string | boolean } | null;
}
export interface CustomFieldDefinition { id: string; name: string; description: string; kind: CustomFieldKind; required: boolean; issueTypes: string[]; options: CustomFieldOption[]; archived: boolean; visibleWhen?: CustomFieldVisibility }
export type CustomFieldValue = string | number | boolean | string[] | null;
export interface ProjectIssueSchema { id: string; projectId: string; version: number; issueTypes: IssueTypeDefinition[]; fields: CustomFieldDefinition[]; updatedAt: string }
export type IssueDescriptionFormat = 'plain' | 'markdown';
export interface Issue {
  id: string; key: string; projectId: string; title: string; description: string;
  descriptionFormat?: IssueDescriptionFormat;
  type: string; status: IssueStatus; priority: Priority; assigneeId: string | null;
  collaboratorIds: string[]; parentId: string | null; labels: string[];
  startDate: string | null; endDate: string | null; dueDate: string | null;
  estimate: number | null; cycle: string | null; module: string | null; release: string | null;
  plannedEffortMinutes?: number | null;
  cycleId?: string | null; moduleId?: string | null; releaseId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  version: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface IssueChildCreationResult { issue: Issue; duplicate: boolean }
export interface IssueCloneResult { issue: Issue; relation: IssueRelation | null; duplicate: boolean }
export interface IssuePasteDiagnostic { line: number | null; message: string }
export interface IssuePastePreviewRow extends Pick<Issue,
  'title' | 'description' | 'type' | 'status' | 'priority' | 'assigneeId' | 'startDate' | 'endDate' | 'dueDate' | 'labels'
> {
  line: number;
  typeName: string;
  statusLabel: string;
  assigneeLabel: string | null;
}
export interface IssuePastePreview {
  previewId: string | null;
  rows: IssuePastePreviewRow[];
  errors: IssuePasteDiagnostic[];
}
export interface IssuePasteResult { issues: Issue[]; duplicate: boolean }
export const ISSUE_BULK_EDIT_LIMIT = 100;
export const ISSUE_BULK_LABEL_LIMIT = 100;
export const ISSUE_BULK_LABEL_MAX_LENGTH = 60;
export const WORKFLOW_STATUS_MIGRATION_LIMIT = 1_000;
export interface WorkflowStatusMigrationPreviewInput {
  fromStatusId: string;
  toStatusId: string;
  expectedWorkflowVersion: number;
}
export type IssueBulkEditValues = Pick<Issue, 'status' | 'priority' | 'assigneeId'> & Partial<Pick<Issue, 'dueDate' | 'labels'>>;
export type IssueBulkEditChanges = Partial<Pick<Issue, 'status' | 'priority' | 'assigneeId' | 'dueDate'>> & {
  addLabels?: string[];
  removeLabels?: string[];
};
export interface IssueBulkEditPreviewInput {
  issues: { id: string; expectedVersion: number }[];
  changes: IssueBulkEditChanges;
}
export interface IssueBulkEditRow extends Pick<Issue, 'id' | 'key' | 'title'> {
  outcome: 'changed' | 'unchanged' | 'blocked';
  before: IssueBulkEditValues;
  after: IssueBulkEditValues | null;
  reason: string | null;
}
export interface IssueBulkEditPreview {
  previewId: string | null;
  expiresAt: string | null;
  rows: IssueBulkEditRow[];
  changed: number;
  unchanged: number;
  blocked: number;
}
export interface IssueBulkEditResult {
  previewId: string;
  updated: Pick<Issue, 'id' | 'key' | 'version'>[];
  unchanged: number;
}
export interface WorklogEntry {
  id: string;
  issueId: string;
  projectId: string;
  issueKey: string;
  issueTitle: string;
  authorId: string;
  workDate: string;
  minutes: number;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceRecordId?: string;
  durationSeconds?: number;
}
export interface IssueWorklogPage { entries: WorklogEntry[]; totalMinutes: number; totalEntries: number }
export interface IssueTimeReservation {
  id: string;
  issueId: string;
  userId: string;
  startAt: string;
  endAt: string;
  version: number;
  state: 'reserved' | 'needs-review';
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}
export interface IssueTimeReservationEntry extends IssueTimeReservation {
  projectId: string;
  issueKey: string;
  issueTitle: string;
}
export const TEAM_OVERVIEW_ISSUE_METRICS = ['open', 'overdue', 'dueSoon', 'unscheduled', 'unassigned'] as const;
export type TeamOverviewIssueMetric = typeof TEAM_OVERVIEW_ISSUE_METRICS[number];
export function isTeamOverviewIssueMetric(value: unknown): value is TeamOverviewIssueMetric {
  return TEAM_OVERVIEW_ISSUE_METRICS.some(metric => metric === value);
}
export interface TeamOverviewFilters {
  projectId: string;
  memberId: string;
  date: string;
  issueMetric?: TeamOverviewIssueMetric;
  issueOffset?: number;
}
export interface TeamBoardFilters {
  projectId?: string;
  memberId?: string | null;
  query?: string;
  gitlab?: IssueViewGitlabFilter;
}
export type TeamOverviewCounts = Record<TeamOverviewIssueMetric, number>;
export interface TeamOverviewProject extends TeamOverviewCounts { projectId: string }
export interface TeamOverviewDeadline {
  id: string;
  projectId: string;
  key: string;
  title: string;
  assigneeId: string | null;
  statusLabel: string;
  statusColor: string;
  deadline: string;
  deadlineSource: 'dueDate' | 'endDate';
  timing: 'overdue' | 'today' | 'soon';
}
export interface TeamOverviewIssueQueueItem extends Omit<TeamOverviewDeadline, 'deadline' | 'deadlineSource' | 'timing'> {
  startDate: string | null;
  endDate: string | null;
  priority: Priority;
  deadline: TeamOverviewDeadline['deadline'] | null;
  deadlineSource: TeamOverviewDeadline['deadlineSource'] | null;
  timing: TeamOverviewDeadline['timing'] | 'later' | null;
}
export interface TeamOverviewGitlabActivity {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  projectId: string;
  link: GitlabLink;
}
export interface TeamOverviewPage<T> { items: T[]; total: number; offset: number; limit: number }
export interface TeamOverviewResult {
  date: string;
  timeZone: string;
  totals: TeamOverviewCounts;
  projects: TeamOverviewProject[];
  deadlines: TeamOverviewPage<TeamOverviewDeadline>;
  issueQueue?: TeamOverviewPage<TeamOverviewIssueQueueItem> & { metric: TeamOverviewIssueMetric };
  reviews: TeamOverviewPage<DocumentPublicationListItem>;
  gitlab: TeamOverviewPage<TeamOverviewGitlabActivity>;
  reservations: TeamOverviewPage<IssueTimeReservationEntry>;
}
export interface ProjectWorklogReport {
  projectId: string;
  startDate: string;
  endDate: string;
  authorId: string | null;
  minutes: number;
  entryCount: number;
  byAuthor: { authorId: string; minutes: number; entries: number }[];
  byIssue: { issueId: string; key: string; title: string; deleted: boolean; minutes: number; entries: number }[];
  days: { date: string; minutes: number; entries: number }[];
}
export interface RichContent { type: string; content?: RichContent[]; text?: string; attrs?: Record<string, unknown>; marks?: {type: string; attrs?: Record<string, unknown>}[] }
export interface ContentReference { type: 'issue' | 'document'; id: string; kind: 'reference' | 'include'; label: string; revisionId?: string }
export interface DocPage {
  id: string; projectId: string | null; parentId: string | null; title: string;
  content: RichContent; plainText: string; icon: string; status: 'draft' | 'published';
  version: number; authorId: string; createdAt: string; updatedAt: string;
  labels?: string[];
}
export interface DocumentTemplateSummary {
  id: string;
  projectId: string | null;
  name: string;
  icon: string;
  sourceDocumentId: string;
  sourceTitle: string;
  sourceVersion: number;
  attachmentCount?: number;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
export interface DocumentTemplate extends DocumentTemplateSummary { content: RichContent }
export interface DocumentTreeMovePreview {
  token: string;
  documentId: string;
  sourceProjectId: string | null;
  sourceParentId: string | null;
  projectId: string | null;
  parentId: string | null;
  documents: { id: string; title: string }[];
  archivedCount: number;
  changed: boolean;
}
export interface DocumentTreeCopyOptions {
  title: string;
  projectId: string | null;
  parentId: string | null;
  includeDescendants: boolean;
  expectedSourceVersion: number;
}
export interface DocumentSiblingOrder {
  projectId: string | null;
  parentId: string | null;
  documentIds: string[];
  version: string;
}
export interface DocumentTreeCopyPreview extends DocumentTreeCopyOptions {
  sourceDocumentId: string;
  token: string;
  documents: Pick<DocPage, 'id' | 'title' | 'version'>[];
  attachmentCount: number;
  attachmentBytes: number;
  warnings: string[];
}
export interface DocRevision { id: string; documentId: string; version: number; title: string; content: RichContent; plainText: string; authorId: string; createdAt: string; summary: string; confluenceSourceVersion?: number }
export interface DocumentReview {
  revisionId: string;
  requestedById: string;
  reviewerId: string;
  requestedAt: string;
  note: string;
  changesRequested: { byId: string; at: string; note: string } | null;
}
export interface DocumentPublishedVersion {
  revisionId: string;
  publishedById: string;
  publishedAt: string;
  note: string;
  requestedById: string;
  reviewerId: string;
  requestedAt: string;
}
export interface DocumentPublicationState {
  documentId: string;
  version: number;
  review: DocumentReview | null;
  published: DocumentPublishedVersion | null;
}
export interface DocumentPublicationView extends DocumentPublicationState {
  workspaceGeneration: string | null;
  documentVersion: number;
  reviewRevision: Pick<DocRevision, 'id' | 'version' | 'title'> | null;
  publishedRevision: Pick<DocRevision, 'id' | 'version' | 'title'> | null;
}
export type DocumentPublicationListTab = 'assigned' | 'requested' | 'published';
export type DocumentPublicationScope = 'workspace' | 'project' | 'common';
export type DocumentPublicationTarget = { kind: 'review' | 'published'; revisionId: string };
export interface DocumentPublicationListItem {
  documentId: string;
  projectId: string | null;
  documentVersion: number;
  revision: Pick<DocRevision, 'id' | 'version' | 'title'>;
  status: 'pending' | 'changes_requested' | 'published';
  requestedById: string;
  reviewerId: string;
  actionAt: string;
}
export interface DocumentPublicationList {
  tab: DocumentPublicationListTab;
  scope: DocumentPublicationScope;
  projectId: string | null;
  offset: number;
  total: number;
  pendingAssigned: number;
  items: DocumentPublicationListItem[];
}
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';
export interface Dependency { id: string; predecessorId: string; successorId: string; type: DependencyType; lagDays: number; version?: number }
export interface DocumentSourceSelection { from: number; to: number; text: string }
export interface DocumentDecisionSource extends DocumentSourceSelection { revisionId: string }
export interface ResourceLink { id: string; issueId: string; documentId: string; kind: string; documentSource?: DocumentDecisionSource }

export interface DecisionFollowUpItem {
  linkId: string;
  issue: Pick<Issue, 'id' | 'projectId' | 'key' | 'title' | 'status' | 'assigneeId'> & {
    statusLabel: string;
    statusColor: string;
    statusCategory: StatusCategory;
    deadline: string | null;
    deadlineSource: 'dueDate' | 'endDate' | null;
  };
  document: Pick<DocPage, 'id' | 'projectId' | 'title'>;
  source: Omit<DocumentDecisionSource, 'text'> & { version: number; title: string; createdAt: string };
}

export interface DecisionFollowUpPage {
  projectId: string | null;
  total: number;
  offset: number;
  limit: number;
  items: DecisionFollowUpItem[];
}

export interface DecisionFollowUpSource {
  linkId: string;
  documentId: string;
  source: DocumentDecisionSource;
}
export interface DocumentIssueLinkResult { issue: Issue; link: ResourceLink; duplicate: boolean }
export type DocumentFollowUpResult = DocumentIssueLinkResult;
export const MAX_COMMENT_MENTIONS = 50;
export interface CommentMention { userId: string; from: number; to: number }
export type DocumentCommentResolutionState = 'open' | 'resolved';
export interface DocumentCommentResolution {
  state: DocumentCommentResolutionState;
  version: number;
  changedAt: string;
  actorId: string;
}
export interface Comment {
  id: string;
  resourceType: 'issue' | 'document';
  resourceId: string;
  authorId: string;
  body: string;
  createdAt: string;
  documentSource?: DocumentDecisionSource;
  parentCommentId?: string;
  mentions?: CommentMention[];
  resolution?: DocumentCommentResolution;
}
export interface DocumentSelectionCommentResult { comment: Comment; duplicate: boolean }
export interface DocumentCommentReplyResult { comment: Comment; duplicate: boolean }
export interface Attachment { id: string; resourceType: 'issue' | 'document'; resourceId: string; filename: string; mimeType: string; size: number; sha256: string; authorId: string; createdAt: string; versionCount?: number }
export interface AttachmentHead extends Attachment { currentVersionId: string; versionCount: number; hasVersionHistory: boolean }
export type TrashResourceType = 'issue' | 'document';
export interface TrashEntrySummary {
  id: string;
  resourceType: TrashResourceType;
  resourceId: string;
  projectId: string | null;
  title: string;
  issueKey: string | null;
  deletedAt: string;
  deletedById: string;
  parentId: string | null;
}
export interface TrashPage { items: TrashEntrySummary[]; total: number; offset: number; limit: number }
export interface TrashRestoreResult {
  resourceType: TrashResourceType;
  resourceId: string;
  projectId: string | null;
  warnings: string[];
}
export type TrashItemType = 'comment' | 'attachment';
export interface TrashItemSummary {
  id: string;
  itemType: TrashItemType;
  itemId: string;
  ownerType: TrashResourceType;
  ownerId: string;
  ownerTitle: string;
  ownerIssueKey: string | null;
  ownerAvailable: boolean;
  projectId: string | null;
  title: string;
  deletedAt: string;
  deletedById: string;
  authorId: string;
  versionCount: number | null;
}
export interface TrashItemPage { items: TrashItemSummary[]; total: number; offset: number; limit: number }
export interface Activity { id: string; resourceType: string; resourceId: string; actorId: string; action: string; detail: string; createdAt: string }
export const ISSUE_RISK_NOTIFICATION_KINDS = ['issue-block-added', 'issue-block-resolved', 'issue-deadline-postponed'] as const;
export const ISSUE_DEADLINE_REMINDER_KINDS = ['issue-deadline-upcoming', 'issue-deadline-today', 'issue-deadline-overdue'] as const;
export const COMMENT_MENTION_NOTIFICATION_KINDS = ['issue-comment-mentioned', 'document-comment-mentioned'] as const;
export const TEAM_NOTIFICATION_KINDS = [
  'issue-assigned', 'issue-created', 'issue-comment', 'issue-status-changed', ...ISSUE_RISK_NOTIFICATION_KINDS,
  ...ISSUE_DEADLINE_REMINDER_KINDS, ...COMMENT_MENTION_NOTIFICATION_KINDS,
  'document-created', 'document-comment', 'document-comment-reply', 'document-updated', 'document-review-requested',
  'document-changes-requested', 'document-published', 'document-review-withdrawn',
] as const;
export type TeamNotificationKind = typeof TEAM_NOTIFICATION_KINDS[number];
export type TeamNotificationFilter = 'all' | 'unread';
export interface TeamNotification {
  id: string;
  recipientId: string;
  actorId: string | null;
  kind: TeamNotificationKind;
  projectId: string | null;
  targetId: string;
  targetLabel: string;
  commentId?: string;
  detail?: string;
  createdAt: string;
  readAt: string | null;
}
export interface TeamNotificationPage {
  items: TeamNotification[];
  nextCursor: string | null;
  unreadCount: number;
}
export const MAX_DEADLINE_REMINDER_DAYS = 14;
export interface DeadlineReminderPreferences {
  daysBefore: number;
  onDueDate: boolean;
  overdue: boolean;
  version: string | null;
}
export type DeadlineReminderPreferenceRecord = DeadlineReminderPreferences & { userId: string; version: string };
export type NotificationSubscriptionTarget = 'issue' | 'document' | 'project' | 'space';
export const COMMON_DOCUMENT_NOTIFICATION_SPACE_ID = 'common';
export const PROJECT_DOCUMENT_NOTIFICATION_SPACE_PREFIX = 'project:';
export function documentNotificationSpaceId(projectId: string | null): string {
  return projectId === null ? COMMON_DOCUMENT_NOTIFICATION_SPACE_ID : `${PROJECT_DOCUMENT_NOTIFICATION_SPACE_PREFIX}${projectId}`;
}
export interface NotificationSubscription {
  userId: string;
  targetType: NotificationSubscriptionTarget;
  targetId: string;
}
export interface NotificationSubscriptionState { subscribed: boolean }
export type GitlabMergeReadinessState = 'ready' | 'checking' | 'draft' | 'conflict' | 'approval_required' | 'changes_requested' |
  'discussions_unresolved' | 'ci_required' | 'ci_running' | 'rebase_required' | 'dependency' | 'policy' | 'blocked' | 'unknown';
export interface GitlabMergeReadiness {
  state: GitlabMergeReadinessState;
  observedAt: string;
  source: 'read' | 'webhook';
}
export interface GitlabLink { id: string; issueId: string; projectId: number; iid: number; kind: 'merge_request' | 'commit' | 'pipeline' | 'branch'; title: string; webUrl: string; state: string; updatedAt: string; sourceBranch?: string; sourceSha?: string; branchObservationSource?: 'sync'; originalJiraKey?: string; manualLinkId?: string; mergeReadiness?: GitlabMergeReadiness; mergeCommitShas?: string[] }
export const GITLAB_DEPLOYMENT_STATES = ['created', 'blocked', 'running', 'success', 'failed', 'canceled', 'skipped'] as const;
export type GitlabDeploymentState = typeof GITLAB_DEPLOYMENT_STATES[number];
export interface GitlabDeploymentMergeRequest { id: number; iid: number }
export interface GitlabDeployment {
  instance: string;
  repositoryId: number;
  deploymentId: number;
  environment: string;
  environmentTier?: string;
  sha: string;
  status: GitlabDeploymentState;
  changedAt: string;
  projectUrl: string;
  jobUrl?: string;
  source?: 'sync';
  mergeRequests?: GitlabDeploymentMergeRequest[];
}
export interface GitlabDeploymentPage { items: GitlabDeployment[]; total: number; offset: number; limit: number }
export interface GitlabDeploymentSyncResult {
  repositoryId: number;
  settingsVersion: number;
  deploymentsRead: number;
  deploymentsStored: number;
  mergeRequestsStored: number;
  associationUnavailable: number;
  associationLimited: number;
  deploymentLimitReached: boolean;
}
export interface GitlabJiraSource { projectId: string; jiraInstanceKey: string }
export interface GitlabJiraRoute extends GitlabJiraSource { repositoryId: number }
export interface GitlabSettings { baseUrl: string; projectIds: number[]; tokenConfigured: boolean; webhookSecretConfigured: boolean; signingTokenConfigured: boolean; version: number; lastSyncAt: string | null; lastError: string | null; jiraRoutes?: GitlabJiraRoute[]; webhookReceiverUrl?: string }
export interface GitlabRepositoryCandidate { id: number; name: string; pathWithNamespace: string; webUrl: string }
export interface GitlabRepositorySearch {
  settingsVersion: number;
  page: number;
  hasNextPage: boolean;
  repositories: GitlabRepositoryCandidate[];
}
export interface GitlabWebhookDelivery {
  event: 'push' | 'tag_push' | 'merge_request' | 'pipeline' | 'deployment' | 'other';
  authentication: 'secret-token' | 'signing-token';
  receivedAt: string;
  duplicate: boolean;
  linked: number;
  automationRuns: number;
  deploymentUpdated?: true;
}
export interface GitlabWebhookStatus {
  settingsVersion: number;
  repositories: { repositoryId: number; lastDelivery: GitlabWebhookDelivery | null }[];
}
export interface GitlabSyncPreviewCounts {
  mergeRequests: number; pipelines: number; matched: number; unmatched: number; skipped: number;
  create: number; update: number; unchanged: number;
  branches?: number; commits?: number;
}
export interface GitlabSyncPreviewCandidate {
  projectId: number; kind: GitlabLink['kind']; objectId: string; title: string; state: string;
  issueId: string; issueKey: string; issueTitle: string; action: 'create' | 'update' | 'unchanged'; originalJiraKey?: string;
}
export interface GitlabHistoryLimits { branches: boolean; commits: boolean }
interface GitlabSyncRepositoryCounts {
  projectId: number; counts: GitlabSyncPreviewCounts; historyLimits?: GitlabHistoryLimits; ambiguousKeys?: string[];
}
export interface GitlabSyncRepositoryFailure extends GitlabSyncRepositoryCounts {
  status: 'error';
  error: { stage: 'merge-requests' | 'pipelines' | 'project' | 'branches' | 'commits'; httpStatus: number | null; message: string };
}
export type GitlabSyncRepositoryResult = GitlabSyncRepositoryFailure | (GitlabSyncRepositoryCounts & {
  status: 'ok'; error: null;
});
export interface GitlabSyncFailure {
  settingsVersion: number; reason: string; repositories: GitlabSyncRepositoryFailure[];
}
export interface GitlabSyncResult {
  ok: true; scanned: number; linked: number; settings: GitlabSettings; notice: string;
  partial: boolean; repositories: GitlabSyncRepositoryResult[];
  historyCounts?: { branches: number; commits: number }; historyLimits?: GitlabHistoryLimits;
}
export interface GitlabSyncPreview {
  settingsVersion: number; baseUrl: string; projectIds: number[];
  repositories: GitlabSyncRepositoryResult[];
  counts: GitlabSyncPreviewCounts; candidates: GitlabSyncPreviewCandidate[]; candidatesTruncated: boolean;
}
export type GitlabAutomationTrigger = 'merge_request.opened' | 'merge_request.merged' | 'merge_request.closed' | 'pipeline.succeeded' | 'pipeline.failed' | 'deployment.succeeded';
export interface AutomationRule {
  id: string; projectId: string; name: string; enabled: boolean; trigger: GitlabAutomationTrigger;
  gitlabProjectIds: number[]; branchPattern: string; environment?: string; issueTypes: string[]; fromStatuses: string[]; toStatusId: string;
  actorId: string; priority: number; gitlabBaseUrl: string; enabledAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export interface AutomationEvent {
  id: string; trigger: GitlabAutomationTrigger; gitlabProjectId: number; objectKind: 'merge_request' | 'pipeline' | 'deployment'; objectId: string;
  branch: string; environment?: string; issueIds: string[]; occurredAt: string | null; receivedAt: string;
  disposition: 'fresh' | 'stale' | 'ambiguous' | 'unverified'; reason: string;
}
export interface AutomationOutcome {
  issueId: string; key: string; title: string; fromStatus: string; toStatus: string;
  outcome: 'changed' | 'no_op' | 'blocked' | 'ignored'; reason: string;
}
export interface AutomationRunContext {
  ruleName: string; trigger: GitlabAutomationTrigger; gitlabBaseUrl: string; gitlabProjectId: number;
  objectKind: AutomationEvent['objectKind']; objectId: string; branch: string; environment?: string;
  fromStatusLabel: string; toStatusLabel: string;
}
export interface AutomationRun extends AutomationOutcome {
  id: string; eventId: string; ruleId: string; projectId: string; actorId: string; createdAt: string; occurredAt: string | null;
  context?: AutomationRunContext;
}
export interface IssueAutomationRunPage { issueVersion: number; items: AutomationRun[]; nextCursor: string | null; latestBlockedRunId: string | null }
export interface AutomationPreview { outcomes: AutomationOutcome[]; warnings: string[] }
export interface IssueAssignmentRuleInput {
  name: string;
  enabled: boolean;
  fromStatuses: string[];
  toStatusId: string;
  issueTypes: string[];
  assigneeId: string;
  mode: 'unassigned' | 'replace';
  priority: number;
}
export interface IssueAssignmentRule extends IssueAssignmentRuleInput {
  id: string;
  projectId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface IssueAssignmentOutcome {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  fromStatusId: string;
  toStatusId: string;
  previousAssigneeId: string | null;
  assigneeId: string | null;
  outcome: 'assigned' | 'unchanged' | 'skipped' | 'blocked';
  reason: string;
}
export interface IssueAssignmentRun extends Omit<IssueAssignmentOutcome, 'outcome'> {
  id: string;
  projectId: string;
  ruleId: string;
  ruleName: string;
  actorId: string;
  source: 'user' | 'gitlab';
  sourceEventId: string | null;
  issueVersion: number;
  outcome: 'assigned' | 'unchanged' | 'skipped';
  createdAt: string;
}
export interface IssueAssignmentRunPage { items: IssueAssignmentRun[]; total: number; offset: number; limit: number }
export interface IssueAssignmentPreview { outcomes: IssueAssignmentOutcome[] }
export type OutboundEventType = 'issue.created' | 'issue.updated' | 'issue.deleted' | 'document.created' | 'document.updated' | 'document.deleted' | 'comment.created';
export type MutationOrigin = 'user' | 'gitlab' | 'automation' | 'system' | 'import' | 'restore';
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
export interface WorkflowTransition { from: string; to: string; issueTypes: string[]; requiredFields: IssueRequiredField[]; requireResolvedBlockers?: boolean }
export interface WorkflowFieldRule { issueType: string; statusId: string; requiredFields: IssueRequiredField[] }
export interface ProjectWorkflow { id: string; projectId: string; version: number; initialStatusId: string; statuses: WorkflowStatus[]; transitions: WorkflowTransition[]; fieldRules: WorkflowFieldRule[]; updatedAt: string }
export type IssueFieldOperator = 'is_set' | 'is_empty' | 'equals' | 'not_equals' | 'contains' | 'gte' | 'lte' | 'includes' | 'excludes';
export interface IssueFieldRule { fieldId: string; operator: IssueFieldOperator; value?: string | number | boolean }
export interface IssueFieldFilter { match: 'all' | 'any'; rules: IssueFieldRule[] }
export type IssueViewDateFilter = { mode: 'planned' | 'needs_dates' } | { mode: 'overlap' | 'due'; from?: string; to?: string };
export interface IssueViewPlanningFilter {
  cycleId?: string | null;
  moduleId?: string | null;
  releaseId?: string | null;
  dates?: IssueViewDateFilter;
}
export const ISSUE_VIEW_GITLAB_FILTERS = ['open_merge_request', 'merge_blocked', 'failed_pipeline', 'running_pipeline', 'no_activity'] as const;
export type IssueViewGitlabFilter = typeof ISSUE_VIEW_GITLAB_FILTERS[number];
export function isIssueViewGitlabFilter(value: unknown): value is IssueViewGitlabFilter {
  return ISSUE_VIEW_GITLAB_FILTERS.some(filter => filter === value);
}

export interface IssueViewLabelFilter {
  include?: string[];
  exclude?: string[];
  match?: 'any' | 'all';
  presence?: 'set' | 'empty';
}

export interface SavedViewState {
  layout: 'list' | 'board';
  boardGrouping?: 'assignee';
  filters: {
    query: string;
    status: string;
    assigneeId: string;
    type: string;
    fieldFilter?: IssueFieldFilter;
    planning?: IssueViewPlanningFilter;
    gitlab?: IssueViewGitlabFilter;
    priorities?: Priority[];
    labels?: IssueViewLabelFilter;
  };
}
export const ISSUE_FIELD_BREAKDOWN_DIMENSIONS = ['status', 'priority', 'assignee', 'type'] as const;
export type IssueFieldBreakdownDimension = typeof ISSUE_FIELD_BREAKDOWN_DIMENSIONS[number];
export interface IssueFieldBreakdownColumn {
  id: string;
  label: string;
  count: number;
}
export interface IssueFieldBreakdownComparison {
  by: IssueFieldBreakdownDimension;
  columns: IssueFieldBreakdownColumn[];
  counts: Record<string, Record<string, number>>;
}
export interface IssueFieldBreakdownBucket {
  id: string;
  label: string;
  kind: 'value' | 'missing' | 'not_applicable';
  count: number;
}
export interface IssueFieldBreakdownIssue { id: string; key: string; title: string }
export interface IssueFieldBreakdown {
  projectId: string;
  field: Pick<CustomFieldDefinition, 'id' | 'name' | 'kind' | 'archived'>;
  groupBy?: IssueFieldBreakdownDimension;
  comparison?: IssueFieldBreakdownComparison;
  savedView: { id: string; name: string; version: number } | null;
  revision: string;
  generatedAt: string;
  totalIssues: number;
  applicableIssues: number;
  populatedIssues: number;
  missingIssues: number;
  notApplicableIssues: number;
  groups: IssueFieldBreakdownBucket[];
  numeric: { min: number; max: number; average: number; sum: number | null } | null;
}
export interface IssueFieldBreakdownPage {
  bucket: IssueFieldBreakdownBucket;
  comparisonBucket?: IssueFieldBreakdownColumn;
  total: number;
  offset: number;
  issues: IssueFieldBreakdownIssue[];
}
export interface SavedView extends SavedViewState { id: string; projectId: string; name: string; authorId: string; version: number; createdAt: string; updatedAt: string }
export interface ProjectIssueOrder { projectId: string; issueIds: string[]; version: string }
export interface IssueOrderMove {
  issueId: string;
  expectedVersion: string;
  expectedIssueVersion: number;
  anchorId: string | null;
  position: 'before' | 'after';
  status?: IssueStatus;
  targetAssigneeId?: string | null;
  assigneeId?: string | null;
}
export interface IssueOrderMoveResult { order: ProjectIssueOrder; issue: Issue }
type CycleBoardVersion = { id: string; expectedVersion: number };
export interface CycleBoardMoveInput {
  requestId: string;
  issueId: string;
  expectedVersion: string;
  expectedIssueVersion: number;
  sourceCycle: CycleBoardVersion | null;
  targetCycle: CycleBoardVersion | null;
  anchorId: string | null;
  position: 'before' | 'after';
}
export interface CycleBoardMoveResult extends IssueOrderMoveResult { duplicate: boolean }
export interface WorkspaceSnapshot {
  projects: Project[]; users: User[]; issues: Issue[]; documents: DocPage[]; workflows?: ProjectWorkflow[];
  dependencies: Dependency[]; resourceLinks: ResourceLink[]; activities: Activity[]; gitlabLinks: GitlabLink[]; savedViews?: SavedView[];
  planningItems?: PlanningItem[];
  calendars?: WorkCalendar[]; milestones?: Milestone[]; baselines?: ScheduleBaseline[];
  workloadCapacities?: ProjectWorkloadCapacity[];
  teamWorkloadCapacity?: TeamWorkloadCapacity;
  issueSchemas?: ProjectIssueSchema[];
  issueOrders?: ProjectIssueOrder[];
  issueMoveOrigins?: Record<string, string[]>;
  documentOrders?: DocumentSiblingOrder[];
}
export interface ScheduleChange {
  id: string;
  projectId?: string;
  key: string;
  title: string;
  version: number;
  fromStart: string | null;
  fromEnd: string | null;
  toStart: string | null;
  toEnd: string | null;
  fromDue?: string | null;
  toDue?: string | null;
}
export interface SchedulePreview { changes: ScheduleChange[]; warnings: string[]; calendarVersions?: Record<string, number>; previewId?: string; blocking?: string[]; expiresAt?: string }
export interface TeamFollowUpScheduleInput { relationId: string; expectedVersion: number }
export interface AutomaticSchedulePreview extends SchedulePreview {
  previewId: string;
  blocking: string[];
  expiresAt: string;
  teamFollowUp?: TeamFollowUpScheduleInput & { sourceIssueId: string; targetIssueId: string; sourceEndDate: string | null };
}
export interface WorkloadLevelSummary { overloadedCells: number; excessMinutes: number; completionDate: string | null }
export interface WorkloadLevelConflict { userId: string; date: string; excessMinutes: number; issueIds: string[] }
export interface WorkloadLevelPlan {
  changes: ScheduleChange[];
  before: WorkloadLevelSummary;
  after: WorkloadLevelSummary;
  remaining: WorkloadLevelConflict[];
  reason?: 'search-limit';
}
export type WorkloadLevelPreview = AutomaticSchedulePreview & WorkloadLevelPlan;
export interface TeamWorkloadLevelPlan extends Omit<WorkloadLevelPlan, 'changes'> {
  changes: (ScheduleChange & { projectId: string })[];
  projectCompletions: { projectId: string; before: string | null; after: string | null }[];
}
export type TeamWorkloadLevelPreview = Omit<AutomaticSchedulePreview, 'changes'> & TeamWorkloadLevelPlan & { movableProjectIds: string[] };
export interface ScheduleAnalysisTask {
  issueId: string;
  key: string;
  title: string;
  earlyStart: string;
  earlyFinish: string;
  latestStart: string;
  latestFinish: string;
  slackDays: number;
  critical: boolean;
}
export interface ScheduleAnalysisExclusion {
  issueId: string;
  key: string;
  title: string;
  reason: string;
}
export interface ProjectScheduleAnalysis {
  projectId: string;
  projectedFinish: string | null;
  tasks: ScheduleAnalysisTask[];
  criticalDependencyIds: string[];
  excluded: ScheduleAnalysisExclusion[];
  completedCount: number;
  cancelledCount: number;
  warnings: string[];
  partial: boolean;
}
export interface SchedulePasteDiagnostic { line: number | null; key?: string; issueId?: string; message: string }
export interface SchedulePasteDependencyChange {
  line: number;
  predecessorKey: string;
  predecessorTitle: string;
  successorKey: string;
  successorTitle: string;
  before: Pick<Dependency, 'type' | 'lagDays'> | null;
  after: Pick<Dependency, 'type' | 'lagDays'> | null;
}
export interface SchedulePastePreview {
  projectId: string | null;
  projectIds?: string[];
  previewId: string | null;
  expiresAt: string | null;
  changes: ScheduleChange[];
  dependencyChanges?: SchedulePasteDependencyChange[];
  warnings: string[];
  errors: SchedulePasteDiagnostic[];
  unchanged: number;
}
export interface SchedulePasteApplyResult { undoId: string; updated: Issue[]; warnings: string[]; dependencyChanges?: number }
export const MAX_SCHEDULE_BULK_DATE_ISSUES = 100;
export type ScheduleBulkDateChanges = Partial<Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>>;
export interface ScheduleBulkDateInput {
  projectId: string | null;
  issues: { id: string; expectedVersion: number }[];
  changes: ScheduleBulkDateChanges;
}
type ScheduleRowIssue = { id: string; expectedVersion: number };
export const MAX_SCHEDULE_ROW_DEPENDENCY_EDITS = 100;
export type ScheduleRowDependencyEdit =
  | { action: 'add'; relatedIssue: ScheduleRowIssue; direction: 'predecessor' | 'successor'; type: DependencyType; lagDays: number }
  | { action: 'update'; id: string; expectedVersion: number; relatedIssue: ScheduleRowIssue; type: DependencyType; lagDays: number }
  | { action: 'remove'; id: string; expectedVersion: number; relatedIssue: ScheduleRowIssue };
export interface ScheduleRowEditInput {
  projectId: string;
  issue: ScheduleRowIssue;
  changes: ScheduleBulkDateChanges;
  dependency?: ScheduleRowDependencyEdit;
  dependencies?: readonly ScheduleRowDependencyEdit[];
}
export type PlanScheduleDates = Pick<PlanningItem, 'startDate' | 'endDate' | 'targetDate'>;
export interface PlanScheduleShiftPreview {
  previewId: string | null;
  expiresAt: string | null;
  plan: Pick<PlanningItem, 'id' | 'name' | 'kind' | 'version'> & { from: PlanScheduleDates; to: PlanScheduleDates };
  changes: ScheduleChange[];
  skipped: { id: string; key: string; title: string; reason: 'terminal' | 'unscheduled' }[];
  warnings: string[];
  blocking: string[];
}
export interface PlanScheduleShiftResult extends SchedulePasteApplyResult { plan: PlanningItem }
export interface FeatureProps {
  data: WorkspaceSnapshot; projectId: string; actorId: string;
  refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void;
  openIssue: (id: string) => void; openDocument: (id: string) => void;
}
