import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AttachmentFiles, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_EXPORT_BYTES, attachmentId, safeFilename, sniffMime, hash } from './attachments.js';
import { AttachmentVersionsService, AttachmentVersionError } from './attachment-versions.js';
import { Store } from './store.js';
import { seed } from './seed.js';
import { WorkflowService, WorkflowError } from './workflows.js';
import { SavedViewService, SavedViewError } from './saved-views.js';
import { CollaborationService, CollaborationError, type CollaborationUpgradeGuard } from './collaboration.js';
import { PlanningService, PlanningError } from './planning.js';
import { ApiKeyService, ApiKeyError } from './api-keys.js';
import { CalendarService, CalendarError } from './calendars.js';
import { AutomaticScheduleService, AutomaticScheduleError, type AutomaticScheduleMutation } from './automatic-schedule.js';
import { SchedulePasteService, SchedulePasteError } from './schedule-paste.js';
import { dependencyPair, hasScheduleDependencyCycle, projectScheduleDependencies, type ScheduleDependencyMutation } from './schedule-dependency-changes.js';
import { PlanScheduleShiftError, PlanScheduleShiftService } from './plan-schedule-shift.js';
import { DocumentContentService, DocumentContentError, normalizeDocumentContent, validateDocumentIssueBlocks, validatePinnedDocumentRevisions } from './document-content.js';
import { registerDocumentIncludeRevisionRoutes } from './document-include-revisions.js';
import { DocumentFollowUpError, DocumentFollowUpService } from './document-follow-up.js';
import { ScheduleArtifactService, ScheduleArtifactError } from './schedule-artifacts.js';
import { IssueSchemaService, IssueSchemaError, validateVisibilityStatuses } from './issue-schema.js';
import { IssueOrderError, IssueOrderService } from './issue-order.js';
import { IssueBulkEditError, IssueBulkEditService } from './issue-bulk-edit.js';
import { AutomationService, AutomationError } from './automation.js';
import { IssueAssignmentRulesService, IssueAssignmentRulesError, type IssueAssignmentDecision } from './issue-assignment-rules.js';
import { OutboundWebhookService, OutboundWebhookError } from './outbound-webhooks.js';
import { GitlabIntegrationService, GitlabIntegrationError } from './gitlab-integration.js';
import { gitlabJiraOriginalKeys, gitlabJiraSources } from './gitlab-jira-sources.js';
import { LegacyImportService } from './legacy-import.js';
import { LegacyImportError } from './legacy-import-model.js';
import { MigrationService } from './migration.js';
import { SourcePreservationService, SourcePreservationError } from './source-preservation.js';
import { registerSourceReconciliationRoutes } from './source-reconciliation.js';
import { LegacyArchiveError } from './legacy-import-archive.js';
import { ReportingLedger, ReportingLedgerError } from './reporting-ledger.js';
import { ReportingMetricsError } from './reporting-metrics.js';
import { ReportingService, ReportingError } from './reporting.js';
import { WorklogService, WorklogError } from './worklogs.js';
import { TimeReservationError, TimeReservationService } from './time-reservations.js';
import { registerTeamOverviewRoutes } from './team-overview.js';
import { FieldBreakdownError } from './field-breakdown.js';
import { registerFieldBreakdownRoutes } from './field-breakdown-routes.js';
import { DocumentPublicationError, DocumentPublicationService } from './document-publication.js';
import { countDocumentAssignedReviews, listDocumentPublications } from './document-publication-list.js';
import { NotificationsService, TeamNotificationError } from './notifications.js';
import { documentNotificationSpaceProject, NotificationSubscriptionError, NotificationSubscriptionsService } from './notification-subscriptions.js';
import { AtlassianReadError } from '../shared/atlassian-links.js';
import { AtlassianLinkError, AtlassianLinksService } from './atlassian-links.js';
import { AtlassianReader } from './atlassian-read.js';
import { TrashService, TrashError, type TrashArchive } from './trash.js';
import { TrashItemsService, trashItemFiles } from './trash-items.js';
import { ProjectWorkloadService } from './project-workload.js';
import { registerTeamWorkloadRoutes } from './team-workload.js';
import { TeamWorkloadCapacityService } from './team-workload-capacity.js';
import { NATIVE_BACKUP_SCHEMA_VERSION, supportsNativeBackupVersion } from '../shared/native-backup.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION, documentContentSchemaVersion } from '../shared/document-nodes.js';
import { createCalendarMath } from '../shared/calendar.js';
import { dependencyScheduleWarning, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { isRestorableGitlabLink } from '../shared/gitlab-links.js';
import { analyzeProjectSchedule, MAX_SCHEDULE_ANALYSIS_DEPENDENCIES, MAX_SCHEDULE_ANALYSIS_TASKS, ScheduleAnalysisError } from '../shared/schedule-analysis.js';
import { calculateProjectWorkload, DEFAULT_DAILY_WORKLOAD_MINUTES, validatePlannedEffortMinutes, WorkloadError } from '../shared/project-workload.js';
import { issueSearchText } from '../shared/issue-schema.js';
import { createIssueFieldMatcher, IssueFieldFilterError, parseIssueFieldFilter } from '../shared/issue-field-filter.js';
import { PRIORITY, documentNotificationSpaceId, type Issue, type DocPage, type DocRevision, type Project, type WorkspaceSnapshot, type ScheduleChange, type SchedulePreview, type Attachment, type AttachmentVersion, type Comment, type IssueRelation, type User, type Dependency, type PlanningItem, type PlanScheduleDates, type TeamNotificationKind, type TrashRestoreResult, type GitlabLink, type ResourceLink } from '../shared/types.js';

type ScheduleUndoIssue = Pick<Issue, 'id' | 'startDate' | 'endDate'> & { appliedVersion:number };
type ScheduleUndoPlan = { id:string; appliedVersion:number; dates:PlanScheduleDates };
type ScheduleUndoRecord = { id:string; records:ScheduleUndoIssue[]; used:boolean; plan?:ScheduleUndoPlan; linkChanges?:ScheduleDependencyMutation[] };

class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
const fail = (message: string, status = 400, details?: unknown): never => { throw new ApiError(status, message, details); };
const uid = () => randomUUID();
const now = () => new Date().toISOString();
const planScheduleLabel = (dates:PlanScheduleDates) => `${dates.startDate ?? '미정'} ~ ${dates.endDate ?? '미정'} · 목표일 ${dates.targetDate ?? '미정'}`;
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
const dependencyVersionKey='schedule.dependencyVersion';
function normalizeBackupDocumentContent(value: unknown, backupVersion: number) {
  const normalized = normalizeDocumentContent(value);
  const version = documentContentSchemaVersion(normalized.content);
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

export function createApp(options: {dataDir?: string; seed?: boolean; outboundWorker?: boolean; atlassianEnv?: NodeJS.ProcessEnv} = {}) {
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
  const workflows=new WorkflowService(store,issueSchemas),savedViews=new SavedViewService(store,issueSchemas);
  const documentContent=new DocumentContentService(store);
  const documentFollowUp=new DocumentFollowUpService(store);
  const collaboration=new CollaborationService(store,documentContent);
  const notifications=new NotificationsService(store);
  const subscriptions=new NotificationSubscriptionsService(store);
  const projectSubscribers=(issue: Issue)=>subscriptions.recipients('project',issue.projectId);
  const issueSubscribers=(issue: Issue)=>[...subscriptions.recipients('issue',issue.id),...projectSubscribers(issue)];
  const spaceSubscribers=(document: DocPage)=>subscriptions.recipients('space',documentNotificationSpaceId(document.projectId));
  const documentSubscribers=(document: DocPage)=>[...subscriptions.recipients('document',document.id),...spaceSubscribers(document)];
  const atlassianLinks=new AtlassianLinksService(store);
  const atlassian=new AtlassianReader(options.atlassianEnv);
  const documentPublication=new DocumentPublicationService(store,notifications,documentSubscribers);
  const planning=new PlanningService(store);planning.migrateLegacyIssues();
  const issueOrders = new IssueOrderService(store);
  const issueBulkEdit = new IssueBulkEditService(store);
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
  const sourcePreservation=new SourcePreservationService(store);
  const trash=new TrashService(store);
  const trashItems=new TrashItemsService(store,files);
  const migrations=new MigrationService(store,dataDir,legacyImport,sourcePreservation,id=>trash.hasLocalAttachmentVersion(id)||trashItems.hasLocalAttachmentVersion(id));
  trashItems.finishCleanup();
  const attachmentVersions=new AttachmentVersionsService(store,dataDir);
  const app = express(); app.disable('x-powered-by');
  apiKeys.installAuthentication(app);
  app.use('/api/attachments',(req,res,next)=>{if(req.method!=='POST')return next();if(!req.is('application/octet-stream'))return res.status(415).json({error:'첨부파일은 application/octet-stream 형식으로 전송해 주세요.'});express.raw({type:'application/octet-stream',limit:MAX_FILE_BYTES})(req,res,next);});
  app.use('/api/legacy-import/packages',(req,res,next)=>{if(req.method!=='POST')return next();if(!req.is('application/octet-stream'))return res.status(415).json({error:'원본 패키지는 application/octet-stream 형식으로 전송해 주세요.'});express.raw({type:'application/octet-stream',limit:MAX_PACKAGE_BYTES})(req,res,next);});
  app.use('/api/integrations/gitlab/webhook',express.json({limit:2*1024*1024,verify:(req,_res,buffer)=>{(req as Request & {gitlabRawBody:Buffer}).gitlabRawBody=Buffer.from(buffer);}}));
  app.use(express.json({limit:MAX_PACKAGE_BYTES}));
  app.use((req,res,next)=>{req.body??={};if(req.method!=='GET'&&(typeof req.body!=='object'||Array.isArray(req.body)))return res.status(400).json({error:'JSON 객체가 필요합니다.'});next();});
  apiKeys.installAuthorization(app);
  app.use((req,res,next)=>{const explicit=req.header('X-Actor-Id');if(req.method!=='GET'&&explicit&&!store.get('users',explicit))return res.status(400).json({error:'작업자를 찾을 수 없습니다.'});next();});
  const get = <T = any>(table: string, id: any): T => typeof id === 'string' && store.get<T>(table,id) || fail('대상을 찾을 수 없습니다.',404);
  const actor = (req: Request) => {
    const explicit = req.header('X-Actor-Id') || req.body?.actorId;
    if (explicit) { if (!store.get('users',explicit)) fail('작업자를 찾을 수 없습니다.'); return explicit as string; }
    return store.all<any>('users')[0]?.id || fail('먼저 팀원을 등록해 주세요.');
  };
  const activity = (req: Request, resourceType: string, resourceId: string, action: string, detail = '') => store.put('activities',{id:uid(),resourceType,resourceId,actorId:actor(req),action,detail,createdAt:now()});
  const notifyIssue = (issue: Issue, actorId: string, kind: Extract<TeamNotificationKind, `issue-${string}`>, recipientIds: (string|null)[], createdAt: string) =>
    notifications.notify({kind,actorId,recipientIds,projectId:issue.projectId,targetId:issue.id,targetLabel:`${issue.key} ${issue.title}`,createdAt});
  const notifyDocument = (document: DocPage, actorId: string, kind: Extract<TeamNotificationKind, `document-${string}`>, recipientIds: string[], createdAt: string) =>
    notifications.notify({kind,actorId,recipientIds,projectId:document.projectId,targetId:document.id,targetLabel:document.title,createdAt});
  const notifyDocumentCreated = (document: DocPage) =>
    notifyDocument(document,document.authorId,'document-created',spaceSubscribers(document),document.createdAt);
  const notifyDocumentUpdate = (document: DocPage, actorId: string, createdAt: string) =>
    notifyDocument(document,actorId,'document-updated',documentSubscribers(document),createdAt);
  const stopIssueWatch = store.onChange(({before,after,context})=>{
    const old=before as Issue | undefined, issue=after as Issue | undefined;
    if(!old || !issue || old.status===issue.status || !context.actorId ||
      (context.origin!=='user' && context.origin!=='automation') || !store.get('users',context.actorId)) return;
    notifyIssue(issue,context.actorId,'issue-status-changed',issueSubscribers(issue),issue.updatedAt);
  },['issues']);
  app.use((req,_res,next)=>{const webhook=req.path==='/api/integrations/gitlab/webhook';const requested=req.header('X-Actor-Id')||req.body?.actorId;const actorId=webhook?null:(typeof requested==='string'?requested:store.all<any>('users')[0]?.id||null);store.withMutationContext({actorId,origin:webhook?'gitlab':'user'},next);});
  const attachmentRows=(type:string,id:string)=>{
    const rows=store.db.prepare('SELECT json FROM attachments WHERE resource_type=? AND resource_id=? ORDER BY rowid').all(type,id) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as Attachment);
  };
  const attachmentTarget=(type:unknown,id:unknown)=>{if(!['issue','document'].includes(type as string)||typeof id!=='string')fail('첨부파일 대상을 확인해 주세요.');get(type==='issue'?'issues':'documents',id);};
  const detachArchivedChildren=(type:string,id:string)=>{
    store.db.prepare('DELETE FROM comments WHERE resource_type=? AND resource_id=?').run(type,id);
    store.db.prepare('DELETE FROM attachments WHERE resource_type=? AND resource_id=?').run(type,id);
  };
  const snapshot = (): WorkspaceSnapshot => {
    const rows = store.db.prepare('SELECT json FROM issues ORDER BY rowid').all() as { json: string }[];
    const issues = rows.map(row => JSON.parse(row.json) as Issue);
    const data = Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, table === 'issues' ? issues : store.all(table)]));
    return {
      ...data,
      workflows:workflows.snapshot(),savedViews:savedViews.all(),planningItems:planning.all(),calendars:calendars.snapshot(),
      workloadCapacities:workload.snapshot(),teamWorkloadCapacity:teamCapacity.get(),milestones:scheduleArtifacts.allMilestones(),
      baselines:scheduleArtifacts.allBaselines(),issueSchemas:issueSchemas.snapshot(),
      issueOrders: issueOrders.snapshot(data.projects, issues),
    } as unknown as WorkspaceSnapshot;
  };
  const validateEmail = (email: any) => { const e = text(email,'이메일',254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail('올바른 이메일이 필요합니다.'); return e; };
  const validateUser = (u: any) => { u.name=text(u.name,'이름',80);u.email=validateEmail(u.email);if(!/^#[a-f\d]{6}$/i.test(u.color))fail('색상은 #RRGGBB 형식이어야 합니다.'); return u; };
  const validateProject = (p: any) => { p.name=text(p.name,'프로젝트 이름',100);p.key=text(p.key,'프로젝트 키',12).toUpperCase();if(!/^[A-Z][A-Z0-9]{1,11}$/.test(p.key))fail('프로젝트 키는 영문 대문자로 시작하는 2~12자리 영문·숫자입니다.');if(typeof p.description!=='string')fail('설명을 확인해 주세요.');if(!/^#[a-f\d]{6}$/i.test(p.color))fail('색상을 확인해 주세요.');return p; };
  const validateIssue = (i: Issue,previous?:Issue,options?:{checkTransition?:boolean;checkFields?:boolean;allowArchivedPlanning?:boolean;allowArchivedSchema?:boolean}) => {
    get('projects',i.projectId); i.title=text(i.title,'티켓 제목',300);
    if(typeof i.description!=='string'||i.description.length>200000)fail('설명을 확인해 주세요.');
    issueSchemas.validateIssue(i,previous,{checkFields:options?.checkFields,allowArchived:options?.allowArchivedSchema});
    if(typeof i.status!=='string'||!Object.hasOwn(PRIORITY,i.priority))fail('상태 또는 우선순위가 올바르지 않습니다.');
    if(i.assigneeId!==null)get('users',i.assigneeId);
    if(!Array.isArray(i.collaboratorIds)||!i.collaboratorIds.every(x=>typeof x==='string'))fail('협력자를 확인해 주세요.');
    i.collaboratorIds=[...new Set(i.collaboratorIds)];i.collaboratorIds.forEach(id=>get('users',id));
    if(!Array.isArray(i.labels)||!i.labels.every(x=>typeof x==='string'&&x.length<=60))fail('라벨을 확인해 주세요.');i.labels=[...new Set(i.labels)];
    i.startDate=date(i.startDate,'시작일');i.endDate=date(i.endDate,'종료일');i.dueDate=date(i.dueDate,'마감일');dateRange(i.startDate,i.endDate);
    if(i.estimate!==null&&(!Number.isFinite(i.estimate)||i.estimate<0||i.estimate>100000))fail('예상 작업량은 0 이상의 숫자여야 합니다.');
    validatePlannedEffortMinutes(i.plannedEffortMinutes);
    planning.validateIssueReferences(i,previous,{allowArchived:options?.allowArchivedPlanning});
    let parentId=i.parentId;const visited=new Set([i.id]);
    while(parentId){if(visited.has(parentId))fail('상위 티켓에 순환 관계가 있습니다.');visited.add(parentId);const p=get<Issue>('issues',parentId);if(p.projectId!==i.projectId)fail('상위 티켓은 같은 프로젝트에 있어야 합니다.');parentId=p.parentId;}
    workflows.validateIssue(i,previous,options);return i;
  };
  const validateDocument = (d: DocPage, previous?: DocPage, options: {allowMissing?: boolean;skipReferences?:boolean} = {}) => {
    d.title=text(d.title,'문서 제목',300);if(d.projectId!==null)get('projects',d.projectId);get('users',d.authorId);
    const normalized=documentContent.normalize(d.content);d.content=normalized.content;d.plainText=normalized.plainText;if(!options.skipReferences)documentContent.validate(d.id,d.content,previous?.content,options);if(!['draft','published'].includes(d.status))fail('문서 상태를 확인해 주세요.');
    if(typeof d.icon!=='string'||d.icon.length>20)fail('아이콘을 확인해 주세요.');
    let parentId=d.parentId;const visited=new Set([d.id]);
    while(parentId){if(visited.has(parentId))fail('문서 트리에 순환 관계가 있습니다.');visited.add(parentId);const p=get<DocPage>('documents',parentId);if(p.projectId!==d.projectId)fail('상위 문서는 같은 프로젝트에 있어야 합니다.');parentId=p.parentId;}
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
  /** Caller owns the transaction, shared by manual edits and guarded proposals. */
  const commitScheduleChanges=(req:Request,changes:unknown,dependencies?:Dependency[],plan?:ScheduleUndoPlan,dependencyChanges:ScheduleDependencyMutation[] = [])=>{
    if(!Array.isArray(changes)||(!changes.length&&!plan&&!dependencyChanges.length)||changes.length>1000)return fail('변경할 일정이나 업무 연결을 선택해 주세요.');
    const seen=new Set<string>(),records:ScheduleUndoIssue[]=[],updated:Issue[]=[];
    for(const c of changes){
      if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.id!=='string')fail('일정 변경 형식을 확인해 주세요.');
      if(seen.has(c.id))fail('중복된 티켓입니다.');seen.add(c.id);
      const old=get<Issue>('issues',c.id);checkVersion(old,c.expectedVersion);
      if(!Object.hasOwn(c,'startDate')||!Object.hasOwn(c,'endDate'))fail('시작일과 종료일 값을 지정해 주세요.');
      const i=validateIssue({...old,startDate:date(c.startDate,'시작일'),endDate:date(c.endDate,'종료일'),version:old.version+1,updatedAt:now()},old,{checkTransition:false});
      records.push({id:i.id,appliedVersion:i.version,startDate:old.startDate,endDate:old.endDate});store.put('issues',i);
      activity(req,'issue',i.id,'일정 변경',`${old.startDate||'미정'} ~ ${old.endDate||'미정'} → ${i.startDate||'미정'} ~ ${i.endDate||'미정'}`);updated.push(i);
    }
    const projectIds=new Set(updated.map(issue=>issue.projectId));
    const undoId=uid();
    const linkChanges=writeScheduleDependencyChanges(req,dependencyChanges,projectIds,undoId);
    const record:ScheduleUndoRecord={id:undoId,records,used:false,...(plan?{plan}:{}),...(linkChanges.length?{linkChanges}:{})};
    const linkDetail=linkChanges.length?` · 업무 연결 ${linkChanges.length}건`:'';
    store.put('schedule_undos',record);activity(req,'schedule',undoId,'일정 일괄 변경',`${plan?'계획 1개 · ':''}${updated.length}개 티켓${linkDetail}`);
    const warnings=projectIds.size?scheduleWarnings(store.all<Issue>('issues').filter(issue=>projectIds.has(issue.projectId)),dependencies):[];
    return{undoId,updated,warnings,...(linkChanges.length?{dependencyChanges:linkChanges.length}:{})};
  };
  const scheduleVersions=(projectId:string)=>({calendar:calendars.get(projectId).version,workflow:workflows.get(projectId).version,schema:issueSchemas.get(projectId).version});
  const validateScheduleChange=(issue:Issue,change:AutomaticScheduleMutation):string|null=>{
    try {
      validateIssue({...issue,startDate:change.startDate,endDate:change.endDate},issue,{checkTransition:false});
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
  const prepareIssueChange=(before:Issue,proposed:Issue,assigneeExplicit=false)=>{
    const decision=issueAssignments.decide(before,proposed,assigneeExplicit);
    const issue=validateIssue(decision?.outcome==='assigned'?{...proposed,assigneeId:decision.assigneeId}:proposed,before);
    issue.completedAt=done(issue)?(before.completedAt||issue.updatedAt):null;
    return {issue,decision};
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
      const {issue,decision}=prepareIssueChange(before,{...before,status,version:before.version+1,updatedAt:now()});
      if(decision)onStatusChange((rule,event)=>commitIssueAssignment(decision,before,issue,rule.actorId,'gitlab',event.id));
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
  });
  const outbound=new OutboundWebhookService(store,{autoStart:options.outboundWorker!==false});
  legacyImport.registerRoutes(app,{actor,activity});
  sourcePreservation.registerRoutes(app);
  registerSourceReconciliationRoutes(app, { store, files, preservation: sourcePreservation, trash });
  migrations.registerRoutes(app, {
    actor,
    persistCanonical(value, req) {
      const schemas = issueSchemas.validateImport(value.issueSchemas, value.projects, value.issues, {users:store.all<User>('users')});
      const importedWorkflows = workflows.validateImport(value.workflows, value.projects, value.issues, schemas);
      validateVisibilityStatuses(schemas, importedWorkflows);
      for (const project of value.projects) store.put('projects', validateProject(project));
      for (const schema of schemas) store.put('issue_schemas', schema);
      for (const workflow of importedWorkflows) store.put('workflows', workflow);
      // Insert both sets first so forward references can be validated against the complete plan.
      for (const issue of value.issues) store.put('issues', issue);
      for (const document of value.documents) store.put('documents', document);
      const firstDocument = value.documents[0];
      if (firstDocument) documentContent.validate(firstDocument.id, firstDocument.content);
      for (const issue of value.issues) store.put('issues', validateIssue(issue, undefined, {checkFields:false,allowArchivedSchema:true}));
      for (const document of value.documents) store.put('documents', validateDocument(document, undefined, {skipReferences:true}));
      worklogs.persistMigrated(value.worklogs??[],value.sourceRecords);
      for (const comment of value.comments) store.put('comments', comment);
      for (const revision of value.revisions) store.put('revisions', revision);
      for (const attachment of value.attachments) store.put('attachments', attachment);
      for (const link of value.resourceLinks) store.put('resource_links', link);
      for (const link of value.atlassianLinks??[]) atlassianLinks.create(link);
      const nextNumbers = new Map(value.projects.map(project => [project.id, 1]));
      for (const issue of value.issues) {
        const number = Number(issue.key.split('-').at(-1));
        nextNumbers.set(issue.projectId, Math.max(nextNumbers.get(issue.projectId)!, number + 1));
      }
      const insertSequence = store.db.prepare('INSERT INTO issue_sequences VALUES(?,?)');
      for (const [projectId, next] of nextNumbers) insertSequence.run(projectId, next);
      reportLedger.baselineImportedIssues(value.issues);
      activity(req, 'source-import', value.sourceImport.id, '원본 이관 적용', `${value.issues.length}개 업무 · ${value.documents.length}개 문서`);
    },
  });
  worklogs.registerRoutes(app,{actor,activity});
  timeReservations.registerRoutes(app,{actor,activity});
  registerFieldBreakdownRoutes(app,store,issueSchemas);
  reports.registerRoutes(app,{
    actor,
    createDocument(req,snapshot,content,issueIds) {
      const document=validateDocument({
        id:snapshot.documentId,projectId:snapshot.projectId,parentId:null,title:snapshot.title,content,plainText:'',
        icon:'📊',status:'draft',version:1,authorId:snapshot.actorId,createdAt:snapshot.createdAt,updatedAt:snapshot.createdAt,
      });
      store.put('documents',document);
      revision(document,snapshot.actorId,'보고서에서 작성');
      activity(req,'document',document.id,'주간 문서 생성',document.title);
      for (const issueId of issueIds) store.put('resource_links',{id:uid(),issueId,documentId:document.id,kind:'주간 보고서'});
      notifyDocumentCreated(document);
    },
  });
  automation.registerRoutes(app,{actor,activity});outbound.registerRoutes(app,{actor,activity});gitlab.registerRoutes(app,{actor,activity});
  issueAssignments.registerRoutes(app,{actor,activity,validate:(proposed,before)=>validateIssue(proposed,before)});
  workflows.registerRoutes(app,{actor,activity});savedViews.registerRoutes(app,{actor,activity});
  issueSchemas.registerRoutes(app,{actor,activity});
  planning.registerRoutes(app,{actor,activity,validateIssue});apiKeys.registerManagementRoutes(app,{actor,activity});
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
  automaticSchedule.registerRoutes(app,{actor,commitChanges:commitScheduleChanges},{
    capacity:projectId=>workload.get(projectId),teamCapacity:()=>teamCapacity.get(),
    workflow:projectId=>workflows.get(projectId),validateChange:validateScheduleChange,
  });
  schedulePaste.registerRoutes(app,{
    actor,
    versions:scheduleVersions,
    validateChange:validateScheduleChange,
    warnings:scheduleWarnings,
    commitChanges:(request,changes,dependencies,linkChanges)=>commitScheduleChanges(request,changes,dependencies,undefined,linkChanges),
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
      return {...commitScheduleChanges(req,changes,dependencies,planUndo),plan};
    },
  });
  scheduleArtifacts.registerRoutes(app,{actor,activity,getCalendar:projectId=>calendars.get(projectId)});

  app.get('/api/health',(_req,res)=>res.json({ok:true,storage:'sqlite',version:'0.1.0'}));
  app.get('/api/workspace',(_req,res)=>res.json(snapshot()));
  registerTeamOverviewRoutes(app,{
    store,timeReservations,
    snapshot:()=>({projects:store.all('projects'),issues:store.all('issues'),workflows:workflows.snapshot(),gitlabLinks:store.all('gitlab_links')}),
  });
  app.get('/api/atlassian-links',(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='targetType'&&key!=='targetId'))return fail('기존 도구 링크 조회 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').json(atlassianLinks.list(req.query.targetType,req.query.targetId));
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
  const notificationRecipient = (req: Request) => {
    const recipientId = req.header('X-Actor-Id');
    if (!recipientId || !store.get('users',recipientId)) return fail('등록된 작업자를 선택해 주세요.');
    return recipientId;
  };
  app.get('/api/notifications/count',(req,res)=>{
    if (Object.keys(req.query).length) return fail('알림 수에 조회 조건을 지정할 수 없습니다.');
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(notificationRecipient(req))});
  });
  app.get('/api/notifications',(req,res)=>{
    const {filter='all',before}=req.query;
    if (Object.keys(req.query).some(key=>key!=='filter'&&key!=='before') || (filter!=='all'&&filter!=='unread') ||
      (before!==undefined&&(typeof before!=='string'||!before))) return fail('알림 조회 조건을 확인해 주세요.');
    res.set('Cache-Control','no-store').json(notifications.list(notificationRecipient(req),filter,before));
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
    const userId=notificationRecipient(req), {targetType,targetId}=subscriptionTarget(req);
    res.set('Cache-Control','no-store').json({subscribed:subscriptions.isSubscribed(userId,targetType,targetId)});
  });
  app.put('/api/notifications/subscriptions/:targetType/:targetId',(req,res)=>{
    const userId=notificationRecipient(req), {targetType,targetId}=subscriptionTarget(req);
    if (Object.keys(req.body).length!==1 || typeof req.body.subscribed!=='boolean') return fail('구독 여부를 확인해 주세요.');
    res.set('Cache-Control','no-store').json(subscriptions.setSubscribed(userId,targetType,targetId,req.body.subscribed));
  });
  app.patch('/api/notifications/read-all',(req,res)=>{
    const recipientId=notificationRecipient(req), throughId=text(req.body.throughId,'알림 ID',200);
    if (!notifications.markAllRead(recipientId,throughId)) return fail('알림을 찾을 수 없습니다.',404);
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(recipientId)});
  });
  app.patch('/api/notifications/:id/read',(req,res)=>{
    const recipientId=notificationRecipient(req);
    if (!notifications.markRead(recipientId,req.params.id)) return fail('알림을 찾을 수 없습니다.',404);
    res.set('Cache-Control','no-store').json({unreadCount:notifications.count(recipientId)});
  });
  app.post('/api/users',(req,res)=>{const u=validateUser({id:uid(),name:req.body.name,email:req.body.email,color:req.body.color||'#5879ed'});store.put('users',u);res.status(201).json(u);});
  app.patch('/api/users/:id',(req,res)=>{const u=get('users',req.params.id);const updated=validateUser({...u,...Object.fromEntries(['name','email','color'].filter(k=>k in req.body).map(k=>[k,req.body[k]]))});store.transaction(()=>{store.put('users',updated);activity(req,'user',u.id,'팀원 정보 변경');});res.json(updated);});
  app.post('/api/projects',(req,res)=>{const p=validateProject({id:uid(),key:req.body.key,name:req.body.name,description:req.body.description||'',color:req.body.color||'#5879ed',createdAt:now()});store.transaction(()=>{store.put('projects',p);store.db.prepare('INSERT INTO issue_sequences VALUES(?,1)').run(p.id);activity(req,'project',p.id,'프로젝트 생성',p.name);});res.status(201).json(p);});
  const prepareIssueUpdate = (old: Issue, values: Record<string, unknown>, assigneeExplicit=false) => {
    if(values.projectId&&values.projectId!==old.projectId)fail('프로젝트 이동은 아직 지원하지 않습니다.');
    const fields=['title','description','type','status','priority','assigneeId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','plannedEffortMinutes','cycle','module','release','cycleId','moduleId','releaseId','customFields'].filter(k=>k in values);
    const proposed={...old,...Object.fromEntries(fields.map(k=>[k,values[k]])),...planning.resolveIssueFields(values,old.projectId,old),version:old.version+1,updatedAt:now()};
    return {...prepareIssueChange(old,proposed,assigneeExplicit),fields};
  };
  const commitIssueUpdate = (req: Request, old: Issue, {issue,decision,fields}:ReturnType<typeof prepareIssueUpdate>) => {
    const actorId=actor(req);
    store.put('issues',issue);activity(req,'issue',issue.id,'티켓 변경',`${issue.key}: ${fields.join(', ')}`);
    if(issue.assigneeId&&issue.assigneeId!==old.assigneeId)notifyIssue(issue,actorId,'issue-assigned',[issue.assigneeId],issue.updatedAt);
    commitIssueAssignment(decision,old,issue,actorId,'user');
    return issue;
  };
  const updateIssue = (req: Request, old: Issue, values: Record<string, unknown>) => commitIssueUpdate(req,old,prepareIssueUpdate(old,values));
  issueBulkEdit.registerRoutes(app,{
    actor,
    configurationToken:projectId=>JSON.stringify([workflows.get(projectId).version,issueSchemas.get(projectId).version,issueAssignments.revisions(projectId)]),
    prepare:(before,changes)=>prepareIssueUpdate(before,changes,Object.hasOwn(changes,'assigneeId')),
    commit:commitIssueUpdate,
  });
  app.get('/api/projects/:id/issue-order',(req,res)=>{
    res.set('Cache-Control','no-store').json(issueOrders.get(req.params.id));
  });
  app.patch('/api/projects/:id/issue-order',(req,res)=>{
    const result = issueOrders.move(req.params.id, req.body, {
      changeStatus: (issue,status) => updateIssue(req, issue, {status}),
      recordMove: (issue,anchor,position) => {
        const location = anchor ? `${anchor.key} ${position === 'before' ? '앞으로' : '뒤로'}` : position === 'before' ? '맨 처음으로' : '맨 끝으로';
        activity(req, 'issue', issue.id, '업무 순서 변경', `${issue.key} · ${location} 이동`);
      },
    });
    res.json(result);
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
    const {projectId}=req.body;
    if(typeof projectId!=='string'||!projectId||projectId.length>200)fail('필터를 적용할 프로젝트가 필요합니다.');
    const result=store.transaction(()=>{
      const schema=issueSchemas.get(projectId);
      const filter=parseIssueFieldFilter(req.body.fieldFilter,schema,store.all<User>('users'));
      const matches=createIssueFieldMatcher(filter,schema);
      const rows=store.db.prepare('SELECT json FROM issues WHERE project_id=? ORDER BY rowid').all(projectId) as {json:string}[];
      return rows.map(row=>JSON.parse(row.json) as Issue).filter(matches);
    });
    res.json(result);
  });
  // The caller owns the transaction, including any links created with the issue.
  const createIssueInTransaction=(req:Request,input:Record<string,unknown>):Issue=>{
    const timestamp=now();const fields=['projectId','title','description','type','status','priority','assigneeId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','plannedEffortMinutes','cycle','module','release','customFields'];
    const projectId=text(input.projectId,'프로젝트',200);
    const activeTypes=issueSchemas.get(projectId).issueTypes.filter(type=>!type.archived);
    const i:Issue={id:uid(),key:'',projectId:'',title:'',description:'',type:activeTypes.find(type=>type.id==='작업')?.id||activeTypes[0].id,status:workflows.get(projectId).initialStatusId,priority:'medium',assigneeId:null,collaboratorIds:[],parentId:null,labels:[],startDate:null,endDate:null,dueDate:null,estimate:null,plannedEffortMinutes:null,cycle:null,module:null,release:null,version:1,createdAt:timestamp,updatedAt:timestamp,completedAt:null,...Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]))};
    Object.assign(i,planning.resolveIssueFields(input,i.projectId));validateIssue(i);
    const p=get<Project>('projects',i.projectId), row=store.db.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(i.projectId) as {next_number:number}|undefined;
    const num=row?.next_number||1;i.key=`${p.key}-${num}`;
    store.db.prepare('INSERT INTO issue_sequences VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET next_number=excluded.next_number').run(i.projectId,num+1);
    if(done(i))i.completedAt=timestamp;
    store.put('issues',i);activity(req,'issue',i.id,'티켓 생성',`${i.key} ${i.title}`);
    const actorId=actor(req);
    if(i.assigneeId)notifyIssue(i,actorId,'issue-assigned',[i.assigneeId],timestamp);
    notifyIssue(i,actorId,'issue-created',projectSubscribers(i).filter(id=>id!==i.assigneeId),timestamp);
    return i;
  };
  app.post('/api/issues',(req,res)=>{
    const issue=store.transaction(()=>createIssueInTransaction(req,req.body));
    res.status(201).json(issue);
  });
  app.post('/api/documents/:id/follow-up-issues',(req,res)=>{
    const result=documentFollowUp.create({documentId:String(req.params.id),actorId:actor(req),body:req.body},{
      create(documentId,expectedVersion,input){
        const document=get<DocPage>('documents',documentId);
        checkVersion(document,expectedVersion);
        if(document.projectId!==null&&document.projectId!==input.projectId)fail('프로젝트 문서의 후속 업무는 같은 프로젝트에 만들어 주세요.');
        const issue=createIssueInTransaction(req,input);
        const link:ResourceLink={id:uid(),issueId:issue.id,documentId,kind:'후속 업무'};
        store.put('resource_links',link);
        activity(req,'document',documentId,'후속 업무 생성',`${issue.key} ${issue.title}`);
        return {issue,link};
      },
    });
    res.status(result.duplicate?200:201).json(result);
  });
  app.patch('/api/issues/:id',(req,res)=>{
    const updated=store.transaction(()=>{
      const old=get<Issue>('issues',req.params.id);checkVersion(old,req.body.expectedVersion);
      return updateIssue(req,old,req.body);
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
  app.post('/api/documents',(req,res)=>{const timestamp=now(),authorId=actor(req);const d:DocPage={id:uid(),projectId:req.body.projectId??null,parentId:req.body.parentId??null,title:req.body.title,content:Object.hasOwn(req.body,'content')?req.body.content:{type:'doc',content:[{type:'paragraph'}]},plainText:'',icon:req.body.icon||'📄',status:req.body.status||'draft',version:1,authorId,createdAt:timestamp,updatedAt:timestamp};store.transaction(()=>{validateDocument(d);store.put('documents',d);revision(d,authorId,'최초 작성');activity(req,'document',d.id,'문서 생성',d.title);notifyDocumentCreated(d);});res.status(201).json(d);});
  app.patch('/api/documents/:id',(req,res)=>{
    const bodyChanged=Object.hasOwn(req.body,'content');
    const updated=store.transaction(()=>{
      const old=get<DocPage>('documents',req.params.id);checkVersion(old,req.body.expectedVersion);
      const fields=['projectId','parentId','title','content','icon','status'];
      let d=validateDocument({...old,...Object.fromEntries(fields.filter(k=>k in req.body).map(k=>[k,req.body[k]])),version:old.version+1,updatedAt:now()},old);
      if (bodyChanged) {
        const existingSchema = documentContentSchemaVersion(old.content);
        const clientSchema = req.body.contentSchemaVersion;
        if (existingSchema >= 4 && clientSchema !== existingSchema && clientSchema !== DOCUMENT_CONTENT_SCHEMA_VERSION && JSON.stringify(d.content) !== JSON.stringify(old.content)) {
          const block = existingSchema === 5 ? '고정 버전 포함 블록' : '업무 현황';
          fail(`${block}이 있는 문서입니다. 최신 편집기를 열어 본문을 다시 확인해 주세요.`, 409, { currentVersion: old.version, contentSchemaVersion: existingSchema });
        }
        if (existingSchema === 3 && clientSchema !== 3 && clientSchema !== 4 && clientSchema !== DOCUMENT_CONTENT_SCHEMA_VERSION && documentContentSchemaVersion(d.content) < 3) {
          fail('업무 목록이 있는 문서입니다. 최신 편집기를 열어 본문을 다시 확인해 주세요.', 409, { currentVersion: old.version, contentSchemaVersion: 3 });
        }
      }
      if(d.projectId!==old.projectId&&store.all<DocPage>('documents').some(x=>x.parentId===d.id))fail('하위 문서를 먼저 이동해 주세요.');
      store.put('documents',d);if(bodyChanged)d=collaboration.replaceBody(d);else{d=collaboration.deriveSnapshot(d);store.put('documents',d);}
      const actorId=actor(req);
      revision(d,actorId,nullableText(req.body.summary,'변경 설명',500)||'문서 편집');activity(req,'document',d.id,'문서 변경',d.title);
      if (d.title!==old.title || d.status!==old.status || d.projectId!==old.projectId || d.parentId!==old.parentId ||
        d.icon!==old.icon || (bodyChanged && JSON.stringify(d.content)!==JSON.stringify(old.content))) notifyDocumentUpdate(d,actorId,d.updatedAt);
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
      atlassianLinks.removeTarget(entry.resourceType,entry.resourceId);
      if(entry.resourceType==='issue')timeReservations.purgeIssue(entry.resourceId);
      trashItems.purgeOwner(entry.resourceType,entry.resourceId);
      trashItems.queueCleanup(archivedFiles(entry));
      trash.remove(entry.id);
      activity(req,entry.resourceType,entry.resourceId,'휴지통에서 영구 삭제',entry.title);
    });
    trashItems.finishCleanup();
    res.json({ok:true});
  });
  app.get('/api/documents/:id/revisions',(req,res)=>{get('documents',req.params.id);res.json(store.all<any>('revisions').filter(r=>r.documentId===req.params.id).sort((a,b)=>b.version-a.version));});
  app.get('/api/document-publications/count',(req,res)=>{
    if(Object.keys(req.query).length)return fail('검토 수에 조회 조건을 지정할 수 없습니다.');
    res.set('Cache-Control','no-store').json({pendingAssigned:countDocumentAssignedReviews(store,actor(req))});
  });
  app.get('/api/document-publications',(req,res)=>{
    res.set('Cache-Control','no-store').json(listDocumentPublications(store,actor(req),req.query));
  });
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
  app.post('/api/documents/:id/publication',(req,res)=>{
    res.json(documentPublication.transition(req.params.id,actor(req),req.body,content=>apiKeys.authorizeDocumentBody(req,content)));
  });
  app.post('/api/documents/:id/restore',(req,res)=>{
    const updated=store.transaction(()=>{const old=get<DocPage>('documents',req.params.id);checkVersion(old,req.body.expectedVersion);const r=get('revisions',req.body.revisionId);if(r.documentId!==old.id)fail('이 문서의 버전이 아닙니다.');let d=validateDocument({...old,title:r.title,content:r.content,plainText:r.plainText,version:old.version+1,updatedAt:now()},old,{allowMissing:true});store.put('documents',d);d=collaboration.replaceBody(d,{allowMissing:true});const actorId=actor(req);revision(d,actorId,`버전 ${r.version}에서 복구`);activity(req,'document',d.id,'문서 복구',`버전 ${r.version} → ${d.version}`);if(d.title!==old.title||JSON.stringify(d.content)!==JSON.stringify(old.content))notifyDocumentUpdate(d,actorId,d.updatedAt);return d;});
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
    if(!['issue','document'].includes(resourceType))return fail('댓글 대상을 확인해 주세요.');
    const c={id:uid(),resourceType,resourceId,authorId:actor(req),body:text(req.body.body,'댓글',20000),createdAt:now()};
    store.transaction(()=>{
      if(resourceType==='issue'){
        const issue=get<Issue>('issues',resourceId);
        notifyIssue(issue,c.authorId,'issue-comment',[issue.assigneeId,...issue.collaboratorIds,...issueSubscribers(issue)],c.createdAt);
      }else{
        const doc=get<DocPage>('documents',resourceId);
        notifyDocument(doc,c.authorId,'document-comment',[doc.authorId,...documentSubscribers(doc)],c.createdAt);
      }
      store.put('comments',c);activity(req,resourceType,resourceId,'댓글 작성',c.body.slice(0,100));
    });res.status(201).json(c);
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
  app.get('/api/issues/:id/relations',(req,res)=>{
    const issue=get<Issue>('issues',req.params.id);
    const rows=store.db.prepare('SELECT json FROM issue_relations WHERE source_issue_id=? OR target_issue_id=? ORDER BY rowid').all(issue.id,issue.id) as {json:string}[];
    res.json(rows.map(row=>JSON.parse(row.json) as IssueRelation));
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
  app.post('/api/resource-links',(req,res)=>{get('issues',req.body.issueId);get('documents',req.body.documentId);const l={id:uid(),issueId:req.body.issueId,documentId:req.body.documentId,kind:nullableText(req.body.kind,'관계',80)||'관련 문서'};store.transaction(()=>{store.put('resource_links',l);activity(req,'issue',l.issueId,'문서 연결');});res.status(201).json(l);});
  app.delete('/api/resource-links/:id',(req,res)=>{const l=get('resource_links',req.params.id);store.transaction(()=>{store.remove('resource_links',l.id);activity(req,'issue',l.issueId,'문서 연결 해제');});res.json({ok:true});});
  app.post('/api/dependencies',(req,res)=>{
    const input=req.body??{};
    const dependency:Dependency={id:uid(),predecessorId:input.predecessorId,successorId:input.successorId,
      type:input.type===undefined?'FS':input.type,lagDays:input.lagDays??0,version:1};
    store.transaction(()=>{
      validateDependency(dependency);
      store.put('dependencies',dependency);
      activity(req,'issue',dependency.successorId,'선행 업무 연결',get<Issue>('issues',dependency.predecessorId).key);
    });
    res.status(201).json(dependency);
  });
  app.patch('/api/dependencies/:id',(req,res)=>{
    const input=req.body;
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['expectedVersion','type','lagDays','actorId'].includes(key)))fail('업무 연결 유형과 간격을 확인해 주세요.');
    const result=store.transaction(()=>{
      const prior=get<Dependency>('dependencies',req.params.id);
      checkVersion({version:prior.version??1},input.expectedVersion);
      const type=Object.hasOwn(input,'type')?input.type:prior.type;
      const lagDays=Object.hasOwn(input,'lagDays')?input.lagDays:prior.lagDays;
      if(!isDependencyType(type)||!isDependencyLag(lagDays))fail('업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
      if(type===prior.type&&lagDays===prior.lagDays)return {...prior,version:prior.version??1};
      // Editing relationship details leaves the existing endpoints and graph intact.
      const version=nextDependencyVersion(prior);
      const next:Dependency={...prior,type,lagDays,version};
      store.put('dependencies',next);
      trackDependencyVersion(version);
      activity(req,'issue',next.successorId,'선후행 일정 변경',`${prior.type} ${prior.lagDays}근무일 → ${next.type} ${next.lagDays}근무일`);
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
  app.post('/api/schedule/undo',(req,res)=>{
    const result=store.transaction(()=>{
      const record=get<ScheduleUndoRecord>('schedule_undos',req.body.undoId);
      if(record.used)fail('이미 되돌린 작업입니다.',409);
      const previousPlan=record.plan&&get<PlanningItem>('planning_items',record.plan.id);
      if(record.plan&&previousPlan)checkVersion(previousPlan,record.plan.appliedVersion);
      for(const entry of record.records)checkVersion(get<Issue>('issues',entry.id),entry.appliedVersion);
      const reverseLinks=record.linkChanges?.length?prepareDependencyUndo(record.id,record.linkChanges):[];
      const updated=record.records.map(entry=>{
        const old=get<Issue>('issues',entry.id);
        const issue=validateIssue({...old,startDate:entry.startDate,endDate:entry.endDate,version:old.version+1,updatedAt:now()},old,{checkTransition:false});
        store.put('issues',issue);
        activity(req,'issue',issue.id,'일정 되돌리기',`${old.startDate??'미정'} ~ ${old.endDate??'미정'} → ${issue.startDate??'미정'} ~ ${issue.endDate??'미정'}`);
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
      return {updated,warnings,...(plan?{plan}:{}),...(reverseLinks.length?{dependencyChanges:reverseLinks.length}:{})};
    });
    res.json(result);
  });
  app.get('/api/search',(req,res)=>{const q=String(req.query.q||'').trim().toLocaleLowerCase();if(q.length>500)fail('검색어가 너무 깁니다.');const searchData={issueSchemas:issueSchemas.snapshot(),users:store.all<import('../shared/types.js').User>('users')};res.json({issues:store.all<Issue>('issues').filter(i=>issueSearchText(searchData,i).toLocaleLowerCase().includes(q)),documents:store.all<DocPage>('documents').filter(d=>`${d.title} ${d.plainText}`.toLocaleLowerCase().includes(q))});});
  app.get('/api/export',(_req,res)=>{
    const attachments=store.all<Attachment>('attachments');
    const attachmentVersions=sourcePreservation.allVersions();
    const itemArchives=trashItems.all();
    const trashEntries=trash.all().map(entry=>entry.gitlabLinks.some(link=>link.kind==='branch')
      ? {...entry,gitlabLinks:entry.gitlabLinks.map(link=>gitlab.latestObservedBranchLink(link))}
      : entry);
    const binaries=[...new Map([...attachments,...attachmentVersions,...trashEntries.flatMap(archivedFiles),...itemArchives.flatMap(trashItemFiles)].map(file=>[file.id,file])).values()];
    const exportedAt=now();
    const payload={schemaVersion:NATIVE_BACKUP_SCHEMA_VERSION,trashEntries,trashItems:itemArchives,teamNotifications:notifications.all(),notificationSubscriptions:subscriptions.all(),atlassianLinks:atlassianLinks.all(),documentPublications:documentPublication.all(),worklogs:worklogs.all(),timeReservations:timeReservations.all(),reportingLedger:reportLedger.exportData(exportedAt),reportSnapshots:reports.all(),automationRules:automation.all(),issueAssignmentRules:issueAssignments.all(),collabStates:collaboration.exportStates(),exportedAt,...snapshot(),comments:store.all('comments'),revisions:store.all('revisions'),attachments,attachmentContents:[] as {id:string;data:string}[],attachmentVersions,sourceImports:sourcePreservation.allImports(),sourceRecords:sourcePreservation.allRecords(),issueRelations:sourcePreservation.allRelations()};
    const estimated=Buffer.byteLength(JSON.stringify(payload))+binaries.reduce((sum,a)=>sum+Math.ceil(a.size/3)*4+100,0);
    if(estimated>MAX_EXPORT_BYTES)fail('첨부파일을 포함한 전체 내보내기 파일은 64MiB 미만이어야 합니다. 운영 파일 백업을 사용해 주세요.',413);
    try{payload.attachmentContents=binaries.map(a=>({id:a.id,data:files.read(a).toString('base64')}));}catch{fail('첨부파일을 읽거나 무결성을 확인하지 못해 내보내기를 중단했습니다.',503);}
    const serialized=JSON.stringify(payload);if(Buffer.byteLength(serialized)>MAX_EXPORT_BYTES)fail('내보내기 파일은 64MiB 미만이어야 합니다.',413);
    res.type('application/json').send(serialized);
  });
  app.post('/api/import',(req,res)=>{
    const data=req.body.data;if(!data||!supportsNativeBackupVersion(data.schemaVersion))fail(`지원하는 Teamspace 내보내기 파일(schemaVersion 1~${NATIVE_BACKUP_SCHEMA_VERSION})이 필요합니다.`);
    if(data.schemaVersion===1){if(data.attachments?.length||data.attachmentContents?.length)fail('첨부파일이 있는 데이터는 schemaVersion 2가 필요합니다.');data.attachments=[];data.attachmentContents=[];}
    const expected=[...Object.keys(tables),'comments','revisions','attachments','attachmentContents'];
    for(const key of expected){if(!Array.isArray(data[key])||data[key].length>100000)fail(`${key} 데이터가 올바르지 않습니다.`);const ids=new Set();for(const x of data[key]){if(!x||typeof x.id!=='string'||!x.id||ids.has(x.id))fail(`${key}에 잘못되거나 중복된 ID가 있습니다.`);ids.add(x.id);}}
    const importedPlanning=planning.prepareImport(data.schemaVersion>=4?data.planningItems:[],data.projects,data.users,data.issues,{legacy:data.schemaVersion<4});
    data.issues=importedPlanning.issues;
    const importedIssueOrders = data.schemaVersion >= 23 ? issueOrders.validateImport(data.issueOrders, data.projects, data.issues) : [];
    const importDocument = <T extends DocPage | DocRevision>(document: T): T => ({ ...document, ...normalizeBackupDocumentContent(document.content, data.schemaVersion) });
    const importedDocuments = (data.documents as DocPage[]).map(importDocument);
    const importedRevisions = (data.revisions as DocRevision[]).map(importDocument);
    data.documents=importedDocuments;
    data.revisions=importedRevisions;
    if(data.schemaVersion<34&&Array.isArray(data.issueSchemas)&&data.issueSchemas.some((schema:{fields?:unknown}|null)=>
      Array.isArray(schema?.fields)&&schema.fields.some((field:unknown)=>field&&typeof field==='object'&&Object.hasOwn(field,'visibleWhen'))
    ))fail('필드 표시 조건이 있는 백업은 schemaVersion 34가 필요합니다.');
    const importedSchemas=issueSchemas.validateImport(data.schemaVersion>=6?data.issueSchemas:[],data.projects,data.issues,{legacy:data.schemaVersion<6,users:data.users});
    const importedWorkflows=workflows.validateImport(data.schemaVersion>=3?data.workflows:[],data.projects,data.issues,importedSchemas);
    validateVisibilityStatuses(importedSchemas,importedWorkflows);
    if(data.schemaVersion<13&&Array.isArray(data.savedViews)&&data.savedViews.some((value:unknown)=>
      value&&typeof value==='object'&&'filters' in value&&value.filters&&typeof value.filters==='object'&&
      'fieldFilter' in value.filters&&value.filters.fieldFilter!=null
    ))fail('사용자 정의 필드 조건을 포함한 보기는 schemaVersion 13이 필요합니다.');
    const importedViews=savedViews.validateImport(data.schemaVersion>=3?data.savedViews:[],data.projects,data.users,importedSchemas);
    const importedProjectIds = new Set((data.projects as Project[]).map(project => project.id));
    const importedViewProjects = new Map(importedViews.map(view => [view.id, view.projectId]));
    const issueBlockTargets = { hasProject: (id: string) => importedProjectIds.has(id), viewProject: (id: string) => importedViewProjects.get(id) };
    const importedCalendars=calendars.validateImport(data.schemaVersion>=5?data.calendars:[],data.projects,{legacy:data.schemaVersion<5});
    const importedArtifacts=scheduleArtifacts.validateImport(data.schemaVersion>=5?data.milestones:[],data.schemaVersion>=5?data.baselines:[],data.projects,data.users,data.issues);
    const importedAutomation=automation.validateImport(data.schemaVersion>=8?data.automationRules:[],data.projects,data.users,importedWorkflows,importedSchemas,{legacy:data.schemaVersion<8});
    if(data.schemaVersion<32&&data.issueAssignmentRules!==undefined&&(!Array.isArray(data.issueAssignmentRules)||data.issueAssignmentRules.length)){
      fail('담당자 자동 배정 규칙을 포함한 백업은 schemaVersion 32가 필요합니다.');
    }
    const importedAssignments=issueAssignments.validateImport(data.schemaVersion>=32?data.issueAssignmentRules:[],{
      projects:data.projects,users:data.users,workflows:importedWorkflows,schemas:importedSchemas,
    });
    if(data.schemaVersion<9&&['sourceImports','sourceRecords','attachmentVersions','issueRelations'].some(key=>Array.isArray(data[key])&&data[key].length))fail('원본 이관과 첨부 버전이 있는 백업은 schemaVersion 9가 필요합니다.');
    if(data.schemaVersion<16&&Array.isArray(data.attachmentVersions)&&data.attachmentVersions.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'localRevision')))fail('새 첨부 버전을 포함한 백업은 schemaVersion 16이 필요합니다.');
    const restoreAt=now();
    const importedReportLedger=data.schemaVersion>=10?reportLedger.validateRestore(data.reportingLedger,data.exportedAt,restoreAt,data.projects):{coverage:[],events:[]};
    const importedReportSnapshots=data.schemaVersion>=10?reports.validateRestore(data.reportSnapshots,data.exportedAt,data.projects,data.users):[];
    if(data.schemaVersion<11&&Array.isArray(data.worklogs)&&data.worklogs.length)fail('작업 시간 기록이 있는 백업은 schemaVersion 11이 필요합니다.');
    if(data.schemaVersion<17&&((Array.isArray(data.trashEntries)&&data.trashEntries.length)||importedReportLedger.events.some(event=>event.kind==='restored')))fail('휴지통과 복원 이력이 있는 백업은 schemaVersion 17이 필요합니다.');
    if(data.schemaVersion>=9&&(!Array.isArray(data.attachmentVersions)||data.attachmentVersions.some((value:unknown)=>!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string')))fail('첨부 버전 목록을 확인해 주세요.');
    const importedTrash=trash.validateImport(data.schemaVersion>=17?data.trashEntries:[],data);
    if(data.schemaVersion<31&&data.trashItems!==undefined&&(!Array.isArray(data.trashItems)||data.trashItems.length))fail('개별 댓글·첨부 휴지통을 포함한 백업은 schemaVersion 31이 필요합니다.');
    const importedTrashItems=trashItems.validateImport(data.schemaVersion>=31?data.trashItems:[],{...data,trash:importedTrash});
    if (data.schemaVersion < 24 && (data.gitlabLinks.some((link: { kind: string }) => link.kind === 'branch') ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.kind === 'branch')))) {
      fail('GitLab 브랜치 연결에는 schemaVersion 24 백업이 필요합니다.');
    }
    if (!data.gitlabLinks.every(isRestorableGitlabLink)) fail('GitLab 연결 데이터를 확인해 주세요.');
    if (data.schemaVersion <28 && (data.gitlabLinks.some((link:GitlabLink) => link.branchObservationSource==='sync') ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.branchObservationSource==='sync')))) {
      fail('GitLab 수동 조회로 확인한 브랜치 연결에는 schemaVersion 28 백업이 필요합니다.');
    }
    if (data.schemaVersion < 35 && (data.gitlabLinks.some((link:GitlabLink) => link.originalJiraKey !== undefined) ||
        importedTrash.some(entry => entry.gitlabLinks.some(link => link.originalJiraKey !== undefined)))) {
      fail('GitLab 연결의 Jira 원본 키를 포함한 백업은 schemaVersion 35가 필요합니다.');
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
    const effortIssues=[...(data.issues as Issue[]),...archivedIssues];
    if(data.schemaVersion<18){
      const capacities:unknown=data.workloadCapacities;
      const hasCustomCapacity=capacities!==undefined&&(!Array.isArray(capacities)||capacities.some(entry=>
        !entry||entry.defaultDailyMinutes!==DEFAULT_DAILY_WORKLOAD_MINUTES||!Array.isArray(entry.members)||entry.members.length||!Array.isArray(entry.exceptions)||entry.exceptions.length));
      if(hasCustomCapacity||effortIssues.some(issue=>issue.plannedEffortMinutes!=null))fail('계획 작업 시간과 가용 시간 설정은 schemaVersion 18이 필요합니다.');
    }
    for(const issue of effortIssues)validatePlannedEffortMinutes(issue.plannedEffortMinutes);
    const importedCapacity=workload.validateImport(data.schemaVersion>=18?data.workloadCapacities:[],data.projects,data.users,{legacy:data.schemaVersion<18});
    const importedTeamCapacity=teamCapacity.validateImport(data.teamWorkloadCapacity,data.users,{legacy:data.schemaVersion<19});
    const archiveAttachments=[...importedTrash.flatMap(entry=>entry.attachments),...importedTrashItems.flatMap(entry=>entry.itemType==='attachment'?[entry.item]:[])];
    const archiveVersions=[...importedTrash.flatMap(entry=>entry.attachmentVersions),...importedTrashItems.flatMap(entry=>entry.versions)];
    const archiveComments=[...importedTrash.flatMap(entry=>entry.comments),...importedTrashItems.flatMap(entry=>entry.itemType==='comment'?[entry.item]:[])];
    if(data.schemaVersion<33&&(
      (Array.isArray(data.sourceImports)&&data.sourceImports.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'integrity')))||
      (Array.isArray(data.sourceRecords)&&data.sourceRecords.some((row:unknown)=>row&&typeof row==='object'&&Object.hasOwn(row,'excluded')))
    ))fail('원본 무결성 기준 또는 하위 제외 기록을 포함한 백업은 schemaVersion 33이 필요합니다.');
    const importedSources=sourcePreservation.validateImport({
      imports:data.schemaVersion>=9?data.sourceImports:[], records:data.schemaVersion>=9?data.sourceRecords:[],
      versions:data.schemaVersion>=9?[...data.attachmentVersions,...archiveVersions]:[], relations:data.schemaVersion>=9?data.issueRelations:[],
    }, {users:data.users,projects:data.projects,issues:data.issues,documents:data.documents,comments:[...data.comments,...archiveComments],revisions:data.revisions,attachments:[...data.attachments,...archiveAttachments]});
    const versionById=new Map(importedSources.versions.map(version=>[version.id,version]));
    const archivedDocuments = importedTrash.filter(entry => entry.resourceType === 'document');
    for(const entry of importedTrash){
      entry.attachmentVersions=entry.attachmentVersions.map(version=>versionById.get(version.id)!);
    }
    for(const entry of importedTrashItems)if(entry.itemType==='attachment')entry.versions=entry.versions.map(version=>versionById.get(version.id)!);
    for (const entry of archivedDocuments) {
      entry.resource = importDocument(entry.resource);
      entry.revisions = entry.revisions.map(importDocument);
    }
    const revisionOwners = new Map([...importedRevisions, ...archivedDocuments.flatMap(entry => entry.revisions)].map(revision => [revision.id, revision.documentId]));
    const revisionOwner = (id: string) => revisionOwners.get(id);
    const firstDocument = importedDocuments[0];
    documentContent.validate(firstDocument?.id || uid(), firstDocument?.content || { type: 'doc', content: [{ type: 'paragraph' }] }, undefined,
      { allowMissing: true, documents: importedDocuments, issues: data.issues, issueBlockTargets, revisionOwner });
    const allImportedContent = [...importedDocuments, ...importedRevisions, ...archivedDocuments.flatMap(entry => [entry.resource, ...entry.revisions])].map(value => value.content);
    validateDocumentIssueBlocks(allImportedContent, issueBlockTargets, { allowMissing: true });
    validatePinnedDocumentRevisions(allImportedContent, revisionOwner, { allowMissing: true });
    const importedCollaboration = collaboration.validateImport(data.schemaVersion >= 3 ? data.collabStates : [], importedDocuments, issueBlockTargets, revisionOwner);
    for (const entry of archivedDocuments) {
      if (entry.collaboration) collaboration.validateImport([entry.collaboration], [entry.resource], issueBlockTargets, revisionOwner);
      if (entry.publication) [entry.publication] = documentPublication.validateRestore([entry.publication], [entry.resource], data.users, entry.revisions, data.exportedAt);
    }
    const importedWorklogs=data.schemaVersion>=11?worklogs.validateRestore(
      data.worklogs,data.projects,data.issues,data.users,data.exportedAt,data.schemaVersion>=12?importedSources.records:[],
    ):[];
    if(data.schemaVersion<14&&Array.isArray(data.documentPublications)&&data.documentPublications.length)fail('문서 검토·발행 기록을 포함한 백업은 schemaVersion 14가 필요합니다.');
    const importedPublications=data.schemaVersion>=14?documentPublication.validateRestore(
      data.documentPublications,data.documents,data.users,data.revisions,data.exportedAt,
    ):[];
    if(data.schemaVersion<15&&Array.isArray(data.teamNotifications)&&data.teamNotifications.length)fail('팀 알림을 포함한 백업은 schemaVersion 15가 필요합니다.');
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
    const subscriptionRefs={
      users:new Set((data.users as User[]).map(user=>user.id)),
      issueIds:new Set((data.issues as Issue[]).map(issue=>issue.id)),
      documentIds:new Set(importedDocuments.map(document=>document.id)),
      projectIds:new Set((data.projects as Project[]).map(project=>project.id)),
    };
    for(const entry of importedTrash) (entry.resourceType==='issue'?subscriptionRefs.issueIds:subscriptionRefs.documentIds).add(entry.resourceId);
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
      for(const entry of trash.all()){
        const versions=entry.resourceType==='issue'?previousIssues:previousDocuments;
        versions.set(entry.resourceId,Math.max(versions.get(entry.resourceId)||0,entry.resource.version));
        for(const dependency of entry.dependencies)previousDependencyVersion=Math.max(previousDependencyVersion,dependency.version??1);
      }
      for(const entry of importedTrash){
        const versions=entry.resourceType==='issue'?previousIssues:previousDocuments;
        entry.resource.version=Math.max(entry.resource.version,versions.get(entry.resourceId)||0);
      }
      const previousImports=new Map(sourcePreservation.allImports().map(value=>[value.id,value.version]));
      const previousWorklogs=worklogs.clearForRestore();
      timeReservations.clearForRestore();
      documentFollowUp.clearForImport();
      issueBulkEdit.resetForImport();
      outbound.resetForImport();
      migrations.resetForNativeImport();
      for(const table of ['automation_runs','automation_rules','automatic_schedule_previews','schedule_paste_previews','plan_schedule_previews','milestones','baselines','project_calendars','collaboration_requests','collaboration_documents','issue_schemas','workflows','saved_views','planning_items','attachments','resource_links','dependencies','comments','revisions','gitlab_links','schedule_undos','issue_sequences','activities','issues','documents','projects','users','webhook_inbox'])store.db.exec(`DELETE FROM ${table}`);
      data.users.forEach((u:any)=>store.put('users',validateUser(u)));data.projects.forEach((p:any)=>store.put('projects',validateProject(p)));
      if(!data.users.length)fail('최소 한 명의 팀원이 필요합니다.');
      notifications.restore(data.schemaVersion>=15?data.teamNotifications:[],subscriptionRefs.users);
      subscriptions.restore(data.schemaVersion>=25?data.notificationSubscriptions:[],subscriptionRefs,data.schemaVersion>=29);
      atlassianLinks.restore(data.schemaVersion>=27?data.atlassianLinks:[],subscriptionRefs);
      issueSchemas.replaceImported(importedSchemas,previousSchemas);
      workflows.replaceImported(importedWorkflows.map(w=>({...w,version:Math.max(w.version,(previousWorkflows.get(w.projectId)||0)+1)})));savedViews.replaceImported(importedViews,previousViews);
      automation.replaceImported(importedAutomation,previousAutomation);
      issueAssignments.replaceImported(importedAssignments,previousAssignments);
      planning.replaceImported(importedPlanning.items,previousPlanning);
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
      for(const d of data.documents)if(!data.revisions.some((r:any)=>r.documentId===d.id&&r.version===d.version))revision(d,d.authorId,'백업 가져오기');
      documentPublication.replaceRestored(importedPublications);
      for(const a of data.activities){get('users',a.actorId);store.put('activities',a);}
      for(const a of data.attachments){attachmentTarget(a.resourceType,a.resourceId);get('users',a.authorId);if(!validTimestamp(a.createdAt))fail('첨부파일 작성 시간을 확인해 주세요.');store.put('attachments',a);}
      for(const l of data.gitlabLinks){get('issues',l.issueId);store.put('gitlab_links',l);}
      const nextNumbers=new Map(previousSequences);
      const reserve=(projectId:string,key:string)=>{
        const number=Number(key.match(/-(\d+)$/)?.[1]??0);
        if(Number.isSafeInteger(number+1))nextNumbers.set(projectId,Math.max(nextNumbers.get(projectId)||1,number+1));
      };
      for(const issue of data.issues as Issue[])reserve(issue.projectId,issue.key);
      for(const entry of importedTrash)if(entry.resourceType==='issue')reserve(entry.resource.projectId,entry.resource.key);
      for(const event of importedReportLedger.events){const state=event.after??event.before;if(state)reserve(state.projectId,state.key);}
      for(const project of data.projects)store.db.prepare('INSERT INTO issue_sequences VALUES(?,?)').run(project.id,nextNumbers.get(project.id)||1);
      collaboration.replaceImported(importedCollaboration);
      sourcePreservation.replaceImported(liveSources,previousImports);
      gitlab.resetForImport([...data.gitlabLinks,...importedTrash.flatMap(entry=>entry.gitlabLinks)]);
      trash.replaceImported(importedTrash);
      trashItems.replaceImported(importedTrashItems);
      timeReservations.replaceRestored(importedReservations);
      reportLedger.replaceRestored(importedReportLedger,restoreAt);
      reports.replaceRestored(importedReportSnapshots);
      worklogs.replaceRestored(importedWorklogs,previousWorklogs);
      const generation=uid();store.setSetting('attachmentImportGeneration',generation);swapped=files.swapImport(staged!,generation);
    }));}catch(error){swapped?.rollback();files.cleanupStage(staged!);throw error;}
    collaboration.invalidateAll('백업 가져오기로 문서가 교체되었습니다.');
    files.cleanupStage(staged!);try{swapped?.commit();}catch{console.error('[teamspace attachments] previous upload directory cleanup needed');}
    res.json({ok:true,counts:{projects:data.projects.length,issues:data.issues.length,documents:data.documents.length,attachments:data.attachments.length,planningItems:importedPlanning.items.length,milestones:importedArtifacts.milestones.length,baselines:importedArtifacts.baselines.length}});
  });

  app.use('/api',(_req,res)=>res.status(404).json({error:'API 경로를 찾을 수 없습니다.'}));
  app.use((error:any,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof AtlassianLinkError||error instanceof AtlassianReadError)return res.status(error.status).json({error:error.message});
    if(error instanceof DocumentFollowUpError)return res.status(error.status).json({error:error.message});
    if(error instanceof TimeReservationError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof IssueAssignmentRulesError||error instanceof IssueBulkEditError)return res.status(error.status).json({error:error.message,details:error.details});
    if(error instanceof ApiError||error instanceof WorkflowError||error instanceof SavedViewError||error instanceof CollaborationError||error instanceof PlanningError||error instanceof ApiKeyError||error instanceof CalendarError||error instanceof AutomaticScheduleError||error instanceof ScheduleAnalysisError||error instanceof SchedulePasteError||error instanceof PlanScheduleShiftError||error instanceof ScheduleArtifactError||error instanceof IssueSchemaError||error instanceof IssueOrderError||error instanceof DocumentContentError||error instanceof AutomationError||error instanceof OutboundWebhookError||error instanceof GitlabIntegrationError||error instanceof LegacyImportError||error instanceof LegacyArchiveError||error instanceof SourcePreservationError||error instanceof ReportingLedgerError||error instanceof ReportingMetricsError||error instanceof ReportingError||error instanceof WorklogError||error instanceof IssueFieldFilterError||error instanceof FieldBreakdownError||error instanceof DocumentPublicationError||error instanceof TeamNotificationError||error instanceof NotificationSubscriptionError||error instanceof AttachmentVersionError||error instanceof TrashError||error instanceof WorkloadError)return res.status(error.status).json({error:error.message,details:'details'in error?error.details:undefined});
    if(error?.type==='entity.parse.failed')return res.status(400).json({error:'JSON 형식이 올바르지 않습니다.'});
    if(error?.type==='entity.too.large')return res.status(413).json({error:_req.originalUrl.startsWith('/api/attachments')?'첨부파일은 20MiB 이하여야 합니다.':_req.originalUrl.startsWith('/api/integrations/gitlab/webhook')?'GitLab 웹훅 본문은 2MiB 이하여야 합니다.':'요청 데이터는 64MiB 이하여야 합니다.'});
    if(String(error?.code).startsWith('SQLITE_CONSTRAINT')||/UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint/.test(String(error?.message)))return res.status(409).json({error:'이미 사용 중인 키·이메일·관계이거나 참조가 올바르지 않습니다.'});
    console.error('[teamspace API]',error?.message||error);return res.status(500).json({error:'요청을 처리하지 못했습니다.'});
  });
  return {app,attachWebSocket:(server:import('node:http').Server,authorize?:CollaborationUpgradeGuard)=>collaboration.attachWebSocket(server,authorize),close:()=>{migrations.close();legacyImport.close();outbound.close();collaboration.close();reportLedger.close();stopIssueWatch();store.db.close();}};
}
