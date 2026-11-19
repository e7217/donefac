import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AttachmentFiles, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_EXPORT_BYTES, safeFilename, sniffMime, hash } from './attachments.js';
import { Store } from './store.js';
import { seed, plain } from './seed.js';
import { WorkflowService, WorkflowError } from './workflows.js';
import { SavedViewService, SavedViewError } from './saved-views.js';
import { CollaborationService, CollaborationError } from './collaboration.js';
import { PlanningService, PlanningError } from './planning.js';
import { ApiKeyService, ApiKeyError } from './api-keys.js';
import { CalendarService, CalendarError } from './calendars.js';
import { AutomaticScheduleService, AutomaticScheduleError } from './automatic-schedule.js';
import { SchedulePasteService, SchedulePasteError } from './schedule-paste.js';
import { DocumentContentService, DocumentContentError, normalizeDocumentContent, hasVersionTwoNodes } from './document-content.js';
import { ScheduleArtifactService, ScheduleArtifactError } from './schedule-artifacts.js';
import { IssueSchemaService, IssueSchemaError } from './issue-schema.js';
import { AutomationService, AutomationError } from './automation.js';
import { OutboundWebhookService, OutboundWebhookError } from './outbound-webhooks.js';
import { GitlabIntegrationService, GitlabIntegrationError } from './gitlab-integration.js';
import { LegacyImportService } from './legacy-import.js';
import { LegacyImportError } from './legacy-import-model.js';
import { MigrationService } from './migration.js';
import { SourcePreservationService, SourcePreservationError } from './source-preservation.js';
import { LegacyArchiveError } from './legacy-import-archive.js';
import { ReportingLedger, ReportingLedgerError } from './reporting-ledger.js';
import { ReportingMetricsError } from './reporting-metrics.js';
import { ReportingService, ReportingError } from './reporting.js';
import { WorklogService, WorklogError } from './worklogs.js';
import { createCalendarMath } from '../shared/calendar.js';
import { issueSearchText } from '../shared/issue-schema.js';
import { createIssueFieldMatcher, IssueFieldFilterError, parseIssueFieldFilter } from '../shared/issue-field-filter.js';
import { PRIORITY, type Issue, type DocPage, type RichContent, type WorkspaceSnapshot, type ScheduleChange, type SchedulePreview, type Attachment, type AttachmentVersion, type IssueRelation, type User, type Dependency } from '../shared/types.js';

class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
const fail = (message: string, status = 400, details?: unknown): never => { throw new ApiError(status, message, details); };
const uid = () => randomUUID();
const now = () => new Date().toISOString();
const tables = { projects: 'projects', users: 'users', issues: 'issues', documents: 'documents', dependencies: 'dependencies', resourceLinks: 'resource_links', activities: 'activities', gitlabLinks: 'gitlab_links' } as const;
const text = (v: unknown, label: string, max = 500): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail(`${label}을(를) 확인해 주세요.`);
const nullableText = (v: unknown, label: string, max = 500) => v === null || v === '' || v === undefined ? null : text(v, label, max);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const date = (v: unknown, label: string) => v === null || v === '' || v === undefined ? null : isDate(v) ? v : fail(`${label}: YYYY-MM-DD 형식의 날짜가 필요합니다.`);
function dateRange(start: string | null, end: string | null) { if (start && end && start > end) fail('종료일은 시작일보다 빠를 수 없습니다.'); }
function checkVersion(current: {version: number}, value: unknown) { if (!Number.isInteger(value)) fail('expectedVersion이 필요합니다.'); if (current.version !== value) fail('다른 작업자가 변경했습니다. 새로고침 후 다시 시도해 주세요.',409,{currentVersion:current.version}); }
function rich(value: unknown): RichContent { return normalizeDocumentContent(value).content; }
function shiftDate(value: string, days: number, working: boolean): string {
  const d = new Date(`${value}T00:00:00Z`), sign = Math.sign(days); let remain = Math.abs(days);
  while (remain) { d.setUTCDate(d.getUTCDate()+sign); if (!working || ![0,6].includes(d.getUTCDay())) remain--; }
  return d.toISOString().slice(0,10);
}

export function createApp(options: {dataDir?: string; seed?: boolean; outboundWorker?: boolean} = {}) {
  const dataDir=options.dataDir || process.env.TEAMSPACE_DATA_DIR || resolve('data');
  const store = new Store(dataDir);
  const files = new AttachmentFiles(dataDir);
  files.recover(store.setting('attachmentImportGeneration'));
  if (options.seed !== false) seed(store);
  const issueSchemas=new IssueSchemaService(store);
  const workflows=new WorkflowService(store,issueSchemas),savedViews=new SavedViewService(store,issueSchemas);
  const documentContent=new DocumentContentService(store);
  const collaboration=new CollaborationService(store,documentContent);
  const planning=new PlanningService(store);planning.migrateLegacyIssues();
  const reportLedger=new ReportingLedger(store,projectId=>workflows.get(projectId));
  reportLedger.start();
  const reports=new ReportingService(store,reportLedger);
  const worklogs=new WorklogService(store);
  const apiKeys=new ApiKeyService(store);
  const calendars=new CalendarService(store),scheduleArtifacts=new ScheduleArtifactService(store);
  const automaticSchedule=new AutomaticScheduleService(store,calendars);
  const schedulePaste=new SchedulePasteService(store);
  const legacyImport=new LegacyImportService(store,dataDir);
  const sourcePreservation=new SourcePreservationService(store);
  const migrations=new MigrationService(store,dataDir,legacyImport,sourcePreservation);
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
  app.use((req,_res,next)=>{const webhook=req.path==='/api/integrations/gitlab/webhook';const requested=req.header('X-Actor-Id')||req.body?.actorId;const actorId=webhook?null:(typeof requested==='string'?requested:store.all<any>('users')[0]?.id||null);store.withMutationContext({actorId,origin:webhook?'gitlab':'user'},next);});
  const attachmentRows=(type:string,id:string)=>store.all<Attachment>('attachments').filter(a=>a.resourceType===type&&a.resourceId===id);
  const attachmentTarget=(type:unknown,id:unknown)=>{if(!['issue','document'].includes(type as string)||typeof id!=='string')fail('첨부파일 대상을 확인해 주세요.');get(type==='issue'?'issues':'documents',id);};
  const attachmentFiles=(rows:Attachment[])=>[...rows,...sourcePreservation.versionsForAttachments(rows.map(row=>row.id))];
  const deleteAttachmentRows=(type:string,id:string)=>{const rows=attachmentFiles(attachmentRows(type,id));store.db.prepare('DELETE FROM attachments WHERE resource_type=? AND resource_id=?').run(type,id);return rows;};
  const cleanupAttachments=(rows:Attachment[])=>{for(const id of new Set(rows.map(row=>row.id)))try{files.remove(id);}catch{console.error('[teamspace attachments] orphan cleanup needed:',id);}};
  const snapshot = (): WorkspaceSnapshot => ({...Object.fromEntries(Object.entries(tables).map(([key,table])=>[key,store.all(table)])),workflows:workflows.snapshot(),savedViews:savedViews.all(),planningItems:planning.all(),calendars:calendars.snapshot(),milestones:scheduleArtifacts.allMilestones(),baselines:scheduleArtifacts.allBaselines(),issueSchemas:issueSchemas.snapshot()}) as unknown as WorkspaceSnapshot;
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
  const validateDependency = (d: any, current: any[] = store.all('dependencies')) => {
    if(d.predecessorId===d.successorId)fail('자기 자신에게 의존할 수 없습니다.');
    const a=get<Issue>('issues',d.predecessorId),b=get<Issue>('issues',d.successorId);
    if(a.projectId!==b.projectId)fail('의존성은 같은 프로젝트 안에서 연결해 주세요.');
    if(d.type!=='FS'||!Number.isInteger(d.lagDays)||Math.abs(d.lagDays)>3650)fail('FS 의존성과 정수 지연일이 필요합니다.');
    const edges=current.filter(x=>x.id!==d.id);
    if(edges.some(x=>x.predecessorId===d.predecessorId&&x.successorId===d.successorId))fail('이미 연결된 의존성입니다.',409);
    const todo=[d.successorId],seen=new Set();
    while(todo.length){const id=todo.pop();if(id===d.predecessorId)fail('의존성에 순환 관계가 생깁니다.');if(seen.has(id))continue;seen.add(id);edges.filter(x=>x.predecessorId===id).forEach(x=>todo.push(x.successorId));}
  };
  const scheduleWarnings = (issues: Issue[], dependencies=store.all<Dependency>('dependencies')) => {
    const map=new Map(issues.map(i=>[i.id,i])); const warnings:string[]=[];const mathCache=new Map<string,ReturnType<typeof createCalendarMath>>();
    const mathFor=(projectId:string)=>{let math=mathCache.get(projectId);if(!math){math=createCalendarMath(calendars.get(projectId));mathCache.set(projectId,math);}return math;};
    for(const dep of dependencies){const a=map.get(dep.predecessorId),b=map.get(dep.successorId);if(a?.endDate&&b?.startDate){try{if(b.startDate<mathFor(a.projectId).shift(a.endDate,dep.lagDays+1))warnings.push(`${a.key} → ${b.key}: 선행 업무 종료 후 ${dep.lagDays}근무일 간격 조건과 일정이 맞지 않습니다. 수동 일정은 자동 이동하지 않습니다.`);}catch{warnings.push(`${a.key} → ${b.key}: 달력 계산 범위를 확인해 주세요. 수동 일정은 자동 이동하지 않습니다.`);}}}
    return warnings;
  };
  /** Caller owns the transaction, shared by manual edits and guarded proposals. */
  const commitScheduleChanges=(req:Request,changes:unknown,dependencies?:Dependency[])=>{
    if(!Array.isArray(changes)||!changes.length||changes.length>1000)return fail('변경할 일정을 선택해 주세요.');
    const seen=new Set<string>(),records:any[]=[],updated:Issue[]=[];
    for(const c of changes){
      if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.id!=='string')fail('일정 변경 형식을 확인해 주세요.');
      if(seen.has(c.id))fail('중복된 티켓입니다.');seen.add(c.id);
      const old=get<Issue>('issues',c.id);checkVersion(old,c.expectedVersion);
      if(!Object.hasOwn(c,'startDate')||!Object.hasOwn(c,'endDate'))fail('시작일과 종료일 값을 지정해 주세요.');
      const i=validateIssue({...old,startDate:date(c.startDate,'시작일'),endDate:date(c.endDate,'종료일'),version:old.version+1,updatedAt:now()},old,{checkTransition:false});
      records.push({id:i.id,appliedVersion:i.version,startDate:old.startDate,endDate:old.endDate});store.put('issues',i);
      activity(req,'issue',i.id,'일정 변경',`${old.startDate||'미정'} ~ ${old.endDate||'미정'} → ${i.startDate||'미정'} ~ ${i.endDate||'미정'}`);updated.push(i);
    }
    const undoId=uid();store.put('schedule_undos',{id:undoId,records,used:false});activity(req,'schedule',undoId,'일정 일괄 변경',`${updated.length}개 티켓`);
    const projectIds=new Set(updated.map(issue=>issue.projectId));
    return{undoId,updated,warnings:scheduleWarnings(store.all<Issue>('issues').filter(issue=>projectIds.has(issue.projectId)),dependencies)};
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
  const automation=new AutomationService(store,{
    getGitlabSettings:()=>gitlab.settings(),
    prepareChange:(before,status)=>{const next=validateIssue({...before,status,version:before.version+1,updatedAt:now()},before);next.completedAt=done(next)?(before.completedAt||now()):null;return next;},
    commitChange:(rule,before,next,event)=>{store.put('issues',next);store.put('activities',{id:uid(),resourceType:'issue',resourceId:next.id,actorId:rule.actorId,action:'GitLab 자동화 상태 변경',detail:`${before.status} → ${next.status} · ${rule.name} · ${event.id}`,createdAt:now()});},
  });
  const gitlab:GitlabIntegrationService=new GitlabIntegrationService(store,{processEvent:event=>automation.processEvent(event),onConnectionChanged:(previous,next)=>automation.onConnectionChanged(previous,next)});
  const outbound=new OutboundWebhookService(store,{autoStart:options.outboundWorker!==false});
  legacyImport.registerRoutes(app,{actor,activity});
  sourcePreservation.registerRoutes(app);
  migrations.registerRoutes(app, {
    actor,
    persistCanonical(value, req) {
      const schemas = issueSchemas.validateImport(value.issueSchemas, value.projects, value.issues, {users:store.all<User>('users')});
      const importedWorkflows = workflows.validateImport(value.workflows, value.projects, value.issues, schemas);
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
    },
  });
  automation.registerRoutes(app,{actor,activity});outbound.registerRoutes(app,{actor,activity});gitlab.registerRoutes(app,{actor,activity});
  workflows.registerRoutes(app,{actor,activity});savedViews.registerRoutes(app,{actor,activity});
  issueSchemas.registerRoutes(app,{actor,activity});
  planning.registerRoutes(app,{actor,activity,validateIssue});apiKeys.registerManagementRoutes(app,{actor,activity});
  calendars.registerRoutes(app,{actor,activity});
  automaticSchedule.registerRoutes(app,{actor,commitChanges:commitScheduleChanges});
  schedulePaste.registerRoutes(app,{
    actor,
    versions:projectId=>({
      calendar:calendars.get(projectId).version,
      workflow:workflows.get(projectId).version,
      schema:issueSchemas.get(projectId).version,
    }),
    validateChange(issue,change) {
      try {
        validateIssue({...issue,startDate:change.startDate,endDate:change.endDate},issue,{checkTransition:false});
        return null;
      } catch (error) {
        if (error instanceof ApiError||error instanceof WorkflowError||error instanceof IssueSchemaError||error instanceof PlanningError) {
          if (error.status<500) return error.message;
        }
        throw error;
      }
    },
    warnings:scheduleWarnings,
    commitChanges:commitScheduleChanges,
  });
  scheduleArtifacts.registerRoutes(app,{actor,activity,getCalendar:projectId=>calendars.get(projectId)});

  app.get('/api/health',(_req,res)=>res.json({ok:true,storage:'sqlite',version:'0.1.0'}));
  app.get('/api/workspace',(_req,res)=>res.json(snapshot()));
  app.post('/api/users',(req,res)=>{const u=validateUser({id:uid(),name:req.body.name,email:req.body.email,color:req.body.color||'#5879ed'});store.put('users',u);res.status(201).json(u);});
  app.patch('/api/users/:id',(req,res)=>{const u=get('users',req.params.id);const updated=validateUser({...u,...Object.fromEntries(['name','email','color'].filter(k=>k in req.body).map(k=>[k,req.body[k]]))});store.transaction(()=>{store.put('users',updated);activity(req,'user',u.id,'팀원 정보 변경');});res.json(updated);});
  app.post('/api/projects',(req,res)=>{const p=validateProject({id:uid(),key:req.body.key,name:req.body.name,description:req.body.description||'',color:req.body.color||'#5879ed',createdAt:now()});store.transaction(()=>{store.put('projects',p);store.db.prepare('INSERT INTO issue_sequences VALUES(?,1)').run(p.id);activity(req,'project',p.id,'프로젝트 생성',p.name);});res.status(201).json(p);});
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
  app.post('/api/issues',(req,res)=>{
    const timestamp=now();const fields=['projectId','title','description','type','status','priority','assigneeId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','cycle','module','release','customFields'];
    const activeTypes=issueSchemas.get(text(req.body.projectId,'프로젝트',200)).issueTypes.filter(type=>!type.archived);
    const i:Issue={id:uid(),key:'',projectId:'',title:'',description:'',type:activeTypes.find(type=>type.id==='작업')?.id||activeTypes[0].id,status:workflows.get(req.body.projectId).initialStatusId,priority:'medium',assigneeId:null,collaboratorIds:[],parentId:null,labels:[],startDate:null,endDate:null,dueDate:null,estimate:null,cycle:null,module:null,release:null,version:1,createdAt:timestamp,updatedAt:timestamp,completedAt:null,...Object.fromEntries(fields.filter(k=>k in req.body).map(k=>[k,req.body[k]]))};
    store.transaction(()=>{Object.assign(i,planning.resolveIssueFields(req.body,i.projectId));validateIssue(i);const p=get('projects',i.projectId);const row=store.db.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(i.projectId) as any;const num=row?.next_number||1;i.key=`${p.key}-${num}`;store.db.prepare('INSERT INTO issue_sequences VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET next_number=excluded.next_number').run(i.projectId,num+1);if(done(i))i.completedAt=timestamp;store.put('issues',i);activity(req,'issue',i.id,'티켓 생성',`${i.key} ${i.title}`);});res.status(201).json(i);
  });
  app.patch('/api/issues/:id',(req,res)=>{
    const updated=store.transaction(()=>{const old=get<Issue>('issues',req.params.id);checkVersion(old,req.body.expectedVersion);if(req.body.projectId&&req.body.projectId!==old.projectId)fail('프로젝트 이동은 아직 지원하지 않습니다.');const fields=['title','description','type','status','priority','assigneeId','collaboratorIds','parentId','labels','startDate','endDate','dueDate','estimate','cycle','module','release','cycleId','moduleId','releaseId','customFields'];const i=validateIssue({...old,...Object.fromEntries(fields.filter(k=>k in req.body).map(k=>[k,req.body[k]])),...planning.resolveIssueFields(req.body,old.projectId,old),version:old.version+1,updatedAt:now()},old);i.completedAt=done(i)?(old.completedAt||now()):null;store.put('issues',i);activity(req,'issue',i.id,'티켓 변경',`${i.key}: ${fields.filter(k=>k in req.body).join(', ')}`);return i;});res.json(updated);
  });
  app.delete('/api/issues/:id',(req,res)=>{const cleanup:Attachment[]=[];store.transaction(()=>{const i=get<Issue>('issues',req.params.id);const v=req.body?.expectedVersion??req.query.expectedVersion;if(v!==undefined)checkVersion(i,Number(v));if(store.all<Issue>('issues').some(x=>x.parentId===i.id))fail('하위 티켓을 먼저 이동하거나 삭제해 주세요.',409);store.db.prepare('DELETE FROM comments WHERE resource_type=? AND resource_id=?').run('issue',i.id);cleanup.push(...deleteAttachmentRows('issue',i.id));for(const milestone of scheduleArtifacts.detachIssue(i.id))activity(req,'milestone',milestone.id,'연결 업무 삭제',`${i.key} 연결 해제`);store.remove('issues',i.id);activity(req,'issue',i.id,'티켓 삭제',i.key);});cleanupAttachments(cleanup);res.json({ok:true});});
  app.post('/api/documents',(req,res)=>{const timestamp=now(),authorId=actor(req);const d:DocPage={id:uid(),projectId:req.body.projectId??null,parentId:req.body.parentId??null,title:req.body.title,content:Object.hasOwn(req.body,'content')?req.body.content:{type:'doc',content:[{type:'paragraph'}]},plainText:'',icon:req.body.icon||'📄',status:req.body.status||'draft',version:1,authorId,createdAt:timestamp,updatedAt:timestamp};store.transaction(()=>{validateDocument(d);store.put('documents',d);revision(d,authorId,'최초 작성');activity(req,'document',d.id,'문서 생성',d.title);});res.status(201).json(d);});
  app.patch('/api/documents/:id',(req,res)=>{
    const bodyChanged=Object.hasOwn(req.body,'content');
    const updated=store.transaction(()=>{
      const old=get<DocPage>('documents',req.params.id);checkVersion(old,req.body.expectedVersion);
      const fields=['projectId','parentId','title','content','icon','status'];
      let d=validateDocument({...old,...Object.fromEntries(fields.filter(k=>k in req.body).map(k=>[k,req.body[k]])),version:old.version+1,updatedAt:now()},old);
      if(d.projectId!==old.projectId&&store.all<DocPage>('documents').some(x=>x.parentId===d.id))fail('하위 문서를 먼저 이동해 주세요.');
      store.put('documents',d);if(bodyChanged)d=collaboration.replaceBody(d);else{d=collaboration.deriveSnapshot(d);store.put('documents',d);}
      revision(d,actor(req),nullableText(req.body.summary,'변경 설명',500)||'문서 편집');activity(req,'document',d.id,'문서 변경',d.title);return d;
    });
    if(bodyChanged)collaboration.reset(updated.id,'문서 본문이 교체되었습니다.');else collaboration.notifyMetadata(updated.id);
    res.json(updated);
  });
  app.delete('/api/documents/:id',(req,res)=>{const cleanup:Attachment[]=[];store.transaction(()=>{const d=get<DocPage>('documents',req.params.id);const v=req.body?.expectedVersion??req.query.expectedVersion;if(v!==undefined)checkVersion(d,Number(v));if(store.all<DocPage>('documents').some(x=>x.parentId===d.id))fail('하위 문서를 먼저 이동하거나 삭제해 주세요.',409);store.db.prepare('DELETE FROM comments WHERE resource_type=? AND resource_id=?').run('document',d.id);cleanup.push(...deleteAttachmentRows('document',d.id));store.remove('documents',d.id);activity(req,'document',d.id,'문서 삭제',d.title);});collaboration.reset(String(req.params.id),'문서가 삭제되었습니다.');cleanupAttachments(cleanup);res.json({ok:true});});
  app.get('/api/documents/:id/revisions',(req,res)=>{get('documents',req.params.id);res.json(store.all<any>('revisions').filter(r=>r.documentId===req.params.id).sort((a,b)=>b.version-a.version));});
  app.post('/api/documents/:id/restore',(req,res)=>{
    const updated=store.transaction(()=>{const old=get<DocPage>('documents',req.params.id);checkVersion(old,req.body.expectedVersion);const r=get('revisions',req.body.revisionId);if(r.documentId!==old.id)fail('이 문서의 버전이 아닙니다.');let d=validateDocument({...old,title:r.title,content:r.content,plainText:r.plainText,version:old.version+1,updatedAt:now()},old,{allowMissing:true});store.put('documents',d);d=collaboration.replaceBody(d,{allowMissing:true});revision(d,actor(req),`버전 ${r.version}에서 복구`);activity(req,'document',d.id,'문서 복구',`버전 ${r.version} → ${d.version}`);return d;});
    collaboration.reset(updated.id,'문서 이력에서 복구되었습니다.');res.json(updated);
  });
  app.get('/api/documents/:id/collaboration',(req,res)=>res.json(collaboration.session(String(req.params.id))));
  app.post('/api/documents/:id/collaboration/enable',(req,res)=>res.json(collaboration.enable(String(req.params.id),req.body.expectedVersion,actor(req))));
  app.post('/api/documents/:id/checkpoint',(req,res)=>res.json(collaboration.checkpoint(String(req.params.id),actor(req),req.body.expectedVersion,req.body.summary)));
  app.get('/api/comments',(req,res)=>{const type=req.query.resourceType,id=req.query.resourceId;if(!['issue','document'].includes(type as string)||typeof id!=='string')fail('댓글 대상을 확인해 주세요.');get(type==='issue'?'issues':'documents',id);res.json(store.all<any>('comments').filter(c=>c.resourceType===type&&c.resourceId===id));});
  app.post('/api/comments',(req,res)=>{const {resourceType,resourceId}=req.body;if(!['issue','document'].includes(resourceType))fail('댓글 대상을 확인해 주세요.');get(resourceType==='issue'?'issues':'documents',resourceId);const c={id:uid(),resourceType,resourceId,authorId:actor(req),body:text(req.body.body,'댓글',20000),createdAt:now()};store.transaction(()=>{store.put('comments',c);activity(req,resourceType,resourceId,'댓글 작성',c.body.slice(0,100));});res.status(201).json(c);});
  app.get('/api/attachments',(req,res)=>{
    attachmentTarget(req.query.resourceType,req.query.resourceId);
    const rows=attachmentRows(req.query.resourceType as string,req.query.resourceId as string);
    const count=store.db.prepare('SELECT COUNT(*) AS count FROM attachment_versions WHERE attachment_id=?');
    res.json(rows.map(row=>({...row,versionCount:Number(count.get(row.id)?.count||0)})));
  });
  app.post('/api/attachments',(req,res)=>{
    attachmentTarget(req.query.resourceType,req.query.resourceId);
    let filename:string;try{filename=safeFilename(req.query.filename);}catch(error){fail((error as Error).message);}
    if(!Buffer.isBuffer(req.body)||!req.body.length)fail('비어 있지 않은 파일이 필요합니다.');
    if(req.body.length>MAX_FILE_BYTES)fail('첨부파일은 20MiB 이하여야 합니다.',413);
    const bytes=req.body as Buffer;
    const a:Attachment={id:uid(),resourceType:req.query.resourceType as 'issue'|'document',resourceId:req.query.resourceId as string,filename:filename!,mimeType:sniffMime(bytes),size:bytes.length,sha256:hash(bytes),authorId:actor(req),createdAt:now()};
    files.write(a.id,bytes);try{store.transaction(()=>{store.put('attachments',a);activity(req,a.resourceType,a.resourceId,'파일 첨부',a.filename);});}catch(error){files.remove(a.id);throw error;}
    res.status(201).json(a);
  });
  const serveAttachment=(a:Attachment,req:Request,res:Response)=>{
    let bytes:Buffer;
    try{bytes=files.read(a);}catch{fail('첨부파일을 읽거나 무결성을 확인하지 못했습니다.',503);}
    const inline=req.query.inline==='1';if(inline&&!['image/png','image/jpeg','image/gif','image/webp'].includes(sniffMime(bytes!)))fail('이 파일 형식은 인라인으로 표시할 수 없습니다.',415);
    const encoded=encodeURIComponent(a.filename).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({'Content-Type':inline?sniffMime(bytes!):'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename="download"; filename*=UTF-8''${encoded}`,'Content-Length':String(bytes!.length),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-cache','ETag':`"${a.sha256}"`});res.end(bytes!);
  };
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
  app.delete('/api/attachments/:id',(req,res)=>{const a=get<Attachment>('attachments',req.params.id);const rows=store.transaction(()=>{const rows=attachmentFiles([a]);store.remove('attachments',a.id);activity(req,a.resourceType,a.resourceId,'첨부파일 삭제',a.filename);return rows;});cleanupAttachments(rows);res.json({ok:true});});
  app.post('/api/resource-links',(req,res)=>{get('issues',req.body.issueId);get('documents',req.body.documentId);const l={id:uid(),issueId:req.body.issueId,documentId:req.body.documentId,kind:nullableText(req.body.kind,'관계',80)||'관련 문서'};store.transaction(()=>{store.put('resource_links',l);activity(req,'issue',l.issueId,'문서 연결');});res.status(201).json(l);});
  app.delete('/api/resource-links/:id',(req,res)=>{const l=get('resource_links',req.params.id);store.transaction(()=>{store.remove('resource_links',l.id);activity(req,'issue',l.issueId,'문서 연결 해제');});res.json({ok:true});});
  app.post('/api/dependencies',(req,res)=>{const d={id:uid(),predecessorId:req.body.predecessorId,successorId:req.body.successorId,type:'FS',lagDays:req.body.lagDays??0};store.transaction(()=>{validateDependency(d);store.put('dependencies',d);activity(req,'issue',d.successorId,'선행 업무 연결',get<Issue>('issues',d.predecessorId).key);});res.status(201).json(d);});
  app.delete('/api/dependencies/:id',(req,res)=>{const d=get('dependencies',req.params.id);store.transaction(()=>{store.remove('dependencies',d.id);activity(req,'issue',d.successorId,'선행 업무 연결 해제');});res.json({ok:true});});
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
  app.post('/api/schedule/undo',(req,res)=>{const result=store.transaction(()=>{const record=get('schedule_undos',req.body.undoId);if(record.used)fail('이미 되돌린 작업입니다.',409);for(const r of record.records)checkVersion(get('issues',r.id),r.appliedVersion);const updated=record.records.map((r:any)=>{const old=get<Issue>('issues',r.id);const i=validateIssue({...old,startDate:r.startDate,endDate:r.endDate,version:old.version+1,updatedAt:now()},old,{checkTransition:false});store.put('issues',i);activity(req,'issue',i.id,'일정 되돌리기',`${old.startDate||'미정'} ~ ${old.endDate||'미정'} → ${i.startDate||'미정'} ~ ${i.endDate||'미정'}`);return i;});store.put('schedule_undos',{...record,used:true});activity(req,'schedule',record.id,'일정 변경 되돌리기',`${updated.length}개 티켓`);return{updated,warnings:scheduleWarnings(store.all<Issue>('issues').filter(issue=>updated.some((changed:Issue)=>changed.projectId===issue.projectId)))};});res.json(result);});
  app.get('/api/search',(req,res)=>{const q=String(req.query.q||'').trim().toLocaleLowerCase();if(q.length>500)fail('검색어가 너무 깁니다.');const searchData={issueSchemas:issueSchemas.snapshot(),users:store.all<import('../shared/types.js').User>('users')};res.json({issues:store.all<Issue>('issues').filter(i=>issueSearchText(searchData,i).toLocaleLowerCase().includes(q)),documents:store.all<DocPage>('documents').filter(d=>`${d.title} ${d.plainText}`.toLocaleLowerCase().includes(q))});});
  app.get('/api/export',(_req,res)=>{
    const attachments=store.all<Attachment>('attachments');
    const attachmentVersions=sourcePreservation.allVersions();
    const binaries=[...new Map([...attachments,...attachmentVersions].map(file=>[file.id,file])).values()];
    const exportedAt=now();
    const payload={schemaVersion:13,worklogs:worklogs.all(),reportingLedger:reportLedger.exportData(exportedAt),reportSnapshots:reports.all(),automationRules:automation.all(),collabStates:collaboration.exportStates(),exportedAt,...snapshot(),comments:store.all('comments'),revisions:store.all('revisions'),attachments,attachmentContents:[] as {id:string;data:string}[],attachmentVersions,sourceImports:sourcePreservation.allImports(),sourceRecords:sourcePreservation.allRecords(),issueRelations:sourcePreservation.allRelations()};
    const estimated=Buffer.byteLength(JSON.stringify(payload))+binaries.reduce((sum,a)=>sum+Math.ceil(a.size/3)*4+100,0);
    if(estimated>MAX_EXPORT_BYTES)fail('첨부파일을 포함한 전체 내보내기 파일은 64MiB 미만이어야 합니다. 운영 파일 백업을 사용해 주세요.',413);
    try{payload.attachmentContents=binaries.map(a=>({id:a.id,data:files.read(a).toString('base64')}));}catch{fail('첨부파일을 읽거나 무결성을 확인하지 못해 내보내기를 중단했습니다.',503);}
    const serialized=JSON.stringify(payload);if(Buffer.byteLength(serialized)>MAX_EXPORT_BYTES)fail('내보내기 파일은 64MiB 미만이어야 합니다.',413);
    res.type('application/json').send(serialized);
  });
  app.post('/api/import',(req,res)=>{
    const data=req.body.data;if(!data||![1,2,3,4,5,6,7,8,9,10,11,12,13].includes(data.schemaVersion))fail('지원하는 Teamspace 내보내기 파일(schemaVersion 1~13)이 필요합니다.');
    if(data.schemaVersion===1){if(data.attachments?.length||data.attachmentContents?.length)fail('첨부파일이 있는 데이터는 schemaVersion 2가 필요합니다.');data.attachments=[];data.attachmentContents=[];}
    const expected=[...Object.keys(tables),'comments','revisions','attachments','attachmentContents'];
    for(const key of expected){if(!Array.isArray(data[key])||data[key].length>100000)fail(`${key} 데이터가 올바르지 않습니다.`);const ids=new Set();for(const x of data[key]){if(!x||typeof x.id!=='string'||!x.id||ids.has(x.id))fail(`${key}에 잘못되거나 중복된 ID가 있습니다.`);ids.add(x.id);}}
    if(data.schemaVersion<7)for(const document of [...data.documents,...data.revisions]){const content=rich(document.content);if(hasVersionTwoNodes(content))fail('참조·포함·접기 블록은 schemaVersion 7 백업이 필요합니다.');}
    const importedPlanning=planning.prepareImport(data.schemaVersion>=4?data.planningItems:[],data.projects,data.users,data.issues,{legacy:data.schemaVersion<4});
    data.issues=importedPlanning.issues;
    data.documents=data.documents.map((document:DocPage)=>({...document,...documentContent.normalize(document.content)}));
    const firstDocument=data.documents[0] as DocPage|undefined;documentContent.validate(firstDocument?.id||uid(),firstDocument?.content||{type:'doc',content:[{type:'paragraph'}]},undefined,{allowMissing:true,documents:data.documents,issues:data.issues});
    const importedCollaboration=collaboration.validateImport(data.schemaVersion>=3?data.collabStates:[],data.documents);
    const importedSchemas=issueSchemas.validateImport(data.schemaVersion>=6?data.issueSchemas:[],data.projects,data.issues,{legacy:data.schemaVersion<6,users:data.users});
    const importedWorkflows=workflows.validateImport(data.schemaVersion>=3?data.workflows:[],data.projects,data.issues,importedSchemas);
    if(data.schemaVersion<13&&Array.isArray(data.savedViews)&&data.savedViews.some((value:unknown)=>
      value&&typeof value==='object'&&'filters' in value&&value.filters&&typeof value.filters==='object'&&
      'fieldFilter' in value.filters&&value.filters.fieldFilter!=null
    ))fail('사용자 정의 필드 조건을 포함한 보기는 schemaVersion 13이 필요합니다.');
    const importedViews=savedViews.validateImport(data.schemaVersion>=3?data.savedViews:[],data.projects,data.users,importedSchemas);
    const importedCalendars=calendars.validateImport(data.schemaVersion>=5?data.calendars:[],data.projects,{legacy:data.schemaVersion<5});
    const importedArtifacts=scheduleArtifacts.validateImport(data.schemaVersion>=5?data.milestones:[],data.schemaVersion>=5?data.baselines:[],data.projects,data.users,data.issues);
    const importedAutomation=automation.validateImport(data.schemaVersion>=8?data.automationRules:[],data.projects,data.users,importedWorkflows,importedSchemas,{legacy:data.schemaVersion<8});
    if(data.schemaVersion<9&&['sourceImports','sourceRecords','attachmentVersions','issueRelations'].some(key=>Array.isArray(data[key])&&data[key].length))fail('원본 이관과 첨부 버전이 있는 백업은 schemaVersion 9가 필요합니다.');
    const restoreAt=now();
    const importedReportLedger=data.schemaVersion>=10?reportLedger.validateRestore(data.reportingLedger,data.exportedAt,restoreAt,data.projects):{coverage:[],events:[]};
    const importedReportSnapshots=data.schemaVersion>=10?reports.validateRestore(data.reportSnapshots,data.exportedAt,data.projects,data.users):[];
    if(data.schemaVersion<11&&Array.isArray(data.worklogs)&&data.worklogs.length)fail('작업 시간 기록이 있는 백업은 schemaVersion 11이 필요합니다.');
    const importedSources=sourcePreservation.validateImport({
      imports:data.schemaVersion>=9?data.sourceImports:[], records:data.schemaVersion>=9?data.sourceRecords:[],
      versions:data.schemaVersion>=9?data.attachmentVersions:[], relations:data.schemaVersion>=9?data.issueRelations:[],
    }, {users:data.users,projects:data.projects,issues:data.issues,documents:data.documents,comments:data.comments,revisions:data.revisions,attachments:data.attachments});
    const importedWorklogs=data.schemaVersion>=11?worklogs.validateRestore(
      data.worklogs,data.projects,data.issues,data.users,data.exportedAt,data.schemaVersion>=12?importedSources.records:[],
    ):[];
    const binaries=[...new Map<string,Attachment>([...(data.attachments as Attachment[]),...importedSources.versions].map(file=>[file.id,file])).values()];
    let staged:string;try{staged=files.stageImport(binaries,data.attachmentContents);}catch(error){fail((error as Error).message);}
    let swapped:ReturnType<AttachmentFiles['swapImport']>|undefined;
    try{store.withMutationContext({actorId:null,origin:'import'},()=>store.transaction(()=>{
      const previousAutomation=new Map(automation.all().map(rule=>[rule.id,rule.version]));
      const previousSchemas=new Map(issueSchemas.snapshot().map(schema=>[schema.projectId,schema.version]));
      const previousWorkflows=new Map(workflows.snapshot().map(w=>[w.projectId,w.version]));
      const previousViews=new Map(savedViews.all().map(v=>[v.id,v.version]));
      const previousPlanning=new Map(planning.all().map(item=>[item.id,item.version]));
      const previousCalendars=new Map(calendars.snapshot().map(calendar=>[calendar.projectId,calendar.version]));
      const previousMilestones=new Map(scheduleArtifacts.allMilestones().map(milestone=>[milestone.id,milestone.version]));
      const previousBaselines=new Map(scheduleArtifacts.allBaselines().map(baseline=>[baseline.id,baseline.version]));
      const previousIssues=new Map(store.all<Issue>('issues').map(i=>[i.id,i.version]));
      const previousDocuments=new Map(store.all<DocPage>('documents').map(d=>[d.id,d.version]));
      const previousImports=new Map(sourcePreservation.allImports().map(value=>[value.id,value.version]));
      const previousWorklogs=worklogs.clearForRestore();
      outbound.resetForImport();gitlab.resetForImport();migrations.resetForNativeImport();
      for(const table of ['automation_runs','automation_rules','automatic_schedule_previews','schedule_paste_previews','milestones','baselines','project_calendars','collaboration_requests','collaboration_documents','issue_schemas','workflows','saved_views','planning_items','attachments','resource_links','dependencies','comments','revisions','gitlab_links','schedule_undos','issue_sequences','activities','issues','documents','projects','users','webhook_inbox'])store.db.exec(`DELETE FROM ${table}`);
      data.users.forEach((u:any)=>store.put('users',validateUser(u)));data.projects.forEach((p:any)=>store.put('projects',validateProject(p)));
      if(!data.users.length)fail('최소 한 명의 팀원이 필요합니다.');
      issueSchemas.replaceImported(importedSchemas,previousSchemas);
      workflows.replaceImported(importedWorkflows.map(w=>({...w,version:Math.max(w.version,(previousWorkflows.get(w.projectId)||0)+1)})));savedViews.replaceImported(importedViews,previousViews);
      automation.replaceImported(importedAutomation,previousAutomation);
      planning.replaceImported(importedPlanning.items,previousPlanning);
      calendars.replaceImported(importedCalendars,previousCalendars);
      scheduleArtifacts.replaceImported(importedArtifacts,previousMilestones,previousBaselines);
      for(const i of data.issues)store.put('issues',i);
      for(const d of data.documents)store.put('documents',d);
      const validTimestamp=(v:any)=>typeof v==='string'&&!Number.isNaN(Date.parse(v));
      const keys=new Set();for(const i of data.issues){validateIssue(i,undefined,{checkTransition:false,checkFields:false,allowArchivedPlanning:true,allowArchivedSchema:true});if(!Number.isInteger(i.version)||i.version<1||!validTimestamp(i.createdAt)||!validTimestamp(i.updatedAt)||typeof i.key!=='string'||keys.has(i.key))fail('티켓 버전·키·시간을 확인해 주세요.');keys.add(i.key);i.version=Math.max(i.version,(previousIssues.get(i.id)||0)+1);store.put('issues',i);}
      for(const d of data.documents){validateDocument(d,undefined,{allowMissing:true,skipReferences:true});if(!Number.isInteger(d.version)||d.version<1||!validTimestamp(d.createdAt)||!validTimestamp(d.updatedAt))fail('문서 버전·시간을 확인해 주세요.');d.version=Math.max(d.version,(previousDocuments.get(d.id)||0)+1);store.put('documents',d);}
      for(const d of data.dependencies){validateDependency(d,data.dependencies);store.put('dependencies',d);}
      for(const l of data.resourceLinks){get('issues',l.issueId);get('documents',l.documentId);text(l.kind,'관계',80);store.put('resource_links',l);}
      for(const c of data.comments){if(!['issue','document'].includes(c.resourceType))fail('잘못된 댓글 대상입니다.');get(c.resourceType==='issue'?'issues':'documents',c.resourceId);get('users',c.authorId);text(c.body,'댓글',20000);store.put('comments',c);}
      for(const r of data.revisions){get('documents',r.documentId);get('users',r.authorId);rich(r.content);if(!Number.isInteger(r.version)||r.version<1)fail('문서 이력을 확인해 주세요.');store.put('revisions',{...r,plainText:plain(r.content)});}
      for(const d of data.documents)if(!data.revisions.some((r:any)=>r.documentId===d.id&&r.version===d.version))revision(d,d.authorId,'백업 가져오기');
      for(const a of data.activities){get('users',a.actorId);store.put('activities',a);}
      for(const a of data.attachments){attachmentTarget(a.resourceType,a.resourceId);get('users',a.authorId);if(!validTimestamp(a.createdAt))fail('첨부파일 작성 시간을 확인해 주세요.');store.put('attachments',a);}
      for(const l of data.gitlabLinks){get('issues',l.issueId);if(!['merge_request','commit','pipeline'].includes(l.kind)||!Number.isInteger(l.projectId)||typeof l.webUrl!=='string'||!/^https?:\/\//.test(l.webUrl))fail('GitLab 연결 데이터를 확인해 주세요.');store.put('gitlab_links',l);}
      for(const p of data.projects){const max=Math.max(0,...data.issues.filter((i:any)=>i.projectId===p.id).map((i:any)=>{const match=i.key.match(/-(\d+)$/);return match?Number(match[1]):0;}));store.db.prepare('INSERT INTO issue_sequences VALUES(?,?)').run(p.id,max+1);}
      collaboration.replaceImported(importedCollaboration);
      sourcePreservation.replaceImported(importedSources,previousImports);
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
    if(error instanceof ApiError||error instanceof WorkflowError||error instanceof SavedViewError||error instanceof CollaborationError||error instanceof PlanningError||error instanceof ApiKeyError||error instanceof CalendarError||error instanceof AutomaticScheduleError||error instanceof SchedulePasteError||error instanceof ScheduleArtifactError||error instanceof IssueSchemaError||error instanceof DocumentContentError||error instanceof AutomationError||error instanceof OutboundWebhookError||error instanceof GitlabIntegrationError||error instanceof LegacyImportError||error instanceof LegacyArchiveError||error instanceof SourcePreservationError||error instanceof ReportingLedgerError||error instanceof ReportingMetricsError||error instanceof ReportingError||error instanceof WorklogError||error instanceof IssueFieldFilterError)return res.status(error.status).json({error:error.message,details:'details'in error?error.details:undefined});
    if(error?.type==='entity.parse.failed')return res.status(400).json({error:'JSON 형식이 올바르지 않습니다.'});
    if(error?.type==='entity.too.large')return res.status(413).json({error:_req.originalUrl.startsWith('/api/attachments')?'첨부파일은 20MiB 이하여야 합니다.':_req.originalUrl.startsWith('/api/integrations/gitlab/webhook')?'GitLab 웹훅 본문은 2MiB 이하여야 합니다.':'요청 데이터는 64MiB 이하여야 합니다.'});
    if(String(error?.code).startsWith('SQLITE_CONSTRAINT')||/UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint/.test(String(error?.message)))return res.status(409).json({error:'이미 사용 중인 키·이메일·관계이거나 참조가 올바르지 않습니다.'});
    console.error('[teamspace API]',error?.message||error);return res.status(500).json({error:'요청을 처리하지 못했습니다.'});
  });
  return {app,attachWebSocket:(server:import('node:http').Server)=>collaboration.attachWebSocket(server),close:()=>{migrations.close();legacyImport.close();outbound.close();collaboration.close();reportLedger.close();store.db.close();}};
}
