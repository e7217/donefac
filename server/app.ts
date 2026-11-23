import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AttachmentFiles, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_EXPORT_BYTES, attachmentId, safeFilename, sniffMime, hash } from './attachments.js';
import { AttachmentVersionsService, AttachmentVersionError } from './attachment-versions.js';
import { AttachmentAppend } from './attachment-append.js';
import { MarkdownArchiveImportError, MarkdownArchiveImportService } from './markdown-archive-import.js';
import { MAX_MARKDOWN_ARCHIVE_BYTES } from '../shared/document-markdown-archive.js';
import { Store } from './store.js';
import { WorkspaceRevisions, workspaceRestoreGeneration } from './workspace-revisions.js';
import { seed } from './seed.js';
import { WorkflowService, WorkflowError } from './workflows.js';
import { SavedViewService, SavedViewError } from './saved-views.js';
import { CollaborationService, CollaborationError, type CollaborationUpgradeGuard } from './collaboration.js';
import { PlanningService, PlanningError } from './planning.js';
import { CycleCompletionError, CycleCompletionService } from './cycle-completion.js';
import { CycleCompletionRecords, CycleCompletionRecordsError } from './cycle-completion-records.js';
import { aggregateCycleProgress, CycleProgressError } from './cycle-progress.js';
import { ApiKeyService, ApiKeyError } from './api-keys.js';
import { CalendarService, CalendarError } from './calendars.js';
import { AutomaticScheduleService, AutomaticScheduleError, AUTO_RESULT_RETENTION_MS, type ScheduleUndoOrigin } from './automatic-schedule.js';
import { SchedulePasteService, SchedulePasteError, type ScheduleDateMutation } from './schedule-paste.js';
import { dependencyPair, hasScheduleDependencyCycle, projectScheduleDependencies, type ScheduleDependencyMutation } from './schedule-dependency-changes.js';
import { PlanScheduleShiftError, PlanScheduleShiftService } from './plan-schedule-shift.js';
import { DocumentContentService, DocumentContentError, normalizeDocumentContent, validateDocumentIssueBlocks, validateDocumentListProjects, validatePinnedDocumentRevisions } from './document-content.js';
import { registerDocumentIncludeRevisionRoutes } from './document-include-revisions.js';
import { bindImportedDocumentSections, DocumentCreationError, DocumentCreationService } from './document-creation.js';
import { creationRequestId, deterministicCreationId } from './creation-request.js';
import { DocumentTemplateError, DocumentTemplatesService, templateDraftContent } from './document-templates.js';
import { DocumentTemplateAssetsService } from './document-template-assets.js';
import { DocumentCopyAssetError, DocumentCopyAssets } from './document-copy-assets.js';
import { DocumentOrderError, DocumentOrderService } from './document-order.js';
import { DocumentTreeCopyError, DocumentTreeCopyService } from './document-tree-copy.js';
import { DocumentFollowUpError, DocumentFollowUpService, resolveDocumentDecisionSource, validateDocumentDecisionSource } from './document-follow-up.js';
import { DocumentSelectionCommentError, DocumentSelectionCommentService } from './document-selection-comments.js';
import { DocumentCommentReplyError, DocumentCommentReplyService } from './document-comment-replies.js';
import { DocumentCommentResolutionError, advanceRestoredCommentResolutionVersions, updateDocumentCommentResolution, validateDocumentCommentResolution } from './document-comment-resolution.js';
import { CommentMentionError, parseCommentMentions, validateCurrentMentionNames } from './comment-mentions.js';
import { CommentEditError, CommentEditingService, validateCommentEdit } from './comment-editing.js';
import { IssueChildCreationError, IssueChildService } from './issue-child.js';
import { IssueCreationError, IssueCreationService } from './issue-creation.js';
import { IssueChangeHistory, IssueChangeHistoryError } from './issue-change-history.js';
import { IssueTemplateError, IssueTemplatesService } from './issue-templates.js';
import { RecurringIssueError, RecurringIssueService } from './recurring-issues.js';
import { IssuePasteError, IssuePasteService } from './issue-paste.js';
import { IssueRelationError, IssueRelationsService } from './issue-relations.js';
import { IssueBlockerNotifications } from './issue-blocker-notifications.js';
import { ScheduleArtifactService, ScheduleArtifactError } from './schedule-artifacts.js';
import { IssueSchemaService, IssueSchemaError, validateVisibilityStatuses } from './issue-schema.js';
import { IssueOrderError, IssueOrderService } from './issue-order.js';
import { IssueBulkEditError, IssueBulkEditService } from './issue-bulk-edit.js';
import { AutomationService, AutomationError } from './automation.js';
import { exportAutomationRunHistory, restoreAutomationRunHistory, validateAutomationRunHistory } from './automation-run-backup.js';
import { IssueAssignmentRulesService, IssueAssignmentRulesError, type IssueAssignmentDecision } from './issue-assignment-rules.js';
import { OutboundWebhookService, OutboundWebhookError } from './outbound-webhooks.js';
import { GitlabIntegrationService, GitlabIntegrationError, branchObjectId } from './gitlab-integration.js';
import { GitlabProjectWebhookSetupError } from './gitlab-project-webhook-setup.js';
import { GitlabDeploymentError } from './gitlab-deployments.js';
import { gitlabJiraOriginalKeys, gitlabJiraSources } from './gitlab-jira-sources.js';
import { LegacyImportService } from './legacy-import.js';
import { LegacyImportError } from './legacy-import-model.js';
import { MigrationService } from './migration.js';
import type { MigrationJiraIssueUpdate, PreparedMigration } from './migration-contracts.js';
import { SourcePreservationService, SourcePreservationError } from './source-preservation.js';
import { findTeamspaceIssueRelation, issueRelationVersionFloor, IssueRelationVersionError, nextIssueRelationVersion, recordIssueRelationVersion } from './issue-relation-persistence.js';
import { registerSourceReconciliationRoutes } from './source-reconciliation.js';
import { LegacyArchiveError } from './legacy-import-archive.js';
import { ReportingLedger, ReportingLedgerError, previousIssueKeys } from './reporting-ledger.js';
import { IssueKeyLookupError, readIssueKeyMatches, readIssueSearchAliases } from './issue-search-aliases.js';
import { ReportingMetricsError } from './reporting-metrics.js';
import { ReportingService, ReportingError } from './reporting.js';
import { WorklogService, WorklogError } from './worklogs.js';
import { TimeReservationError, TimeReservationService } from './time-reservations.js';
import { registerTeamOverviewRoutes } from './team-overview.js';
import { DecisionFollowUpError, registerDecisionFollowUpRoutes } from './decision-follow-ups.js';
import { FieldBreakdownError } from './field-breakdown.js';
import { registerFieldBreakdownRoutes } from './field-breakdown-routes.js';
import { SavedFieldBreakdownService } from './saved-field-breakdowns.js';
import { registerDeliveryBlockerRoutes } from './delivery-blocker-routes.js';
import { DocumentPublicationError, DocumentPublicationService } from './document-publication.js';
import { countDocumentAssignedReviews, listDocumentPublications } from './document-publication-list.js';
import { registerDocumentExportRoutes } from './document-export.js';
import { NotificationsService, TeamNotificationError } from './notifications.js';
import { DeadlineReminderError, DeadlineRemindersService } from './deadline-reminders.js';
import { documentNotificationSpaceProject, NotificationSubscriptionError, NotificationSubscriptionsService } from './notification-subscriptions.js';
import { FavoriteError, FavoritesService } from './favorites.js';
import { AtlassianReadError } from '../shared/atlassian-links.js';
import { parseAtlassianSearchInput } from '../shared/atlassian-search.js';
import { AtlassianLinkError, AtlassianLinksService } from './atlassian-links.js';
import { AtlassianReader } from './atlassian-read.js';
import { TrashService, TrashError, type TrashArchive } from './trash.js';
import { TrashItemsService, trashItemComments, trashItemFiles, validateCommentReplyTopology } from './trash-items.js';
import { DocumentTreeMoveError, DocumentTreeMoveService } from './document-tree-move.js';
import { IssueProjectMoveError, IssueProjectMoveService } from './issue-project-move.js';
import { ProjectWorkloadService } from './project-workload.js';
import { registerTeamWorkloadRoutes } from './team-workload.js';
import { TeamWorkloadCapacityService } from './team-workload-capacity.js';
import { NATIVE_BACKUP_SCHEMA_VERSION, supportsNativeBackupVersion } from '../shared/native-backup.js';
import { documentLabelKey, documentSearchText, MAX_DOCUMENT_LABEL_LENGTH, MAX_DOCUMENT_LABELS, normalizeDocumentLabels } from '../shared/document-labels.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, documentContentSchemaVersion } from '../shared/document-nodes.js';
import { createCalendarMath, isCalendarDate } from '../shared/calendar.js';
import { reservationDayRange, reservationLocalDateTime } from '../shared/time-reservations.js';
import { dependencyScheduleWarning, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { isRestorableGitlabLink } from '../shared/gitlab-links.js';
import { hasDuplicateTeamspaceIssueRelations, isRelationId, isTeamspaceIssueRelation, issueRelationEndpoints, issueRelationScheduleMode } from '../shared/issue-relations.js';
import type { IssueCloneResult, IssueCloseAsDuplicateResult } from '../shared/types.js';
import { issueDeadline } from '../shared/my-work.js';
import { isTerminalStatus, requiredFieldsFor, statusMeta } from '../shared/workflow-helpers.js';
import { analyzeProjectSchedule, MAX_SCHEDULE_ANALYSIS_DEPENDENCIES, MAX_SCHEDULE_ANALYSIS_TASKS, ScheduleAnalysisError } from '../shared/schedule-analysis.js';
import { calculateProjectWorkload, DEFAULT_DAILY_WORKLOAD_MINUTES, validatePlannedEffortMinutes, WorkloadError } from '../shared/project-workload.js';
import { fieldApplies, hasCustomValue, issueSearchText, visibleIssueFieldIds } from '../shared/issue-schema.js';
import { IssueFieldFilterError, parseIssueFieldFilter } from '../shared/issue-field-filter.js';
import { createIssueViewMatcher, IssueViewPriorityLabelFilterError, IssueViewStatusFilterError, issueViewStatusCriteria, parseIssueViewLabelFilter, parseIssueViewPriorities, parseIssueViewStatusIds } from '../shared/issue-view.js';
import { matchingIssueSearchAliases, normalizeWorkspaceSearchQuery } from '../shared/workspace-search.js';
import { matchingGitlabSearchLinks, normalizeGitlabSearchInput } from '../shared/gitlab-search.js';
import type { ScheduleUndoInfo, ScheduleUndoResult, ScheduleUndoScope } from '../shared/types.js';
import { COMMENT_MENTION_NOTIFICATION_KINDS, CONFLUENCE_MIGRATION_DOCUMENT_FIELDS, ISSUE_DEADLINE_REMINDER_KINDS, ISSUE_RISK_NOTIFICATION_KINDS, JIRA_MIGRATION_ISSUE_FIELDS, PRIORITY, documentNotificationSpaceId, type Issue, type IssueRelation, type DocPage, type DocRevision, type Project, type WorkspaceSnapshot, type ScheduleChange, type SchedulePreview, type Attachment, type AttachmentVersion, type Comment, type User, type Dependency, type PlanningItem, type PlanScheduleDates, type TeamNotificationKind, type TrashRestoreResult, type GitlabLink, type ReportSnapshot, type ResourceLink, type LinkedDocumentCreationResult, type RichContent, type SourceImport } from '../shared/types.js';

type ScheduleUndoIssue = Pick<Issue, 'id' | 'startDate' | 'endDate'> & Partial<Pick<Issue, 'dueDate'>> & { appliedVersion:number };
type ScheduleUndoPlan = { id:string; appliedVersion:number; dates:PlanScheduleDates };
type ScheduleUndoRecord = {
  id:string; records:ScheduleUndoIssue[]; used:boolean; plan?:ScheduleUndoPlan; linkChanges?:ScheduleDependencyMutation[];
  actorId?:string; appliedAt?:string; scope?:string; scopeProjectId?:string;
};

class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
const fail = (message: string, status = 400, details?: unknown): never => { throw new ApiError(status, message, details); };
function normalizeDocumentMetadataLabels(document: DocPage): DocPage {
  if (!Object.hasOwn(document, 'labels')) return document;
  const labels = normalizeDocumentLabels(document.labels);
  if (!labels) return fail(`문서 라벨은 최대 ${MAX_DOCUMENT_LABELS}개이며 각 라벨은 ${MAX_DOCUMENT_LABEL_LENGTH}자 이하여야 합니다. 라벨을 확인해 주세요.`);
  if (labels.length) document.labels = labels;
  else delete document.labels;
  return document;
}
const uid = () => randomUUID();
const now = () => new Date().toISOString();
const planScheduleLabel = (dates:PlanScheduleDates) => `${dates.startDate ?? '미정'} ~ ${dates.endDate ?? '미정'} · 목표일 ${dates.targetDate ?? '미정'}`;
const issueScheduleLabel = (issue:Pick<Issue,'startDate'|'endDate'|'dueDate'>,includeDue:boolean) =>
  `${issue.startDate ?? '미정'} ~ ${issue.endDate ?? '미정'}${includeDue ? ` · 목표 마감일 ${issue.dueDate ?? '미정'}` : ''}`;
const archivedFiles = (entry:TrashArchive): Attachment[] => [...entry.attachments,...entry.attachmentVersions];
const tables = { projects: 'projects', users: 'users', issues: 'issues', documents: 'documents', dependencies: 'dependencies', resourceLinks: 'resource_links', activities: 'activities', gitlabLinks: 'gitlab_links' } as const;
const text = (v: unknown, label: string, max = 500): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail(`${label}을(를) 확인해 주세요.`);
const nullableText = (v: unknown, label: string, max = 500) => v === null || v === '' || v === undefined ? null : text(v, label, max);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const date = (v: unknown, label: string) => v === null || v === '' || v === undefined ? null : isDate(v) ? v : fail(`${label}: YYYY-MM-DD 형식의 날짜가 필요합니다.`);
function dateRange(start: string | null, end: string | null) { if (start && end && start > end) fail('종료일은 시작일보다 빠를 수 없습니다.'); }
function checkVersion(current: {version: number}, value: unknown) { if (!Number.isInteger(value)) fail('expectedVersion이 필요합니다.'); if (current.version !== value) fail('다른 작업자가 변경했습니다. 새로고침 후 다시 시도해 주세요.',409,{currentVersion:current.version}); }
function validateDependencyVersion(dependency: Dependency): void {
  if(dependency.version!==undefined&&(!Number.isSafeInteger(dependency.version)||dependency.version<1))fail('업무 연결 버전을 확인해 주세요.');
}
function nextDependencyVersion(dependency: Dependency, previousVersion = 0): number {
  const version=Math.max(dependency.version??1,previousVersion)+1;
  if(!Number.isSafeInteger(version))fail('업무 연결의 버전 범위를 초과했습니다.',409);
  return version;
}
function normalizeIssueDescription(issue: Pick<Issue, 'description' | 'descriptionFormat'>, backupVersion?: number): void {
  if (typeof issue.description !== 'string' || issue.description.length > 200000) fail('설명을 확인해 주세요.');
  if (!Object.hasOwn(issue, 'descriptionFormat')) return;
  if (backupVersion !== undefined && backupVersion < 78) fail('업무 설명 서식을 포함한 백업은 schemaVersion 78이 필요합니다.');
  if (issue.descriptionFormat === 'plain') delete issue.descriptionFormat;
  else if (issue.descriptionFormat !== 'markdown') fail('업무 설명 서식을 텍스트 또는 Markdown으로 지정해 주세요.');
}
const dependencyVersionKey='schedule.dependencyVersion';
function normalizeBackupDocumentContent(value: unknown, backupVersion: number) {
  const normalized = normalizeDocumentContent(value);
  const version = documentContentSchemaVersion(normalized.content);
  if (version >= 13 && backupVersion < 96) fail('문서 속성 또는 속성 보고서를 포함한 백업은 schemaVersion 96이 필요합니다.');
  if (version >= 12 && backupVersion < 79) fail('문서 열 배치를 포함한 백업은 schemaVersion 79가 필요합니다.');
  if (version >= 11 && backupVersion < 69) fail('문서 발췌를 포함한 백업은 schemaVersion 69가 필요합니다.');
  if (version >= 10 && backupVersion < 67) fail('하위 문서 목록을 포함한 백업은 schemaVersion 67이 필요합니다.');
  if (version >= 9 && backupVersion < 59) fail('라벨별 문서 목록을 포함한 백업은 schemaVersion 59가 필요합니다.');
  if (version >= 8 && backupVersion < 54) fail('본문 목차를 포함한 백업은 schemaVersion 54가 필요합니다.');
  if (version >= 7 && backupVersion < 49) fail('문서 절 링크는 schemaVersion 49 백업이 필요합니다.');
  if (version >= 6 && backupVersion < 46) fail('안내 상자와 상태 배지는 schemaVersion 46 백업이 필요합니다.');
  if (version >= 5 && backupVersion < 26) fail('문서 버전 포함 블록은 schemaVersion 26 백업이 필요합니다.');
  if (version >= 4 && backupVersion < 22) fail('업무 현황 블록은 schemaVersion 22 백업이 필요합니다.');
  if (version >= 2 && backupVersion < 7) fail('참조·포함·접기 블록은 schemaVersion 7 백업이 필요합니다.');
  if (version >= 3 && backupVersion < 20) fail('업무 목록 블록은 schemaVersion 20 백업이 필요합니다.');
  return normalized;
}
function shiftDate(value: string, days: number, working: boolean): string {
  const d = new Date(`${value}T00:00:00Z`), sign = Math.sign(days); let remain = Math.abs(days);
  while (remain) { d.setUTCDate(d.getUTCDate()+sign); if (!working || ![0,6].includes(d.getUTCDay())) remain--; }
  return d.toISOString().slice(0,10);
}

export function createApp(options: {
  dataDir?: string;
  seed?: boolean;
  outboundWorker?: boolean;
  deadlineReminderWorker?: boolean;
  deadlineReminderClock?: () => Date;
  deadlineReminderIntervalMs?: number;
  recurringIssueWorker?: boolean;
  recurringIssueClock?: () => Date;
  recurringIssueIntervalMs?: number;
  atlassianEnv?: NodeJS.ProcessEnv;
  browserOrigin?: string;
  gitlabWebhookPublicOrigin?: string;
  restrictedConfluencePages?: ReadonlyMap<string, ReadonlySet<string>>;
} = {}) {
  const dataDir=options.dataDir || process.env.TEAMSPACE_DATA_DIR || resolve('data');
  const store = new Store(dataDir);
  const dependencyVersionFloor=()=>{
    const value=store.setting(dependencyVersionKey);
    return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:1;
  };
  const trackDependencyVersion=(version: number)=>{
    if(version>dependencyVersionFloor())store.setSetting(dependencyVersionKey,version);
  };
  const files = new AttachmentFiles(dataDir);
  files.recover(store.setting('attachmentImportGeneration'));
  if (options.seed !== false) seed(store);
  const issueSchemas=new IssueSchemaService(store);
  const sourcePreservation=new SourcePreservationService(store);
  const issueRelations=new IssueRelationsService(store,sourcePreservation);
  const workflows=new WorkflowService(store,issueSchemas,issueRelations),savedViews=new SavedViewService(store,issueSchemas);
  const savedFieldBreakdowns = new SavedFieldBreakdownService(store, issueSchemas);
  const documentContent=new DocumentContentService(store);
  const documentFollowUp=new DocumentFollowUpService(store);
  const documentSelectionComments=new DocumentSelectionCommentService(store);
  const documentCommentReplies=new DocumentCommentReplyService(store);
  const commentEditing = new CommentEditingService(store);
  const issueChildren = new IssueChildService(store);
  const issueCreation = new IssueCreationService(store);
  const issueTemplates = new IssueTemplatesService(store, (projectId, defaults, source) => {
    let customFields = defaults.customFields;
    if (source) {
      const schema = issueSchemas.get(projectId);
      const visible = visibleIssueFieldIds(schema, source);
      customFields = Object.fromEntries(schema.fields.flatMap(field => {
        const value = defaults.customFields[field.id];
        if (!visible.has(field.id) || !hasCustomValue(value)) return [];
        const activeOption = (id: unknown) => field.options.some(option => option.id === id && !option.archived);
        if (field.kind === 'select' && !activeOption(value)) return [];
        if (field.kind === 'user' && (typeof value !== 'string' || !store.get<User>('users', value))) return [];
        if (field.kind === 'multi_select') {
          return Array.isArray(value) ? [[field.id, value.filter(activeOption)]] : [];
        }
        return [[field.id, value]];
      }));
    }
    const candidate = { projectId, type: defaults.type, status: workflows.get(projectId).initialStatusId, customFields };
    issueSchemas.validateIssue(candidate, undefined, { checkFields: false });
    return { ...defaults, customFields: candidate.customFields };
  });
  const recurringIssueRules = new RecurringIssueService(store, options.recurringIssueClock);
  const documentCreation = new DocumentCreationService(store);
  const documentTemplateAssets = new DocumentTemplateAssetsService(store, files);
  const documentTemplates = new DocumentTemplatesService(store, documentTemplateAssets);
  const documentDraftFiles = new AttachmentAppend(dataDir);
  const markdownArchiveImport = new MarkdownArchiveImportService(store, documentDraftFiles);
  const collaboration=new CollaborationService(store,documentContent);
  const notifications=new NotificationsService(store);
  const deadlineReminders = new DeadlineRemindersService(
    store, notifications,
    issue => isTerminalStatus({ workflows: [workflows.get(issue.projectId)] }, issue.projectId, issue.status),
    options.deadlineReminderClock,
  );
  const subscriptions=new NotificationSubscriptionsService(store);
  const favorites = new FavoritesService(store);
  const projectSubscribers=(issue: Issue)=>subscriptions.recipients('project',issue.projectId);
  const issueSubscribers=(issue: Issue)=>[...subscriptions.recipients('issue',issue.id),...projectSubscribers(issue)];
  const spaceSubscribers=(document: DocPage)=>subscriptions.recipients('space',documentNotificationSpaceId(document.projectId));
  const documentSubscribers=(document: DocPage)=>[...subscriptions.recipients('document',document.id),...spaceSubscribers(document)];
  const atlassianLinks=new AtlassianLinksService(store);
  const atlassian=new AtlassianReader(options.atlassianEnv);
  const documentPublication=new DocumentPublicationService(store,notifications,documentSubscribers);
  const planning=new PlanningService(store);planning.migrateLegacyIssues();
  const cycleCompletionRecords = new CycleCompletionRecords(store);
  const cycleCompletion = new CycleCompletionService(store, cycleCompletionRecords);
  const issueOrders = new IssueOrderService(store);
  const documentOrders = new DocumentOrderService(store);
  const issueBulkEdit = new IssueBulkEditService(store);
  const issueChangeHistory = new IssueChangeHistory(store, {
    schema: projectId => issueSchemas.get(projectId), workflow: projectId => workflows.get(projectId),
  });
  const reportLedger=new ReportingLedger(store,projectId=>workflows.get(projectId));
  reportLedger.start();
  const reports=new ReportingService(store,reportLedger);
  const worklogs=new WorklogService(store);
  const timeReservations=new TimeReservationService(store);
  const apiKeys=new ApiKeyService(store);
  const calendars=new CalendarService(store),scheduleArtifacts=new ScheduleArtifactService(store);
  const workload=new ProjectWorkloadService(store);
  const teamCapacity=new TeamWorkloadCapacityService(store);
  const automaticSchedule=new AutomaticScheduleService(store,calendars);
  const schedulePaste=new SchedulePasteService(store);
  const planScheduleShift=new PlanScheduleShiftService(store);
  const legacyImport=new LegacyImportService(store,dataDir);
  const workspaceRevisions = new WorkspaceRevisions(store);
  const trash=new TrashService(store);
  const trashItems=new TrashItemsService(store,files);
  const documentTreeMove=new DocumentTreeMoveService(store,trash);
  const migrations=new MigrationService(store,dataDir,legacyImport,sourcePreservation,id=>
    Boolean(store.get('documents',id)||trash.find('document',id))||trash.hasLocalAttachmentVersion(id)||trashItems.hasLocalAttachmentVersion(id),
    options.restrictedConfluencePages);
  trashItems.finishCleanup();
  const attachmentVersions=new AttachmentVersionsService(store,dataDir);
  const documentTreeCopy = new DocumentTreeCopyService(store, new DocumentCopyAssets(store, files, attachmentVersions), documentOrders);
  const app = express(); app.disable('x-powered-by');
  apiKeys.installAuthentication(app);
  app.use('/api/attachments',(req,res,next)=>{if(req.method!=='POST')return next();if(!req.is('application/octet-stream'))return res.status(415).json({error:'첨부파일은 application/octet-stream 형식으로 전송해 주세요.'});express.raw({type:'application/octet-stream',limit:MAX_FILE_BYTES})(req,res,next);});
  app.use('/api/legacy-import/packages',(req,res,next)=>{if(req.method!=='POST')return next();if(!req.is('application/octet-stream'))return res.status(415).json({error:'원본 패키지는 application/octet-stream 형식으로 전송해 주세요.'});express.raw({type:'application/octet-stream',limit:MAX_PACKAGE_BYTES})(req,res,next);});
  app.use('/api/document-markdown-import', (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Markdown ZIP을 application/octet-stream 형식으로 보내 주세요.' });
    express.raw({ type: 'application/octet-stream', limit: MAX_MARKDOWN_ARCHIVE_BYTES })(req, res, next);
  });
  app.use('/api/integrations/gitlab/webhook',express.json({limit:2*1024*1024,verify:(req,_res,buffer)=>{(req as Request & {gitlabRawBody:Buffer}).gitlabRawBody=Buffer.from(buffer);}}));
  app.use(express.json({limit:MAX_PACKAGE_BYTES}));
  app.use((req,res,next)=>{req.body??={};if(req.method!=='GET'&&(typeof req.body!=='object'||Array.isArray(req.body)))return res.status(400).json({error:'JSON 객체가 필요합니다.'});next();});
  apiKeys.installAuthorization(app);
  app.use((req,res,next)=>{const explicit=req.header('X-Actor-Id');if(req.method!=='GET'&&explicit&&!store.get('users',explicit))return res.status(400).json({error:'작업자를 찾을 수 없습니다.'});next();});
  const get = <T = any>(table: string, id: any): T => typeof id === 'string' && store.get<T>(table,id) || fail('대상을 찾을 수 없습니다.',404);
  const resolveActor = (req: Request): string | null => {
    const explicit = req.header('X-Actor-Id') || req.body?.actorId;
    if (explicit) {
      if (typeof explicit !== 'string' || !store.get('users', explicit)) return fail('작업자를 찾을 수 없습니다.');
      return explicit;
    }
    return store.all<User>('users')[0]?.id ?? null;
  };
  const actor = (req: Request) => resolveActor(req) ?? fail('먼저 팀원을 등록해 주세요.');
  const recordActivity = (actorId: string, resourceType: string, resourceId: string, action: string, detail = '', createdAt = now()) =>
    store.put('activities', { id: uid(), resourceType, resourceId, actorId, action, detail, createdAt });
  const activity = (req: Request, resourceType: string, resourceId: string, action: string, detail = '') =>
    recordActivity(actor(req), resourceType, resourceId, action, detail);
  const notifyIssue = (issue: Issue, actorId: string, kind: Extract<TeamNotificationKind, `issue-${string}`>, recipientIds: (string | null | undefined)[], createdAt: string, detail?: string) =>
    notifications.notify({kind,actorId,recipientIds,projectId:issue.projectId,targetId:issue.id,targetLabel:`${issue.key} ${issue.title}`,createdAt,...(detail===undefined?{}:{detail})});
  const notifyIssueRisk = (issue: Issue, actorId: string, kind: typeof ISSUE_RISK_NOTIFICATION_KINDS[number], createdAt: string, detail: string) =>
    notifyIssue(issue,actorId,kind,[issue.assigneeId,...(issue.collaboratorIds??[]),...issueSubscribers(issue)],createdAt,detail);
  const blockerNotifications = new IssueBlockerNotifications(store,projectId=>workflows.get(projectId),notifyIssueRisk);
  const notifyDocument = (document: DocPage, actorId: string, kind: Extract<TeamNotificationKind, `document-${string}`>, recipientIds: string[], createdAt: string) =>
    notifications.notify({kind,actorId,recipientIds,projectId:document.projectId,targetId:document.id,targetLabel:document.title,createdAt});
  const notifyDocumentCreated = (document: DocPage) =>
    notifyDocument(document,document.authorId,'document-created',spaceSubscribers(document),document.createdAt);
  const notifyDocumentUpdate = (document: DocPage, actorId: string, createdAt: string) =>
    notifyDocument(document,actorId,'document-updated',documentSubscribers(document),createdAt);
  const notifyComment = (comment: Comment, projectId: string | null, targetLabel: string, usualRecipients: (string | null | undefined)[]) => {
    const { resourceType, resourceId: targetId, authorId: actorId, createdAt } = comment;
    const fields = { projectId, targetId, targetLabel, actorId, createdAt };
    const mentioned = new Set(comment.mentions?.map(mention => mention.userId));
    if (mentioned.size) {
      notifications.notify({ ...fields, kind: `${resourceType}-comment-mentioned`, recipientIds: [...mentioned], commentId: comment.id });
    }
    const recipients = usualRecipients.filter(userId => userId == null || !mentioned.has(userId));
    if (resourceType === 'document' && comment.parentCommentId) {
      notifications.notify({ ...fields, kind: 'document-comment-reply', recipientIds: recipients, commentId: comment.id });
    } else notifications.notify({ ...fields, kind: `${resourceType}-comment`, recipientIds: recipients,
      ...(resourceType === 'issue' ? { commentId: comment.id } : {}) });
  };
  const notifyDocumentComment = (document: DocPage, comment: Comment, participants: string[] = []) =>
    notifyComment(comment, document.projectId, document.title, [document.authorId, ...documentSubscribers(document), ...participants]);
  const stopIssueWatch = store.onChange(({before,after,context})=>{
    const old=before as Issue | undefined, issue=after as Issue | undefined;
    if(!old || !issue)return;
    const statusChanged=old.status!==issue.status;
    const projectChanged=old.projectId!==issue.projectId;
    const datesChanged=old.dueDate!==issue.dueDate||old.endDate!==issue.endDate;
    if((!statusChanged&&!projectChanged&&!datesChanged) || !context.actorId ||
      (context.origin!=='user' && context.origin!=='automation') || !store.get('users',context.actorId)) return;
    if(statusChanged){
      const statusLabel = (ticket: Issue) => statusMeta({ workflows: [workflows.get(ticket.projectId)] }, ticket.projectId, ticket.status).label
        .replace(/[\s\p{Cc}]+/gu, ' ').trim() || '알 수 없는 상태';
      const detail = `${statusLabel(old)} → ${statusLabel(issue)}`;
      notifyIssue(issue, context.actorId, 'issue-status-changed', [issue.reporterId, ...issueSubscribers(issue)], issue.updatedAt, detail);
    }
    if(statusChanged||projectChanged)blockerNotifications.sourceStatusChanged(old,issue,context.actorId,issue.updatedAt);
    if(!datesChanged)return;
    const previousDeadline=issueDeadline(old),deadline=issueDeadline(issue);
    if(!previousDeadline||!deadline||deadline.value<=previousDeadline.value||
      isTerminalStatus({workflows:[workflows.get(issue.projectId)]},issue.projectId,issue.status))return;
    const label=(date:NonNullable<ReturnType<typeof issueDeadline>>)=>`${date.source==='dueDate'?'목표 마감일':'계획 종료일'} ${date.value}`;
    notifyIssueRisk(issue,context.actorId,'issue-deadline-postponed',issue.updatedAt,`${label(previousDeadline)} → ${label(deadline)}`);
  },['issues']);
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const webhook = req.path === '/api/integrations/gitlab/webhook';
    return store.withMutationContext({ actorId: webhook ? null : resolveActor(req), origin: webhook ? 'gitlab' : 'user' }, next);
  });
  const attachmentRows=(type:string,id:string)=>{
    const rows=store.db.prepare('SELECT json FROM attachments WHERE resource_type=? AND resource_id=? ORDER BY rowid').all(type,id) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as Attachment);
  };
  const attachmentTarget=(type:unknown,id:unknown)=>{if(!['issue','document'].includes(type as string)||typeof id!=='string')fail('첨부파일 대상을 확인해 주세요.');get(type==='issue'?'issues':'documents',id);};
  const detachArchivedChildren=(type:string,id:string)=>{
    store.db.prepare('DELETE FROM comments WHERE resource_type=? AND resource_id=?').run(type,id);
    store.db.prepare('DELETE FROM attachments WHERE resource_type=? AND resource_id=?').run(type,id);
  };
  const snapshot = (purpose: 'workspace' | 'backup' = 'workspace'): WorkspaceSnapshot => {
    const rows = store.db.prepare('SELECT json FROM issues ORDER BY rowid').all() as { json: string }[];
    const issues = rows.map(row => JSON.parse(row.json) as Issue);
    const documentRows = store.db.prepare('SELECT json FROM documents ORDER BY rowid').all() as { json: string }[];
    const documents = documentRows.map(row => JSON.parse(row.json) as DocPage);
    const data = Object.fromEntries(Object.entries(tables).map(([key, table]) =>
      [key, table === 'issues' ? issues : table === 'documents' ? documents : store.all(table)]));
    const activeIssueIds = new Set(issues.map(issue => issue.id));
    const priorIssueKeys = purpose === 'workspace' ? previousIssueKeys(store) : null;
    const issueMoveOrigins = priorIssueKeys ? [...priorIssueKeys]
      .filter(([id]) => activeIssueIds.has(id))
      .map(([id, origins]) => [id, [...new Set(origins.map(origin => origin.projectId))]]) : [];
    const issueAliases = priorIssueKeys ? readIssueSearchAliases(store, issues, priorIssueKeys) : null;
    return {
      ...data,
      workflows:workflows.snapshot(),savedViews:savedViews.all(),planningItems:planning.all(),calendars:calendars.snapshot(),
      workloadCapacities:workload.snapshot(),teamWorkloadCapacity:teamCapacity.get(),milestones:scheduleArtifacts.allMilestones(),
      baselines:scheduleArtifacts.allBaselines(),issueSchemas:issueSchemas.snapshot(),
      issueOrders: issueOrders.snapshot(data.projects, issues),
      ...(purpose === 'workspace' ? {
        restoreGeneration: workspaceRestoreGeneration(store),
        teamScheduleBlockers: issueRelations.teamScheduleBlockers(),
      } : {}),
      ...(issueMoveOrigins.length ? { issueMoveOrigins: Object.fromEntries(issueMoveOrigins) } : {}),
      ...(issueAliases && Object.keys(issueAliases).length ? { issueAliases } : {}),
      documentOrders: purpose === 'backup' ? documentOrders.forBackup(documents) : documentOrders.snapshot(documents),
    } as unknown as WorkspaceSnapshot;
  };
  const validateEmail = (email: any) => { const e = text(email,'이메일',254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail('올바른 이메일이 필요합니다.'); return e; };
  const validateUser = (u: any) => { u.name=text(u.name,'이름',80);u.email=validateEmail(u.email);if(!/^#[a-f\d]{6}$/i.test(u.color))fail('색상은 #RRGGBB 형식이어야 합니다.'); return u; };
  const validateProject = (p: any) => { p.name=text(p.name,'프로젝트 이름',100);p.key=text(p.key,'프로젝트 키',12).toUpperCase();if(!/^[A-Z][A-Z0-9]{1,11}$/.test(p.key))fail('프로젝트 키는 영문 대문자로 시작하는 2~12자리 영문·숫자입니다.');if(typeof p.description!=='string')fail('설명을 확인해 주세요.');if(!/^#[a-f\d]{6}$/i.test(p.color))fail('색상을 확인해 주세요.');return p; };
  type IssueParent = Pick<Issue, 'id' | 'projectId' | 'parentId'>;
  type ProjectedIssueHierarchy = { issues: ReadonlyMap<string, IssueParent>; validated: Set<string> };
  const storedIssueParent = store.db.prepare('SELECT id, project_id AS projectId, parent_id AS parentId FROM issues WHERE id=?');
  const readProjectedIssueParent = (id: string, hierarchy: ProjectedIssueHierarchy) => typeof id === 'string'
    ? hierarchy.issues.get(id) ?? (storedIssueParent.get(id) as IssueParent | undefined) : undefined;
  type IssueHierarchyOptions = { moveParents?: ReadonlyMap<string, Issue>; hierarchy?: ProjectedIssueHierarchy };
  const validateIssueHierarchy = (issue: IssueParent, options?: IssueHierarchyOptions) => {
    const { hierarchy } = options ?? {};
    if (hierarchy?.validated.has(issue.id)) return;
    const visited = new Set([issue.id]);
    const status = hierarchy ? 409 : 400;
    for (let parentId = issue.parentId; parentId;) {
      if (visited.has(parentId)) fail('상위 티켓에 순환 관계가 있습니다.', status);
      visited.add(parentId);
      const parent = hierarchy
        ? readProjectedIssueParent(parentId, hierarchy) ?? fail('이관할 상위 티켓을 찾을 수 없습니다.', 409)
        : options?.moveParents?.get(parentId) ?? get<Issue>('issues', parentId);
      if (parent.projectId !== issue.projectId) fail('상위 티켓은 같은 프로젝트에 있어야 합니다.', status);
      if (hierarchy?.validated.has(parentId)) break;
      parentId = parent.parentId;
    }
    if (hierarchy) for (const id of visited) hierarchy.validated.add(id);
  };
  const validateIssue = (i: Issue,previous?:Issue,options?:IssueHierarchyOptions & {checkTransition?:boolean;checkFields?:boolean;allowArchivedPlanning?:boolean | ReadonlySet<string>;allowArchivedSchema?:boolean}) => {
    get('projects',i.projectId); i.title=text(i.title,'티켓 제목',300);
    normalizeIssueDescription(i);
    issueSchemas.validateIssue(i,previous,{checkFields:options?.checkFields,allowArchived:options?.allowArchivedSchema});
    if(typeof i.status!=='string'||!Object.hasOwn(PRIORITY,i.priority))fail('상태 또는 우선순위가 올바르지 않습니다.');
    if(i.assigneeId!==null)get('users',i.assigneeId);
    if (i.reporterId !== undefined && i.reporterId !== null &&
        (typeof i.reporterId !== 'string' || !store.get<User>('users', i.reporterId))) fail('등록된 요청자를 선택해 주세요.');
    if(!Array.isArray(i.collaboratorIds)||!i.collaboratorIds.every(x=>typeof x==='string'))fail('협력자를 확인해 주세요.');
    i.collaboratorIds=[...new Set(i.collaboratorIds)];i.collaboratorIds.forEach(id=>get('users',id));
    if(!Array.isArray(i.labels)||!i.labels.every(x=>typeof x==='string'&&x.length<=60))fail('라벨을 확인해 주세요.');i.labels=[...new Set(i.labels)];
    i.startDate=date(i.startDate,'시작일');i.endDate=date(i.endDate,'종료일');i.dueDate=date(i.dueDate,'마감일');dateRange(i.startDate,i.endDate);
    if(i.estimate!==null&&(!Number.isFinite(i.estimate)||i.estimate<0||i.estimate>100000))fail('예상 작업량은 0 이상의 숫자여야 합니다.');
    validatePlannedEffortMinutes(i.plannedEffortMinutes);
    planning.validateIssueReferences(i,previous,{allowArchived:options?.allowArchivedPlanning});
    validateIssueHierarchy(i, options);
    workflows.validateIssue(i,previous,options);return i;
  };
  type DocumentParent = Pick<DocPage, 'id' | 'projectId' | 'parentId'>;
  type ProjectedDocumentHierarchy = { documents: ReadonlyMap<string, DocumentParent>; validated: Set<string> };
  const storedDocumentParent = store.db.prepare('SELECT id, project_id AS projectId, parent_id AS parentId FROM documents WHERE id=?');
  const validateDocumentHierarchy = (document: DocumentParent, projected?: ProjectedDocumentHierarchy) => {
    if (projected?.validated.has(document.id)) return;
    const visited = new Set([document.id]);
    const status = projected ? 409 : 400;
    for (let parentId = document.parentId; parentId;) {
      if (visited.has(parentId)) fail('문서 트리에 순환 관계가 있습니다.', status);
      visited.add(parentId);
      const parent = projected ? projected.documents.get(parentId) ??
        (storedDocumentParent.get(parentId) as DocumentParent | undefined) ?? fail('이관할 상위 문서를 찾을 수 없습니다.', 409)
        : get<DocPage>('documents', parentId);
      if (parent.projectId !== document.projectId) fail('상위 문서는 같은 프로젝트에 있어야 합니다.', status);
      if (projected?.validated.has(parentId)) break;
      parentId = parent.parentId;
    }
    if (projected) for (const id of visited) projected.validated.add(id);
  };
  const validateDocument = (d: DocPage, previous?: DocPage, options: {allowMissing?: boolean;skipReferences?:boolean;
    hierarchy?: ProjectedDocumentHierarchy} = {}) => {
    d.title=text(d.title,'문서 제목',300);if(d.projectId!==null)get('projects',d.projectId);get('users',d.authorId);
    normalizeDocumentMetadataLabels(d);
    const normalized=documentContent.normalize(d.content);d.content=normalized.content;d.plainText=normalized.plainText;if(!options.skipReferences)documentContent.validate(d.id,d.content,previous?.content,options);if(!['draft','published'].includes(d.status))fail('문서 상태를 확인해 주세요.');
    if(typeof d.icon!=='string'||d.icon.length>20)fail('아이콘을 확인해 주세요.');
    validateDocumentHierarchy(d, options.hierarchy);
    return d;
  };
  const revision = (d: DocPage, authorId: string, summary: string) => store.put('revisions',{id:uid(),documentId:d.id,version:d.version,title:d.title,content:d.content,plainText:d.plainText,authorId,createdAt:now(),summary});
  const validateDependency = (d: Dependency, current: Dependency[] = store.all<Dependency>('dependencies')) => {
    if(d.predecessorId===d.successorId)fail('자기 자신에게 의존할 수 없습니다.');
    const a=get<Issue>('issues',d.predecessorId),b=get<Issue>('issues',d.successorId);
    if(a.projectId!==b.projectId)fail('의존성은 같은 프로젝트 안에서 연결해 주세요.');
    if(!isDependencyType(d.type)||!isDependencyLag(d.lagDays))fail('업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
    validateDependencyVersion(d);
    const successors=new Map<string,string[]>();
    for(const edge of current){
      if(edge.id===d.id)continue;
      if(edge.predecessorId===d.predecessorId&&edge.successorId===d.successorId)fail('이미 연결된 의존성입니다.',409);
      const next=successors.get(edge.predecessorId);
      if(next)next.push(edge.successorId);else successors.set(edge.predecessorId,[edge.successorId]);
    }
    const todo=[d.successorId],seen=new Set<string>();
    while(todo.length){
      const id=todo.pop()!;
      if(id===d.predecessorId)fail('의존성에 순환 관계가 생깁니다.');
      if(seen.has(id))continue;
      seen.add(id);
      for(const successor of successors.get(id)??[])todo.push(successor);
    }
  };
  const saveNewDependency = (req: Request, dependency: Dependency, current?: Dependency[]) => {
    validateDependency(dependency, current);
    store.put('dependencies', dependency);
    activity(req, 'issue', dependency.successorId, '선행 업무 연결', get<Issue>('issues', dependency.predecessorId).key);
    return dependency;
  };
  const scheduleWarnings = (issues: Issue[], dependencies=store.all<Dependency>('dependencies')) => {
    const map=new Map(issues.map(i=>[i.id,i])); const warnings:string[]=[];const mathCache=new Map<string,ReturnType<typeof createCalendarMath>>();
    const mathFor=(projectId:string)=>{let math=mathCache.get(projectId);if(!math){math=createCalendarMath(calendars.get(projectId));mathCache.set(projectId,math);}return math;};
    for(const dep of dependencies){
      const prior=map.get(dep.predecessorId),next=map.get(dep.successorId);
      if(!prior||!next)continue;
      const warning=dependencyScheduleWarning(dep,prior,next,mathFor(prior.projectId));
      if(warning)warnings.push(warning);
    }
    return warnings;
  };
  const writeScheduleDependencyChanges = (req:Request, changes:ScheduleDependencyMutation[], projectIds:Set<string>, undoId:string|null): ScheduleDependencyMutation[] => changes.map(change => {
    const {before,after} = change;
    const link = after ?? before!;
    const predecessor = get<Issue>('issues',link.predecessorId);
    const undo = undoId === null;
    projectIds.add(predecessor.projectId);
    if (!after) {
      store.remove('dependencies',link.id);
      if (undoId !== null) {
        store.db.prepare('INSERT INTO schedule_dependency_removals(predecessor_id,successor_id,undo_id) VALUES(?,?,?)')
          .run(link.predecessorId,link.successorId,undoId);
      }
      activity(req,'issue',link.successorId,undo?'선행 업무 연결 되돌리기':'선행 업무 연결 해제',predecessor.key);
      return change;
    }
    const version = before ? nextDependencyVersion(before) : undo ? nextDependencyVersion(after) : 1;
    const next = {...after,version};
    store.put('dependencies',next);
    trackDependencyVersion(version);
    const action = undo ? '선행 업무 연결 되돌리기' : before ? '선후행 일정 변경' : '선행 업무 연결';
    activity(req,'issue',link.successorId,action,`${predecessor.key} · ${next.type} ${next.lagDays}근무일`);
    return {before,after:next};
  });
  const prepareDependencyUndo = (undoId:string, changes:ScheduleDependencyMutation[]): ScheduleDependencyMutation[] => {
    const current = store.all<Dependency>('dependencies');
    const byId = new Map(current.map(link => [link.id,link]));
    const pairs = new Set(current.map(link => dependencyPair(link.predecessorId,link.successorId)));
    const removal = store.db.prepare('SELECT undo_id FROM schedule_dependency_removals WHERE predecessor_id=? AND successor_id=?');
    const reverse = changes.map(({before,after}): ScheduleDependencyMutation => {
      const link = after ?? before!;
      const predecessor = store.get<Issue>('issues',link.predecessorId), successor = store.get<Issue>('issues',link.successorId);
      if (!predecessor || !successor || predecessor.projectId!==successor.projectId) fail('선행 또는 후행 업무를 확인한 뒤 되돌려 주세요.',409);
      const saved = byId.get(link.id);
      if (after) {
        if (!saved || saved.version!==after.version || saved.type!==after.type || saved.lagDays!==after.lagDays ||
          saved.predecessorId!==after.predecessorId || saved.successorId!==after.successorId) fail('업무 연결이 변경되었습니다. 현재 연결을 확인해 주세요.',409);
        return {before:after,after:before};
      }
      const marker = removal.get(link.predecessorId,link.successorId);
      if (saved || pairs.has(dependencyPair(link.predecessorId,link.successorId)) || marker?.undo_id!==undoId) {
        fail('업무 연결이 변경되었습니다. 현재 연결을 확인해 주세요.',409);
      }
      return {before:null,after:link};
    });
    if (reverse.some(change=>!change.before) && hasScheduleDependencyCycle(projectScheduleDependencies(current,reverse))) {
      fail('되돌리면 업무 연결에 순환 관계가 생깁니다. 현재 연결을 확인해 주세요.',409);
    }
    return reverse;
  };
  const undoScopeKey = (scope:ScheduleUndoScope) => scope.kind === 'team' ? 'team' : `${scope.kind}:${scope.id}`;
  const undoScope = (kind:unknown,id:unknown):ScheduleUndoScope => {
    if(kind==='team'&&id===undefined)return {kind};
    if((kind==='project'||kind==='issue')&&typeof id==='string'&&id)return {kind,id};
    return fail('일정 되돌리기 화면을 확인해 주세요.');
  };
  const requestedUndoScope = (req:Request):ScheduleUndoScope|undefined => {
    const header=req.header('X-Teamspace-Schedule-Undo-Scope');
    if(header===undefined)return;
    if(header==='team')return {kind:'team'};
    const colon=header.indexOf(':');
    if(colon<0)return fail('일정 되돌리기 화면을 확인해 주세요.');
    let id:string;
    try{id=decodeURIComponent(header.slice(colon+1));}
    catch{return fail('일정 되돌리기 화면을 확인해 주세요.');}
    return undoScope(header.slice(0,colon),id);
  };
  const checkUndoOrigin = (scope:ScheduleUndoScope,origin:ScheduleUndoOrigin,projectIds:Set<string>) => {
    if(scope.kind==='team')return;
    if(scope.kind==='project'){
      get<Project>('projects',scope.id);
      if(origin.selectableProject||origin.projectId===scope.id||(projectIds.size===1&&projectIds.has(scope.id)))return;
    }else if(origin.issueId===scope.id)return get<Issue>('issues',scope.id).projectId;
    return fail('일정 변경에 해당하는 화면을 확인해 주세요.');
  };
  const prepareScheduleUndo = (record:ScheduleUndoRecord) => {
    if(record.scope?.startsWith('issue:')&&record.scopeProjectId!==store.get<Issue>('issues',record.scope.slice('issue:'.length))?.projectId) {
      fail('업무가 다른 프로젝트로 옮겨졌거나 현재 찾을 수 없습니다.',409);
    }
    if(record.scope?.startsWith('project:')&&!store.get<Project>('projects',record.scope.slice('project:'.length))) {
      fail('일정을 변경한 프로젝트를 찾을 수 없습니다.',409);
    }
    const previousPlan=record.plan&&get<PlanningItem>('planning_items',record.plan.id);
    if(record.plan&&previousPlan)checkVersion(previousPlan,record.plan.appliedVersion);
    for(const entry of record.records)checkVersion(get<Issue>('issues',entry.id),entry.appliedVersion);
    const reverseLinks=record.linkChanges?.length?prepareDependencyUndo(record.id,record.linkChanges):[];
    return {previousPlan,reverseLinks};
  };
  /** Caller owns the transaction, shared by manual edits and guarded proposals. */
  const commitScheduleChanges=(req:Request,changes:unknown,dependencies?:Dependency[],plan?:ScheduleUndoPlan,
    dependencyChanges:ScheduleDependencyMutation[] = [],allowDueDate=false,origin:ScheduleUndoOrigin={})=>{
    if(!Array.isArray(changes)||(!changes.length&&!plan&&!dependencyChanges.length)||changes.length>1000)return fail('변경할 일정이나 업무 연결을 선택해 주세요.');
    const scope=requestedUndoScope(req);
    const seen=new Set<string>(),records:ScheduleUndoIssue[]=[],updated:Issue[]=[];
    for(const c of changes){
      if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.id!=='string')fail('일정 변경 형식을 확인해 주세요.');
      if(seen.has(c.id))fail('중복된 티켓입니다.');seen.add(c.id);
      const old=get<Issue>('issues',c.id);checkVersion(old,c.expectedVersion);
      if(!Object.hasOwn(c,'startDate')||!Object.hasOwn(c,'endDate'))fail('시작일과 종료일 값을 지정해 주세요.');
      const dueDate=allowDueDate&&Object.hasOwn(c,'dueDate')?date(c.dueDate,'목표 마감일'):old.dueDate;
      const i=validateIssue({...old,startDate:date(c.startDate,'시작일'),endDate:date(c.endDate,'종료일'),dueDate,version:old.version+1,updatedAt:now()},old,{checkTransition:false});
      const dueChanged=allowDueDate&&i.dueDate!==(old.dueDate??null);
      records.push({id:i.id,appliedVersion:i.version,startDate:old.startDate,endDate:old.endDate,...(dueChanged?{dueDate:old.dueDate??null}:{})});
      store.put('issues',i);
      activity(req,'issue',i.id,'일정 변경',`${issueScheduleLabel(old,dueChanged)} → ${issueScheduleLabel(i,dueChanged)}`);updated.push(i);
    }
    const projectIds=new Set(updated.map(issue=>issue.projectId));
    const undoId=uid();
    const linkChanges=writeScheduleDependencyChanges(req,dependencyChanges,projectIds,undoId);
    const scopeProjectId=scope&&checkUndoOrigin(scope,origin,projectIds);
    const record:ScheduleUndoRecord={id:undoId,records,used:false,actorId:actor(req),appliedAt:now(),
      ...(scope?{scope:undoScopeKey(scope)}:{}),...(scopeProjectId?{scopeProjectId}:{}),
      ...(plan?{plan}:{}),...(linkChanges.length?{linkChanges}:{})};
    const linkDetail=linkChanges.length?` · 업무 연결 ${linkChanges.length}건`:'';
    store.put('schedule_undos',record);activity(req,'schedule',undoId,'일정 일괄 변경',`${plan?'계획 1개 · ':''}${updated.length}개 티켓${linkDetail}`);
    const warnings=projectIds.size?scheduleWarnings(store.all<Issue>('issues').filter(issue=>projectIds.has(issue.projectId)),dependencies):[];
    return{undoId,updated,warnings,...(linkChanges.length?{dependencyChanges:linkChanges.length}:{})};
  };
  const scheduleVersions=(projectId:string)=>({calendar:calendars.get(projectId).version,workflow:workflows.get(projectId).version,schema:issueSchemas.get(projectId).version});
  const validateScheduleChange=(issue:Issue,change:ScheduleDateMutation):string|null=>{
    try {
      const {startDate,endDate,dueDate=issue.dueDate}=change;
      validateIssue({...issue,startDate,endDate,dueDate},issue,{checkTransition:false});
      return null;
    } catch(error) {
      if((error instanceof ApiError||error instanceof WorkflowError||error instanceof IssueSchemaError||error instanceof PlanningError)&&error.status<500)return error.message;
      throw error;
    }
  };
  const checkCalendarVersions=(value:unknown,changes:any[])=>{
    if(value===undefined)return;
    if(!value||typeof value!=='object'||Array.isArray(value))fail('달력 버전 목록을 확인해 주세요.');
    const versions=value as Record<string,unknown>;
    if(Object.keys(versions).length>1000)fail('달력 버전 목록이 너무 큽니다.');
    for(const [projectId,version]of Object.entries(versions)){if(!Number.isSafeInteger(version)||Number(version)<1)fail('달력 버전이 올바르지 않습니다.');if(calendars.get(projectId).version!==version)fail('업무 달력이 변경되었습니다. 일정을 다시 미리 확인해 주세요.',409);}
    for(const c of changes){if(!c||typeof c!=='object'||typeof c.id!=='string')fail('일정 변경 형식을 확인해 주세요.');const issue=get<Issue>('issues',c.id);if(!Object.hasOwn(versions,issue.projectId))fail('변경할 업무의 달력 버전이 필요합니다.');}
  };
  const done=(issue:Issue)=>workflows.get(issue.projectId).statuses.find(status=>status.id===issue.status)?.category==='done';
  const issueAssignments=new IssueAssignmentRulesService(store);
  type IssueChangeOptions = { assigneeExplicit?: boolean; checkTransition?: boolean; skipAutomaticDueDate?: boolean };
  const defaultStatusDueDate = (before: Issue, proposed: Issue, skip = false): string | null => {
    if (skip || before.projectId !== proposed.projectId || before.status === proposed.status ||
        before.dueDate != null || proposed.dueDate != null) return null;
    const status = workflows.get(proposed.projectId).statuses.find(status => status.id === proposed.status);
    if (status?.defaultDueWorkdays == null) return null;
    const transitionDate = reservationLocalDateTime(proposed.updatedAt).slice(0, 10);
    return createCalendarMath(calendars.get(proposed.projectId)).shift(transitionDate, status.defaultDueWorkdays);
  };
  const prepareIssueChange=(before:Issue,proposed:Issue,options:IssueChangeOptions={})=>{
    const automaticDueDate = defaultStatusDueDate(before, proposed, options.skipAutomaticDueDate);
    const datedIssue = automaticDueDate ? { ...proposed, dueDate: automaticDueDate } : proposed;
    const decision=issueAssignments.decide(before,datedIssue,options.assigneeExplicit ?? false);
    const issue=validateIssue(decision?.outcome==='assigned'?{...datedIssue,assigneeId:decision.assigneeId}:datedIssue,before,options);
    issue.completedAt=done(issue)?(before.completedAt||issue.updatedAt):null;
    return {issue,decision,automaticDueDate};
  };
  const recordAutomaticDueDate = (actorId: string, issue: Issue, dueDate: string | null) => {
    if (!dueDate) return;
    const status = workflows.get(issue.projectId).statuses.find(status => status.id === issue.status);
    recordActivity(actorId, 'issue', issue.id, '목표 마감일 자동 지정', `${status?.label ?? issue.status} · ${dueDate}`, issue.updatedAt);
  };
  const commitIssueAssignment=(decision:IssueAssignmentDecision|null,before:Issue,issue:Issue,actorId:string,source:'user'|'gitlab',sourceEventId:string|null=null)=>{
    if(!decision)return;
    issueAssignments.record(decision,before,issue,{actorId,source,sourceEventId});
    if(decision.outcome==='assigned'){
      const assignee=issue.assigneeId?store.get<User>('users',issue.assigneeId):undefined;
      store.put('activities',{id:uid(),resourceType:'issue',resourceId:issue.id,actorId,action:'담당자 자동 배정',
        detail:`${decision.rule.name} · ${assignee?.name??issue.assigneeId}`,createdAt:issue.updatedAt});
    }
  };
  const automation=new AutomationService(store,{
    getGitlabSettings:()=>gitlab.settings(),
    prepareChange:(before,status,onStatusChange)=>{
      const {issue,decision,automaticDueDate}=prepareIssueChange(before,{...before,status,version:before.version+1,updatedAt:now()});
      if(decision || automaticDueDate)onStatusChange((rule,event)=>{
        commitIssueAssignment(decision,before,issue,rule.actorId,'gitlab',event.id);
        recordAutomaticDueDate(rule.actorId,issue,automaticDueDate);
      });
      return issue;
    },
    commitChange:(rule,before,next,event)=>{
      store.put('issues',next);
      store.put('activities',{id:uid(),resourceType:'issue',resourceId:next.id,actorId:rule.actorId,action:'GitLab 자동화 상태 변경',detail:`${before.status} → ${next.status} · ${rule.name} · ${event.id}`,createdAt:now()});
      if(next.assigneeId&&next.assigneeId!==before.assigneeId)notifyIssue(next,rule.actorId,'issue-assigned',[next.assigneeId],next.updatedAt);
    },
  });
  const gitlab:GitlabIntegrationService=new GitlabIntegrationService(store,{
    processEvent:event=>automation.processEvent(event),
    onConnectionChanged:(previous,next)=>automation.onConnectionChanged(previous,next),
    findArchivedBranchLink:cursorId=>trash.findGitlabBranchLink(cursorId),
    jiraSources:()=>gitlabJiraSources(store),
    jiraOriginalKeys:route=>gitlabJiraOriginalKeys(store,route),
    previousIssueKeys:()=>previousIssueKeys(store),
    onIssueBranchAttached:(actorId,issueId,link)=>recordActivity(actorId,'issue',issueId,'GitLab 브랜치 연결',`${link.sourceBranch} · 저장소 ${link.projectId}`),
  },options.gitlabWebhookPublicOrigin);
  const issueProjectMove = new IssueProjectMoveService(store, {
    schema: projectId => issueSchemas.get(projectId), workflow: projectId => workflows.get(projectId),
    calendar: projectId => calendars.get(projectId), order: projectId => issueOrders.get(projectId),
    plans: projectId => planning.forProject(projectId),
    validate: (issue, moveParents) => { validateIssue(issue, undefined, { moveParents }); },
    validationMessage: error => (error instanceof ApiError || error instanceof IssueSchemaError || error instanceof WorkflowError ||
      error instanceof PlanningError || error instanceof WorkloadError) && error.status < 500 ? error.message : null,
    appendOrder: (order, ids) => issueOrders.appendTransferredIssues(order, ids),
  });
  const outbound=new OutboundWebhookService(store,{autoStart:options.outboundWorker!==false});
  legacyImport.registerRoutes(app,{actor,activity});
  sourcePreservation.registerRoutes(app);
  registerSourceReconciliationRoutes(app, { store, files, preservation: sourcePreservation, trash });
  const jiraRefreshFields = new Set<string>(JIRA_MIGRATION_ISSUE_FIELDS);
  const prepareJiraRefresh = (update: MigrationJiraIssueUpdate, projectId: string, allowStandard: boolean, allowCustom: boolean) => {
    const before = store.get<Issue>('issues', update.issueId);
    if (!before || before.projectId !== projectId || before.version !== update.expectedVersion) {
      return fail('이관을 검토하는 동안 업무가 변경되었습니다. 미리보기를 다시 만들어 주세요.', 409);
    }
    const { customFields, descriptionFormat, ...changes } = update.changes;
    const hasDescriptionFormat = Object.hasOwn(update.changes, 'descriptionFormat');
    if (hasDescriptionFormat !== Object.hasOwn(changes, 'description') ||
        (hasDescriptionFormat && descriptionFormat !== 'plain' && descriptionFormat !== 'markdown')) {
      fail('Jira 설명과 표시 서식을 함께 확인해 주세요. 새 미리보기를 만들어 주세요.', 409);
    }
    const fields = Object.keys(changes);
    if (fields.length && (!allowStandard || fields.some(field => !jiraRefreshFields.has(field)))) {
      fail('Jira에서 반영할 업무 필드를 확인해 주세요.', 409);
    }
    if (customFields !== undefined && (!allowCustom || !customFields || typeof customFields !== 'object' || Array.isArray(customFields))) {
      fail('Jira에서 반영할 사용자 정의 필드를 확인해 주세요.', 409);
    }
    const customIds = Object.keys(customFields ?? {});
    if (!fields.length && !customIds.length) fail('Jira에서 반영할 업무 필드를 확인해 주세요.', 409);
    const mergedFields = customIds.length ? { ...before.customFields, ...customFields } : before.customFields;
    const after = { ...before, ...changes, ...(hasDescriptionFormat ? { descriptionFormat } : {}),
      customFields: mergedFields, version: before.version + 1, updatedAt: now() };
    if (fields.includes('parentId') && after.parentId !== null && (typeof after.parentId !== 'string' || !after.parentId)) {
      fail(`${before.key} · 이관할 상위 티켓의 ID를 확인해 주세요.`, 409);
    }
    return { before, after, fields, customIds };
  };
  const prepareJiraRefreshes = (value: PreparedMigration) => {
    const updates = value.issueUpdates ?? [];
    if (!updates.length) return { refreshedIssues: [], hierarchy: undefined };
    const projectId = value.append?.projectId;
    const append = value.preview.configuration.appendTo;
    const allowStandard = append?.refreshExisting === true, allowCustom = append?.refreshCustomFields === true;
    if (!projectId || append?.projectId !== projectId || (!allowStandard && !allowCustom) ||
        new Set(updates.map(update => update.issueId)).size !== updates.length) {
      return fail('Jira에서 변경분을 반영할 프로젝트와 업무를 확인해 주세요.', 409);
    }
    const refreshedIssues = updates.map(update => prepareJiraRefresh(update, projectId, allowStandard, allowCustom));
    // Project final parents together so moving both ends of an existing link can be checked before either write.
    const hierarchy: ProjectedIssueHierarchy | undefined = refreshedIssues.some(({ before, after }) => before.parentId !== after.parentId)
      ? { issues: new Map([...value.issues, ...refreshedIssues.map(({ after }) => after)].map(issue => [issue.id, issue])), validated: new Set() }
      : undefined;
    const schema = issueSchemas.get(projectId);
    if (hierarchy) for (const issue of value.issues) {
      try { validateIssueHierarchy(issue, { hierarchy }); }
      catch (error) {
        if (error instanceof ApiError) fail(`${issue.key} · ${error.message}`, error.status);
        throw error;
      }
    }
    for (const { before, after, fields, customIds } of refreshedIssues) {
      try { validateIssue(after, before, { hierarchy }); }
      catch (error) {
        if (error instanceof ApiError || error instanceof IssueSchemaError || error instanceof WorkflowError ||
            error instanceof PlanningError || error instanceof WorkloadError) return fail(`${before.key} · ${error.message}`, error.status);
        throw error;
      }
      if (customIds.length) {
        const visible = visibleIssueFieldIds(schema, after);
        if (customIds.some(id => !visible.has(id))) return fail(`${before.key} · 표시 조건에 맞는 사용자 정의 필드를 확인해 주세요.`, 422);
        for (const field of schema.fields) if (customIds.includes(field.id)) fields.push(field.name);
      }
      after.completedAt = done(after) ? (before.completedAt || after.updatedAt) : null;
    }
    return { refreshedIssues, hierarchy };
  };
  const confluenceRefreshFields = new Set<string>(CONFLUENCE_MIGRATION_DOCUMENT_FIELDS);
  const prepareConfluenceRefreshes = (value: PreparedMigration) => {
    const updates = value.documentUpdates ?? [];
    if (!updates.length) return [];
    const projectId = value.appendPages?.projectId;
    if (!projectId || value.preview.configuration.appendPagesTo?.refreshExisting !== true ||
        new Set(updates.map(update => update.documentId)).size !== updates.length) {
      return fail('Confluence에서 변경분을 반영할 프로젝트와 문서를 확인해 주세요.', 409);
    }
    const prepared = updates.map(update => {
      const before = store.get<DocPage>('documents', update.documentId);
      if (!before || before.projectId !== projectId || before.version !== update.expectedVersion) {
        return fail('이관을 검토하는 동안 문서가 변경되었습니다. 미리보기를 다시 만들어 주세요.', 409);
      }
      const fields = Object.keys(update.changes);
      if (!fields.length || fields.some(field => !confluenceRefreshFields.has(field))) {
        return fail('Confluence에서 반영할 문서 필드를 확인해 주세요.', 409);
      }
      if (Object.hasOwn(update.changes, 'labels')) {
        const labels = normalizeDocumentLabels(update.changes.labels);
        if (!labels || JSON.stringify(labels) !== JSON.stringify(update.changes.labels)) {
          return fail('Confluence에서 반영할 문서 라벨을 확인해 주세요.', 409);
        }
      }
      const bodyChanged = Object.hasOwn(update.changes, 'content');
      if (bodyChanged && collaboration.hasReadyEditors(before.id)) {
        return fail(`‘${before.title}’에서 공동 편집 중입니다. 참여자가 나간 뒤 문서 변경분을 다시 검토해 주세요.`, 409);
      }
      const version = before.version + 1;
      if (!Number.isSafeInteger(version)) return fail('문서의 버전 범위를 초과했습니다.', 409);
      const after = { ...before, ...update.changes, version, updatedAt: now() };
      if (Object.hasOwn(update.changes, 'parentId') && after.parentId !== null &&
          (typeof after.parentId !== 'string' || !after.parentId)) {
        return fail('이관할 상위 문서의 ID를 확인해 주세요.', 409);
      }
      return { before, after, bodyChanged };
    });
    const hasParentChange = prepared.some(({ before, after }) => before.parentId !== after.parentId);
    const hierarchy: ProjectedDocumentHierarchy | undefined = hasParentChange ? {
      documents: new Map([...value.documents, ...prepared.map(({ after }) => after)].map(document => [document.id, document])),
      validated: new Set(),
    } : undefined;
    for (const { before, after } of prepared) validateDocument(after, before, { skipReferences: true, hierarchy });
    if (hierarchy) for (const document of value.documents) validateDocumentHierarchy(document, hierarchy);
    documentContent.validateBatch([
      ...value.documents.map(({ id, content }) => ({ id, content })),
      ...prepared.map(({ before, after }) => ({ id: after.id, content: after.content, previousContent: before.content })),
    ]);
    return prepared;
  };
  migrations.registerRoutes(app, {
    actor,
    validateIssueUpdates(value: PreparedMigration) {
      try { prepareJiraRefreshes(value); }
      catch (error) {
        if (!(error instanceof ApiError)) throw error;
        value.preview.canApply = false;
        value.preview.notices.unshift({ severity: 'error', code: 'JIRA_REFRESH_VALIDATION',
          message: error.message, recordId: null, requiresAcknowledgement: false });
      }
    },
    validateDocumentUpdates(value: PreparedMigration) {
      try { prepareConfluenceRefreshes(value); }
      catch (error) {
        if (!(error instanceof ApiError || error instanceof DocumentContentError)) throw error;
        value.preview.canApply = false;
        value.preview.notices.unshift({ severity: 'error', code: 'CONFLUENCE_REFRESH_VALIDATION',
          message: error.message, recordId: null, requiresAcknowledgement: false });
      }
    },
    afterApply(value: PreparedMigration) {
      for (const update of value.documentUpdates ?? []) {
        if (Object.hasOwn(update.changes, 'content')) collaboration.reset(update.documentId, 'Confluence 원본 변경으로 문서 본문을 갱신했습니다.');
        else collaboration.notifyMetadata(update.documentId);
      }
    },
    persistCanonical(value, req) {
      const { refreshedIssues, hierarchy: issueHierarchy } = prepareJiraRefreshes(value);
      const refreshedDocuments = prepareConfluenceRefreshes(value);
      const importedWorklogs = value.worklogs ?? [];
      const issueHistoryOwners = new Set(value.jiraHistoryOwners ?? []);
      const newJiraComments = value.comments.filter(comment => issueHistoryOwners.has(comment.resourceId)).length;
      const newJiraWorklogs = importedWorklogs.filter(worklog => issueHistoryOwners.has(worklog.issueId)).length;
      const hasJiraHistory = newJiraComments > 0 || newJiraWorklogs > 0;
      const jiraAttachmentOwners = new Set(value.jiraAttachmentOwners ?? []);
      const newJiraAttachments = value.attachments.filter(file => jiraAttachmentOwners.has(file.resourceId)).length;
      const newIssueIds = new Set(value.issues.map(issue => issue.id));
      const jiraRelationRefresh = value.append ? value.issueRelations.filter(relation =>
        !newIssueIds.has(relation.sourceIssueId) && !newIssueIds.has(relation.targetIssueId)) : [];
      const attachmentOwners = new Set(value.confluenceAttachmentOwners ?? []);
      const newConfluenceAttachments = value.attachments.filter(file => attachmentOwners.has(file.resourceId)).length;
      const newConfluenceVersions = value.attachmentVersions.filter(version => version.sourceRevision !== undefined).length;
      const historyOwners = new Set(value.confluenceHistoryOwners ?? []);
      const newConfluenceComments = value.comments.filter(comment => historyOwners.has(comment.resourceId)).length;
      const newConfluenceRevisions = value.revisions.filter(revision => historyOwners.has(revision.documentId)).length;
      const hasConfluenceHistory = newConfluenceComments > 0 || newConfluenceRevisions > 0;
      if (value.appendPages) {
        const { projectId } = value.appendPages;
        get<Project>('projects', projectId);
        const newDocumentIds = new Set(value.documents.map(document => document.id));
        const newAttachmentIds = new Set(value.attachments.map(attachment => attachment.id));
        if (attachmentOwners.size && (value.preview.configuration.appendPagesTo?.refreshAttachments !== true ||
            [...attachmentOwners].some(id => store.get<DocPage>('documents', id)?.projectId !== projectId))) {
          fail('첨부를 추가할 기존 Confluence 문서를 확인해 주세요.', 409);
        }
        if (historyOwners.size && (value.preview.configuration.appendPagesTo?.refreshHistory !== true ||
            [...historyOwners].some(id => store.get<DocPage>('documents', id)?.projectId !== projectId))) {
          fail('댓글과 이력을 추가할 기존 Confluence 문서를 확인해 주세요.', 409);
        }
        if (value.projects.length || value.workflows.length || value.issueSchemas.length || value.issues.length || importedWorklogs.length ||
            (!value.documents.length && !refreshedDocuments.length && !newConfluenceAttachments && !newConfluenceVersions && !hasConfluenceHistory) ||
            value.documents.some(document => document.projectId !== projectId || store.get('documents', document.id)) ||
            value.revisions.some(revision => store.get('revisions', revision.id) || (newDocumentIds.has(revision.documentId)
              ? revision.confluenceSourceVersion !== undefined
              : !historyOwners.has(revision.documentId) || revision.confluenceSourceVersion !== revision.version ||
                !Number.isSafeInteger(revision.version) || revision.version < 1)) ||
            value.comments.some(record => record.resourceType !== 'document' || store.get('comments', record.id) ||
              (!newDocumentIds.has(record.resourceId) && !historyOwners.has(record.resourceId))) ||
            value.attachments.some(file => file.resourceType !== 'document' || (!newDocumentIds.has(file.resourceId) && !attachmentOwners.has(file.resourceId)) ||
              store.get('attachments', file.id) || store.get('attachment_versions', file.id))) {
          fail('기존 프로젝트에 추가할 문서의 범위가 올바르지 않습니다.',409);
        }
        for (const version of value.attachmentVersions) {
          if (version.sourceRevision === undefined && newAttachmentIds.has(version.attachmentId)) continue;
          const anchor = store.get<Attachment>('attachments', version.attachmentId);
          if (version.sourceRevision === undefined || !attachmentOwners.has(version.resourceId) || version.resourceType !== 'document' ||
              anchor?.resourceType !== 'document' || anchor.resourceId !== version.resourceId) {
            fail('기존 Confluence 첨부의 원본 버전과 문서를 확인해 주세요.', 409);
          }
        }
      } else if (value.append) {
        const { projectId, startIssueNumber } = value.append;
        const project = get<Project>('projects', projectId);
        const historyRecords = value.sourceRecords.filter(record => record.jiraHistoryAppend === true);
        const commentTargets = new Map(historyRecords.filter(record => record.targetType === 'comment').map(record => [record.targetId, record.ownerId]));
        const worklogSources = new Map(historyRecords.filter(record => record.record.kind === 'history').map(record => [record.id, record.ownerId]));
        const attachmentTargets = new Map(value.sourceRecords.filter(record => record.jiraAttachmentAppend === true).map(record => [record.targetId, record.ownerId]));
        const incomingAttachments = new Map(value.attachments.map(file => [file.id, file.resourceId]));
        const rootVersions = new Set(value.attachmentVersions.filter(version => version.id === version.attachmentId).map(version => version.id));
        if (issueHistoryOwners.size && (value.preview.configuration.appendTo?.refreshHistory !== true ||
            [...issueHistoryOwners].some(id => store.get<Issue>('issues', id)?.projectId !== projectId))) {
          fail('댓글과 작업 시간을 추가할 기존 Jira 업무를 확인해 주세요.', 409);
        }
        if (jiraAttachmentOwners.size && (value.preview.configuration.appendTo?.refreshAttachments !== true ||
            [...jiraAttachmentOwners].some(id => store.get<Issue>('issues', id)?.projectId !== projectId))) {
          fail('첨부파일을 추가할 기존 Jira 업무를 확인해 주세요.', 409);
        }
        if (jiraRelationRefresh.length) {
          const relationProjects = new Set(value.sourceImport.projectIds);
          const outsideReview = jiraRelationRefresh.some(relation => {
            const source = store.get<Issue>('issues', relation.sourceIssueId);
            const target = store.get<Issue>('issues', relation.targetIssueId);
            return !source || !target || !relationProjects.has(source.projectId) || !relationProjects.has(target.projectId) ||
              (source.projectId !== projectId && target.projectId !== projectId);
          });
          if (value.preview.configuration.appendTo?.refreshRelations !== true || outsideReview) {
            fail('선택한 프로젝트에 연결된 양쪽 Jira 업무의 이관 기록을 확인해 주세요.', 409);
          }
        }
        const current = store.db.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId) as { next_number: number } | undefined;
        if ((current?.next_number ?? 1) !== startIssueNumber) fail('새 업무 번호가 변경되었습니다. 이관 미리보기를 다시 만들어 주세요.',409);
        if (value.projects.length || value.workflows.length || value.issueSchemas.length || value.documents.length || value.revisions.length ||
            (!value.issues.length && !refreshedIssues.length && !hasJiraHistory && !newJiraAttachments && !jiraRelationRefresh.length) ||
            !Number.isSafeInteger(startIssueNumber + value.issues.length) || value.issues.some((issue,index)=>
              issue.projectId !== projectId || issue.key !== `${project.key}-${startIssueNumber + index}` || store.get('issues',issue.id)) ||
            value.comments.some(comment => comment.resourceType !== 'issue' || store.get('comments', comment.id) ||
              (!newIssueIds.has(comment.resourceId) && (!issueHistoryOwners.has(comment.resourceId) || commentTargets.get(comment.id) !== comment.resourceId))) ||
            importedWorklogs.some(worklog => worklog.projectId !== projectId || (!newIssueIds.has(worklog.issueId) &&
              (!issueHistoryOwners.has(worklog.issueId) || worklogSources.get(worklog.sourceRecordId ?? '') !== worklog.issueId))) ||
            value.attachments.some(file => file.resourceType !== 'issue' || store.get('attachments', file.id) || store.get('attachment_versions', file.id) ||
              (!newIssueIds.has(file.resourceId) && (!jiraAttachmentOwners.has(file.resourceId) || attachmentTargets.get(file.id) !== file.resourceId ||
                !rootVersions.has(file.id)))) ||
            value.attachmentVersions.some(version => version.resourceType !== 'issue' || incomingAttachments.get(version.attachmentId) !== version.resourceId ||
              (attachmentTargets.has(version.attachmentId) && (version.id !== version.attachmentId ||
                version.localRevision !== undefined || version.sourceRevision !== undefined)))) {
          fail('기존 프로젝트에 추가할 업무의 범위나 번호가 올바르지 않습니다.',409);
        }
        if (value.issues.length) store.db.prepare(`INSERT INTO issue_sequences VALUES(?,?) ON CONFLICT(project_id)
          DO UPDATE SET next_number=excluded.next_number`).run(projectId,startIssueNumber + value.issues.length);
      } else {
        const schemas = issueSchemas.validateImport(value.issueSchemas, value.projects, value.issues, {users:store.all<User>('users')});
        const importedWorkflows = workflows.validateImport(value.workflows, value.projects, value.issues, schemas);
        validateVisibilityStatuses(schemas, importedWorkflows);
        for (const project of value.projects) store.put('projects', validateProject(project));
        for (const schema of schemas) store.put('issue_schemas', schema);
        for (const workflow of importedWorkflows) store.put('workflows', workflow);
      }
      const planningProjects = value.appendPages ? [] : value.append ? [value.append.projectId] : value.projects.map(project => project.id);
      const jiraPlans = planning.persistMigratedJiraPlans(value.planningItems ?? [], new Set(planningProjects));
      const historicalPlans = new Set(jiraPlans.filter(item => item.status === 'archived').map(item => item.id));
      for (const item of jiraPlans) activity(req, 'planning', item.id, item.kind === 'cycle' ? 'Jira 스프린트 이관' : 'Jira 릴리스 이관', item.name);
      // Insert both sets first so forward references can be validated against the complete plan.
      for (const issue of value.issues) store.put('issues', issue);
      for (const document of value.documents) store.put('documents', document);
      for (const { before, after } of refreshedDocuments) {
        store.put('documents', after);
        if (before.parentId !== after.parentId) documentOrders.trackMigratedParentChange(before, after);
      }
      const firstDocument = value.documents[0];
      if (firstDocument && !refreshedDocuments.length) documentContent.validate(firstDocument.id, firstDocument.content);
      validateDocumentListProjects([...value.documents, ...value.revisions].map(document => document.content), id => Boolean(store.get('projects', id)));
      for (const issue of value.issues) store.put('issues', validateIssue(issue, undefined, {
        checkFields: false, allowArchivedSchema: true, allowArchivedPlanning: historicalPlans, hierarchy: issueHierarchy,
      }));
      for (const document of value.documents) store.put('documents', validateDocument(document, undefined, {skipReferences:true}));
      for (const { before, after, fields } of refreshedIssues) {
        store.put('issues', after);
        reportLedger.recordImportedIssueUpdate(before, after, actor(req));
        activity(req, 'issue', after.id, 'Jira 원본 변경분 반영', fields.join(', '));
      }
      for (const { after, bodyChanged } of refreshedDocuments) {
        const document = bodyChanged ? collaboration.replaceBody(after) : collaboration.deriveSnapshot(after);
        if (!bodyChanged && document !== after) store.put('documents', document);
        revision(document, actor(req), 'Confluence 원본 변경분 반영');
        activity(req, 'document', document.id, 'Confluence 원본 변경분 반영', document.title);
      }
      const worklogRows = importedWorklogs.map(worklog => {
        if (!issueHistoryOwners.has(worklog.issueId)) return worklog;
        const { key, title } = get<Issue>('issues', worklog.issueId);
        return { ...worklog, issueKey: key, issueTitle: title };
      });
      worklogs.persistMigrated(worklogRows, value.sourceRecords);
      for (const comment of value.comments) store.put('comments', comment);
      for (const revision of value.revisions) store.put('revisions', revision);
      for (const attachment of value.attachments) store.put('attachments', attachment);
      for (const link of value.resourceLinks) store.put('resource_links', link);
      for (const link of value.atlassianLinks??[]) atlassianLinks.create(link);
      for (const relation of jiraRelationRefresh) {
        const source = get<Issue>('issues', relation.sourceIssueId);
        const target = get<Issue>('issues', relation.targetIssueId);
        activity(req, 'issue', source.id, 'Jira 업무 관계 이관', `${relation.type} · ${target.key}`);
        activity(req, 'issue', target.id, 'Jira 업무 관계 이관', `${relation.type} · ${source.key}`);
      }
      if (!value.append && !value.appendPages) {
        const nextNumbers = new Map(value.projects.map(project => [project.id, 1]));
        for (const issue of value.issues) {
          const number = Number(issue.key.split('-').at(-1));
          nextNumbers.set(issue.projectId, Math.max(nextNumbers.get(issue.projectId)!, number + 1));
        }
        const insertSequence = store.db.prepare('INSERT INTO issue_sequences VALUES(?,?)');
        for (const [projectId, next] of nextNumbers) insertSequence.run(projectId, next);
      }
      reportLedger.baselineImportedIssues(value.issues);
      const action = refreshedIssues.length || hasJiraHistory || newJiraAttachments || jiraRelationRefresh.length ? 'Jira 원본 변경분 반영' : (refreshedDocuments.length || newConfluenceAttachments || newConfluenceVersions || hasConfluenceHistory) ? 'Confluence 원본 변경분 반영' :
        value.appendPages ? 'Confluence 신규 문서 추가' : value.append ? 'Jira 신규 업무 추가' : '원본 이관 적용';
      const details = [`${value.issues.length}개 업무`, `${value.documents.length}개 문서`];
      if (refreshedIssues.length) details.push(`기존 업무 ${refreshedIssues.length}개 변경`);
      if (newJiraComments) details.push(`기존 업무에 원본 댓글 ${newJiraComments}개 추가`);
      if (newJiraWorklogs) details.push(`기존 업무에 원본 작업 시간 ${newJiraWorklogs}개 추가`);
      if (newJiraAttachments) details.push(`기존 업무에 원본 첨부파일 ${newJiraAttachments}개 추가`);
      if (jiraRelationRefresh.length) details.push(`기존 업무 사이에 Jira 관계 ${jiraRelationRefresh.length}개 추가`);
      if (refreshedDocuments.length) details.push(`기존 문서 ${refreshedDocuments.length}개 변경`);
      if (newConfluenceAttachments) details.push(`기존 문서에 첨부 ${newConfluenceAttachments}개 추가`);
      if (newConfluenceVersions) details.push(`기존 첨부에 버전 ${newConfluenceVersions}개 추가`);
      if (newConfluenceComments) details.push(`기존 문서에 원본 댓글 ${newConfluenceComments}개 추가`);
      if (newConfluenceRevisions) details.push(`기존 문서에 원본 이력 ${newConfluenceRevisions}개 추가`);
      activity(req, 'source-import', value.sourceImport.id, action, details.join(' · '));
    },
  });
  worklogs.registerRoutes(app,{actor,activity});
  timeReservations.registerRoutes(app,{actor,activity});
  const fieldBreakdownMatches = registerFieldBreakdownRoutes(app,store,issueSchemas,projectId=>workflows.get(projectId));
  function createReportDocument(
    req: Request, capture: Pick<ReportSnapshot, 'documentId' | 'title' | 'actorId' | 'createdAt'> & { projectId: string | null },
    content: RichContent, issueIds: string[], kind: '주간 보고서' | '진행 차단 회의' | '결정 후속 업무 회의' = '주간 보고서',
  ): DocPage {
    const document = validateDocument({
      id: capture.documentId, projectId: capture.projectId, parentId: null, title: capture.title, content, plainText: '',
      icon: '📊', status: 'draft', version: 1, authorId: capture.actorId, createdAt: capture.createdAt, updatedAt: capture.createdAt,
    });
    store.put('documents', document);
    revision(document, capture.actorId, '보고서에서 작성');
    const action = { '주간 보고서': '주간 문서 생성', '진행 차단 회의': '진행 차단 문서 생성', '결정 후속 업무 회의': '결정 후속 업무 회의 문서 생성' }[kind];
    activity(req, 'document', document.id, action, document.title);
    for (const issueId of issueIds) store.put('resource_links', { id: uid(), issueId, documentId: document.id, kind });
    notifyDocumentCreated(document);
    return document;
  }
  registerDeliveryBlockerRoutes(app, {
    store, schemas: issueSchemas, calendars, issueRelations, actor, documentCreation, projectScope: req => apiKeys.projectScope(req),
    createDocument: (req, capture, content, issueIds) => createReportDocument(req, capture, content, issueIds, '진행 차단 회의'),
  });
  reports.registerRoutes(app,{
    actor,
    documentCreation,
    createDocument: createReportDocument,
  });
  automation.registerRoutes(app,{actor,activity});outbound.registerRoutes(app,{actor,activity});gitlab.registerRoutes(app,{actor,activity});
  issueAssignments.registerRoutes(app,{actor,activity,validate:(proposed,before)=>{
    const dueDate = defaultStatusDueDate(before, proposed);
    return validateIssue(dueDate ? { ...proposed, dueDate } : proposed, before);
  }});
  workflows.registerRoutes(app,{actor,activity});savedViews.registerRoutes(app,{
    actor, activity, planningItems: projectId => planning.forProject(projectId),
    issueOrder: projectId => issueOrders.get(projectId), workflow: projectId => workflows.get(projectId),
  });
  savedFieldBreakdowns.registerRoutes(app, { actor, activity });
  issueSchemas.registerRoutes(app,{actor,activity});
  planning.registerRoutes(app,{actor,activity,validateIssue,findSavedViewReference:item=>savedViews.findPlanningItemReference(item)});apiKeys.registerManagementRoutes(app,{actor,activity});
  calendars.registerRoutes(app,{actor,activity});
  app.get('/api/projects/:projectId/workload-capacity',(req,res)=>{
    if(Object.keys(req.query).length)return fail('가용 시간 조회 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').json(workload.get(String(req.params.projectId)));
  });
  app.patch('/api/projects/:projectId/workload-capacity',(req,res)=>{
    actor(req);
    if(Object.keys(req.query).length)return fail('가용 시간 저장 조건을 확인해 주세요.');
    const capacity=workload.save(String(req.params.projectId),req.body,value=>activity(req,'project',value.projectId,'프로젝트 가용 시간 변경',`버전 ${value.version}`));
    res.json(capacity);
  });
  app.get('/api/projects/:projectId/workload',(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='startDate'&&key!=='endDate'))return fail('작업량 조회 조건을 확인해 주세요.');
    const projectId=String(req.params.projectId), capacity=workload.get(projectId);
    const rows=store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY rowid').all(projectId) as {json:string}[];
    const terminalStatusIds=workflows.get(projectId).statuses.filter(status=>status.category==='done'||status.category==='cancelled').map(status=>status.id);
    const result=calculateProjectWorkload({
      startDate:req.query.startDate,endDate:req.query.endDate,capacity,calendar:calendars.get(projectId),terminalStatusIds,
      issues:rows.map(row=>JSON.parse(row.json) as Issue),userIds:store.all<User>('users').map(user=>user.id),
    });
    res.set('Cache-Control','no-store').json(result);
  });
  registerTeamWorkloadRoutes(app,{store,capacity:teamCapacity,calendars,workflows,actor,activity});
  app.get('/api/projects/:projectId/schedule-analysis', (req, res) => {
    if (Object.keys(req.query).length) return fail('일정 여유 분석 조회 조건을 확인해 주세요.');
    const projectId = String(req.params.projectId);
    const calendar = calendars.get(projectId);
    const workflow = workflows.get(projectId);
    const issues = store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY rowid LIMIT ?')
      .all(projectId, MAX_SCHEDULE_ANALYSIS_TASKS + 1) as { json: string }[];
    if (issues.length > MAX_SCHEDULE_ANALYSIS_TASKS) throw new ScheduleAnalysisError(422, `프로젝트 업무 ${MAX_SCHEDULE_ANALYSIS_TASKS.toLocaleString('ko-KR')}개까지 분석할 수 있습니다.`);
    const dependencies = store.db.prepare(`
      SELECT dependency.json FROM dependencies AS dependency
      JOIN issues AS predecessor ON predecessor.id=dependency.predecessor_id
      JOIN issues AS successor ON successor.id=dependency.successor_id
      WHERE ? IN (predecessor.project_id, successor.project_id)
      ORDER BY dependency.rowid LIMIT ?
    `).all(projectId, MAX_SCHEDULE_ANALYSIS_DEPENDENCIES + 1) as { json: string }[];
    if (dependencies.length > MAX_SCHEDULE_ANALYSIS_DEPENDENCIES) throw new ScheduleAnalysisError(422, `업무 연결 ${MAX_SCHEDULE_ANALYSIS_DEPENDENCIES.toLocaleString('ko-KR')}개까지 분석할 수 있습니다.`);
    const analysis = analyzeProjectSchedule({
      projectId, calendar, workflow,
      issues: issues.map(({ json }) => JSON.parse(json) as Issue),
      dependencies: dependencies.map(({ json }) => JSON.parse(json) as Dependency),
    });
    res.set('Cache-Control', 'no-store').json(analysis);
  });
  automaticSchedule.registerRoutes(app,{actor,
    commitChanges:(request,changes,origin)=>commitScheduleChanges(request,changes,undefined,undefined,[],false,origin),
  },{
    capacity:projectId=>workload.get(projectId),teamCapacity:()=>teamCapacity.get(),
    workflow:projectId=>workflows.get(projectId),validateChange:validateScheduleChange,
    teamBlockers:()=>issueRelations.teamScheduleBlockers(),
  });
  schedulePaste.registerRoutes(app,{
    actor,
    versions:scheduleVersions,
    calendar:projectId=>calendars.get(projectId),
    workflow:projectId=>workflows.get(projectId),
    validateChange:validateScheduleChange,
    warnings:scheduleWarnings,
    projectBlockers:projectIds=>issueRelations.localScheduleBlockers(projectIds),
    commitChanges:(request,changes,dependencies,linkChanges,origin)=>commitScheduleChanges(request,changes,dependencies,undefined,linkChanges,true,origin),
  });
  planScheduleShift.registerRoutes(app,{
    actor,calendar:projectId=>calendars.get(projectId),versions:scheduleVersions,
    isTerminal(issue){
      const category=workflows.get(issue.projectId).statuses.find(status=>status.id===issue.status)?.category;
      return category==='done'||category==='cancelled';
    },
    validateChange:validateScheduleChange,warnings:scheduleWarnings,
    commit(req,item,dates,changes,dependencies){
      const plan=planning.writeScheduleDates(item.id,item.version,dates);
      activity(req,'planning',plan.id,'계획 일정 변경',`${planScheduleLabel(item)} → ${planScheduleLabel(plan)}`);
      const planUndo:ScheduleUndoPlan={id:item.id,appliedVersion:plan.version,dates:{startDate:item.startDate,endDate:item.endDate,targetDate:item.targetDate}};
      return {...commitScheduleChanges(req,changes,dependencies,planUndo,[],false,{projectId:item.projectId}),plan};
    },
  });
  scheduleArtifacts.registerRoutes(app,{actor,activity,getCalendar:projectId=>calendars.get(projectId)});

  app.get('/api/health',(_req,res)=>res.json({ok:true,storage:'sqlite',version:'0.1.0'}));
  app.get('/api/workspace',(req,res)=>{
    const { teamBoardSince, ganttSince } = req.query;
    if (teamBoardSince !== undefined && (typeof teamBoardSince !== 'string' || !/^[a-f0-9]{32}$/u.test(teamBoardSince))) {
      return fail('팀 보드에서 확인한 버전을 보내 주세요.');
    }
    if (ganttSince !== undefined && (typeof ganttSince !== 'string' || !/^[a-f0-9]{32}$/u.test(ganttSince))) {
      return fail('간트에서 확인한 버전을 보내 주세요.');
    }
    if (teamBoardSince !== undefined && ganttSince !== undefined) return fail('갱신을 확인할 보기 하나만 지정해 주세요.');
    const { boardRevision, ganttRevision, data } = workspaceRevisions.read({ teamBoardSince, ganttSince }, snapshot);
    res.set({ 'X-Teamspace-Board-Revision': boardRevision, 'X-Teamspace-Gantt-Revision': ganttRevision, 'Cache-Control': 'no-store' });
    if (data === null) return res.status(204).end();
    res.json(data);
  });
  registerTeamOverviewRoutes(app,{
    store,timeReservations,
    snapshot:()=>({projects:store.all('projects'),issues:store.all('issues'),workflows:workflows.snapshot(),gitlabLinks:store.all('gitlab_links')}),
  });
  registerDecisionFollowUpRoutes(app, {
    store, actor, documentCreation,
    workflow: projectId => workflows.get(projectId),
    projectScope: req => apiKeys.projectScope(req),
    authorizeDocumentBody: (req, content) => apiKeys.authorizeDocumentBody(req, content),
    createDocument: (req, capture, content, issueIds) => createReportDocument(req, capture, content, issueIds, '결정 후속 업무 회의'),
  });
  app.get('/api/atlassian-links',(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='targetType'&&key!=='targetId'))return fail('기존 도구 링크 조회 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').json(atlassianLinks.list(req.query.targetType,req.query.targetId));
  });
  app.get('/api/atlassian-links/resolve', (req, res) => {
    if (Object.keys(req.query).length !== 1 || typeof req.query.url !== 'string') return fail('검색할 원본 주소 한 개를 입력해 주세요.');
    const address = parseAtlassianSearchInput(req.query.url);
    if (!address) return fail('Jira 업무 또는 Confluence 페이지 주소를 확인해 주세요.');
    res.set('Cache-Control', 'no-store').json({ targets: atlassianLinks.resolve(address) });
  });
  app.post('/api/atlassian-links',(req,res)=>{
    actor(req);
    if(Object.keys(req.query).length)return fail('기존 도구 링크 추가 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').status(201).json(atlassianLinks.create(req.body));
  });
  app.delete('/api/atlassian-links/:id',(req,res)=>{
    actor(req);
    if(Object.keys(req.query).length)return fail('기존 도구 링크 삭제 조건을 확인해 주세요.');
    atlassianLinks.remove(req.params.id);
    res.status(204).end();
  });
  app.get('/api/atlassian-links/:id/preview',async(req,res)=>{
    actor(req);
    if(Object.keys(req.query).length)return fail('원본 조회 조건을 확인해 주세요.');
    const link=atlassianLinks.get(req.params.id);
    const controller=new AbortController();
    const disconnect=()=>controller.abort();
    res.set('Cache-Control','no-store');
    res.once('close',disconnect);
    try {
      const preview=await atlassian.preview(link.product,link.url,controller.signal);
      if(controller.signal.aborted)return;
      const current=atlassianLinks.get(link.id);
      if(current.url!==link.url||current.product!==link.product||current.targetType!==link.targetType||current.targetId!==link.targetId){
        return fail('원본 링크가 변경되었습니다. 다시 불러와 주세요.',409);
      }
      res.json(preview);
    } catch(error) {
      if(!controller.signal.aborted)throw error;
    } finally { res.off('close',disconnect); }
  });
  const requireSelectedActor = (req: Request) => {
    const recipientId = req.header('X-Actor-Id');
    if (!recipientId || !store.get('users',recipientId)) return fail('등록된 작업자를 선택해 주세요.');
    return recipientId;
  };
  function favoriteTarget(req: Request) {
    const { resourceType, resourceId } = req.params;
    if ((resourceType !== 'issue' && resourceType !== 'document') || typeof resourceId !== 'string' || !resourceId || Object.keys(req.query).length ||
        (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
      return fail('즐겨찾기 대상을 확인해 주세요.');
    }
    return { resourceType, resourceId } as const;
  }
  app.get('/api/favorites', (req, res) => {
    if (Object.keys(req.query).length) return fail('즐겨찾기 조회 조건을 확인해 주세요.');
    res.set('Cache-Control', 'no-store').json(favorites.list(requireSelectedActor(req)));
  });
  app.put('/api/favorites/:resourceType/:resourceId', (req, res) => {
    const userId = requireSelectedActor(req), { resourceType, resourceId } = favoriteTarget(req);
    res.set('Cache-Control', 'no-store').json(favorites.add(userId, resourceType, resourceId));
  });
  app.delete('/api/favorites/:resourceType/:resourceId', (req, res) => {
    const userId = requireSelectedActor(req), { resourceType, resourceId } = favoriteTarget(req);
    favorites.remove(userId, resourceType, resourceId);
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.get('/api/notifications/count',(req,res)=>{
    if (Object.keys(req.query).length) return fail('알림 수에 조회 조건을 지정할 수 없습니다.');
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(requireSelectedActor(req))});
  });
  app.get('/api/notifications',(req,res)=>{
    const {filter='all',before}=req.query;
    if (Object.keys(req.query).some(key=>key!=='filter'&&key!=='before') || (filter!=='all'&&filter!=='unread') ||
      (before!==undefined&&(typeof before!=='string'||!before))) return fail('알림 조회 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').json(notifications.list(requireSelectedActor(req),filter,before));
  });
  app.get('/api/notifications/deadline-reminders', (req, res) => {
    if (Object.keys(req.query).length) return fail('마감 알림의 조회 조건을 확인해 주세요.');
    res.set('Cache-Control', 'no-store').json(deadlineReminders.get(requireSelectedActor(req)));
  });
  app.put('/api/notifications/deadline-reminders', (req, res) => {
    if (Object.keys(req.query).length) return fail('마감 알림의 변경 조건을 확인해 주세요.');
    res.set('Cache-Control', 'no-store').json(deadlineReminders.update(requireSelectedActor(req), req.body));
  });
  function subscriptionTarget(req: Request) {
    const {targetType,targetId}=req.params;
    if ((targetType!=='issue'&&targetType!=='document'&&targetType!=='project'&&targetType!=='space') ||
      typeof targetId!=='string' || !targetId || Object.keys(req.query).length) {
      return fail('구독 대상을 확인해 주세요.');
    }
    if(targetType==='space'){
      const projectId=documentNotificationSpaceProject(targetId);
      if(projectId===undefined)return fail('문서 공간 구독 대상을 확인해 주세요.');
      if(projectId!==null)get('projects',projectId);
    }else get(targetType==='issue'?'issues':targetType==='document'?'documents':'projects',targetId);
    return {targetType,targetId} as const;
  }
  app.get('/api/notifications/subscriptions/:targetType/:targetId',(req,res)=>{
    const userId=requireSelectedActor(req), {targetType,targetId}=subscriptionTarget(req);
    res.set('Cache-Control','no-store').json({subscribed:subscriptions.isSubscribed(userId,targetType,targetId)});
  });
  app.put('/api/notifications/subscriptions/:targetType/:targetId',(req,res)=>{
    const userId=requireSelectedActor(req), {targetType,targetId}=subscriptionTarget(req);
    if (Object.keys(req.body).length!==1 || typeof req.body.subscribed!=='boolean') return fail('구독 여부를 확인해 주세요.');
    res.set('Cache-Control','no-store').json(subscriptions.setSubscribed(userId,targetType,targetId,req.body.subscribed));
  });
  app.patch('/api/notifications/read-all',(req,res)=>{
    const recipientId=requireSelectedActor(req), throughId=text(req.body.throughId,'알림 ID',200);
    if (!notifications.markAllRead(recipientId,throughId)) return fail('알림을 찾을 수 없습니다.',404);
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(recipientId)});
  });
  app.patch('/api/notifications/:id/read',(req,res)=>{
    const recipientId=requireSelectedActor(req);
    if (!notifications.markRead(recipientId,req.params.id)) return fail('알림을 찾을 수 없습니다.',404);
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(recipientId)});
  });
  app.post('/api/users',(req,res)=>{const u=validateUser({id:uid(),name:req.body.name,email:req.body.email,color:req.body.color||'#5879ed'});store.put('users',u);res.status(201).json(u);});
  app.patch('/api/users/:id',(req,res)=>{const u=get('users',req.params.id);const updated=validateUser({...u,...Object.fromEntries(['name','email','color'].filter(k=>k in req.body).map(k=>[k,req.body[k]]))});store.transaction(()=>{store.put('users',updated);activity(req,'user',u.id,'팀원 정보 변경');});res.json(updated);});
  app.post('/api/projects',(req,res)=>{const p=validateProject({id:uid(),key:req.body.key,name:req.body.name,description:req.body.description||'',color:req.body.color||'#5879ed',createdAt:now()});store.transaction(()=>{store.put('projects',p);store.db.prepare('INSERT INTO issue_sequences VALUES(?,1)').run(p.id);activity(req,'project',p.id,'프로젝트 생성',p.name);});res.status(201).json(p);});
  const prepareIssueUpdate = (old: Issue, values: Record<string, unknown>, options?: IssueChangeOptions, updatedAt = now()) => {
    if(values.projectId&&values.projectId!==old.projectId)fail('다른 프로젝트로 옮기려면 업무 상세에서 프로젝트 이동 미리보기를 사용해 주세요.');
    const fields=['title','description','descriptionFormat','type','status','priority','assigneeId','reporterId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','plannedEffortMinutes','cycle','module','release','cycleId','moduleId','releaseId','customFields'].filter(k=>k in values);
    const proposed={...old,...Object.fromEntries(fields.map(k=>[k,values[k]])),...planning.resolveIssueFields(values,old.projectId,old),version:old.version+1,updatedAt};
    const prepared = prepareIssueChange(old, proposed, { ...options, skipAutomaticDueDate: options?.skipAutomaticDueDate || fields.includes('dueDate') });
    if (prepared.automaticDueDate) fields.push('dueDate');
    return {...prepared,fields};
  };
  const commitIssueUpdate = (req: Request, old: Issue, {issue,decision,automaticDueDate,fields}:ReturnType<typeof prepareIssueUpdate>, history?: { action: string; detail: string }) => {
    const actorId=actor(req);
    let detail = history?.detail ?? `${issue.key}: ${fields.join(', ')}`;
    if (old.reporterId !== issue.reporterId) {
      const reporterName = (id: Issue['reporterId']) => id ? get<User>('users', id).name : id === null ? '미지정' : '확인되지 않음';
      detail += ` · 요청자 ${reporterName(old.reporterId)} → ${reporterName(issue.reporterId)}`;
    }
    store.put('issues',issue);activity(req,'issue',issue.id,history?.action ?? '티켓 변경',detail);
    if(issue.assigneeId&&issue.assigneeId!==old.assigneeId)notifyIssue(issue,actorId,'issue-assigned',[issue.assigneeId],issue.updatedAt);
    commitIssueAssignment(decision,old,issue,actorId,'user');
    recordAutomaticDueDate(actorId,issue,automaticDueDate);
    return issue;
  };
  const issueEditConfiguration = (projectId: string) => JSON.stringify([
    workflows.get(projectId).version, issueSchemas.get(projectId).version, issueAssignments.revisions(projectId),
  ]);
  cycleCompletion.registerRoutes(app, {
    actor,
    activity,
    workflow: projectId => workflows.get(projectId),
    configurationToken: projectId => JSON.stringify([workflows.get(projectId).version, issueSchemas.get(projectId).version]),
    prepare(before, destinationId) {
      const updated = { ...before, cycleId: destinationId, version: before.version + 1, updatedAt: now() };
      const { cycle } = validateIssue(structuredClone(updated), before);
      return { issue: { ...updated, cycle }, decision: null, automaticDueDate: null, fields: ['cycleId'] };
    },
    validationMessage(error) {
      return (error instanceof ApiError || error instanceof WorkflowError || error instanceof PlanningError || error instanceof IssueSchemaError) &&
        error.status < 500 ? error.message : null;
    },
    commit: commitIssueUpdate,
    closeCycle: (id, version, timestamp) => planning.completeCycle(id, version, timestamp),
  });
  const cycleCompletionRecordsPath = '/api/projects/:projectId/cycle-completion-records';
  app.get(cycleCompletionRecordsPath, (req, res) => {
    const { id } = get<Project>('projects', req.params.projectId);
    const { cycleId, cursor, limit = '20' } = req.query;
    const isId = (value: unknown): value is string =>
      typeof value === 'string' && value.length <= 200 && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value);
    if (Object.keys(req.query).some(key => !['cycleId', 'cursor', 'limit'].includes(key)) ||
      (cycleId !== undefined && !isId(cycleId)) || (cursor !== undefined && !isId(cursor)) ||
      typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limit)) {
      return fail('사이클 완료 기록의 조회 조건을 확인해 주세요.');
    }
    res.set('Cache-Control', 'no-store').json(cycleCompletionRecords.list(id, { cycleId, cursor, limit: Number(limit) }));
  });
  app.get(`${cycleCompletionRecordsPath}/:recordId`, (req, res) => {
    if (Object.keys(req.query).length) return fail('사이클 완료 기록 상세에는 조회 조건을 사용할 수 없습니다.');
    const { id } = get<Project>('projects', req.params.projectId);
    const record = cycleCompletionRecords.get(id, req.params.recordId);
    if (!record) return fail('사이클 완료 기록을 찾을 수 없습니다.', 404);
    res.set('Cache-Control', 'no-store').json(record);
  });
  app.get('/api/projects/:projectId/cycles/:cycleId/progress', (req, res) => {
    const { projectId, cycleId } = req.params;
    const { throughDate, date, offset, expectedRevision } = req.query;
    if (Object.keys(req.query).some(key => !['throughDate', 'date', 'offset', 'expectedRevision'].includes(key)) ||
        (throughDate !== undefined && !isCalendarDate(throughDate)) || (date !== undefined && !isCalendarDate(date)) ||
        (offset !== undefined && (typeof offset !== 'string' || !/^(?:0|[1-9]\d{0,6})$/u.test(offset))) ||
        (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedRevision))) ||
        (date === undefined && (offset !== undefined || expectedRevision !== undefined)) ||
        (Number(offset) > 0 && expectedRevision === undefined)) {
      return fail('사이클 진행 추이의 날짜와 조회 위치를 확인해 주세요.');
    }
    const cycle = store.get<PlanningItem>('planning_items', cycleId);
    if (!cycle || cycle.kind !== 'cycle' || cycle.projectId !== projectId) return fail('프로젝트의 사이클을 찾을 수 없습니다.', 404);
    const latest = cycle.status === 'completed' ? cycleCompletionRecords.list(projectId, { cycleId, limit: 1 }).items[0] : undefined;
    // Native restore may renew a plan's version while preserving its last edit time.
    const completedAt = latest && latest.completedAt === cycle.updatedAt && latest.cycle.version <= cycle.version
      ? latest.completedAt : null;
    const generatedAt = now();
    const requestedRange = throughDate ? reservationDayRange(throughDate) : null;
    const horizon = completedAt && completedAt < generatedAt ? completedAt : generatedAt;
    const through = requestedRange && requestedRange.endAt <= horizon
      ? new Date(Date.parse(requestedRange.endAt) - 1).toISOString() : horizon;
    const ledger = reportLedger.readCycle(projectId, cycleId, through);
    const progress = aggregateCycleProgress(cycle, ledger, generatedAt, { completedAt, throughDate, evidenceDate: date,
      offset: offset === undefined ? undefined : Number(offset) });
    const newest = ledger.events.at(-1);
    const revision = createHash('sha256').update(JSON.stringify([projectId, cycleId, cycle.version, progress.completedAt,
      progress.windowStart, progress.windowEnd, ledger.coverage, newest?.id, newest?.sequence])).digest('hex');
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return fail('사이클 진행 추이가 바뀌었습니다. 최신 결과를 다시 불러와 주세요.', 409, { reason: 'stale_cycle_progress', revision });
    }
    if (date !== undefined && !progress.evidence) return fail('현재 조회 기간에 속하는 날짜를 선택해 주세요.');
    res.set('Cache-Control', 'no-store').json({ ...progress, revision });
  });
  issueBulkEdit.registerRoutes(app,{
    actor,
    workflow:projectId=>workflows.get(projectId),
    configurationToken(projectId, changes) {
      const editToken = issueEditConfiguration(projectId);
      const destination = workflows.get(projectId).statuses.find(status => status.id === changes.status);
      if (destination?.defaultDueWorkdays == null || Object.hasOwn(changes, 'dueDate')) return editToken;
      return JSON.stringify([editToken, calendars.get(projectId).version]);
    },
    fieldBreakdownMatches,
    prepare(before, changes, preparedAt) {
      const { customFields } = changes;
      const values = customFields ? { ...changes, customFields: { ...before.customFields, ...customFields } } : changes;
      const prepared = prepareIssueUpdate(before, values, { assigneeExplicit: Object.hasOwn(changes, 'assigneeId') }, preparedAt);
      if (!customFields) return prepared;

      const { issue } = prepared;
      const schema = issueSchemas.get(issue.projectId);
      const requested = schema.fields.filter(field => Object.hasOwn(customFields, field.id));
      const unavailable = requested.filter(field => field.archived || !fieldApplies(field, issue.type));
      if (unavailable.length) fail(`${unavailable.map(field => field.name).join(', ')} 필드는 보관되었거나 현재 업무 유형에서 편집할 수 없습니다.`, 422);

      const visible = visibleIssueFieldIds(schema, issue);
      const hidden = requested.filter(field => !visible.has(field.id));
      if (hidden.length) {
        const required = new Set(requiredFieldsFor({ workflows: [workflows.get(issue.projectId)], issueSchemas: [schema] },
          issue.projectId, issue.type, issue.status, before.status));
        const excluded = hidden.filter(field => !required.has(`custom:${field.id}`));
        if (excluded.length) fail(`${excluded.map(field => field.name).join(', ')} 필드는 현재 표시 조건에 맞지 않습니다.`, 422);
      }
      return prepared;
    },
    commit:commitIssueUpdate,
  });
  issueBulkEdit.registerStatusMigrationRoutes(app,{
    actor,
    configurationToken:issueEditConfiguration,
    workflow:projectId=>workflows.get(projectId),
    prepare:(before,changes,preparedAt)=>prepareIssueUpdate(before,{status:changes.status},{checkTransition:false,skipAutomaticDueDate:true},preparedAt),
    commit(req,before,change){
      const {statuses}=workflows.get(before.projectId);
      const from=statuses.find(status=>status.id===before.status)?.label ?? before.status;
      const to=statuses.find(status=>status.id===change.issue.status)?.label ?? change.issue.status;
      commitIssueUpdate(req,before,change,{action:'워크플로 상태 이관',detail:`${before.key} · ${from} → ${to}`});
    },
  });
  app.get('/api/projects/:id/issue-order',(req,res)=>{
    res.set('Cache-Control','no-store').json(issueOrders.get(req.params.id));
  });
  app.patch('/api/projects/:id/issue-order',(req,res)=>{
    const result = issueOrders.move(req.params.id, req.body, {
      changeIssue: (issue, changes) => commitIssueUpdate(req, issue,
        prepareIssueUpdate(issue, changes, { assigneeExplicit: Object.hasOwn(changes, 'assigneeId') })),
      recordMove: (issue,anchor,position) => {
        const location = anchor ? `${anchor.key} ${position === 'before' ? '앞으로' : '뒤로'}` : position === 'before' ? '맨 처음으로' : '맨 끝으로';
        activity(req, 'issue', issue.id, '업무 순서 변경', `${issue.key} · ${location} 이동`);
      },
    });
    res.json(result);
  });
  app.post('/api/projects/:id/cycle-board/move', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = issueOrders.moveOnCycleBoard(req.params.id, actor(req), req.body, (issue, placement) => {
      const { sourceCycle, targetCycle, orderChanged, anchor, position } = placement;
      const sourceId = sourceCycle?.id ?? null;
      const targetId = targetCycle?.id ?? null;
      const cycleLabel = targetCycle?.name ?? '백로그';
      const membership = sourceId !== targetId ? `${sourceCycle?.name ?? '백로그'} → ${cycleLabel}` : cycleLabel;
      const rank = orderChanged && anchor ? ` · ${anchor.key} ${position === 'before' ? '앞으로' : '뒤로'} 이동` : '';
      const history = { action: '사이클 보드 이동', detail: `${issue.key} · ${membership}${rank}` };
      if (sourceId !== targetId) {
        const prepared = prepareIssueUpdate(issue, { cycleId: targetId });
        const { cycleId, cycle, version, updatedAt } = prepared.issue;
        return commitIssueUpdate(req, issue, { ...prepared, issue: { ...issue, cycleId, cycle, version, updatedAt } }, history);
      }
      activity(req, 'issue', issue.id, history.action, history.detail);
      return issue;
    });
    res.json(result);
  });
  app.get('/api/issues/:id/change-history', (req, res) => {
    const cursor = req.query.beforeVersion;
    if (Object.keys(req.query).some(key => key !== 'beforeVersion') ||
        (cursor !== undefined && (typeof cursor !== 'string' || !/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))) {
      return fail('변경 기록의 조회 위치를 확인해 주세요.');
    }
    const issue = get<Issue>('issues', req.params.id);
    const scope = apiKeys.projectScope(req);
    if (scope && !scope.includes(issue.projectId)) return fail('API 키에서 허용하지 않는 프로젝트입니다.', 403);
    res.set('Cache-Control', 'no-store').json(issueChangeHistory.page(issue.id, cursor === undefined ? undefined : Number(cursor), scope ?? undefined));
  });
  app.get('/api/issues/:id/gitlab-links', (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'kind' && key !== 'offset')) return fail('GitLab 활동 조회 조건을 확인해 주세요.');
    const kind = req.query.kind ?? '';
    if (typeof kind !== 'string' || (kind && !['branch', 'commit', 'merge_request', 'pipeline'].includes(kind))) return fail('GitLab 활동 종류를 확인해 주세요.');
    const rawOffset = req.query.offset ?? '0';
    if (typeof rawOffset !== 'string' || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) return fail('GitLab 활동 조회 위치를 확인해 주세요.');
    const issue = get<Issue>('issues', req.params.id);
    const offset = Number(rawOffset), limit = 50;
    const where = `WHERE issue_id=?${kind ? " AND json_extract(json, '$.kind')=?" : ''}`;
    const args = kind ? [issue.id, kind] : [issue.id];
    const { total } = store.db.prepare(`SELECT COUNT(*) AS total FROM gitlab_links ${where}`).get(...args) as { total: number };
    const rows = store.db.prepare(`SELECT json FROM gitlab_links ${where}
      ORDER BY julianday(json_extract(json, '$.updatedAt')) DESC, id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as { json: string }[];
    res.set('Cache-Control', 'no-store').json({ links: rows.map(row => JSON.parse(row.json)), total, offset, limit });
  });
  app.post('/api/issues/query',(req,res)=>{
    const input = req.body;
    const { projectId } = input;
    if(typeof projectId!=='string'||!projectId||projectId.length>200)fail('필터를 적용할 프로젝트가 필요합니다.');
    const result=store.transaction(()=>{
      const schema=issueSchemas.get(projectId);
      const statusIds = Object.hasOwn(input, 'statusIds') ? parseIssueViewStatusIds(input.statusIds) : undefined;
      const priorities = Object.hasOwn(input, 'priorities') ? parseIssueViewPriorities(input.priorities) : undefined;
      const labels = Object.hasOwn(input, 'labels') ? parseIssueViewLabelFilter(input.labels) : undefined;
      const hasFieldFilter = Object.hasOwn(input, 'fieldFilter');
      const users = hasFieldFilter ? store.all<User>('users') : [];
      const fieldFilter = hasFieldFilter ? parseIssueFieldFilter(input.fieldFilter, schema, users) : undefined;
      if (!statusIds && !fieldFilter && !priorities && !labels) fail('업무 조회 조건을 하나 이상 지정해 주세요.');
      const matches = createIssueViewMatcher({ ...issueViewStatusCriteria(statusIds ?? []), query: '', assigneeId: 'all', type: 'all',
        fieldFilter, priorities, labels }, { issueSchemas: [schema], users }, schema);
      const rows=store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY rowid').all(projectId) as {json:string}[];
      return rows.map(row=>JSON.parse(row.json) as Issue).filter(matches);
    });
    res.json(result);
  });
  const prepareIssueCreation=(input:Record<string,unknown>,timestamp=now()):Issue=>{
    const fields=['projectId','title','description','descriptionFormat','type','status','priority','assigneeId','reporterId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','plannedEffortMinutes','cycle','module','release','customFields'];
    const projectId=text(input.projectId,'프로젝트',200);
    const activeTypes=issueSchemas.get(projectId).issueTypes.filter(type=>!type.archived);
    const i:Issue={id:uid(),key:'',projectId:'',title:'',description:'',type:activeTypes.find(type=>type.id==='작업')?.id||activeTypes[0].id,status:workflows.get(projectId).initialStatusId,priority:'medium',assigneeId:null,collaboratorIds:[],parentId:null,labels:[],startDate:null,endDate:null,dueDate:null,estimate:null,plannedEffortMinutes:null,cycle:null,module:null,release:null,version:1,createdAt:timestamp,updatedAt:timestamp,completedAt:null,...Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]))};
    Object.assign(i,planning.resolveIssueFields(input,i.projectId));
    return validateIssue(i);
  };
  // The caller owns the transaction, including any links created with the issue.
  const commitIssueCreation=(actorId:string,i:Issue,recurringName?:string):Issue=>{
    const timestamp=i.createdAt;
    if (i.reporterId === undefined) i.reporterId = actorId;
    const p=get<Project>('projects',i.projectId), row=store.db.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(i.projectId) as {next_number:number}|undefined;
    const num=row?.next_number||1;i.key=`${p.key}-${num}`;
    store.db.prepare('INSERT INTO issue_sequences VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET next_number=excluded.next_number').run(i.projectId,num+1);
    if(done(i))i.completedAt=timestamp;
    store.put('issues',i);
    const detail = `${i.key} ${i.title}`;
    recordActivity(actorId, 'issue', i.id, '티켓 생성', recurringName ? `${detail} · 반복 업무 ${recurringName}` : detail,
      recurringName ? timestamp : undefined);
    if(i.assigneeId)notifyIssue(i,actorId,'issue-assigned',[i.assigneeId],timestamp);
    notifyIssue(i,actorId,'issue-created',projectSubscribers(i).filter(id=>id!==i.assigneeId),timestamp);
    return i;
  };
  const createIssueInTransaction=(req:Request,input:Record<string,unknown>):Issue=>
    commitIssueCreation(actor(req),prepareIssueCreation(input));

  const issueTemplatesPath = '/api/projects/:projectId/issue-templates';
  app.get(issueTemplatesPath, (req, res) => {
    const includeArchived = req.query.includeArchived;
    if (includeArchived !== undefined && includeArchived !== '1') fail('보관된 양식을 보려면 includeArchived=1을 사용해 주세요.');
    res.set('Cache-Control', 'no-store').json(issueTemplates.list(req.params.projectId, includeArchived === '1'));
  });
  app.post(issueTemplatesPath, (req, res) => {
    const template = store.transaction(() => {
      const created = issueTemplates.create(req.params.projectId, req.body, actor(req));
      activity(req, 'project', created.projectId, '업무 템플릿 생성', created.name);
      return created;
    });
    res.status(201).json(template);
  });
  app.patch(`${issueTemplatesPath}/:templateId`, (req, res) => {
    const template = store.transaction(() => {
      const updated = issueTemplates.patch(req.params.projectId, req.params.templateId, req.body, actor(req));
      if (updated.version !== req.body.expectedVersion) {
        activity(req, 'project', updated.projectId, '업무 템플릿 변경', updated.name);
      }
      return updated;
    });
    res.json(template);
  });

  const recurringIssuesPath = '/api/projects/:projectId/recurring-issues';
  app.get(recurringIssuesPath, (req, res) => {
    const includeArchived = req.query.includeArchived;
    if (includeArchived !== undefined && includeArchived !== '1') fail('보관된 반복 업무를 보려면 includeArchived=1을 사용해 주세요.');
    res.set('Cache-Control', 'no-store').json(recurringIssueRules.list(req.params.projectId, includeArchived === '1'));
  });
  app.post(recurringIssuesPath, (req, res) => {
    const actorId = actor(req);
    let created = false;
    const rule = recurringIssueRules.create(req.params.projectId, req.body, actorId, saved => {
      recordActivity(actorId, 'project', saved.projectId, '반복 업무 추가', saved.name, saved.createdAt);
      created = true;
    });
    res.set('Cache-Control', 'no-store').status(created ? 201 : 200).json(rule);
  });
  app.patch(`${recurringIssuesPath}/:ruleId`, (req, res) => {
    const actorId = actor(req);
    const rule = store.transaction(() => {
      const saved = recurringIssueRules.patch(req.params.projectId, req.params.ruleId, req.body, actorId);
      if (saved.version !== req.body.expectedVersion) {
        recordActivity(actorId, 'project', saved.projectId, '반복 업무 변경', saved.name, saved.updatedAt);
      }
      return saved;
    });
    res.set('Cache-Control', 'no-store').json(rule);
  });

  const issueCreationInput = (input: Record<string, unknown>): Record<string, unknown> => {
    if (!Object.hasOwn(input, 'templateId') && !Object.hasOwn(input, 'expectedTemplateVersion')) return input;
    const projectId = text(input.projectId, '프로젝트', 200);
    const { defaults } = issueTemplates.forCreation(projectId, input.templateId, input.expectedTemplateVersion);
    const merged = { ...defaults, ...input };
    const inheritsFields = !Object.hasOwn(input, 'customFields');
    if (inheritsFields || !Object.hasOwn(input, 'type')) {
      const candidate = {
        projectId,
        type: merged.type,
        status: typeof input.status === 'string' ? input.status : workflows.get(projectId).initialStatusId,
        customFields: inheritsFields ? defaults.customFields : {},
      };
      try {
        issueSchemas.validateIssue(candidate, undefined, { checkFields: false });
      } catch (error) {
        if (error instanceof IssueSchemaError) fail(`업무 템플릿의 기본값을 확인해 주세요. ${error.message}`, 422, { reason: 'issue-template-defaults-invalid' });
        throw error;
      }
      if (inheritsFields) {
        const visible = visibleIssueFieldIds(issueSchemas.get(projectId), candidate);
        merged.customFields = Object.fromEntries(Object.entries(candidate.customFields).filter(([id]) => visible.has(id)));
      }
    }
    return merged;
  };

  function runRecurringIssues() {
    return recurringIssueRules.sweep({
      prepare(rule, processedAt, template) {
        try {
          const input = issueCreationInput({ projectId: rule.projectId, templateId: template.id,
            expectedTemplateVersion: template.version, assigneeId: rule.assigneeId, reporterId: rule.authorId });
          return { issue: prepareIssueCreation(input, processedAt) };
        } catch (error) {
          if ((error instanceof ApiError || error instanceof IssueSchemaError || error instanceof WorkflowError ||
               error instanceof PlanningError || error instanceof WorkloadError || error instanceof IssueTemplateError) && error.status < 500) {
            return { blocked: error.message };
          }
          throw error;
        }
      },
      commit: (rule, issue) => store.withMutationContext({ actorId: rule.authorId, origin: 'automation' },
        () => commitIssueCreation(rule.authorId, issue, rule.name)),
      onError: error => console.error('[teamspace recurring issues]', error instanceof Error ? error.message : error),
    });
  }

  const issuePaste = new IssuePasteService(store, {
    schema: projectId => issueSchemas.get(projectId),
    workflow: projectId => workflows.get(projectId),
    calendar: projectId => calendars.get(projectId),
    prepare: prepareIssueCreation,
    validationMessage(error) {
      return error instanceof ApiError || error instanceof IssueSchemaError || error instanceof WorkflowError ||
        error instanceof PlanningError || error instanceof WorkloadError ? error.message : null;
    },
  });
  app.post('/api/projects/:projectId/issues/paste-preview', (req, res) => {
    const scope = { projectId: String(req.params.projectId), actorId: actor(req) };
    res.set('Cache-Control', 'no-store').json(issuePaste.preview(scope, req.body.text));
  });
  app.post('/api/projects/:projectId/issues/paste-apply', (req, res) => {
    const scope = { projectId: String(req.params.projectId), actorId: actor(req) };
    const result = issuePaste.apply(scope, req.body.previewId, issue => commitIssueCreation(scope.actorId, issue),
      (dependency, batch) => saveNewDependency(req, dependency, batch));
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(result);
  });
  app.post('/api/issues',(req,res)=>{
    const result=issueCreation.create(()=>actor(req),req.body,()=>createIssueInTransaction(req,issueCreationInput(req.body)));
    res.status(result.duplicate?200:201).json(result.issue);
  });
  const registerScheduleLinkedIssue = (direction: 'predecessor' | 'successor') => {
    const createsPredecessor = direction === 'predecessor';
    const newRole = createsPredecessor ? '선행 업무' : '후행 업무';
    const anchorRole = createsPredecessor ? '후행 업무' : '선행 업무';
    const anchorKind = createsPredecessor ? 'successor' : 'predecessor';
    const versionField = createsPredecessor ? 'expectedSuccessorVersion' : 'expectedPredecessorVersion';
    const fields = new Set(['requestId', versionField, 'expectedCalendarVersion', 'type', 'lagDays', 'issue']);
    app.post(`/api/issues/:id/schedule-${direction}s`, (req, res) => {
      const input = req.body as Record<string, unknown>;
      if (Object.keys(input).some(key => !fields.has(key))) return fail(`${newRole} 생성 요청을 확인해 주세요.`);
      const { [versionField]: expectedAnchorVersion, expectedCalendarVersion, type, lagDays, issue } = input;
      if (typeof expectedAnchorVersion !== 'number' || !Number.isSafeInteger(expectedAnchorVersion) || expectedAnchorVersion < 1 ||
          typeof expectedCalendarVersion !== 'number' || !Number.isSafeInteger(expectedCalendarVersion) || expectedCalendarVersion < 1) {
        return fail(`${anchorRole}와 작업 달력의 버전을 확인해 주세요.`);
      }
      if (!isDependencyType(type) || !isDependencyLag(lagDays)) {
        return fail('업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
      }
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return fail(`생성할 ${newRole} 정보를 확인해 주세요.`);
      const issueInput = issue as Record<string, unknown>;
      const anchorId = String(req.params.id);
      const scope = createsPredecessor ? { kind: 'schedule-predecessor' as const, successorId: anchorId }
        : { kind: 'schedule-successor' as const, predecessorId: anchorId };
      const result = issueCreation.create(() => actor(req), input, () => {
        const anchor = store.get<Issue>('issues', anchorId);
        if (!anchor) return fail(`${anchorRole}를 찾을 수 없습니다.`, 404, { reason: `${anchorKind}_missing` });
        if (anchor.version !== expectedAnchorVersion) {
          return fail(`${anchorRole}가 변경되었습니다. 최신 날짜와 연결 조건을 확인해 주세요.`, 409,
            { reason: `${anchorKind}_changed`, currentVersion: anchor.version });
        }
        const calendar = calendars.get(anchor.projectId);
        if (calendar.version !== expectedCalendarVersion) {
          return fail('작업 달력이 변경되었습니다. 최신 날짜와 연결 조건을 확인해 주세요.', 409,
            { reason: 'calendar_changed', currentVersion: calendar.version });
        }
        if (Object.hasOwn(issueInput, 'projectId') && issueInput.projectId !== anchor.projectId) {
          return fail(`${newRole}는 ${anchorRole}와 같은 프로젝트에 만들어 주세요.`);
        }
        const created = createIssueInTransaction(req, { ...issueInput, projectId: anchor.projectId });
        const [predecessorId, successorId] = createsPredecessor ? [created.id, anchor.id] : [anchor.id, created.id];
        saveNewDependency(req, { id: uid(), predecessorId, successorId, type, lagDays, version: 1 });
        activity(req, 'issue', anchor.id, `${newRole} 생성`, `${created.key} ${created.title}`);
        return created;
      }, scope);
      res.status(result.duplicate ? 200 : 201).json(result.issue);
    });
  };
  registerScheduleLinkedIssue('successor');
  registerScheduleLinkedIssue('predecessor');
  app.post('/api/issues/:id/children', (req, res) => {
    const result = issueChildren.create({ parentId: String(req.params.id), actorId: actor(req), body: req.body }, {
      checkParentVersion: checkVersion,
      create(parent, input) {
        const issue = createIssueInTransaction(req, input);
        activity(req, 'issue', parent.id, '하위 업무 생성', `${issue.key} ${issue.title}`);
        return issue;
      },
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.post('/api/documents/:id/follow-up-issues',(req,res)=>{
    const actorId=actor(req);
    const result=documentFollowUp.create({documentId:String(req.params.id),actorId,body:req.body},{
      authorizeResult: (issue, link) => apiKeys.authorizeDocumentDecisionResult(req, issue, link),
      create(documentId,expectedVersion,input,sourceSelection){
        const document=get<DocPage>('documents',documentId);
        checkVersion(document,expectedVersion);
        if(document.projectId!==null&&document.projectId!==input.projectId)fail('프로젝트 문서의 후속 업무는 같은 프로젝트에 만들어 주세요.');
        if (sourceSelection) apiKeys.authorizeDocumentBody(req, document.content);
        const documentSource=sourceSelection && resolveDocumentDecisionSource(store,document,actorId,sourceSelection);
        const issue=createIssueInTransaction(req,input);
        const link:ResourceLink={id:uid(),issueId:issue.id,documentId,kind:'후속 업무',...(documentSource?{documentSource}:{})};
        store.put('resource_links',link);
        activity(req,'document',documentId,'후속 업무 생성',`${issue.key} ${issue.title}`);
        return {issue,link};
      },
    });
    res.set('Cache-Control', 'no-store').status(result.duplicate?200:201).json(result);
  });
  app.post('/api/documents/:id/decision-links', (req, res) => {
    const actorId = actor(req);
    const result = documentFollowUp.linkExisting({ documentId: String(req.params.id), actorId, body: req.body }, {
      checkVersion,
      authorizeSource: content => apiKeys.authorizeDocumentBody(req, content),
      authorizeResult: (issue, link) => apiKeys.authorizeDocumentDecisionResult(req, issue, link),
      onLinked: (issue, document) => { activity(req, 'issue', issue.id, '문서 결정 근거 연결', document.title); },
    });
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(result);
  });
  app.post('/api/issues/:id/project-move/preview', (req, res) => {
    res.set('Cache-Control', 'no-store').json(issueProjectMove.preview(req.params.id, actor(req), req.body));
  });
  app.post('/api/issues/:id/project-move/apply', (req, res) => {
    const result = issueProjectMove.apply(req.params.id, actor(req), req.body, (before, after) => {
      activity(req, 'issue', after.id, '업무를 다른 프로젝트로 이동', `${before.key} → ${after.key}`);
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
  app.patch('/api/issues/:id',(req,res)=>{
    const updated=store.transaction(()=>{
      const old=get<Issue>('issues',req.params.id);checkVersion(old,req.body.expectedVersion);
      const guardedTransition = Object.hasOwn(req.body, 'expectedWorkflowVersion');
      if (guardedTransition) {
        const { expectedWorkflowVersion } = req.body;
        if (!Object.hasOwn(req.body, 'status') || !Number.isSafeInteger(expectedWorkflowVersion) || expectedWorkflowVersion < 1) {
          fail('변경할 상태와 확인한 워크플로 버전을 보내 주세요.');
        }
        const { version } = workflows.get(old.projectId);
        if (version !== expectedWorkflowVersion) {
          fail('업무의 워크플로가 변경되었습니다. 최신 상태를 확인한 뒤 다시 변경해 주세요.', 409,
            { reason: 'workflow_changed', currentWorkflowVersion: version });
        }
      }
      return commitIssueUpdate(req, old, prepareIssueUpdate(old, req.body, {
        assigneeExplicit: guardedTransition && Object.hasOwn(req.body, 'assigneeId'),
      }));
    });res.json(updated);
  });
  app.delete('/api/issues/:id',(req,res)=>{
    const archived=store.transaction(()=>{
      const issue=get<Issue>('issues',req.params.id), version=req.body?.expectedVersion??req.query.expectedVersion;
      if(version!==undefined)checkVersion(issue,Number(version));
      if(store.db.prepare('SELECT 1 FROM issues WHERE parent_id=? LIMIT 1').get(issue.id))fail('하위 티켓을 먼저 이동하거나 휴지통에 넣어 주세요.',409);
      const entry=trash.capture('issue',issue,actor(req));
      detachArchivedChildren('issue',issue.id);
      for(const milestone of scheduleArtifacts.detachIssue(issue.id))activity(req,'milestone',milestone.id,'연결 업무 삭제',`${issue.key} 연결 해제`);
      store.remove('issues',issue.id);
      activity(req,'issue',issue.id,'업무 휴지통 이동',issue.key);
      return entry;
    });res.json({ok:true,trashEntryId:archived.id});
  });
  app.get('/api/document-templates', (req,res) => {
    const {projectId,includeArchived}=req.query;
    if(Object.keys(req.query).some(key=>!['projectId','includeArchived'].includes(key)) ||
      (projectId!==undefined&&(typeof projectId!=='string'||!projectId)) || (includeArchived!==undefined&&includeArchived!=='1')){
      return fail('템플릿을 조회할 문서 공간과 보관함 조건을 확인해 주세요.');
    }
    res.set('Cache-Control','no-store').json(documentTemplates.list(projectId??null,includeArchived==='1'));
  });
  const templateOrigins=(req:Request)=>[req.get('origin')??'',`${req.protocol}://${req.get('host')??''}`];
  app.post('/api/document-templates', (req,res) => {
    const result=documentTemplates.create(actor(req),req.body,templateOrigins(req));
    res.status(result.duplicate?200:201).json(result.template);
  });
  app.patch('/api/document-templates/:id', (req,res) => {
    res.json(documentTemplates.patch(req.params.id,actor(req),req.body,templateOrigins(req)));
  });
  function writeIssueDocumentLink(req: Request, link: ResourceLink, title = '') {
    store.put('resource_links',link);
    activity(req,'issue',link.issueId,'문서 연결',title);
  }
  // The original link ID lets a receipt distinguish a later manual link between the same resources.
  const linkedDocumentLinkId = (issueId: string, documentId: string) => deterministicCreationId(['issue-linked-document-link', issueId, documentId]);
  function createDocument(req: Request, res: Response, issueId?: string) {
    const authorId = actor(req);
    const input=req.body;
    if (issueId !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
      return fail('업무와 문서 공간, 초안 내용을 확인해 주세요.');
    }
    const usesTemplate=Object.hasOwn(input,'templateId')||Object.hasOwn(input,'expectedTemplateVersion');
    const templateFields = ['requestId','templateId','expectedTemplateVersion','projectId','parentId','title','actorId'];
    if (issueId !== undefined) templateFields.push('expectedIssueProjectId');
    const invalidLocation = (input.projectId!=null&&(typeof input.projectId!=='string'||!input.projectId))||
      (input.parentId!=null&&(typeof input.parentId!=='string'||!input.parentId));
    if (issueId !== undefined) {
      if (typeof input.requestId !== 'string' || !creationRequestId.test(input.requestId)) {
        throw new DocumentCreationError(400, '문서 생성 요청 ID를 확인해 주세요.', 'invalid_request_id');
      }
      const draftFields = ['requestId','expectedIssueProjectId','projectId','parentId','title','actorId','content','icon','labels','status'];
      if (typeof input.expectedIssueProjectId !== 'string' || !input.expectedIssueProjectId.trim() || invalidLocation ||
        Object.keys(req.query).length || (!usesTemplate && Object.keys(input).some(key => !draftFields.includes(key))) ||
        (Object.hasOwn(input,'status') && input.status !== 'draft')) {
        return fail('업무와 문서 공간, 초안 내용을 확인해 주세요.');
      }
    }
    if(usesTemplate&&(Object.keys(input).some(key=>!templateFields.includes(key))||
      typeof input.requestId!=='string'||typeof input.templateId!=='string'||!input.templateId||
      !Number.isSafeInteger(input.expectedTemplateVersion)||input.expectedTemplateVersion<1||invalidLocation)){
      return fail('팀 템플릿, 문서 공간과 저장 요청을 확인해 주세요.');
    }
    let linkedResult: ResourceLink | undefined;
    const verifyLink = issueId === undefined ? undefined : (document: DocPage) => {
      const link = store.get<ResourceLink>('resource_links', linkedDocumentLinkId(issueId, document.id));
      if (!link || link.issueId !== issueId || link.documentId !== document.id || !store.get<Issue>('issues', issueId)) {
        throw new DocumentCreationError(409, '이 요청에서 만든 업무·문서 연결을 현재 확인할 수 없습니다.', 'result_unavailable');
      }
      linkedResult = link;
    };
    let staged:ReturnType<AttachmentAppend['stage']>|undefined;
    let result:ReturnType<DocumentCreationService['create']>;
    try {
      result = documentCreation.create(authorId, input, () => {
        if (issueId !== undefined) {
          const issue = get<Issue>('issues', issueId);
          if (issue.projectId !== input.expectedIssueProjectId) {
            fail('업무의 프로젝트가 바뀌었습니다. 문서를 연결할 업무와 공간을 다시 확인해 주세요.', 409,
              {reason:'issue_project_changed',projectId:issue.projectId});
          }
        }
        const timestamp=now(), id=uid(), projectId=input.projectId??null;
        if(usesTemplate&&projectId!==null)get<Project>('projects',projectId);
        const template=usesTemplate?documentTemplates.forDraft(input.templateId,input.expectedTemplateVersion,projectId):null;
        const draft=template?documentTemplateAssets.forDraft(template.id,templateDraftContent(template,id),id,authorId,timestamp):null;
        const content=draft?draft.content:Object.hasOwn(input,'content')?input.content:{type:'doc',content:[{type:'paragraph'}]};
        const d:DocPage={id,projectId,parentId:input.parentId??null,title:input.title,
          ...(Object.hasOwn(input,'labels')?{labels:input.labels}:{}),content,
          plainText:'',icon:template?.icon??(input.icon||'📄'),status:template?'draft':input.status||'draft',version:1,authorId,createdAt:timestamp,updatedAt:timestamp};
        validateDocument(d,undefined,{allowMissing:Boolean(template)});
        bindImportedDocumentSections(d);
        store.put('documents',d);
        if(draft?.files.length){
          staged=documentDraftFiles.stage(id,draft.files.map(({attachment,bytes})=>({id:attachment.id,size:attachment.size,sha256:attachment.sha256,bytes})));
          for(const {attachment} of draft.files){
            store.put('attachments',attachment);
            activity(req,'document',d.id,'파일 첨부',attachment.filename);
          }
          staged.install();
        }
        revision(d,authorId,template?`팀 템플릿 사용 · ${template.name}`:'최초 작성');
        activity(req,'document',d.id,'문서 생성',d.title);
        if (issueId !== undefined) {
          writeIssueDocumentLink(req, { id: linkedDocumentLinkId(issueId, d.id), issueId, documentId: d.id, kind: '관련 문서' }, d.title);
        }
        notifyDocumentCreated(d);
        return d;
      },issueId !== undefined ? `issue-linked-document:${issueId}` : usesTemplate ? 'document-template-draft' : undefined,verifyLink);
    } catch(error) {
      try{staged?.rollback();}catch{console.error('[teamspace attachments] 템플릿 첨부 복구 기록 정리가 필요합니다.');}
      throw error;
    }
    try{staged?.commit();}catch{console.error('[teamspace attachments] 템플릿 첨부 복구 기록 정리가 필요합니다.');}
    const status = result.duplicate ? 200 : 201;
    if (issueId === undefined) return res.status(status).json(result.document);
    if (!linkedResult) throw new Error('The linked document receipt has no resource link');
    const payload: LinkedDocumentCreationResult = { document: result.document, link: linkedResult };
    return res.status(status).json(payload);
  }
  app.post('/api/documents',(req,res)=>createDocument(req,res));
  app.post('/api/issues/:id/documents',(req,res)=>createDocument(req,res,req.params.id));
  app.get('/api/documents/:id/sibling-order', (req, res) => {
    res.set('Cache-Control', 'no-store').json(documentOrders.get(req.params.id));
  });
  app.patch('/api/documents/:id/sibling-order', (req, res) => {
    actor(req);
    const order = documentOrders.save(req.params.id, req.body, document => {
      activity(req, 'document', document.id, '문서 순서 변경', document.title);
    });
    res.set('Cache-Control', 'no-store').json(order);
  });
  app.post('/api/document-markdown-import/preview', async (req, res) => {
    const { projectId, parentId } = req.query;
    if (typeof projectId !== 'string' || typeof parentId !== 'string') return fail('문서 공간과 상위 위치를 지정해 주세요.');
    const result = await markdownArchiveImport.preview({ projectId: projectId || null, parentId: parentId || null }, actor(req), req.body);
    res.set('Cache-Control', 'no-store').json(result);
  });
  app.post('/api/document-markdown-import/apply', async (req, res) => {
    const { previewId } = req.query;
    if (typeof previewId !== 'string') return fail('검토한 Markdown ZIP 미리보기를 지정해 주세요.');
    const authorId = actor(req);
    const result = await markdownArchiveImport.apply(previewId, authorId, req.body, {
      validateDocument: document => { validateDocument(document, undefined, { skipReferences: true }); },
      validateBatch: documents => documentContent.validateBatch(documents.map(({ id, content }) => ({ id, content }))),
      record(document) {
        revision(document, authorId, 'Markdown ZIP 가져오기');
        activity(req, 'document', document.id, 'Markdown ZIP에서 문서 생성', document.title);
      },
    });
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(result);
  });
  app.post('/api/documents/:id/copy-preview', (req, res) => {
    res.set('Cache-Control', 'no-store').json(documentTreeCopy.preview(req.params.id, actor(req), req.body, templateOrigins(req)));
  });
  app.post('/api/documents/:id/copy', (req, res) => {
    const authorId = actor(req);
    const sourceId = req.params.id;
    let staged: ReturnType<AttachmentAppend['stage']> | undefined;
    let result: ReturnType<DocumentCreationService['create']>;
    try {
      result = documentCreation.create(authorId, req.body, () => {
        const { documents, originals, files: copiedFiles } = documentTreeCopy.prepareCopy(sourceId, authorId, req.body, templateOrigins(req), now());
        const [root] = documents;
        const edits = documents.map((document, index) => {
          const original = originals[index];
          validateDocument(document, original, { skipReferences: true });
          store.put('documents', document);
          return { id: document.id, content: document.content, previousContent: original.content };
        });
        documentContent.validateBatch(edits);
        if (copiedFiles.length) {
          staged = documentDraftFiles.stage(root.id, copiedFiles.map(({ attachment, bytes }) => ({
            id: attachment.id, size: attachment.size, sha256: attachment.sha256, bytes,
          })));
          for (const { attachment } of copiedFiles) store.put('attachments', attachment);
          staged.install();
        }
        for (const [index, document] of documents.entries()) {
          revision(document, authorId, '복제본 최초 작성');
          activity(req, 'document', document.id, '문서 복제', originals[index].title);
          notifyDocumentCreated(document);
        }
        return root;
      }, `document-tree-copy:${sourceId}`);
    } catch (error) {
      try { staged?.rollback(); }
      catch { console.error('[teamspace attachments] 문서 복제 첨부 복구 기록 정리가 필요합니다.'); }
      throw error;
    }
    try { staged?.commit(); }
    catch { console.error('[teamspace attachments] 문서 복제 첨부 복구 기록 정리가 필요합니다.'); }
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(result.document);
  });
  app.post('/api/documents/:id/move-preview',(req,res)=>{
    res.set('Cache-Control','no-store').json(documentTreeMove.preview(req.params.id,actor(req),req.body));
  });
  app.post('/api/documents/:id/move',(req,res)=>{
    const actorId=actor(req);
    const {preview,moved}=documentTreeMove.move(req.params.id,actorId,req.body,document=>{
      revision(document,actorId,'문서 이동');
      activity(req,'document',document.id,'문서 이동',document.title);
      notifyDocumentUpdate(document,actorId,document.updatedAt);
    });
    for(const document of moved)collaboration.notifyMetadata(document.id);
    res.json(preview);
  });
  app.patch('/api/documents/:id',(req,res)=>{
    const bodyChanged=Object.hasOwn(req.body,'content');
    const updated=store.transaction(()=>{
      const old=get<DocPage>('documents',req.params.id);checkVersion(old,req.body.expectedVersion);
      const fields=['projectId','parentId','title','content','icon','status','labels'];
      let d=validateDocument({...old,...Object.fromEntries(fields.filter(k=>Object.hasOwn(req.body,k)).map(k=>[k,req.body[k]])),version:old.version+1,updatedAt:now()},old);
      if (bodyChanged) {
        const existingSchema = documentContentSchemaVersion(old.content);
        const clientSchema = req.body.contentSchemaVersion;
        const supportsExistingSchema = typeof clientSchema === 'number' && Number.isInteger(clientSchema)
          && clientSchema >= existingSchema && clientSchema <= DOCUMENT_CONTENT_SCHEMA_VERSION;
        if (!supportsExistingSchema) {
          const removesIssueList = existingSchema === 3 && documentContentSchemaVersion(d.content) < 3;
          const changesProtectedBody = existingSchema >= 4 && JSON.stringify(d.content) !== JSON.stringify(old.content);
          if (removesIssueList || changesProtectedBody) {
            fail('이 문서의 본문 형식을 지원하는 최신 편집기를 열어 다시 확인해 주세요.', 409, { currentVersion: old.version, contentSchemaVersion: existingSchema });
          }
        }
      }
      if(d.projectId!==old.projectId&&store.all<DocPage>('documents').some(x=>x.parentId===d.id))fail('하위 문서를 먼저 이동해 주세요.');
      store.put('documents',d);if(bodyChanged)d=collaboration.replaceBody(d);else{d=collaboration.deriveSnapshot(d);store.put('documents',d);}
      const actorId=actor(req);
      revision(d,actorId,nullableText(req.body.summary,'변경 설명',500)||'문서 편집');activity(req,'document',d.id,'문서 변경',d.title);
      if (d.title!==old.title || d.status!==old.status || d.projectId!==old.projectId || d.parentId!==old.parentId ||
        d.icon!==old.icon || JSON.stringify(d.labels)!==JSON.stringify(old.labels) ||
        (bodyChanged && JSON.stringify(d.content)!==JSON.stringify(old.content))) notifyDocumentUpdate(d,actorId,d.updatedAt);
      return d;
    });
    if(bodyChanged)collaboration.reset(updated.id,'문서 본문이 교체되었습니다.');else collaboration.notifyMetadata(updated.id);
    res.json(updated);
  });
  app.delete('/api/documents/:id',(req,res)=>{
    const archived=store.transaction(()=>{
      const doc=get<DocPage>('documents',req.params.id), version=req.body?.expectedVersion??req.query.expectedVersion;
      if(version!==undefined)checkVersion(doc,Number(version));
      if(store.db.prepare('SELECT 1 FROM documents WHERE parent_id=? LIMIT 1').get(doc.id))fail('하위 문서를 먼저 이동하거나 휴지통에 넣어 주세요.',409);
      const entry=trash.capture('document',doc,actor(req),{publication:documentPublication.archiveState(doc.id),collaboration:collaboration.exportState(doc.id)});
      detachArchivedChildren('document',doc.id);
      store.remove('documents',doc.id);
      activity(req,'document',doc.id,'문서 휴지통 이동',doc.title);
      return entry;
    });
    collaboration.reset(archived.resourceId,'문서가 휴지통으로 이동했습니다.');
    res.json({ok:true,trashEntryId:archived.id});
  });
  app.get('/api/trash',(req,res)=>{
    res.set('Cache-Control','no-store').json(trash.list(req.query));
  });
  trashItems.registerRoutes(app,{actor,activity});
  app.post('/api/trash/:id/restore',(req,res)=>{
    const actorId=actor(req);
    const restored=store.withMutationContext({actorId,origin:'restore'},()=>store.transaction(():TrashRestoreResult=>{
      const entry=trash.get(String(req.params.id));
      const table=entry.resourceType==='issue'?'issues':'documents';
      const parentId=entry.resource.parentId;
      if(parentId){
        const parent=store.get<Issue|DocPage>(table,parentId);
        if(!parent)return fail('상위 항목을 먼저 복원해 주세요.',409);
        if(parent.projectId!==entry.projectId)return fail('상위 항목이 다른 프로젝트로 이동했습니다. 원래 프로젝트로 옮긴 뒤 복원해 주세요.',409);
      }
      if(store.get(table,entry.resourceId))fail('같은 ID의 항목이 이미 있습니다.',409);
      if(!Number.isSafeInteger(entry.resource.version+1))fail('복원할 항목의 버전 범위를 초과했습니다.',409);
      for(const file of new Map(archivedFiles(entry).map(file=>[file.id,file])).values()){
        try{files.read(file);}catch{return fail(`휴지통에서 ${file.filename} 파일의 무결성을 확인하지 못했습니다.`,503);}
      }
      const updatedAt=now();
      if(entry.resourceType==='issue'){
        const original=entry.resource;
        const reused=store.db.prepare("SELECT 1 FROM issues WHERE project_id=? AND json_extract(json,'$.key')=? LIMIT 1").get(original.projectId,original.key);
        if(reused)fail('같은 업무 키가 이미 사용 중이라 복원할 수 없습니다.',409);
        let issue:Issue;
        try{
          issue=validateIssue({...original,version:original.version+1,updatedAt},original,{checkFields:false,checkTransition:false,allowArchivedPlanning:true,allowArchivedSchema:true});
        }catch(error){
          if((error instanceof ApiError||error instanceof WorkflowError||error instanceof IssueSchemaError||error instanceof PlanningError)&&error.status<500)return fail(`업무 설정을 확인한 뒤 복원해 주세요. ${error.message}`,409);
          throw error;
        }
        issue.completedAt=done(issue)?issue.completedAt||updatedAt:null;
        store.put('issues',issue);
        trash.restoreChildren(entry);
        gitlab.refreshRestoredBranchLinks(issue.id);
      }else{
        const original=entry.resource;
        const doc=validateDocument({...original,version:original.version+1,updatedAt},original,{allowMissing:true});
        store.put('documents',doc);
        trash.restoreChildren(entry);
        if(entry.publication)documentPublication.restoreArchived(entry.publication);
        if(entry.collaboration)collaboration.restoreState(entry.collaboration,doc);
        revision(doc,actorId,'휴지통에서 복원');
      }
      const warnings=trash.restoreLinks(entry,{dependency(value){
        try{validateDependency(value);trackDependencyVersion(value.version??1);}
        catch(error){if(error instanceof ApiError&&error.status<500)return error.message;throw error;}
      }});
      if(entry.resourceType==='issue'){
        const {attached,unavailable}=scheduleArtifacts.restoreIssueLinks(entry.resource,entry.milestoneIds);
        for(const milestone of attached)activity(req,'milestone',milestone.id,'연결 업무 복원',entry.resource.key);
        if(unavailable)warnings.push(`기존 마일스톤 ${unavailable}개를 찾을 수 없어 업무 연결을 복원하지 못했습니다.`);
        const pendingReservations=timeReservations.restoreIssue(entry.resourceId);
        if(pendingReservations)warnings.push(`팀원의 다른 일정과 겹친 시간 배정 ${pendingReservations}건을 보관했습니다. 업무 상세의 시간 배정에서 확인해 주세요.`);
      }
      activity(req,entry.resourceType,entry.resourceId,'휴지통에서 복원',entry.title);
      trash.remove(entry.id);
      return {resourceType:entry.resourceType,resourceId:entry.resourceId,projectId:entry.projectId,warnings};
    }));
    res.json(restored);
  });
  app.delete('/api/trash/:id',(req,res)=>{
    store.transaction(()=>{
      const entry=trash.get(String(req.params.id));
      if(trash.hasChildren(entry.resourceType,entry.resourceId))fail('휴지통의 하위 항목을 먼저 처리해 주세요.',409);
      subscriptions.removeTarget(entry.resourceType,entry.resourceId);
      favorites.removeTarget(entry.resourceType, entry.resourceId);
      atlassianLinks.removeTarget(entry.resourceType,entry.resourceId);
      if(entry.resourceType==='issue') {
        timeReservations.purgeIssue(entry.resourceId);
        issueChangeHistory.purgeIssue(entry.resourceId);
      }
      trashItems.purgeOwner(entry.resourceType,entry.resourceId);
      trashItems.queueCleanup(archivedFiles(entry));
      trash.remove(entry.id);
      activity(req,entry.resourceType,entry.resourceId,'휴지통에서 영구 삭제',entry.title);
    });
    trashItems.finishCleanup();
    res.json({ok:true});
  });
  app.get('/api/documents/:id/revisions',(req,res)=>{
    get('documents',req.params.id);
    const revisions=store.all<DocRevision>('revisions').filter(revision=>revision.documentId===req.params.id);
    revisions.sort((a,b)=>Number(a.confluenceSourceVersion!==undefined)-Number(b.confluenceSourceVersion!==undefined)||b.version-a.version);
    res.json(revisions);
  });
  app.get('/api/document-publications/count',(req,res)=>{
    if(Object.keys(req.query).length)return fail('검토 수에 조회 조건을 지정할 수 없습니다.');
    res.set('Cache-Control','no-store').json({pendingAssigned:countDocumentAssignedReviews(store,actor(req))});
  });
  app.get('/api/document-publications',(req,res)=>{
    res.set('Cache-Control','no-store').json(listDocumentPublications(store,actor(req),req.query));
  });
  registerDocumentExportRoutes(app, { store, files, publications: documentPublication, attachmentVersions }, options.browserOrigin);
  app.get('/api/documents/:id/publication',(req,res)=>{
    res.json(documentPublication.get(req.params.id));
  });
  app.get('/api/documents/:id/publication/snapshot',(req,res)=>{
    const {kind,revisionId}=req.query;
    if((kind!=='review'&&kind!=='published')||typeof revisionId!=='string'||!revisionId)return fail('조회할 검토본 또는 발행본 버전을 확인해 주세요.');
    const revision=documentPublication.snapshot(req.params.id,kind,revisionId);
    apiKeys.authorizeDocumentBody(req,revision.content);
    res.json(revision);
  });
  app.get('/api/documents/:id/publication/comparison',(req,res)=>{
    res.set('Cache-Control','no-store');
    const queryStart=req.url.indexOf('?');
    const query=new URLSearchParams(queryStart<0?'':req.url.slice(queryStart+1));
    const comparison=documentPublication.comparison(req.params.id,query);
    apiKeys.authorizeDocumentBody(req,comparison.published.content);
    apiKeys.authorizeDocumentBody(req,comparison.review.content);
    res.json(comparison);
  });
  app.post('/api/documents/:id/publication',(req,res)=>{
    res.json(documentPublication.transition(req.params.id,actor(req),req.body,content=>apiKeys.authorizeDocumentBody(req,content)));
  });
  app.post('/api/documents/:id/restore',(req,res)=>{
    const updated=store.transaction(()=>{
      const old=get<DocPage>('documents',req.params.id);
      checkVersion(old,req.body.expectedVersion);
      const saved=get<DocRevision>('revisions',req.body.revisionId);
      if(saved.documentId!==old.id)fail('이 문서의 버전이 아닙니다.');
      const sourceVersion=saved.confluenceSourceVersion===undefined ? `버전 ${saved.version}` : `Confluence 원본 버전 ${saved.confluenceSourceVersion}`;
      let document=validateDocument({...old,title:saved.title,content:saved.content,plainText:saved.plainText,version:old.version+1,updatedAt:now()},old,{allowMissing:true});
      store.put('documents',document);
      document=collaboration.replaceBody(document,{allowMissing:true});
      const actorId=actor(req);
      revision(document,actorId,`${sourceVersion}에서 복구`);
      activity(req,'document',document.id,'문서 복구',`${sourceVersion} → ${document.version}`);
      if(document.title!==old.title||JSON.stringify(document.content)!==JSON.stringify(old.content))notifyDocumentUpdate(document,actorId,document.updatedAt);
      return document;
    });
    collaboration.reset(updated.id,'문서 이력에서 복구되었습니다.');res.json(updated);
  });
  app.get('/api/documents/:id/collaboration',(req,res)=>res.json(collaboration.session(String(req.params.id))));
  app.post('/api/documents/:id/collaboration/enable',(req,res)=>res.json(collaboration.enable(String(req.params.id),req.body.expectedVersion,actor(req))));
  app.post('/api/documents/:id/checkpoint',(req,res)=>res.json(collaboration.checkpoint(String(req.params.id),actor(req),req.body.expectedVersion,req.body.summary,
    (document,revision)=>notifyDocumentUpdate(document,revision.authorId,revision.createdAt))));
  app.get('/api/comments',(req,res)=>{
    const {resourceType,resourceId}=req.query;
    if((resourceType!=='issue'&&resourceType!=='document')||typeof resourceId!=='string')return fail('댓글 대상을 확인해 주세요.');
    get(resourceType==='issue'?'issues':'documents',resourceId);
    res.set('Cache-Control','no-store').json(store.commentsForResource(resourceType,resourceId));
  });
  app.post('/api/comments',(req,res)=>{
    const {resourceType,resourceId}=req.body;
    if(resourceType!=='issue'&&resourceType!=='document')return fail('댓글 대상을 확인해 주세요.');
    if (Object.hasOwn(req.body, 'parentCommentId')) return fail('문장 댓글 답글 경로를 사용해 주세요.');
    const body = text(req.body.body, '댓글', 20000);
    const mentions = parseCommentMentions(body, req.body.mentions);
    const c: Comment = { id: uid(), resourceType, resourceId, authorId: actor(req), body, createdAt: now(),
      ...(mentions.length ? { mentions } : {}) };
    store.transaction(()=>{
      validateCurrentMentionNames(store, body, mentions);
      if(resourceType==='issue'){
        const issue=get<Issue>('issues',resourceId);
        notifyComment(c, issue.projectId, `${issue.key} ${issue.title}`, [issue.reporterId, issue.assigneeId, ...issue.collaboratorIds, ...issueSubscribers(issue)]);
      }else{
        const doc=get<DocPage>('documents',resourceId);
        notifyDocumentComment(doc,c);
      }
      store.put('comments',c);activity(req,resourceType,resourceId,'댓글 작성',c.body.slice(0,100));
    });res.status(201).json(c);
  });
  app.get('/api/comments/:id/edit', (req, res) => {
    res.set('Cache-Control', 'no-store').json(commentEditing.get(req.params.id, actor(req)));
  });
  app.patch('/api/comments/:id', (req, res) => {
    const result = commentEditing.update({ commentId: req.params.id, actorId: actor(req), body: req.body }, {
      validateBody: body => text(body, '댓글', 20000),
      onEdited(comment, newlyMentionedIds) {
        const { resourceType, resourceId, authorId, id, editedAt } = comment;
        if (newlyMentionedIds.length) {
          const target = resourceType === 'issue' ? get<Issue>('issues', resourceId) : get<DocPage>('documents', resourceId);
          notifications.notify({
            kind: `${resourceType}-comment-mentioned`, actorId: authorId, recipientIds: newlyMentionedIds,
            projectId: target.projectId, targetId: resourceId, targetLabel: 'key' in target ? `${target.key} ${target.title}` : target.title,
            commentId: id, createdAt: editedAt,
          });
        }
        activity(req, resourceType, resourceId, comment.parentCommentId ? '댓글 답글 수정' : '댓글 수정');
      },
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
  app.post('/api/documents/:id/selection-comments',(req,res)=>{
    const result=documentSelectionComments.create({documentId:String(req.params.id),actorId:actor(req),body:req.body},{
      validateBody:body=>text(body,'댓글',20000),
      onCreated(document,comment){
        notifyDocumentComment(document,comment);
        activity(req,'document',document.id,'댓글 작성',comment.body.slice(0,100));
      },
    });
    res.status(result.duplicate?200:201).json(result);
  });
  app.post('/api/documents/:id/selection-comments/:commentId/replies', (req, res) => {
    const result = documentCommentReplies.create({
      documentId: String(req.params.id), parentCommentId: String(req.params.commentId), actorId: actor(req), body: req.body,
    }, {
      validateBody: body => text(body, '답글', 20000),
      onCreated(document, reply, participants) {
        notifyDocumentComment(document, reply, participants);
        activity(req, 'document', document.id, '댓글 답글 작성', reply.body.slice(0,100));
      },
    });
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(result);
  });
  app.patch('/api/documents/:id/selection-comments/:commentId/resolution', (req, res) => {
    const actorId = req.header('X-Actor-Id');
    if (!actorId) return fail('등록된 작업자를 선택해 주세요.');
    const comment = updateDocumentCommentResolution(store, {
      documentId: String(req.params.id), commentId: String(req.params.commentId), actorId, body: req.body,
    });
    res.set('Cache-Control', 'no-store').json(comment);
  });
  app.delete('/api/comments/:id',(req,res)=>{
    const trashItemId=store.transaction(()=>{
      const comment=get<Comment>('comments',req.params.id);
      const archivedId=trashItems.archiveComment(comment,actor(req));
      activity(req,comment.resourceType,comment.resourceId,'댓글 휴지통 이동');
      return archivedId;
    });
    res.json({ok:true,trashItemId});
  });
  app.get('/api/attachments',(req,res)=>{
    attachmentTarget(req.query.resourceType,req.query.resourceId);
    const rows=attachmentRows(req.query.resourceType as string,req.query.resourceId as string);
    res.json(rows.map(row=>attachmentVersions.head(row)));
  });
  const uploadAttachment = (req:Request) => {
    const bytes:unknown=req.body;
    if(!Buffer.isBuffer(bytes)||!bytes.length)return fail('비어 있지 않은 파일이 필요합니다.');
    if(bytes.length>MAX_FILE_BYTES)return fail('첨부파일은 20MiB 이하여야 합니다.',413);
    let filename:string;
    try{filename=safeFilename(req.query.filename);}catch(error){return fail((error as Error).message);}
    return {filename,bytes,authorId:actor(req)};
  };
  const expectedAttachmentVersion = (value:unknown) => {
    try{return attachmentId(value);}
    catch{return fail('확인한 첨부파일 버전 ID가 필요합니다.');}
  };
  app.post('/api/attachments',(req,res)=>{
    attachmentTarget(req.query.resourceType,req.query.resourceId);
    const {filename,bytes,authorId}=uploadAttachment(req);
    const a:Attachment={id:uid(),resourceType:req.query.resourceType as 'issue'|'document',resourceId:req.query.resourceId as string,filename,mimeType:sniffMime(bytes),size:bytes.length,sha256:hash(bytes),authorId,createdAt:now()};
    files.write(a.id,bytes);try{store.transaction(()=>{store.put('attachments',a);activity(req,a.resourceType,a.resourceId,'파일 첨부',a.filename);});}catch(error){files.remove(a.id);throw error;}
    res.status(201).json(attachmentVersions.head(a));
  });
  app.post('/api/attachments/:id/versions',(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='filename'&&key!=='expectedVersionId'))return fail('첨부파일의 새 버전 조건을 확인해 주세요.');
    const expected=expectedAttachmentVersion(req.query.expectedVersionId);
    const head=attachmentVersions.append(req.params.id,expected,uploadAttachment(req),version=>{
      activity(req,version.resourceType,version.resourceId,'첨부파일 버전 추가',`${version.filename} · ${version.versionLabel}`);
    });
    res.status(201).json(head);
  });
  const serveAttachment=(a:Attachment,req:Request,res:Response,inline=req.query.inline==='1')=>{
    let bytes:Buffer;
    try{bytes=files.read(a);}catch{fail('첨부파일을 읽거나 무결성을 확인하지 못했습니다.',503);}
    if(inline&&!['image/png','image/jpeg','image/gif','image/webp'].includes(sniffMime(bytes!)))fail('이 파일 형식은 인라인으로 표시할 수 없습니다.',415);
    const encoded=encodeURIComponent(a.filename).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({'Content-Type':inline?sniffMime(bytes!):'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename="download"; filename*=UTF-8''${encoded}`,'Content-Length':String(bytes!.length),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-cache','ETag':`"${a.sha256}"`});res.end(bytes!);
  };
  registerDocumentIncludeRevisionRoutes(app, store, (attachment, req, res) => serveAttachment(attachment, req, res, true));
  app.get('/api/attachments/:id/content',(req,res)=>{
    const id=String(req.params.id);
    const attachment=store.get<Attachment>('attachments',id) || get<AttachmentVersion>('attachment_versions',id);
    serveAttachment(attachment,req,res);
  });
  app.get('/api/attachment-versions/:id/download',(req,res)=>{
    const id=String(req.params.id);
    const attachment=store.get<AttachmentVersion>('attachment_versions',id) || get<Attachment>('attachments',id);
    serveAttachment(attachment,req,res);
  });
  const relationAudit = (req: Request) => {
    actor(req);
    return (issueId: string, action: string, detail: string) => activity(req,'issue',issueId,action,detail);
  };
  const relationNotification = (req: Request) => (before: IssueRelation | undefined, after: IssueRelation | undefined) =>
    blockerNotifications.relationChanged(before,after,actor(req),now());
  app.post('/api/issues/:id/clone', (req, res) => {
    const input = req.body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['requestId', 'expectedSourceVersion', 'issue', 'actorId'].includes(key))) {
      return fail('업무 복제 요청을 확인해 주세요.');
    }
    const { expectedSourceVersion, issue } = input;
    if (typeof expectedSourceVersion !== 'number' || !Number.isSafeInteger(expectedSourceVersion) || expectedSourceVersion < 1) {
      return fail('원본 업무의 버전을 확인해 주세요.');
    }
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return fail('복제할 업무 정보를 확인해 주세요.');
    const issueInput = issue as Record<string, unknown>;
    const sourceIssueId = String(req.params.id);
    let createdRelation: IssueRelation | undefined;
    const result = issueCreation.create(() => actor(req), input, () => {
      const source = store.get<Issue>('issues', sourceIssueId);
      if (!source) return fail('원본 업무를 찾을 수 없습니다.', 404, { reason: 'source_missing' });
      if (source.version !== expectedSourceVersion) {
        return fail('원본 업무가 변경되었습니다. 최신 업무를 확인해 주세요.', 409,
          { reason: 'source_version_changed', currentVersion: source.version });
      }
      if (Object.hasOwn(issueInput, 'projectId') && issueInput.projectId !== source.projectId) {
        return fail('복제 업무는 원본 업무와 같은 프로젝트에 만들어 주세요.');
      }
      const created = createIssueInTransaction(req, { ...issueInput, projectId: source.projectId });
      createdRelation = issueRelations.createInTransaction(source.id,
        { otherIssueId: created.id, type: 'related', direction: 'outgoing' }, relationAudit(req), relationNotification(req)).relation;
      return created;
    }, { kind: 'issue-clone', sourceIssueId });
    const endpoints = issueRelationEndpoints(sourceIssueId, result.issue.id, 'related', 'outgoing');
    const relation = createdRelation ?? findTeamspaceIssueRelation(store, { ...endpoints, type: 'related' }) ?? null;
    const response: IssueCloneResult = { ...result, relation };
    res.set('Cache-Control', 'no-store').status(result.duplicate ? 200 : 201).json(response);
  });
  app.post('/api/issues/:id/close-as-duplicate', (req, res) => {
    const input = req.body as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['originalIssueId', 'status', 'expectedVersion', 'expectedOriginalVersion', 'expectedWorkflowVersion', 'actorId'].includes(key))) {
      return fail('중복 업무 종료 요청을 확인해 주세요.');
    }
    const { originalIssueId, status, expectedVersion, expectedOriginalVersion, expectedWorkflowVersion } = input;
    if (!isRelationId(originalIssueId) || originalIssueId === req.params.id ||
        ![expectedVersion, expectedOriginalVersion, expectedWorkflowVersion].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
      return fail('다른 원본 업무를 선택하고 확인한 업무·워크플로 버전을 보내 주세요.');
    }
    const result: IssueCloseAsDuplicateResult = store.transaction(() => {
      const before = get<Issue>('issues', req.params.id);
      checkVersion(before, expectedVersion);
      const original = get<Issue>('issues', originalIssueId);
      if (original.version !== expectedOriginalVersion) {
        return fail('원본 업무가 변경되었습니다. 최신 업무를 확인해 주세요.', 409,
          { reason: 'original_version_changed', currentVersion: original.version });
      }
      const workflow = workflows.get(before.projectId);
      if (workflow.version !== expectedWorkflowVersion) {
        return fail('업무의 워크플로가 변경되었습니다. 최신 상태를 확인한 뒤 다시 변경해 주세요.', 409,
          { reason: 'workflow_changed', currentWorkflowVersion: workflow.version });
      }
      const terminal = (id: unknown) => workflow.statuses.some(value => value.id === id &&
        (value.category === 'done' || value.category === 'cancelled'));
      if (terminal(before.status)) return fail('이미 종료된 업무입니다. 현재 상태와 원본 업무를 확인해 주세요.', 409);
      if (!terminal(status)) return fail('종료 상태를 선택해 주세요.', 422);
      const prepared = prepareIssueUpdate(before, { status });
      const { relation } = issueRelations.createDuplicateInTransaction(before.id, original.id, relationAudit(req), relationNotification(req));
      const issue = commitIssueUpdate(req, before, prepared, { action: '중복으로 닫기', detail: `${before.key} → 원본 ${original.key}` });
      return { issue, relation };
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
  app.get('/api/issues/:id/relations',(req,res)=>{
    res.set('Cache-Control','no-store').json(issueRelations.list(req.params.id, apiKeys.projectScope(req)));
  });
  app.get('/api/schedule/team-blockers',(_req,res)=>{
    res.set('Cache-Control','no-store').json(issueRelations.teamScheduleBlockers());
  });
  app.post('/api/issues/:id/relations',(req,res)=>{
    const { relation, created }=issueRelations.create(req.params.id,req.body,relationAudit(req),relationNotification(req));
    res.status(created?201:200).json(relation);
  });
  app.patch('/api/issues/:id/relations/:relationId',(req,res)=>{
    res.json(issueRelations.update(req.params.id,req.params.relationId,req.body,relationAudit(req),relationNotification(req)));
  });
  app.delete('/api/issues/:id/relations/:relationId',(req,res)=>{
    issueRelations.remove(req.params.id,req.params.relationId,req.query.expectedVersion,relationAudit(req),relationNotification(req));
    res.json({ok:true});
  });
  app.post('/api/issues/:issueId/relations/:relationId/schedule-dependency', (req, res) => {
    const input = req.body;
    const { expectedVersion, predecessorId, successorId, type, lagDays } = input;
    if (Object.keys(input).some(key => !['expectedVersion', 'predecessorId', 'successorId', 'type', 'lagDays', 'actorId'].includes(key)) ||
        !isRelationId(predecessorId) || !isRelationId(successorId) || !isDependencyType(type) || !isDependencyLag(lagDays)) {
      return fail('일정 연결의 선행·후행 업무, 연결 유형과 근무일 간격을 확인해 주세요.');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return fail('업무 관계의 expectedVersion이 필요합니다.');
    actor(req);
    const { issueId, relationId } = req.params;
    const result = store.transaction(() => {
      const relation = store.get<IssueRelation>('issue_relations', relationId);
      if (!relation || (relation.sourceIssueId !== issueId && relation.targetIssueId !== issueId)) {
        return fail('업무 관계를 찾을 수 없습니다.', 404);
      }
      checkVersion(relation, expectedVersion);
      const mode = issueRelationScheduleMode(relation);
      if (!mode) return fail('차단 관계에서 일정 연결을 추가할 수 있습니다.');
      const forward = predecessorId === relation.sourceIssueId && successorId === relation.targetIssueId;
      const backward = predecessorId === relation.targetIssueId && successorId === relation.sourceIssueId;
      if (!forward && !(mode === 'choose-direction' && backward)) {
        return fail('현재 차단 관계에 해당하는 선행·후행 업무를 선택해 주세요.');
      }
      const current = store.all<Dependency>('dependencies');
      const existing = current.find(dependency => dependency.predecessorId === predecessorId && dependency.successorId === successorId);
      if (existing?.type === type && existing.lagDays === lagDays) {
        validateDependency(existing, current);
        return { dependency: existing, created: false };
      }
      const dependency = saveNewDependency(req, { id: uid(), predecessorId, successorId, type, lagDays, version: 1 }, current);
      return { dependency, created: true };
    });
    res.status(result.created ? 201 : 200).json(result.dependency);
  });
  app.delete('/api/attachments/:id',(req,res)=>{
    const expected=req.query.expectedVersionId===undefined?undefined:expectedAttachmentVersion(req.query.expectedVersionId);
    const trashItemId=store.transaction(()=>{
      const base=get<Attachment>('attachments',req.params.id), head=attachmentVersions.head(base);
      if(expected!==undefined&&expected!==head.currentVersionId)fail('다른 작업자가 새 파일 버전을 올렸습니다. 버전 목록을 다시 확인해 주세요.',409,{currentVersionId:head.currentVersionId});
      const archivedId=trashItems.archiveAttachment(base,sourcePreservation.versionsForAttachments([base.id]),actor(req),head.filename);
      activity(req,base.resourceType,base.resourceId,'첨부파일 휴지통 이동',head.filename);
      return archivedId;
    });
    res.json({ok:true,trashItemId});
  });
  app.post('/api/resource-links',(req,res)=>{
    const input=req.body;
    if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).some(key=>!['issueId','documentId','kind','actorId'].includes(key))) return fail('업무와 문서의 연결 정보를 확인해 주세요.');
    const {issueId,documentId}=input;
    if(typeof issueId!=='string'||!issueId||typeof documentId!=='string'||!documentId) return fail('연결할 업무와 문서를 확인해 주세요.');
    const kind=nullableText(input.kind,'관계',80)||'관련 문서';
    actor(req);
    const {link,created}=store.transaction(()=>{
      get('issues',issueId);
      get('documents',documentId);
      const existing=store.db.prepare('SELECT json FROM resource_links WHERE issue_id=? AND document_id=?').get(issueId,documentId) as {json:string}|undefined;
      if(existing) return {link:JSON.parse(existing.json) as ResourceLink,created:false};
      const link:ResourceLink={id:uid(),issueId,documentId,kind};
      writeIssueDocumentLink(req,link);
      return {link,created:true};
    });
    res.status(created?201:200).json({id:link.id,issueId:link.issueId,documentId:link.documentId,kind:link.kind});
  });
  app.delete('/api/resource-links/:id',(req,res)=>{
    const { expectedDecisionRevisionId: revisionId, expectedDecisionFrom, expectedDecisionTo } = req.query;
    let expected: Omit<NonNullable<ResourceLink['documentSource']>, 'text'> | undefined;
    if (revisionId !== undefined || expectedDecisionFrom !== undefined || expectedDecisionTo !== undefined) {
      const invalid = '확인한 결정 근거의 저장본 ID와 발췌 범위를 보내 주세요.';
      if (typeof revisionId !== 'string' || !revisionId.trim() || revisionId.length > 200 || !revisionId.isWellFormed() ||
          /[\u0000-\u001f\u007f]/u.test(revisionId) || typeof expectedDecisionFrom !== 'string' || !/^\d+$/u.test(expectedDecisionFrom) ||
          typeof expectedDecisionTo !== 'string' || !/^\d+$/u.test(expectedDecisionTo)) return fail(invalid);
      const from = Number(expectedDecisionFrom), to = Number(expectedDecisionTo);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return fail(invalid);
      expected = { revisionId, from, to };
    }
    store.transaction(()=>{
      const link=get<ResourceLink>('resource_links',req.params.id);
      const pin = link.documentSource;
      const matches = expected ? pin?.revisionId === expected.revisionId && pin.from === expected.from && pin.to === expected.to : pin === undefined;
      if (!matches) {
        fail('문서 연결의 결정 근거가 변경되었습니다. 최신 연결과 근거를 확인해 주세요.',409,{reason:'decision_source_changed'});
      }
      store.remove('resource_links',link.id);
      activity(req,'issue',link.issueId,'문서 연결 해제');
    });
    res.json({ok:true});
  });
  app.get('/api/projects/:id/dependencies',(req,res)=>{
    const projectId=get<Project>('projects',req.params.id).id;
    const rows=store.db.prepare(`SELECT d.json FROM dependencies d
      JOIN issues predecessor ON predecessor.id=d.predecessor_id
      JOIN issues successor ON successor.id=d.successor_id
      WHERE predecessor.project_id=? AND successor.project_id=? ORDER BY d.id`).all(projectId,projectId) as {json:string}[];
    const dependencies=rows.map(row=>{
      const {id,predecessorId,successorId,type,lagDays,version}=JSON.parse(row.json) as Dependency;
      return {id,predecessorId,successorId,type,lagDays,version:version??1};
    });
    res.set('Cache-Control','no-store').json(dependencies);
  });
  app.post('/api/dependencies',(req,res)=>{
    const input=req.body??{};
    const dependency:Dependency={id:uid(),predecessorId:input.predecessorId,successorId:input.successorId,
      type:input.type===undefined?'FS':input.type,lagDays:input.lagDays??0,version:1};
    store.transaction(() => saveNewDependency(req, dependency));
    res.status(201).json(dependency);
  });
  app.patch('/api/dependencies/:id',(req,res)=>{
    const input=req.body;
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['expectedVersion','type','lagDays','reverse','actorId'].includes(key)))fail('업무 연결 변경 내용을 확인해 주세요.');
    if(Object.hasOwn(input,'reverse')&&typeof input.reverse!=='boolean')fail('업무 연결 방향을 확인해 주세요.');
    const result=store.transaction(()=>{
      const prior=get<Dependency>('dependencies',req.params.id);
      checkVersion({version:prior.version??1},input.expectedVersion);
      const type=Object.hasOwn(input,'type')?input.type:prior.type;
      const lagDays=Object.hasOwn(input,'lagDays')?input.lagDays:prior.lagDays;
      if(!isDependencyType(type)||!isDependencyLag(lagDays))fail('업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
      const reverse=input.reverse===true;
      if(!reverse&&type===prior.type&&lagDays===prior.lagDays)return {...prior,version:prior.version??1};
      const version=nextDependencyVersion(prior);
      const next:Dependency={...prior,
        predecessorId:reverse?prior.successorId:prior.predecessorId,
        successorId:reverse?prior.predecessorId:prior.successorId,type,lagDays,version};
      if(reverse)validateDependency(next);
      store.put('dependencies',next);
      trackDependencyVersion(version);
      if(reverse){
        const predecessor=get<Issue>('issues',prior.predecessorId),successor=get<Issue>('issues',prior.successorId);
        const detail=`${predecessor.key} → ${successor.key}에서 ${successor.key} → ${predecessor.key}로 변경`;
        activity(req,'issue',predecessor.id,'선후행 방향 변경',detail);
        activity(req,'issue',successor.id,'선후행 방향 변경',detail);
      }else activity(req,'issue',next.successorId,'선후행 일정 변경',`${prior.type} ${prior.lagDays}근무일 → ${next.type} ${next.lagDays}근무일`);
      return next;
    });
    res.json(result);
  });
  app.delete('/api/dependencies/:id',(req,res)=>{
    store.transaction(()=>{
      const dependency=get<Dependency>('dependencies',req.params.id);
      const expected=req.body?.expectedVersion===undefined?req.query.expectedVersion:req.body.expectedVersion;
      if(expected!==undefined)checkVersion({version:dependency.version??1},typeof expected==='string'&&/^\d+$/.test(expected)?Number(expected):expected);
      store.remove('dependencies',dependency.id);
      activity(req,'issue',dependency.successorId,'선행 업무 연결 해제');
    });
    res.json({ok:true});
  });
  app.post('/api/schedule/preview',(req,res)=>{
    const {issueIds,days,workingDays=false}=req.body;
    if(!Array.isArray(issueIds)||!issueIds.length||issueIds.length>1000||!issueIds.every(x=>typeof x==='string')||!Number.isInteger(days)||Math.abs(days)>3650||typeof workingDays!=='boolean')fail('대상 티켓과 이동 일수를 확인해 주세요.');
    const preview=store.transaction(()=>{
      const changes:ScheduleChange[]=[],warnings:string[]=[],calendarVersions:Record<string,number>={},projectIds=new Set<string>();
      const calendarCache=new Map<string,ReturnType<CalendarService['get']>>(),mathCache=new Map<string,ReturnType<typeof createCalendarMath>>();
      for(const id of new Set<string>(issueIds)){
        const i=get<Issue>('issues',id);projectIds.add(i.projectId);
        if(!i.startDate&&!i.endDate){warnings.push(`${i.key}: 일정이 없어 이동하지 않습니다.`);continue;}
        let calendar=calendarCache.get(i.projectId);
        if(workingDays&&!calendar){calendar=calendars.get(i.projectId);calendarCache.set(i.projectId,calendar);mathCache.set(i.projectId,createCalendarMath(calendar));calendarVersions[i.projectId]=calendar.version;}
        const shift=(value:string)=>workingDays?mathCache.get(i.projectId)!.shift(value,days):shiftDate(value,days,false);
        changes.push({id:i.id,key:i.key,title:i.title,version:i.version,fromStart:i.startDate,fromEnd:i.endDate,toStart:i.startDate?shift(i.startDate):null,toEnd:i.endDate?shift(i.endDate):null});
      }
      const all=store.all<Issue>('issues').map(i=>{const c=changes.find(c=>c.id===i.id);return c?{...i,startDate:c.toStart,endDate:c.toEnd}:i;});
      warnings.push(...scheduleWarnings(all.filter(issue=>projectIds.has(issue.projectId))));return{changes,warnings,...(workingDays?{calendarVersions}: {})} as SchedulePreview;
    });res.json(preview);
  });
  app.post('/api/schedule/apply',(req,res)=>{
    const changes=req.body.changes;if(!Array.isArray(changes)||!changes.length||changes.length>1000)fail('변경할 일정을 선택해 주세요.');
    const result=store.transaction(()=>{checkCalendarVersions(req.body.calendarVersions,changes);return commitScheduleChanges(req,changes);});res.json(result);
  });
  const scheduleUndoCutoff = () => new Date(Date.now() - AUTO_RESULT_RETENTION_MS).toISOString();
  const latestScheduleUndo = (actorId:string,scope:string) => {
    const located=store.db.prepare(`SELECT json FROM schedule_undos WHERE json_extract(json,'$.actorId')=?
      AND json_extract(json,'$.scope')=? ORDER BY rowid DESC LIMIT 1`).get(actorId,scope) as {json:string}|undefined;
    return located&&JSON.parse(located.json) as ScheduleUndoRecord;
  };
  app.get('/api/schedule/undo/latest',(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='scope'&&key!=='id'))return fail('일정 되돌리기 조회 조건을 확인해 주세요.');
    const scope=undoScope(req.query.scope,req.query.id),actorId=resolveActor(req);
    const undo=store.transaction(():ScheduleUndoInfo|null=>{
      if(!actorId)return null;
      const record=latestScheduleUndo(actorId,undoScopeKey(scope));
      if(!record||record.used||!record.appliedAt||record.appliedAt<=scheduleUndoCutoff())return null;
      try{prepareScheduleUndo(record);}
      catch(error){if(error instanceof ApiError&&(error.status===404||error.status===409))return null;throw error;}
      return {undoId:record.id,appliedAt:record.appliedAt,issueCount:record.records.length,
        dependencyChanges:record.linkChanges?.length??0,planCount:record.plan?1:0};
    });
    res.set('Cache-Control','no-store').json({undo});
  });
  app.post('/api/schedule/undo',(req,res)=>{
    const {retry}=req.query;
    if(Object.keys(req.query).some(key=>key!=='retry')||(retry!==undefined&&retry!=='true'))return fail('일정 되돌리기 요청을 확인해 주세요.');
    const scope=requestedUndoScope(req);
    const result=store.transaction(()=>{
      const record=get<ScheduleUndoRecord>('schedule_undos',req.body.undoId);
      if(record.actorId&&record.actorId!==actor(req))fail('일정을 변경한 작업자가 되돌릴 수 있습니다.',409);
      if(scope&&record.scope&&record.scope!==undoScopeKey(scope))fail('일정을 변경한 화면에서 다시 확인해 주세요.',409);
      if(record.used){
        if(retry==='true'&&record.actorId){
          const receipt=store.db.prepare('SELECT json FROM schedule_undo_results WHERE undo_id=? AND completed_at>?')
            .get(record.id,scheduleUndoCutoff()) as {json:string}|undefined;
          if(receipt)return {...JSON.parse(receipt.json) as ScheduleUndoResult,duplicate:true};
        }
        return fail('이미 되돌린 작업입니다.',409);
      }
      if(scope&&record.scope&&record.actorId&&(!record.appliedAt||record.appliedAt<=scheduleUndoCutoff()||
          latestScheduleUndo(record.actorId,record.scope)?.id!==record.id)){
        return fail('최근 일정 변경이 달라졌거나 되돌리기 기간이 지났습니다. 목록을 새로고침해 주세요.',409);
      }
      const {previousPlan,reverseLinks}=prepareScheduleUndo(record);
      const updated=record.records.map(entry=>{
        const old=get<Issue>('issues',entry.id);
        const {startDate,endDate,dueDate=old.dueDate}=entry;
        const issue=validateIssue({...old,startDate,endDate,dueDate,version:old.version+1,updatedAt:now()},old,{checkTransition:false});
        store.put('issues',issue);
        const dueChanged=Object.hasOwn(entry,'dueDate');
        activity(req,'issue',issue.id,'일정 되돌리기',`${issueScheduleLabel(old,dueChanged)} → ${issueScheduleLabel(issue,dueChanged)}`);
        return issue;
      });
      const plan=record.plan&&planning.writeScheduleDates(record.plan.id,record.plan.appliedVersion,record.plan.dates);
      if(plan&&previousPlan)activity(req,'planning',plan.id,'계획 일정 되돌리기',`${planScheduleLabel(previousPlan)} → ${planScheduleLabel(plan)}`);
      const projects=new Set(updated.map(issue=>issue.projectId));
      writeScheduleDependencyChanges(req,reverseLinks,projects,null);
      store.put('schedule_undos',{...record,used:true});
      const linkDetail=reverseLinks.length?` · 업무 연결 ${reverseLinks.length}건`:'';
      activity(req,'schedule',record.id,'일정 변경 되돌리기',`${plan?'계획 1개 · ':''}${updated.length}개 티켓${linkDetail}`);
      const warnings=projects.size?scheduleWarnings(store.all<Issue>('issues').filter(issue=>projects.has(issue.projectId))):[];
      const confirmation:ScheduleUndoResult={updated,warnings,...(plan?{plan}:{}),...(reverseLinks.length?{dependencyChanges:reverseLinks.length}:{})};
      if(record.actorId){
        store.db.prepare('DELETE FROM schedule_undo_results WHERE completed_at<=?').run(scheduleUndoCutoff());
        store.db.prepare('INSERT INTO schedule_undo_results(undo_id,completed_at,json) VALUES(?,?,?)')
          .run(record.id,now(),JSON.stringify(confirmation));
      }
      return confirmation;
    });
    res.set('Cache-Control','no-store').json(result);
  });
  app.get('/api/issue-key-matches', (req, res) => {
    res.set('Cache-Control', 'no-store').json(readIssueKeyMatches(store, req.query, apiKeys.projectScope(req)));
  });
  app.get('/api/search',(req,res)=>{
    const query=String(req.query.q||'').trim(), q=query.toLocaleLowerCase();
    const gitlabQuery = normalizeGitlabSearchInput(query);
    const originalAddress = gitlabQuery ? null : parseAtlassianSearchInput(query);
    if (originalAddress) {
      const issues: Issue[] = [], documents: DocPage[] = [];
      for (const { targetType, targetId } of atlassianLinks.resolve(originalAddress)) {
        if (targetType === 'issue') {
          const issue = store.get<Issue>('issues', targetId);
          if (issue) issues.push(issue);
        } else {
          const document = store.get<DocPage>('documents', targetId);
          if (document) documents.push(document);
        }
      }
      return res.set('Cache-Control', 'no-store').json({ issues, documents });
    }
    if(q.length>500 && !gitlabQuery)fail('검색어가 너무 깁니다.');
    const gitlabMatches = gitlabQuery ? matchingGitlabSearchLinks(store.all<GitlabLink>('gitlab_links'), gitlabQuery) : null;
    if(q.length>500 && !gitlabMatches?.size && !/^https?:\/\//u.test(gitlabQuery ?? ''))fail('검색어가 너무 깁니다.');
    const documentQuery=documentLabelKey(query);
    const issues = store.all<Issue>('issues');
    const issueAliases = q ? readIssueSearchAliases(store, issues) : {};
    const searchData = { issueSchemas: issueSchemas.snapshot(), users: store.all<User>('users'), issueAliases };
    const keyQuery = normalizeWorkspaceSearchQuery(query).toLowerCase();
    const issueResults = issues.flatMap(issue => {
      const aliases = matchingIssueSearchAliases(searchData, issue.id, keyQuery);
      const exactCurrent = Boolean(keyQuery) && normalizeWorkspaceSearchQuery(issue.key).toLowerCase() === keyQuery;
      const exactGitlab = gitlabMatches?.has(issue.id);
      if (!exactCurrent && !aliases.length && !exactGitlab && !issueSearchText(searchData, issue).toLocaleLowerCase().includes(q)) return [];
      const exactAlias = aliases.some(alias => normalizeWorkspaceSearchQuery(alias.key).toLowerCase() === keyQuery);
      return [{ issue, rank: exactCurrent ? 0 : exactAlias ? 1 : exactGitlab ? 2 : 3 }];
    }).sort((left, right) => left.rank - right.rank).map(({ issue }) => issue);
    res.json({issues:issueResults,
      documents:store.all<DocPage>('documents').filter(d=>documentSearchText(d).includes(documentQuery))});
  });
  app.get('/api/export',(_req,res)=>{
    const attachments=store.all<Attachment>('attachments');
    const attachmentVersions=sourcePreservation.allVersions();
    const itemArchives=trashItems.all();
    const trashEntries=trash.all().map(entry=>entry.gitlabLinks.some(link=>link.kind==='branch')
      ? {...entry,gitlabLinks:entry.gitlabLinks.map(link=>gitlab.latestObservedBranchLink(link))}
      : entry);
    const binaries=[...new Map([...attachments,...attachmentVersions,...trashEntries.flatMap(archivedFiles),...itemArchives.flatMap(trashItemFiles)].map(file=>[file.id,file])).values()];
    const exportedAt=now();
    const payload={schemaVersion:NATIVE_BACKUP_SCHEMA_VERSION,savedFieldBreakdowns:savedFieldBreakdowns.all(),recurringIssueRules:recurringIssueRules.all(),cycleCompletionRecords:cycleCompletionRecords.exportRecords(),trashEntries,trashItems:itemArchives,teamNotifications:notifications.all(),deadlineReminderPreferences:deadlineReminders.all(),gitlabDeployments:gitlab.deployments.exportRows(),notificationSubscriptions:subscriptions.all(),favorites:favorites.all(),atlassianLinks:atlassianLinks.all(),documentPublications:documentPublication.all(),documentTemplates:documentTemplates.all(),issueTemplates:issueTemplates.all(),issueChangeHistory:issueChangeHistory.all(),documentTemplateAssets:[] as ReturnType<DocumentTemplateAssetsService['export']>,worklogs:worklogs.all(),timeReservations:timeReservations.all(),reportingLedger:reportLedger.exportData(exportedAt),reportSnapshots:reports.all(),automationRules:automation.all(),automationRuns:exportAutomationRunHistory(store),issueAssignmentRules:issueAssignments.all(),collabStates:collaboration.exportStates(),exportedAt,...snapshot('backup'),comments:store.all('comments'),revisions:store.all('revisions'),attachments,attachmentContents:[] as {id:string;data:string}[],attachmentVersions,sourceImports:sourcePreservation.allImports(),sourceRecords:sourcePreservation.allRecords(),issueRelations:sourcePreservation.allRelations()};
    const estimated=Buffer.byteLength(JSON.stringify(payload))+documentTemplateAssets.exportBytes()+binaries.reduce((sum,a)=>sum+Math.ceil(a.size/3)*4+100,0);
    if(estimated>MAX_EXPORT_BYTES)fail('첨부파일을 포함한 전체 내보내기 파일은 64MiB 미만이어야 합니다. 운영 파일 백업을 사용해 주세요.',413);
    try{payload.attachmentContents=binaries.map(a=>({id:a.id,data:files.read(a).toString('base64')}));}catch{fail('첨부파일을 읽거나 무결성을 확인하지 못해 내보내기를 중단했습니다.',503);}
    payload.documentTemplateAssets=documentTemplateAssets.export();
    const serialized=JSON.stringify(payload);if(Buffer.byteLength(serialized)>MAX_EXPORT_BYTES)fail('내보내기 파일은 64MiB 미만이어야 합니다.',413);
    res.type('application/json').send(serialized);
  });
  app.post('/api/import',(req,res)=>{
    const data=req.body.data;if(!data||!supportsNativeBackupVersion(data.schemaVersion))fail(`지원하는 Teamspace 내보내기 파일(schemaVersion 1~${NATIVE_BACKUP_SCHEMA_VERSION})이 필요합니다.`);
    if(data.schemaVersion===1){if(data.attachments?.length||data.attachmentContents?.length)fail('첨부파일이 있는 데이터는 schemaVersion 2가 필요합니다.');data.attachments=[];data.attachmentContents=[];}
    const expected=[...Object.keys(tables),'comments','revisions','attachments','attachmentContents'];
    for(const key of expected){if(!Array.isArray(data[key])||data[key].length>100000)fail(`${key} 데이터가 올바르지 않습니다.`);const ids=new Set();for(const x of data[key]){if(!x||typeof x.id!=='string'||!x.id||ids.has(x.id))fail(`${key}에 잘못되거나 중복된 ID가 있습니다.`);ids.add(x.id);}}
    if (data.schemaVersion < 87 && data.issueTemplates !== undefined && (!Array.isArray(data.issueTemplates) || data.issueTemplates.length)) {
      fail('업무 템플릿을 포함한 백업은 schemaVersion 87이 필요합니다.');
    }
    const importedIssueTemplates = data.schemaVersion >= 87
      ? issueTemplates.validateRestore(data.issueTemplates, data.projects, data.users, data.exportedAt) : [];
    if (data.schemaVersion < 90 && data.recurringIssueRules !== undefined && (!Array.isArray(data.recurringIssueRules) || data.recurringIssueRules.length)) {
      fail('반복 업무를 포함한 백업은 schemaVersion 90이 필요합니다.');
    }
    const importedRecurringIssueRules = data.schemaVersion >= 90
      ? recurringIssueRules.validateRestore(data.recurringIssueRules, data.projects, data.users, importedIssueTemplates, data.exportedAt) : [];
    if(data.schemaVersion<63&&data.documentTemplates!==undefined&&(!Array.isArray(data.documentTemplates)||data.documentTemplates.length)){
      fail('팀 문서 템플릿을 포함한 백업은 schemaVersion 63이 필요합니다.');
    }
    const importedTemplates=data.schemaVersion>=63?documentTemplates.validateRestore(data.documentTemplates,data.projects,data.users,data.exportedAt):[];
    if (data.schemaVersion < 96 && importedTemplates.some(template => documentContentSchemaVersion(template.content) >= 13)) {
      fail('문서 속성 또는 속성 보고서가 있는 템플릿에는 schemaVersion 96 백업이 필요합니다.');
    }
    if (data.schemaVersion < 79 && importedTemplates.some(template => documentContentSchemaVersion(template.content) >= 12)) {
      fail('문서 열 배치가 있는 템플릿에는 schemaVersion 79 백업이 필요합니다.');
    }
    if (data.schemaVersion < 69 && importedTemplates.some(template => documentContentSchemaVersion(template.content) >= 11)) {
      fail('문서 발췌가 있는 템플릿에는 schemaVersion 69 백업이 필요합니다.');
    }
    if (data.schemaVersion < 67 && importedTemplates.some(template => documentContentSchemaVersion(template.content) >= 10)) {
      fail('하위 문서 목록이 있는 문서 템플릿에는 schemaVersion 67 백업이 필요합니다.');
    }
    if(data.schemaVersion<65&&data.documentTemplateAssets!==undefined&&(!Array.isArray(data.documentTemplateAssets)||data.documentTemplateAssets.length)){
      fail('팀 문서 템플릿 첨부를 포함한 백업은 schemaVersion 65가 필요합니다.');
    }
    if (data.schemaVersion < 72 && data.gitlabDeployments !== undefined &&
        (!Array.isArray(data.gitlabDeployments) || data.gitlabDeployments.length)) {
      fail('GitLab 배포 기록을 포함한 백업은 schemaVersion 72가 필요합니다.');
    }
    if (data.schemaVersion < 74 && Array.isArray(data.gitlabDeployments) && data.gitlabDeployments.some(
      (row: { source?: unknown; mergeRequests?: unknown; status?: unknown } | null) => row && typeof row === 'object' &&
        (Object.hasOwn(row, 'source') || Object.hasOwn(row, 'mergeRequests') || row.status === 'created' || row.status === 'skipped'),
    )) fail('GitLab 배포 동기화 기록을 포함한 백업은 schemaVersion 74가 필요합니다.');
    const importedTemplateAssets=documentTemplateAssets.validateRestore(data.schemaVersion>=65?data.documentTemplateAssets:[],importedTemplates);
    const importedPlanning=planning.prepareImport(data.schemaVersion>=4?data.planningItems:[],data.projects,data.users,data.issues,{legacy:data.schemaVersion<4});
    data.issues=importedPlanning.issues;
    const importedIssueOrders = data.schemaVersion >= 23 ? issueOrders.validateImport(data.issueOrders, data.projects, data.issues) : [];
    if (data.schemaVersion < 82 && data.documentOrders !== undefined &&
      (!Array.isArray(data.documentOrders) || data.documentOrders.length > 0)) {
      fail('사용자 지정 문서 순서를 포함한 백업은 schemaVersion 82가 필요합니다.');
    }
    const importedDocumentOrders = data.schemaVersion >= 82 ? documentOrders.validateImport(data.documentOrders, data.documents) : [];
    const importDocument = <T extends DocPage | DocRevision>(document: T): T => ({ ...document, ...normalizeBackupDocumentContent(document.content, data.schemaVersion) });
    const importedDocuments = (data.documents as DocPage[]).map(importDocument);
    const importedRevisions = (data.revisions as DocRevision[]).map(importDocument);
    data.documents=importedDocuments;
    data.revisions=importedRevisions;
    if(data.schemaVersion<34&&Array.isArray(data.issueSchemas)&&data.issueSchemas.some((schema:{fields?:unknown}|null)=>
      Array.isArray(schema?.fields)&&schema.fields.some((field:unknown)=>field&&typeof field==='object'&&Object.hasOwn(field,'visibleWhen'))
    ))fail('필드 표시 조건이 있는 백업은 schemaVersion 34가 필요합니다.');
    const importedSchemas=issueSchemas.validateImport(data.schemaVersion>=6?data.issueSchemas:[],data.projects,data.issues,{legacy:data.schemaVersion<6,users:data.users});
    if(data.schemaVersion<56&&Array.isArray(data.workflows)&&data.workflows.some((workflow:{statuses?:unknown}|null)=>
      Array.isArray(workflow?.statuses)&&workflow.statuses.some((status:{wipLimit?:unknown}|null)=>status?.wipLimit!=null)
    ))fail('상태별 보드 업무 한도가 있는 백업은 schemaVersion 56이 필요합니다.');
    if (data.schemaVersion < 81 && Array.isArray(data.workflows) && data.workflows.some((workflow: { transitions?: unknown } | null) =>
      Array.isArray(workflow?.transitions) && workflow.transitions.some((edge: { requireResolvedBlockers?: unknown } | null) => edge?.requireResolvedBlockers === true)
    )) fail('차단 업무 해결 전이 규칙이 있는 백업은 schemaVersion 81이 필요합니다.');
    if (data.schemaVersion < 93 && Array.isArray(data.workflows) && data.workflows.some((workflow: { statuses?: unknown } | null) =>
      Array.isArray(workflow?.statuses) && workflow.statuses.some((status: { defaultDueWorkdays?: unknown } | null) => status?.defaultDueWorkdays != null)
    )) fail('상태별 자동 목표 마감일이 있는 백업은 schemaVersion 93이 필요합니다.');
    const importedWorkflows=workflows.validateImport(data.schemaVersion>=3?data.workflows:[],data.projects,data.issues,importedSchemas);
    validateVisibilityStatuses(importedSchemas,importedWorkflows);
    if(data.schemaVersion<13&&Array.isArray(data.savedViews)&&data.savedViews.some((value:unknown)=>
      value&&typeof value==='object'&&'filters' in value&&value.filters&&typeof value.filters==='object'&&
      'fieldFilter' in value.filters&&value.filters.fieldFilter!=null
    ))fail('사용자 정의 필드 조건을 포함한 보기는 schemaVersion 13이 필요합니다.');
    if (data.schemaVersion < 47 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' && Object.hasOwn(view.filters, 'planning')
    )) fail('계획·일정 조건을 포함한 보기는 schemaVersion 47이 필요합니다.');
    if (data.schemaVersion < 53 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' && Object.hasOwn(view.filters, 'gitlab')
    )) fail('GitLab 조건을 포함한 보기는 schemaVersion 53이 필요합니다.');
    if (data.schemaVersion < 57 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' &&
      'gitlab' in view.filters && view.filters.gitlab === 'merge_blocked'
    )) fail('GitLab 병합 차단 조건을 포함한 보기는 schemaVersion 57이 필요합니다.');
    if (data.schemaVersion < 68 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' &&
      (Object.hasOwn(view.filters, 'priorities') || Object.hasOwn(view.filters, 'labels'))
    )) fail('우선순위·라벨 조건을 포함한 보기는 schemaVersion 68이 필요합니다.');
    if (data.schemaVersion < 76 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && Object.hasOwn(view, 'boardGrouping')
    )) fail('담당자별 보드 묶음을 포함한 보기는 schemaVersion 76이 필요합니다.');
    if (data.schemaVersion < 85 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' && Object.hasOwn(view.filters, 'reporter')
    )) fail('요청자 조건을 포함한 보기는 schemaVersion 85가 필요합니다.');
    if (data.schemaVersion < 103 && Array.isArray(data.savedViews) && data.savedViews.some((view: unknown) =>
      view && typeof view === 'object' && 'filters' in view && view.filters && typeof view.filters === 'object' && Object.hasOwn(view.filters, 'statusIds')
    )) fail('여러 상태 조건을 포함한 보기는 schemaVersion 103이 필요합니다.');
    const importedViews=savedViews.validateImport(data.schemaVersion>=3?data.savedViews:[],data.projects,data.users,importedSchemas,importedPlanning.items);
    if (data.schemaVersion < 92 && data.savedFieldBreakdowns !== undefined &&
        (!Array.isArray(data.savedFieldBreakdowns) || data.savedFieldBreakdowns.length)) {
      fail('저장된 필드 집계가 포함된 백업은 schemaVersion 92가 필요합니다.');
    }
    const importedFieldBreakdowns = data.schemaVersion >= 92
      ? savedFieldBreakdowns.validateImport(data.savedFieldBreakdowns, data.projects, importedViews) : [];
    if (data.schemaVersion < 95 && importedFieldBreakdowns.some(preset => preset.query.comparisonFieldId !== undefined)) {
      fail('사용자 정의 비교 기준의 필드 집계가 포함된 백업은 schemaVersion 95가 필요합니다.');
    }
    const importedProjectIds = new Set((data.projects as Project[]).map(project => project.id));
    const importedViewProjects = new Map(importedViews.map(view => [view.id, view.projectId]));
    const issueBlockTargets = { hasProject: (id: string) => importedProjectIds.has(id), viewProject: (id: string) => importedViewProjects.get(id) };
    const importedCalendars=calendars.validateImport(data.schemaVersion>=5?data.calendars:[],data.projects,{legacy:data.schemaVersion<5});
    const importedArtifacts=scheduleArtifacts.validateImport(data.schemaVersion>=5?data.milestones:[],data.schemaVersion>=5?data.baselines:[],data.projects,data.users,data.issues);
    if (data.schemaVersion < 75 && (
      Array.isArray(data.automationRules) && data.automationRules.some((rule: { trigger?: unknown } | null) => rule?.trigger === 'deployment.succeeded') ||
      Array.isArray(data.automationRuns) && data.automationRuns.some((run: { context?: { trigger?: unknown } } | null) => run?.context?.trigger === 'deployment.succeeded')
    )) fail('GitLab 배포 자동화 규칙이나 실행 기록을 포함한 백업은 schemaVersion 75가 필요합니다.');
    const importedAutomation=automation.validateImport(data.schemaVersion>=8?data.automationRules:[],data.projects,data.users,importedWorkflows,importedSchemas,{legacy:data.schemaVersion<8});
    if(data.schemaVersion<64&&data.automationRuns!==undefined&&(!Array.isArray(data.automationRuns)||data.automationRuns.length)){
      fail('GitLab 상태 자동화 실행 기록을 포함한 백업은 schemaVersion 64가 필요합니다.');
    }
    const importedAutomationRuns=data.schemaVersion>=64?validateAutomationRunHistory(data.automationRuns,data.projects,data.users,data.exportedAt):[];
    if(data.schemaVersion<32&&data.issueAssignmentRules!==undefined&&(!Array.isArray(data.issueAssignmentRules)||data.issueAssignmentRules.length)){
      fail('담당자 자동 배정 규칙을 포함한 백업은 schemaVersion 32가 필요합니다.');
    }
    const importedAssignments=issueAssignments.validateImport(data.schemaVersion>=32?data.issueAssignmentRules:[],{
      projects:data.projects,users:data.users,workflows:importedWorkflows,schemas:importedSchemas,
    });
    if(data.schemaVersion<9&&['sourceImports','sourceRecords','attachmentVersions','issueRelations'].some(key=>Array.isArray(data[key])&&data[key].length))fail('원본 이관과 첨부 버전이 있는 백업은 schemaVersion 9가 필요합니다.');
    if(data.schemaVersion<37&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendTo!==undefined))fail('기존 프로젝트에 Jira 업무를 추가한 영수증에는 schemaVersion 37 백업이 필요합니다.');
    if(data.schemaVersion<38&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendPagesTo!==undefined))fail('기존 프로젝트에 Confluence 문서를 추가한 영수증에는 schemaVersion 38 백업이 필요합니다.');
    if(data.schemaVersion<39&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendTo?.refreshExisting!==undefined))fail('기존 Jira 업무의 변경분을 반영한 영수증에는 schemaVersion 39 백업이 필요합니다.');
    if(data.schemaVersion<98&&Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'jiraIssueSourceFieldHashes')))fail('Jira 업무의 승인된 원본 필드 기준에는 schemaVersion 98 백업이 필요합니다.');
    if(data.schemaVersion<40&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendPagesTo?.refreshExisting!==undefined))fail('기존 Confluence 문서의 변경분을 반영한 영수증에는 schemaVersion 40 백업이 필요합니다.');
    if(data.schemaVersion<41&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendPagesTo?.refreshAttachments!==undefined))fail('기존 Confluence 문서의 첨부를 추가한 영수증에는 schemaVersion 41 백업이 필요합니다.');
    if(data.schemaVersion<42&&Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendPagesTo?.refreshHistory!==undefined))fail('기존 Confluence 문서의 댓글과 이력을 추가한 영수증에는 schemaVersion 42 백업이 필요합니다.');
    if(data.schemaVersion<43&&(
      (Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendTo?.refreshCustomFields!==undefined))||
      (Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'jiraCustomFieldHashes')))
    ))fail('Jira 사용자 정의 필드의 변경분 설정과 비교 기준에는 schemaVersion 43 백업이 필요합니다.');
    if(data.schemaVersion<44&&(
      (Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendTo?.refreshHistory!==undefined))||
      (Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'jiraHistoryAppend')))
    ))fail('기존 Jira 업무의 댓글과 작업 시간 이관에는 schemaVersion 44 백업이 필요합니다.');
    if(data.schemaVersion<45&&(
      (Array.isArray(data.sourceImports)&&data.sourceImports.some((receipt: SourceImport | null)=>receipt?.configuration?.appendTo?.refreshAttachments!==undefined))||
      (Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'jiraAttachmentAppend')))
    ))fail('기존 Jira 업무의 첨부파일 추가 이관에는 schemaVersion 45 백업이 필요합니다.');
    if(data.schemaVersion<16&&Array.isArray(data.attachmentVersions)&&data.attachmentVersions.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'localRevision')))fail('새 첨부 버전을 포함한 백업은 schemaVersion 16이 필요합니다.');
    const restoreAt=now();
    const importedReportLedger=data.schemaVersion>=10?reportLedger.validateRestore(data.reportingLedger,data.exportedAt,restoreAt,data.projects):{coverage:[],events:[]};
    if(data.schemaVersion<83&&importedReportLedger.events.some(event=>event.kind==='moved_out'||event.kind==='moved_in'))fail('업무 프로젝트 이동 이력이 있는 백업에는 schemaVersion 83이 필요합니다.');
    if(data.schemaVersion<55&&Array.isArray(data.reportSnapshots)&&data.reportSnapshots.some((snapshot:ReportSnapshot|null)=>
      snapshot?.report?.definitionVersion===2||snapshot?.report?.statusDuration!==undefined
    ))fail('상태 체류 시간이 있는 보고서 보관본에는 schemaVersion 55 백업이 필요합니다.');
    const importedReportSnapshots=data.schemaVersion>=10?reports.validateRestore(data.reportSnapshots,data.exportedAt,data.projects,data.users):[];
    if(data.schemaVersion<11&&Array.isArray(data.worklogs)&&data.worklogs.length)fail('작업 시간 기록이 있는 백업은 schemaVersion 11이 필요합니다.');
    if(data.schemaVersion<17&&((Array.isArray(data.trashEntries)&&data.trashEntries.length)||importedReportLedger.events.some(event=>event.kind==='restored')))fail('휴지통과 복원 이력이 있는 백업은 schemaVersion 17이 필요합니다.');
    if(data.schemaVersion>=9&&(!Array.isArray(data.attachmentVersions)||data.attachmentVersions.some((value:unknown)=>!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string')))fail('첨부 버전 목록을 확인해 주세요.');
    if ((data.schemaVersion >= 9 || data.issueRelations != null) && (!Array.isArray(data.issueRelations) ||
      data.issueRelations.some((value: unknown) => !value || typeof value !== 'object' || Array.isArray(value)))) fail('업무 관계 목록을 확인해 주세요.');
    const importedTrash=trash.validateImport(data.schemaVersion>=17?data.trashEntries:[],data);
    if (data.schemaVersion < 72 && [data.gitlabLinks, ...importedTrash.map(entry => entry.gitlabLinks)].some(
      links => links.some((link: GitlabLink) => Object.hasOwn(link, 'mergeCommitShas')),
    )) fail('GitLab 병합 커밋 증거를 포함한 백업은 schemaVersion 72가 필요합니다.');
    if(data.schemaVersion<31&&data.trashItems!==undefined&&(!Array.isArray(data.trashItems)||data.trashItems.length))fail('개별 댓글·첨부 휴지통을 포함한 백업은 schemaVersion 31이 필요합니다.');
    const importedTrashItems=trashItems.validateImport(data.schemaVersion>=31?data.trashItems:[],{...data,trash:importedTrash},data.schemaVersion);
    if (data.schemaVersion < 24 && (data.gitlabLinks.some((link: { kind: string }) => link.kind === 'branch') ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.kind === 'branch')))) {
      fail('GitLab 브랜치 연결에는 schemaVersion 24 백업이 필요합니다.');
    }
    if (!data.gitlabLinks.every(isRestorableGitlabLink)) fail('GitLab 연결 데이터를 확인해 주세요.');
    if (data.schemaVersion < 101 && [data.gitlabLinks, ...importedTrash.map(entry => entry.gitlabLinks)].some(
      links => links.some((link: GitlabLink) => Object.hasOwn(link, 'pipelineSource') || Object.hasOwn(link, 'pipelineTag')),
    )) fail('GitLab 파이프라인 실행 유형을 포함한 백업은 schemaVersion 101이 필요합니다.');
    const readBranchLinks = [data.gitlabLinks, ...importedTrash.map(entry => entry.gitlabLinks)].flatMap(
      (links: GitlabLink[]) => links.filter(link => link.branchObservationSource === 'read'),
    );
    if (readBranchLinks.length) {
      if (data.schemaVersion < 102) fail('단건 조회로 확인한 GitLab 브랜치를 포함한 백업은 schemaVersion 102가 필요합니다.');
      const latestObservation = Math.min(Date.parse(data.exportedAt), Date.parse(restoreAt));
      if (!Number.isFinite(latestObservation) || readBranchLinks.some(link => {
        const { id, issueId, projectId, sourceBranch, updatedAt } = link;
        const instance = /^gitlab:([a-f\d]{12}):/u.exec(id)?.[1];
        return !instance || !sourceBranch || id !== `gitlab:${instance}:${projectId}:branch:${branchObjectId(sourceBranch)}:${issueId}` ||
          Date.parse(updatedAt) > latestObservation;
      })) fail('단건 조회로 확인한 GitLab 브랜치의 식별자나 관측 시각을 확인해 주세요.');
    }
    if (data.schemaVersion <28 && (data.gitlabLinks.some((link:GitlabLink) => link.branchObservationSource==='sync') ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.branchObservationSource==='sync')))) {
      fail('GitLab 수동 조회로 확인한 브랜치 연결에는 schemaVersion 28 백업이 필요합니다.');
    }
    if (data.schemaVersion < 35 && (data.gitlabLinks.some((link:GitlabLink) => link.originalJiraKey !== undefined) ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.originalJiraKey !== undefined)))) {
      fail('GitLab 연결의 Jira 원본 키를 포함한 백업은 schemaVersion 35가 필요합니다.');
    }
    if (data.schemaVersion < 52 && (data.gitlabLinks.some((link:GitlabLink) => link.manualLinkId !== undefined) ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.manualLinkId !== undefined)))) {
      fail('GitLab 수동 연결을 포함한 백업은 schemaVersion 52가 필요합니다.');
    }
    if (data.schemaVersion < 60) {
      const isManualRepositoryLink = (link: GitlabLink) => link.manualLinkId !== undefined && (link.kind === 'branch' || link.kind === 'commit');
      if (data.gitlabLinks.some(isManualRepositoryLink) || importedTrash.some(entry => entry.gitlabLinks.some(isManualRepositoryLink))) {
        fail('GitLab 브랜치·커밋 수동 연결을 포함한 백업은 schemaVersion 60이 필요합니다.');
      }
    }
    const hasInvalidManualBranch = (link: GitlabLink) => link.kind === 'branch' && link.manualLinkId !== undefined &&
      (typeof link.sourceBranch !== 'string' || link.id.split(':', 5)[4] !== branchObjectId(link.sourceBranch));
    if (data.gitlabLinks.some(hasInvalidManualBranch) || importedTrash.some(entry => entry.gitlabLinks.some(hasInvalidManualBranch))) {
      fail('GitLab 수동 연결의 브랜치 이름과 식별자가 일치하지 않습니다.');
    }
    if (data.schemaVersion < 57 && (data.gitlabLinks.some((link:GitlabLink) => link.mergeReadiness !== undefined) ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.mergeReadiness !== undefined)))) {
      fail('GitLab 병합 준비 상태를 포함한 백업은 schemaVersion 57이 필요합니다.');
    }
    if (data.schemaVersion >= 57) {
      const latestObservation = data.exportedAt < restoreAt ? data.exportedAt : restoreAt;
      const isFutureObservation = ({ mergeReadiness }: GitlabLink) => mergeReadiness !== undefined && mergeReadiness.observedAt > latestObservation;
      if (data.gitlabLinks.some(isFutureObservation) || importedTrash.some(entry => entry.gitlabLinks.some(isFutureObservation))) {
        fail('GitLab 병합 준비 상태의 관측 시각이 백업 내보내기 또는 복원 시각보다 늦습니다.');
      }
    }
    const importedDependencies=data.dependencies as Dependency[];
    const archivedDependencies=importedTrash.flatMap(entry=>entry.dependencies);
    if(data.schemaVersion<21&&(importedDependencies.some(value=>value.type!=='FS')||archivedDependencies.some(value=>value.type!=='FS'))){
      fail('SS·FF·SF 업무 연결에는 schemaVersion 21 백업이 필요합니다.');
    }
    for(const dependency of importedDependencies)validateDependencyVersion(dependency);
    const archivedIssues=importedTrash.flatMap(entry=>entry.resourceType==='issue'?[entry.resource]:[]);
    if(data.schemaVersion<30&&data.timeReservations!==undefined&&(!Array.isArray(data.timeReservations)||data.timeReservations.length)){
      fail('시간 배정을 포함한 백업은 schemaVersion 30이 필요합니다.');
    }
    const importedReservations=data.schemaVersion>=30?timeReservations.validateRestore(data.timeReservations,{
      issues:data.issues,archivedIssues,users:data.users,
    },data.exportedAt):[];
    const allImportedIssues=[...(data.issues as Issue[]),...archivedIssues];
    if (data.schemaVersion < 88 && data.issueChangeHistory !== undefined && (!Array.isArray(data.issueChangeHistory) || data.issueChangeHistory.length)) {
      fail('티켓 필드 변경 기록을 포함한 백업은 schemaVersion 88이 필요합니다.');
    }
    const importedIssueChangeHistory = data.schemaVersion >= 88
      ? issueChangeHistory.validateRestore(data.issueChangeHistory, allImportedIssues, data.projects, data.users, data.exportedAt) : [];
    const importedCycleCompletionRecords = cycleCompletionRecords.validateRestore(data.cycleCompletionRecords, {
      schemaVersion: data.schemaVersion, exportedAt: data.exportedAt, projects: data.projects,
      planningItems: importedPlanning.items, issues: allImportedIssues,
    });
    if(data.schemaVersion<18){
      const capacities:unknown=data.workloadCapacities;
      const hasCustomCapacity=capacities!==undefined&&(!Array.isArray(capacities)||capacities.some(entry=>
        !entry||entry.defaultDailyMinutes!==DEFAULT_DAILY_WORKLOAD_MINUTES||!Array.isArray(entry.members)||entry.members.length||!Array.isArray(entry.exceptions)||entry.exceptions.length));
      if(hasCustomCapacity||allImportedIssues.some(issue=>issue.plannedEffortMinutes!=null))fail('계획 작업 시간과 가용 시간 설정은 schemaVersion 18이 필요합니다.');
    }
    for(const issue of allImportedIssues){
      normalizeIssueDescription(issue,data.schemaVersion);
      validatePlannedEffortMinutes(issue.plannedEffortMinutes);
    }
    const importedCapacity=workload.validateImport(data.schemaVersion>=18?data.workloadCapacities:[],data.projects,data.users,{legacy:data.schemaVersion<18});
    const importedTeamCapacity=teamCapacity.validateImport(data.teamWorkloadCapacity,data.users,{legacy:data.schemaVersion<19});
    const archiveAttachments=[...importedTrash.flatMap(entry=>entry.attachments),...importedTrashItems.flatMap(entry=>entry.itemType==='attachment'?[entry.item]:[])];
    const archiveVersions=[...importedTrash.flatMap(entry=>entry.attachmentVersions),...importedTrashItems.flatMap(entry=>entry.versions)];
    validateCommentReplyTopology(data.schemaVersion, data.comments, importedTrash, importedTrashItems);
    const archiveComments=[...importedTrash.flatMap(entry=>entry.comments),...importedTrashItems.flatMap(trashItemComments)];
    const allImportedComments=[...(data.comments as Comment[]),...archiveComments];
    const importedUserIds = new Set((data.users as User[]).map(user => user.id));
    for (const issue of allImportedIssues) {
      if (Object.hasOwn(issue, 'reporterId') && issue.reporterId !== null &&
          (typeof issue.reporterId !== 'string' || !importedUserIds.has(issue.reporterId))) {
        fail('백업의 업무에서 지정한 요청자를 찾을 수 없습니다.');
      }
    }
    for (const { body, mentions } of allImportedComments) {
      if (data.schemaVersion < 71 && mentions !== undefined && (!Array.isArray(mentions) || mentions.length)) {
        fail('댓글 멘션을 포함한 백업은 schemaVersion 71이 필요합니다.');
      }
      if (parseCommentMentions(body, mentions).some(mention => !importedUserIds.has(mention.userId))) {
        fail('백업의 댓글에서 지정한 팀원을 찾을 수 없습니다.');
      }
    }
    const allImportedRevisions=[...importedRevisions,...importedTrash.flatMap(entry=>entry.revisions)];
    if(data.schemaVersion<42&&allImportedRevisions.some(revision=>revision.confluenceSourceVersion!==undefined))fail('Confluence 원본 버전을 구분하는 문서 이력에는 schemaVersion 42 백업이 필요합니다.');
    if(data.schemaVersion<33&&(
      (Array.isArray(data.sourceImports)&&data.sourceImports.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'integrity')))||
      (Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'excluded')))
    ))fail('원본 무결성 기준 또는 하위 제외 기록을 포함한 백업은 schemaVersion 33이 필요합니다.');
    const importedSources=sourcePreservation.validateImport({
      imports:data.schemaVersion>=9?data.sourceImports:[], records:data.schemaVersion>=9?data.sourceRecords:[],
      versions:data.schemaVersion>=9?[...data.attachmentVersions,...archiveVersions]:[], relations:data.schemaVersion>=9?data.issueRelations:[],
    }, {users:data.users,projects:data.projects,issues:data.issues,documents:data.documents,comments:allImportedComments,revisions:allImportedRevisions,attachments:[...data.attachments,...archiveAttachments]});
    if (data.schemaVersion < 61 && importedSources.records.some(row => row.confluencePageFieldHashes?.labels !== undefined)) {
      fail('Confluence 문서 라벨의 비교 기준을 포함한 백업은 schemaVersion 61이 필요합니다.');
    }
    if (data.schemaVersion < 98 && importedSources.records.some(row => row.confluencePageBodySourceHash !== undefined)) {
      fail('Confluence 문서 원문의 비교 기준을 포함한 백업은 schemaVersion 98이 필요합니다.');
    }
    if (data.schemaVersion < 99 && importedSources.records.some(row => row.confluencePageFieldHashes?.parentId !== undefined)) {
      fail('Confluence 상위 문서의 비교 기준을 포함한 백업은 schemaVersion 99가 필요합니다.');
    }
    if (data.schemaVersion < 100 && importedSources.records.some(row =>
      row.jiraIssueFieldHashes?.parentId !== undefined || row.jiraIssueSourceFieldHashes?.parentId !== undefined)) {
      fail('Jira 상위 티켓의 비교 기준을 포함한 백업은 schemaVersion 100이 필요합니다.');
    }
    const importedIssueRelations = [...importedSources.relations, ...importedTrash.flatMap(entry => entry.issueRelations)];
    const importedTeamspaceRelations = importedIssueRelations.filter(isTeamspaceIssueRelation);
    if (data.schemaVersion < 51 && importedTeamspaceRelations.length) fail('직접 만든 업무 관계를 포함한 백업은 schemaVersion 51이 필요합니다.');
    if (hasDuplicateTeamspaceIssueRelations(importedTeamspaceRelations)) fail('같은 업무 사이의 동일한 관계가 중복되었습니다.');
    const versionById=new Map(importedSources.versions.map(version=>[version.id,version]));
    const archivedDocuments = importedTrash.filter(entry => entry.resourceType === 'document');
    if (data.schemaVersion < 58 && (importedDocuments.some(document => Object.hasOwn(document, 'labels')) ||
        archivedDocuments.some(entry => Object.hasOwn(entry.resource, 'labels')))) {
      fail('문서 라벨을 포함한 백업은 schemaVersion 58이 필요합니다.');
    }
    for(const entry of importedTrash){
      entry.attachmentVersions=entry.attachmentVersions.map(version=>versionById.get(version.id)!);
    }
    for(const entry of importedTrashItems)if(entry.itemType==='attachment')entry.versions=entry.versions.map(version=>versionById.get(version.id)!);
    for (const entry of archivedDocuments) {
      entry.resource = normalizeDocumentMetadataLabels(importDocument(entry.resource));
      entry.revisions = entry.revisions.map(importDocument);
    }
    const revisionsById = new Map([...importedRevisions, ...archivedDocuments.flatMap(entry => entry.revisions)].map(revision => [revision.id, revision]));
    const revisionOwner = (id: string) => revisionsById.get(id)?.documentId;
    const importedDocumentIds = new Set([...importedDocuments.map(document=>document.id), ...archivedDocuments.map(entry=>entry.resource.id)]);
    const validateDecisionLink = (link: ResourceLink, live: boolean) => {
      if (!link || typeof link !== 'object' || !Object.hasOwn(link,'documentSource')) return;
      if (data.schemaVersion < 36) fail('문서 결정 근거를 포함한 백업은 schemaVersion 36이 필요합니다.');
      if (data.schemaVersion < 48 && link.kind !== '후속 업무') fail('기존 업무에 연결한 문서 결정 근거를 포함한 백업은 schemaVersion 48이 필요합니다.');
      validateDocumentDecisionSource(link.documentSource, link.documentId, revisionsById, live || importedDocumentIds.has(link.documentId));
    };
    for (const link of data.resourceLinks as ResourceLink[]) validateDecisionLink(link, true);
    for (const entry of importedTrash) for (const link of entry.resourceLinks) validateDecisionLink(link, false);
    const legacyConfluenceRevisionIds = new Set(importedSources.records.filter(record =>
      record.source.product === 'confluence' && record.targetType === 'revision').map(record => record.targetId));
    for (const comment of allImportedComments) {
      validateCommentEdit(comment, data.schemaVersion, data.exportedAt);
      if (data.schemaVersion < 73 && Object.hasOwn(comment, 'resolution')) {
        fail('문장 댓글 해결 상태를 포함한 백업은 schemaVersion 73이 필요합니다.');
      }
      validateDocumentCommentResolution(comment, importedUserIds);
      if (!Object.hasOwn(comment, 'documentSource')) continue;
      if (data.schemaVersion < 50) fail('문장 댓글을 포함한 백업은 schemaVersion 50이 필요합니다.');
      const invalidSource = '문장 댓글의 선택 범위와 원문 저장본을 확인해 주세요.';
      if (comment.resourceType !== 'document' || !importedDocumentIds.has(comment.resourceId)
          || (comment.documentSource && legacyConfluenceRevisionIds.has(comment.documentSource.revisionId))) fail(invalidSource);
      validateDocumentDecisionSource(comment.documentSource, comment.resourceId, revisionsById, true, invalidSource);
    }
    const firstDocument = importedDocuments[0];
    documentContent.validate(firstDocument?.id || uid(), firstDocument?.content || { type: 'doc', content: [{ type: 'paragraph' }] }, undefined,
      { allowMissing: true, documents: importedDocuments, issues: data.issues, issueBlockTargets, revisionOwner });
    const allImportedContent = [...importedDocuments, ...importedRevisions, ...importedTemplates, ...archivedDocuments.flatMap(entry => [entry.resource, ...entry.revisions])].map(value => value.content);
    validateDocumentListProjects(allImportedContent, issueBlockTargets.hasProject);
    validateDocumentIssueBlocks(allImportedContent, issueBlockTargets, { allowMissing: true });
    validatePinnedDocumentRevisions(allImportedContent, revisionOwner, { allowMissing: true });
    const importedCollaboration = collaboration.validateImport(data.schemaVersion >= 3 ? data.collabStates : [], importedDocuments, issueBlockTargets, revisionOwner);
    for (const entry of archivedDocuments) {
      if (entry.collaboration) collaboration.validateImport([entry.collaboration], [entry.resource], issueBlockTargets, revisionOwner);
      if (entry.publication) [entry.publication] = documentPublication.validateRestore(
        [entry.publication], [entry.resource], data.users, entry.revisions, data.exportedAt, data.schemaVersion,
      );
    }
    const importedWorklogs=data.schemaVersion>=11?worklogs.validateRestore(
      data.worklogs,data.projects,data.issues,data.users,data.exportedAt,data.schemaVersion>=12?importedSources.records:[],
    ):[];
    if(data.schemaVersion<14&&Array.isArray(data.documentPublications)&&data.documentPublications.length)fail('문서 검토·발행 기록을 포함한 백업은 schemaVersion 14가 필요합니다.');
    const importedPublications=data.schemaVersion>=14?documentPublication.validateRestore(
      data.documentPublications,data.documents,data.users,data.revisions,data.exportedAt,data.schemaVersion,
    ):[];
    if(data.schemaVersion<15&&Array.isArray(data.teamNotifications)&&data.teamNotifications.length)fail('팀 알림을 포함한 백업은 schemaVersion 15가 필요합니다.');
    if (data.schemaVersion < 91 && Array.isArray(data.teamNotifications) && data.teamNotifications.some(
      (row: { kind?: unknown } | null) => row?.kind === 'document-review-approved',
    )) fail('문서 검토 승인 알림을 포함한 백업은 schemaVersion 91이 필요합니다.');
    if(data.schemaVersion<25&&((data.notificationSubscriptions!==undefined&&
      (!Array.isArray(data.notificationSubscriptions)||data.notificationSubscriptions.length))||
      (Array.isArray(data.teamNotifications)&&data.teamNotifications.some((row: {kind?: unknown} | null)=>row?.kind==='issue-status-changed'||row?.kind==='document-updated')))){
      fail('구독 또는 구독 알림을 포함한 백업은 schemaVersion 25가 필요합니다.');
    }
    if(data.schemaVersion<27&&data.atlassianLinks!==undefined&&(!Array.isArray(data.atlassianLinks)||data.atlassianLinks.length)){
      fail('Jira·Confluence 링크를 포함한 백업은 schemaVersion 27이 필요합니다.');
    }
    if(data.schemaVersion<29&&Array.isArray(data.teamNotifications)&&data.teamNotifications.some((row: {kind?:unknown} | null)=>row?.kind==='issue-created'||row?.kind==='document-created')){
      fail('업무·문서 생성 알림을 포함한 백업은 schemaVersion 29가 필요합니다.');
    }
    const issueRiskKinds:ReadonlySet<unknown>=new Set(ISSUE_RISK_NOTIFICATION_KINDS);
    if (data.schemaVersion < 77 && Array.isArray(data.teamNotifications) && data.teamNotifications.some(
      (row: { kind?: unknown } | null) => row?.kind === 'document-comment-reply',
    )) fail('문장 댓글 답글 알림을 포함한 백업은 schemaVersion 77이 필요합니다.');
    const commentMentionKinds: ReadonlySet<unknown> = new Set(COMMENT_MENTION_NOTIFICATION_KINDS);
    if (data.schemaVersion < 71 && Array.isArray(data.teamNotifications) && data.teamNotifications.some(
      (row: { kind?: unknown; commentId?: unknown } | null) => commentMentionKinds.has(row?.kind) ||
        (row?.kind !== 'issue-comment' && row?.commentId !== undefined),
    )) fail('댓글 멘션 알림을 포함한 백업은 schemaVersion 71이 필요합니다.');
    const deadlineReminderKinds: ReadonlySet<unknown> = new Set(ISSUE_DEADLINE_REMINDER_KINDS);
    if (data.schemaVersion < 70 && (
      (data.deadlineReminderPreferences !== undefined && (!Array.isArray(data.deadlineReminderPreferences) || data.deadlineReminderPreferences.length > 0)) ||
      (Array.isArray(data.teamNotifications) && data.teamNotifications.some((row: { kind?: unknown; actorId?: unknown } | null) =>
        deadlineReminderKinds.has(row?.kind) || row?.actorId === null))
    )) fail('업무 마감 알림을 포함한 백업은 schemaVersion 70이 필요합니다.');
    if(data.schemaVersion<62&&Array.isArray(data.teamNotifications)&&data.teamNotifications.some((row:{kind?:unknown;detail?:unknown}|null)=>
      (row?.kind !== 'issue-status-changed' && row?.detail !== undefined) || issueRiskKinds.has(row?.kind))){
      fail('업무 차단·마감 연기 알림을 포함한 백업은 schemaVersion 62가 필요합니다.');
    }
    if (data.schemaVersion < 86 && Array.isArray(data.teamNotifications) && data.teamNotifications.some(
      (row: { kind?: unknown; detail?: unknown; commentId?: unknown } | null) =>
        (row?.kind === 'issue-status-changed' && row.detail !== undefined) ||
        (row?.kind === 'issue-comment' && row.commentId !== undefined),
    )) fail('업무 상태 변경의 상세 내용이나 일반 댓글의 위치를 포함한 백업은 schemaVersion 86이 필요합니다.');
    const subscriptionRefs={
      users:importedUserIds,
      issueIds:new Set((data.issues as Issue[]).map(issue=>issue.id)),
      documentIds:new Set(importedDocuments.map(document=>document.id)),
      projectIds:new Set((data.projects as Project[]).map(project=>project.id)),
    };
    for(const entry of importedTrash) (entry.resourceType==='issue'?subscriptionRefs.issueIds:subscriptionRefs.documentIds).add(entry.resourceId);
    if (data.schemaVersion < 94 && data.favorites !== undefined && (!Array.isArray(data.favorites) || data.favorites.length)) {
      fail('개인 즐겨찾기를 포함한 백업은 schemaVersion 94가 필요합니다.');
    }
    const importedFavorites = data.schemaVersion >= 94 ? favorites.validateRestore(data.favorites, subscriptionRefs) : [];
    const binaries=[...new Map<string,Attachment>([...(data.attachments as Attachment[]),...archiveAttachments,...importedSources.versions].map(file=>[file.id,file])).values()];
    const archivedAttachmentIds=new Set(archiveAttachments.map(file=>file.id));
    const liveSources={...importedSources,versions:importedSources.versions.filter(version=>!archivedAttachmentIds.has(version.attachmentId))};
    let staged:string;try{staged=files.stageImport(binaries,data.attachmentContents);}catch(error){fail((error as Error).message);}
    let swapped:ReturnType<AttachmentFiles['swapImport']>|undefined;
    try{store.withMutationContext({actorId:null,origin:'import'},()=>store.transaction(()=>{
      const previousAutomation=new Map(automation.all().map(rule=>[rule.id,rule.version]));
      const previousAssignments=issueAssignments.clearForImport();
      const previousSchemas=new Map(issueSchemas.snapshot().map(schema=>[schema.projectId,schema.version]));
      const previousWorkflows=new Map(workflows.snapshot().map(w=>[w.projectId,w.version]));
      const previousViews=new Map(savedViews.all().map(v=>[v.id,v.version]));
      const previousFieldBreakdowns = savedFieldBreakdowns.versions();
      const previousPlanning=new Map(planning.all().map(item=>[item.id,item.version]));
      const previousCalendars=new Map(calendars.snapshot().map(calendar=>[calendar.projectId,calendar.version]));
      const previousCapacities=new Map(workload.snapshot().map(capacity=>[capacity.projectId,capacity.version]));
      const previousTeamCapacityVersion=teamCapacity.get().version;
      const previousMilestones=new Map(scheduleArtifacts.allMilestones().map(milestone=>[milestone.id,milestone.version]));
      const previousBaselines=new Map(scheduleArtifacts.allBaselines().map(baseline=>[baseline.id,baseline.version]));
      const previousIssues=new Map(store.all<Issue>('issues').map(i=>[i.id,i.version]));
      const previousDocuments=new Map(store.all<DocPage>('documents').map(d=>[d.id,d.version]));
      const previousSequences=new Map((store.db.prepare('SELECT project_id,next_number FROM issue_sequences').all() as {project_id:string;next_number:number}[]).map(row=>[row.project_id,row.next_number]));
      // Remember prior versions even if their links were deleted before this import.
      let previousDependencyVersion=dependencyVersionFloor();
      for(const dependency of store.all<Dependency>('dependencies'))previousDependencyVersion=Math.max(previousDependencyVersion,dependency.version??1);
      const previousTrash=trash.all();
      for(const entry of previousTrash){
        const versions=entry.resourceType==='issue'?previousIssues:previousDocuments;
        versions.set(entry.resourceId,Math.max(versions.get(entry.resourceId)||0,entry.resource.version));
        for(const dependency of entry.dependencies)previousDependencyVersion=Math.max(previousDependencyVersion,dependency.version??1);
      }
      if (allImportedComments.some(comment => comment.resolution)) {
        advanceRestoredCommentResolutionVersions(allImportedComments, [
          ...store.all<Comment>('comments'), ...previousTrash.flatMap(entry => entry.comments),
          ...trashItems.all().flatMap(trashItemComments),
        ]);
      }
      for(const entry of importedTrash){
        const versions=entry.resourceType==='issue'?previousIssues:previousDocuments;
        entry.resource.version=Math.max(entry.resource.version,versions.get(entry.resourceId)||0);
      }
      const previousImports=new Map(sourcePreservation.allImports().map(value=>[value.id,value.version]));
      const previousWorklogs=worklogs.clearForRestore();
      timeReservations.clearForRestore();
      documentFollowUp.clearForImport();
      documentSelectionComments.clearForImport();
      documentCommentReplies.clearForImport();
      commentEditing.clearForImport();
      issueChildren.clearForImport();
      issueCreation.invalidateForImport();
      issueProjectMove.clearForImport();
      issuePaste.resetForImport();
      documentCreation.invalidateForImport();
      markdownArchiveImport.reset();
      issueBulkEdit.resetForImport();
      cycleCompletion.resetForImport();
      issueOrders.clearCycleMovesForImport();
      outbound.resetForImport();
      migrations.resetForNativeImport();
      for(const table of ['automation_runs','automation_rules','automatic_schedule_previews','schedule_paste_previews','plan_schedule_previews','milestones','baselines','project_calendars','collaboration_requests','collaboration_documents','issue_schemas','workflows','saved_views','planning_items','attachments','resource_links','dependencies','comments','revisions','gitlab_links','schedule_undos','issue_sequences','activities','issues','documents','projects','users','webhook_inbox'])store.db.exec(`DELETE FROM ${table}`);
      data.users.forEach((u:any)=>store.put('users',validateUser(u)));data.projects.forEach((p:any)=>store.put('projects',validateProject(p)));
      if(!data.users.length)fail('최소 한 명의 팀원이 필요합니다.');
      issueTemplates.restore(importedIssueTemplates);
      recurringIssueRules.restore(importedRecurringIssueRules);
      documentTemplates.restore(importedTemplates);
      documentTemplateAssets.restore(importedTemplateAssets);
      notifications.restore(data.schemaVersion>=15?data.teamNotifications:[], subscriptionRefs.users,
        data.schemaVersion>=71 ? new Map(allImportedComments.map(comment => [comment.id, comment])) : undefined);
      deadlineReminders.restore(data.schemaVersion >= 70 ? data.deadlineReminderPreferences : [], subscriptionRefs.users);
      subscriptions.restore(data.schemaVersion>=25?data.notificationSubscriptions:[],subscriptionRefs,data.schemaVersion>=29);
      favorites.restore(importedFavorites);
      atlassianLinks.restore(data.schemaVersion>=27?data.atlassianLinks:[],subscriptionRefs);
      issueSchemas.replaceImported(importedSchemas,previousSchemas);
      workflows.replaceImported(importedWorkflows.map(w=>({...w,version:Math.max(w.version,(previousWorkflows.get(w.projectId)||0)+1)})));savedViews.replaceImported(importedViews,previousViews);
      savedFieldBreakdowns.replaceImported(importedFieldBreakdowns, previousFieldBreakdowns);
      automation.replaceImported(importedAutomation,previousAutomation);
      restoreAutomationRunHistory(store,importedAutomationRuns);
      issueAssignments.replaceImported(importedAssignments,previousAssignments);
      planning.replaceImported(importedPlanning.items,previousPlanning);
      cycleCompletionRecords.restore(importedCycleCompletionRecords);
      calendars.replaceImported(importedCalendars,previousCalendars);
      workload.replaceImported(importedCapacity,previousCapacities);
      teamCapacity.replaceImported(importedTeamCapacity,previousTeamCapacityVersion);
      scheduleArtifacts.replaceImported(importedArtifacts,previousMilestones,previousBaselines);
      for(const i of data.issues)store.put('issues',i);
      for(const d of data.documents)store.put('documents',d);
      const validTimestamp=(v:any)=>typeof v==='string'&&!Number.isNaN(Date.parse(v));
      const keys=new Set();for(const i of data.issues){validateIssue(i,undefined,{checkTransition:false,checkFields:false,allowArchivedPlanning:true,allowArchivedSchema:true});if(!Number.isInteger(i.version)||i.version<1||!validTimestamp(i.createdAt)||!validTimestamp(i.updatedAt)||typeof i.key!=='string'||keys.has(i.key))fail('티켓 버전·키·시간을 확인해 주세요.');keys.add(i.key);i.version=Math.max(i.version,(previousIssues.get(i.id)||0)+1);store.put('issues',i);}
      issueOrders.replaceImported(importedIssueOrders);
      for(const d of data.documents){validateDocument(d,undefined,{allowMissing:true,skipReferences:true});if(!Number.isInteger(d.version)||d.version<1||!validTimestamp(d.createdAt)||!validTimestamp(d.updatedAt))fail('문서 버전·시간을 확인해 주세요.');d.version=Math.max(d.version,(previousDocuments.get(d.id)||0)+1);store.put('documents',d);}
      documentOrders.replaceImported(importedDocumentOrders);
      let importedDependencyVersion=previousDependencyVersion;
      for(const dependency of [...importedDependencies,...archivedDependencies]){
        dependency.version=nextDependencyVersion(dependency,previousDependencyVersion);
        importedDependencyVersion=Math.max(importedDependencyVersion,dependency.version);
      }
      trackDependencyVersion(importedDependencyVersion);
      for(const dependency of importedDependencies){validateDependency(dependency,importedDependencies);store.put('dependencies',dependency);}
      for(const l of data.resourceLinks){get('issues',l.issueId);get('documents',l.documentId);text(l.kind,'관계',80);store.put('resource_links',l);}
      for(const c of data.comments){if(!['issue','document'].includes(c.resourceType))fail('잘못된 댓글 대상입니다.');get(c.resourceType==='issue'?'issues':'documents',c.resourceId);get('users',c.authorId);text(c.body,'댓글',20000);store.put('comments',c);}
      for(const r of importedRevisions){get('documents',r.documentId);get('users',r.authorId);if(!Number.isInteger(r.version)||r.version<1)fail('문서 이력을 확인해 주세요.');store.put('revisions',r);}
      for(const d of importedDocuments)if(!importedRevisions.some(r=>r.documentId===d.id&&r.version===d.version&&r.confluenceSourceVersion===undefined))revision(d,d.authorId,'백업 가져오기');
      documentPublication.replaceRestored(importedPublications);
      for(const a of data.activities){get('users',a.actorId);store.put('activities',a);}
      for(const a of data.attachments){attachmentTarget(a.resourceType,a.resourceId);get('users',a.authorId);if(!validTimestamp(a.createdAt))fail('첨부파일 작성 시간을 확인해 주세요.');store.put('attachments',a);}
      for(const link of data.gitlabLinks as GitlabLink[]){
        get('issues',link.issueId);
        store.put('gitlab_links',link.manualLinkId?{...link,manualLinkId:uid()}:link);
      }
      const nextNumbers=new Map(previousSequences);
      const reserve=(projectId:string,key:string)=>{
        const number=Number(key.match(/-(\d+)$/)?.[1]??0);
        if(Number.isSafeInteger(number+1))nextNumbers.set(projectId,Math.max(nextNumbers.get(projectId)||1,number+1));
      };
      for(const issue of data.issues as Issue[])reserve(issue.projectId,issue.key);
      for(const entry of importedTrash)if(entry.resourceType==='issue')reserve(entry.resource.projectId,entry.resource.key);
      for (const record of importedCycleCompletionRecords) for (const issue of record.issues) reserve(record.projectId, issue.key);
      for(const event of importedReportLedger.events){const state=event.after??event.before;if(state)reserve(state.projectId,state.key);}
      for(const project of data.projects)store.db.prepare('INSERT INTO issue_sequences VALUES(?,?)').run(project.id,nextNumbers.get(project.id)||1);
      collaboration.replaceImported(importedCollaboration);
      const previousIssueRelationVersion = issueRelationVersionFloor(store);
      let restoredIssueRelationVersion = previousIssueRelationVersion;
      for (const relation of importedTeamspaceRelations) {
        relation.version = nextIssueRelationVersion(relation.version, previousIssueRelationVersion);
        restoredIssueRelationVersion = Math.max(restoredIssueRelationVersion, relation.version);
      }
      recordIssueRelationVersion(store, restoredIssueRelationVersion);
      sourcePreservation.replaceImported(liveSources,previousImports);
      gitlab.deployments.restore(data.schemaVersion >= 72 ? data.gitlabDeployments : [], data.exportedAt);
      gitlab.resetForImport([...data.gitlabLinks,...importedTrash.flatMap(entry=>entry.gitlabLinks)]);
      trash.replaceImported(importedTrash);
      trashItems.replaceImported(importedTrashItems);
      timeReservations.replaceRestored(importedReservations);
      reportLedger.replaceRestored(importedReportLedger,restoreAt);
      reports.replaceRestored(importedReportSnapshots);
      worklogs.replaceRestored(importedWorklogs,previousWorklogs);
      issueChangeHistory.replace(importedIssueChangeHistory);
      const generation=uid();store.setSetting('attachmentImportGeneration',generation);swapped=files.swapImport(staged!,generation);
    }));}catch(error){swapped?.rollback();files.cleanupStage(staged!);throw error;}
    collaboration.invalidateAll('백업 가져오기로 문서가 교체되었습니다.');
    files.cleanupStage(staged!);try{swapped?.commit();}catch{console.error('[teamspace attachments] previous upload directory cleanup needed');}
    res.json({ok:true,counts:{projects:data.projects.length,issues:data.issues.length,documents:data.documents.length,attachments:data.attachments.length,planningItems:importedPlanning.items.length,milestones:importedArtifacts.milestones.length,baselines:importedArtifacts.baselines.length}});
  });

  app.use('/api',(_req,res)=>res.status(404).json({error:'API 경로를 찾을 수 없습니다.'}));
  app.use((error:any,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof DecisionFollowUpError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof DocumentTreeMoveError||error instanceof DocumentCopyAssetError)return res.status(error.status).json({error:error.message});
    if(error instanceof DocumentTreeCopyError||error instanceof DocumentOrderError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof AtlassianLinkError||error instanceof AtlassianReadError)return res.status(error.status).json({error:error.message});
    if(error instanceof IssueRelationVersionError)return res.status(error.status).json({error:error.message});
    if(error instanceof DocumentFollowUpError||error instanceof DocumentSelectionCommentError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof DocumentCommentResolutionError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof DocumentCommentReplyError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof CommentEditError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof DocumentCreationError||error instanceof DocumentTemplateError||error instanceof IssueChildCreationError||error instanceof IssueCreationError||error instanceof IssueTemplateError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof IssueRelationError||error instanceof IssueProjectMoveError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof IssueChangeHistoryError)return res.status(error.status).json({error:error.message});
    if(error instanceof FavoriteError)return res.status(error.status).json({error:error.message});
    if(error instanceof IssueKeyLookupError)return res.status(error.status).json({error:error.message});
    if(error instanceof RecurringIssueError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof TimeReservationError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof IssueAssignmentRulesError||error instanceof IssueBulkEditError||error instanceof IssuePasteError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof GitlabProjectWebhookSetupError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof GitlabDeploymentError)return res.status(error.status).json({error:error.message});
    if(error instanceof CycleCompletionError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof CycleCompletionRecordsError||error instanceof CycleProgressError)return res.status(error.status).json({error:error.message});
    if(error instanceof DeadlineReminderError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof CommentMentionError)return res.status(error.status).json({error:error.message});
    if(error instanceof IssueViewPriorityLabelFilterError||error instanceof IssueViewStatusFilterError)return res.status(error.status).json({error:error.message});
    if (error instanceof MarkdownArchiveImportError) return res.status(error.status).json({ error: error.message, details: error.details });
    if(error instanceof ApiError||error instanceof WorkflowError||error instanceof SavedViewError||error instanceof CollaborationError||error instanceof PlanningError||error instanceof ApiKeyError||error instanceof CalendarError||error instanceof AutomaticScheduleError||error instanceof ScheduleAnalysisError||error instanceof SchedulePasteError||error instanceof PlanScheduleShiftError||error instanceof ScheduleArtifactError||error instanceof IssueSchemaError||error instanceof IssueOrderError||error instanceof DocumentContentError||error instanceof AutomationError||error instanceof OutboundWebhookError||error instanceof GitlabIntegrationError||error instanceof LegacyImportError||error instanceof LegacyArchiveError||error instanceof SourcePreservationError||error instanceof ReportingLedgerError||error instanceof ReportingMetricsError||error instanceof ReportingError||error instanceof WorklogError||error instanceof IssueFieldFilterError||error instanceof FieldBreakdownError||error instanceof DocumentPublicationError||error instanceof TeamNotificationError||error instanceof NotificationSubscriptionError||error instanceof AttachmentVersionError||error instanceof TrashError||error instanceof WorkloadError)return res.status(error.status).json({error:error.message,details:'details'in error?error.details:undefined});
    if(error?.type==='entity.parse.failed')return res.status(400).json({error:'JSON 형식이 올바르지 않습니다.'});
    if(error?.type==='entity.too.large')return res.status(413).json({error:_req.originalUrl.startsWith('/api/attachments')?'첨부파일은 20MiB 이하여야 합니다.':_req.originalUrl.startsWith('/api/integrations/gitlab/webhook')?'GitLab 웹훅 본문은 2MiB 이하여야 합니다.':'요청 데이터는 64MiB 이하여야 합니다.'});
    if(String(error?.code).startsWith('SQLITE_CONSTRAINT')||/UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint/.test(String(error?.message)))return res.status(409).json({error:'이미 사용 중인 키·이메일·관계이거나 참조가 올바르지 않습니다.'});
    console.error('[teamspace API]',error?.message||error);return res.status(500).json({error:'요청을 처리하지 못했습니다.'});
  });
  function sweepDeadlineReminders() {
    try { deadlineReminders.sweep(); }
    catch (error) { console.error('[teamspace deadlines]', error instanceof Error ? error.message : error); }
  }
  const deadlineReminderTimer = options.deadlineReminderWorker === false ? undefined
    : setInterval(sweepDeadlineReminders, options.deadlineReminderIntervalMs ?? 60_000).unref();
  if (deadlineReminderTimer) sweepDeadlineReminders();
  function sweepRecurringIssues() {
    try { runRecurringIssues(); }
    catch (error) { console.error('[teamspace recurring issues]', error instanceof Error ? error.message : error); }
  }
  const recurringIssueTimer = options.recurringIssueWorker === false ? undefined
    : setInterval(sweepRecurringIssues, options.recurringIssueIntervalMs ?? 60_000).unref();
  if (recurringIssueTimer) sweepRecurringIssues();
  return {
    app,
    runRecurringIssues,
    attachWebSocket: (server: import('node:http').Server, authorize?: CollaborationUpgradeGuard) => collaboration.attachWebSocket(server, authorize),
    close: () => {
      if (deadlineReminderTimer) clearInterval(deadlineReminderTimer);
      if (recurringIssueTimer) clearInterval(recurringIssueTimer);
      migrations.close(); legacyImport.close(); outbound.close(); collaboration.close(); reportLedger.close(); issueChangeHistory.close(); stopIssueWatch(); store.db.close();
    },
  };
}
