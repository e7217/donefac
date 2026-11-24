import { createHash, randomUUID } from 'node:crypto';
import type { Express,Request } from 'express';
import type { AutomationEvent,AutomationOutcome,AutomationPreview,AutomationRule,AutomationRun,GitlabSettings,Issue,IssueAutomationRunPage,Project,ProjectIssueSchema,ProjectWorkflow,User } from '../shared/types.js';
import type { GitlabDeploymentStatusBinding, GitlabLink, GitlabStatusObservation, GitlabStatusReview, GitlabWorkflowStatusSuggestionTrigger } from '../shared/types.js';
import { AUTOMATION_TRIGGERS,branchMatches,isGitlabDeploymentEnvironment,isPipelineAutomationTrigger,sortedAutomationRules } from '../shared/automation.js';
import { gitlabPipelineSource } from '../shared/gitlab-pipeline-source.js';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import { allowedNextStatuses,defaultWorkflow } from '../shared/workflow-helpers.js';
import type { Store } from './store.js';

const ISSUE_RUN_PAGE_SIZE = 20;
const MANUAL_STATUS_TOKEN_DOMAIN = 'teamspace.gitlab-status-suggestion.v1';
const MANUAL_STATUS_TOKEN_TTL = 5 * 60 * 1_000;
const MAX_MANUAL_STATUS_TOKEN_LENGTH = 32 * 1024;
const MANUAL_STATUS_TOKEN = /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]+={0,2}$/u;
const MANUAL_STATUS_SOURCES: Record<GitlabWorkflowStatusSuggestionTrigger, { kind: GitlabLink['kind']; state: string }> = {
  'pipeline.succeeded': { kind: 'pipeline', state: 'success' },
  'pipeline.failed': { kind: 'pipeline', state: 'failed' },
  'merge_request.merged': { kind: 'merge_request', state: 'merged' },
  'merge_request.closed': { kind: 'merge_request', state: 'closed' },
};

export class AutomationError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
function fail(message:string,status=400,details?:unknown):never{throw new AutomationError(status,message,details);}
type Connection=Pick<GitlabSettings,'baseUrl'|'projectIds'|'webhookSecretConfigured'|'signingTokenConfigured'|'jiraRoutes'>;
type PipelineEvidence = Pick<AutomationEvent, 'pipelineSource' | 'pipelineTag'>;
type MatchEvent = Pick<AutomationEvent, 'trigger' | 'gitlabProjectId' | 'branch' | 'environment'> & PipelineEvidence;
type ManualDeploymentProof = { binding: GitlabDeploymentStatusBinding; digest: string };
type AfterStatusChange=(rule:AutomationRule,event:AutomationEvent)=>void;
type PreparedChange={outcome:AutomationOutcome;next?:Issue;afterStatusChange?:AfterStatusChange};
export interface AutomationHooks{
  getGitlabSettings:()=>Connection;
  latestVerifiedPipelineId?:(link:GitlabLink)=>number|null;
  deploymentStatusProof?:(issueId:string,binding:GitlabDeploymentStatusBinding)=>string|null;
  prepareChange:(before:Issue,status:string,afterStatusChange:(effect:AfterStatusChange)=>void)=>Issue;
  commitChange:(rule:AutomationRule,before:Issue,next:Issue,event:AutomationEvent)=>void;
}
type RouteHooks={actor:(request:Request)=>string;activity:(request:Request,resourceType:string,resourceId:string,action:string,detail?:string)=>unknown};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('자동화 규칙 객체가 필요합니다.');return value as Record<string,unknown>;}
function text(value:unknown,label:string,max=200):string{if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label}을(를) 확인해 주세요.`);return value.trim();}
function strings(value:unknown,label:string,max:number,allowEmpty=false):string[]{if(!Array.isArray(value)||value.length>max||(!allowEmpty&&!value.length)||value.some(item=>typeof item!=='string'||!item||item.length>200)||new Set(value).size!==value.length)fail(`${label} 목록을 확인해 주세요.`);return[...value];}
function repoIds(value:unknown):number[]{if(!Array.isArray(value)||!value.length||value.length>1000||value.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(value).size!==value.length)fail('GitLab 프로젝트 ID를 하나 이상 선택해 주세요.');return[...value].sort((a,b)=>a-b);}
function validTime(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function normalizeBase(value:unknown):string{if(typeof value!=='string'||!value)return'';let url:URL;try{url=new URL(value);}catch{fail('GitLab 주소를 확인해 주세요.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('인증 정보가 없는 GitLab http(s) 주소가 필요합니다.');return url.toString().replace(/\/+$/,'');}
function version(value:unknown,current:number){if(!Number.isSafeInteger(value)||Number(value)<1)fail('expectedVersion이 필요합니다.');if(value!==current)fail('자동화 규칙이 변경되었습니다. 최신 설정을 확인해 주세요.',409,{currentVersion:current});}

function isDeploymentStatusBinding(value: unknown): value is GitlabDeploymentStatusBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { instance, repositoryId, deploymentId, linkId, occurredAt } = value as Partial<GitlabDeploymentStatusBinding>;
  return typeof instance === 'string' && /^[a-f0-9]{12}$/u.test(instance) &&
    typeof repositoryId === 'number' && Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
    typeof deploymentId === 'number' && Number.isSafeInteger(deploymentId) && deploymentId > 0 &&
    typeof linkId === 'string' && linkId.length > 0 && linkId.length <= 500 && validTime(occurredAt);
}

export function isDeploymentAutomationContext(value: { objectKind?: unknown; objectId?: unknown; branch?: unknown; environment?: unknown }): boolean {
  const { objectKind, objectId, branch, environment } = value;
  return objectKind === 'deployment' && typeof objectId === 'string' && /^[1-9]\d{0,15}$/u.test(objectId) &&
    Number.isSafeInteger(Number(objectId)) && branch === '' && isGitlabDeploymentEnvironment(environment);
}

function parsePipelineEvidence(value: { pipelineSource?: unknown; pipelineTag?: unknown }, pipeline: boolean, message: string): PipelineEvidence {
  const { pipelineSource, pipelineTag } = value;
  if (pipelineSource === undefined && pipelineTag === undefined) return {};
  const source = gitlabPipelineSource(pipelineSource);
  if (!pipeline || (pipelineSource !== undefined && !source) || (pipelineTag !== undefined && typeof pipelineTag !== 'boolean')) fail(message);
  return {
    ...(source === undefined ? {} : { pipelineSource: source }),
    ...(typeof pipelineTag === 'boolean' ? { pipelineTag } : {}),
  };
}

function config(value:unknown,projectId:string,actorId:string,workflow:ProjectWorkflow,schema:ProjectIssueSchema,users:User[]):Omit<AutomationRule,'id'|'gitlabBaseUrl'|'enabledAt'|'version'|'createdAt'|'updatedAt'>{
  const input=object(value);if(typeof input.enabled!=='boolean')fail('자동화 사용 여부를 확인해 주세요.');
  if(typeof input.trigger!=='string'||!AUTOMATION_TRIGGERS.includes(input.trigger as AutomationRule['trigger']))fail('지원하지 않는 GitLab 자동화 이벤트입니다.');
  const trigger = input.trigger as AutomationRule['trigger'];
  let environment: string | undefined;
  let branchPattern = '*';
  if (trigger === 'deployment.succeeded') {
    if (!isGitlabDeploymentEnvironment(input.environment)) fail('GitLab 배포 환경 이름을 정확히 입력해 주세요.');
    environment = input.environment;
  } else {
    const patternLabel = isPipelineAutomationTrigger(trigger) ? '참조 이름 패턴' : '브랜치 패턴';
    branchPattern = text(input.branchPattern, patternLabel, 128);
    if (/[\u0000-\u001f\u007f]/u.test(branchPattern)) fail(`${patternLabel}에 제어 문자를 사용할 수 없습니다.`);
  }
  const pipelineSources = input.pipelineSources === undefined ? [] : strings(input.pipelineSources, '파이프라인 실행 유형', 64, true).sort();
  if (pipelineSources.some(source => !gitlabPipelineSource(source))) fail('파이프라인 실행 유형을 확인해 주세요.');
  const pipelineRefKind = input.pipelineRefKind ?? undefined;
  if (pipelineRefKind !== undefined && pipelineRefKind !== 'branch' && pipelineRefKind !== 'tag') fail('파이프라인 참조 유형을 확인해 주세요.');
  if (!isPipelineAutomationTrigger(trigger) && (pipelineSources.length || pipelineRefKind)) fail('파이프라인 이벤트에서 실행 유형과 참조 유형을 설정할 수 있습니다.');
  const issueTypes=strings(input.issueTypes,'업무 유형',50,true),fromStatuses=strings(input.fromStatuses,'출발 상태',40),toStatusId=text(input.toStatusId,'도착 상태',80),priority=input.priority===undefined?100:input.priority;
  if(issueTypes.some(id=>!schema.issueTypes.some(type=>type.id===id)))fail('프로젝트에 없는 업무 유형입니다.');
  if(fromStatuses.some(id=>!workflow.statuses.some(status=>status.id===id))||!workflow.statuses.some(status=>status.id===toStatusId))fail('프로젝트에 없는 업무 상태입니다.');
  if(!Number.isSafeInteger(priority)||Number(priority)<0||Number(priority)>10000)fail('우선순위는 0~10000의 정수여야 합니다.');
  if(!users.some(user=>user.id===actorId))fail('자동화 실행 팀원을 찾을 수 없습니다.');
  return{projectId,name:text(input.name,'자동화 이름',120),enabled:input.enabled,trigger,gitlabProjectIds:repoIds(input.gitlabProjectIds),branchPattern,
    ...(environment===undefined?{}:{environment}),...(pipelineSources.length?{pipelineSources}:{}),...(pipelineRefKind?{pipelineRefKind}:{}),
    issueTypes:[...issueTypes].sort(),fromStatuses:[...fromStatuses].sort(),toStatusId,actorId,priority:Number(priority)};
}

/** Event processing joins the caller's webhook transaction; it never starts a nested transaction. */
export class AutomationService{
  constructor(private readonly store:Store,private readonly hooks:AutomationHooks){
    store.db.exec(`CREATE TABLE IF NOT EXISTS automation_rules(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,issue_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,occurred_at TEXT,outcome TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(event_id,issue_id));
      CREATE INDEX IF NOT EXISTS automation_runs_issue_time ON automation_runs(issue_id,occurred_at);
      CREATE INDEX IF NOT EXISTS automation_runs_issue ON automation_runs(issue_id);`);
  }
  all():AutomationRule[]{return sortedAutomationRules(this.store.all<AutomationRule>('automation_rules'));}
  runs(projectId?:string,limit=100):AutomationRun[]{if(projectId&&!this.store.get('projects',projectId))fail('프로젝트를 찾을 수 없습니다.',404);if(!Number.isSafeInteger(limit)||limit<1||limit>500)fail('실행 기록 개수는 1~500이어야 합니다.');const rows=this.store.db.prepare(`SELECT json FROM automation_runs ${projectId?'WHERE project_id=?':''} ORDER BY rowid DESC LIMIT ?`).all(...(projectId?[projectId,limit]:[limit])) as {json:string}[];return rows.map(row=>JSON.parse(row.json) as AutomationRun);}
  issueRuns(issueId: string, before?: unknown): IssueAutomationRunPage {
    const issue = this.store.get<Issue>('issues', issueId);
    if (!issue) fail('업무를 찾을 수 없습니다.', 404);
    const params: (string | number)[] = [issueId];
    if (before !== undefined) {
      if (typeof before !== 'string' || !before || before.length > 200) fail('자동화 실행 기록의 위치를 확인해 주세요.');
      const anchor = this.store.db.prepare('SELECT rowid FROM automation_runs WHERE issue_id=? AND id=?')
        .get(issueId, before) as { rowid: number } | undefined;
      if (!anchor) fail('자동화 실행 기록의 위치가 변경되었습니다. 처음부터 다시 불러와 주세요.');
      params.push(anchor.rowid);
    }
    params.push(ISSUE_RUN_PAGE_SIZE + 1);
    const rows = this.store.db.prepare(`SELECT json FROM automation_runs WHERE issue_id=?${before === undefined ? '' : ' AND rowid<?'}
      ORDER BY rowid DESC LIMIT ?`).all(...params) as { json: string }[];
    const items = rows.slice(0, ISSUE_RUN_PAGE_SIZE).map(row => JSON.parse(row.json) as AutomationRun);
    const latest = this.store.db.prepare(`SELECT json FROM automation_runs WHERE issue_id=? AND project_id=?
      AND outcome IN ('changed','no_op','blocked') AND occurred_at IS NOT NULL ORDER BY occurred_at DESC,rowid DESC LIMIT 1`)
      .get(issueId, issue.projectId) as { json: string } | undefined;
    const run = latest ? JSON.parse(latest.json) as AutomationRun : undefined;
    const workflow = { workflows: [this.workflow(issue.projectId)] };
    const canReview = run?.outcome === 'blocked' && run.fromStatus === issue.status && run.toStatus !== issue.status &&
      allowedNextStatuses(workflow, issue).some(status => status.id === run.toStatus);
    return {
      issueVersion: issue.version,
      items,
      nextCursor: rows.length > ISSUE_RUN_PAGE_SIZE ? items[items.length - 1].id : null,
      latestBlockedRunId: canReview ? run.id : null,
    };
  }
  private get(id:string):AutomationRule{return this.store.get<AutomationRule>('automation_rules',id)||fail('자동화 규칙을 찾을 수 없습니다.',404);}
  private workflow(projectId:string):ProjectWorkflow{return this.store.get<ProjectWorkflow>('workflows',projectId)||defaultWorkflow(projectId);}
  private schema(projectId:string):ProjectIssueSchema{return this.store.get<ProjectIssueSchema>('issue_schemas',projectId)||defaultIssueSchema(projectId);}
  private project(id:unknown):string{const projectId=text(id,'프로젝트 ID');if(!this.store.get('projects',projectId))fail('프로젝트를 찾을 수 없습니다.',404);return projectId;}
  private put(rule:AutomationRule){this.store.db.prepare('INSERT INTO automation_rules(id,project_id,actor_id,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,actor_id=excluded.actor_id,json=excluded.json').run(rule.id,rule.projectId,rule.actorId,JSON.stringify(rule));}
  private parse(input:unknown,requestActor:string,old?:AutomationRule):AutomationRule{
    const source=object(input);if(old&&source.projectId!==undefined&&source.projectId!==old.projectId)fail('규칙의 프로젝트는 변경할 수 없습니다.');
    const projectId=old?.projectId||this.project(source.projectId),actorId=source.actorId===undefined?(old?.actorId||requestActor):text(source.actorId,'실행 팀원 ID');
    const proposed: Record<string, unknown> = {...old,...source,enabled:source.enabled===undefined?(old?.enabled??false):source.enabled};
    if (!isPipelineAutomationTrigger(proposed.trigger)) {
      proposed.pipelineSources = source.pipelineSources;
      proposed.pipelineRefKind = source.pipelineRefKind;
    }
    const editable=config(proposed,projectId,actorId,this.workflow(projectId),this.schema(projectId),this.store.all<User>('users'));
    const settings=this.hooks.getGitlabSettings(),base=normalizeBase(settings.baseUrl);
    if(editable.gitlabProjectIds.some(id=>!settings.projectIds.includes(id)))fail('현재 GitLab 연결에서 허용한 프로젝트만 선택해 주세요.');
    if(editable.enabled&&(!base||!(settings.webhookSecretConfigured||settings.signingTokenConfigured)))fail('자동화를 사용하려면 GitLab 주소·프로젝트와 인증된 Webhook 수신을 먼저 설정해 주세요.',409);
    const timestamp = new Date().toISOString();
    const fields = Object.keys(editable) as (keyof typeof editable)[];
    fields.push('environment', 'pipelineSources', 'pipelineRefKind');
    const changed = !old || old.gitlabBaseUrl !== base || fields.some(key => JSON.stringify(old[key]) !== JSON.stringify(editable[key]));
    return{...editable,id:old?.id||randomUUID(),gitlabBaseUrl:base,enabledAt:editable.enabled?(old?.enabled&&!changed?old.enabledAt:timestamp):null,version:old?old.version+1:1,createdAt:old?.createdAt||timestamp,updatedAt:timestamp};
  }
  create(input:unknown,actorId:string,afterSave?:(rule:AutomationRule)=>void):AutomationRule{return this.store.transaction(()=>{if(this.all().length>=1000)fail('자동화 규칙은 최대 1000개까지 만들 수 있습니다.');const rule=this.parse(input,actorId);this.put(rule);afterSave?.(rule);return rule;});}
  save(id:string,input:unknown,expectedVersion:unknown,actorId:string,afterSave?:(rule:AutomationRule)=>void):AutomationRule{return this.store.transaction(()=>{const old=this.get(id);version(expectedVersion,old.version);const rule=this.parse(input,actorId,old);this.put(rule);afterSave?.(rule);return rule;});}
  remove(id:string,expectedVersion:unknown,afterDelete?:(rule:AutomationRule)=>void):void{this.store.transaction(()=>{const rule=this.get(id);version(expectedVersion,rule.version);this.store.remove('automation_rules',id);afterDelete?.(rule);});}
  /** Caller updates its connection and owns the surrounding transaction. */
  onConnectionChanged(previous:Pick<Connection,'baseUrl'|'projectIds'>&Partial<Connection>,next:Pick<Connection,'baseUrl'|'projectIds'>&Partial<Connection>):number{
    const lostAuthentication=(previous.webhookSecretConfigured||previous.signingTokenConfigured)&&!(next.webhookSecretConfigured||next.signingTokenConfigured);
    const connectionChanged = lostAuthentication || normalizeBase(previous.baseUrl) !== normalizeBase(next.baseUrl)
      || JSON.stringify([...previous.projectIds].sort((a,b)=>a-b)) !== JSON.stringify([...next.projectIds].sort((a,b)=>a-b));
    const oldRoutes = new Map((previous.jiraRoutes ?? []).map(route => [route.repositoryId, route]));
    const newRoutes = new Map((next.jiraRoutes ?? []).map(route => [route.repositoryId, route]));
    const changedRoutes = [...new Set([...oldRoutes.keys(), ...newRoutes.keys()])].filter(id => {
      const before = oldRoutes.get(id), after = newRoutes.get(id);
      return before?.projectId !== after?.projectId || before?.jiraInstanceKey !== after?.jiraInstanceKey;
    });
    if (!connectionChanged && !changedRoutes.length) return 0;
    const rules = this.all().filter(rule => connectionChanged || rule.enabled && rule.gitlabProjectIds.some(id => changedRoutes.includes(id)));
    const timestamp = new Date().toISOString();
    for (const rule of rules) this.put({...rule, enabled: false, enabledAt: null, version: rule.version + 1, updatedAt: timestamp});
    return rules.length;
  }
  private matchReason(rule:AutomationRule,issue:Issue,event:MatchEvent):string|null{
    if(issue.projectId!==rule.projectId)return'규칙과 다른 팀 프로젝트의 업무입니다.';
    if(event.trigger!==rule.trigger)return'규칙과 다른 GitLab 이벤트입니다.';
    if(!rule.gitlabProjectIds.includes(event.gitlabProjectId))return'규칙에서 선택하지 않은 GitLab 프로젝트입니다.';
    if (event.trigger === 'deployment.succeeded') {
      if (!event.environment || event.environment !== rule.environment) return '배포 환경 이름이 일치하지 않습니다.';
    } else if (!event.branch || !branchMatches(rule.branchPattern, event.branch)) {
      return isPipelineAutomationTrigger(event.trigger) ? '참조 이름 패턴이 일치하지 않습니다.' : '브랜치 패턴이 일치하지 않습니다.';
    }
    if (rule.pipelineSources?.length) {
      if (event.pipelineSource === undefined) return '파이프라인 실행 유형을 확인할 수 없습니다.';
      if (!rule.pipelineSources.includes(event.pipelineSource)) return '규칙에서 선택한 파이프라인 실행 유형이 아닙니다.';
    }
    if (rule.pipelineRefKind) {
      if (event.pipelineTag === undefined) return '파이프라인 참조가 브랜치인지 태그인지 확인할 수 없습니다.';
      if (event.pipelineTag !== (rule.pipelineRefKind === 'tag')) return '규칙에서 선택한 파이프라인 참조 유형이 아닙니다.';
    }
    if(rule.issueTypes.length&&!rule.issueTypes.includes(issue.type))return'선택한 업무 유형이 아닙니다.';
    if(!rule.fromStatuses.includes(issue.status))return'현재 상태가 규칙의 출발 상태에 없습니다.';
    return null;
  }
  private outcome(rule:AutomationRule,issue:Issue,outcome:AutomationOutcome['outcome'],reason:string):AutomationOutcome{return{issueId:issue.id,key:issue.key,title:issue.title,fromStatus:issue.status,toStatus:rule.toStatusId,outcome,reason};}
  private prepare(rule:AutomationRule,issue:Issue):PreparedChange{
    if(issue.status===rule.toStatusId)return{outcome:this.outcome(rule,issue,'no_op','이미 도착 상태여서 변경하지 않았습니다.')};
    try{
      let afterStatusChange:AfterStatusChange|undefined;
      const next=this.hooks.prepareChange(structuredClone(issue),rule.toStatusId,effect=>{afterStatusChange=effect;});
      return{next,afterStatusChange,outcome:this.outcome(rule,issue,'changed','규칙 조건과 현재 워크플로 검증을 통과했습니다.')};
    }
    catch(error){const status=(error as {status?:unknown})?.status;if(typeof status==='number'&&status>=400&&status<500)return{outcome:this.outcome(rule,issue,'blocked',error instanceof Error?error.message:'현재 업무 조건에서 상태를 변경할 수 없습니다.')};throw error;}
  }
  private latestAppliedRun(issueId: string): AutomationRun | undefined {
    const row = this.store.db.prepare(`SELECT json FROM automation_runs WHERE issue_id=?
      AND outcome IN ('changed','no_op') AND occurred_at IS NOT NULL ORDER BY occurred_at DESC,rowid DESC LIMIT 1`)
      .get(issueId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as AutomationRun : undefined;
  }
  private manualStatusContext(issue: Issue, deployment: boolean) {
    const settings = this.hooks.getGitlabSettings();
    const base = normalizeBase(settings.baseUrl);
    const routedProjects = new Map((settings.jiraRoutes ?? []).map(route => [route.repositoryId, route.projectId]));
    const repositories = new Set(settings.projectIds.filter(id => !routedProjects.has(id) || routedProjects.get(id) === issue.projectId));
    const rules = base && (settings.webhookSecretConfigured || settings.signingTokenConfigured) ? this.all().filter(rule =>
      rule.enabled && rule.projectId === issue.projectId && rule.gitlabBaseUrl === base &&
      (deployment ? rule.trigger === 'deployment.succeeded' : Object.hasOwn(MANUAL_STATUS_SOURCES, rule.trigger)) &&
      rule.gitlabProjectIds.some(id => repositories.has(id))) : [];
    return { repositories, rules, workflow: this.workflow(issue.projectId), latestRun: this.latestAppliedRun(issue.id) };
  }
  private manualStatusFence(issue: Issue, settingsVersion: number, { workflow, repositories, rules, latestRun }: ReturnType<AutomationService['manualStatusContext']>,
    deploymentProof?: string) {
    const digest = createHash('sha256').update(JSON.stringify([
      this.store.setting('attachmentImportGeneration'), settingsVersion, issue.id, issue.projectId, issue.version, issue.status, issue.type,
      workflow.version, this.schema(issue.projectId).version, [...repositories], rules.map(({ id, version }) => [id, version]), latestRun?.id ?? null,
    ]));
    if (deploymentProof) digest.update('\n').update(deploymentProof);
    for (const row of this.store.db.prepare(`SELECT id,json FROM gitlab_links WHERE issue_id=?
      AND json_extract(json,'$.kind') IN ('merge_request','pipeline') ORDER BY id`).iterate(issue.id)) {
      const cursor = this.hooks.latestVerifiedPipelineId?.(JSON.parse(String(row.json)) as GitlabLink) ?? null;
      digest.update('\n').update(JSON.stringify([row, cursor]));
    }
    return digest.digest('hex');
  }
  private manualDeploymentProof(issue: Issue, { deployment, link, occurredAt }: Extract<GitlabStatusObservation, { trigger: 'deployment.succeeded' }>): ManualDeploymentProof | null {
    if (deployment.status !== 'success' || deployment.repositoryId !== link.projectId || !isGitlabDeploymentEnvironment(deployment.environment)) return null;
    const { instance, repositoryId, deploymentId } = deployment;
    const binding = { instance, repositoryId, deploymentId, linkId: link.id, occurredAt };
    const digest = this.hooks.deploymentStatusProof?.(issue.id, binding);
    return digest ? { binding, digest } : null;
  }
  manualStatusReview(issue: Issue, observations: readonly GitlabStatusObservation[], actorId: string, settingsVersion: number): GitlabStatusReview | undefined {
    if (!observations.length) return;
    const deployment = observations[0].trigger === 'deployment.succeeded';
    const context = this.manualStatusContext(issue, deployment);
    const { repositories, rules, workflow, latestRun } = context;
    if (!rules.length) return;
    const reachable = new Map(allowedNextStatuses({ workflows: [workflow] }, issue).map(status => [status.id, status]));
    const appliedAt = latestRun?.occurredAt ? Date.parse(latestRun.occurredAt) : -Infinity;
    const checkedAt = Date.now();
    let selected: { rule: AutomationRule; evidence: GitlabStatusObservation; deploymentProof?: ManualDeploymentProof } | undefined;
    for (const evidence of observations) {
      const { link, trigger, occurredAt } = evidence;
      const occurred = Date.parse(occurredAt);
      if (deployment !== (trigger === 'deployment.succeeded') || link.issueId !== issue.id || !repositories.has(link.projectId) ||
        !Number.isFinite(occurred) || occurred > checkedAt || occurred <= appliedAt) continue;
      const saved = this.store.get<GitlabLink>('gitlab_links', link.id);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(link)) continue;
      let deploymentProof: ManualDeploymentProof | undefined;
      let sample: MatchEvent;
      if (trigger === 'deployment.succeeded') {
        const proof = this.manualDeploymentProof(issue, evidence);
        if (!proof) continue;
        deploymentProof = proof;
        sample = { trigger, gitlabProjectId: link.projectId, branch: '', environment: evidence.deployment.environment };
      } else {
        const source = MANUAL_STATUS_SOURCES[trigger];
        if (!source || link.kind !== source.kind || link.state !== source.state) continue;
        const { pipelineSource, pipelineTag } = link;
        sample = { trigger, gitlabProjectId: link.projectId, branch: link.sourceBranch ?? '',
          ...(link.kind === 'pipeline' && link.pipelineObservedAt === occurredAt ? { pipelineSource, pipelineTag } : {}) };
      }
      const matches = rules.filter(rule => this.matchReason(rule, issue, sample) === null);
      const [rule] = matches;
      if (!rule || !validTime(rule.enabledAt) || occurred < Date.parse(rule.enabledAt)) continue;
      if (matches.some(match => match.priority === rule.priority && match.toStatusId !== rule.toStatusId &&
        validTime(match.enabledAt) && occurred >= Date.parse(match.enabledAt))) return { kind: 'ambiguous' };
      if (rule.toStatusId === issue.status || !reachable.has(rule.toStatusId)) continue;
      if (selected && selected.rule.toStatusId !== rule.toStatusId) return { kind: 'ambiguous' };
      if (!selected || occurred > Date.parse(selected.evidence.occurredAt) ||
        occurred === Date.parse(selected.evidence.occurredAt) && link.id < selected.evidence.link.id) selected = { rule, evidence, deploymentProof };
    }
    if (!selected) return;
    const { rule, evidence, deploymentProof } = selected;
    const prepared = this.prepare(rule, issue).outcome;
    const expiresAt = checkedAt + MANUAL_STATUS_TOKEN_TTL;
    const token = this.store.seal(JSON.stringify({ domain: MANUAL_STATUS_TOKEN_DOMAIN, actorId, expiresAt, toStatus: rule.toStatusId,
      fence: this.manualStatusFence(issue, settingsVersion, context, deploymentProof?.digest),
      ...(deploymentProof ? { deployment: deploymentProof.binding } : {}) }));
    return { kind: 'suggestion', suggestion: {
      issueId: issue.id, projectId: issue.projectId, issueVersion: issue.version, workflowVersion: workflow.version,
      fromStatus: issue.status, toStatus: rule.toStatusId,
      fromStatusLabel: workflow.statuses.find(status => status.id === issue.status)?.label ?? issue.status,
      toStatusLabel: reachable.get(rule.toStatusId)!.label,
      rule: { id: rule.id, name: rule.name, version: rule.version }, evidence,
      blockReason: prepared.outcome === 'blocked' ? prepared.reason : null, token, expiresAt: new Date(expiresAt).toISOString(),
    } };
  }
  verifyManualStatusSuggestion(issue: Issue, proposedStatus: unknown, proposedType: unknown, token: unknown, actorId: string, settingsVersion: number): void {
    const stale = () => fail('업무, 규칙 또는 GitLab 활동이 변경되었습니다. GitLab에서 상태를 다시 확인해 주세요.', 409,
      { reason: 'gitlab_status_suggestion_stale' });
    if (typeof token !== 'string' || token.length > MAX_MANUAL_STATUS_TOKEN_LENGTH || !MANUAL_STATUS_TOKEN.test(token) ||
      typeof proposedStatus !== 'string' || proposedStatus === issue.status || (proposedType !== undefined && proposedType !== issue.type)) return stale();
    let proof: Record<string, unknown>;
    try { proof = JSON.parse(this.store.unseal(token)); } catch { return stale(); }
    if (proof?.domain !== MANUAL_STATUS_TOKEN_DOMAIN || proof.actorId !== actorId || proof.toStatus !== proposedStatus ||
      typeof proof.expiresAt !== 'number' || !Number.isSafeInteger(proof.expiresAt) || Date.now() >= proof.expiresAt) return stale();
    let deploymentDigest: string | undefined;
    if (proof.deployment !== undefined) {
      if (!isDeploymentStatusBinding(proof.deployment)) return stale();
      const current = this.hooks.deploymentStatusProof?.(issue.id, proof.deployment);
      if (!current) return stale();
      deploymentDigest = current;
    }
    const context = this.manualStatusContext(issue, deploymentDigest !== undefined);
    if (proof.fence !== this.manualStatusFence(issue, settingsVersion, context, deploymentDigest)) return stale();
  }
  processEvent(event:AutomationEvent):AutomationRun[]{
    if(typeof event.id!=='string'||!event.id||event.id.length>300||!AUTOMATION_TRIGGERS.includes(event.trigger)||!Number.isSafeInteger(event.gitlabProjectId)||event.gitlabProjectId<1||typeof event.branch!=='string'||event.branch.length>512||!Array.isArray(event.issueIds)||event.issueIds.length>10000||event.issueIds.some(id=>typeof id!=='string'||id.length>200)||!validTime(event.receivedAt))fail('정규화된 GitLab 이벤트를 확인해 주세요.');
    const deployment = event.trigger === 'deployment.succeeded';
    if (deployment ? !isDeploymentAutomationContext(event) : event.objectKind === 'deployment' || event.environment !== undefined) {
      fail('정규화된 GitLab 배포 이벤트를 확인해 주세요.');
    }
    const pipelineEvidence = parsePipelineEvidence(event, event.objectKind === 'pipeline' && isPipelineAutomationTrigger(event.trigger),
      '정규화된 GitLab 파이프라인 이벤트를 확인해 주세요.');
    const settings=this.hooks.getGitlabSettings(),base=normalizeBase(settings.baseUrl),rules=this.all(),result:AutomationRun[]=[];
    for(const issueId of new Set(event.issueIds)){
      const prior=this.store.db.prepare('SELECT json FROM automation_runs WHERE event_id=? AND issue_id=?').get(event.id,issueId) as {json:string}|undefined;if(prior){result.push(JSON.parse(prior.json) as AutomationRun);continue;}
      const issue=this.store.get<Issue>('issues',issueId);if(!issue)continue;
      const scoped=rules.filter(rule=>rule.enabled&&rule.projectId===issue.projectId&&rule.gitlabBaseUrl===base&&rule.gitlabProjectIds.includes(event.gitlabProjectId)&&settings.projectIds.includes(event.gitlabProjectId)&&rule.trigger===event.trigger);if(!scoped.length)continue;
      const rule=scoped.find(rule=>this.matchReason(rule,issue,event)===null)||scoped[0];let ignored:string|null=null;
      if(!(settings.webhookSecretConfigured||settings.signingTokenConfigured))ignored='인증된 GitLab Webhook 연결이 설정되지 않았습니다.';
      else if(event.disposition!=='fresh')ignored=event.reason||'새 이벤트임을 확정하지 못해 상태 변경을 생략했습니다.';
      else if(!validTime(event.occurredAt))ignored='이벤트 발생 시각을 확인할 수 없습니다.';
      else if(!rule.enabledAt||Date.parse(event.occurredAt)<Date.parse(rule.enabledAt)-(deployment?0:1000))ignored='규칙을 활성화하기 전에 발생한 이벤트입니다.';
      else{
        const applied=this.latestAppliedRun(issueId);
        if(applied){const difference=Date.parse(event.occurredAt)-Date.parse(applied.occurredAt!);if(difference<0)ignored='이 업무에 마지막으로 적용한 이벤트보다 오래된 이벤트입니다.';else if(difference===0&&(applied.toStatus!==rule.toStatusId||issue.status!==rule.toStatusId))ignored='같은 발생 시각의 이벤트가 다른 상태 변경을 요구해 적용하지 않았습니다.';}
      }
      ignored??=this.matchReason(rule,issue,event);
      let prepared:PreparedChange;
      if(ignored)prepared={outcome:this.outcome(rule,issue,'ignored',ignored)};
      else prepared=this.store.withMutationContext({actorId:rule.actorId,origin:'automation',sourceEventId:event.id},()=>this.prepare(rule,issue));
      const next=prepared.next;
      if(next)this.store.withMutationContext({actorId:rule.actorId,origin:'automation',sourceEventId:event.id},()=>{
        this.hooks.commitChange(rule,issue,next,event);
        prepared.afterStatusChange?.(rule,event);
      });
      const statuses = this.workflow(issue.projectId).statuses;
      const run: AutomationRun = {
        ...prepared.outcome, id: randomUUID(), eventId: event.id, ruleId: rule.id, projectId: issue.projectId,
        actorId: rule.actorId, createdAt: new Date().toISOString(),
        occurredAt: validTime(event.occurredAt) ? new Date(event.occurredAt).toISOString() : null,
        context: {
          ruleName: rule.name, trigger: event.trigger, gitlabBaseUrl: base, gitlabProjectId: event.gitlabProjectId,
          objectKind: event.objectKind, objectId: event.objectId, branch: event.branch,
          ...(event.environment === undefined ? {} : { environment: event.environment }),
          ...pipelineEvidence,
          fromStatusLabel: statuses.find(status => status.id === issue.status)?.label ?? issue.status,
          toStatusLabel: statuses.find(status => status.id === rule.toStatusId)?.label ?? rule.toStatusId,
        },
      };
      this.store.db.prepare('INSERT INTO automation_runs(id,event_id,issue_id,project_id,occurred_at,outcome,json) VALUES(?,?,?,?,?,?,?)').run(run.id,event.id,issueId,issue.projectId,run.occurredAt,run.outcome,JSON.stringify(run));result.push(run);
    }
    return result;
  }
  preview(value:unknown,actorId?:string):AutomationPreview{
    const input=object(value),source=object(input.rule),rule=this.parse({...source,enabled:false},actorId||this.store.all<User>('users')[0]?.id||'');
    const issueIds=strings(input.issueIds,'미리 볼 업무',500),sample=object(input.sample);
    if(typeof sample.trigger!=='string'||!AUTOMATION_TRIGGERS.includes(sample.trigger as AutomationRule['trigger'])||!Number.isSafeInteger(sample.gitlabProjectId))fail('미리 볼 GitLab 이벤트를 확인해 주세요.');
    const gitlabProjectId = Number(sample.gitlabProjectId);
    let event: MatchEvent;
    const pipelineEvidence = parsePipelineEvidence(sample, isPipelineAutomationTrigger(sample.trigger), '미리 볼 GitLab 파이프라인의 실행 유형과 참조 유형을 확인해 주세요.');
    if (sample.trigger === 'deployment.succeeded') {
      if (!isGitlabDeploymentEnvironment(sample.environment)) fail('미리 볼 GitLab 배포 환경 이름을 확인해 주세요.');
      event = { trigger: sample.trigger, gitlabProjectId, branch: '', environment: sample.environment };
    } else {
      if (typeof sample.branch !== 'string' || !sample.branch || sample.branch.length > 512) fail('미리 볼 GitLab 이벤트를 확인해 주세요.');
      event = { trigger: sample.trigger as AutomationRule['trigger'], gitlabProjectId, branch: sample.branch, ...pipelineEvidence };
    }
    const outcomes=issueIds.map(id=>{const issue=this.store.get<Issue>('issues',id);if(!issue)fail('미리 볼 업무를 찾을 수 없습니다.',404);const reason=this.matchReason(rule,issue,event);return reason?this.outcome(rule,issue,'ignored',reason):this.prepare(rule,issue).outcome;});
    return{outcomes,warnings:['미리보기는 업무·실행 기록을 변경하지 않으며 실제 GitLab 이벤트를 요청하지 않습니다.','실제 실행에서는 활성화 시각·이벤트 순서·연결 정보를 추가로 검증합니다.']};
  }
  validateImport(value:unknown,projects:Project[],users:User[],workflows:ProjectWorkflow[],schemas:ProjectIssueSchema[],options:{legacy?:boolean}={}):AutomationRule[]{
    if(!Array.isArray(value)||value.length>1000)fail('자동화 규칙 목록을 확인해 주세요.');if(options.legacy)return[];const ids=new Set<string>();
    return value.map(raw=>{const source=object(raw),id=text(source.id,'자동화 ID'),projectId=text(source.projectId,'자동화 프로젝트 ID'),actorId=text(source.actorId,'자동화 실행 팀원 ID');if(ids.has(id)||!projects.some(project=>project.id===projectId))fail('자동화 ID 또는 프로젝트 참조를 확인해 주세요.');ids.add(id);
      if (source.trigger !== 'deployment.succeeded' && Object.hasOwn(source, 'environment')) fail('자동화 규칙의 배포 환경을 확인해 주세요.');
      const hasSources = Object.hasOwn(source, 'pipelineSources');
      const hasRefKind = Object.hasOwn(source, 'pipelineRefKind');
      if ((hasSources || hasRefKind) && (!isPipelineAutomationTrigger(source.trigger) ||
          (hasSources && (!Array.isArray(source.pipelineSources) || !source.pipelineSources.length)) ||
          (hasRefKind && source.pipelineRefKind !== 'branch' && source.pipelineRefKind !== 'tag'))) {
        fail('자동화 규칙의 파이프라인 실행 유형 및 참조 유형을 확인해 주세요.');
      }
      const editable=config(source,projectId,actorId,workflows.find(workflow=>workflow.projectId===projectId)||defaultWorkflow(projectId),schemas.find(schema=>schema.projectId===projectId)||defaultIssueSchema(projectId),users);
      if(!Number.isSafeInteger(source.version)||Number(source.version)<1||!validTime(source.createdAt)||!validTime(source.updatedAt)||(source.enabledAt!==null&&!validTime(source.enabledAt))||typeof source.gitlabBaseUrl!=='string')fail('자동화 규칙의 버전·시간·연결 정보를 확인해 주세요.');
      return{...editable,id,enabled:false,enabledAt:null,gitlabBaseUrl:normalizeBase(source.gitlabBaseUrl),version:Number(source.version),createdAt:source.createdAt,updatedAt:source.updatedAt};
    });
  }
  replaceImported(rules:AutomationRule[],previousVersions=new Map(this.all().map(rule=>[rule.id,rule.version]))):void{this.store.db.exec('DELETE FROM automation_runs;DELETE FROM automation_rules;');for(const rule of rules){const previous=previousVersions.get(rule.id);this.put({...rule,enabled:false,enabledAt:null,version:previous===undefined?rule.version:Math.max(previous,rule.version)+1});}}
  registerRoutes(app:Express,hooks:RouteHooks):void{
    app.get('/api/automation-rules',(req,res)=>{const projectId=req.query.projectId===undefined?undefined:this.project(req.query.projectId);res.json(this.all().filter(rule=>!projectId||rule.projectId===projectId));});
    app.post('/api/automation-rules',(req,res)=>{const actorId=hooks.actor(req);res.status(201).json(this.create(req.body,actorId,rule=>hooks.activity(req,'project',rule.projectId,'자동화 규칙 생성',rule.name)));});
    app.patch('/api/automation-rules/:id',(req,res)=>{const actorId=hooks.actor(req);res.json(this.save(String(req.params.id),req.body,req.body.expectedVersion,actorId,rule=>hooks.activity(req,'project',rule.projectId,'자동화 규칙 변경',rule.name)));});
    app.delete('/api/automation-rules/:id',(req,res)=>{hooks.actor(req);const expected=req.body?.expectedVersion??(req.query.expectedVersion===undefined?undefined:Number(req.query.expectedVersion));this.remove(String(req.params.id),expected,rule=>hooks.activity(req,'project',rule.projectId,'자동화 규칙 삭제',rule.name));res.json({ok:true});});
    app.get('/api/automation-runs',(req,res)=>res.json(this.runs(req.query.projectId===undefined?undefined:this.project(req.query.projectId),req.query.limit===undefined?100:Number(req.query.limit))));
    app.get('/api/issues/:id/automation-runs', (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).some(key => key !== 'before')) fail('자동화 실행 기록의 위치를 확인해 주세요.');
      res.json(this.issueRuns(req.params.id, req.query.before));
    });
    app.post('/api/automation/preview',(req,res)=>res.json(this.preview(req.body,hooks.actor(req))));
  }
}
