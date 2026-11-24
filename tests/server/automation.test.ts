import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store,type StoreChange } from '../../server/store.js';
import { AutomationService,AutomationError } from '../../server/automation.js';
import { WorkflowService } from '../../server/workflows.js';
import { IssueSchemaService } from '../../server/issue-schema.js';
import { branchMatches,sortedAutomationRules } from '../../shared/automation.js';
import type { AutomationEvent,AutomationRule,AutomationRun,Issue,Project,ProjectIssueSchema,User } from '../../shared/types.js';
import type { GitlabSettings, GitlabStatusObservation } from '../../shared/types.js';

const timestamp=new Date().toISOString();
const project:Project={id:'project-auto',name:'자동화 검증',key:'AUTO',color:'#668899',description:'',createdAt:timestamp};
const users:User[]=[{id:'user-auto',name:'자동화 실행자',email:'auto@example.test',color:'#668899'},{id:'user-other',name:'다른 실행자',email:'other@example.test',color:'#886699'}];
function issue(id='issue-a',overrides:Partial<Issue>={}):Issue{return{id,key:`AUTO-${id==='issue-a'?1:2}`,projectId:project.id,title:id,description:'',type:'작업',status:'todo',priority:'medium',assigneeId:null,collaboratorIds:[],parentId:null,labels:[],startDate:null,endDate:null,dueDate:null,estimate:null,cycle:null,module:null,release:null,customFields:{},version:1,createdAt:timestamp,updatedAt:timestamp,completedAt:null,...overrides};}
function event(overrides:Partial<AutomationEvent>={}):AutomationEvent{return{id:randomUUID(),trigger:'merge_request.merged',gitlabProjectId:77,objectKind:'merge_request',objectId:'123',branch:'main',issueIds:['issue-a'],occurredAt:new Date(Date.now()+5000).toISOString(),receivedAt:new Date().toISOString(),disposition:'fresh',reason:'',...overrides};}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'teamspace-automation-')),store=new Store(dir);store.put('projects',project);users.forEach(user=>store.put('users',user));store.put('issues',issue());store.put('issues',issue('issue-b'));
  const schemas=new IssueSchemaService(store),workflows=new WorkflowService(store,schemas);let connection:Pick<GitlabSettings,'baseUrl'|'projectIds'|'webhookSecretConfigured'|'signingTokenConfigured'|'jiraRoutes'>={baseUrl:'https://git.example.test',projectIds:[77,88],webhookSecretConfigured:true,signingTokenConfigured:false};let failOnCommit=0,commitCount=0;
  const service=new AutomationService(store,{getGitlabSettings:()=>connection,prepareChange:(before,status)=>{const next={...before,status,version:before.version+1,updatedAt:new Date().toISOString(),completedAt:status==='done'?new Date().toISOString():null};schemas.validateIssue(next,before);workflows.validateIssue(next,before);return next;},commitChange:(rule,before,next,source)=>{store.put('issues',next);store.put('activities',{id:randomUUID(),resourceType:'issue',resourceId:before.id,actorId:rule.actorId,action:'상태 자동 변경',detail:source.id,createdAt:new Date().toISOString()});if(++commitCount===failOnCommit)throw new Error('audit failed');}});
  const create=(overrides:Record<string,unknown>={})=>service.create({projectId:project.id,name:'병합 완료',enabled:true,trigger:'merge_request.merged',gitlabProjectIds:[77],branchPattern:'main',issueTypes:[],fromStatuses:['todo','in_progress','done'],toStatusId:'done',actorId:users[0].id,priority:100,...overrides},users[0].id);
  return{dir,store,schemas,workflows,service,create,process:(source:AutomationEvent)=>store.transaction(()=>service.processEvent(source)),connection:()=>connection,setConnection:(next:typeof connection)=>{connection=next;},failCommit:(after=1)=>{failOnCommit=after;},close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
function rejects(action:()=>unknown,status=400){assert.throws(action,(error:unknown)=>error instanceof AutomationError&&error.status===status);}

function pipelineObservation(store: Store, overrides: Partial<GitlabStatusObservation['link']> = {}): GitlabStatusObservation {
  const occurredAt = new Date().toISOString();
  const link: GitlabStatusObservation['link'] = { id: 'pipeline-12', issueId: 'issue-a', projectId: 77, iid: 12,
    kind: 'pipeline', title: 'Synthetic CI', webUrl: 'https://git.example.test/demo/repo/-/pipelines/12',
    state: 'success', updatedAt: occurredAt, pipelineObservedAt: occurredAt, sourceBranch: 'main', ...overrides };
  store.put('gitlab_links', link);
  return { link, trigger: link.state === 'failed' ? 'pipeline.failed' : 'pipeline.succeeded', occurredAt };
}

test('GitLab status suggestions use the first rule and prepare ordinary workflow checks without creating a run', () => {
  const f = fixture();
  try {
    const workflow = f.workflows.get(project.id);
    const saved = f.workflows.save(project.id, { ...workflow,
      fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
    }, workflow.version);
    const rule = f.create({ trigger: 'pipeline.succeeded', priority: 1 });
    f.create({ trigger: 'pipeline.succeeded', priority: 2, toStatusId: 'in_progress' });
    const evidence = pipelineObservation(f.store);
    const before = f.store.get<Issue>('issues', 'issue-a')!;
    const review = f.service.manualStatusReview(before, [evidence], users[0].id, 4);
    assert.equal(review?.kind, 'suggestion');
    if (review?.kind !== 'suggestion') throw new Error('Expected a status suggestion.');
    const { suggestion } = review;
    assert.deepEqual(suggestion.rule, { id: rule.id, name: rule.name, version: rule.version });
    assert.deepEqual(suggestion.evidence, evidence);
    assert.equal(suggestion.issueVersion, before.version);
    assert.equal(suggestion.workflowVersion, saved.version);
    assert.equal(suggestion.toStatus, 'done');
    assert.match(suggestion.blockReason ?? '', /설명/u);
    assert.doesNotThrow(() => f.service.verifyManualStatusSuggestion(before, 'done', undefined, suggestion.token, users[0].id, 4));
    assert.deepEqual(f.store.get('issues', before.id), before);
    assert.deepEqual(f.service.runs(), []);
    assert.deepEqual(f.store.all('activities'), []);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_inbox').get()?.n, 0);

    f.workflows.save(project.id, { ...saved, transitions: saved.transitions.filter(edge => edge.to !== 'done') }, saved.version);
    assert.equal(f.service.manualStatusReview(before, [evidence], users[0].id, 4), undefined);
  } finally { f.close(); }
});

test('GitLab status suggestions reject expired or changed actor, issue, workflow, rule, link, connection and workspace evidence', () => {
  const f = fixture();
  try {
    const rule = f.create({ trigger: 'pipeline.succeeded', priority: 1 });
    const before = f.store.get<Issue>('issues', 'issue-a')!;
    const evidence = pipelineObservation(f.store);
    function tokenFor(candidate: GitlabStatusObservation = evidence) {
      const review = f.service.manualStatusReview(before, [candidate], users[0].id, 4);
      if (review?.kind !== 'suggestion') throw new Error('Expected a status suggestion.');
      return review.suggestion.token;
    }
    const token = tokenFor();
    assert.doesNotThrow(() => verify(token));
    function verify(proof: unknown, issueValue = before, actorId = users[0].id, settingsVersion = 4,
      status = 'done', issueType = before.type) {
      f.service.verifyManualStatusSuggestion(issueValue, status, issueType, proof, actorId, settingsVersion);
    }
    function stale(action: () => unknown) {
      assert.throws(action, (cause: unknown) => cause instanceof AutomationError && cause.status === 409 &&
        (cause.details as { reason?: string })?.reason === 'gitlab_status_suggestion_stale');
    }
    stale(() => verify(`${token}!invalid`));
    stale(() => verify(token, { ...before, version: before.version + 1 }));
    stale(() => verify(token, before, users[1].id));
    stale(() => verify(token, before, users[0].id, 5));
    stale(() => verify(token, before, users[0].id, 4, 'in_progress'));
    stale(() => verify(token, before, users[0].id, 4, 'done', 'different-type'));
    const expired = { ...JSON.parse(f.store.unseal(token)), expiresAt: Date.now() - 1 };
    stale(() => verify(f.store.seal(JSON.stringify(expired))));
    f.store.put('gitlab_links', { ...evidence.link, state: 'running' });
    stale(() => verify(token));
    f.store.put('gitlab_links', evidence.link);
    f.store.setSetting('attachmentImportGeneration', 'new-generation');
    stale(() => verify(token));
    const afterRestore = tokenFor();
    const schema = f.schemas.get(project.id);
    f.schemas.save(project.id, schema, schema.version);
    stale(() => verify(afterRestore));
    const afterSchemaEdit = tokenFor();
    const workflow = f.workflows.get(project.id);
    f.workflows.save(project.id, workflow, workflow.version);
    stale(() => verify(afterSchemaEdit));
    const afterWorkflowEdit = tokenFor();
    f.service.save(rule.id, { name: '수정된 규칙' }, rule.version, users[0].id);
    stale(() => verify(afterWorkflowEdit));
    assert.deepEqual(f.service.runs(), []);
  } finally { f.close(); }
});

test('GitLab status review filters stale or out-of-scope evidence and withholds competing targets', () => {
  const f = fixture();
  try {
    const rule = f.create({ trigger: 'pipeline.succeeded', priority: 2 });
    const before = f.store.get<Issue>('issues', 'issue-a')!;
    const evidence = pipelineObservation(f.store);
    const review = (...sources: GitlabStatusObservation[]) => f.service.manualStatusReview(before, sources, users[0].id, 1);
    assert.equal(review({ ...evidence, occurredAt: new Date(Date.parse(rule.enabledAt!) - 1_000).toISOString() }), undefined);
    assert.equal(review({ ...evidence, link: { ...evidence.link, state: 'running' } }), undefined);
    assert.equal(review({ ...evidence, occurredAt: new Date(Date.now() + 1_000).toISOString() }), undefined);
    assert.equal(review(pipelineObservation(f.store, { id: 'other-repo', projectId: 88 })), undefined);
    assert.equal(review(pipelineObservation(f.store, { id: 'other-branch', sourceBranch: 'feature/no-match' })), undefined);
    f.setConnection({ ...f.connection(), jiraRoutes: [{ repositoryId: 77, projectId: 'different-project', jiraInstanceKey: 'jira-instance' }] });
    assert.equal(review(evidence), undefined);
    f.setConnection({ ...f.connection(), jiraRoutes: [] });
    assert.equal(review(evidence)?.kind, 'suggestion');
    const otherTrigger = f.create({ trigger: 'pipeline.failed', priority: 2, toStatusId: 'in_progress' });
    const failed = pipelineObservation(f.store, { id: 'pipeline-failed', state: 'failed' });
    assert.deepEqual(review(evidence, failed), { kind: 'ambiguous' });
    f.service.remove(otherTrigger.id, otherTrigger.version);
    const sameDestination = f.create({ trigger: 'pipeline.succeeded', priority: 2 });
    assert.equal(review(pipelineObservation(f.store))?.kind, 'suggestion');
    f.service.remove(sameDestination.id, sameDestination.version);
    f.create({ trigger: 'pipeline.succeeded', priority: 2, toStatusId: 'in_progress' });
    assert.deepEqual(review(pipelineObservation(f.store)), { kind: 'ambiguous' });
    const observed = pipelineObservation(f.store);
    const [applied] = f.process(event({ trigger: 'pipeline.succeeded', objectKind: 'pipeline', occurredAt: observed.occurredAt }));
    assert.equal(applied.outcome, 'changed');
    f.store.put('issues', { ...before, version: before.version + 2 });
    assert.equal(f.service.manualStatusReview(f.store.get<Issue>('issues', before.id)!, [observed], users[0].id, 1), undefined);
  } finally { f.close(); }
});

test('branch globs are literal apart from bounded * and ? with deterministic priority/id ordering',()=>{
  assert.ok(branchMatches('feature/*','feature/nested/branch'));assert.ok(branchMatches('release/?','release/1'));assert.ok(!branchMatches('release/?','release/12'));assert.ok(branchMatches('기능/🚀?','기능/🚀가'));assert.ok(!branchMatches('main|dev','main'));assert.ok(branchMatches('branch[1]','branch[1]'));assert.ok(!branchMatches('*a'.repeat(64),'b'.repeat(512)));assert.ok(!branchMatches('*'.repeat(129),'main'));assert.ok(!branchMatches('*','x'.repeat(513)));assert.ok(!branchMatches('*','line\nbreak'));
  const rows=[{id:'z',priority:2},{id:'b',priority:1},{id:'a',priority:1}] as AutomationRule[];assert.deepEqual(sortedAutomationRules(rows).map(rule=>rule.id),['a','b','z']);assert.equal(rows[0].id,'z');
});

test('rules enforce CAS, explicit safe filters, connection readiness and activation resets',()=>{
  const f=fixture();try{
    for(const change of [{fromStatuses:[]},{gitlabProjectIds:[]},{gitlabProjectIds:[99]},{fromStatuses:['unknown']},{toStatusId:'unknown'},{issueTypes:['unknown']},{branchPattern:'a'.repeat(129)},{priority:null},{priority:-1},{enabled:null},{trigger:'push'},{actorId:'missing'}])rejects(()=>f.create(change));
    f.setConnection({...f.connection(),webhookSecretConfigured:false});rejects(()=>f.create(),409);const disabled=f.create({enabled:false});assert.equal(disabled.enabledAt,null);
    f.setConnection({...f.connection(),signingTokenConfigured:true});const enabled=f.service.save(disabled.id,{enabled:true},disabled.version,users[0].id);assert.equal(enabled.version,2);assert.ok(enabled.enabledAt);rejects(()=>f.service.save(enabled.id,{name:'다른 이름'},1,users[0].id),409);
    const renamed=f.service.save(enabled.id,{name:'새 규칙'},enabled.version,users[0].id);assert.ok(Date.parse(renamed.enabledAt!)>=Date.parse(enabled.enabledAt!));const unchanged=f.service.save(renamed.id,{},renamed.version,users[0].id);assert.equal(unchanged.enabledAt,renamed.enabledAt);rejects(()=>f.service.save(unchanged.id,{projectId:'elsewhere'},unchanged.version,users[0].id));rejects(()=>f.service.remove(unchanged.id,1),409);f.service.remove(unchanged.id,unchanged.version);assert.equal(f.service.all().length,0);
  }finally{f.close();}
});

test('first matching priority rule changes once, uses captured actor context and duplicate/no-op processing is idempotent',()=>{
  const f=fixture();try{
    f.create({priority:1,branchPattern:'release/*',toStatusId:'review'});const winner=f.create({priority:2,toStatusId:'in_progress',actorId:users[1].id});f.create({priority:3,toStatusId:'done'});
    const contexts:StoreChange[]=[];const stop=f.store.onChange(change=>{if(change.table==='issues')contexts.push(change);});const source=event();let runs=f.process(source);assert.equal(runs.length,1);assert.equal(runs[0].ruleId,winner.id);assert.equal(runs[0].outcome,'changed');assert.equal(f.store.get<Issue>('issues','issue-a')!.status,'in_progress');assert.equal(f.store.get<Issue>('issues','issue-a')!.version,2);assert.equal(contexts.length,1);assert.deepEqual(contexts[0].context,{actorId:users[1].id,origin:'automation',sourceEventId:source.id});
    assert.deepEqual(f.process(source),runs);assert.equal(f.service.runs().length,1);assert.equal(f.store.all('activities').length,1);
    runs=f.process(event({occurredAt:new Date(Date.parse(source.occurredAt!)+1000).toISOString()}));assert.equal(runs[0].outcome,'no_op');assert.equal(f.store.get<Issue>('issues','issue-a')!.version,2);assert.equal(contexts.length,1);stop();
  }finally{f.close();}
});

test('workflow/custom requirements block the chosen rule without fallback, while preview writes nothing',()=>{
  const f=fixture();try{
    const schema=f.schemas.get(project.id);f.schemas.save(project.id,{...schema,fields:[{id:'approval',name:'승인 기록',description:'',kind:'text',required:false,issueTypes:[],options:[],archived:false}]},schema.version);
    const workflow=f.workflows.get(project.id);f.workflows.save(project.id,{...workflow,fieldRules:[{issueType:'*',statusId:'done',requiredFields:['custom:approval']}]},workflow.version);
    const rule=f.create({priority:1}),fallback=f.create({priority:2,toStatusId:'in_progress'}),before=f.store.get<Issue>('issues','issue-a')!;
    const preview=f.service.preview({rule,issueIds:['issue-a'],sample:{trigger:'merge_request.merged',gitlabProjectId:77,branch:'main'}},users[0].id);assert.equal(preview.outcomes[0].outcome,'blocked');assert.equal(f.service.runs().length,0);assert.deepEqual(f.store.get('issues','issue-a'),before);assert.equal(f.store.all('activities').length,0);
    const runs=f.process(event());assert.equal(runs[0].outcome,'blocked');assert.equal(runs[0].ruleId,rule.id);assert.notEqual(runs[0].ruleId,fallback.id);assert.ok(runs[0].reason.includes('승인 기록'));assert.deepEqual(f.store.get('issues','issue-a'),before);
    f.store.put('issues',{...before,customFields:{approval:'검토 완료'}});assert.equal(f.process(event())[0].outcome,'changed');assert.equal(f.store.get<Issue>('issues','issue-a')!.status,'done');
  }finally{f.close();}
});

test('ticket history keeps execution context, paginates within one ticket and reads context-free runs', () => {
  const f = fixture();
  try {
    const rule = f.create({ name: '이전 규칙 이름' });
    const workflow = f.workflows.get(project.id);
    const savedWorkflow = f.workflows.save(project.id, {
      ...workflow,
      statuses: workflow.statuses.map(status => status.id === 'done' ? { ...status, label: '이전 종료 이름' } : status),
      fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
    }, workflow.version);
    const source = event();
    const [blocked] = f.process(source);
    assert.equal(blocked.outcome, 'blocked');
    assert.deepEqual(blocked.context, {
      ruleName: rule.name,
      trigger: source.trigger,
      gitlabBaseUrl: rule.gitlabBaseUrl,
      gitlabProjectId: source.gitlabProjectId,
      objectKind: source.objectKind,
      objectId: source.objectId,
      branch: source.branch,
      fromStatusLabel: workflow.statuses.find(status => status.id === 'todo')?.label,
      toStatusLabel: '이전 종료 이름',
    });
    f.service.save(rule.id, { name: '현재 규칙 이름' }, rule.version, users[0].id);
    f.workflows.save(project.id, {
      ...savedWorkflow,
      statuses: savedWorkflow.statuses.map(status => status.id === 'done' ? { ...status, label: '현재 종료 이름' } : status),
    }, savedWorkflow.version);

    const [anotherIssue] = f.process(event({ issueIds: ['issue-b'], disposition: 'unverified', objectId: '' }));
    assert.equal(anotherIssue.context?.objectId, '');
    for (let count = 0; count < 20; count++) f.process(event({ disposition: 'stale' }));
    const page = f.service.issueRuns('issue-a');
    assert.equal(page.items.length, 20);
    assert.ok(page.items.every(run => run.issueId === 'issue-a' && run.outcome === 'ignored'));
    assert.equal(page.latestBlockedRunId, blocked.id);
    assert.equal(page.nextCursor, page.items.at(-1)?.id);
    const last = f.service.issueRuns('issue-a', page.nextCursor);
    assert.deepEqual(last, { issueVersion: 1, items: [blocked], nextCursor: null, latestBlockedRunId: blocked.id });
    assert.equal(last.items[0].context?.ruleName, '이전 규칙 이름');
    assert.equal(last.items[0].context?.toStatusLabel, '이전 종료 이름');
    rejects(() => f.service.issueRuns('issue-a', anotherIssue.id));
    rejects(() => f.service.issueRuns('issue-a', [page.nextCursor, page.nextCursor]));
    rejects(() => f.service.issueRuns('issue-a', 'missing-run'));
    rejects(() => f.service.issueRuns('issue-missing'), 404);

    const legacy: AutomationRun = { ...blocked };
    delete legacy.context;
    f.store.db.prepare('UPDATE automation_runs SET json=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
    assert.deepEqual(f.service.issueRuns('issue-a', page.nextCursor).items, [legacy]);
  } finally { f.close(); }
});

test('only the newest relevant blocked run is eligible when the current workflow still allows it', () => {
  const f = fixture();
  try {
    f.create();
    const workflow = f.workflows.get(project.id);
    const requirements = f.workflows.save(project.id, {
      ...workflow, fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
    }, workflow.version);
    const nextTime = Date.now() + 5_000;
    const [newer] = f.process(event({ occurredAt: new Date(nextTime).toISOString() }));
    const [older] = f.process(event({ occurredAt: new Date(nextTime - 1_000).toISOString() }));
    assert.equal(older.outcome, 'blocked');
    assert.equal(f.service.issueRuns('issue-a').latestBlockedRunId, newer.id);
    const [tied] = f.process(event({ occurredAt: newer.occurredAt }));
    assert.equal(f.service.issueRuns('issue-a').latestBlockedRunId, tied.id);

    const current = f.store.get<Issue>('issues', 'issue-a')!;
    f.store.put('issues', { ...current, status: 'in_progress', version: current.version + 1 });
    const moved = f.service.issueRuns('issue-a');
    assert.equal(moved.latestBlockedRunId, null);
    assert.equal(moved.issueVersion, current.version + 1);
    f.store.put('issues', current);
    const restricted = f.workflows.save(project.id, {
      ...requirements, transitions: requirements.transitions.filter(edge => edge.from !== 'todo' || edge.to !== 'done'),
    }, requirements.version);
    assert.equal(f.service.issueRuns('issue-a').latestBlockedRunId, null);
    f.workflows.save(project.id, { ...restricted, transitions: requirements.transitions }, restricted.version);
    f.store.put('issues', { ...current, description: '필수 속성 작성 완료' });
    assert.equal(f.process(event({ occurredAt: new Date(nextTime + 1_000).toISOString() }))[0].outcome, 'changed');
    // Historical blocked events remain in the log even after a newer outcome and a manual status change.
    f.store.put('issues', current);
    const history = f.service.issueRuns('issue-a');
    assert.equal(history.latestBlockedRunId, null);
    assert.ok(history.items.some(run => run.id === tied.id));
  } finally { f.close(); }
});

test('freshness, activation tolerance, cross-object ordering and equal-time conflicts protect newer intent',()=>{
  const f=fixture();try{
    const rule=f.create();for(const disposition of ['stale','ambiguous','unverified'] as const){const run=f.process(event({disposition,reason:`${disposition} event` }))[0];assert.equal(run.outcome,'ignored');assert.equal(run.reason,`${disposition} event`);}
    assert.equal(f.process(event({occurredAt:null}))[0].outcome,'ignored');assert.equal(f.process(event({occurredAt:new Date(Date.parse(rule.enabledAt!)-1001).toISOString()}))[0].outcome,'ignored');assert.equal(f.process(event({occurredAt:new Date(Date.parse(rule.enabledAt!)-900).toISOString()}))[0].outcome,'changed');
    const newest=event({occurredAt:new Date(Date.now()+10000).toISOString()});assert.equal(f.process(newest)[0].outcome,'no_op');const version=f.store.get<Issue>('issues','issue-a')!.version;
    const changed=f.service.save(rule.id,{toStatusId:'review'},rule.version,users[0].id);assert.equal(f.process(event({occurredAt:new Date(Date.parse(newest.occurredAt!)-1).toISOString(),objectId:'different-mr'}))[0].outcome,'ignored');const tie=f.process(event({occurredAt:newest.occurredAt,objectId:'equal-time-mr'}))[0];assert.equal(tie.outcome,'ignored');assert.ok(tie.reason.includes('같은 발생 시각'));assert.equal(f.store.get<Issue>('issues','issue-a')!.version,version);
    assert.equal(f.process(event({occurredAt:new Date(Date.parse(newest.occurredAt!)+1).toISOString()}))[0].ruleId,changed.id);assert.equal(f.store.get<Issue>('issues','issue-a')!.status,'review');
  }finally{f.close();}
});

test('repository binding and connection changes disable old rules and invalidate pre-change editors',()=>{
  const f=fixture();try{
    const rule=f.create();assert.equal(f.process(event({gitlabProjectId:88})).length,0);assert.equal(f.process(event({branch:'feature/unselected'}))[0].outcome,'ignored');
    const previous=f.connection(),next={...previous,baseUrl:'https://new-git.example.test'};f.setConnection(next);assert.equal(f.process(event()).length,0);f.store.transaction(()=>assert.equal(f.service.onConnectionChanged(previous,next),1));const disabled=f.service.all()[0];assert.equal(disabled.enabled,false);assert.equal(disabled.enabledAt,null);assert.equal(disabled.gitlabBaseUrl,rule.gitlabBaseUrl);rejects(()=>f.service.save(rule.id,{enabled:true},rule.version,users[0].id),409);const rebound=f.service.save(rule.id,{enabled:true},disabled.version,users[0].id);assert.equal(rebound.gitlabBaseUrl,next.baseUrl);assert.equal(f.process(event())[0].outcome,'changed');
    const currentVersion=rebound.version;f.store.transaction(()=>assert.equal(f.service.onConnectionChanged(next,{...next,projectIds:[88,77]}),0));assert.equal(f.service.all()[0].version,currentVersion);const unauthenticated={...next,webhookSecretConfigured:false,signingTokenConfigured:false};f.setConnection(unauthenticated);f.store.transaction(()=>assert.equal(f.service.onConnectionChanged(next,unauthenticated),1));assert.equal(f.service.all()[0].enabled,false);assert.equal(f.service.all()[0].version,currentVersion+1);
  }finally{f.close();}
});

test('unexpected commit/audit failures roll back every ticket, receipt and audit row in the enclosing transaction',()=>{
  const f=fixture();try{
    f.create();const before=f.store.all<Issue>('issues');f.failCommit(2);assert.throws(()=>f.process(event({issueIds:['issue-a','issue-b']})),/audit failed/);assert.deepEqual(f.store.all('issues'),before);assert.equal(f.service.runs().length,0);assert.equal(f.store.all('activities').length,0);
    const original=f.service.all()[0];assert.throws(()=>f.service.save(original.id,{name:'되돌릴 규칙'},original.version,users[0].id,()=>{throw new Error('audit failed');}),/audit failed/);assert.deepEqual(f.service.all()[0],original);
  }finally{f.close();}
});

test('native import validates incoming references purely, restores rules disabled and bumps old CAS versions',()=>{
  const f=fixture();try{
    const rule=f.create(),definitions=f.schemas.snapshot(),workflows=f.workflows.snapshot(),before=structuredClone(rule);const imported=f.service.validateImport([rule],[project],users,workflows,definitions);assert.deepEqual(rule,before);assert.equal(imported[0].enabled,false);assert.equal(imported[0].enabledAt,null);
    for(const invalid of [{...rule,actorId:'missing'},{...rule,fromStatuses:['missing']},{...rule,issueTypes:['missing']},{...rule,gitlabBaseUrl:'https://user:secret@git.example.test'},{...rule,version:0}])rejects(()=>f.service.validateImport([invalid],[project],users,workflows,definitions));rejects(()=>f.service.validateImport([rule,rule],[project],users,workflows,definitions));
    assert.deepEqual(f.service.validateImport([],[project],users,workflows,definitions,{legacy:true}),[]);const custom:ProjectIssueSchema={...definitions[0],issueTypes:[...definitions[0].issueTypes,{id:'incident',name:'장애',color:'#668899',archived:true}]};assert.equal(f.service.validateImport([{...rule,issueTypes:['incident']}],[project],users,workflows,[custom])[0].issueTypes[0],'incident');
    f.process(event());f.store.transaction(()=>f.service.replaceImported(imported,new Map([[rule.id,rule.version+4]])));assert.equal(f.service.all()[0].version,rule.version+5);assert.equal(f.service.all()[0].enabled,false);assert.equal(f.service.runs().length,0);assert.equal(f.process(event()).length,0);
  }finally{f.close();}
});
