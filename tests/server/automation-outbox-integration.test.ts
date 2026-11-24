import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { Store } from '../../server/store.js';
import type { AutomationPreview, AutomationRule, AutomationRun, GitlabIssueRefreshResult, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, IssueAutomationRunPage, ProjectWorkflow, TeamNotificationPage, WebhookDelivery, WebhookEndpointCreated, WebhookEnvelope } from '../../shared/types.js';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'teamspace-automation-outbox-')),service=createApp({dataDir:dir,outboundWorker:false});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const observer=new Store(dir);
  async function call<T=any>(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){const response=await fetch(`${base}/api${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as T};}
  return{call,observer,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));service.close();observer.db.close();rmSync(dir,{recursive:true,force:true});}};
}
async function configure(f:Awaited<ReturnType<typeof fixture>>){const response=await f.call('/integrations/gitlab','PATCH',{expectedVersion:1,baseUrl:'http://gitlab.synthetic.test',projectIds:[42],webhookSecret:'integration-secret'});assert.equal(response.status,200);}
async function rule(f:Awaited<ReturnType<typeof fixture>>,overrides:Record<string,unknown>={}){const response=await f.call<AutomationRule>('/automation-rules','POST',{projectId:'project-neo',name:'병합 후 완료',trigger:'merge_request.merged',enabled:true,gitlabProjectIds:[42],branchPattern:'feature/*',issueTypes:[],fromStatuses:['in_progress','review','done'],toStatusId:'done',actorId:'user-seo',priority:100,...overrides});assert.equal(response.status,201,JSON.stringify(response.data));return response.data;}
async function endpoint(f:Awaited<ReturnType<typeof fixture>>){const response=await f.call<WebhookEndpointCreated>('/webhook-endpoints','POST',{name:'합성 수신처',url:'http://127.0.0.1:9/receiver',eventTypes:['issue.updated','document.created','document.updated','comment.created'],projectIds:['project-neo']});assert.equal(response.status,201);const enabled=await f.call('/webhook-endpoints/'+response.data.endpoint.id,'PATCH',{expectedVersion:response.data.endpoint.version,enabled:true});assert.equal(enabled.status,200);return{...response.data,endpoint:enabled.data};}
function payload(id=101,issue='NEO-1',timestamp=new Date().toISOString()){return{object_kind:'merge_request',project:{id:42},object_attributes:{id,iid:id,action:'merge',state:'merged',title:`${issue} synthetic`,source_branch:`feature/${issue}`,url:`http://gitlab.synthetic.test/-/merge_requests/${id}`,updated_at:timestamp}};}
async function hook(f:Awaited<ReturnType<typeof fixture>>,body=payload(),id=randomUUID()){return f.call('/integrations/gitlab/webhook','POST',body,{'X-Gitlab-Token':'integration-secret','webhook-id':id});}

test('authenticated automation shares issue, audit, receipt and minimal outbox transaction',async()=>{
  const f=await fixture();try{
    await configure(f);await endpoint(f);await rule(f);const before=f.observer.get<Issue>('issues','issue-1')!;const body=payload(),id=randomUUID();const result=await hook(f,body,id);assert.equal(result.status,200,JSON.stringify(result.data));
    const snapshot=(await f.call('/workspace')).data,issue=snapshot.issues.find((value:Issue)=>value.id==='issue-1');assert.equal(issue.status,'done');assert.ok(issue.completedAt);assert.equal(issue.version,before.version+1);
    const webhookStatus = await f.call<GitlabWebhookStatus>('/integrations/gitlab/webhook-status');
    assert.equal(webhookStatus.status, 200);
    assert.equal(webhookStatus.data.repositories[0].lastDelivery?.automationRuns, 1);
    assert.equal(webhookStatus.data.repositories[0].lastDelivery?.linked, 1);
    assert.equal((await f.call('/integrations/gitlab/webhook-status?repositoryId=42')).status, 400);
    const activity=snapshot.activities.at(-1);assert.equal(activity.actorId,'user-seo');assert.match(activity.action,/자동화/);
    const deliveries=(await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;assert.equal(deliveries.length,1);
    const detail=(await f.call<{delivery:WebhookDelivery;envelope:WebhookEnvelope}>('/webhook-deliveries/'+deliveries[0].id)).data;assert.equal(detail.envelope.origin,'automation');assert.equal(detail.envelope.actorId,'user-seo');assert.ok(detail.envelope.sourceEventId);assert.deepEqual(detail.envelope.changedFields.sort(),['completedAt','status']);assert.equal(detail.envelope.resource.status,'done');assert.ok(!JSON.stringify(detail).includes('integration-secret'));assert.ok(!Object.hasOwn(detail.envelope.resource,'description'));
    assert.equal((await hook(f,body,id)).data.duplicate,true);assert.equal((await f.call<WebhookDelivery[]>('/webhook-deliveries')).data.length,1);assert.equal((await f.call('/automation-runs')).data.length,1);
    const older=payload(101,'NEO-1',new Date(Date.now()-60000).toISOString());older.object_attributes.action='reopen';older.object_attributes.state='opened';assert.equal((await hook(f,older)).status,200);assert.equal(f.observer.get<Issue>('issues','issue-1')!.status,'done');
  }finally{await f.close();}
});

test('pipeline automation and the direct-review token distinguish compatible runs on the same ref', async t => {
  const branch = 'feature/pipeline-scope';
  const sha = 'a'.repeat(40);
  const checkedId = 500;
  let finishedAt = '';
  let repositoryUrl = '';
  const mock = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v4/projects/42') {
      res.end(JSON.stringify({ id: 42, path_with_namespace: 'team/repo', web_url: repositoryUrl }));
    } else if (req.url === `/api/v4/projects/42/pipelines/${checkedId}`) {
      res.end(JSON.stringify({ id: checkedId, iid: checkedId, project_id: 42, ref: branch, sha, status: 'success',
        source: 'push', tag: false, finished_at: finishedAt, updated_at: finishedAt, web_url: `${repositoryUrl}/-/pipelines/${checkedId}` }));
    } else res.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => mock.close(() => resolve())));
  await once(mock, 'listening');
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('GitLab mock address missing');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  repositoryUrl = `${baseUrl}/team/repo`;

  const f = await fixture();
  t.after(f.close);
  const configured = await f.call('/integrations/gitlab', 'PATCH', {
    expectedVersion: 1, baseUrl, projectIds: [42], webhookSecret: 'integration-secret', token: 'synthetic-read-token',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const saved = await rule(f, { name: 'Pipeline verified', trigger: 'pipeline.succeeded', branchPattern: branch });
  const before = f.observer.get<Issue>('issues', 'issue-1')!;
  const deliver = async (id: number, source: string, tag: boolean, status: 'running' | 'success', keyed = false) => {
    const time = new Date().toISOString();
    const response = await f.call('/integrations/gitlab/webhook', 'POST', {
      object_kind: 'pipeline', project: { id: 42, web_url: repositoryUrl },
      object_attributes: { id, ref: branch, sha, source, tag, status, updated_at: time, ...(status === 'success' ? { finished_at: time } : {}) },
      ...(keyed ? { commit: { id: sha, message: 'NEO-1 pipeline' } } : {}),
    }, { 'X-Gitlab-Token': 'integration-secret', 'webhook-id': randomUUID() });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return time;
  };
  const reviewed = async () => {
    const response = await f.call<GitlabIssueRefreshResult>('/issues/issue-1/gitlab-links/refresh', 'POST', {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(response.data.failures, []);
    return response.data.statusReview;
  };

  const startedAt = await deliver(checkedId, 'push', false, 'running', true);
  await deliver(501, 'schedule', false, 'running');
  await deliver(502, 'push', true, 'running');
  finishedAt = new Date().toISOString();
  assert.ok(finishedAt > startedAt);
  const review = await reviewed();
  assert.equal(review?.kind, 'suggestion');
  if (review?.kind !== 'suggestion') throw new Error('Pipeline suggestion missing');
  assert.equal(review.suggestion.evidence.link.pipelineSource, 'push');
  assert.equal(review.suggestion.evidence.link.pipelineTag, false);
  const exact = await f.call<GitlabIssueRefreshResult>(`/issues/issue-1/gitlab-links/${encodeURIComponent(review.suggestion.evidence.link.id)}/refresh`, 'POST', {});
  assert.equal(exact.status, 200);
  assert.equal(exact.data.links.length, 1);
  assert.equal(exact.data.statusReview, undefined);

  const rulePath = `/automation-rules/${saved.id}`;
  const scheduled = await f.call<AutomationRule>(rulePath, 'PATCH', {
    expectedVersion: saved.version, pipelineSources: ['schedule'], pipelineRefKind: 'branch',
  });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
  const outdatedRule = await f.call('/issues/issue-1', 'PATCH', {
    expectedVersion: before.version, status: 'done', gitlabStatusSuggestionToken: review.suggestion.token,
  });
  assert.equal(outdatedRule.status, 409, JSON.stringify(outdatedRule.data));
  assert.equal(outdatedRule.data.details.reason, 'gitlab_status_suggestion_stale');
  finishedAt = new Date().toISOString();
  assert.equal(await reviewed(), undefined);

  const tags = await f.call<AutomationRule>(rulePath, 'PATCH', {
    expectedVersion: scheduled.data.version, pipelineSources: ['push'], pipelineRefKind: 'tag',
  });
  assert.equal(tags.status, 200, JSON.stringify(tags.data));
  finishedAt = new Date().toISOString();
  assert.equal(await reviewed(), undefined);

  const pushes = await f.call<AutomationRule>(rulePath, 'PATCH', {
    expectedVersion: tags.data.version, pipelineRefKind: 'branch',
  });
  assert.equal(pushes.status, 200, JSON.stringify(pushes.data));
  finishedAt = new Date().toISOString();
  const filtered = await reviewed();
  assert.equal(filtered?.kind, 'suggestion');
  if (filtered?.kind !== 'suggestion') throw new Error('Filtered pipeline suggestion missing');
  assert.equal(filtered.suggestion.rule.version, pushes.data.version);

  await deliver(503, 'push', false, 'running');
  assert.equal(await reviewed(), undefined);
  const stale = await f.call('/issues/issue-1', 'PATCH', {
    expectedVersion: before.version, status: 'done', gitlabStatusSuggestionToken: filtered.suggestion.token,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.details.reason, 'gitlab_status_suggestion_stale');
  assert.deepEqual(f.observer.get('issues', before.id), before);

  await deliver(506, 'merge_request_event', false, 'running');
  await deliver(505, 'push', false, 'success', true);
  assert.equal(f.observer.get<Issue>('issues', before.id)?.status, 'done');
  const runs = (await f.call<AutomationRun[]>('/automation-runs')).data;
  assert.deepEqual(runs.map(run => [run.context?.objectId, run.outcome]), [['505', 'changed']]);
  assert.equal(f.observer.all<GitlabLink>('gitlab_links').find(link => link.iid === 505)?.pipelineSource, 'push');
});

test('pipeline filters use authenticated exact execution evidence, including on sparse terminal deliveries', async t => {
  const f = await fixture();
  t.after(f.close);
  await configure(f);
  const before = f.observer.get<Issue>('issues', 'issue-1')!;
  const ref = 'feature/pipeline-filter';
  const sha = 'b'.repeat(40);
  await rule(f, { trigger: 'pipeline.succeeded', branchPattern: ref, pipelineSources: ['push'], pipelineRefKind: 'branch' });
  const start = Date.now() - 100;
  let deliveryCount = 0;
  const deliver = async (id: number, classification: Record<string, unknown>, keyed = true) => {
    const time = new Date(start + deliveryCount++).toISOString();
    const response = await f.call<{ runs: AutomationRun[] }>('/integrations/gitlab/webhook', 'POST', {
      object_kind: 'pipeline', project: { id: 42, web_url: 'http://gitlab.synthetic.test/team/repo' },
      object_attributes: { id, ref, sha, status: 'success', updated_at: time, ...classification },
      ...(keyed ? { commit: { id: sha, message: 'NEO-1 pipeline' } } : {}),
    }, { 'X-Gitlab-Token': 'integration-secret', 'webhook-id': randomUUID() });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.runs;
  };

  for (const [id, classification, reason] of [
    [700, { source: 'schedule', tag: false }, /선택한 파이프라인 실행 유형/u],
    [701, { source: 'merge_request_event', tag: false }, /선택한 파이프라인 실행 유형/u],
    [702, { source: 'push', tag: true }, /선택한 파이프라인 참조 유형/u],
    [703, { tag: false }, /실행 유형을 확인/u],
    [704, { source: 'push', tag: 'false' }, /참조가 브랜치인지 태그인지 확인/u],
    [705, { id: undefined, iid: 705, source: 'push', tag: false }, /실행 유형을 확인/u],
  ] as const) {
    const [run] = await deliver(id, classification);
    assert.equal(run.outcome, 'ignored');
    assert.match(run.reason, reason);
    assert.deepEqual(f.observer.get('issues', before.id), before);
  }

  assert.deepEqual(await deliver(706, { status: 'running', source: 'push', tag: false }, false), []);
  const [conflict] = await deliver(706, { source: 'schedule', tag: false });
  assert.equal(conflict.outcome, 'ignored');
  assert.match(conflict.reason, /기존 연결과 다릅니다/u);
  assert.equal(conflict.context?.pipelineSource, undefined);
  const [applied] = await deliver(706, {});
  assert.equal(applied.outcome, 'changed');
  assert.equal(applied.context?.pipelineSource, 'push');
  assert.equal(applied.context?.pipelineTag, false);
  assert.equal(f.observer.get<Issue>('issues', before.id)?.status, 'done');
});

test('pipeline rule preview and edits preserve independent source and ref filters', async t => {
  const f = await fixture();
  t.after(f.close);
  await configure(f);
  const before = f.observer.get<Issue>('issues', 'issue-1')!;
  const saved = await rule(f, {
    trigger: 'pipeline.succeeded', pipelineSources: ['schedule', 'push'], pipelineRefKind: 'branch',
  });
  assert.deepEqual(saved.pipelineSources, ['push', 'schedule']);
  const preview = (sample: Record<string, unknown> = {}, edits: Record<string, unknown> = {}) =>
    f.call('/automation/preview', 'POST', {
      rule: { ...saved, ...edits }, issueIds: [before.id],
      sample: { trigger: 'pipeline.succeeded', gitlabProjectId: 42, branch: 'feature/NEO-1', ...sample },
    });
  for (const [sample, edits, outcome] of [
    [{ pipelineSource: 'push', pipelineTag: false }, {}, 'changed'],
    [{ pipelineSource: 'schedule', pipelineTag: false }, {}, 'changed'],
    [{ pipelineSource: 'web', pipelineTag: false }, {}, 'ignored'],
    [{ pipelineSource: 'push', pipelineTag: true }, {}, 'ignored'],
    [{ pipelineSource: 'push' }, {}, 'ignored'],
    [{ pipelineTag: false }, {}, 'ignored'],
    [{ pipelineSource: 'push' }, { pipelineRefKind: null }, 'changed'],
    [{ pipelineTag: true }, { pipelineSources: [], pipelineRefKind: 'tag' }, 'changed'],
    [{}, { pipelineSources: [], pipelineRefKind: null }, 'changed'],
  ] as const) {
    const response = await preview(sample, edits);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.outcomes[0].outcome, outcome);
  }
  assert.equal((await preview({ pipelineSource: 'Push' })).status, 400);
  assert.equal((await preview({ pipelineTag: 'false' })).status, 400);
  assert.equal((await preview({ trigger: 'merge_request.merged', pipelineTag: false })).status, 400);
  assert.deepEqual(f.observer.get('issues', before.id), before);
  assert.deepEqual((await f.call('/automation-runs')).data, []);

  const path = `/automation-rules/${saved.id}`;
  for (const invalid of [
    { pipelineSources: ['push', 'push'] },
    { pipelineSources: ['schedule!'] },
    { pipelineRefKind: 'any' },
    { trigger: 'merge_request.merged', pipelineSources: ['push'] },
  ]) assert.equal((await f.call(path, 'PATCH', { expectedVersion: saved.version, ...invalid })).status, 400);
  const cleared = await f.call<AutomationRule>(path, 'PATCH', {
    expectedVersion: saved.version, pipelineSources: [], pipelineRefKind: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.version, saved.version + 1);
  assert.ok(Date.parse(cleared.data.enabledAt!) > Date.parse(saved.enabledAt!));
  assert.equal(Object.hasOwn(cleared.data, 'pipelineSources'), false);
  assert.equal(Object.hasOwn(cleared.data, 'pipelineRefKind'), false);
  const tagged = await f.call<AutomationRule>(path, 'PATCH', { expectedVersion: cleared.data.version, pipelineRefKind: 'tag' });
  assert.equal(tagged.status, 200, JSON.stringify(tagged.data));
  const merge = await f.call<AutomationRule>(path, 'PATCH', { expectedVersion: tagged.data.version, trigger: 'merge_request.merged' });
  assert.equal(merge.status, 200, JSON.stringify(merge.data));
  assert.equal(Object.hasOwn(merge.data, 'pipelineRefKind'), false);
});

test('preview and webhook honor the same required-field workflow without creating mutation events',async()=>{
  const f=await fixture();try{
    await configure(f);assert.equal((await f.call('/issues/issue-1','PATCH',{expectedVersion:f.observer.get<Issue>('issues','issue-1')!.version,dueDate:null})).status,200);await endpoint(f);const workflow=(await f.call('/projects/project-neo/workflow')).data;workflow.transitions.find((edge:any)=>edge.from==='in_progress'&&edge.to==='done').requiredFields=['dueDate'];assert.equal((await f.call('/projects/project-neo/workflow','PATCH',{...workflow,expectedVersion:workflow.version})).status,200);
    const saved=await rule(f);const preview=await f.call('/automation/preview','POST',{rule:saved,issueIds:['issue-1'],sample:{trigger:'merge_request.merged',gitlabProjectId:42,branch:'feature/NEO-1'}});assert.equal(preview.status,200);assert.equal(preview.data.outcomes[0].outcome,'blocked');assert.equal((await f.call('/automation-runs')).data.length,0);
    const before=f.observer.get<Issue>('issues','issue-1')!;assert.equal((await hook(f)).status,200);assert.deepEqual(f.observer.get('issues','issue-1'),before);assert.equal((await f.call('/automation-runs')).data[0].outcome,'blocked');assert.equal((await f.call('/webhook-deliveries')).data.length,0);
    const path='/issues/issue-1/automation-runs';
    const page=await f.call<IssueAutomationRunPage>(path);
    assert.equal(page.status,200);
    const [blocked]=page.data.items;
    assert.equal(page.data.latestBlockedRunId,blocked.id);
    assert.match(blocked.reason,/필수/);
    assert.deepEqual(blocked.context && [blocked.context.ruleName,blocked.context.trigger,blocked.context.objectId],
      ['병합 후 완료','merge_request.merged','101']);
    assert.equal((await f.call(`${path}?before=${blocked.id}&before=${blocked.id}`)).status,400);
    assert.equal((await f.call('/issues/missing/automation-runs')).status,404);
    assert.equal((await f.call('/issues/issue-1','PATCH',{expectedVersion:before.version,status:'done',dueDate:'2030-02-01'},{'X-Actor-Id':'user-jun'})).status,200);
    const resolved=(await f.call<IssueAutomationRunPage>(path)).data;
    assert.equal(resolved.latestBlockedRunId,null);
    assert.deepEqual(resolved.items,[blocked]);
  }finally{await f.close();}
});

test('GitLab preview and delivery honor the blocker guard and a new event succeeds after resolution', async () => {
  const f = await fixture();
  try {
    await configure(f);
    await endpoint(f);
    const path = '/projects/project-neo/workflow';
    const { data: workflow } = await f.call<ProjectWorkflow>(path);
    const guard = await f.call(path, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      transitions: workflow.transitions.map(edge => edge.from === 'in_progress' && edge.to === 'done'
        ? { ...edge, requireResolvedBlockers: true } : edge),
    });
    assert.equal(guard.status, 200, JSON.stringify(guard.data));
    const created = await f.call<Issue>('/issues', 'POST', { projectId: 'project-team', title: '외부 프로젝트 승인' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const source = created.data;
    const target = f.observer.get<Issue>('issues', 'issue-1')!;
    const linked = await f.call(`/issues/${source.id}/relations`, 'POST', {
      otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
    });
    assert.equal(linked.status, 201, JSON.stringify(linked.data));
    const saved = await rule(f);
    const sample = { trigger: 'merge_request.merged', gitlabProjectId: 42, branch: `feature/${target.key}` };
    const preview = () => f.call('/automation/preview', 'POST', { rule: saved, issueIds: [target.id], sample });
    const blockedPreview = await preview();
    assert.equal(blockedPreview.status, 200);
    assert.equal(blockedPreview.data.outcomes[0].outcome, 'blocked');
    assert.match(blockedPreview.data.outcomes[0].reason, /열린 차단 업무/u);
    assert.ok(!JSON.stringify(blockedPreview.data).includes(source.key));
    assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data, []);

    const originalEvent = payload(301, target.key);
    const eventId = randomUUID();
    const blockedEvent = await hook(f, originalEvent, eventId);
    assert.equal(blockedEvent.status, 200, JSON.stringify(blockedEvent.data));
    assert.deepEqual(f.observer.get('issues', target.id), target);
    assert.deepEqual((await f.call<WebhookDelivery[]>('/webhook-deliveries')).data, []);
    const [blockedRun] = (await f.call<AutomationRun[]>('/automation-runs')).data;
    assert.equal(blockedRun.outcome, 'blocked');
    assert.match(blockedRun.reason ?? '', /열린 차단 업무/u);
    assert.equal(f.observer.all('gitlab_links').length, 1);

    const closed = await f.call<Issue>(`/issues/${source.id}`, 'PATCH', { status: 'done', expectedVersion: source.version });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.equal((await preview()).data.outcomes[0].outcome, 'changed');
    assert.equal((await hook(f, originalEvent, eventId)).data.duplicate, true);
    assert.deepEqual(f.observer.get('issues', target.id), target);
    assert.equal((await hook(f, payload(302, target.key))).status, 200);
    const moved = f.observer.get<Issue>('issues', target.id)!;
    assert.equal(moved.status, 'done');
    assert.equal(moved.version, target.version + 1);
    assert.ok(moved.completedAt);
    assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data.map(item => item.outcome).sort(), ['blocked', 'changed']);
    const deliveries = (await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;
    assert.equal(deliveries.length, 1);
    const detail = (await f.call<{ envelope: WebhookEnvelope }>(`/webhook-deliveries/${deliveries[0].id}`)).data;
    assert.equal(detail.envelope.origin, 'automation');
    assert.equal(detail.envelope.resource.status, 'done');
  } finally {
    await f.close();
  }
});

test('native format 81 retains blocker guards and rejects a mislabeled legacy backup', async () => {
  const f = await fixture();
  try {
    const path = '/projects/project-neo/workflow';
    const legacy = { ...(await f.call('/export')).data, schemaVersion: 80 };
    const { data: workflow } = await f.call<ProjectWorkflow>(path);
    const edgeFor = (value: ProjectWorkflow) => value.transitions.find(edge => edge.from === 'in_progress' && edge.to === 'done');
    const guarded = await f.call<ProjectWorkflow>(path, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      transitions: workflow.transitions.map(edge => edge === edgeFor(workflow) ? { ...edge, requireResolvedBlockers: true } : edge),
    });
    assert.equal(guarded.status, 200);
    assert.equal(edgeFor(guarded.data)?.requireResolvedBlockers, true);
    const saved = (await f.call('/export')).data;
    assert.equal(saved.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    const bad = await f.call<{ error: string }>('/import', 'POST', { data: { ...saved, schemaVersion: 80 } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /schemaVersion 81/u);
    assert.deepEqual((await f.call<ProjectWorkflow>(path)).data, guarded.data);

    assert.equal((await f.call('/import', 'POST', { data: legacy })).status, 200);
    assert.equal(edgeFor((await f.call<ProjectWorkflow>(path)).data)?.requireResolvedBlockers, undefined);
    assert.equal((await f.call('/import', 'POST', { data: { ...saved, schemaVersion: 81 } })).status, 200);
    const restored = (await f.call<ProjectWorkflow>(path)).data;
    assert.equal(edgeFor(restored)?.requireResolvedBlockers, true);
    assert.ok(restored.version > guarded.data.version);
  } finally {
    await f.close();
  }
});

const closedSubtaskMessage = '열린 하위 업무를 먼저 완료하거나 취소해 주세요.';
const subtaskWorkflowPath = '/projects/project-neo/workflow';
const subtaskGuardEdge = (edge: ProjectWorkflow['transitions'][number]) => edge.from === 'in_progress' && edge.to === 'done';
const subtaskGuard = (workflow: ProjectWorkflow) => workflow.transitions.find(subtaskGuardEdge)!;

function saveSubtaskGuard(f: Awaited<ReturnType<typeof fixture>>, workflow: ProjectWorkflow, change: Record<string, unknown>) {
  return f.call<ProjectWorkflow>(subtaskWorkflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    transitions: workflow.transitions.map(edge => subtaskGuardEdge(edge) ? { ...edge, ...change } : edge),
  });
}

async function openSubtaskPair(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = await f.call<Issue>('/issues', 'POST', { projectId: 'project-neo', status: 'in_progress', title: '합성 상위 업무' });
  assert.equal(parent.status, 201, JSON.stringify(parent.data));
  const child = await f.call<Issue>('/issues', 'POST', { projectId: 'project-neo', parentId: parent.data.id, title: '합성 미완료 하위 업무' });
  assert.equal(child.status, 201, JSON.stringify(child.data));
  assert.equal(child.data.parentId, parent.data.id);
  return { parent: parent.data, child: child.data };
}

test('signed GitLab automation honors the closed-subtask guard and a new event can move the parent after resolution', async t => {
  const f = await fixture();
  t.after(f.close);
  const key = Buffer.alloc(32, 19);
  const configured = await f.call<GitlabSettings>('/integrations/gitlab', 'PATCH', {
    expectedVersion: 1, baseUrl: 'http://gitlab.synthetic.test', projectIds: [42], signingToken: `whsec_${key.toString('base64')}`,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  assert.equal(configured.data.signingTokenConfigured, true);
  assert.equal(configured.data.webhookSecretConfigured, false);

  const workflow = (await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data;
  const enabled = await saveSubtaskGuard(f, workflow, { requireClosedSubtasks: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(subtaskGuard(enabled.data).requireClosedSubtasks, true);
  const { parent, child } = await openSubtaskPair(f);
  const target = f.observer.get<Issue>('issues', parent.id)!;
  await endpoint(f);
  const savedRule = await rule(f);
  const preview = () => f.call<AutomationPreview>('/automation/preview', 'POST', { rule: savedRule, issueIds: [target.id],
    sample: { trigger: 'merge_request.merged', gitlabProjectId: 42, branch: `feature/${target.key}` } });
  const blocked = await preview();
  assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
  assert.equal(blocked.data.outcomes[0].outcome, 'blocked');
  assert.equal(blocked.data.outcomes[0].reason, closedSubtaskMessage);
  assert.ok(!JSON.stringify(blocked.data).includes(child.key));
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data, []);

  function signed(body: ReturnType<typeof payload>, id = randomUUID()) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(JSON.stringify(body)).digest('base64');
    return f.call<{ duplicate: boolean; linked: number; runs: AutomationRun[] }>('/integrations/gitlab/webhook', 'POST', body, {
      'X-Gitlab-Event': 'Merge Request Hook', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
    });
  }
  const firstEvent = payload(340, target.key);
  const id = randomUUID();
  const delivery = await signed(firstEvent, id);
  assert.equal(delivery.status, 200, JSON.stringify(delivery.data));
  assert.equal(delivery.data.linked, 1);
  const [blockedRun] = delivery.data.runs;
  assert.equal(blockedRun.outcome, 'blocked');
  assert.equal(blockedRun.reason, closedSubtaskMessage);
  assert.deepEqual(f.observer.get<Issue>('issues', target.id), target);
  assert.deepEqual((await f.call<WebhookDelivery[]>('/webhook-deliveries')).data, []);

  const closed = await f.call<Issue>(`/issues/${child.id}`, 'PATCH', { expectedVersion: child.version, status: 'done' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.status, 'done');
  assert.equal((await preview()).data.outcomes[0].outcome, 'changed');
  const retry = await signed(firstEvent, id);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.duplicate, true);
  assert.deepEqual(f.observer.get<Issue>('issues', target.id), target);
  const accepted = await signed(payload(341, target.key));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.runs.map(run => run.outcome), ['changed']);
  const moved = f.observer.get<Issue>('issues', target.id)!;
  assert.equal(moved.status, 'done');
  assert.equal(moved.version, target.version + 1);
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data.map(run => run.outcome), ['changed', 'blocked']);
  const deliveries = (await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;
  const envelopes = await Promise.all(deliveries.map(item => f.call<{ envelope: WebhookEnvelope }>(`/webhook-deliveries/${item.id}`)));
  const automated = envelopes.filter(({ data }) => data.envelope.origin === 'automation');
  assert.equal(automated.length, 1);
  assert.equal(automated[0].data.envelope.resource.id, target.id);
  assert.equal(automated[0].data.envelope.resource.status, 'done');
});

test('portable backup preserves the closed-subtask guard and older format imports retain permissive behavior', async t => {
  const f = await fixture();
  t.after(f.close);
  const { parent, child } = await openSubtaskPair(f);
  const workflow = (await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data;
  type WorkflowBackup = { schemaVersion: number; workflows: ProjectWorkflow[] };
  const legacy = { ...(await f.call<WorkflowBackup>('/export')).data, schemaVersion: 114 };
  const enabled = await saveSubtaskGuard(f, workflow, { requireClosedSubtasks: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  for (const invalid of [null, 'true', 1]) {
    const rejected = await saveSubtaskGuard(f, enabled.data, { requireClosedSubtasks: invalid });
    assert.equal(rejected.status, 400);
    assert.deepEqual((await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data, enabled.data);
  }

  const legacyClient = structuredClone(enabled.data);
  delete subtaskGuard(legacyClient).requireClosedSubtasks;
  const retained = await saveSubtaskGuard(f, legacyClient, {});
  assert.equal(retained.status, 200, JSON.stringify(retained.data));
  assert.equal(subtaskGuard(retained.data).requireClosedSubtasks, true);
  const backup = (await f.call<WorkflowBackup>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(subtaskGuard(backup.workflows.find(item => item.projectId === workflow.projectId)!).requireClosedSubtasks, true);

  const disabled = await saveSubtaskGuard(f, retained.data, { requireClosedSubtasks: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
  assert.ok(!Object.hasOwn(subtaskGuard(disabled.data), 'requireClosedSubtasks'));
  const mislabeled = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 114 } });
  assert.equal(mislabeled.status, 400);
  assert.match(mislabeled.data.error, /schemaVersion 115/u);
  assert.deepEqual((await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data, disabled.data);

  assert.equal((await f.call('/import', 'POST', { data: legacy })).status, 200);
  assert.equal(subtaskGuard((await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data).requireClosedSubtasks, undefined);
  async function moveParent() {
    const current = f.observer.get<Issue>('issues', parent.id)!;
    return f.call<{ error?: string; status?: string; details?: { reason?: string } }>(`/issues/${parent.id}`, 'PATCH', {
      expectedVersion: current.version, status: 'done',
    });
  }
  const older = await moveParent();
  assert.equal(older.status, 200, JSON.stringify(older.data));
  assert.equal(older.data.status, 'done');

  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  const restored = (await f.call<ProjectWorkflow>(subtaskWorkflowPath)).data;
  assert.equal(subtaskGuard(restored).requireClosedSubtasks, true);
  assert.ok(restored.version > disabled.data.version);
  assert.equal(f.observer.get<Issue>('issues', child.id)?.parentId, parent.id);
  const before = f.observer.get<Issue>('issues', parent.id)!;
  const restoredBlock = await moveParent();
  assert.equal(restoredBlock.status, 422, JSON.stringify(restoredBlock.data));
  assert.equal(restoredBlock.data.error, closedSubtaskMessage);
  assert.equal(restoredBlock.data.details?.reason, 'open_subtasks');
  assert.deepEqual(f.observer.get<Issue>('issues', parent.id), before);
});

test('native automation backup restores execution history and disabled rules with operational outbox reset',async()=>{
  const f=await fixture();try{
    await configure(f);const destination=await endpoint(f);const saved=await rule(f);assert.equal((await hook(f)).status,200);const backup=(await f.call('/export')).data;assert.equal(backup.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.equal(backup.automationRules[0].id,saved.id);
    const serialized=JSON.stringify(backup);for(const privateValue of [destination.secret,destination.endpoint.url,'integration-secret','webhook_endpoints','webhook_deliveries'])assert.ok(!serialized.includes(privateValue));
    assert.equal(Object.hasOwn(backup, 'gitlabWebhookDeliveries'), false);
    const history=await f.call<AutomationRun[]>('/automation-runs');
    assert.equal(history.data.length,1);
    const [run]=history.data;
    assert.deepEqual(backup.automationRuns,history.data);
    assert.equal(run.context?.gitlabBaseUrl,'http://gitlab.synthetic.test');
    const oldFormat=await f.call<{error:string}>('/import','POST',{data:{...backup,schemaVersion:63,issueChangeHistory:undefined}});
    assert.equal(oldFormat.status,400);
    assert.match(oldFormat.data.error,/schemaVersion 64/);
    for(const automationRuns of [
      [run,{...run,id:randomUUID()}], [{...run,id:'a'.repeat(201)}],
      [{...run,context:{...run.context,gitlabBaseUrl:'https://token:secret@gitlab.synthetic.test'}}],
    ]){
      assert.equal((await f.call('/import','POST',{data:{...backup,automationRuns}})).status,400);
      assert.deepEqual((await f.call('/automation-runs')).data,history.data);
      assert.equal((await f.call('/webhook-endpoints')).data.length,1);
    }
    assert.equal((await f.call('/import','POST',{data:backup})).status,200);const restored=(await f.call<AutomationRule[]>('/automation-rules')).data[0];assert.equal(restored.enabled,false);assert.equal(restored.enabledAt,null);assert.ok(restored.version>saved.version);
    assert.deepEqual((await f.call<IssueAutomationRunPage>('/issues/issue-1/automation-runs')).data,
      {items:[run],nextCursor:null,latestBlockedRunId:null,issueVersion:f.observer.get<Issue>('issues','issue-1')!.version});
    assert.equal((await f.call('/webhook-endpoints')).data.length,0);assert.equal((await f.call('/webhook-deliveries')).data.length,0);assert.equal(f.observer.db.prepare('SELECT COUNT(*) AS total FROM webhook_events').get()!.total,0);
    assert.deepEqual((await f.call<GitlabWebhookStatus>('/integrations/gitlab/webhook-status')).data.repositories, [{ repositoryId: 42, lastDelivery: null }]);
    assert.equal((await f.call('/integrations/gitlab')).data.webhookSecretConfigured,true);
    const olderRun={...run};delete olderRun.context;
    assert.equal((await f.call('/import','POST',{data:{...backup,automationRuns:[olderRun]}})).status,200);
    assert.deepEqual((await f.call('/automation-runs')).data,[olderRun]);
    const legacy={...backup,schemaVersion:7,issueChangeHistory:undefined};delete legacy.automationRules;delete legacy.automationRuns;
    assert.equal((await f.call('/import','POST',{data:legacy})).status,200);
    assert.equal((await f.call('/automation-rules')).data.length,0);
    assert.deepEqual((await f.call('/automation-runs')).data,[]);
  }finally{await f.close();}
});

test('late native import validation failure rolls back rule, destination, queue and config generation',async()=>{
  const f=await fixture();try{
    await configure(f);await endpoint(f);await rule(f);await hook(f);const backup=(await f.call('/export')).data;
    const before={rules:(await f.call('/automation-rules')).data,history:(await f.call('/automation-runs')).data,endpoints:(await f.call('/webhook-endpoints')).data,deliveries:(await f.call('/webhook-deliveries')).data,settings:(await f.call('/integrations/gitlab')).data,generation:f.observer.setting('outboundWebhookGeneration')};
    backup.dependencies.push({id:randomUUID(),predecessorId:'missing-issue',successorId:'issue-1',type:'FS',lagDays:0});assert.equal((await f.call('/import','POST',{data:backup})).status,404);
    assert.deepEqual((await f.call('/automation-rules')).data,before.rules);assert.deepEqual((await f.call('/automation-runs')).data,before.history);assert.deepEqual((await f.call('/webhook-endpoints')).data,before.endpoints);assert.deepEqual((await f.call('/webhook-deliveries')).data,before.deliveries);assert.deepEqual((await f.call('/integrations/gitlab')).data,before.settings);assert.equal(f.observer.setting('outboundWebhookGeneration'),before.generation);
  }finally{await f.close();}
});

test('API keys cannot configure automation or destinations and outbound events retain fixed key actor',async()=>{
  const f=await fixture();try{
    await endpoint(f);const key=(await f.call('/api-keys','POST',{name:'합성 쓰기',access:'write',projectIds:['project-neo'],expiresAt:null},{'X-Actor-Id':'user-jun'})).data;
    const headers={Authorization:`Bearer ${key.token}`,'X-Actor-Id':'user-seo'};for(const path of ['/v1/automation-rules','/v1/webhook-endpoints','/v1/integrations/gitlab'])assert.equal((await f.call(path,'POST',{},headers)).status,403);
    const issue=f.observer.get<Issue>('issues','issue-1')!;assert.equal((await f.call('/v1/issues/issue-1','PATCH',{expectedVersion:issue.version,title:issue.title+' API'},headers)).status,200);
    const deliveries=(await f.call<WebhookDelivery[]>('/webhook-deliveries')).data;assert.equal(deliveries.length,1);const detail=(await f.call('/webhook-deliveries/'+deliveries[0].id)).data;assert.equal(detail.envelope.actorId,'user-jun');assert.equal(detail.envelope.origin,'user');
  }finally{await f.close();}
});

test('Store change listeners join implicit writes and preserve separate async mutation contexts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-store-observer-')),store=new Store(dir);try{
    store.put('activities',{id:'seed'});const stop=store.onChange(change=>{store.put('settings_shadow',{id:'shadow',context:change.context});throw new Error('reject event enqueue');},['activities']);store.db.exec('CREATE TABLE settings_shadow(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    assert.throws(()=>store.withMutationContext({actorId:'first',origin:'user'},()=>store.put('activities',{id:'seed',value:2})),/reject event/);assert.deepEqual(store.get('activities','seed'),{id:'seed'});assert.equal(store.all('settings_shadow').length,0);stop();
    const contexts:string[]=[];store.onChange(change=>{contexts.push(change.context.actorId!);},['activities']);
    await Promise.all([store.withMutationContext({actorId:'one',origin:'user'},async()=>{await Promise.resolve();store.put('activities',{id:'one'});}),store.withMutationContext({actorId:'two',origin:'automation'},async()=>{await Promise.resolve();store.put('activities',{id:'two'});})]);assert.deepEqual(contexts,['one','two']);
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('automation audit failure rolls back issue changes and reporter notifications, then replay delivers once', async () => {
  const f = await fixture();
  try {
    const issueId = 'issue-1';
    const projectId = 'project-neo';
    const reporter = {'X-Actor-Id':'user-min'};
    const watcher = {'X-Actor-Id':'user-jun'};
    const automationActor = {'X-Actor-Id':'user-seo'};
    const original = f.observer.get<Issue>('issues', issueId)!;
    const assignedReporter = await f.call<Issue>(`/issues/${issueId}`, 'PATCH', {
      expectedVersion: original.version, reporterId: reporter['X-Actor-Id'],
    });
    assert.equal(assignedReporter.status, 200, JSON.stringify(assignedReporter.data));
    const before = assignedReporter.data;

    const workflowPath = `/projects/${projectId}/workflow`;
    const { data: workflow } = await f.call<ProjectWorkflow>(workflowPath);
    const beforeLabel = '개발 검토 중';
    const afterLabel = '배포 반영';
    const renamed = await f.call(workflowPath, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map(status => status.id === before.status ? { ...status, label: beforeLabel }
        : status.id === 'done' ? { ...status, label: afterLabel } : status),
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

    await configure(f);
    await endpoint(f);
    await rule(f);
    const body = payload(), id = randomUUID();
    const watchIssue = `/notifications/subscriptions/issue/${issueId}`;
    assert.equal((await f.call(watchIssue, 'PUT', { subscribed: true }, watcher)).status, 200);
    assert.equal((await f.call(`/notifications/subscriptions/project/${projectId}`, 'PUT', { subscribed: true }, watcher)).status, 200);
    assert.equal((await f.call(watchIssue, 'PUT', { subscribed: true }, automationActor)).status, 200);
    assert.equal((await f.call(watchIssue, 'GET', undefined, reporter)).data.subscribed, false);

    f.observer.db.exec("CREATE TRIGGER reject_automation_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='GitLab 자동화 상태 변경' BEGIN SELECT RAISE(ABORT,'synthetic automation audit rejection'); END;");
    assert.equal((await hook(f, body, id)).status, 500);
    assert.deepEqual(f.observer.get('issues', issueId), before);
    const transactionalTables = ['webhook_inbox', 'gitlab_object_cursors', 'gitlab_links', 'automation_runs', 'webhook_events', 'webhook_deliveries', 'team_notifications'];
    for (const table of transactionalTables) {
      assert.equal(f.observer.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total, 0, table);
    }

    f.observer.db.exec('DROP TRIGGER reject_automation_audit');
    assert.equal((await hook(f, body, id)).status, 200);
    const updated = f.observer.get<Issue>('issues', issueId)!;
    assert.equal(updated.status, 'done');
    assert.equal(updated.version, before.version + 1);
    const replay = await hook(f, body, id);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true);
    assert.deepEqual(f.observer.get('issues', issueId), updated);
    assert.equal((await f.call('/webhook-deliveries')).data.length, 1);

    for (const recipient of [reporter, watcher]) {
      const notifications = await f.call<TeamNotificationPage>('/notifications', 'GET', undefined, recipient);
      assert.equal(notifications.status, 200);
      assert.deepEqual(notifications.data.items.map(item => [item.kind, item.actorId, item.targetId, item.detail]), [
        ['issue-status-changed', automationActor['X-Actor-Id'], issueId, `${beforeLabel} → ${afterLabel}`],
      ]);
    }
    const self = await f.call<TeamNotificationPage>('/notifications', 'GET', undefined, automationActor);
    assert.equal(self.status, 200);
    assert.deepEqual(self.data.items, []);
  } finally {
    await f.close();
  }
});

test('rules protect status/type references and connection credential removal disables stale rules',async()=>{
  const f=await fixture();try{
    await configure(f);const wfPath='/projects/project-neo/workflow',schemaPath='/projects/project-neo/issue-schema';
    const workflow=(await f.call(wfPath)).data,schema=(await f.call(schemaPath)).data;const addedWorkflow={...workflow,statuses:[...workflow.statuses,{id:'verification',label:'검증대기',category:'in_progress',color:'#123456'}],expectedVersion:workflow.version};assert.equal((await f.call(wfPath,'PATCH',addedWorkflow)).status,200);
    const addedSchema={...schema,issueTypes:[...schema.issueTypes,{id:'synthetic_type',name:'합성유형',color:'#123456',archived:false}],expectedVersion:schema.version};assert.equal((await f.call(schemaPath,'PATCH',addedSchema)).status,200);
    const saved=await rule(f,{fromStatuses:['verification'],issueTypes:['synthetic_type']});assert.equal((await f.call(wfPath,'PATCH',{...workflow,expectedVersion:workflow.version+1})).status,409);assert.equal((await f.call(schemaPath,'PATCH',{...schema,expectedVersion:schema.version+1})).status,409);
    const config=(await f.call('/integrations/gitlab')).data;assert.equal((await f.call('/integrations/gitlab','PATCH',{expectedVersion:config.version,webhookSecret:''})).status,200);const disabled=(await f.call<AutomationRule[]>('/automation-rules')).data[0];assert.equal(disabled.enabled,false);assert.equal(disabled.enabledAt,null);assert.ok(disabled.version>saved.version);assert.equal((await f.call('/automation-rules/'+saved.id,'PATCH',{expectedVersion:saved.version,enabled:true})).status,409);
    assert.equal((await f.call('/automation-rules/'+saved.id,'DELETE',{expectedVersion:disabled.version})).status,200);assert.equal((await f.call(wfPath,'PATCH',{...workflow,expectedVersion:workflow.version+1})).status,200);assert.equal((await f.call(schemaPath,'PATCH',{...schema,expectedVersion:schema.version+1})).status,200);
  }finally{await f.close();}
});
