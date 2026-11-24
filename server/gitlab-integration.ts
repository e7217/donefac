import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { Express,Request,Response,NextFunction } from 'express';
import type { AutomationEvent,AutomationRun,GitlabHistoryLimits,GitlabIssueBranchTarget,GitlabIssueRefreshResult,GitlabJiraRoute,GitlabJiraSource,GitlabLink,GitlabMergeReadiness,GitlabMergeRequestDiscussions,GitlabMergeRequestPipeline,GitlabMergeRequestReview,GitlabPipelineFailedTests,GitlabPipelineJobs,GitlabPipelineTestReport,GitlabRepositorySearch,GitlabSettings,GitlabSyncFailure,GitlabSyncPreview,GitlabSyncPreviewCandidate,GitlabSyncPreviewCounts,GitlabSyncRepositoryFailure,GitlabSyncRepositoryResult,GitlabSyncResult,GitlabWebhookDelivery,GitlabWebhookStatus,Issue } from '../shared/types.js';
import { GITLAB_WEBHOOK_TRACKED_EVENTS, type GitlabWebhookTrackedEvent } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha, gitlabPipelineLinkIdentity, isGitlabBranchName, isGitlabManualLinkId, isRestorableGitlabLink } from '../shared/gitlab-links.js';
import { parseGitlabMergeReadiness } from '../shared/gitlab-merge-readiness.js';
import { gitlabPipelineSource } from '../shared/gitlab-pipeline-source.js';
import { gitlabPipelineGroup } from '../shared/issue-gitlab-view.js';
import type { GitlabProjectWebhookHistory, GitlabProjectWebhookMessageReceipt } from '../shared/gitlab-project-webhooks.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl, gitlabScopedPushUrl, readGitlabHeadPush, type GitlabHeadPush } from './gitlab-push.js';
import { GITLAB_REPOSITORY_SEARCH_MAX_PAGE, GitlabManualUrlError, GitlabReadError, GitlabRepositoryQueryError, gitlabLinkedActivityReader, includesGitlabCredential, isExactGitlabPipelineListRow, isGitlabMergeRequestUrl, readGitlabBranchMergeRequests, readGitlabManualObject, readGitlabMergeRequestDiscussions, readGitlabMergeRequestPipeline, readGitlabMergeRequestReview, readGitlabPipelineFailedTests, readGitlabPipelineJobs, readGitlabPipelineTestReport, readGitlabRepositorySearch, readGitlabSyncProject } from './gitlab-read-sync.js';
import type { MergeRequestPipelineTestReaders } from './gitlab-read-sync.js';
import { GitlabProjectWebhookSetup } from './gitlab-project-webhook-setup.js';
import { gitlabWebhookMessageDigest } from './gitlab-webhook-message.js';
import { GitlabWebhookReceipts } from './gitlab-webhook-receipts.js';
import { GitlabIssueBranchCreation, GitlabIssueBranchError } from './gitlab-branch-creation.js';
import { GitlabDeployments } from './gitlab-deployments.js';
import { readGitlabDeploymentHistory, readGitlabDeploymentStatus } from './gitlab-deployment-read.js';
import { GitlabManualSyncStatus } from './gitlab-sync-status.js';
import { GitlabMergeRequestObservations, isGitlabMergeRequestReadState, type GitlabMergeRequestReadState } from './gitlab-merge-request-observations.js';
import { readGitlabWorkflowPipelineFreshness, type GitlabWorkflowPipelineFreshness } from './gitlab-workflow-pipeline-freshness.js';
import type { ManualPipelineStatusCandidate } from './automation.js';
import type { GitlabBranchMergeRequests, GitlabDeployment, GitlabDeploymentPreviewResult, GitlabDeploymentReviewResult, GitlabDeploymentStatusBinding, GitlabDeploymentSyncResult, GitlabMergeRequestStatusBinding, GitlabPipelineStatusBinding, GitlabStatusObservation, GitlabStatusReview, GitlabSyncStatus, GitlabWorkflowStatusSuggestionTrigger } from '../shared/types.js';
import type { Store } from './store.js';
import type { PreviousIssueKey } from './reporting-ledger.js';

export class GitlabIntegrationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new GitlabIntegrationError(status,message,details);}
function failGitlabWorkflowRead(error: GitlabReadError): never {
  if (error.httpStatus === 404) {
    if (error.stage === 'pipeline-test-report') fail('GitLab에서 이 파이프라인의 테스트 결과를 제공하지 않습니다.', 404);
    if (error.stage === 'pipeline-failed-tests') fail('GitLab에서 이 파이프라인의 실패 테스트 상세를 제공하지 않습니다.', 404);
  }
  const status = error.code === 'changed' ? 409 : error.code === 'timeout' ? 504
    : error.httpStatus === 401 || error.httpStatus === 403 ? 403
    : error.httpStatus === 404 || error.httpStatus === 429 ? error.httpStatus : 502;
  return fail(error.message, status);
}
function failGitlabDeploymentRead(error: GitlabReadError): never {
  const denied = error.httpStatus === 401 || error.httpStatus === 403;
  const message = denied ? 'GitLab 배포 이력을 읽을 수 없습니다. 읽기 토큰과 접근 권한을 확인해 주세요.'
    : 'GitLab 배포 이력을 읽지 못했습니다. 저장소 주소와 연결 상태를 확인해 주세요.';
  return fail(message, 502, { stage: error.stage, httpStatus: error.httpStatus, reason: error.message });
}
type Obj=Record<string,unknown>;
type RawSettings={baseUrl:string;projectIds:number[];jiraRoutes?:GitlabJiraRoute[];token?:string|null;webhookSecret?:string|null;signingToken?:string|null;version:number;lastSyncAt:string|null;lastError:string|null};
type LinkedMergeRequestReadContext = { issue: Issue; link: GitlabLink; captured: RawSettings; workspaceGeneration: unknown;
  token: string | null; assertCurrent: () => void };
type WebhookResult = { ok: true; duplicate: boolean; linked: number; runs: AutomationRun[]; deploymentUpdated?: true };
type AcceptedWebhookEvents = Partial<Record<GitlabWebhookTrackedEvent, GitlabWebhookDelivery>>;
type StoredWebhookDelivery = { id: string; delivery: GitlabWebhookDelivery; lastAcceptedByEvent?: AcceptedWebhookEvents };
type VerifiedPipelineCursor = PipelineClassification & { scope: string; objectId: number; sourceBranch: string; sourceSha: string };
type ObjectCursor={id:string;occurredAt:string|null;state:string;receivedAt?:string;approvalRevision?:{updatedAt:string;head:string};pipeline?:VerifiedPipelineCursor};
type BranchCursor={id:string;pipelineId:number};
type PushObservation={id:string;state:'active'|'deleted';sourceSha:string;webUrl:string;updatedAt:string;source?:'read';revision?:string};
type Hooks={
  processEvent:(event:AutomationEvent)=>AutomationRun[];
  manualStatusReview?:(issue:Issue, observations:readonly GitlabStatusObservation[], actorId:string, settingsVersion:number)=>GitlabStatusReview|undefined;
  requiresManualPipelineVerification?:(issue: Issue, candidate: ManualPipelineStatusCandidate) => boolean;
  onConnectionChanged:(previous:GitlabSettings,next:GitlabSettings)=>number;
  findArchivedBranchLink?:(cursorId:string)=>GitlabLink|undefined;
  jiraSources?:()=>GitlabJiraSource[];
  jiraOriginalKeys?:(route:GitlabJiraRoute)=>Map<string,JiraKeyBinding|null>;
  previousIssueKeys?: () => ReadonlyMap<string, PreviousIssueKey[]>;
  onIssueBranchAttached?: (actorId: string, issueId: string, link: GitlabLink) => void;
};
type RouteHooks={actor:(request:Request)=>string;activity:(request:Request,resourceType:string,resourceId:string,action:string,detail?:string)=>unknown};
type SyncConnection={baseUrl:string;projectIds:number[];jiraRoutes?:GitlabJiraRoute[];token:string|null;version:number;
  webhookCredentials:readonly (string | null)[]};
type ReadOptions={signal?:AbortSignal;includeHistory?:boolean};
type SyncOptions=Pick<ReadOptions,'includeHistory'> & { expectedVersion?: unknown; repositoryIds?: unknown };
type SyncKind=GitlabSyncPreviewCandidate['kind'];
type WorkflowGitlabKind=Extract<GitlabLink['kind'],'merge_request'|'pipeline'>;
type VerifiedGitlabActivity = Awaited<ReturnType<typeof readGitlabManualObject>>;
type BranchMergeRequestAttachment = {
  assertCurrent: () => void;
  assertMergeRequest: (activity: VerifiedGitlabActivity, existing: GitlabLink | undefined) => void;
};
type IssueMatch=Pick<Issue,'id'|'key'|'title'|'projectId'> & { previousKeys?: PreviousIssueKey[] };
type JiraKeyBinding={issueId:string;originalJiraKey:string};
type TicketMatch={issue:IssueMatch;originalJiraKey?:string};
type KeyReader=(...values:unknown[])=>string[];
type TicketMatcher={match:(keys:string[],inherited?:TicketMatch[])=>TicketMatch[];inherit:(link:GitlabLink)=>TicketMatch|undefined;ambiguousKeys:Set<string>};
type MergeObservation=Pick<GitlabMergeReadiness,'source'|'observedAt'>&{invalidate?:boolean; repositoryId?:number; targetBranch?:string|null; trackState?:boolean};
type ExactMergeRequestRead = { repositoryId: number; objectId: number; iid: number; state: GitlabMergeRequestReadState; updatedAt: string };
type PipelineClassification = Pick<GitlabLink, 'pipelineSource' | 'pipelineTag'>;
const approvalActions=new Set(['approval','approved','unapproval','unapproved']);
const mergeRequestLifecycle = {
  open: { state: 'opened', trigger: 'merge_request.opened' },
  reopen: { state: 'opened', trigger: 'merge_request.opened' },
  merge: { state: 'merged', trigger: 'merge_request.merged' },
  close: { state: 'closed', trigger: 'merge_request.closed' },
} as const;
const PREVIEW_CANDIDATE_LIMIT=100;
const AMBIGUOUS_KEY_LIMIT=20;
const GITLAB_PUSH_COMMIT_LIMIT=20;
const ISSUE_REFRESH_LINK_LIMIT=20;
const ISSUE_REFRESH_CONCURRENCY=4;
const now=()=>new Date().toISOString();
function isTrackedWebhookEvent(event: string): event is GitlabWebhookTrackedEvent {
  return GITLAB_WEBHOOK_TRACKED_EVENTS.some(tracked => tracked === event);
}
function acceptedWebhookEvents(stored: StoredWebhookDelivery | undefined): AcceptedWebhookEvents | undefined {
  if (!stored) return undefined;
  const { delivery, lastAcceptedByEvent } = stored;
  if (lastAcceptedByEvent) return lastAcceptedByEvent;
  // An older physical backup contains only the most recent delivery for this repository.
  if (!delivery.duplicate && isTrackedWebhookEvent(delivery.event)) return { [delivery.event]: delivery };
  return undefined;
}
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const string=(value:unknown):string=>typeof value==='string'?value:'';
const bound=(value:unknown,max:number):string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:'';
const objectId=(object:Obj):string=>{const id=object.id??object.iid;return typeof id==='number'&&Number.isSafeInteger(id)&&id>0?String(id):typeof id==='string'&&id.trim()?bound(id,200):'';};
function numericObjectId(value:unknown): string {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):'';
  return typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))?value:'';
}
function baseUrl(value:unknown):string{if(typeof value!=='string')fail('GitLab 주소를 확인해 주세요.');if(!value.trim())return'';let url:URL;try{url=new URL(value.trim());}catch{fail('GitLab 주소를 확인해 주세요.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('인증 정보가 없는 GitLab http(s) 기본 주소가 필요합니다.');return url.toString().replace(/\/+$/,'');}
function projectIds(value:unknown):number[]{
  if(!Array.isArray(value)||value.length>100||value.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(value).size!==value.length)fail('저장소 ID는 중복되지 않은 양의 정수 목록이어야 합니다.');
  return [...value].sort((a,b)=>a-b);
}
function jiraSourceId(source:Pick<GitlabJiraSource,'projectId'|'jiraInstanceKey'>):string {
  return JSON.stringify([source.projectId,source.jiraInstanceKey]);
}
function parseJiraRoutes(value:unknown,allowed:number[],sources:GitlabJiraSource[]):GitlabJiraRoute[]{
  if(!Array.isArray(value)||value.length>100)fail('GitLab 저장소별 Jira 원본 경로를 확인해 주세요.');
  const selected=new Set<number>(),sourceIds=new Set(sources.map(jiraSourceId));
  return value.map(raw=>{
    const input=record(raw),{repositoryId,projectId,jiraInstanceKey}=input;
    if(Object.keys(input).length!==3||typeof repositoryId!=='number'||!allowed.includes(repositoryId)||selected.has(repositoryId)||
       typeof projectId!=='string'||typeof jiraInstanceKey!=='string'||!sourceIds.has(jiraSourceId({projectId,jiraInstanceKey}))){
      fail('허용된 저장소마다 현재 이관된 프로젝트와 Jira 원본 조합을 한 번만 선택해 주세요.');
    }
    selected.add(repositoryId);
    return {repositoryId,projectId,jiraInstanceKey};
  }).sort((a,b)=>a.repositoryId-b.repositoryId);
}
function credential(value:unknown):string{
  if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value))fail('인증 값을 확인해 주세요.');
  return value;
}
function historyRequested(input:Obj):boolean{
  if('includeHistory'in input&&typeof input.includeHistory!=='boolean')fail('기존 브랜치·커밋 조회 옵션을 확인해 주세요.');
  return input.includeHistory===true;
}
function assertSettingsVersion(expectedVersion:unknown, currentVersion:number):void{
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==currentVersion)fail('GitLab 연결 설정이 변경되었습니다. 최신 설정을 확인해 주세요.',Number.isSafeInteger(expectedVersion)?409:400,{currentVersion});
}
function occurredAt(value:unknown):string|null{if(typeof value!=='string'||value.length>100)return null;const candidate=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(value)?value.replace(' ','T').replace(' UTC','Z'):value;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(candidate)||!isCalendarDate(candidate.slice(0,10))||Number(candidate.slice(11,13))>23||Number(candidate.slice(14,16))>59||Number(candidate.slice(17,19))>59)return null;const time=Date.parse(candidate);return Number.isFinite(time)&&time<=Date.now()?new Date(time).toISOString():null;}
function keys(...values:unknown[]):string[]{return[...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g)||[]))];}
function routedKeys(...values:unknown[]):string[]{
  return [...new Set(values.flatMap(value=>(typeof value==='string'?value:'').match(/\b[A-Za-z][A-Za-z0-9_]{0,127}-\d+\b/g)||[]).map(key=>key.toUpperCase()))];
}
function constantEqual(a:string,b:string):boolean{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function signingKey(value:string):Buffer{if(!value.startsWith('whsec_'))fail('서명 토큰은 whsec_ 형식이어야 합니다.');const encoded=value.slice(6),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)fail('서명 토큰은 32바이트 Base64 whsec_ 형식이어야 합니다.');return key;}
function validWebUrl(value:unknown):string{if(typeof value!=='string'||value.length>4000)return'';try{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():'';}catch{return'';}}

function pipelineTime(object:Obj,state:string):string|null{
  const terminal=['success','failed','canceled','skipped'].includes(state);
  const first=terminal?object.finished_at:object.updated_at;
  const second=terminal?object.updated_at:object.finished_at;
  return occurredAt(first)??occurredAt(second)??(!first&&!second?occurredAt(object.created_at):null);
}
function readPipelineClassification(object: Obj, readTag: boolean, ...secrets: (string | null | undefined)[]): PipelineClassification {
  const pipelineSource = gitlabPipelineSource(object.source);
  return {
    ...(pipelineSource && !secrets.some(secret => secret && pipelineSource.includes(secret)) ? { pipelineSource } : {}),
    ...(readTag && typeof object.tag === 'boolean' ? { pipelineTag: object.tag } : {}),
  };
}
function readMergeTargetBranch(object: Obj, repositoryId: number, ...secrets: (string | null)[]): string | null | undefined {
  const { target_branch: branch, target_project_id: target } = object;
  if (!numericObjectId(object.id) || !numericObjectId(object.iid) || (target !== undefined && target !== repositoryId)) return;
  // A scoped observation can clear a cached target when its branch is unusable.
  return isGitlabBranchName(branch) && !secrets.some(secret => secret && branch.includes(secret)) ? branch : null;
}
function exactMergeRequestRead(object: Obj, repositoryId: number): ExactMergeRequestRead | undefined {
  const { id, iid, state, project_id: project, target_project_id: target } = object;
  if (project !== repositoryId || (target !== undefined && target !== repositoryId) ||
      typeof id !== 'number' || !numericObjectId(id) || typeof iid !== 'number' || !numericObjectId(iid) ||
      !isGitlabMergeRequestReadState(state)) return;
  const updatedAt = occurredAt(object.updated_at);
  if (updatedAt?.length === 24) return { repositoryId, objectId: id, iid, state, updatedAt };
}
function readLink(kind:GitlabLink['kind'],object:Obj,explicitKeys:string[],readKeys:KeyReader=keys,observation?:MergeObservation,
  pipelineClassification:PipelineClassification={}){
  const id=objectId(object);
  const explicitTitle=string(object.title)||string(object.name);
  const title=explicitTitle||string(object.ref)||string(object.message)||`${kind} #${id}`;
  const state=string(object.state)||string(object.status)||'unknown';
  const incomingTime=kind==='pipeline'
    ? pipelineTime(object,state)
    : occurredAt(object.updated_at||object.finished_at||object.created_at);
  const mergeCommitShas=kind==='merge_request' && state==='merged' && incomingTime && observation?.repositoryId &&
    numericObjectId(object.target_project_id)===String(observation.repositoryId) && numericObjectId(object.id) && numericObjectId(object.iid)
    ? [...new Set([gitlabObjectSha(object.merge_commit_sha),gitlabObjectSha(object.squash_commit_sha)]
      .filter((sha): sha is string => Boolean(sha && !/^0+$/u.test(sha))))].sort() : [];
  return {
    id,numericId:numericObjectId(object.id),hasTitle:Boolean(explicitTitle),title:title.slice(0,500),matchedKeys:[...new Set([...readKeys(title,object.description,object.source_branch,object.ref),...explicitKeys])],
    webUrl:validWebUrl(object.web_url||object.url),iid:kind==='commit'?0:Number(object.iid||object.id)||0,reportedIid:Number(numericObjectId(object.iid))||0,
    reportedProjectId:object.project_id===undefined?undefined:numericObjectId(object.project_id),
    state,incomingTime,mergeCommitShas,pipelineClassification,
    exactMergeRequestRead:kind==='merge_request'&&observation?.source==='read'&&observation.trackState&&observation.repositoryId
      ?exactMergeRequestRead(object,observation.repositoryId):undefined,
    targetBranch:kind==='merge_request'&&incomingTime?observation?.targetBranch:undefined,
    sourceBranch:bound(kind==='pipeline'?object.ref:object.source_branch||object.ref,512),sourceSha:bound(object.sha||record(object.last_commit).id,128),
    mergeObservation:kind==='merge_request'&&object.state==='opened'&&observation
      ?{...observation,evidence:parseGitlabMergeReadiness(object,observation.observedAt,observation.source)}:undefined,
  };
}
type LinkDraft=ReturnType<typeof readLink>;
type OpenedMergeRequestStatusRead = { trigger: 'merge_request.opened'; occurredAt: string; sourceProjectId: number };
type WorkflowStatusRead = OpenedMergeRequestStatusRead |
  { trigger: Exclude<GitlabWorkflowStatusSuggestionTrigger, 'merge_request.opened'>; occurredAt: string | null };
type ConfirmedWorkflowRead = { link: GitlabLink; observation: GitlabStatusObservation | null };
type IssueGitlabRefreshMode = 'all' | 'exact' | 'status-review';

function openedMergeRequestStatusRead(object: Obj, targetBranch: string | null | undefined): OpenedMergeRequestStatusRead | null {
  if (object.state !== 'opened' || !targetBranch || !isGitlabBranchName(object.source_branch) || !gitlabObjectSha(object.sha)) return null;
  const createdAt = occurredAt(object.created_at);
  const updatedAt = occurredAt(object.updated_at);
  const sourceProjectId = object.source_project_id;
  return createdAt && updatedAt && createdAt <= updatedAt && typeof sourceProjectId === 'number' && Number.isSafeInteger(sourceProjectId) && sourceProjectId > 0
    ? { trigger: 'merge_request.opened', occurredAt: createdAt, sourceProjectId } : null;
}

function workflowStatusRead(kind: WorkflowGitlabKind, object: Obj, targetBranch: string | null | undefined): WorkflowStatusRead | null {
  if (kind === 'merge_request' && object.state === 'opened') return openedMergeRequestStatusRead(object, targetBranch);
  let trigger: Exclude<GitlabWorkflowStatusSuggestionTrigger, 'merge_request.opened'>;
  let timestamp: unknown;
  if (kind === 'pipeline' && (object.status === 'success' || object.status === 'failed')) {
    trigger = object.status === 'success' ? 'pipeline.succeeded' : 'pipeline.failed';
    timestamp = object.finished_at;
  } else if (kind === 'merge_request' && (object.state === 'merged' || object.state === 'closed')) {
    trigger = object.state === 'merged' ? 'merge_request.merged' : 'merge_request.closed';
    timestamp = object.state === 'merged' ? object.merged_at : object.closed_at;
  } else return null;
  return { trigger, occurredAt: occurredAt(timestamp) };
}

function confirmWorkflowRead(link: GitlabLink, draft: LinkDraft, status: WorkflowStatusRead | null,
  aliases: readonly GitlabLink[]): ConfirmedWorkflowRead | null {
  const timestamp = draft.incomingTime;
  const sha = gitlabObjectSha(draft.sourceSha);
  if (!timestamp || draft.state === 'unknown' || link.updatedAt !== timestamp || link.state !== draft.state ||
      !isGitlabBranchName(draft.sourceBranch) || link.sourceBranch !== draft.sourceBranch ||
      !sha || /^0+$/u.test(sha) || gitlabObjectSha(link.sourceSha) !== sha ||
      (link.kind === 'pipeline' && link.pipelineObservedAt !== timestamp)) return null;
  if (status && !status.occurredAt) return null;
  const checkedAt = Date.parse(timestamp);
  if (aliases.some(alias => alias.id !== link.id && alias.pipelineObservedAt !== null &&
      (Date.parse(alias.updatedAt) > checkedAt || Date.parse(alias.updatedAt) === checkedAt && alias.state !== link.state))) return null;
  if (!status?.occurredAt) return { link, observation: null };
  const evidence = { link, occurredAt: status.occurredAt };
  if (status.trigger === 'merge_request.opened') {
    const targetBranch = draft.targetBranch;
    const conflictingHead = aliases.some(alias => {
      if (alias.id === link.id || alias.iid !== draft.reportedIid || alias.updatedAt !== timestamp) return false;
      const aliasSha = gitlabObjectSha(alias.sourceSha);
      return Boolean((alias.sourceBranch && alias.sourceBranch !== draft.sourceBranch) || (aliasSha && aliasSha !== sha));
    });
    const observation = targetBranch && targetBranch === link.targetBranch && !conflictingHead &&
      !hasConflictingMergeTarget(draft, aliases, link.id)
      ? { ...evidence, trigger: status.trigger, targetBranch, sourceProjectId: status.sourceProjectId } : null;
    return { link, observation };
  }
  if (status.trigger === 'merge_request.merged' || status.trigger === 'merge_request.closed') {
    const targetBranch = draft.targetBranch && draft.targetBranch === link.targetBranch &&
      !hasConflictingMergeTarget(draft, aliases, link.id) ? draft.targetBranch : undefined;
    return { link, observation: { ...evidence, trigger: status.trigger, ...(targetBranch ? { targetBranch } : {}) } };
  }
  return { link, observation: { ...evidence, trigger: status.trigger } };
}

function hasConflictingMergeTarget(draft: LinkDraft, aliases: readonly GitlabLink[], exceptId?: string): boolean {
  const timestamp = Date.parse(draft.incomingTime ?? '');
  return aliases.some(alias => alias.id !== exceptId && alias.iid === draft.reportedIid &&
    (Date.parse(alias.updatedAt) > timestamp || Date.parse(alias.updatedAt) === timestamp &&
      (alias.state !== draft.state || alias.targetBranch !== undefined && alias.targetBranch !== draft.targetBranch)));
}

function currentWorkflowObservations(checked: readonly ConfirmedWorkflowRead[], latestVerifiedPipelineId: (link: GitlabLink) => number | null): GitlabStatusObservation[] {
  const latestPipelineIds = new Map<string, number>();
  for (const { link } of checked) {
    if (link.kind !== 'pipeline') continue;
    const group = gitlabPipelineGroup(link);
    if (group && group.id > (latestPipelineIds.get(group.key) ?? 0)) latestPipelineIds.set(group.key,group.id);
  }
  return checked.flatMap(({ link, observation }) => {
    if (!observation) return [];
    if (link.kind !== 'pipeline') return [observation];
    const group = gitlabPipelineGroup(link);
    const newestWebhookId = latestVerifiedPipelineId(link);
    return group && latestPipelineIds.get(group.key) === group.id && (newestWebhookId === null || group.id >= newestWebhookId) ? [observation] : [];
  });
}

type ProjectReadPlan={
  projectId:number;mergeRequests:LinkDraft[];pipelines:LinkDraft[];
  history?:{branches:LinkDraft[];commits:LinkDraft[];limits:GitlabHistoryLimits};
};
type ProjectReadOutcome={projectId:number;plan:ProjectReadPlan}|{projectId:number;failure:GitlabSyncRepositoryFailure};
function gitlabLinkObjectKey(instance:string,projectId:number,kind:GitlabLink['kind'],id:string):string{
  return `gitlab:${instance}:${projectId}:${kind}:${id}`;
}
function linkedWorkflowTarget(link:GitlabLink, issueId:string, instance:string){
  const {kind,projectId,iid}=link;
  if ((kind!=='merge_request'&&kind!=='pipeline')||link.issueId!==issueId||!numericObjectId(projectId)||kind==='merge_request'&&!numericObjectId(iid)) return null;
  const prefix=gitlabLinkObjectKey(instance,projectId,kind,'');
  const suffix=`:${issueId}`;
  if (!link.id.startsWith(prefix)||!link.id.endsWith(suffix)) return null;
  const objectId=Number(numericObjectId(link.id.slice(prefix.length,-suffix.length)));
  if (!objectId) return null;
  return {kind,id:kind==='merge_request'?iid:objectId,objectId};
}
function linkForIssue(instance:string,projectId:number,kind:GitlabLink['kind'],match:TicketMatch,draft:LinkDraft):GitlabLink{
  const { id,title,iid,webUrl,state,incomingTime,sourceBranch,sourceSha,mergeCommitShas,targetBranch }=draft;
  const {issue:{id:issueId},originalJiraKey}=match;
  return {id:`${gitlabLinkObjectKey(instance,projectId,kind,id)}:${issueId}`,issueId,projectId,iid,kind,title,webUrl,state,updatedAt:incomingTime||now(),...(kind==='pipeline'?{pipelineObservedAt:pipelineObservedAt(draft),...draft.pipelineClassification}:{}),...(sourceBranch?{sourceBranch}:{}),...(sourceSha?{sourceSha}:{}),...(targetBranch?{targetBranch}:{}),...(originalJiraKey?{originalJiraKey}:{}),...(draft.mergeObservation?.evidence?{mergeReadiness:draft.mergeObservation.evidence}:{}),...(mergeCommitShas.length?{mergeCommitShas}:{})};
}
function retainOriginalJiraKey(link:GitlabLink,existing?:GitlabLink):GitlabLink{
  return !link.originalJiraKey&&existing?.originalJiraKey?{...link,originalJiraKey:existing.originalJiraKey}:link;
}

function makeTicketMatcher(issues:IssueMatch[],route:GitlabJiraRoute|undefined,originals:Map<string,JiraKeyBinding|null>):TicketMatcher{
  const scoped=route?issues.filter(issue=>issue.projectId===route.projectId):issues;
  const normalizeKey = (key: string) => route ? key.toUpperCase() : key;
  const byId=new Map(scoped.map(issue=>[issue.id,issue]));
  const byKey=new Map(scoped.map(issue=>[normalizeKey(issue.key),issue]));
  const previousByKey = new Map<string, IssueMatch | null>();
  for (const issue of issues) {
    for (const previous of issue.previousKeys ?? []) {
      if (route && previous.projectId !== route.projectId) continue;
      const key = normalizeKey(previous.key);
      const existing = previousByKey.get(key);
      previousByKey.set(key, existing === undefined || existing?.id === issue.id ? issue : null);
      byId.set(issue.id, issue);
    }
  }
  const ambiguousKeys=new Set<string>();

  function fromKey(key:string):TicketMatch|undefined{
    const normalized = normalizeKey(key);
    const current = byKey.get(normalized), previous = previousByKey.get(normalized), alias = originals.get(normalized);
    const identities = new Set([current?.id, previous?.id, alias?.issueId].filter(Boolean));
    if (previous === null || alias === null || identities.size > 1) {
      if(ambiguousKeys.size<AMBIGUOUS_KEY_LIMIT)ambiguousKeys.add(normalized);
      return;
    }
    const issue = current ?? previous ?? (alias ? byId.get(alias.issueId) : undefined);
    return issue?{issue,...(alias?{originalJiraKey:alias.originalJiraKey}:{})}:undefined;
  }

  return {
    match(keys,inherited=[]){
      const matches=new Map<string,TicketMatch>();
      for(const candidate of [...keys.map(fromKey),...inherited]){
        if(!candidate)continue;
        const previous=matches.get(candidate.issue.id);
        if(!previous||!previous.originalJiraKey&&candidate.originalJiraKey)matches.set(candidate.issue.id,candidate);
      }
      return [...matches.values()];
    },
    inherit(link){
      if(link.manualLinkId)return;
      const issue=byId.get(link.issueId);
      if(!issue)return;
      if(!link.originalJiraKey)return {issue};
      const alias=originals.get(link.originalJiraKey.toUpperCase());
      if(alias?.issueId!==issue.id||fromKey(link.originalJiraKey)?.issue.id!==issue.id)return;
      return {issue,originalJiraKey:alias.originalJiraKey};
    },
    ambiguousKeys,
  };
}
function keepNewerLink(existing:GitlabLink,draft:LinkDraft):boolean{
  return !draft.incomingTime||Date.parse(existing.updatedAt)>=Date.parse(draft.incomingTime);
}
function sameMergeHead(link:GitlabLink,draft:LinkDraft):boolean{
  return (!link.iid||!draft.reportedIid||link.iid===draft.reportedIid)&&
    (!link.sourceSha||!draft.sourceSha||link.sourceSha===draft.sourceSha)&&
    (!link.sourceBranch||!draft.sourceBranch||link.sourceBranch===draft.sourceBranch);
}
function pipelineObservedAt(draft: LinkDraft): string | null {
  return draft.id === draft.numericId && draft.numericId && draft.state !== 'unknown' && bound(draft.state,100)
    ? draft.incomingTime : null;
}
function samePipelineRevision(link: Pick<GitlabLink, 'sourceBranch' | 'sourceSha'>, draft: Pick<LinkDraft,'sourceBranch'|'sourceSha'>): boolean {
  const storedSha = gitlabObjectSha(link.sourceSha) ?? link.sourceSha;
  const incomingSha = gitlabObjectSha(draft.sourceSha) ?? draft.sourceSha;
  return (!storedSha || !incomingSha || storedSha === incomingSha) &&
    (!link.sourceBranch || !draft.sourceBranch || link.sourceBranch === draft.sourceBranch);
}
function conflictingPipelineClassification(a: PipelineClassification, b: PipelineClassification): boolean {
  return (a.pipelineSource !== undefined && b.pipelineSource !== undefined && a.pipelineSource !== b.pipelineSource) ||
    (a.pipelineTag !== undefined && b.pipelineTag !== undefined && a.pipelineTag !== b.pipelineTag);
}
function addPipelineClassification<T extends PipelineClassification>(known: T, evidence: PipelineClassification): T {
  if (conflictingPipelineClassification(known, evidence)) return known;
  const { pipelineSource, pipelineTag } = evidence;
  const source = known.pipelineSource === undefined ? pipelineSource : undefined;
  const tag = known.pipelineTag === undefined ? pipelineTag : undefined;
  if (source === undefined && tag === undefined) return known;
  return { ...known, ...(source !== undefined ? { pipelineSource: source } : {}), ...(tag !== undefined ? { pipelineTag: tag } : {}) };
}
function knownPipelineClassification(aliases: readonly PipelineClassification[]): PipelineClassification | null {
  let known: PipelineClassification = {};
  for (const alias of aliases) {
    if (conflictingPipelineClassification(known, alias)) return null;
    known = addPipelineClassification(known, alias);
  }
  return known;
}
function classifyPipelineDraft(draft: LinkDraft, aliases: readonly GitlabLink[], cursor?: VerifiedPipelineCursor, mayAddEvidence = true): LinkDraft | null {
  if (!draft.numericId || draft.id !== draft.numericId) return { ...draft, pipelineClassification: {} };
  const references = cursor ? [cursor, ...aliases] : aliases;
  const known = knownPipelineClassification(references);
  if (!known || conflictingPipelineClassification(known, draft.pipelineClassification) ||
      references.some(reference => !samePipelineRevision(reference, draft))) return null;
  const time = pipelineObservedAt(draft);
  const fresh = time && aliases.every(alias => alias.pipelineObservedAt === null ||
    !keepNewerLink(alias,draft) || time === alias.updatedAt && draft.state === alias.state);
  return { ...draft, pipelineClassification: mayAddEvidence && fresh ? addPipelineClassification(known, draft.pipelineClassification) : known };
}
function matchingApprovalTime(cursor:ObjectCursor|undefined,draft:LinkDraft):string|undefined{
  const revision=cursor?.approvalRevision;
  return revision&&draft.state==='opened'&&cursor?.state==='opened'&&
    draft.incomingTime===revision.updatedAt&&gitlabObjectSha(draft.sourceSha)===revision.head
    ?cursor.occurredAt??undefined:undefined;
}
function applyMergeObservation(link:GitlabLink,existing:GitlabLink,draft:LinkDraft,approvalAt?:string):GitlabLink{
  if(link.kind!=='merge_request')return link;
  const prior=existing.mergeReadiness,observation=draft.mergeObservation;
  let evidence=link.state==='opened'?prior:undefined;
  const approvalHead=Boolean(approvalAt)&&approvalAt===existing.updatedAt&&Boolean(draft.sourceSha)&&existing.sourceSha===draft.sourceSha;
  if(link.state==='opened'&&observation&&(draft.incomingTime===link.updatedAt||approvalHead)&&sameMergeHead(link,draft)){
    const metadataAdvanced=link.updatedAt!==existing.updatedAt;
    const headChanged=!sameMergeHead(existing,draft);
    const newer=!prior||observation.observedAt>prior.observedAt||observation.observedAt===prior.observedAt&&
      (metadataAdvanced||observation.source==='webhook'&&prior.source==='read');
    if(newer){
      if(observation.evidence)evidence=observation.evidence;
      else if(prior&&(metadataAdvanced||observation.invalidate||observation.source==='read')){
        evidence={state:'unknown',observedAt:observation.observedAt,source:observation.source};
      }
    }else if(prior&&headChanged&&prior.state!=='unknown'){
      // A changed revision can make the newer observation irrelevant.
      // Keep its clock so a read already in flight cannot restore the displaced finding.
      evidence={...prior,state:'unknown'};
    }
  }
  const priorMergeShas=existing.state==='merged'?existing.mergeCommitShas:undefined;
  let mergeCommitShas=link.state==='merged'?priorMergeShas:undefined;
  if(link.state==='merged' && draft.incomingTime===link.updatedAt && sameMergeHead(link,draft) &&
      draft.mergeCommitShas.length>(priorMergeShas?.length??0) && (priorMergeShas??[]).every(sha=>draft.mergeCommitShas.includes(sha))){
    mergeCommitShas=draft.mergeCommitShas;
  }
  const targetBranch=draft.targetBranch!==undefined&&draft.incomingTime===link.updatedAt&&draft.state===link.state&&sameMergeHead(link,draft)
    ?draft.targetBranch??undefined:existing.targetBranch;
  if(evidence===link.mergeReadiness&&mergeCommitShas===link.mergeCommitShas&&targetBranch===link.targetBranch)return link;
  const next={...link};
  if(evidence)next.mergeReadiness=evidence;
  else delete next.mergeReadiness;
  if(mergeCommitShas)next.mergeCommitShas=mergeCommitShas;
  else delete next.mergeCommitShas;
  if(targetBranch)next.targetBranch=targetBranch;
  else delete next.targetBranch;
  return next;
}
function matchesManualLink(existing:GitlabLink,draft:LinkDraft):boolean{
  if(existing.kind==='branch')return isGitlabBranchName(draft.sourceBranch)&&existing.sourceBranch===draft.sourceBranch&&draft.id===branchObjectId(draft.sourceBranch);
  if(existing.kind==='commit')return draft.id===draft.sourceSha&&existing.sourceSha===draft.id&&gitlabObjectSha(draft.id)===draft.id;
  if(existing.kind==='pipeline'&&!samePipelineRevision(existing,draft))return false;
  return Boolean(draft.numericId&&draft.id===draft.numericId&&(existing.kind!=='merge_request'||existing.iid===draft.iid));
}
function manualTitle(title:string,token:string|null):string{
  return safePreviewValue(title.replace(/[\u0000-\u001f\u007f]/gu,' '),token).slice(0,500).toWellFormed().trim();
}
function refreshExistingLink(existing:GitlabLink,draft:LinkDraft,token:string|null,approvalAt?:string):GitlabLink{
  const pipeline=existing.kind==='pipeline';
  const observedAt=pipeline?pipelineObservedAt(draft):null;
  if(pipeline){
    if(!observedAt||!samePipelineRevision(existing,draft))return existing;
    // Legacy links may have an upstream timestamp. Only explicitly unverified links use a local display clock.
    if(existing.pipelineObservedAt!==null&&keepNewerLink(existing,draft)){
      if(existing.updatedAt!==observedAt||existing.state!==draft.state)return existing;
      const verified=existing.pipelineObservedAt===undefined?{...existing,pipelineObservedAt:observedAt}:existing;
      return addPipelineClassification(verified,draft.pipelineClassification);
    }
  }
  const next=!draft.incomingTime||!pipeline&&keepNewerLink(existing,draft)?existing:{...existing,
    title:draft.hasTitle?manualTitle(draft.title,token)||existing.title:existing.title,
    state:draft.state==='unknown'?existing.state:bound(safePreviewValue(draft.state,token),100)||existing.state,
    updatedAt:draft.incomingTime,
    ...(pipeline?{pipelineObservedAt:observedAt}:{}),
    ...(draft.sourceBranch?{sourceBranch:safePreviewValue(draft.sourceBranch,token).slice(0,512)}:{}),
    ...(draft.sourceSha?{sourceSha:safePreviewValue(draft.sourceSha,token).slice(0,128)}:{}),
  };
  return pipeline?addPipelineClassification(next,draft.pipelineClassification):applyMergeObservation(next,existing,draft,approvalAt);
}
function automaticLinkForAttached(existing:GitlabLink,draft:LinkDraft,originalJiraKey:string|undefined,token:string|null):GitlabLink{
  return promoteAttachedLink(refreshExistingLink(existing,draft,token),originalJiraKey);
}
function refreshAutomaticPipeline(existing:GitlabLink,draft:LinkDraft,matched:GitlabLink):GitlabLink{
  const refreshed=refreshExistingLink(existing,draft,null);
  if(refreshed.pipelineObservedAt!==existing.pipelineObservedAt){
    return {...refreshed,webUrl:matched.webUrl,...(matched.originalJiraKey?{originalJiraKey:matched.originalJiraKey}:{})};
  }
  return !existing.originalJiraKey&&matched.originalJiraKey?{...refreshed,originalJiraKey:matched.originalJiraKey}:refreshed;
}
function promoteAttachedLink(link:GitlabLink,originalJiraKey?:string):GitlabLink{
  const verified={...link};
  delete verified.manualLinkId;
  return originalJiraKey?{...verified,originalJiraKey}:verified;
}
function refreshAttachedBranch(link:GitlabLink, {state,sourceSha,webUrl,updatedAt,branchObservationSource}:Pick<GitlabLink,'state'|'sourceSha'|'webUrl'|'updatedAt'|'branchObservationSource'>):GitlabLink{
  if(branchObservationSource==='sync' && (link.branchObservationSource!=='sync' || Date.parse(link.updatedAt)>Date.parse(updatedAt)))return link;
  if(link.state===state&&link.sourceSha===sourceSha&&link.webUrl===webUrl&&link.branchObservationSource===branchObservationSource)return link;
  const refreshed={...link,state,sourceSha,webUrl,updatedAt};
  if(branchObservationSource===undefined)delete refreshed.branchObservationSource;
  else refreshed.branchObservationSource=branchObservationSource;
  return refreshed;
}
function emptyCounts(includeHistory=false):GitlabSyncPreviewCounts{
  return {mergeRequests:0,pipelines:0,matched:0,unmatched:0,skipped:0,create:0,update:0,unchanged:0,...(includeHistory?{branches:0,commits:0}:{})};
}
function branchHead(branch:unknown,sha:unknown):string|null{
  const ref=bound(branch,512),head=bound(sha,128);
  return ref&&head?JSON.stringify([ref,head]):null;
}
export const branchObjectId=(branch:string)=>createHash('sha256').update(branch).digest('hex');
function pushCursorId(instance: string, projectId: number, branch: string): string {
  return `gitlab:${instance}:${projectId}:branch:${branchObjectId(branch)}`;
}
function linkedBranchTarget(link: GitlabLink, issueId: string, instance: string) {
  const branch = link.sourceBranch;
  if (link.kind !== 'branch' || !isGitlabBranchName(branch) || !isRestorableGitlabLink(link)) return null;
  const cursorId = pushCursorId(instance, link.projectId, branch);
  return link.issueId === issueId && link.id === `${cursorId}:${issueId}` ? { branch, cursorId } : null;
}
function branchLinkFields({state,sourceSha,webUrl,updatedAt,source}:PushObservation) {
  return {state,sourceSha,webUrl,updatedAt,...(source?{branchObservationSource:source}:{})};
}
function pushObservationFromLink(link: GitlabLink, includeSnapshot=false): PushObservation | null {
  if (!includeSnapshot && link.branchObservationSource === 'sync') return null;
  const { sourceBranch, state, webUrl, updatedAt } = link;
  if (link.kind !== 'branch' || !isGitlabBranchName(sourceBranch) || (state !== 'active' && state !== 'deleted')) return null;
  const instance = /^gitlab:([a-f\d]{12}):/.exec(link.id)?.[1];
  const sourceSha = gitlabObjectSha(link.sourceSha);
  if (!instance || !sourceSha || /^0+$/.test(sourceSha) || !Number.isFinite(Date.parse(updatedAt))) return null;
  const id = pushCursorId(instance, link.projectId, sourceBranch);
  return link.id === `${id}:${link.issueId}` ? {
    id,state,sourceSha,webUrl,updatedAt,...(link.branchObservationSource==='read'?{source:'read'}:{}),
  } : null;
}
function safePreviewValue(value:string,token:string|null):string{
  return token?value.replaceAll(token,'[숨김]'):value;
}

function repositoryBranchDraft(object:Obj, readKeys:KeyReader):LinkDraft{
  const branch=object.name, sha=gitlabObjectSha(record(object.commit).id);
  if(!isGitlabBranchName(branch)||!sha||/^0+$/.test(sha))return readLink('branch',{},[]);
  const draft=readLink('branch',{
    id:branchObjectId(branch),title:branch,source_branch:branch,sha,state:'active',web_url:object.web_url,
  },[],readKeys);
  return {...draft,title:branch,iid:0};
}

function repositoryCommitDraft(object:Obj, readKeys:KeyReader):LinkDraft{
  const sha=gitlabObjectSha(object.id);
  if(!sha||/^0+$/.test(sha))return readLink('commit',{},[]);
  return readLink('commit',{
    id:sha,sha,title:object.title,message:object.message,state:'committed',
    updated_at:object.committed_date,web_url:object.web_url,
  },readKeys(object.title,object.message),readKeys);
}

async function readProjectPlan(connection:SyncConnection,projectId:number,options:ReadOptions):Promise<ProjectReadPlan>{
  const observation={source:'read',observedAt:now(),repositoryId:projectId} as const;
  const scan=await readGitlabSyncProject(connection,projectId,options);
  const readKeys=connection.jiraRoutes?.some(route=>route.repositoryId===projectId)?routedKeys:keys;
  const mergeRequests=scan.mergeRequests.map(object=>{
    const scoped=(object.project_id===projectId||object.project_id===undefined&&object.target_project_id===projectId)&&
      isGitlabMergeRequestUrl(object.web_url,connection.baseUrl,Number(numericObjectId(object.iid)));
    const targetBranch=scoped?readMergeTargetBranch(object,projectId,connection.token,...connection.webhookCredentials):undefined;
    return readLink('merge_request',object,[],readKeys,
      object.target_project_id===undefined||numericObjectId(object.target_project_id)===String(projectId)
        ?{...observation,targetBranch,trackState:scoped}:undefined);
  });
  const keysByHead=new Map<string,Set<string>>();
  for(const mr of mergeRequests){
    const head=branchHead(mr.sourceBranch,mr.sourceSha);
    if(!head||!mr.id||!mr.webUrl)continue;
    let selected=keysByHead.get(head);
    if(!selected){selected=new Set();keysByHead.set(head,selected);}
    for(const key of mr.matchedKeys)selected.add(key);
  }
  const pipelines=scan.pipelines.map(object=>{
    const head=branchHead(object.ref,object.sha);
    const classification=isExactGitlabPipelineListRow(object,projectId,connection.baseUrl)
      ? readPipelineClassification(object,false,connection.token) : undefined;
    return readLink('pipeline',object,head?[...(keysByHead.get(head)??[])]:[],readKeys,undefined,classification);
  });
  if(!scan.history)return {projectId,mergeRequests,pipelines};
  const repository=gitlabRepositoryUrl(connection.baseUrl,scan.history.project);
  if(!repository)throw new GitlabReadError('project','invalid-response');
  const {branches,commits,branchesLimited,commitsLimited}=scan.history;
  return {projectId,mergeRequests,pipelines,history:{
    branches:branches.map(object=>repositoryBranchDraft({...object,web_url:gitlabPushLinkUrl(repository,'tree',string(object.name))},readKeys)),
    commits:commits.map(object=>repositoryCommitDraft({...object,web_url:gitlabPushLinkUrl(repository,'commit',gitlabObjectSha(object.id)??'')},readKeys)),
    limits:{branches:branchesLimited,commits:commitsLimited},
  }};
}

/** GitLab activity reads and explicit project webhook setup use the saved connection. */
export class GitlabIntegrationService{
  // Branch list snapshots have no revision number for reconciling overlapping manual scans.
  private historySyncActive=false;
  // A verified branch read can race its first webhook before a link exists.
  private readonly pendingBranchReads=new Map<string,{count:number;webUrl:string}>();
  private readonly manualLinkRows:StatementSync;
  private readonly linkedActivityRows:StatementSync;
  private readonly compatiblePipelineCursor: StatementSync;
  private readonly projectWebhooks: GitlabProjectWebhookSetup;
  private readonly webhookReceipts: GitlabWebhookReceipts;
  private readonly issueBranches: GitlabIssueBranchCreation;
  private readonly deploymentSyncs = new Set<string>();
  private readonly syncAttempts: GitlabManualSyncStatus;
  readonly mergeRequestObservations: GitlabMergeRequestObservations;
  readonly deployments: GitlabDeployments;
  constructor(private readonly store:Store,private readonly hooks:Hooks,webhookPublicOrigin?:string){
    this.deployments=new GitlabDeployments(store);
    this.syncAttempts = new GitlabManualSyncStatus(store);
    this.mergeRequestObservations = new GitlabMergeRequestObservations(store);
    this.webhookReceipts = new GitlabWebhookReceipts(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_object_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_branch_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_push_cursors(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gitlab_webhook_deliveries(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gitlab_pipeline_cursor_scope ON gitlab_object_cursors(
        json_extract(json,'$.pipeline.scope'), json_extract(json,'$.pipeline.objectId') DESC
      ) WHERE json_type(json,'$.pipeline')='object';
      CREATE INDEX IF NOT EXISTS gitlab_links_manual ON gitlab_links(id) WHERE json_extract(json,'$.manualLinkId') IS NOT NULL;`);
    this.manualLinkRows=store.db.prepare(`SELECT json FROM gitlab_links WHERE id>=? AND id<?
      AND json_extract(json,'$.manualLinkId') IS NOT NULL`);
    this.linkedActivityRows=store.db.prepare('SELECT json FROM gitlab_links WHERE id>=? AND id<? ORDER BY id');
    this.compatiblePipelineCursor = store.db.prepare(`SELECT json_extract(json,'$.pipeline.objectId') AS pipelineId
      FROM gitlab_object_cursors WHERE json_type(json,'$.pipeline')='object' AND json_extract(json,'$.pipeline.scope')=?
      AND (? IS NULL OR json_extract(json,'$.pipeline.pipelineSource') IS NULL OR json_extract(json,'$.pipeline.pipelineSource')=?)
      AND (? IS NULL OR json_extract(json,'$.pipeline.pipelineTag') IS NULL OR json_extract(json,'$.pipeline.pipelineTag')=?)
      ORDER BY json_extract(json,'$.pipeline.objectId') DESC LIMIT 1`);
    this.projectWebhooks = new GitlabProjectWebhookSetup(store, () => {
      const saved = this.raw();
      const authMode = saved.signingToken ? 'signature' : saved.webhookSecret ? 'secret' : null;
      return { baseUrl: saved.baseUrl, version: saved.version, projectIds: saved.projectIds, authMode,
        readToken: () => saved.token ? this.store.unseal(saved.token) : null,
        matchesCredential: value => this.sameCredential(authMode === 'signature' ? saved.signingToken : saved.webhookSecret, value),
      };
    }, webhookPublicOrigin);
    this.issueBranches = new GitlabIssueBranchCreation(store, () => {
      const saved = this.raw();
      return { baseUrl: saved.baseUrl, version: saved.version, projectIds: saved.projectIds,
        readToken: () => saved.token ? this.store.unseal(saved.token) : null };
    }, input => this.attachCreatedBranch(input));
  }
  private raw():RawSettings{const value=record(this.store.setting('gitlab'));return{baseUrl:string(value.baseUrl),projectIds:Array.isArray(value.projectIds)?value.projectIds as number[]:[],...(Array.isArray(value.jiraRoutes)&&value.jiraRoutes.length?{jiraRoutes:value.jiraRoutes as GitlabJiraRoute[]}:{}),token:typeof value.token==='string'?value.token:null,webhookSecret:typeof value.webhookSecret==='string'?value.webhookSecret:null,signingToken:typeof value.signingToken==='string'?value.signingToken:null,version:Number.isSafeInteger(value.version)&&Number(value.version)>0?Number(value.version):1,lastSyncAt:typeof value.lastSyncAt==='string'?value.lastSyncAt:null,lastError:typeof value.lastError==='string'?value.lastError:null};}
  private public(raw:RawSettings):GitlabSettings{return{baseUrl:raw.baseUrl,projectIds:raw.projectIds,tokenConfigured:!!raw.token,webhookSecretConfigured:!!raw.webhookSecret,signingTokenConfigured:!!raw.signingToken,version:raw.version,lastSyncAt:raw.lastSyncAt,lastError:raw.lastError,...(raw.jiraRoutes?.length?{jiraRoutes:raw.jiraRoutes}:{}),...(this.projectWebhooks.receiverUrl?{webhookReceiverUrl:this.projectWebhooks.receiverUrl}:{})};}
  settings():GitlabSettings{return this.public(this.raw());}
  syncStatus(): GitlabSyncStatus {
    const settings = this.raw();
    return this.syncAttempts.list(settings.version, settings.projectIds);
  }
  webhookStatus(): GitlabWebhookStatus {
    const settings = this.raw();
    const deliveries = new Map(this.store.all<StoredWebhookDelivery>('gitlab_webhook_deliveries').map(stored => [stored.id, stored]));
    return {
      settingsVersion: settings.version,
      repositories: settings.projectIds.map(repositoryId => {
        const stored = deliveries.get(String(repositoryId));
        const lastAcceptedByEvent = acceptedWebhookEvents(stored);
        return { repositoryId, lastDelivery: stored?.delivery ?? null, ...(lastAcceptedByEvent ? { lastAcceptedByEvent } : {}) };
      }),
    };
  }
  private jiraSources():GitlabJiraSource[]{return this.hooks.jiraSources?.()??[];}
  private submittedJiraRoutes(input:Obj,old:RawSettings,address:string,repositories:number[]):GitlabJiraRoute[]{
    if(Object.hasOwn(input,'jiraRoutes'))return parseJiraRoutes(input.jiraRoutes,repositories,this.jiraSources());
    return address===old.baseUrl?(old.jiraRoutes??[]).filter(route=>repositories.includes(route.repositoryId)):[];
  }
  private instance(raw:Pick<RawSettings,'baseUrl'>=this.raw()):string{return createHash('sha256').update(raw.baseUrl).digest('hex').slice(0,12);}
  private webhookCredentials(raw:RawSettings):(string|null)[]{
    return [raw.webhookSecret,raw.signingToken].map(value=>value?this.store.unseal(value):null);
  }
  private requireIssue(issueId:string):Issue{
    return this.store.get<Issue>('issues',issueId)??fail('업무를 찾을 수 없습니다.',404);
  }
  private attachCreatedBranch({ issue, target, observedSha, actorId }: {
    issue: Issue; target: GitlabIssueBranchTarget; observedSha: string; actorId: string;
  }): GitlabLink {
    const instance = this.instance();
    const draft = repositoryBranchDraft({ name: target.branch, commit: { id: observedSha }, web_url: target.webUrl }, keys);
    const snapshot = linkForIssue(instance, target.repositoryId, 'branch', { issue }, draft);
    const existing = this.store.get<GitlabLink>('gitlab_links', snapshot.id);
    const link = existing && !existing.manualLinkId ? existing : this.verifiedBranchAttachment(instance, snapshot, existing, now());
    if (!isRestorableGitlabLink(link) || link.issueId !== issue.id || link.sourceBranch !== target.branch ||
      link.sourceSha !== observedSha || link.state !== 'active') {
      fail('GitLab에서 확인한 브랜치와 티켓의 최신 활동이 달라 다시 확인해야 합니다.', 409);
    }
    if (link !== existing) this.store.put('gitlab_links', link);
    if (!existing) this.hooks.onIssueBranchAttached?.(actorId, issue.id, link);
    return link;
  }
  async attachLink(issueId:string,value:unknown,afterAttach?:(link:GitlabLink)=>void,signal?:AbortSignal,
    branchAttachment?: BranchMergeRequestAttachment):Promise<{link:GitlabLink;created:boolean}>{
    const input=record(value);
    if(Object.keys(input).some(key=>!['repositoryId','url','expectedSettingsVersion','actorId'].includes(key)))fail('GitLab 활동 연결 요청을 확인해 주세요.');
    const captured=this.raw();
    assertSettingsVersion(input.expectedSettingsVersion,captured.version);
    const repositoryId=input.repositoryId;
    if(typeof repositoryId!=='number'||!Number.isSafeInteger(repositoryId)||repositoryId<1)fail('GitLab 저장소를 선택해 주세요.');
    if(!captured.baseUrl||!captured.projectIds.includes(repositoryId))fail('허용된 GitLab 저장소를 선택해 주세요.',403);
    const issue=this.requireIssue(issueId);
    const token=captured.token?this.store.unseal(captured.token):null;
    const startedAt=now();
    const instance=this.instance(captured);
    let pendingBranchId:string|undefined;
    let branchCursorBeforeRead:PushObservation|undefined;
    let verified:VerifiedGitlabActivity;
    try {
      verified=await readGitlabManualObject({baseUrl:captured.baseUrl,token},repositoryId,input.url,signal,(name,webUrl)=>{
        if(token&&(name.includes(token)||webUrl.includes(token)))fail('GitLab 활동의 주소를 확인할 수 없습니다.',502);
        const id=pushCursorId(instance,repositoryId,name);
        const pending=this.pendingBranchReads.get(id);
        this.pendingBranchReads.set(id,{count:(pending?.count??0)+1,webUrl});
        pendingBranchId=id;
        branchCursorBeforeRead=this.store.get<PushObservation>('gitlab_push_cursors',id);
      });
    } catch(error) {
      branchAttachment?.assertCurrent();
      signal?.throwIfAborted();
      assertSettingsVersion(captured.version,this.raw().version);
      if(branchAttachment&&error instanceof GitlabManualUrlError)fail('GitLab 저장소 또는 브랜치 주소가 변경되었습니다. MR을 다시 확인해 주세요.',409);
      if(error instanceof GitlabManualUrlError)fail(error.message,400);
      if(branchAttachment&&error instanceof GitlabReadError)failGitlabWorkflowRead(error);
      if(error instanceof GitlabReadError)fail(error.message,error.httpStatus===404?404:502,{stage:error.stage,httpStatus:error.httpStatus});
      throw error;
    } finally {
      if(pendingBranchId){
        const pending=this.pendingBranchReads.get(pendingBranchId)!;
        if(pending.count===1)this.pendingBranchReads.delete(pendingBranchId);
        else pending.count--;
      }
    }
    branchAttachment?.assertCurrent();
    signal?.throwIfAborted();
    const {kind,object,webUrl}=verified;
    if(token&&webUrl.includes(token))fail('GitLab 활동의 주소를 확인할 수 없습니다.',502);
    const data={...object,web_url:webUrl};
    const targetBranch=kind==='merge_request'?readMergeTargetBranch(object,repositoryId,token,...this.webhookCredentials(captured)):undefined;
    const observedDraft=kind==='branch'?repositoryBranchDraft(data,keys):kind==='commit'?repositoryCommitDraft(data,keys):readLink(kind,{
      ...data,iid:kind==='merge_request'?object.iid:Number(numericObjectId(object.iid)||numericObjectId(object.id)),
    },[],keys,{source:'read',observedAt:startedAt,repositoryId,targetBranch,trackState:true},kind==='pipeline'?readPipelineClassification(object,true,token):undefined);
    if(!observedDraft.id||!observedDraft.webUrl)fail('GitLab 활동의 저장 정보를 확인할 수 없습니다.',502);
    return this.store.transaction(()=>{
      branchAttachment?.assertCurrent();
      assertSettingsVersion(captured.version,this.raw().version);
      const currentIssue=this.requireIssue(issueId);
      if(currentIssue.projectId!==issue.projectId)fail('업무가 다른 프로젝트로 이동했습니다. 최신 업무에서 다시 연결해 주세요.',409);
      const draft=kind==='pipeline'
        ? this.classifyReadPipeline(instance,repositoryId,observedDraft,this.workflowLinksForObject(instance,repositoryId,kind,observedDraft.id)) : observedDraft;
      if(!draft)fail('GitLab 파이프라인의 실행 정보가 기존 연결과 다릅니다. 최신 활동을 다시 확인해 주세요.',409);
      const snapshot=linkForIssue(instance,repositoryId,kind,{issue:currentIssue},draft);
      const existing=this.store.get<GitlabLink>('gitlab_links',snapshot.id);
      branchAttachment?.assertMergeRequest(verified,existing);
      if(existing?.manualLinkId&&!matchesManualLink(existing,draft))fail('저장한 GitLab 활동의 식별자와 일치하지 않습니다.',409);
      if(kind==='merge_request'){
        this.recordMergeRequestRead(instance,draft,startedAt);
        if(this.hasConflictingMergeRequestRead(instance,repositoryId,draft)){
          if(existing)return {link:existing,created:false};
          fail('GitLab MR의 최신 상태와 조회 결과가 다릅니다. 다시 확인해 주세요.',409);
        }
      }
      if(existing&&(branchAttachment||!existing.manualLinkId))return {link:existing,created:false};
      const link=kind==='branch'
        ?this.verifiedBranchAttachment(instance,snapshot,existing,startedAt,branchCursorBeforeRead)
        :kind==='commit'
          ?existing??{...snapshot,title:manualTitle(snapshot.title,token)||`commit #${snapshot.sourceSha}`,manualLinkId:randomUUID()}
          :this.verifiedWorkflowAttachment(kind,instance,snapshot,draft,existing,token,startedAt);
      if(link!==existing){
        if(!isRestorableGitlabLink(link))fail('GitLab 활동의 저장 정보를 확인할 수 없습니다.',502);
        this.store.put('gitlab_links',link);
      }
      if(!existing)afterAttach?.(link);
      return {link,created:!existing};
    });
  }
  private verifiedBranchAttachment(instance:string,snapshot:GitlabLink,existing:GitlabLink|undefined,startedAt:string,before?:PushObservation):GitlabLink{
    const cursor=this.store.get<PushObservation>('gitlab_push_cursors',pushCursorId(instance,snapshot.projectId,snapshot.sourceBranch!));
    if(cursor&&(cursor.state!=='active'||cursor.sourceSha!==snapshot.sourceSha)){
      const changedDuringRead=JSON.stringify(cursor)!==JSON.stringify(before);
      if(existing&&(changedDuringRead||Date.parse(cursor.updatedAt)>Date.parse(startedAt)))return existing;
      fail('GitLab에서 조회한 브랜치 HEAD가 마지막으로 확인한 푸시 기록과 다릅니다.',409);
    }
    const sample:GitlabLink=cursor?{...snapshot,...branchLinkFields(cursor),webUrl:snapshot.webUrl}
      :{...snapshot,branchObservationSource:'sync',updatedAt:startedAt};
    return existing?refreshAttachedBranch(existing,sample):{...sample,manualLinkId:randomUUID()};
  }
  private verifiedWorkflowAttachment(kind:WorkflowGitlabKind,instance:string,snapshot:GitlabLink,draft:LinkDraft,existing:GitlabLink|undefined,token:string|null,startedAt:string):GitlabLink{
    const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${snapshot.projectId}:${kind}:${draft.id}`);
    const cursorTime=Date.parse(cursor?.occurredAt??''),readTime=Date.parse(draft.incomingTime??'');
    const webhookDuringRead=kind==='merge_request'&&Date.parse(cursor?.receivedAt??'')>=Date.parse(startedAt);
    const approvalAt=kind==='merge_request'&&existing?matchingApprovalTime(cursor,draft):undefined;
    const approvalRead=Boolean(approvalAt)&&approvalAt===existing?.updatedAt;
    if(webhookDuringRead||!approvalRead&&Number.isFinite(cursorTime)&&(!Number.isFinite(readTime)||cursorTime>readTime||cursorTime===readTime&&cursor?.state!==draft.state)){
      if(existing)return existing;
      fail('방금 GitLab 활동 상태가 변경되었습니다. 다시 확인해 주세요.',409);
    }
    const {sourceBranch,sourceSha,...identity}=snapshot;
    const verified:GitlabLink=existing?refreshExistingLink(existing,draft,token,approvalAt):{...identity,manualLinkId:randomUUID(),
      title:manualTitle(snapshot.title,token)||`GitLab #${snapshot.iid}`,
      state:bound(safePreviewValue(snapshot.state,token),100)||'unknown',
      ...(sourceBranch?{sourceBranch:safePreviewValue(sourceBranch,token).slice(0,512)}:{}),
      ...(sourceSha?{sourceSha:safePreviewValue(sourceSha,token).slice(0,128)}:{}),
    };
    return verified.webUrl===snapshot.webUrl?verified:{...verified,webUrl:snapshot.webUrl};
  }
  private hasConflictingMergeRequestCursor(instance: string, repositoryId: number, draft: LinkDraft, startedAt: string): boolean {
    const cursor = this.store.get<ObjectCursor>('gitlab_object_cursors', `${instance}:${repositoryId}:merge_request:${draft.id}`);
    if (!cursor) return false;
    const difference = Date.parse(cursor.occurredAt ?? '') - Date.parse(draft.incomingTime ?? '');
    return Date.parse(cursor.receivedAt ?? '') >= Date.parse(startedAt) || difference > 0 || difference === 0 && cursor.state !== draft.state;
  }
  private recordMergeRequestRead(instance: string, draft: LinkDraft, startedAt: string): void {
    const read = draft.exactMergeRequestRead;
    if (read && !this.hasConflictingMergeRequestCursor(instance, read.repositoryId, draft, startedAt)) {
      this.mergeRequestObservations.record({ instance, ...read, source: 'read' });
    }
  }
  private hasConflictingMergeRequestRead(instance: string, repositoryId: number, draft: LinkDraft): boolean {
    if (!draft.numericId || draft.id !== draft.numericId) return false;
    const prior = this.mergeRequestObservations.get(instance, repositoryId, draft.numericId);
    if (!prior) return false;
    const read = draft.exactMergeRequestRead;
    return !read || prior.iid !== read.iid || prior.updatedAt > read.updatedAt ||
      (prior.updatedAt === read.updatedAt && prior.state !== read.state);
  }
  async pipelineJobs(issueId: string, linkId: string, signal: AbortSignal): Promise<GitlabPipelineJobs> {
    return this.readLinkedPipeline(issueId, linkId, signal, 'GitLab CI 작업', readGitlabPipelineJobs);
  }
  async pipelineTestReport(issueId: string, linkId: string, signal: AbortSignal): Promise<GitlabPipelineTestReport> {
    return this.readLinkedPipeline(issueId, linkId, signal, 'GitLab 테스트 결과', readGitlabPipelineTestReport);
  }
  async pipelineFailedTests(issueId: string, linkId: string, signal: AbortSignal): Promise<GitlabPipelineFailedTests> {
    return this.readLinkedPipeline(issueId, linkId, signal, 'GitLab 실패 테스트 상세', readGitlabPipelineFailedTests);
  }
  private async readLinkedPipeline<Result>(issueId: string, linkId: string, signal: AbortSignal, description: string,
    read: (connection: { baseUrl: string; token: string | null }, repositoryId: number, pipelineId: number,
      expectedSha: string | null, signal: AbortSignal) => Promise<Result>) {
    if (!linkId || linkId.length > 500) fail('연결된 GitLab 파이프라인을 선택해 주세요.');
    const issue = this.requireIssue(issueId);
    const link = this.store.get<GitlabLink>('gitlab_links', linkId);
    if (!link || link.issueId !== issueId || link.kind !== 'pipeline') fail('업무에 연결된 GitLab 파이프라인을 찾을 수 없습니다.', 404);
    const captured = this.raw();
    if (!captured.baseUrl || !captured.projectIds.includes(link.projectId)) fail('현재 GitLab 연결에 이 저장소가 없습니다.', 403);
    const target = linkedWorkflowTarget(link, issueId, this.instance(captured));
    if (!target) fail('현재 GitLab 연결에서 파이프라인의 식별자를 확인할 수 없습니다.', 409);
    const workspaceGeneration = this.store.setting('attachmentImportGeneration');
    const token = captured.token ? this.store.unseal(captured.token) : null;
    const deadline = AbortSignal.timeout(25_000);
    let result: Result;
    try {
      result = await read({ baseUrl: captured.baseUrl, token }, link.projectId, target.objectId,
        gitlabObjectSha(link.sourceSha), AbortSignal.any([signal, deadline]));
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.aborted) fail(`${description} 조회 시간이 초과되었습니다.`, 504);
      if (!(error instanceof GitlabReadError)) throw error;
      failGitlabWorkflowRead(error);
    }
    signal.throwIfAborted();
    assertSettingsVersion(captured.version, this.raw().version);
    if (this.store.setting('attachmentImportGeneration') !== workspaceGeneration) fail('워크스페이스가 복원되었습니다. 업무를 다시 열어 주세요.', 409);
    const latestIssue = this.store.get<Issue>('issues', issueId);
    const latestLink = this.store.get<GitlabLink>('gitlab_links', linkId);
    if (!latestIssue || latestIssue.projectId !== issue.projectId || latestIssue.key !== issue.key ||
        !latestLink || latestLink.issueId !== issueId || latestLink.projectId !== link.projectId || latestLink.kind !== link.kind ||
        latestLink.manualLinkId !== link.manualLinkId || latestLink.sourceBranch !== link.sourceBranch || latestLink.sourceSha !== link.sourceSha || latestLink.state !== link.state ||
        latestLink.webUrl !== link.webUrl || latestLink.updatedAt !== link.updatedAt || latestLink.pipelineObservedAt !== link.pipelineObservedAt) {
      fail('GitLab 파이프라인 연결이 변경되었습니다. 최신 업무에서 다시 확인해 주세요.', 409);
    }
    return { ...result, linkId, repositoryId: link.projectId, pipelineId: target.objectId, checkedAt: now() };
  }
  async mergeRequestReview(issueId: string, linkId: string, signal: AbortSignal): Promise<GitlabMergeRequestReview> {
    const { result, response } = await this.readLinkedMergeRequest(issueId, linkId, signal, 'GitLab MR 검토 정보', readGitlabMergeRequestReview);
    return { ...result, ...response };
  }
  async verifyManualMergeRequestStatus(issueId: string, binding: GitlabMergeRequestStatusBinding, signal: AbortSignal): Promise<boolean> {
    const startedAt = now();
    try {
      const { context: { link, captured, token }, result: { object } } = await this.readLinkedMergeRequest(
        issueId, binding.proof.linkId, signal, 'GitLab MR 상태', (connection, repositoryId, iid, objectId, readSignal) =>
          gitlabLinkedActivityReader(connection, readSignal).workflow(repositoryId, 'merge_request', iid, objectId));
      const targetBranch = readMergeTargetBranch(object, link.projectId, token, ...this.webhookCredentials(captured));
      const status = workflowStatusRead('merge_request', object, targetBranch);
      if (!status || status.occurredAt !== binding.proof.occurredAt) return false;
      const draft = readLink('merge_request', object, [], keys, { source: 'read', observedAt: startedAt, repositoryId: link.projectId, targetBranch, trackState: true });
      const instance = this.instance(captured);
      if (this.hasConflictingMergeRequestCursor(instance, link.projectId, draft, startedAt) ||
          this.hasConflictingMergeRequestRead(instance, link.projectId, draft)) return false;
      const aliases = this.workflowLinksForObject(instance, link.projectId, 'merge_request', draft.id);
      const observation = confirmWorkflowRead(link, draft, status, aliases)?.observation;
      if (binding.kind === 'opened') {
        return observation?.trigger === 'merge_request.opened' && observation.sourceProjectId === binding.proof.sourceProjectId;
      }
      return observation?.trigger === 'merge_request.closed' &&
        (binding.proof.targetBranch === undefined || observation.targetBranch === binding.proof.targetBranch);
    } catch (error) {
      if (signal.aborted || error instanceof GitlabIntegrationError) return false;
      throw error;
    }
  }
  async verifyManualPipelineStatus(issueId: string, proof: GitlabPipelineStatusBinding, signal: AbortSignal): Promise<boolean> {
    const link = this.store.get<GitlabLink>('gitlab_links', proof.linkId);
    if (!link || link.issueId !== issueId || link.kind !== 'pipeline' || !link.pipelineSource || typeof link.pipelineTag !== 'boolean') return false;
    try {
      const result = await this.readLinkedPipeline(issueId, proof.linkId, signal, 'GitLab 파이프라인 상태',
        async (connection, repositoryId, pipelineId, _expectedSha, readSignal) => {
          const read = gitlabLinkedActivityReader(connection, readSignal);
          const { object } = await read.workflow(repositoryId, 'pipeline', pipelineId, pipelineId);
          const status = workflowStatusRead('pipeline', object, undefined);
          const classification = readPipelineClassification(object, true, connection.token);
          const draft = readLink('pipeline', object, [], keys, undefined, classification);
          if (!status || status.occurredAt !== proof.occurredAt || !confirmWorkflowRead(link, draft, status, [])?.observation ||
              classification.pipelineSource !== link.pipelineSource || classification.pipelineTag !== link.pipelineTag) return { latest: false };
          const freshness = await readGitlabWorkflowPipelineFreshness(read, repositoryId, object, readSignal);
          return { latest: freshness.kind === 'latest' };
        });
      const newest = this.latestVerifiedPipelineId(link);
      return result.latest && (newest === null || newest <= result.pipelineId) && this.latestNewerLinkedPipelineId(link) === null;
    } catch (error) {
      if (signal.aborted || error instanceof GitlabIntegrationError) return false;
      throw error;
    }
  }
  async mergeRequestDiscussions(issueId: string, linkId: string, signal: AbortSignal): Promise<GitlabMergeRequestDiscussions> {
    const { result, response } = await this.readLinkedMergeRequest(issueId, linkId, signal, 'GitLab MR 토론', readGitlabMergeRequestDiscussions);
    return { ...result, ...response };
  }
  private async mergeRequestPipeline(issueId: string, linkId: string, signal: AbortSignal, includeJobs: boolean): Promise<GitlabMergeRequestPipeline> {
    const { result, context, response } = await this.readLinkedMergeRequestPipeline(issueId, linkId, signal, { includeJobs });
    if (result.kind !== 'pipeline') return { ...response, kind: result.kind };
    const { pipeline, jobs } = result;
    return {
      ...response,
      kind: 'pipeline',
      pipeline,
      revision: this.mergeRequestPipelineRevision(context, result),
      ...(jobs ? { jobs: { ...jobs, linkId, repositoryId: pipeline.repositoryId, pipelineId: pipeline.pipelineId, checkedAt: response.checkedAt } } : {}),
    };
  }
  private readLinkedMergeRequestPipeline(issueId: string, linkId: string, signal: AbortSignal,
    { includeJobs, attaching = false }: { includeJobs: boolean; attaching?: boolean }) {
    return this.readLinkedMergeRequest(issueId, linkId, signal, 'GitLab MR 파이프라인',
      (connection, repositoryId, iid, objectId, readSignal) =>
        readGitlabMergeRequestPipeline(connection, repositoryId, iid, objectId, includeJobs, readSignal), attaching);
  }
  private async readMergeRequestPipelineTestInfo<Report>(issueId: string, linkId: string, signal: AbortSignal, revision: string | null,
    description: string, readReport: (readers: MergeRequestPipelineTestReaders) => Promise<Report>) {
    const changed = () => fail('GitLab MR 또는 최신 파이프라인이 변경되었습니다. 다시 확인해 주세요.', 409);
    const { result, response } = await this.readLinkedMergeRequest(issueId, linkId, signal, description,
      (connection, repositoryId, iid, objectId, readSignal, context) =>
        readGitlabMergeRequestPipeline(connection, repositoryId, iid, objectId, false, readSignal, (selected, readers) => {
          context.assertCurrent();
          if (this.mergeRequestPipelineRevision(context, selected) !== revision) changed();
          return readReport(readers);
        }));
    if (result.kind !== 'pipeline' || result.report === undefined) return changed();
    const { repositoryId, pipelineId } = result.pipeline;
    return { ...result.report, linkId, repositoryId, pipelineId, checkedAt: response.checkedAt };
  }
  private mergeRequestPipelineRevision(context: LinkedMergeRequestReadContext,
    result: Extract<Awaited<ReturnType<typeof readGitlabMergeRequestPipeline>>, { kind: 'pipeline' }>) {
    const { issue, link, captured, workspaceGeneration } = context;
    const { sourceHead, sourceProjectId } = result.verification;
    const { repositoryId, pipelineId, sha } = result.pipeline;
    return createHash('sha256').update(JSON.stringify([
      workspaceGeneration, captured.version, captured.baseUrl, issue.id, issue.projectId, issue.key, link,
      sourceProjectId, sourceHead, repositoryId, pipelineId, sha,
    ])).digest('hex');
  }
  private async attachMergeRequestPipeline(issueId: string, linkId: string, value: unknown, afterAttach: (link: GitlabLink) => void, signal: AbortSignal) {
    const input = record(value);
    const { repositoryId, pipelineId, sha, revision, actorId } = input;
    if (Object.keys(input).some(key => !['repositoryId', 'pipelineId', 'sha', 'revision', 'actorId'].includes(key)) ||
        typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
        typeof pipelineId !== 'number' || !Number.isSafeInteger(pipelineId) || pipelineId < 1 ||
        typeof sha !== 'string' || gitlabObjectSha(sha) !== sha || /^0+$/u.test(sha) ||
        typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision) ||
        (actorId !== undefined && (typeof actorId !== 'string' || !actorId.trim()))) {
      fail('업무에 연결할 GitLab MR 파이프라인 정보를 확인해 주세요.');
    }
    const startedAt = now();
    const { result, context } = await this.readLinkedMergeRequestPipeline(issueId, linkId, signal, { includeJobs: false, attaching: true });
    if (result.kind !== 'pipeline' || result.pipeline.repositoryId !== repositoryId ||
        result.pipeline.pipelineId !== pipelineId || result.pipeline.sha !== sha ||
        this.mergeRequestPipelineRevision(context, result) !== revision) {
      fail('GitLab MR 또는 최신 파이프라인이 변경되었습니다. 다시 확인해 주세요.', 409);
    }
    const { issue, captured, token, assertCurrent } = context;
    const instance = this.instance(captured);
    const object = result.verification.pipelineObject;
    const observed = readLink('pipeline', {
      ...object,
      sha,
      web_url: result.pipeline.webUrl,
      state: result.pipeline.status,
      iid: Number(numericObjectId(object.iid) || numericObjectId(object.id)),
    }, [], keys, undefined, readPipelineClassification(object, true, token));
    return this.store.transaction(() => {
      assertCurrent();
      const aliases = this.workflowLinksForObject(instance, repositoryId, 'pipeline', observed.id);
      const draft = this.classifyReadPipeline(instance, repositoryId, observed, aliases);
      if (!draft) fail('GitLab 파이프라인의 실행 정보가 기존 연결과 다릅니다. 최신 활동을 다시 확인해 주세요.', 409);
      const snapshot = linkForIssue(instance, repositoryId, 'pipeline', { issue }, draft);
      const existing = this.store.get<GitlabLink>('gitlab_links', snapshot.id);
      if (existing) {
        const target = linkedWorkflowTarget(existing, issueId, instance);
        if (target?.kind !== 'pipeline' || target.objectId !== pipelineId || existing.projectId !== repositoryId ||
            !isRestorableGitlabLink(existing) || !matchesManualLink(existing, draft)) {
          fail('저장한 GitLab 파이프라인의 식별자가 일치하지 않습니다.', 409);
        }
        return { link: existing, created: false };
      }
      const link = this.verifiedWorkflowAttachment('pipeline', instance, snapshot, draft, undefined, token, startedAt);
      if (!isRestorableGitlabLink(link)) fail('GitLab 활동의 저장 정보를 확인할 수 없습니다.', 502);
      this.store.put('gitlab_links', link);
      afterAttach(link);
      return { link, created: true };
    });
  }
  private async readLinkedMergeRequest<Result>(issueId: string, linkId: string, signal: AbortSignal, description: string,
    read: (connection: { baseUrl: string; token: string | null; projectIds: readonly number[] }, repositoryId: number, iid: number,
      objectId: number, signal: AbortSignal, context: LinkedMergeRequestReadContext) => Promise<Result>, attaching = false) {
    if (!linkId || linkId.length > 500) fail('연결된 GitLab MR을 선택해 주세요.');
    const issue = this.requireIssue(issueId);
    const link = this.store.get<GitlabLink>('gitlab_links', linkId);
    if (!link || link.issueId !== issueId || link.kind !== 'merge_request') fail('업무에 연결된 GitLab MR을 찾을 수 없습니다.', 404);
    const captured = this.raw();
    if (!captured.baseUrl || !captured.projectIds.includes(link.projectId)) fail('현재 GitLab 연결에 이 저장소가 없습니다.', attaching ? 409 : 403);
    const target = linkedWorkflowTarget(link, issueId, this.instance(captured));
    if (!target) fail('현재 GitLab 연결에서 MR의 식별자를 확인할 수 없습니다.', 409);
    const workspaceGeneration = this.store.setting('attachmentImportGeneration');
    const token = captured.token ? this.store.unseal(captured.token) : null;
    const deadline = AbortSignal.timeout(25_000);
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertSettingsVersion(captured.version, this.raw().version);
      if (this.store.setting('attachmentImportGeneration') !== workspaceGeneration) fail('워크스페이스가 복원되었습니다. 업무를 다시 열어 주세요.', 409);
      const latestIssue = this.store.get<Issue>('issues', issueId);
      const latestLink = this.store.get<GitlabLink>('gitlab_links', linkId);
      if (!latestIssue || latestIssue.projectId !== issue.projectId || latestIssue.key !== issue.key ||
          !latestLink || JSON.stringify(latestLink) !== JSON.stringify(link)) {
        fail('GitLab MR 연결이 변경되었습니다. 최신 업무에서 다시 확인해 주세요.', 409);
      }
      if (deadline.aborted) fail(`${description} 조회 시간이 초과되었습니다.`, 504);
    };
    const context = { issue, link, captured, workspaceGeneration, token, assertCurrent };
    let result: Result;
    try {
      result = await read({ baseUrl: captured.baseUrl, token, projectIds: captured.projectIds },
        link.projectId, target.id, target.objectId, AbortSignal.any([signal, deadline]), context);
    } catch (error) {
      assertCurrent();
      if (!(error instanceof GitlabReadError)) throw error;
      if (error.stage === 'merge-request-discussions') {
        if (error.httpStatus === 404) fail('GitLab에서 이 MR의 토론을 조회할 수 없습니다.', 404);
        if (error.httpStatus === 405 || error.httpStatus === 501) fail('이 GitLab 연결에서는 MR 토론 조회를 지원하지 않습니다.', 501);
      }
      failGitlabWorkflowRead(error);
    }
    assertCurrent();
    return { result, context,
      response: { linkId, repositoryId: link.projectId, mergeRequestIid: target.id, checkedAt: now() } };
  }
  private branchMergeRequestContext(issueId: string, linkId: string) {
    if (!linkId || linkId.length > 500) fail('연결된 GitLab 브랜치를 선택해 주세요.');
    const issue = this.requireIssue(issueId);
    const link = this.store.get<GitlabLink>('gitlab_links', linkId);
    if (!link || link.issueId !== issueId || link.kind !== 'branch' || link.state !== 'active') {
      fail('업무에 연결된 활성 GitLab 브랜치를 찾을 수 없습니다.', 404);
    }
    const captured = this.raw();
    if (!captured.baseUrl || !captured.projectIds.includes(link.projectId)) fail('현재 GitLab 연결에 이 저장소가 없습니다.', 403);
    const source = linkedBranchTarget(link, issueId, this.instance(captured));
    if (!source || !link.webUrl.startsWith(`${captured.baseUrl}/`)) {
      fail('현재 GitLab 연결에서 브랜치의 식별자를 확인할 수 없습니다.', 409);
    }
    const workspaceGeneration = this.store.setting('attachmentImportGeneration');
    const linkSnapshot = JSON.stringify(link);
    const branchRevision = createHash('sha256').update(JSON.stringify([
      workspaceGeneration, captured.version, issue.id, issue.projectId, issue.version, issue.key, issue.title, linkSnapshot,
    ])).digest('hex');
    const assertCurrent = () => {
      assertSettingsVersion(captured.version, this.raw().version);
      if (this.store.setting('attachmentImportGeneration') !== workspaceGeneration) fail('워크스페이스가 복원되었습니다. 업무를 다시 열어 주세요.', 409);
      const latestIssue = this.store.get<Issue>('issues', issueId);
      const latestLink = this.store.get<GitlabLink>('gitlab_links', linkId);
      if (!latestIssue || latestIssue.version !== issue.version || latestIssue.projectId !== issue.projectId ||
          latestIssue.key !== issue.key || latestIssue.title !== issue.title ||
          JSON.stringify(latestLink) !== linkSnapshot) {
        fail('GitLab 브랜치 연결이나 업무가 변경되었습니다. 최신 업무에서 다시 확인해 주세요.', 409);
      }
    };
    return { issue, link, sourceBranch: source.branch, captured, branchRevision, assertCurrent };
  }
  async branchMergeRequests(issueId: string, linkId: string, signal: AbortSignal, targetBranch: string | null): Promise<GitlabBranchMergeRequests> {
    const context = this.branchMergeRequestContext(issueId, linkId);
    const { issue, link, sourceBranch, captured, branchRevision } = context;
    const token = captured.token ? this.store.unseal(captured.token) : null;
    const deadline = AbortSignal.timeout(25_000);
    const assertCurrent = () => {
      signal.throwIfAborted();
      context.assertCurrent();
      if (deadline.aborted) fail('GitLab 브랜치의 MR 조회 시간이 초과되었습니다.', 504);
    };
    let result: Awaited<ReturnType<typeof readGitlabBranchMergeRequests>>;
    try {
      result = await readGitlabBranchMergeRequests({ baseUrl: captured.baseUrl, token }, link.projectId, sourceBranch,
        targetBranch, AbortSignal.any([signal, deadline]));
    } catch (error) {
      assertCurrent();
      if (!(error instanceof GitlabReadError)) throw error;
      failGitlabWorkflowRead(error);
    }
    assertCurrent();
    const suggestedTitle = `[${issue.key}] ${issue.title}`.replace(/[\s\p{Cc}]+/gu, ' ').trim().toWellFormed()
      .slice(0, 255).replace(/[\uD800-\uDBFF]$/u, '');
    return { ...result, linkId, repositoryId: link.projectId, branchRevision, suggestedTitle, checkedAt: now() };
  }
  private async attachBranchMergeRequest(issueId: string, linkId: string, value: unknown, afterAttach: (link: GitlabLink) => void, signal: AbortSignal) {
    const input = record(value);
    const { mergeRequestId, mergeRequestIid, targetBranch, branchRevision, actorId } = input;
    if (Object.keys(input).some(key => !['mergeRequestId', 'mergeRequestIid', 'targetBranch', 'branchRevision', 'actorId'].includes(key)) ||
        typeof mergeRequestId !== 'number' || !Number.isSafeInteger(mergeRequestId) || mergeRequestId < 1 ||
        typeof mergeRequestIid !== 'number' || !Number.isSafeInteger(mergeRequestIid) || mergeRequestIid < 1 || !isGitlabBranchName(targetBranch) ||
        typeof branchRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(branchRevision) ||
        (actorId !== undefined && (typeof actorId !== 'string' || !actorId.trim()))) {
      fail('브랜치에 연결할 GitLab MR의 정보를 확인해 주세요.');
    }
    const context = this.branchMergeRequestContext(issueId, linkId);
    const { link, sourceBranch, captured } = context;
    if (branchRevision !== context.branchRevision) fail('GitLab 브랜치 연결이나 업무가 변경되었습니다. MR을 다시 확인해 주세요.', 409);
    if (targetBranch === sourceBranch) fail('소스 브랜치와 다른 대상 브랜치의 MR을 선택해 주세요.');
    const url = new URL(link.webUrl);
    const branchSuffix = `/-/tree/${encodeURIComponent(sourceBranch)}`;
    url.pathname = `${url.pathname.slice(0, -branchSuffix.length)}/-/merge_requests/${mergeRequestIid}`;
    const deadline = AbortSignal.timeout(25_000);
    const assertCurrent = () => {
      signal.throwIfAborted();
      context.assertCurrent();
      if (deadline.aborted) fail('GitLab MR 연결 확인 시간이 초과되었습니다.', 504);
    };
    const assertMergeRequest = ({ kind, object }: VerifiedGitlabActivity, existing: GitlabLink | undefined) => {
      const savedBindingMatches = !existing || (existing.issueId === issueId && existing.projectId === link.projectId &&
        existing.kind === 'merge_request' && existing.iid === mergeRequestIid);
      const existingClosed = existing && (object.state === 'closed' || object.state === 'merged');
      if (!savedBindingMatches || kind !== 'merge_request' || object.id !== mergeRequestId || object.iid !== mergeRequestIid ||
          (object.state !== 'opened' && !existingClosed) ||
          object.source_branch !== sourceBranch || object.target_branch !== targetBranch ||
          object.source_project_id !== link.projectId || object.target_project_id !== link.projectId) {
        fail('GitLab MR이 변경되었습니다. 브랜치의 MR을 다시 확인해 주세요.', 409);
      }
    };
    return this.attachLink(issueId, { repositoryId: link.projectId, url: url.href, expectedSettingsVersion: captured.version },
      afterAttach, AbortSignal.any([signal, deadline]), { assertCurrent, assertMergeRequest });
  }
  private pipelineObjectCursor(instance: string, repositoryId: number, objectId: string | number): ObjectCursor | undefined {
    return this.store.get<ObjectCursor>('gitlab_object_cursors', `${instance}:${repositoryId}:pipeline:${objectId}`);
  }
  private classifyReadPipeline(instance: string, repositoryId: number, draft: LinkDraft, aliases: readonly GitlabLink[]): LinkDraft | null {
    return classifyPipelineDraft(draft, aliases, this.pipelineObjectCursor(instance, repositoryId, draft.id)?.pipeline);
  }
  private latestCompatiblePipelineId(instance: string, repositoryId: number, ref: string, classification: PipelineClassification): number | null {
    const scope = `${instance}:${repositoryId}:${ref}`;
    const source = gitlabPipelineSource(classification.pipelineSource) ?? null;
    const tag = typeof classification.pipelineTag === 'boolean' ? Number(classification.pipelineTag) : null;
    const cursor = this.compatiblePipelineCursor.get(scope, source, source, tag, tag) as { pipelineId: number } | undefined;
    const legacy = this.store.get<BranchCursor>('gitlab_branch_cursors', scope);
    let legacyId = legacy?.pipelineId;
    if (legacyId && (source !== null || tag !== null)) {
      const original = this.pipelineObjectCursor(instance, repositoryId, legacyId);
      const proof = original?.pipeline?.scope === scope ? original.pipeline : original?.occurredAt
        ? knownPipelineClassification(this.workflowLinksForObject(instance, repositoryId, 'pipeline', String(legacyId)).filter(link =>
          link.sourceBranch === ref && link.pipelineObservedAt === original.occurredAt && link.state === original.state)) : null;
      // Legacy rows lack source/tag. Only narrow a floor when the exact observation identifies it.
      if (proof && conflictingPipelineClassification(classification, proof)) legacyId = undefined;
    }
    return Math.max(cursor?.pipelineId ?? 0, legacyId ?? 0) || null;
  }
  latestVerifiedPipelineId(link: GitlabLink): number | null {
    if (link.kind !== 'pipeline' || !isGitlabBranchName(link.sourceBranch)) return null;
    const identity = gitlabPipelineLinkIdentity(link);
    if (!identity) return null;
    return this.latestCompatiblePipelineId(identity.instance, link.projectId, link.sourceBranch, link);
  }

  private latestNewerLinkedPipelineId(link: GitlabLink): number | null {
    if (link.kind !== 'pipeline' || !isGitlabBranchName(link.sourceBranch)) return null;
    const identity = gitlabPipelineLinkIdentity(link);
    if (!identity) return null;
    const prefix = `gitlab:${identity.instance}:${link.projectId}:pipeline`;
    const rows = this.store.db.prepare(`SELECT json FROM gitlab_links WHERE issue_id=? AND id>=? AND id<?
      AND json_extract(json,'$.sourceBranch')=?`).iterate(link.issueId, `${prefix}:`, `${prefix};`, link.sourceBranch) as Iterable<{ json: string }>;
    let latest = identity.objectId;
    for (const { json } of rows) {
      const candidate = JSON.parse(json) as GitlabLink;
      // A link without a verified observation can have an IID in the object-ID slot.
      if (candidate.kind !== 'pipeline' || candidate.pipelineObservedAt === null) continue;
      const candidateIdentity = gitlabPipelineLinkIdentity(candidate);
      if (candidateIdentity && candidateIdentity.objectId > latest && !conflictingPipelineClassification(link, candidate)) {
        latest = candidateIdentity.objectId;
      }
    }
    return latest === identity.objectId ? null : latest;
  }

  private selectedPipelineReview(link: GitlabLink, freshness: GitlabWorkflowPipelineFreshness | undefined,
    captured: RawSettings, token: string | null): GitlabIssueRefreshResult['pipelineReview'] {
    if (!freshness) return;
    const identity = gitlabPipelineLinkIdentity(link);
    if (!identity) return;
    const observedFloor = Math.max(this.latestVerifiedPipelineId(link) ?? 0, this.latestNewerLinkedPipelineId(link) ?? 0);
    if (freshness.kind !== 'superseded') {
      if (freshness.kind === 'unverified' || observedFloor > identity.objectId) return { superseded: 0, unverified: 1 };
      return;
    }
    const replacement = freshness.replacement;
    if (replacement && replacement.pipelineId > identity.objectId && replacement.pipelineId >= observedFloor && replacement.repositoryId === link.projectId &&
        replacement.ref === link.sourceBranch && replacement.source === link.pipelineSource && replacement.tag === link.pipelineTag &&
        ![token, ...this.webhookCredentials(captured)].some(secret => includesGitlabCredential(secret,
          [replacement.webUrl, replacement.status, replacement.ref, replacement.source, replacement.sha]))) {
      const { instance } = identity;
      const { repositoryId, pipelineId, sha: sourceSha, ref: sourceBranch, source: pipelineSource, tag: pipelineTag } = replacement;
      const evidence = { sourceSha, sourceBranch, pipelineSource, pipelineTag };
      const cursor = this.pipelineObjectCursor(instance, repositoryId, pipelineId)?.pipeline;
      const aliases = this.workflowLinksForObject(instance, repositoryId, 'pipeline', String(pipelineId))
        .filter(alias => alias.pipelineObservedAt !== null);
      const known = cursor ? [cursor, ...aliases] : aliases;
      if (known.every(prior => samePipelineRevision(prior, evidence) && !conflictingPipelineClassification(prior, evidence))) {
        return { superseded: 1, unverified: 0, replacement: { linkId: link.id, ...replacement } };
      }
    }
    return { superseded: 1, unverified: 0 };
  }

  async refreshIssueLinks(issueId:string, value:unknown, signal?:AbortSignal, actorId?:string, linkId?:string,
    reviewSelected = false):Promise<GitlabIssueRefreshResult> {
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'actorId'))) fail('GitLab 활동 갱신 요청을 확인해 주세요.');
    const issue = this.requireIssue(issueId);
    const captured = this.raw();
    const workspaceGeneration = this.store.setting('attachmentImportGeneration');
    const result: GitlabIssueRefreshResult = { links:[], failures:[], skipped:0 };
    let selected: GitlabLink[];
    if (linkId !== undefined) {
      if (!linkId || linkId.length > 500) fail('갱신할 GitLab 활동을 선택해 주세요.');
      const link = this.store.get<GitlabLink>('gitlab_links',linkId);
      if (!link || link.issueId !== issueId) fail('업무에 연결된 GitLab 활동을 찾을 수 없습니다.',404);
      if (link.kind !== 'merge_request' && link.kind !== 'pipeline') {
        if (reviewSelected) fail('상태 변경을 검토할 MR 또는 파이프라인을 선택해 주세요.');
        if (link.kind !== 'branch' || link.state !== 'active') fail('연결된 MR, 파이프라인 또는 활성 브랜치를 선택해 주세요.');
      }
      selected = [link];
    } else {
      const rows = this.store.db.prepare(`SELECT json, COUNT(*) OVER() AS total FROM gitlab_links WHERE issue_id=?
        AND json_extract(json, '$.kind') IN ('merge_request', 'pipeline', 'branch')
        ORDER BY julianday(json_extract(json, '$.updatedAt')) DESC, id LIMIT ?`)
        .all(issue.id, ISSUE_REFRESH_LINK_LIMIT) as { json:string; total:number }[];
      result.skipped = Math.max(0, (rows[0]?.total ?? 0) - rows.length);
      selected = rows.map(({ json }) => JSON.parse(json) as GitlabLink);
    }
    if (!selected.length) return result;
    const reviewActorId = linkId === undefined || reviewSelected ? actorId : undefined;

    const instance = this.instance(captured);
    const token = captured.token ? this.store.unseal(captured.token) : null;
    const startedAt = now();
    const read = gitlabLinkedActivityReader({ baseUrl:captured.baseUrl, token }, signal);
    type ReadOutcome = { link:GitlabLink; kind:WorkflowGitlabKind; draft:LinkDraft; status:WorkflowStatusRead|null; freshness?: GitlabWorkflowPipelineFreshness } |
      { link:GitlabLink; kind:'branch'; branch:string; cursorId:string; cursor:PushObservation|undefined; aliases:GitlabLink[]; sourceSha:string; webUrl:string } |
      { link:GitlabLink; message:string };
    const readLinkRow = async (link:GitlabLink):Promise<ReadOutcome> => {
      if (!captured.baseUrl || !captured.projectIds.includes(link.projectId)) {
        return { link, message:'현재 GitLab 연결에 이 저장소가 없습니다.' };
      }
      try {
        if (link.kind === 'branch') {
          const target = linkedBranchTarget(link, issueId, instance);
          if (!target) {
            return { link, message:'현재 GitLab 연결에서 브랜치의 식별자를 확인할 수 없습니다.' };
          }
          const { branch, cursorId } = target;
          const cursor = this.store.get<PushObservation>('gitlab_push_cursors',cursorId);
          const aliases = this.branchLinksForKey(cursorId,link.projectId,branch);
          return { link, kind:'branch', branch, cursorId, cursor, aliases, ...await read.branch(link.projectId,branch) };
        }
        const target = linkedWorkflowTarget(link, issueId, instance);
        if (!target) return { link, message:'현재 GitLab 연결에서 이 활동의 식별자를 확인할 수 없습니다.' };
        const { object } = await read.workflow(link.projectId, target.kind, target.id, target.objectId);
        const targetBranch = target.kind === 'merge_request' ? readMergeTargetBranch(object, link.projectId, token, ...this.webhookCredentials(captured)) : undefined;
        const draft = readLink(target.kind, object, [], keys, { source:'read', observedAt:startedAt, repositoryId:link.projectId, targetBranch, trackState:true },
          target.kind==='pipeline'?readPipelineClassification(object,true,token):undefined);
        const status = reviewActorId && this.hooks.manualStatusReview ? workflowStatusRead(target.kind,object,targetBranch) : null;
        let freshness: GitlabWorkflowPipelineFreshness | undefined;
        if (target.kind === 'pipeline' && samePipelineRevision(link, draft) &&
            (status?.trigger === 'pipeline.succeeded' || status?.trigger === 'pipeline.failed') && status.occurredAt &&
            this.hooks.requiresManualPipelineVerification?.(issue, { trigger: status.trigger, occurredAt: status.occurredAt,
              gitlabProjectId: link.projectId, branch: draft.sourceBranch,
              pipelineSource: draft.pipelineClassification.pipelineSource ?? link.pipelineSource,
              pipelineTag: draft.pipelineClassification.pipelineTag ?? link.pipelineTag }) !== false) {
          freshness = await readGitlabWorkflowPipelineFreshness(read, link.projectId, object, signal);
        }
        return { link, kind:target.kind, draft, status, freshness };
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof GitlabReadError)) throw error;
        if (link.kind === 'branch' && error.stage === 'branches' && error.httpStatus === 404) {
          return { link, message:'GitLab에서 브랜치를 확인하지 못했습니다. 기존 브랜치 상태를 유지합니다.' };
        }
        return { link, message:error.message };
      }
    };

    const outcomes:ReadOutcome[] = [];
    for (let offset = 0; offset < selected.length; offset += ISSUE_REFRESH_CONCURRENCY) {
      signal?.throwIfAborted();
      assertSettingsVersion(captured.version, this.raw().version);
      const batch = selected.slice(offset, offset + ISSUE_REFRESH_CONCURRENCY).map(readLinkRow);
      outcomes.push(...await Promise.all(batch));
    }
    signal?.throwIfAborted();
    return this.store.transaction(() => {
      assertSettingsVersion(captured.version, this.raw().version);
      if (this.store.setting('attachmentImportGeneration') !== workspaceGeneration) fail('워크스페이스가 복원되었습니다. 업무를 다시 열어 주세요.',409);
      const latestIssue = this.requireIssue(issueId);
      if (latestIssue.projectId !== issue.projectId || latestIssue.key !== issue.key) fail('업무가 다른 프로젝트로 이동했습니다. 최신 업무에서 다시 확인해 주세요.',409);
      const checked: ConfirmedWorkflowRead[] = [];
      const freshnessByLink = new Map<string, GitlabWorkflowPipelineFreshness>();
      for (const outcome of outcomes) {
        const { link } = outcome;
        if ('message' in outcome) {
          result.failures.push({ linkId:link.id, message:outcome.message });
          continue;
        }
        const latest = this.store.get<GitlabLink>('gitlab_links',link.id);
        if (!latest || latest.issueId!==issueId || latest.projectId!==link.projectId || latest.kind!==link.kind ||
            (latest.kind==='merge_request'&&latest.iid!==link.iid) || latest.manualLinkId!==link.manualLinkId) {
          result.failures.push({ linkId:link.id, message:'GitLab 활동 연결이 변경되었습니다. 최신 업무에서 다시 확인해 주세요.' });
          continue;
        }
        if (outcome.kind === 'branch') {
          const { branch, cursorId, sourceSha, webUrl } = outcome;
          const cursor = this.store.get<PushObservation>('gitlab_push_cursors',cursorId);
          const aliases = this.branchLinksForKey(cursorId,link.projectId,branch);
          if (JSON.stringify(latest)!==JSON.stringify(link) || JSON.stringify(cursor)!==JSON.stringify(outcome.cursor) ||
              JSON.stringify(aliases)!==JSON.stringify(outcome.aliases)) {
            result.failures.push({ linkId:link.id, message:'브랜치 상태가 변경되었습니다. 최신 업무에서 다시 확인해 주세요.' });
            continue;
          }
          const observation:PushObservation = { id:cursorId, state:'active', sourceSha, webUrl, updatedAt:now(), source:'read', revision:randomUUID() };
          const fields = branchLinkFields(observation);
          const updated = refreshAttachedBranch(latest,fields);
          if (!isRestorableGitlabLink(updated)) {
            result.failures.push({ linkId:link.id, message:'GitLab 브랜치의 저장 정보를 확인할 수 없습니다.' });
            continue;
          }
          // A checked head anchors later pushes, including when the visible link has not changed.
          this.store.put('gitlab_push_cursors',observation);
          for (const alias of aliases) {
            const next = refreshAttachedBranch(alias,fields);
            if (next !== alias) this.store.put('gitlab_links',next);
          }
          result.links.push(updated);
          continue;
        }
        const { kind, draft: observed } = outcome;
        if (kind === 'pipeline' && !samePipelineRevision(latest,observed)) {
          result.failures.push({ linkId:link.id, message:'GitLab 파이프라인의 브랜치 또는 커밋이 기존 연결과 다릅니다.' });
          continue;
        }
        const aliases = kind === 'pipeline' || reviewActorId && this.hooks.manualStatusReview
          ? this.workflowLinksForObject(instance,link.projectId,kind,observed.id) : [];
        const draft = kind==='pipeline' ? this.classifyReadPipeline(instance,link.projectId,observed,aliases) : observed;
        if (!draft) {
          result.failures.push({ linkId:link.id, message:'GitLab 파이프라인의 실행 정보가 기존 연결과 다릅니다.' });
          continue;
        }
        if (kind === 'pipeline' && !pipelineObservedAt(draft)) {
          result.failures.push({ linkId:link.id, message:'GitLab 파이프라인의 상태나 갱신 시각을 확인할 수 없습니다.' });
          continue;
        }
        if (kind === 'merge_request') {
          this.recordMergeRequestRead(instance,draft,startedAt);
          if (this.hasConflictingMergeRequestRead(instance,link.projectId,draft)) {
            result.failures.push({ linkId:link.id, message:'GitLab MR의 최신 상태와 조회 결과가 다릅니다. 다시 확인해 주세요.' });
            continue;
          }
        }
        const webUrl = latest.webUrl===link.webUrl ? draft.webUrl : latest.webUrl;
        const updated = this.verifiedWorkflowAttachment(kind, instance, { ...latest, webUrl }, draft, latest, token, startedAt);
        if (!isRestorableGitlabLink(updated)) {
          result.failures.push({ linkId:link.id, message:'GitLab 활동의 저장 정보를 확인할 수 없습니다.' });
          continue;
        }
        if (updated !== latest) this.store.put('gitlab_links',updated);
        result.links.push(updated);
        if (reviewActorId && this.hooks.manualStatusReview) {
          const trigger = outcome.status?.trigger;
          const status = (trigger === 'merge_request.opened' || trigger === 'merge_request.closed') &&
            this.hasConflictingMergeRequestCursor(instance, link.projectId, draft, startedAt) ? null : outcome.status;
          const confirmation = confirmWorkflowRead(updated,draft,status,aliases);
          if (confirmation) checked.push(confirmation);
          if (outcome.freshness) freshnessByLink.set(link.id, outcome.freshness);
        }
      }
      if (reviewActorId && this.hooks.manualStatusReview && latestIssue.version === issue.version && checked.some(value => value.observation)) {
        if (!reviewSelected) {
          const current = this.store.db.prepare(`SELECT id FROM gitlab_links WHERE issue_id=?
            AND json_extract(json, '$.kind') IN ('merge_request', 'pipeline') LIMIT ?`)
            .all(issue.id, ISSUE_REFRESH_LINK_LIMIT + 1) as { id:string }[];
          const checkedIds = new Set(checked.map(({ link }) => link.id));
          if (current.length !== checkedIds.size || current.some(({ id }) => !checkedIds.has(id))) return result;
        }
        const observations = currentWorkflowObservations(checked, link => this.latestVerifiedPipelineId(link));
        const selectedPipeline = reviewSelected ? checked[0]?.observation?.link : undefined;
        const selectedReview = selectedPipeline?.kind === 'pipeline'
          ? this.selectedPipelineReview(selectedPipeline, freshnessByLink.get(selectedPipeline.id), captured, token) : undefined;
        const pipelineReview = { superseded: 0, unverified: 0 };
        const verified = observations.filter(({ link }) => {
          if (link.kind !== 'pipeline') return true;
          const freshness = freshnessByLink.get(link.id);
          if (reviewSelected) return !selectedReview && freshness?.kind === 'latest';
          if (freshness?.kind === 'superseded' || freshness?.kind === 'unverified') pipelineReview[freshness.kind]++;
          return freshness?.kind === 'latest';
        });
        if (selectedReview) result.pipelineReview = selectedReview;
        else if (pipelineReview.superseded || pipelineReview.unverified) result.pipelineReview = pipelineReview;
        const review = this.hooks.manualStatusReview(latestIssue,verified,reviewActorId,captured.version);
        if (review) result.statusReview = review;
      }
      return result;
    });
  }
  removeAttachedLink(issueId:string,linkId:string,expectedManualLinkId:unknown,afterRemove?:(link:GitlabLink)=>void):void{
    if(!isGitlabManualLinkId(expectedManualLinkId))fail('해제할 GitLab 수동 연결을 다시 선택해 주세요.');
    this.store.transaction(()=>{
      this.requireIssue(issueId);
      const link=this.store.get<GitlabLink>('gitlab_links',linkId);
      if(link?.issueId!==issueId)fail('업무의 GitLab 활동 연결을 찾을 수 없습니다.',404);
      if(!link.manualLinkId)fail('이 활동은 업무 번호로 자동 연결되었습니다.',409);
      if(link.manualLinkId!==expectedManualLinkId)fail('GitLab 연결이 변경되었습니다. 최신 활동을 확인해 주세요.',409);
      this.store.remove('gitlab_links',linkId);
      afterRemove?.(link);
    });
  }
  configure(value:unknown,afterSave?:(settings:GitlabSettings)=>void):GitlabSettings{return this.store.transaction(()=>{
    const input=record(value),old=this.raw();assertSettingsVersion(input.expectedVersion,old.version);const next={...old};
    if('baseUrl'in input)next.baseUrl=baseUrl(input.baseUrl);
    if(next.baseUrl!==old.baseUrl){next.token=null;next.lastSyncAt=null;next.lastError=null;}
    if('projectIds'in input)next.projectIds=projectIds(input.projectIds);
    const jiraRoutes=this.submittedJiraRoutes(input,old,next.baseUrl,next.projectIds);
    if(jiraRoutes.length)next.jiraRoutes=jiraRoutes;
    else delete next.jiraRoutes;
    let webhookCredentialsChanged = false, readCredentialChanged = false;
    for (const field of ['token', 'webhookSecret', 'signingToken'] as const) {
      if (!Object.hasOwn(input, field)) continue;
      const submitted = credential(input[field]);
      if (submitted && field === 'signingToken') signingKey(submitted);
      if (this.sameCredential(next[field], submitted)) continue;
      if (field === 'token') readCredentialChanged = true;
      else webhookCredentialsChanged = true;
      next[field] = submitted ? this.store.seal(submitted) : null;
    }
    this.invalidateWebhookDeliveries(old, next, webhookCredentialsChanged);
    this.invalidateSyncAttempts(old, next, readCredentialChanged);
    next.version=old.version+1;this.store.setSetting('gitlab',next);this.hooks.onConnectionChanged(this.public(old),this.public(next));afterSave?.(this.public(next));return this.public(next);
  });}
  private sameCredential(stored: string | null | undefined, submitted: string): boolean {
    if (!stored) return !submitted;
    if (!submitted) return false;
    try { return constantEqual(this.store.unseal(stored), submitted); }
    catch { return false; }
  }
  private invalidateWebhookDeliveries(previous: RawSettings, next: RawSettings, credentialsChanged: boolean): void {
    if (previous.baseUrl !== next.baseUrl || credentialsChanged) {
      this.store.db.exec('DELETE FROM gitlab_webhook_deliveries');
      this.webhookReceipts.clear();
      return;
    }
    const allowed = new Set(next.projectIds);
    const previousRoutes = new Map((previous.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    const nextRoutes = new Map((next.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    for (const id of previous.projectIds) {
      if (!allowed.has(id) || previousRoutes.get(id) !== nextRoutes.get(id)) {
        this.store.remove('gitlab_webhook_deliveries', String(id));
        this.webhookReceipts.clear(id);
      }
    }
  }
  private invalidateSyncAttempts(previous: RawSettings, next: RawSettings, readCredentialChanged: boolean): void {
    if (previous.baseUrl !== next.baseUrl || readCredentialChanged) {
      this.syncAttempts.clear();
      return;
    }
    const allowed = new Set(next.projectIds);
    const previousRoutes = new Map((previous.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    const nextRoutes = new Map((next.jiraRoutes ?? []).map(route => [route.repositoryId, jiraSourceId(route)]));
    for (const id of previous.projectIds) {
      if (!allowed.has(id)) this.syncAttempts.remove(id);
      else if (previousRoutes.get(id) !== nextRoutes.get(id)) this.syncAttempts.remove(id, 'activity');
    }
  }
  resetForImport(branchLinks: Iterable<GitlabLink> = []): void {
    this.store.db.exec('DELETE FROM webhook_inbox;DELETE FROM gitlab_object_cursors;DELETE FROM gitlab_branch_cursors;DELETE FROM gitlab_push_cursors;DELETE FROM gitlab_webhook_deliveries;');
    this.webhookReceipts.clear();
    this.syncAttempts.clear();
    const observations = new Map<string, PushObservation>();
    for (const link of branchLinks) {
      const observed = pushObservationFromLink(link);
      if (!observed) continue;
      const previous = observations.get(observed.id);
      if (!previous || Date.parse(previous.updatedAt) < Date.parse(observed.updatedAt)) observations.set(observed.id, observed);
    }
    for (const observed of observations.values()) this.store.put('gitlab_push_cursors', observed);
    const raw = this.raw();
    if(raw.jiraRoutes?.length){
      const sources=new Set(this.jiraSources().map(jiraSourceId));
      raw.jiraRoutes=raw.jiraRoutes.filter(route=>raw.projectIds.includes(route.repositoryId)&&sources.has(jiraSourceId(route)));
      if(!raw.jiraRoutes.length)delete raw.jiraRoutes;
    }
    this.store.setSetting('gitlab', { ...raw, version: raw.version + 1 });
  }
  private authenticate(req:Request,raw:RawSettings):GitlabWebhookDelivery['authentication']{
    if(req.headers['webhook-signature']!==undefined){
      if(!raw.signingToken)fail('Webhook 서명 인증에 실패했습니다.',401);
      const id=req.header('webhook-id')||'',timestamp=req.header('webhook-timestamp')||'',signature=req.header('webhook-signature')||'',body=(req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody;
      if(!id||id.length>200||!/^\d{1,16}$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300||!body||signature.length>2048)fail('Webhook 서명 또는 발생 시각을 확인할 수 없습니다.',401);
      const expected=createHmac('sha256',signingKey(this.store.unseal(raw.signingToken))).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`),body])).digest();let valid=false;
      for(const part of signature.split(/\s+/)){const[version,encoded]=part.split(',');if(version!=='v1'||!encoded)continue;const received=Buffer.from(encoded,'base64');if(received.length===expected.length&&received.toString('base64')===encoded&&timingSafeEqual(received,expected))valid=true;}
      if(!valid)fail('Webhook 서명 인증에 실패했습니다.',401);return 'signing-token';
    }
    if(!raw.webhookSecret){if(raw.signingToken)fail('Webhook 서명이 필요합니다.',401);fail('Webhook 인증이 설정되지 않았습니다.',503);}
    if(!constantEqual(this.store.unseal(raw.webhookSecret),req.header('X-Gitlab-Token')||''))fail('Webhook 인증에 실패했습니다.',401);
    return 'secret-token';
  }
  private ticketMatcher(issues:IssueMatch[],route?:GitlabJiraRoute):TicketMatcher{
    return makeTicketMatcher(issues,route,route?this.hooks.jiraOriginalKeys?.(route)??new Map():new Map());
  }
  private inheritedMatches(projectId:number,branch:string,sha:string,instance:string,matcher:TicketMatcher):TicketMatch[]{
    if(!branch||!sha)return[];
    return this.store.all<GitlabLink>('gitlab_links').flatMap(link=>{
      if(link.kind!=='merge_request'||link.projectId!==projectId||!link.id.startsWith(`gitlab:${instance}:`)||link.sourceBranch!==branch||link.sourceSha!==sha)return[];
      const match=matcher.inherit(link);
      return match?[match]:[];
    });
  }
  private manualLinksForKey(instance:string,projectId:number,kind:GitlabLink['kind'],objectId:string):GitlabLink[]{
    const key=gitlabLinkObjectKey(instance,projectId,kind,objectId);
    const rows=this.manualLinkRows.all(`${key}:`,`${key};`) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as GitlabLink).filter(link=>
      link.id===`${key}:${link.issueId}`&&link.kind===kind&&link.projectId===projectId);
  }
  private manualLinksForObject(instance:string,projectId:number,kind:GitlabLink['kind'],draft:LinkDraft):GitlabLink[]{
    if(kind!=='branch'&&kind!=='commit'&&(!draft.numericId||draft.id!==draft.numericId))return[];
    return this.manualLinksForKey(instance,projectId,kind,draft.id).filter(link=>matchesManualLink(link,draft));
  }
  private workflowLinksForObject(instance:string,projectId:number,kind:WorkflowGitlabKind,objectId:string):GitlabLink[]{
    if(!numericObjectId(objectId))return [];
    const key=gitlabLinkObjectKey(instance,projectId,kind,objectId);
    const rows=this.linkedActivityRows.all(`${key}:`,`${key};`) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as GitlabLink)
      .filter(link=>link.id===`${key}:${link.issueId}`&&link.kind===kind&&link.projectId===projectId);
  }
  private branchLinksForKey(key:string,projectId:number,branch:string):GitlabLink[]{
    const rows=this.linkedActivityRows.all(`${key}:`,`${key};`) as {json:string}[];
    return rows.map(row=>JSON.parse(row.json) as GitlabLink)
      .filter(link=>link.id===`${key}:${link.issueId}`&&link.kind==='branch'&&link.projectId===projectId&&
        link.sourceBranch===branch&&isRestorableGitlabLink(link));
  }
  private existingAutomaticWorkflowLinks(instance:string,projectId:number,kind:WorkflowGitlabKind,draft:LinkDraft,matcher:TicketMatcher,
    candidates?: readonly GitlabLink[]){
    if(!draft.numericId||draft.id!==draft.numericId)return [];
    if(kind==='pipeline'&&draft.reportedProjectId!==undefined&&draft.reportedProjectId!==String(projectId))return [];
    return (candidates??this.workflowLinksForObject(instance,projectId,kind,draft.numericId)).flatMap(link=>{
      if(kind==='merge_request'&&draft.reportedIid&&link.iid!==draft.reportedIid)return [];
      if(kind==='pipeline'&&!samePipelineRevision(link,draft))return [];
      const match=matcher.inherit(link);
      return match?[{link,match}]:[];
    });
  }
  private upsert(instance:string,projectId:number,kind:WorkflowGitlabKind,draft:LinkDraft,matches:TicketMatch[],preserveExisting:boolean,token:string|null):number{
    let linked=0;
    for(const match of matches){
      const link=linkForIssue(instance,projectId,kind,match,draft);
      const existing=this.store.get<GitlabLink>('gitlab_links',link.id);
      if(preserveExisting&&existing)continue;
      if(existing?.manualLinkId){
        if(!matchesManualLink(existing,draft))continue;
        this.store.put('gitlab_links',automaticLinkForAttached(existing,draft,match.originalJiraKey,token));
      }else{
        if(!draft.webUrl)continue;
        let next=retainOriginalJiraKey(link,existing);
        if(kind==='pipeline'&&existing){
          next=refreshAutomaticPipeline(existing,draft,link);
          if(next===existing)continue;
        }else if(kind==='merge_request'&&existing){
          if(keepNewerLink(existing,draft))next=existing;
          next=applyMergeObservation(next,existing,draft);
          if(next===existing)continue;
        }
        this.store.put('gitlab_links',next);
      }
      linked++;
    }
    return linked;
  }
  private observeBranch(baseUrl: string, instance: string, projectId: number, head: GitlabHeadPush, repository: URL | null, matches: TicketMatch[]): number {
    const id = pushCursorId(instance,projectId,head.branch);
    const links = this.branchLinksForKey(id,projectId,head.branch);
    const pending = this.pendingBranchReads.get(id);
    let previous = this.store.get<PushObservation>('gitlab_push_cursors', id);
    let snapshotUrl: string | undefined;
    if (!previous) {
      // Native backups contain branch links without transient webhook cursors.
      const persisted=links.flatMap(prior=>{
        if(prior.branchObservationSource==='sync')snapshotUrl??=prior.webUrl;
        const observed=pushObservationFromLink(prior);
        return observed?[observed]:[];
      });
      previous = persisted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    }
    const archived = !previous && !matches.length && !links.length ? this.hooks.findArchivedBranchLink?.(id) : undefined;
    if (archived) previous = pushObservationFromLink(archived) ?? undefined;
    if (!previous && !matches.length && !links.length && !pending && !archived) return 0;
    const latestAttached = [...links.filter(link=>link.manualLinkId), ...(archived?.manualLinkId ? [archived] : [])]
      .sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
    const baseline = previous ?? (latestAttached && pushObservationFromLink(latestAttached,true));
    const lastHead = baseline?.state === 'deleted' ? '0'.repeat(baseline.sourceSha.length) : baseline?.sourceSha;
    const sameHead = lastHead === head.after;
    if (lastHead !== undefined && !sameHead && lastHead !== head.before) return 0;

    const treeUrl = repository && gitlabPushLinkUrl(repository, 'tree', head.branch);
    const webUrl = treeUrl || gitlabScopedPushUrl(baseUrl, previous?.webUrl ?? snapshotUrl ?? pending?.webUrl ?? archived?.webUrl);
    if (!webUrl) return 0;
    const observation: PushObservation = {
      id, state: head.deleted ? 'deleted' : 'active', sourceSha: sameHead && previous ? previous.sourceSha : head.deleted ? head.before : head.after, webUrl,
      updatedAt: sameHead && previous && !previous.source ? previous.updatedAt : now(), revision: randomUUID(),
    };
    this.store.put('gitlab_push_cursors', observation);
    const fields = branchLinkFields(observation);
    let linked = 0;
    const matchedIds = new Set<string>();
    for (const {issue:{id:issueId},originalJiraKey} of matches) {
      matchedIds.add(issueId);
      const link: GitlabLink = { ...fields, id: `${id}:${issueId}`, issueId, projectId, iid: 0, kind: 'branch', title: head.branch, sourceBranch: head.branch, ...(originalJiraKey?{originalJiraKey}:{}) };
      const existing = this.store.get<GitlabLink>('gitlab_links', link.id);
      const next=retainOriginalJiraKey(link,existing);
      if (existing?.state === next.state && !existing.manualLinkId && !existing.branchObservationSource && existing.sourceSha === next.sourceSha && existing.webUrl === next.webUrl && existing.originalJiraKey === next.originalJiraKey) continue;
      this.store.put('gitlab_links', next);
      linked++;
    }
    for(const prior of links){
      if(matchedIds.has(prior.issueId))continue;
      const next=refreshAttachedBranch(prior,fields);
      if(next===prior)continue;
      this.store.put('gitlab_links',next);
      linked++;
    }
    return linked;
  }
  latestObservedBranchLink(link: GitlabLink): GitlabLink {
    const observation = pushObservationFromLink(link,true);
    if (!observation) return link;
    const current = this.store.get<PushObservation>('gitlab_push_cursors', observation.id);
    if (!current) return link;
    return refreshAttachedBranch(link,branchLinkFields(current));
  }
  refreshRestoredBranchLinks(issueId: string): void {
    const links = this.store.db.prepare(`SELECT json FROM gitlab_links WHERE issue_id=? AND json_extract(json,'$.kind')='branch'`).all(issueId);
    for (const row of links) {
      const link = JSON.parse(String(row.json)) as GitlabLink;
      const latest = this.latestObservedBranchLink(link);
      if (latest !== link) this.store.put('gitlab_links', latest);
    }
  }
  private recordPush(raw: RawSettings, instance: string, projectId: number, kind: string, body: Obj, project: Obj): number {
    const head = kind === 'push' ? readGitlabHeadPush(body) : null;
    const route=raw.jiraRoutes?.find(candidate=>candidate.repositoryId===projectId);
    const readKeys=route?routedKeys:keys;
    const branchKeys = head ? readKeys(head.branch) : [];
    const commits = Array.isArray(body.commits) ? body.commits : [];
    if (!head && !commits.length) return 0;

    const repository = gitlabRepositoryUrl(raw.baseUrl, project);
    const matcher=this.ticketMatcher(this.syncIssues(),route);
    const branchMatches=matcher.match(branchKeys);
    let linked = head ? this.observeBranch(raw.baseUrl, instance, projectId, head, repository, branchMatches) : 0;
    if (head?.deleted) return linked;

    for (const item of (head ? commits.slice(-GITLAB_PUSH_COMMIT_LIMIT) : commits)) {
      const commit = record(item);
      const sha = gitlabObjectSha(commit.id);
      if (sha && /^0+$/.test(sha)) continue;
      if (head && (!sha || sha.length !== head.after.length)) continue;
      const explicitKeys = readKeys(commit.title, commit.message, commit.description);
      const matches = explicitKeys.length ? matcher.match(explicitKeys) : branchMatches;
      if (!matches.length) continue;

      const suppliedUrl = commit.web_url || commit.url;
      const canonicalUrl = repository && sha && gitlabPushLinkUrl(repository, 'commit', sha);
      const webUrl = canonicalUrl || gitlabScopedPushUrl(raw.baseUrl, suppliedUrl) || (!head && validWebUrl(suppliedUrl));
      if (!webUrl) continue;
      const draft = readLink('commit', {
        id: sha || commit.id, title: commit.title, message: commit.message, web_url: webUrl,
        state: 'committed', updated_at: commit.timestamp, source_branch: head?.branch, sha,
      }, []);
      if (!draft.id) continue;
      for (const match of matches) {
        const link = linkForIssue(instance, projectId, 'commit', match, draft);
        const existing = this.store.get<GitlabLink>('gitlab_links', link.id);
        if (existing) {
          if(existing.manualLinkId){
            if(!matchesManualLink(existing,draft))continue;
            const promoted=promoteAttachedLink(existing,link.originalJiraKey);
            this.store.put('gitlab_links',{...promoted,...(!promoted.sourceBranch&&link.sourceBranch?{sourceBranch:link.sourceBranch}:{})});
            linked++;
            continue;
          }
          const shaToAdd = existing.sourceSha ? undefined : link.sourceSha;
          const branchToAdd = existing.sourceBranch ? undefined : link.sourceBranch;
          const aliasToAdd = existing.originalJiraKey ? undefined : link.originalJiraKey;
          if (!shaToAdd && !branchToAdd && !aliasToAdd) continue;
          this.store.put('gitlab_links', { ...existing, ...(shaToAdd ? { sourceSha: shaToAdd } : {}), ...(branchToAdd ? { sourceBranch: branchToAdd } : {}), ...(aliasToAdd ? { originalJiraKey: aliasToAdd } : {}) });
        } else this.store.put('gitlab_links', link);
        linked++;
      }
    }
    return linked;
  }
  private deploymentSucceeded(raw: RawSettings, deployment: GitlabDeployment, fresh: boolean, receivedAt: string): AutomationRun[] {
    const { instance, repositoryId, deploymentId, environment, changedAt } = deployment;
    const objectId = String(deploymentId);
    const digest = createHash('sha256').update(`deployment-success:${objectId}`).digest('hex');
    const id = `gitlab:${instance}:${repositoryId}:deployment:${digest}`;
    // Claim the success even when no ticket qualifies, so a redelivery cannot apply it to links added later.
    const receipt = this.store.db.prepare('INSERT OR IGNORE INTO webhook_inbox(id,created_at) VALUES(?,?)')
      .run(`automation:${id}`, receivedAt);
    if (receipt.changes !== 1 || !fresh) return [];

    const links = this.deployments.matchingAutomaticLinks(deployment);
    if (!links.length) return [];
    const route = raw.jiraRoutes?.find(candidate => candidate.repositoryId === repositoryId);
    const matcher = this.ticketMatcher(this.syncIssues(), route);
    const issueIds = [...new Set(links.flatMap(link => {
      const match = matcher.inherit(link);
      return match ? [match.issue.id] : [];
    }))];
    if (!issueIds.length) return [];
    return this.hooks.processEvent({ id, trigger: 'deployment.succeeded', gitlabProjectId: repositoryId,
      objectKind: 'deployment', objectId, branch: '', environment, issueIds, occurredAt: changedAt,
      receivedAt, disposition: 'fresh', reason: '' });
  }
  webhook(req:Request):WebhookResult{
    const raw=this.raw(),authentication=this.authenticate(req,raw);const body=record(req.body),project=record(body.project),projectId=Number(project.id??body.project_id);if(!raw.projectIds.includes(projectId))fail('허용된 저장소가 아닙니다.',403);
    const header=req.header('X-Gitlab-Event')||'',kind=string(body.object_kind)||({'Merge Request Hook':'merge_request','Pipeline Hook':'pipeline','Push Hook':'push','Tag Push Hook':'tag_push','Deployment Hook':'deployment'} as Record<string,string>)[header]||'';
    const attributes=record(body.object_attributes),instance=this.instance(raw),externalId=req.header('webhook-id')||req.header('Idempotency-Key')||req.header('X-Gitlab-Event-UUID')||createHash('sha256').update((req as Request&{gitlabRawBody?:Buffer}).gitlabRawBody||Buffer.from(JSON.stringify(body))).digest('hex');if(externalId.length>500)fail('Webhook 식별자가 너무 깁니다.');const eventId=`gitlab:${instance}:${projectId}:${kind}:${createHash('sha256').update(externalId).digest('hex')}`;
    const receivedAt = now();
    const processWebhook = (): WebhookResult => {
      if(this.store.db.prepare('SELECT id FROM webhook_inbox WHERE id=?').get(eventId))return{ok:true,duplicate:true,linked:0,runs:[]};
      this.store.db.prepare('INSERT INTO webhook_inbox(id,created_at) VALUES(?,?)').run(eventId,now());
      if(kind==='push'||kind==='tag_push')return{ok:true,duplicate:false,linked:this.recordPush(raw,instance,projectId,kind,body,project),runs:[]};
      if(kind==='deployment'){
        let runs: AutomationRun[] = [];
        const changed=this.deployments.observe(instance,raw.baseUrl,projectId,body,(deployment, fresh) => {
          runs = this.deploymentSucceeded(raw, deployment, fresh, receivedAt);
        });
        return{ok:true,duplicate:false,linked:0,runs,...(changed?{deploymentUpdated:true}:{})};
      }
      if(kind!=='merge_request'&&kind!=='pipeline')return{ok:true,duplicate:false,linked:0,runs:[]};
      const id=objectId(attributes),state=string(attributes.state)||string(attributes.status)||'unknown',branch=bound(kind==='merge_request'?attributes.source_branch:attributes.ref,512),sha=bound(attributes.sha||record(attributes.last_commit).id||record(body.commit).id,128);
      const action=string(attributes.action);
      const lifecycle = kind === 'merge_request' && Object.hasOwn(mergeRequestLifecycle, action)
        ? mergeRequestLifecycle[action as keyof typeof mergeRequestLifecycle] : undefined;
      const mergeRepositoryMismatch = kind === 'merge_request' && (
        (attributes.target_project_id !== undefined && attributes.target_project_id !== projectId) ||
        (attributes.project_id !== undefined && attributes.project_id !== projectId)
      );
      const mergeRepositoryMatches=kind==='merge_request'&&!mergeRepositoryMismatch;
      const mergeRead = mergeRepositoryMatches && id ? this.mergeRequestObservations.get(instance, projectId, id) : undefined;
      const mergeIid = kind === 'merge_request' ? numericObjectId(attributes.iid) : '';
      const mergeIdentityMismatch = Boolean((lifecycle || mergeRead) &&
        (!id || numericObjectId(attributes.id) !== id || !mergeIid || mergeRead && mergeIid !== String(mergeRead.iid)));
      const mergeActionMismatch = Boolean(lifecycle && lifecycle.state !== attributes.state);
      const mergeIncompatible = mergeRepositoryMismatch || mergeIdentityMismatch || mergeActionMismatch;
      const mergeRevisionAt = kind === 'merge_request' ? occurredAt(attributes.updated_at) : null;
      const time=kind==='pipeline'?pipelineTime(attributes,state):occurredAt(attributes.actioned_at||attributes.updated_at);
      const cursorId=`${instance}:${projectId}:${kind}:${id}`,prior=id?this.store.get<ObjectCursor>('gitlab_object_cursors',cursorId):undefined;let disposition:AutomationEvent['disposition']='fresh',reason='';
      const pipelineLinks=kind==='pipeline'?this.workflowLinksForObject(instance,projectId,kind,id):[];
      const readToken=kind==='pipeline'&&raw.token?this.store.unseal(raw.token):null;
      const exactPipelineId=kind==='pipeline'&&numericObjectId(attributes.id)===id&&Boolean(id);
      const priorPipeline=exactPipelineId?prior?.pipeline:undefined;
      const classification=exactPipelineId?readPipelineClassification(attributes,true,readToken,req.header('X-Gitlab-Token')):undefined;
      const knownClassification=knownPipelineClassification(priorPipeline?[priorPipeline,...pipelineLinks]:pipelineLinks);
      const pipelineClassificationMismatch=classification&&(!knownClassification||conflictingPipelineClassification(knownClassification,classification));
      const verifiedClassification=classification&&knownClassification?addPipelineClassification(knownClassification,classification):classification;
      const unverifiedPipelineId=kind==='pipeline'&&!exactPipelineId&&Boolean(prior?.pipeline);
      const pipelineIdentityMismatch=kind==='pipeline'&&(
        (attributes.project_id!==undefined&&numericObjectId(attributes.project_id)!==String(projectId))||
        (priorPipeline&&!samePipelineRevision(priorPipeline,{sourceBranch:branch,sourceSha:sha}))||
        pipelineLinks.some(link=>!samePipelineRevision(link,{sourceBranch:branch,sourceSha:sha}))
      );
      if(mergeRepositoryMismatch){disposition='unverified';reason='MR 대상 저장소가 webhook의 저장소와 일치하지 않습니다.';}
      else if(mergeIdentityMismatch){disposition='unverified';reason='이벤트의 정확한 MR ID와 저장소 내 번호를 확인할 수 없습니다.';}
      else if(mergeActionMismatch){disposition='unverified';reason='MR 이벤트의 동작과 상태가 일치하지 않아 적용하지 않았습니다.';}
      else if(pipelineIdentityMismatch){disposition='unverified';reason='파이프라인의 저장소, 브랜치 또는 커밋이 기존 연결과 다릅니다.';}
      else if(unverifiedPipelineId){disposition='unverified';reason='기존 관측의 정확한 파이프라인 ID를 확인할 수 없습니다.';}
      else if(!id||!time||kind==='pipeline'&&!numericObjectId(id)){disposition='unverified';reason='이벤트 식별자 또는 유효한 과거 발생 시각을 확인할 수 없습니다.';}
      else if(prior?.occurredAt){const difference=Date.parse(time)-Date.parse(prior.occurredAt);if(difference<0){disposition='stale';reason='이 객체의 최신 수신 이벤트보다 오래된 이벤트입니다.';}else if(difference===0){disposition=state===prior.state?'stale':'ambiguous';reason=state===prior.state?'같은 발생 시각·상태의 이벤트를 이미 반영했습니다.':'같은 발생 시각의 상태가 서로 달라 적용하지 않았습니다.';}}
      // A saved status can be newer than the last received webhook. An equal matching read
      // leaves the first authenticated webhook eligible for automation.
      if(disposition==='fresh'&&time){
        if (mergeRead) {
          // The action may be older than the accompanying MR snapshot, or vice versa.
          const stateAt = mergeRevisionAt && mergeRevisionAt < time ? mergeRevisionAt : time;
          if (stateAt < mergeRead.updatedAt) {
            disposition = 'stale';
            reason = '더 최신 GitLab 조회에서 확인한 MR 상태를 유지했습니다.';
          } else if (stateAt === mergeRead.updatedAt && mergeRead.state !== state) {
            disposition = 'ambiguous';
            reason = '같은 시각의 GitLab 조회와 MR 상태가 일치하지 않아 적용하지 않았습니다.';
          }
        }
        const incoming=Date.parse(time);
        if(pipelineLinks.some(link=>link.pipelineObservedAt&&Date.parse(link.pipelineObservedAt)>incoming)){
          disposition='stale';reason='저장한 최신 파이프라인 상태보다 오래된 이벤트입니다.';
        }else if(pipelineLinks.some(link=>link.pipelineObservedAt&&Date.parse(link.pipelineObservedAt)===incoming&&link.state!==state)){
          disposition='ambiguous';reason='저장한 파이프라인과 같은 발생 시각의 상태가 달라 적용하지 않았습니다.';
        }
      }
      if(disposition==='fresh'&&pipelineClassificationMismatch){
        disposition='unverified';reason='파이프라인의 실행 유형 또는 태그 정보가 기존 연결과 다릅니다.';
      }
      const objectDisposition=disposition;
      const pipelineIncompatible=pipelineIdentityMismatch||pipelineClassificationMismatch||unverifiedPipelineId;
      const confirmsLegacyPipeline = exactPipelineId && !priorPipeline && Boolean(branch && time && prior &&
        time === prior.occurredAt && state === prior.state) && !pipelineIncompatible;
      if(id&&!mergeIncompatible&&!pipelineIncompatible&&(disposition==='fresh'||disposition==='unverified'&&!prior)){
        const updatedAt=mergeRevisionAt,head=gitlabObjectSha(attributes.sha||record(attributes.last_commit).id);
        const approvalRevision=mergeRepositoryMatches&&state==='opened'&&approvalActions.has(action)&&time&&updatedAt&&updatedAt<time&&head
          ?{updatedAt,head}:undefined;
        const pipeline = exactPipelineId && disposition==='fresh' && (branch || priorPipeline) ? {
          scope: `${instance}:${projectId}:${branch || priorPipeline?.sourceBranch}`,
          objectId: Number(id), sourceBranch: branch || priorPipeline?.sourceBranch || '',
          sourceSha: sha || priorPipeline?.sourceSha || '', ...verifiedClassification,
        } : prior?.pipeline;
        this.store.put('gitlab_object_cursors',{id:cursorId,occurredAt:time,state,receivedAt:now(),...(approvalRevision?{approvalRevision}:{}),...(pipeline?{pipeline}:{})} satisfies ObjectCursor);
      }else if(confirmsLegacyPipeline&&prior){
        this.store.put('gitlab_object_cursors',{...prior,pipeline:{scope:`${instance}:${projectId}:${branch}`,objectId:Number(id),
          sourceBranch:branch,sourceSha:sha,...verifiedClassification}} satisfies ObjectCursor);
      }
      if(kind==='pipeline'&&branch&&objectDisposition==='fresh'){
        const numericId=Number(id),branchId=`${instance}:${projectId}:${branch}`;
        const latest=this.latestCompatiblePipelineId(instance,projectId,branch,verifiedClassification??{});
        if(latest!==null&&numericId<latest){
          disposition='stale';reason='이 참조에 같은 실행으로 볼 수 있는 더 최근 파이프라인이 있어 이전 결과를 적용하지 않았습니다.';
        }else if(!exactPipelineId&&(latest===null||numericId>latest)){
          this.store.put('gitlab_branch_cursors',{id:branchId,pipelineId:numericId} satisfies BranchCursor);
        }
      }
      const route=raw.jiraRoutes?.find(candidate=>candidate.repositoryId===projectId),readKeys=route?routedKeys:keys;
      const issues=this.syncIssues(),matcher=this.ticketMatcher(issues,route);
      const mergeRequest=record(body.merge_request),extra=readKeys(mergeRequest.title,mergeRequest.description,mergeRequest.source_branch,record(body.commit).message,...(Array.isArray(body.commits)?body.commits.map(commit=>record(commit).message):[]));
      const inherited=kind==='pipeline'?this.inheritedMatches(projectId,branch,sha,instance,matcher):[];
      const object={...attributes,...(time?{updated_at:time}:{}),...(branch?{source_branch:branch}:{}),...(sha?{sha}:{}),web_url:attributes.web_url||attributes.url||(kind==='pipeline'&&project.web_url?`${project.web_url}/-/pipelines/${id}`:'')};
      const invalidate=Boolean(attributes.oldrev)||action==='reopen'||approvalActions.has(action);
      const targetBranch=mergeRepositoryMatches&&objectDisposition==='fresh'&&project.id===projectId&&
        (attributes.target_project_id===projectId||isGitlabMergeRequestUrl(object.web_url,raw.baseUrl,Number(numericObjectId(attributes.iid))))
        ?readMergeTargetBranch(attributes,projectId,raw.token?this.store.unseal(raw.token):null,...this.webhookCredentials(raw)):undefined;
      const observation:MergeObservation|undefined=mergeRepositoryMatches&&objectDisposition==='fresh'&&time
        ?{source:'webhook',observedAt:time,invalidate,repositoryId:projectId,targetBranch}:undefined;
      const observedDraft=readLink(kind,object,extra,readKeys,observation,verifiedClassification);
      const mergeTargetConflict=observedDraft.targetBranch&&
        hasConflictingMergeTarget(observedDraft,this.workflowLinksForObject(instance,projectId,'merge_request',id));
      const draft=exactPipelineId?classifyPipelineDraft(observedDraft,pipelineLinks,priorPipeline,objectDisposition==='fresh')??observedDraft
        :mergeTargetConflict?{...observedDraft,targetBranch:undefined}:observedDraft;
      const canUpsert=!mergeIncompatible&&!pipelineIncompatible&&(objectDisposition==='fresh'||objectDisposition==='unverified');
      const direct=canUpsert?draft.matchedKeys:readKeys(attributes.title,attributes.description,branch,attributes.ref,...extra);
      const byMatchId=new Map((id?matcher.match(direct,inherited):[]).map(match=>[match.issue.id,match]));
      const matches=issues.flatMap(issue=>{const match=byMatchId.get(issue.id);return match?[match]:[];});
      const attached=objectDisposition==='fresh'?this.manualLinksForObject(instance,projectId,kind,draft):[];
      const token=attached.length&&raw.token?(readToken??this.store.unseal(raw.token)):null;
      let linked=canUpsert?this.upsert(instance,projectId,kind,draft,matches,objectDisposition==='unverified',token):0;
      for(const prior of attached){
        if(byMatchId.has(prior.issueId))continue;
        const updated=refreshExistingLink(prior,draft,token);
        if(updated===prior)continue;
        this.store.put('gitlab_links',updated);
        linked++;
      }
      if((mergeRepositoryMatches||kind==='pipeline')&&objectDisposition==='fresh'){
        // Already linked objects can change after GitLab omits the references that linked them.
        // An existing link alone does not expand the targets of a workflow event.
        for(const {link:prior} of this.existingAutomaticWorkflowLinks(instance,projectId,kind,draft,matcher,kind==='pipeline'?pipelineLinks:undefined)){
          if(draft.webUrl&&byMatchId.has(prior.issueId))continue;
          const updated=refreshExistingLink(prior,draft,null);
          if(updated===prior)continue;
          this.store.put('gitlab_links',updated);
          linked++;
        }
      }
      const issueIds=matches.map(match=>match.issue.id);
      const trigger=kind==='merge_request'?lifecycle?.trigger:({success:'pipeline.succeeded',failed:'pipeline.failed'} as Record<string,AutomationEvent['trigger']>)[state];
      const pipelineEvidence = !pipelineIncompatible && objectDisposition === 'fresh' ? verifiedClassification : undefined;
      const runs=trigger?this.hooks.processEvent({id:eventId,trigger,gitlabProjectId:projectId,objectKind:kind,objectId:id,branch,
        ...pipelineEvidence,...(draft.targetBranch?{targetBranch:draft.targetBranch}:{}),issueIds,occurredAt:time,receivedAt:now(),disposition,reason}):[];
      return{ok:true,duplicate:false,linked,runs};
    };
    return this.store.transaction(() => {
      const result = processWebhook();
      const event = isTrackedWebhookEvent(kind) || kind === 'tag_push' ? kind : 'other';
      const { duplicate, linked, runs, deploymentUpdated } = result;
      const delivery: GitlabWebhookDelivery = { event, authentication, receivedAt, duplicate, linked, automationRuns: runs.length,
        ...(deploymentUpdated ? { deploymentUpdated } : {}) };
      const id = String(projectId);
      const priorAccepted = acceptedWebhookEvents(this.store.get<StoredWebhookDelivery>('gitlab_webhook_deliveries', id));
      const lastAcceptedByEvent = !duplicate && isTrackedWebhookEvent(event) ? { ...priorAccepted, [event]: delivery } : priorAccepted;
      this.store.put('gitlab_webhook_deliveries', { id, delivery, ...(lastAcceptedByEvent ? { lastAcceptedByEvent } : {}) } satisfies StoredWebhookDelivery);
      const receiverUrl = this.projectWebhooks.receiverUrl;
      if (event !== 'other' && raw.baseUrl && receiverUrl && req.originalUrl === new URL(receiverUrl).pathname) {
        const digest = gitlabWebhookMessageDigest(req.headers, authentication === 'signing-token');
        if (digest) this.webhookReceipts.remember({ instance: raw.baseUrl, repositoryId: projectId, event, receiverUrl }, digest, delivery);
      }
      return result;
    });
  }
  private visitProjectLinks(
    instance:string,plan:ProjectReadPlan,startedAt:number,matcher:TicketMatcher,token:string|null,
    visit:(link:GitlabLink,match:TicketMatch,action:GitlabSyncPreviewCandidate['action'],kind:SyncKind,objectId:string)=>void,
    persistMergeRequestReads = false,
  ):GitlabSyncPreviewCounts{
    const {projectId,mergeRequests,pipelines,history}=plan;
    const counts={...emptyCounts(Boolean(history)),mergeRequests:mergeRequests.length,pipelines:pipelines.length,
      ...(history?{branches:history.branches.length,commits:history.commits.length}:{})};
    // Earlier pages can contain the same object while GitLab changes during pagination.
    // Carry planned writes forward so an in-request duplicate sees what sync would have saved.
    const planned=new Map<string,GitlabLink>();
    const plannedPipelineAliases=new Map<string,Map<string,GitlabLink>>();
    const seenHistory=new Set<string>();
    for(const [kind,drafts] of [['branch',history?.branches??[]],['commit',history?.commits??[]],['merge_request',mergeRequests],['pipeline',pipelines]] as const)for(let draft of drafts){
      if(!draft.id){counts.skipped++;continue;}
      let observation:PushObservation|undefined;
      let approvalAt:string|undefined;
      let pipelineAliases:Map<string,GitlabLink>|undefined;
      let pipelineCandidates:GitlabLink[]|undefined;
      if(kind==='branch'||kind==='commit'){
        const identity=`${kind}:${draft.id}`;
        if(kind==='branch')observation=this.store.get<PushObservation>('gitlab_push_cursors',`gitlab:${instance}:${projectId}:branch:${draft.id}`);
        if(seenHistory.has(identity)||observation&&(observation.state!=='active'||observation.sourceSha!==draft.sourceSha)){
          counts.skipped++;continue;
        }
        seenHistory.add(identity);
      }else{
        const cursor=this.store.get<ObjectCursor>('gitlab_object_cursors',`${instance}:${projectId}:${kind}:${draft.id}`);
        const inconsistentState=Boolean(cursor?.occurredAt)&&cursor?.occurredAt===draft.incomingTime&&cursor?.state!==draft.state;
        const cursorNewer=Boolean(cursor?.occurredAt&&(!draft.incomingTime||Date.parse(cursor.occurredAt)>Date.parse(draft.incomingTime)));
        if(kind==='merge_request'&&cursorNewer)approvalAt=matchingApprovalTime(cursor,draft);
        if(cursor&&(Date.parse(cursor.receivedAt||'')>=startedAt||inconsistentState||cursorNewer&&!approvalAt)){
          counts.skipped++;continue;
        }
        if(kind==='merge_request'){
          if(persistMergeRequestReads)this.recordMergeRequestRead(instance,draft,new Date(startedAt).toISOString());
          if(this.hasConflictingMergeRequestRead(instance,projectId,draft)){counts.skipped++;continue;}
        }
        if(kind==='pipeline'){
          if(draft.reportedProjectId!==undefined&&draft.reportedProjectId!==String(projectId)){counts.skipped++;continue;}
          pipelineAliases=plannedPipelineAliases.get(draft.id);
          if(!pipelineAliases){
            pipelineAliases=new Map(this.workflowLinksForObject(instance,projectId,kind,draft.id).map(link=>[link.id,link]));
            plannedPipelineAliases.set(draft.id,pipelineAliases);
          }
          pipelineCandidates=[...pipelineAliases.values()];
          const classified=this.classifyReadPipeline(instance,projectId,draft,pipelineCandidates);
          if(!classified){counts.skipped++;continue;}
          draft=classified;
        }
      }
      const remember=(link:GitlabLink)=>{planned.set(link.id,link);pipelineAliases?.set(link.id,link);};
      const attached=pipelineCandidates?pipelineCandidates.filter(link=>link.manualLinkId&&matchesManualLink(link,draft))
        :this.manualLinksForObject(instance,projectId,kind,draft).map(link=>planned.get(link.id)??link).filter(link=>link.manualLinkId);
      const known=kind==='merge_request'||kind==='pipeline'?this.existingAutomaticWorkflowLinks(instance,projectId,kind,draft,matcher,pipelineCandidates):[];
      if(!draft.webUrl&&!attached.length&&!known.length){counts.skipped++;continue;}
      const attachedIssueIds=new Set(attached.map(link=>link.issueId));
      const targets=matcher.match(draft.matchedKeys).filter(match=>Boolean(draft.webUrl)||attachedIssueIds.has(match.issue.id));
      // A sampled branch can add a scoped Jira link to the exact authenticated head without replacing that observation.
      const matched=observation&&!observation.source?targets.filter(target=>target.originalJiraKey||attachedIssueIds.has(target.issue.id)):targets;
      if(observation&&!matched.length&&!attached.length){counts.skipped++;continue;}
      if(!matched.length&&!attached.length&&!known.length){counts.unmatched++;continue;}
      counts.matched++;
      const matchedIssueIds=new Set(matched.map(match=>match.issue.id));
      for(const match of matched){
        const link=linkForIssue(instance,projectId,kind,match,draft);
        if(observation){
          Object.assign(link,branchLinkFields(observation));
        }else if(kind==='branch')link.branchObservationSource='sync';
        const existing=planned.get(link.id)??this.store.get<GitlabLink>('gitlab_links',link.id);
        if(approvalAt){
          if(existing){
            const next=applyMergeObservation(existing,existing,draft,approvalAt);
            const action=next===existing?'unchanged':'update';
            counts[action]++;
            remember(next);
            visit(next,match,action,kind,draft.id);
          }
          continue;
        }
        if(existing?.manualLinkId){
          if(!matchesManualLink(existing,draft))continue;
          const next=kind==='branch'
            ?promoteAttachedLink(refreshAttachedBranch(existing,{...link,updatedAt:observation?.updatedAt??new Date(startedAt).toISOString()}),match.originalJiraKey)
            :kind==='commit'?promoteAttachedLink(existing,match.originalJiraKey):automaticLinkForAttached(existing,draft,match.originalJiraKey,token);
          counts.update++;
          remember(next);
          visit(next,match,'update',kind,draft.id);
          continue;
        }
        if(kind==='pipeline'&&existing){
          if(!samePipelineRevision(existing,draft))continue;
          const next=refreshAutomaticPipeline(existing,draft,link);
          const action=next===existing?'unchanged':'update';
          counts[action]++;
          remember(next);
          visit(next,match,action,kind,draft.id);
          continue;
        }
        let currentEnough=false;
        if(existing){
          if(observation){
            currentEnough=existing.branchObservationSource===link.branchObservationSource&&existing.state===link.state&&existing.sourceSha===link.sourceSha&&
              existing.webUrl===link.webUrl&&existing.updatedAt===link.updatedAt;
          }else if(kind==='branch'){
            currentEnough=existing.branchObservationSource!=='sync'||existing.sourceSha===link.sourceSha&&existing.webUrl===link.webUrl;
          }else currentEnough=kind==='commit'||keepNewerLink(existing,draft);
        }
        let action:GitlabSyncPreviewCandidate['action']=existing?'update':'create';
        let next=retainOriginalJiraKey(link,existing);
        if(currentEnough&&existing){
          if(!existing.originalJiraKey&&link.originalJiraKey)next={...existing,originalJiraKey:link.originalJiraKey};
          else{next=existing;action='unchanged';}
        }
        if(kind==='merge_request'&&existing){
          next=applyMergeObservation(next,existing,draft);
          if(next!==existing)action='update';
        }
        counts[action]++;
        if(action!=='unchanged')remember(next);
        visit(next,match,action,kind,draft.id);
      }
      for(const prior of attached){
        if(matchedIssueIds.has(prior.issueId))continue;
        const issue=this.store.get<Issue>('issues',prior.issueId);
        if(!issue)continue;
        const next=kind==='branch'
          ?refreshAttachedBranch(prior,observation?branchLinkFields(observation)
            :{state:draft.state,sourceSha:draft.sourceSha,webUrl:draft.webUrl,updatedAt:new Date(startedAt).toISOString(),branchObservationSource:'sync'})
          :kind==='commit'?prior:refreshExistingLink(prior,draft,token,approvalAt);
        const action=next===prior?'unchanged':'update';
        counts[action]++;
        if(action==='update')remember(next);
        visit(next,{issue},action,kind,draft.id);
      }
      for(const {link,match} of known){
        if(matchedIssueIds.has(link.issueId))continue;
        const prior=planned.get(link.id)??link;
        const next=refreshExistingLink(prior,draft,null,approvalAt);
        const action=next===prior?'unchanged':'update';
        counts[action]++;
        if(action==='update')remember(next);
        visit(next,match,action,kind,draft.id);
      }
    }
    return counts;
  }

  private syncIssues():IssueMatch[]{
    const previous = this.hooks.previousIssueKeys?.();
    return this.store.all<Issue>('issues').map(({id,key,title,projectId})=>({id,key,title,projectId,previousKeys:previous?.get(id)}));
  }

  private currentForSync(version:number):RawSettings{
    const current=this.raw();
    if(current.version!==version)fail('동기화 도중 GitLab 설정이 변경되어 결과를 적용하지 않았습니다.',409);
    return current;
  }

  private draftReadToken(input: Obj, address: string, saved: RawSettings): string | null {
    if (Object.hasOwn(input, 'token')) return credential(input.token);
    return address === saved.baseUrl && saved.token ? this.store.unseal(saved.token) : null;
  }

  async searchRepositories(value: unknown, signal?: AbortSignal): Promise<GitlabRepositorySearch> {
    const input = record(value);
    if (Object.keys(input).some(key => !['expectedVersion', 'baseUrl', 'token', 'query', 'page'].includes(key))) {
      fail('지원하지 않는 GitLab 저장소 검색 요청입니다.');
    }
    const saved = this.raw();
    assertSettingsVersion(input.expectedVersion, saved.version);
    const address = Object.hasOwn(input, 'baseUrl') ? baseUrl(input.baseUrl) : saved.baseUrl;
    if (!address) fail('GitLab 주소를 입력해 주세요.');
    const query = typeof input.query === 'string' && input.query.isWellFormed() && !/\p{Cc}/u.test(input.query) ? input.query.trim() : '';
    if (!query || query.length > 200) fail('GitLab 저장소 검색어를 1~200자로 입력해 주세요.');
    const page = Object.hasOwn(input, 'page') ? input.page : 1;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > GITLAB_REPOSITORY_SEARCH_MAX_PAGE) {
      fail('GitLab 저장소 검색 페이지를 1~20 사이로 지정해 주세요.');
    }
    const token = this.draftReadToken(input, address, saved);
    if (token && query.includes(token)) fail('GitLab 저장소 검색어를 확인해 주세요.');
    signal?.throwIfAborted();
    const result = await readGitlabRepositorySearch({ baseUrl: address, token }, query, page, signal).catch(error => {
      signal?.throwIfAborted();
      assertSettingsVersion(saved.version, this.raw().version);
      if (error instanceof GitlabRepositoryQueryError) fail(error.message);
      if (error instanceof GitlabReadError) {
        const message = error.httpStatus === 401 || error.httpStatus === 403
          ? 'GitLab 저장소를 읽을 수 없습니다. 읽기 토큰과 접근 권한을 확인해 주세요.'
          : 'GitLab 저장소 검색에 실패했습니다. 주소와 연결 상태를 확인해 주세요.';
        fail(message, 502);
      }
      throw error;
    });
    signal?.throwIfAborted();
    assertSettingsVersion(saved.version, this.raw().version);
    return { settingsVersion: saved.version, page, ...result };
  }

  private async readRepositories(connection: SyncConnection, options: ReadOptions): Promise<ProjectReadOutcome[]> {
    const reads: ProjectReadOutcome[] = [];
    for (const projectId of connection.projectIds) {
      options.signal?.throwIfAborted();
      try { reads.push({ projectId, plan: await readProjectPlan(connection, projectId, options) }); }
      catch (error) {
        if (!(error instanceof GitlabReadError) || error.stage === 'webhooks' || error.stage === 'deployments' ||
          error.stage === 'deployment-merge-requests' || error.stage === 'pipeline-jobs' || error.stage === 'pipeline-test-report' || error.stage === 'pipeline-failed-tests' ||
          error.stage === 'merge-request-review' || error.stage === 'merge-request-discussions' || error.stage === 'merge-request-pipeline') throw error;
        const { stage, httpStatus, message } = error;
        reads.push({ projectId, failure:{ projectId, status:'error', counts:emptyCounts(options.includeHistory), error:{stage,httpStatus,message} } });
      }
      options.signal?.throwIfAborted();
      this.currentForSync(connection.version);
    }
    return reads;
  }

  async previewDeployments(value: unknown, signal?: AbortSignal): Promise<GitlabDeploymentPreviewResult> {
    const input = record(value);
    if (Object.keys(input).some(key => !['repositoryId', 'expectedVersion', 'baseUrl', 'projectIds', 'token'].includes(key)) ||
        !Object.hasOwn(input, 'expectedVersion') || !Object.hasOwn(input, 'repositoryId')) {
      return fail('GitLab 배포 조회 미리보기 요청을 확인해 주세요.');
    }
    const saved = this.raw();
    assertSettingsVersion(input.expectedVersion, saved.version);
    const { repositoryId } = input;
    if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1) {
      return fail('배포 이력을 읽을 GitLab 저장소를 선택해 주세요.');
    }
    const draft = Object.hasOwn(input, 'baseUrl');
    if (draft !== Object.hasOwn(input, 'projectIds')) return fail('미리 볼 GitLab 주소와 저장소 ID를 함께 입력해 주세요.');
    const address = draft ? baseUrl(input.baseUrl) : saved.baseUrl;
    const allowed = draft ? projectIds(input.projectIds) : saved.projectIds;
    if (draft && !address) return fail('미리 볼 GitLab 주소를 입력해 주세요.');
    if (!address || !allowed.includes(repositoryId)) {
      return fail(draft ? '입력한 GitLab 저장소를 선택해 주세요.' : '저장된 GitLab 저장소를 선택해 주세요.', 403);
    }

    const token = this.draftReadToken(input, address, saved);
    const history = await readGitlabDeploymentHistory({ baseUrl: address, token }, repositoryId, signal).finally(() => {
      signal?.throwIfAborted();
      assertSettingsVersion(saved.version, this.raw().version);
    }).catch(error => {
      if (error instanceof GitlabReadError) return failGitlabDeploymentRead(error);
      throw error;
    });
    const { deployments, scanned: deploymentsRead, deploymentLimitReached, associationUnavailable,
      associationLimited, associationDenied, associationRateLimited } = history;
    const successfulDeployments = deployments.filter(deployment => deployment.status === 'success').length;
    const mergeRequestsRead = deployments.reduce((sum, deployment) => sum + (deployment.mergeRequests?.length ?? 0), 0);
    const partial = deploymentLimitReached || associationUnavailable > 0 || associationLimited > 0;
    return { repositoryId, settingsVersion: saved.version, status: partial ? 'partial' : deploymentsRead ? 'ok' : 'empty',
      deploymentsRead, successfulDeployments, mergeRequestsRead, deploymentLimitReached,
      associationUnavailable, associationLimited, associationDenied, associationRateLimited };
  }

  deploymentStatusProof(issueId: string, binding: GitlabDeploymentStatusBinding): string | null {
    const settings = this.raw();
    if (!settings.baseUrl || this.instance(settings) !== binding.instance || !settings.projectIds.includes(binding.repositoryId)) return null;
    return this.deployments.statusReviewProof(issueId, binding);
  }

  async reviewDeploymentStatus(issueId: string, instance: string, repositoryId: number, deploymentId: number,
    value: unknown, actorId: string, signal: AbortSignal): Promise<GitlabDeploymentReviewResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length ||
        !/^[a-f0-9]{12}$/u.test(instance) || !numericObjectId(repositoryId) || !numericObjectId(deploymentId)) {
      fail('업무의 GitLab 배포 상태 검토 요청을 확인해 주세요.');
    }
    const issue = this.requireIssue(issueId);
    const settings = this.raw();
    if (!settings.baseUrl || this.instance(settings) !== instance || !settings.projectIds.includes(repositoryId)) {
      fail('현재 GitLab 연결에 이 저장소가 없습니다.', 403);
    }
    const identity = { instance, repositoryId, deploymentId };
    const target = this.deployments.issueReviewTarget(issueId, identity);
    if (!target) fail('업무에 연결된 GitLab 배포를 찾을 수 없습니다.', 404);

    const workspaceGeneration = this.store.setting('attachmentImportGeneration');
    const token = settings.token ? this.store.unseal(settings.token) : null;
    const capturedAt = Date.now();
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertSettingsVersion(settings.version, this.raw().version);
      if (this.store.setting('attachmentImportGeneration') !== workspaceGeneration) fail('워크스페이스가 복원되었습니다. 업무를 다시 열어 주세요.', 409);
      const latestIssue = this.store.get<Issue>('issues', issueId);
      const latestTarget = this.deployments.issueReviewTarget(issueId, identity);
      if (!latestIssue || latestIssue.version !== issue.version || latestIssue.projectId !== issue.projectId || latestIssue.key !== issue.key ||
          latestTarget?.fence !== target.fence) fail('업무 또는 배포 연결이 변경되었습니다. 최신 업무에서 다시 확인해 주세요.', 409);
      return { latestIssue, latestTarget };
    };
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(25_000);
    let read: Awaited<ReturnType<typeof readGitlabDeploymentStatus>>;
    try {
      read = await readGitlabDeploymentStatus({ baseUrl: settings.baseUrl, token }, target.deployment, AbortSignal.any([signal, deadline]));
    } catch (error) {
      assertCurrent();
      if (deadline.aborted) fail('GitLab 배포 상태 조회 시간이 초과되었습니다.', 504);
      if (error instanceof GitlabReadError) failGitlabWorkflowRead(error);
      throw error;
    }

    return this.store.transaction(() => {
      const { latestIssue, latestTarget } = assertCurrent();
      this.deployments.recordSync(instance, repositoryId, [read.deployment], capturedAt);
      const deployment = this.deployments.deployment(identity);
      if (!deployment || deployment.status !== read.deployment.status || deployment.environment !== read.deployment.environment ||
          deployment.sha !== read.deployment.sha || deployment.source === 'sync' && deployment.changedAt > read.deployment.changedAt) {
        fail('배포 상태가 변경되었습니다. 최신 업무에서 다시 확인해 주세요.', 409);
      }
      const { finishedAt } = read;
      const state = read.state !== 'ready' ? read.state : !finishedAt ? 'completion-unverified' :
        this.deployments.hasCompetingSuccess(deployment, finishedAt) ? 'superseded' : 'ready';
      const exact = { instance, ...read.deployment };
      this.deployments.recordReviewEvidence(exact, state === 'ready' ? finishedAt : null);
      if (state !== 'ready' || !finishedAt) return { deployment, state };
      const link = this.deployments.reviewLink(latestTarget.links, exact);
      const binding = link && { ...identity, linkId: link.id, occurredAt: finishedAt };
      if (!link || !binding || !this.deploymentStatusProof(issueId, binding)) return { deployment, state: 'link-unverified' };
      const statusReview = this.hooks.manualStatusReview?.(latestIssue,
        [{ trigger: 'deployment.succeeded', link, occurredAt: finishedAt, deployment }], actorId, settings.version);
      return statusReview ? { deployment, state: 'ready', statusReview } : { deployment, state: 'no-rule' };
    });
  }

  async syncDeployments(value: unknown, signal?: AbortSignal, afterSave?: (result: GitlabDeploymentSyncResult) => void): Promise<GitlabDeploymentSyncResult> {
    const input = record(value);
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'repositoryId') || !Object.hasOwn(input, 'expectedVersion')) {
      return fail('GitLab 배포 이력 동기화 요청을 확인해 주세요.');
    }
    const saved = this.raw();
    assertSettingsVersion(input.expectedVersion, saved.version);
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId < 1) {
      return fail('배포 이력을 읽을 GitLab 저장소를 선택해 주세요.');
    }
    if (!saved.baseUrl || !saved.projectIds.includes(repositoryId)) return fail('저장된 GitLab 저장소를 선택해 주세요.', 403);
    const instance = this.instance(saved);
    const key = `${instance}:${repositoryId}`;
    if (this.deploymentSyncs.has(key)) return fail('이 저장소의 배포 이력을 동기화 중입니다.', 409);
    const token = saved.token ? this.store.unseal(saved.token) : null;
    const capturedAt = Date.now();
    const sequence = this.syncAttempts.start();
    let saving = false;
    this.deploymentSyncs.add(key);
    try {
      signal?.throwIfAborted();
      const history = await readGitlabDeploymentHistory({ baseUrl: saved.baseUrl, token }, repositoryId, signal);
      signal?.throwIfAborted();
      saving = true;
      return this.store.transaction(() => {
        this.currentForSync(saved.version);
        const { stored, mergeRequestsStored } = this.deployments.recordSync(instance, repositoryId, history.deployments, capturedAt);
        const summary = { repositoryId, deploymentsRead: history.scanned,
          deploymentsStored: stored, mergeRequestsStored,
          associationUnavailable: history.associationUnavailable, associationLimited: history.associationLimited,
          deploymentLimitReached: history.deploymentLimitReached };
        this.syncAttempts.deployments(repositoryId, sequence, now(), { status: 'ok', result: summary, error: null });
        const result = { ...summary, settingsVersion: saved.version } satisfies GitlabDeploymentSyncResult;
        if (stored || mergeRequestsStored) afterSave?.(result);
        return result;
      });
    } catch (error) {
      signal?.throwIfAborted();
      this.currentForSync(saved.version);
      if (error instanceof GitlabReadError) {
        const stage = error.stage === 'deployment-merge-requests' ? error.stage : 'deployments';
        this.store.transaction(() => {
          this.currentForSync(saved.version);
          this.syncAttempts.deployments(repositoryId, sequence, now(), { status: 'error', result: null,
            error: { stage, httpStatus: error.httpStatus, message: error.message } });
        });
        return failGitlabDeploymentRead(error);
      }
      if (saving) this.store.transaction(() => {
        this.currentForSync(saved.version);
        this.syncAttempts.deployments(repositoryId, sequence, now(), { status: 'error', result: null,
          error: { stage: 'save', httpStatus: null, message: 'GitLab 배포 이력 동기화 결과를 저장하지 못했습니다.' } });
      });
      throw error;
    } finally {
      this.deploymentSyncs.delete(key);
    }
  }

  async previewSync(value:unknown, signal?:AbortSignal):Promise<GitlabSyncPreview>{
    const input=record(value),saved=this.raw(),startedAt=Date.now();
    if(Object.keys(input).some(key=>!['expectedVersion','baseUrl','projectIds','token','includeHistory','jiraRoutes'].includes(key)))fail('지원하지 않는 GitLab 미리보기 요청입니다.');
    assertSettingsVersion(input.expectedVersion,saved.version);
    const includeHistory=historyRequested(input);
    const address='baseUrl'in input?baseUrl(input.baseUrl):saved.baseUrl;
    const repositories='projectIds'in input?projectIds(input.projectIds):saved.projectIds;
    if(!address||!repositories.length)fail('GitLab 주소와 저장소 ID를 입력해 주세요.');
    const jiraRoutes=this.submittedJiraRoutes(input,saved,address,repositories);
    const token=this.draftReadToken(input,address,saved);
    const connection={baseUrl:address,projectIds:repositories,jiraRoutes,token,version:saved.version,webhookCredentials:this.webhookCredentials(saved)};
    const reads=await this.readRepositories(connection,{signal,includeHistory});
    const candidates:GitlabSyncPreviewCandidate[]=[],counts=emptyCounts(includeHistory),issues=this.syncIssues(),instance=this.instance(connection);
    const outcomes:GitlabSyncPreview['repositories']=reads.map(read=>{
      const {projectId}=read;
      if('failure'in read)return read.failure;
      const matcher=this.ticketMatcher(issues,jiraRoutes.find(route=>route.repositoryId===projectId));
      const projectCounts=this.visitProjectLinks(instance,read.plan,startedAt,matcher,token,(link,{issue,originalJiraKey},action,kind,objectId)=>{
        if(candidates.length<PREVIEW_CANDIDATE_LIMIT)candidates.push({
          projectId,kind,objectId:safePreviewValue(objectId,token),title:safePreviewValue(link.title,token),state:safePreviewValue(link.state.slice(0,100),token),
          issueId:issue.id,issueKey:issue.key,issueTitle:issue.title,action,...(originalJiraKey?{originalJiraKey:safePreviewValue(originalJiraKey,token)}:{}),
        });
      });
      for(const key of Object.keys(counts) as (keyof GitlabSyncPreviewCounts)[])counts[key]=(counts[key]??0)+(projectCounts[key]??0);
      return {projectId,status:'ok',counts:projectCounts,error:null,...(read.plan.history?{historyLimits:read.plan.history.limits}:{}),...(matcher.ambiguousKeys.size?{ambiguousKeys:[...matcher.ambiguousKeys].map(key=>safePreviewValue(key,token))}:{})};
    });
    return {settingsVersion:saved.version,baseUrl:address,projectIds:repositories,repositories:outcomes,counts,candidates,
      candidatesTruncated:counts.create+counts.update+counts.unchanged>candidates.length};
  }

  async sync(afterSync?:(scanned:number,linked:number,failedRepositories:number)=>void,{includeHistory=false,expectedVersion,repositoryIds}:SyncOptions = {}):Promise<GitlabSyncResult>{
    const captured=this.raw(),startedAt=Date.now();
    if(expectedVersion!==undefined||repositoryIds!==undefined)assertSettingsVersion(expectedVersion,captured.version);
    if(!captured.baseUrl||!captured.projectIds.length)fail('GitLab 주소와 저장소 ID를 먼저 설정해 주세요.');
    const selected=repositoryIds===undefined?captured.projectIds:projectIds(repositoryIds);
    if(!selected.length||selected.some(id=>!captured.projectIds.includes(id)))fail('저장한 GitLab 연결의 저장소를 선택해 주세요.');
    if(includeHistory&&this.historySyncActive)fail('기존 브랜치·커밋 동기화가 진행 중입니다.',409);
    const sequence = this.syncAttempts.start();
    let readOutcomes: ProjectReadOutcome[] | undefined;
    if(includeHistory)this.historySyncActive=true;
    try{
      const connection={...captured,projectIds:selected,token:captured.token?this.store.unseal(captured.token):null,
        webhookCredentials:this.webhookCredentials(captured)};
      const reads=await this.readRepositories(connection,{includeHistory});
      readOutcomes = reads;
      const failures=reads.flatMap(read=>'failure'in read?[read.failure]:[]);
      const partial=failures.length>0;
      const failureSummary=`저장소 ${failures.length}곳을 조회하지 못했습니다.`;
      if(failures.length===reads.length){
        const reason=failures.length===1?failures[0].error.message:failureSummary;
        const details:GitlabSyncFailure={settingsVersion:captured.version,reason,repositories:failures};
        this.store.transaction(()=>{
          const current=this.currentForSync(captured.version);
          this.store.setSetting('gitlab',{...current,lastError:reason});
          this.syncAttempts.activity(sequence, now(), includeHistory, failures);
        });
        fail('GitLab 동기화에 실패했습니다.',502,details);
      }
      let scanned=0,linked=0;
      const repositories:GitlabSyncRepositoryResult[]=[];
      const historyCounts={branches:0,commits:0},historyLimits={branches:false,commits:false};
      this.store.transaction(()=>{
        const current=this.currentForSync(captured.version),instance=this.instance(current),issues=this.syncIssues();
        for(const read of reads){
          if('failure'in read){repositories.push(read.failure);continue;}
          const {plan}=read;
          const matcher=this.ticketMatcher(issues,current.jiraRoutes?.find(route=>route.repositoryId===plan.projectId));
          const counts=this.visitProjectLinks(instance,plan,startedAt,matcher,connection.token,(link,_match,action)=>{if(action!=='unchanged')this.store.put('gitlab_links',link);},true);
          repositories.push({projectId:read.projectId,status:'ok',counts,error:null,...(plan.history?{historyLimits:plan.history.limits}:{})});
          scanned+=counts.mergeRequests+counts.pipelines+(counts.branches??0)+(counts.commits??0);
          linked+=counts.create+counts.update;
          if(plan.history){
            historyCounts.branches+=counts.branches??0;
            historyCounts.commits+=counts.commits??0;
            historyLimits.branches||=plan.history.limits.branches;
            historyLimits.commits||=plan.history.limits.commits;
          }
        }
        const completedAt = now();
        this.store.setSetting('gitlab',{...current,lastSyncAt:completedAt,lastError:partial?failureSummary:null});
        this.syncAttempts.activity(sequence, completedAt, includeHistory, repositories);
        afterSync?.(scanned,linked,failures.length);
      });
      const notice=includeHistory ? '저장소당 브랜치 최대 500개와 최근 커밋 100개를 함께 확인했습니다. 업무 상태는 자동 변경하지 않습니다.'
        : 'MR은 저장소당 최근 최대 1000개, 파이프라인은 최근 50개를 조회합니다. 업무 상태는 자동 변경하지 않습니다.';
      return{ok:true,scanned,linked,settings:this.settings(),notice,partial,repositories,...(includeHistory?{historyCounts,historyLimits}:{})};
    }catch(error){
      this.currentForSync(captured.version);
      if(error instanceof GitlabIntegrationError)throw error;
      const message='GitLab 동기화 결과를 저장하지 못했습니다.';
      this.store.transaction(()=>{
        const current=this.currentForSync(captured.version);
        this.store.setSetting('gitlab',{...current,lastError:message});
        if (readOutcomes) this.syncAttempts.activity(sequence, now(), includeHistory, readOutcomes.map(read => 'failure' in read
          ? read.failure : { projectId: read.projectId, status: 'error', counts: emptyCounts(includeHistory), error: { stage: 'save', httpStatus: null, message } }));
      });
      return fail('GitLab 동기화에 실패했습니다.',502,{reason:message});
    }finally{if(includeHistory)this.historySyncActive=false;}
  }
  registerRoutes(app:Express,hooks:RouteHooks):void{
    app.get('/api/integrations/gitlab',(_req,res)=>res.json(this.settings()));
    app.get('/api/integrations/gitlab/sync-status',(req,res)=>{
      res.set('Cache-Control','no-store');
      if (Object.keys(req.query).length) fail('동기화 상태 조회 조건을 확인해 주세요.');
      res.json(this.syncStatus());
    });
    app.get('/api/integrations/gitlab/jira-sources',(_req,res)=>res.set('Cache-Control','no-store').json(this.jiraSources()));
    app.get('/api/integrations/gitlab/webhook-status',(req,res)=>{
      res.set('Cache-Control','no-store');
      if (Object.keys(req.query).length) fail('웹훅 수신 상태 조회 조건을 확인해 주세요.');
      res.json(this.webhookStatus());
    });
    const deploymentOffset=(request:Request)=>{
      const value=request.query.offset??'0';
      if(typeof value!=='string'||!/^\d+$/u.test(value)||!Number.isSafeInteger(Number(value)))fail('GitLab 배포 조회 위치를 확인해 주세요.');
      return Number(value);
    };
    app.get('/api/integrations/gitlab/deployments',(req,res)=>{
      if(Object.keys(req.query).some(key=>key!=='repositoryId'&&key!=='offset'))fail('GitLab 배포 조회 조건을 확인해 주세요.');
      const repositoryId=Number(numericObjectId(req.query.repositoryId));
      const settings=this.raw();
      if(!repositoryId)fail('배포를 조회할 GitLab 저장소를 선택해 주세요.');
      if(!settings.projectIds.includes(repositoryId))fail('저장된 GitLab 저장소를 선택해 주세요.',403);
      res.set('Cache-Control','no-store').json(this.deployments.repositoryPage(this.instance(settings),repositoryId,deploymentOffset(req)));
    });
    app.post('/api/integrations/gitlab/deployments/preview', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      hooks.actor(req);
      if (Object.keys(req.query).length) fail('GitLab 배포 조회 미리보기 조건을 확인해 주세요.');
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.previewDeployments(req.body, controller.signal);
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    app.post('/api/integrations/gitlab/deployments/sync', async (req, res) => {
      hooks.actor(req);
      res.set('Cache-Control', 'no-store');
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.syncDeployments(req.body, controller.signal, ({ repositoryId, deploymentsStored, mergeRequestsStored }) => {
          hooks.activity(req, 'integration', 'gitlab', 'GitLab 배포 이력 동기화', `저장소 ${repositoryId} · 배포 ${deploymentsStored}건 · 포함 MR ${mergeRequestsStored}건`);
        });
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    app.get('/api/issues/:id/gitlab-deployments',(req,res)=>{
      if(Object.keys(req.query).some(key=>key!=='offset'))fail('GitLab 배포 조회 조건을 확인해 주세요.');
      const issue=this.requireIssue(String(req.params.id));
      res.set('Cache-Control','no-store').json(this.deployments.issuePage(issue.id,deploymentOffset(req)));
    });
    app.post('/api/issues/:id/gitlab-deployments/:instance/:repositoryId/:deploymentId/status-review', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).length) fail('업무의 GitLab 배포 상태 검토 요청을 확인해 주세요.');
      const actorId = hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.reviewDeploymentStatus(String(req.params.id), String(req.params.instance),
          Number(numericObjectId(req.params.repositoryId)), Number(numericObjectId(req.params.deploymentId)), req.body, actorId, controller.signal);
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    app.patch('/api/integrations/gitlab',(req,res)=>{hooks.actor(req);res.json(this.configure(req.body,()=>hooks.activity(req,'integration','gitlab','GitLab 설정 변경')));});
    app.post('/api/integrations/gitlab/webhook',(req,res)=>res.json(this.webhook(req)));
    const projectWebhookRequest = (operation: 'review' | 'register' | 'history') => async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const actorId = hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        if (operation === 'history') {
          if (Object.keys(req.query).length) fail('웹훅 전송 이력 조회 조건을 확인해 주세요.');
          const { settingsVersion, repositoryId, hookId, attempts, partial, messageDigests, receiverUrl } =
            await this.projectWebhooks.history(req.body, controller.signal);
          if (controller.signal.aborted) return;
          const current = this.raw();
          if (current.version !== settingsVersion || !current.projectIds.includes(repositoryId)) {
            fail('GitLab 연결 설정이 변경되었습니다. 최신 설정에서 다시 점검해 주세요.', 409);
          }
          const localReceipt = this.store.get<StoredWebhookDelivery>('gitlab_webhook_deliveries', String(repositoryId))?.delivery ?? null;
          const response: GitlabProjectWebhookHistory = { settingsVersion, repositoryId, hookId, partial, localReceipt,
            attempts: attempts.map(attempt => {
              const digest = messageDigests.get(attempt.id);
              let messageReceipt: GitlabProjectWebhookMessageReceipt = { status: 'unavailable' };
              if (digest && attempt.event !== 'other') {
                const delivery = this.webhookReceipts.match({ instance: current.baseUrl, repositoryId, event: attempt.event, receiverUrl }, digest);
                messageReceipt = delivery ? { status: 'matched', delivery } : { status: 'unconfirmed' };
              }
              return { ...attempt, messageReceipt };
            }),
          };
          return res.json(response);
        }
        const result = await this.projectWebhooks[operation](req.body, actorId, controller.signal);
        if (result.state === 'created') {
          try { hooks.activity(req, 'integration', 'gitlab', 'GitLab 웹훅 등록', `저장소 ${result.repositoryId}`); }
          catch { console.error('[teamspace GitLab] 웹훅 등록 활동을 기록하지 못했습니다.'); }
        }
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    };
    app.post('/api/integrations/gitlab/project-webhook-review', projectWebhookRequest('review'));
    app.post('/api/integrations/gitlab/project-webhook-register', projectWebhookRequest('register'));
    app.post('/api/integrations/gitlab/project-webhook-history', projectWebhookRequest('history'));
    const issueBranchRequest = (operation: 'preview' | 'apply' | 'reconcile') => async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).length) fail('브랜치 생성 요청의 입력을 확인해 주세요.');
      const actorId = hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.issueBranches[operation](String(req.params.id), req.body, actorId, controller.signal);
        if (!controller.signal.aborted) res.status(result.state === 'created' ? 201 : 200).json(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof GitlabIssueBranchError) return res.status(error.status).json({ error: error.message, details: error.details });
        throw error;
      } finally { res.off('close', disconnected); }
    };
    app.post('/api/issues/:id/gitlab-branch/preview', issueBranchRequest('preview'));
    app.post('/api/issues/:id/gitlab-branch/apply', issueBranchRequest('apply'));
    app.post('/api/issues/:id/gitlab-branch/reconcile', issueBranchRequest('reconcile'));
    const linkedWorkflowRead = (queryError: string,
      read: (issueId: string, linkId: string, signal: AbortSignal, queryValue: string | null) => Promise<unknown>,
      queryParameter?: 'targetBranch' | 'revision',
    ) => async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      const value = queryParameter ? req.query[queryParameter] : undefined;
      if (Object.keys(req.query).some(key => key !== queryParameter) ||
          (queryParameter === 'targetBranch' && value !== undefined && !isGitlabBranchName(value)) ||
          (queryParameter === 'revision' && (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)))) fail(queryError);
      hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await read(String(req.params.id), String(req.params.linkId), controller.signal, typeof value === 'string' ? value : null);
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    };
    app.get('/api/issues/:id/gitlab-links/:linkId/pipeline-jobs',
      linkedWorkflowRead('GitLab CI 작업 조회 조건을 확인해 주세요.', this.pipelineJobs.bind(this)));
    app.get('/api/issues/:id/gitlab-links/:linkId/pipeline-test-report',
      linkedWorkflowRead('GitLab 테스트 결과 조회 조건을 확인해 주세요.', this.pipelineTestReport.bind(this)));
    app.get('/api/issues/:id/gitlab-links/:linkId/pipeline-failed-tests',
      linkedWorkflowRead('GitLab 실패 테스트 상세 조회 조건을 확인해 주세요.', this.pipelineFailedTests.bind(this)));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-review',
      linkedWorkflowRead('GitLab MR 검토 조회 조건을 확인해 주세요.', this.mergeRequestReview.bind(this)));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-discussions',
      linkedWorkflowRead('GitLab MR 토론 조회 조건을 확인해 주세요.', this.mergeRequestDiscussions.bind(this)));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-pipeline',
      linkedWorkflowRead('GitLab MR 파이프라인 조회 조건을 확인해 주세요.', (issueId, linkId, signal) => this.mergeRequestPipeline(issueId, linkId, signal, false)));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-pipeline-jobs',
      linkedWorkflowRead('GitLab MR 파이프라인 작업 조회 조건을 확인해 주세요.', (issueId, linkId, signal) => this.mergeRequestPipeline(issueId, linkId, signal, true)));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-pipeline-test-report',
      linkedWorkflowRead('GitLab MR 파이프라인 테스트 조회 조건을 확인해 주세요.', (issueId, linkId, signal, revision) =>
        this.readMergeRequestPipelineTestInfo(issueId, linkId, signal, revision, 'GitLab 테스트 결과', readers => readers.testReport()), 'revision'));
    app.get('/api/issues/:id/gitlab-links/:linkId/merge-request-pipeline-failed-tests',
      linkedWorkflowRead('GitLab MR 파이프라인 실패 테스트 조회 조건을 확인해 주세요.', (issueId, linkId, signal, revision) =>
        this.readMergeRequestPipelineTestInfo(issueId, linkId, signal, revision, 'GitLab 실패 테스트 상세', readers => readers.failedTests()), 'revision'));
    app.get('/api/issues/:id/gitlab-links/:linkId/branch-merge-requests',
      linkedWorkflowRead('GitLab 브랜치의 MR 조회 조건을 확인해 주세요.', this.branchMergeRequests.bind(this), 'targetBranch'));
    const linkDetail=(link:GitlabLink)=>`${link.kind==='merge_request'?`MR !${link.iid}`:`파이프라인 #${link.iid}`} · 저장소 ${link.projectId}`;
    app.post('/api/issues/:id/gitlab-links/:linkId/merge-request-pipeline', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).length) fail('업무에 연결할 GitLab MR 파이프라인 정보를 확인해 주세요.');
      hooks.actor(req);
      const issueId = String(req.params.id);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const { link, created } = await this.attachMergeRequestPipeline(issueId, String(req.params.linkId), req.body, link => {
          hooks.activity(req, 'issue', issueId, 'GitLab 활동 수동 연결', linkDetail(link));
        }, controller.signal);
        if (!controller.signal.aborted) res.status(created ? 201 : 200).json(link);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    app.post('/api/issues/:id/gitlab-links/:linkId/branch-merge-requests', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).length) fail('브랜치에 연결할 GitLab MR의 정보를 확인해 주세요.');
      hooks.actor(req);
      const issueId = String(req.params.id);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const { link, created } = await this.attachBranchMergeRequest(issueId, String(req.params.linkId), req.body, link => {
          hooks.activity(req, 'issue', issueId, 'GitLab 활동 수동 연결', linkDetail(link));
        }, controller.signal);
        if (!controller.signal.aborted) res.status(created ? 201 : 200).json(link);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    const issueGitlabRefresh = (mode: IssueGitlabRefreshMode) => async (req: Request, res: Response) => {
      res.set('Cache-Control','no-store');
      if (Object.keys(req.query).length) fail('GitLab 활동 갱신 요청을 확인해 주세요.');
      const actorId=hooks.actor(req);
      const controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',disconnected);
      try {
        const result=await this.refreshIssueLinks(String(req.params.id),req.body,controller.signal,actorId,
          mode === 'all' ? undefined : String(req.params.linkId), mode === 'status-review');
        if(!controller.signal.aborted)res.json(result);
      } catch(error) { if(!controller.signal.aborted)throw error; }
      finally { res.off('close',disconnected); }
    };
    app.post('/api/issues/:id/gitlab-links/refresh',issueGitlabRefresh('all'));
    app.post('/api/issues/:id/gitlab-links/:linkId/refresh',issueGitlabRefresh('exact'));
    app.post('/api/issues/:id/gitlab-links/:linkId/status-review',issueGitlabRefresh('status-review'));
    app.post('/api/issues/:id/gitlab-links',async(req,res)=>{
      hooks.actor(req);
      const issueId=String(req.params.id),controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',disconnected);
      try{
        const {link,created}=await this.attachLink(issueId,req.body,link=>{
          hooks.activity(req,'issue',issueId,'GitLab 활동 수동 연결',linkDetail(link));
        },controller.signal);
        if(!controller.signal.aborted)res.status(created?201:200).set('Cache-Control','no-store').json(link);
      }catch(error){if(!controller.signal.aborted)throw error;}
      finally{res.off('close',disconnected);}
    });
    app.delete('/api/issues/:id/gitlab-links/:linkId',(req,res)=>{
      hooks.actor(req);
      if(Object.keys(req.query).some(key=>key!=='expectedManualLinkId'))fail('GitLab 연결 해제 요청을 확인해 주세요.');
      const issueId=String(req.params.id);
      this.removeAttachedLink(issueId,String(req.params.linkId),req.query.expectedManualLinkId,link=>{
        hooks.activity(req,'issue',issueId,'GitLab 수동 연결 해제',linkDetail(link));
      });
      res.set('Cache-Control','no-store').json({ok:true});
    });
    app.post('/api/integrations/gitlab/repository-search', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      hooks.actor(req);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const result = await this.searchRepositories(req.body, controller.signal);
        if (!controller.signal.aborted) res.json(result);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { res.off('close', disconnected); }
    });
    app.post('/api/integrations/gitlab/sync-preview',async(req,res)=>{
      hooks.actor(req);
      const controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};
      res.once('close',disconnected);
      try{
        const result=await this.previewSync(req.body,controller.signal);
        if(!controller.signal.aborted)res.set('Cache-Control','no-store').json(result);
      }catch(error){if(!controller.signal.aborted)throw error;}
      finally{res.off('close',disconnected);}
    });
    app.post('/api/integrations/gitlab/sync',(req:Request,res:Response,next:NextFunction)=>{
      hooks.actor(req);
      const input=record(req.body),includeHistory=historyRequested(input);
      void this.sync((scanned,linked,failed)=>hooks.activity(req,'integration','gitlab','GitLab 재동기화',
        `${scanned}개 항목 확인, ${linked}개 업무 연결${failed?`, 저장소 ${failed}곳 조회 실패`:''}`),
      {includeHistory,expectedVersion:input.expectedVersion,repositoryIds:input.repositoryIds}).then(result=>res.json(result),next);
    });
  }
}
