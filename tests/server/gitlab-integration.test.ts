import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Request } from 'express';
import { Store } from '../../server/store.js';
import { seed } from '../../server/seed.js';
import { GitlabIntegrationService,GitlabIntegrationError } from '../../server/gitlab-integration.js';
import type { AutomationEvent,GitlabJiraSource,GitlabLink,GitlabSettings,GitlabSyncFailure } from '../../shared/types.js';

function fixture(jiraSources: GitlabJiraSource[] = []){const dir=mkdtempSync(join(tmpdir(),'teamspace-gitlab-')),store=new Store(dir);seed(store);const events:AutomationEvent[]=[],connections:{before:GitlabSettings;after:GitlabSettings}[]=[];let rejectEvent=false;const service=new GitlabIntegrationService(store,{processEvent:event=>{if(rejectEvent)throw new Error('audit rollback');events.push(event);return[];},onConnectionChanged:(before,after)=>{connections.push({before,after});return 0;},jiraSources:()=>jiraSources});return{dir,store,service,events,connections,rejectEvent:(value:boolean)=>{rejectEvent=value;},configure:(values:Record<string,unknown>={})=>service.configure({expectedVersion:service.settings().version,baseUrl:'https://git.example.test',projectIds:[42],webhookSecret:'legacy-secret',...values}),close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};}
function request(body:unknown,headers:Record<string,string>={},raw=Buffer.from(JSON.stringify(body))):Request{const values=Object.fromEntries(Object.entries({'x-gitlab-token':'legacy-secret','x-gitlab-event-uuid':randomUUID(),...headers}).map(([key,value])=>[key.toLowerCase(),value]));return{body,headers:values,gitlabRawBody:raw,header:(name:string)=>values[name.toLowerCase()]} as unknown as Request;}
function mr(values:Record<string,unknown>={}){return{object_kind:'merge_request',project:{id:42,web_url:'https://git.example.test/team/repo'},object_attributes:{id:101,iid:7,title:'NEO-1 동작 확인',description:'설명',source_branch:'feature/NEO-1',last_commit:{id:'sha-a'},state:'merged',action:'merge',updated_at:new Date(Date.now()-1000).toISOString(),url:'https://git.example.test/team/repo/-/merge_requests/7',...values}};}
function pipeline(values:Record<string,unknown>={}){return{object_kind:'pipeline',project:{id:42,web_url:'https://git.example.test/team/repo'},object_attributes:{id:200,ref:'feature/NEO-1',sha:'sha-a',status:'success',finished_at:new Date(Date.now()-1000).toISOString(),...values}};}
function rejects(action:()=>unknown,status=400){assert.throws(action,(error:unknown)=>error instanceof GitlabIntegrationError&&error.status===status);}
const links=(f:ReturnType<typeof fixture>)=>f.store.all<GitlabLink>('gitlab_links');
async function mockServer(handler:(path:string,response:ServerResponse,request:IncomingMessage)=>void){const server=createServer((req,res)=>handler(req.url||'',res,req));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No mock address');return{url:`http://127.0.0.1:${address.port}`,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));}};}

test('config CAS normalizes URLs and persists only encrypted write-only credentials with rollback-safe hooks',()=>{
  const f=fixture();try{assert.equal(f.service.settings().version,1);rejects(()=>f.service.configure({baseUrl:'https://git.example.test'}));const key=`whsec_${Buffer.alloc(32,9).toString('base64')}`;const settings=f.configure({baseUrl:'HTTPS://GIT.EXAMPLE.TEST///',token:'private-token',signingToken:key});assert.equal(settings.baseUrl,'https://git.example.test');assert.equal(settings.version,2);assert.ok(settings.tokenConfigured&&settings.webhookSecretConfigured&&settings.signingTokenConfigured);assert.ok(!JSON.stringify(settings).includes('private-token'));const stored=JSON.stringify(f.store.setting('gitlab'));for(const secret of ['private-token','legacy-secret',key])assert.ok(!stored.includes(secret));rejects(()=>f.service.configure({expectedVersion:1,token:'new-token'}),409);rejects(()=>f.configure({baseUrl:'https://name:secret@example.test'}));rejects(()=>f.configure({signingToken:'whsec_bad'}));assert.equal(f.connections.length,1);
    const before=f.service.settings();assert.throws(()=>f.service.configure({expectedVersion:before.version,token:'another-token'},()=>{throw new Error('audit rollback');}),/audit rollback/);assert.deepEqual(f.service.settings(),before);
  }finally{f.close();}
});

test('raw StandardWebhooks HMAC authentication, timestamp bounds and no invalid-signature legacy fallback',()=>{
  const f=fixture();try{
    const key=Buffer.alloc(32,5);f.configure({signingToken:`whsec_${key.toString('base64')}`});const payload=mr(),raw=Buffer.from(JSON.stringify(payload,null,2)),id=randomUUID(),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`),raw])).digest('base64'),headers={'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`};
    assert.equal(f.service.webhook(request(payload,headers,raw)).linked,1);assert.equal(f.service.webhook(request(payload,headers,raw)).duplicate,true);assert.equal(f.events.length,1);rejects(()=>f.service.webhook(request(payload,{...headers,'webhook-id':randomUUID()},raw)),401);rejects(()=>f.service.webhook(request(payload,headers,Buffer.from(JSON.stringify(payload)))),401);rejects(()=>f.service.webhook(request(payload,{...headers,'webhook-timestamp':String(Number(timestamp)-301)},raw)),401);rejects(()=>f.service.webhook(request(payload,{'webhook-signature':'v1,invalid'})),401);
    const unsigned=f.service.webhook(request(mr({id:102,iid:8})));assert.equal(unsigned.duplicate,false);const wrong=request(payload,{'x-gitlab-token':'wrong'});rejects(()=>f.service.webhook(wrong),401);const forbidden={...payload,project:{id:99}};rejects(()=>f.service.webhook(request(forbidden)),403);
  }finally{f.close();}
});

test('dedup, links and cursor/event processing share one transaction and retain original link IDs',()=>{
  const f=fixture();try{f.configure();const original=`gitlab:${createHash('sha256').update(f.service.settings().baseUrl).digest('hex').slice(0,12)}:42:merge_request:101:issue-1`;f.rejectEvent(true);const payload=mr(),headers={'x-gitlab-event-uuid':'same-event'};assert.throws(()=>f.service.webhook(request(payload,headers)),/audit rollback/);assert.equal(links(f).length,0);assert.equal(f.store.all('gitlab_object_cursors').length,0);assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM webhook_inbox').get() as {n:number}).n,0);f.rejectEvent(false);const first=f.service.webhook(request(payload,headers));assert.equal(first.linked,1);assert.equal(links(f)[0].id,original);assert.equal(f.service.webhook(request(payload,headers)).duplicate,true);assert.ok(f.events[0].id.length<300);
    const long=f.service.webhook(request(mr({id:102}),{'x-gitlab-event-uuid':'x'.repeat(500)}));assert.equal(long.duplicate,false);assert.ok(f.events[1].id.length<300);
  }finally{f.close();}
});

test('exact MR actions and timestamps gate automation while stale/equal-conflict events preserve newer links',()=>{
  const f=fixture();try{f.configure();const time=Date.now()-20000;f.service.webhook(request(mr({state:'opened',action:'update',updated_at:new Date(time).toISOString()})));assert.equal(f.events.length,0);
    for(const[action,state,trigger]of [['open','opened','merge_request.opened'],['reopen','opened','merge_request.opened'],['merge','merged','merge_request.merged'],['close','closed','merge_request.closed']] as const){f.service.webhook(request(mr({id:200+f.events.length,state,action,updated_at:new Date(time+f.events.length*1000).toISOString()})));assert.equal(f.events.at(-1)!.trigger,trigger);assert.equal(f.events.at(-1)!.disposition,'fresh');}
    const id=501,newest=new Date(time+15000).toISOString();f.service.webhook(request(mr({id,state:'merged',updated_at:newest})));f.service.webhook(request(mr({id,state:'opened',action:'open',updated_at:new Date(time+10000).toISOString()})));assert.equal(f.events.at(-1)!.disposition,'stale');assert.equal(links(f).find(link=>link.id.includes(':501:'))!.state,'merged');f.service.webhook(request(mr({id,state:'closed',action:'close',updated_at:newest})));assert.equal(f.events.at(-1)!.disposition,'ambiguous');assert.equal(links(f).find(link=>link.id.includes(':501:'))!.state,'merged');
    f.service.webhook(request(mr({id:600,updated_at:'2026-02-31T00:00:00Z'})));assert.equal(f.events.at(-1)!.disposition,'unverified');f.service.webhook(request(mr({id:601,updated_at:new Date(Date.now()+60000).toISOString()})));assert.equal(f.events.at(-1)!.disposition,'unverified');f.service.webhook(request(mr({id:602,updated_at:'2020-01-01 00:00:00 UTC'})));assert.equal(f.events.at(-1)!.occurredAt,'2020-01-01T00:00:00.000Z');
    const push={object_kind:'push',project_id:42,commits:[{id:'commit-a',message:'NEO-2 커밋 연결',url:'https://git.example.test/commit/a'}]};const count=f.events.length;assert.equal(f.service.webhook(request(push)).linked,1);assert.equal(f.events.length,count);
  }finally{f.close();}
});

test('pipeline branch ordering prevents late older results and MR inheritance requires identical branch/head SHA',()=>{
  const f=fixture();try{f.configure();const base=Date.now()-10000;f.service.webhook(request(mr({source_branch:'feature/reused',title:'NEO-1 연결',last_commit:{id:'head-a'},updated_at:new Date(base).toISOString()})));f.service.webhook(request(pipeline({id:300,ref:'feature/reused',sha:'head-a',finished_at:new Date(base+1000).toISOString()})));assert.deepEqual(f.events.at(-1)!.issueIds,['issue-1']);
    f.service.webhook(request(pipeline({id:301,ref:'feature/reused',sha:'head-b',status:'failed',finished_at:new Date(base+2000).toISOString()})));assert.deepEqual(f.events.at(-1)!.issueIds,[]);assert.equal(f.events.at(-1)!.trigger,'pipeline.failed');
    f.service.webhook(request(pipeline({id:299,ref:'feature/reused',sha:'head-a',finished_at:new Date(base+3000).toISOString()})));assert.equal(f.events.at(-1)!.disposition,'stale');assert.ok(links(f).some(link=>link.kind==='pipeline'&&link.iid===299));
    f.service.webhook(request(pipeline({id:999999,ref:'feature/reused',sha:'head-a',finished_at:new Date(Date.now()+60000).toISOString()})));assert.equal(f.events.at(-1)!.disposition,'unverified');f.service.webhook(request(pipeline({id:302,ref:'feature/reused',sha:'head-a',finished_at:new Date(base+4000).toISOString()})));assert.equal(f.events.at(-1)!.disposition,'fresh');
  }finally{f.close();}
});

const pushBase = 'https://git.example.test/forge';
const pushRepo = `${pushBase}/team/engine`;
const commitSha = (digit: string, width = 40) => digit.repeat(width);
function pushPayload(branch: string, before: string, after: string, commits: Record<string, unknown>[] = []) {
  return {
    object_kind: 'push', project_id: 42, ref: `refs/heads/${branch}`, before, after,
    checkout_sha: /^0+$/.test(after) ? null : after,
    project: { id: 42, web_url: pushRepo, path_with_namespace: 'team/engine' },
    commits, total_commits_count: commits.length,
  };
}

test('GitLab webhook receipts persist only accepted delivery summaries for each repository', t => {
  const f = fixture();
  t.after(f.close);
  const key = Buffer.alloc(32, 13);
  const saved = f.configure({ baseUrl: pushBase, projectIds: [42, 77], signingToken: `whsec_${key.toString('base64')}` });
  const empty = { settingsVersion: saved.version, repositories: [{ repositoryId: 42, lastDelivery: null }, { repositoryId: 77, lastDelivery: null }] };
  assert.deepEqual(f.service.webhookStatus(), empty);

  const push = pushPayload('feature/synthetic-branch-without-ticket', commitSha('0'), commitSha('a'));
  rejects(() => f.service.webhook(request(push, { 'x-gitlab-token': 'invalid-token' })), 401);
  rejects(() => f.service.webhook(request({ ...push, project: { ...push.project, id: 99 } })), 403);
  assert.deepEqual(f.service.webhookStatus(), empty);
  const sentAt = Date.now();
  assert.deepEqual(f.service.webhook(request(push, { 'x-gitlab-event-uuid': 'synthetic-private-delivery-id' })),
    { ok: true, duplicate: false, linked: 0, runs: [] });
  const first = f.service.webhookStatus();
  const delivered = first.repositories[0].lastDelivery;
  assert.ok(delivered);
  assert.ok(Date.parse(delivered.receivedAt) >= sentAt && Date.parse(delivered.receivedAt) <= Date.now());
  assert.deepEqual(delivered, { event: 'push', authentication: 'secret-token', receivedAt: delivered.receivedAt,
    duplicate: false, linked: 0, automationRuns: 0 });
  assert.equal(first.repositories[1].lastDelivery, null);

  const body = { ...mr({ title: 'NEO-1 synthetic-private-merge-title' }), project: { id: 77, web_url: `${pushBase}/team/other` } };
  const raw = Buffer.from(JSON.stringify(body));
  const signedId = 'synthetic-private-signed-id';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(`${signedId}.${timestamp}.`).update(raw).digest('base64');
  const signed = { 'webhook-id': signedId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  f.rejectEvent(true);
  assert.throws(() => f.service.webhook(request(body, signed, raw)), /audit rollback/);
  assert.deepEqual(f.service.webhookStatus(), first);
  f.rejectEvent(false);
  assert.equal(f.service.webhook(request(body, signed, raw)).linked, 1);
  const signedStatus = f.service.webhookStatus();
  const signedDelivery = signedStatus.repositories[1].lastDelivery;
  assert.ok(signedDelivery);
  assert.deepEqual(signedDelivery, { event: 'merge_request', authentication: 'signing-token', receivedAt: signedDelivery.receivedAt,
    duplicate: false, linked: 1, automationRuns: 0 });
  assert.deepEqual(signedStatus.repositories[0].lastDelivery, delivered);
  assert.equal(f.service.webhook(request(body, signed, raw)).duplicate, true);
  const replay = f.service.webhookStatus().repositories[1].lastDelivery;
  assert.ok(replay);
  assert.deepEqual(replay, { ...signedDelivery, receivedAt: replay.receivedAt, duplicate: true, linked: 0 });
  assert.equal(f.events.length, 1);

  const unsupported = 'synthetic-private-custom-event';
  f.service.webhook(request({ object_kind: unsupported, project_id: 42, payload: 'synthetic-private-inline-content' }));
  const expected = f.service.webhookStatus();
  assert.equal(expected.repositories[0].lastDelivery?.event, 'other');
  assert.equal(expected.repositories[0].lastDelivery?.linked, 0);
  const reopened = new Store(f.dir);
  try {
    const restoredService = new GitlabIntegrationService(reopened, { processEvent: () => [], onConnectionChanged: () => 0 });
    assert.deepEqual(restoredService.webhookStatus(), expected);
    const persisted = JSON.stringify(reopened.db.prepare('SELECT json FROM gitlab_webhook_deliveries').all());
    for (const redacted of ['legacy-secret', signedId, signature, unsupported, 'synthetic-private']) {
      assert.ok(!persisted.includes(redacted));
      assert.ok(!JSON.stringify(expected).includes(redacted));
    }
  } finally { reopened.db.close(); }
});

test('matching GitLab settings retain receipts while changed webhook scope prunes them atomically', t => {
  const jiraSource = { projectId: 'project-neo', jiraInstanceKey: 'synthetic-jira-source' };
  const f = fixture([jiraSource]);
  t.after(f.close);
  f.configure({ projectIds: [42, 77] });
  const patchSettings = (values: Record<string, unknown>, afterSave?: (settings: GitlabSettings) => void) =>
    f.service.configure({ expectedVersion: f.service.settings().version, ...values }, afterSave);
  const deliver = (repositoryId: number, token = 'legacy-secret') => f.service.webhook(request({ object_kind: 'push', project_id: repositoryId }, { 'x-gitlab-token': token }));
  deliver(42);
  deliver(77);
  const original = f.service.webhookStatus();
  const updated = patchSettings({ token: 'replacement-read-token', webhookSecret: 'legacy-secret' });
  assert.deepEqual(f.service.webhookStatus(), { ...original, settingsVersion: updated.version });

  assert.throws(() => patchSettings({ webhookSecret: 'rejected-webhook-secret' }, () => { throw new Error('settings rollback'); }), /settings rollback/);
  assert.deepEqual(f.service.webhookStatus(), { ...original, settingsVersion: updated.version });
  patchSettings({ jiraRoutes: [{ repositoryId: 42, ...jiraSource }] });
  assert.deepEqual(f.service.webhookStatus().repositories, [{ repositoryId: 42, lastDelivery: null }, original.repositories[1]]);
  deliver(42);
  const updatedMapping = f.service.webhookStatus().repositories[0];
  patchSettings({ projectIds: [42] });
  assert.deepEqual(f.service.webhookStatus().repositories, [updatedMapping]);
  patchSettings({ projectIds: [42, 77] });
  assert.deepEqual(f.service.webhookStatus().repositories, [updatedMapping, { repositoryId: 77, lastDelivery: null }]);

  const cleared = [{ repositoryId: 42, lastDelivery: null }, { repositoryId: 77, lastDelivery: null }];
  patchSettings({ webhookSecret: 'rotated-webhook-secret' });
  assert.deepEqual(f.service.webhookStatus().repositories, cleared);
  rejects(() => deliver(42), 401);
  deliver(42, 'rotated-webhook-secret');
  assert.ok(f.service.webhookStatus().repositories[0].lastDelivery);
  patchSettings({ baseUrl: 'https://another-git.example.test' });
  assert.deepEqual(f.service.webhookStatus().repositories, cleared);
  deliver(42, 'rotated-webhook-secret');
  assert.ok(f.service.webhookStatus().repositories[0].lastDelivery);
  f.store.transaction(() => f.service.resetForImport());
  assert.deepEqual(f.service.webhookStatus().repositories, cleared);
});

test('an authenticated push links a keyed branch without commits and associates commits before an MR exists', () => {
  const f = fixture();
  try {
    const key = Buffer.alloc(32, 7);
    f.configure({ baseUrl: pushBase, signingToken: `whsec_${key.toString('base64')}` });
    const issues = f.store.all('issues');
    const branch = 'feature/NEO-1';
    const initialHead = commitSha('a');
    const nextHead = commitSha('b');
    const explicitSha = commitSha('c');
    const firstPush = pushPayload(branch, commitSha('0'), initialHead);
    const raw = Buffer.from(JSON.stringify(firstPush, null, 2));
    const id = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(Buffer.from(`${id}.${timestamp}.`)).update(raw).digest('base64');
    const headers = { 'X-Gitlab-Event': 'Push Hook', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
    rejects(() => f.service.webhook(request(firstPush, { ...headers, 'webhook-signature': 'v1,incorrect' }, raw)), 401);
    assert.deepEqual(links(f), []);

    const created = f.service.webhook(request(firstPush, headers, raw));
    assert.equal(created.linked, 1);
    assert.deepEqual(created.runs, []);
    const [firstLink] = links(f);
    assert.ok(firstLink);
    assert.equal(firstLink.kind, 'branch');
    assert.equal(firstLink.iid, 0);
    assert.equal(firstLink.issueId, 'issue-1');
    assert.equal(firstLink.sourceBranch, branch);
    assert.equal(firstLink.sourceSha, initialHead);
    assert.equal(firstLink.state, 'active');
    assert.equal(firstLink.webUrl, `${pushRepo}/-/tree/feature%2FNEO-1`);
    assert.equal(f.service.webhook(request(firstPush, headers, raw)).duplicate, true);

    const nextPush = pushPayload(branch, initialHead, nextHead, [
      { id: nextHead, title: 'Improve development flow', message: 'Improve development flow', url: `${pushRepo}/-/commit/${nextHead}` },
      { id: explicitSha, title: 'Add report column', message: 'Add report column\n\nFollow-up NEO-2', url: `${pushRepo}/-/commit/${explicitSha}` },
    ]);
    const pushed = f.service.webhook(request(nextPush, { 'X-Gitlab-Event': 'Push Hook' }));
    assert.deepEqual(pushed.runs, []);
    const nextLinks = links(f);
    assert.equal(nextLinks.length, 3);
    const updated = nextLinks.find(link => link.id === firstLink.id);
    assert.equal(updated?.sourceSha, nextHead);
    const commits = nextLinks.filter(link => link.kind === 'commit');
    assert.deepEqual(new Map(commits.map(link => [link.sourceSha, link.issueId])), new Map([
      [nextHead, 'issue-1'], [explicitSha, 'issue-2'],
    ]));
    assert.ok(commits.every(link => link.sourceBranch === branch && link.iid === 0));
    assert.ok(commits.every(link => link.webUrl === `${pushRepo}/-/commit/${link.sourceSha}`));
    assert.equal(f.service.webhook(request(nextPush)).linked, 0);
    assert.deepEqual(links(f), nextLinks);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.store.all('issues'), issues);
  } finally { f.close(); }
});

test('push head continuity preserves branch history against disconnected updates and late deletions', () => {
  const f = fixture();
  try {
    f.configure({ baseUrl: pushBase });
    const branch = 'fix/NEO-1';
    const [zero, a, b, c, d, e] = ['0', 'a', 'b', 'c', 'd', 'e'].map(digit => commitSha(digit, 64));
    const push = (before: string, after: string, commits?: Record<string, unknown>[]) =>
      f.service.webhook(request(pushPayload(branch, before, after, commits), { 'X-Gitlab-Event': 'Push Hook' }));
    push(zero, a);
    const first = links(f).find(link => link.kind === 'branch')!;
    assert.equal(first.sourceSha, a);
    push(a, b, [{ id: b, title: 'Stable change', url: `${pushRepo}/-/commit/${b}` }]);
    push(d, c);
    assert.equal(links(f).find(link => link.id === first.id)?.sourceSha, b);
    push(a, zero);
    assert.equal(links(f).find(link => link.id === first.id)?.state, 'active');

    push(b, zero);
    const deleted = links(f).find(link => link.id === first.id);
    assert.equal(deleted?.state, 'deleted');
    assert.equal(deleted?.sourceSha, b);
    push(a, d);
    assert.deepEqual(links(f).find(link => link.id === first.id), deleted);
    push(zero, e);
    const recreated = links(f).find(link => link.id === first.id);
    assert.equal(recreated?.state, 'active');
    assert.equal(recreated?.sourceSha, e);
    push(b, zero);
    assert.deepEqual(links(f).find(link => link.id === first.id), recreated);
    assert.equal(links(f).filter(link => link.kind === 'branch').length, 1);
    assert.equal(links(f).find(link => link.kind === 'commit')?.sourceSha, b);
    assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test('tag events retain explicit commit matching without associating a branch or inheriting a ref key', () => {
  const f = fixture();
  try {
    f.configure({ baseUrl: pushBase });
    const sha = commitSha('a');
    const payload = {
      ...pushPayload('NEO-1', commitSha('0'), sha, [
        { id: sha, title: 'Release', message: 'Release NEO-2', url: `${pushRepo}/-/commit/${sha}` },
      ]),
      object_kind: 'tag_push', ref: 'refs/tags/NEO-1',
    };
    const applied = f.service.webhook(request(payload, { 'X-Gitlab-Event': 'Tag Push Hook' }));
    assert.equal(applied.linked, 1);
    const [commit] = links(f);
    assert.equal(links(f).length, 1);
    assert.equal(commit.kind, 'commit');
    assert.equal(commit.issueId, 'issue-2');
    assert.equal(commit.sourceBranch, undefined);
    const publicSha = commitSha('b');
    const publicUrl = `https://gitlab-public.example.test/team/engine/-/commit/${publicSha}`;
    const historical = { ...payload, project: { id: 42 }, commits: [{ id: publicSha, message: 'Legacy release NEO-2', url: publicUrl }] };
    assert.equal(f.service.webhook(request(historical)).linked, 1);
    assert.equal(links(f).find(link => link.sourceSha === publicSha)?.webUrl, publicUrl);
    assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test('sync remains read-only and a changed connection cannot receive in-flight success or failure results',async()=>{
  const f=fixture();let held:ServerResponse|undefined,announce=()=>{};const nextRequest=()=>new Promise<void>(resolve=>{announce=resolve;});const seen=nextRequest();const mock=await mockServer((path,res)=>{res.setHeader('Content-Type','application/json');if(path.includes('merge_requests')){held=res;announce();}else res.end('[]');});
  try{f.configure({baseUrl:mock.url});const pending=f.service.sync();await seen;const before=f.service.settings();f.service.configure({expectedVersion:before.version,baseUrl:'https://changed.example.test'});held!.end(JSON.stringify([{id:101,iid:7,title:'NEO-1 이전 결과',state:'merged',source_branch:'feature/NEO-1',web_url:'https://git.example.test/mr/7'}]));await assert.rejects(pending,(error:unknown)=>error instanceof GitlabIntegrationError&&error.status===409);assert.equal(links(f).length,0);assert.equal(f.service.settings().baseUrl,'https://changed.example.test');assert.equal(f.service.settings().lastError,null);assert.equal(f.events.length,0);f.configure({baseUrl:mock.url});const failedRequest=nextRequest(),failed=f.service.sync();await failedRequest;f.service.configure({expectedVersion:f.service.settings().version,baseUrl:'https://changed-again.example.test'});held!.statusCode=503;held!.end('unavailable');await assert.rejects(failed,(error:unknown)=>error instanceof GitlabIntegrationError&&error.status===409);assert.equal(f.service.settings().baseUrl,'https://changed-again.example.test');assert.equal(f.service.settings().lastError,null);assert.equal(links(f).length,0);
  }finally{await mock.close();f.close();}
});

test('sync cannot regress a webhook received during fetch or replace an existing link with an undated snapshot',async()=>{
  const f=fixture();let held:ServerResponse|undefined,announce=()=>{};const nextRequest=()=>new Promise<void>(resolve=>{announce=resolve;});const reached=nextRequest();const mock=await mockServer((path,res)=>{res.setHeader('Content-Type','application/json');if(path.includes('merge_requests')){held=res;announce();}else res.end('[]');});
  try{f.configure({baseUrl:mock.url});const pending=f.service.sync();await reached;f.service.webhook(request(mr({state:'merged',updated_at:new Date(Date.now()-100).toISOString()})));held!.end(JSON.stringify([{id:101,iid:7,title:'NEO-1 과거 조회',state:'opened',source_branch:'feature/NEO-1',updated_at:new Date(Date.now()-10000).toISOString(),web_url:'https://git.example.test/mr/7'}]));assert.equal((await pending).linked,0);assert.equal(links(f)[0].state,'merged');assert.equal(f.events.length,1);
    f.store.db.exec('DELETE FROM gitlab_object_cursors');const secondRequest=nextRequest(),next=f.service.sync();await secondRequest;held!.end(JSON.stringify([{id:101,iid:7,title:'NEO-1 시각 없음',state:'opened',source_branch:'feature/NEO-1',web_url:'https://git.example.test/mr/7'}]));assert.equal((await next).linked,0);assert.equal(links(f)[0].state,'merged');
  }finally{await mock.close();f.close();}
});

test('draft sync preview is read-only and predicts actual MR and exact branch/head pipeline links', async () => {
  const f = fixture();
  const draftToken = `synthetic-preview-${randomUUID()}`;
  const at = new Date(Date.now() - 30_000).toISOString();
  let mrTime = at;
  let mrState = 'opened';
  const calls: { method:string|undefined; token:string|string[]|undefined }[] = [];
  const mock = await mockServer((path, res, req) => {
    calls.push({method:req.method,token:req.headers['private-token']});
    res.setHeader('Content-Type','application/json');
    if (path.includes('/projects/99/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({message:`synthetic remote diagnostic ${draftToken}`}));
    } else if (path.includes('/merge_requests?')) {
      res.end(JSON.stringify([
        {id:101,iid:7,title:'NEO-1 원본 브랜치',description:'synthetic remote body not displayed',source_branch:'feature/reused',sha:'head-a',state:mrState,updated_at:mrTime,web_url:'https://git.example.test/mr/7'},
        {id:102,iid:8,title:'OLD-999 없는 업무',updated_at:at,web_url:'https://git.example.test/mr/8'},
        {id:103,iid:9,title:'NEO-1 URL 없음',updated_at:at},
      ]));
    } else {
      res.end(JSON.stringify([
        {id:201,ref:'feature/reused',sha:'head-a',status:'success',updated_at:at,web_url:'https://git.example.test/pipelines/201'},
        {id:202,ref:'feature/reused',sha:'head-b',status:'failed',updated_at:at,web_url:'https://git.example.test/pipelines/202'},
        {id:203,ref:'fix/NEO-2',sha:'head-c',status:'running',updated_at:at,web_url:'https://git.example.test/pipelines/203'},
      ]));
    }
  });
  try {
    const original = f.configure({token:'synthetic-saved-token'});
    const originalRow = f.store.setting('gitlab');
    const preview = await f.service.previewSync({expectedVersion:original.version,baseUrl:mock.url,projectIds:[42,99],token:draftToken});
    assert.equal(preview.settingsVersion, original.version);
    assert.equal(preview.baseUrl, mock.url);
    assert.deepEqual(preview.projectIds, [42,99]);
    const inaccessible = preview.repositories.find(repo => repo.projectId === 99);
    assert.equal(inaccessible?.status, 'error');
    assert.equal(inaccessible.error?.httpStatus, 404);
    assert.equal(inaccessible.error?.stage, 'merge-requests');
    assert.deepEqual(preview.counts, {mergeRequests:3,pipelines:3,matched:3,unmatched:2,skipped:1,create:3,update:0,unchanged:0});
    assert.deepEqual(new Map(preview.candidates.map(link => [link.objectId,link.issueKey])), new Map([['101','NEO-1'],['201','NEO-1'],['203','NEO-2']]));
    assert.ok(preview.candidates.every(link => link.action === 'create'));
    assert.ok(!JSON.stringify(preview).includes(draftToken));
    assert.ok(!JSON.stringify(preview).includes('synthetic remote body not displayed'));
    assert.deepEqual(f.service.settings(), original);
    assert.deepEqual(f.store.setting('gitlab'), originalRow);
    assert.equal(f.connections.length, 1);
    assert.deepEqual(links(f), []);
    assert.deepEqual(f.events, []);
    assert.ok(calls.length >= 3 && calls.every(call => call.method === 'GET' && call.token === draftToken));

    const saved = f.configure({baseUrl:mock.url,projectIds:[42],token:draftToken});
    const actual = await f.service.sync();
    assert.equal(actual.scanned, 6);
    assert.equal(actual.linked, preview.counts.create);
    assert.deepEqual(new Map(links(f).map(link => [link.id.split(':').at(-2),link.issueId])), new Map([['101','issue-1'],['201','issue-1'],['203','issue-2']]));
    assert.deepEqual(f.events, []);
    mrTime = new Date(Date.now() - 10_000).toISOString();
    mrState = 'merged';
    const refresh = await f.service.previewSync({expectedVersion:saved.version});
    assert.equal(refresh.counts.update, 1);
    assert.equal(refresh.counts.unchanged, 2);
    assert.equal(refresh.candidates.find(link => link.objectId === '101')?.state, 'merged');
    assert.equal(links(f).find(link => link.id.includes(':101:'))?.state, 'opened');
    assert.deepEqual(f.service.settings(), actual.settings);
  } finally { await mock.close(); f.close(); }
});

test('sync commits complete healthy repositories, rolls back audit failures, and retries only saved repositories', async () => {
  const f = fixture();
  const token = `synthetic-retry-${randomUUID()}`;
  const calls: { projectId: number; method: string | undefined; token: string | string[] | undefined }[] = [];
  const audit: [number, number, number][] = [];
  const at = new Date(Date.now() - 30_000).toISOString();
  let unavailable = true;
  const mock = await mockServer((path, res, req) => {
    const projectId = Number(path.split('/')[4]);
    calls.push({ projectId, method: req.method, token: req.headers['private-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (path.includes('/merge_requests?')) {
      res.end(JSON.stringify([{ id: projectId * 10, iid: 1, title: 'NEO-1 MR', state: 'opened', updated_at: at,
        web_url: `https://git.example.test/project-${projectId}/-/merge_requests/1` }]));
    } else if (projectId === 40 && unavailable) {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: `untrusted diagnostic ${token}` }));
    } else res.end('[]');
  });
  try {
    const saved = f.configure({ baseUrl: mock.url, projectIds: [40, 42], token });
    const snapshot = f.store.all('issues');
    await assert.rejects(f.service.sync(() => { throw new Error('mixed audit rollback'); }), (error: unknown) =>
      error instanceof GitlabIntegrationError && error.status === 502);
    assert.equal(f.service.settings().lastSyncAt, null);
    assert.deepEqual(links(f), []);

    calls.length = 0;
    const actual = await f.service.sync((...summary) => audit.push(summary));
    assert.equal(actual.partial, true);
    assert.deepEqual(actual.repositories.map(repo => [repo.projectId, repo.status, repo.counts.create]), [[40, 'error', 0], [42, 'ok', 1]]);
    assert.deepEqual(actual.repositories[0].error, { stage: 'pipelines', httpStatus: 403, message: '파이프라인 조회 중 GitLab HTTP 403 응답' });
    assert.deepEqual(audit, [[1, 1, 1]]);
    assert.deepEqual(calls.map(call => call.projectId), [40, 40, 42, 42]);
    assert.ok(calls.every(call => call.method === 'GET' && call.token === token));
    assert.equal(JSON.stringify(actual).includes(token), false);
    assert.deepEqual(links(f).map(link => link.projectId), [42]);
    assert.ok(actual.settings.lastSyncAt);
    assert.ok(actual.settings.lastError);

    calls.length = 0;
    const reject = (status: number) => (error: unknown) => error instanceof GitlabIntegrationError && error.status === status;
    await assert.rejects(f.service.sync(undefined, { repositoryIds: [40] }), reject(400));
    await assert.rejects(f.service.sync(undefined, { expectedVersion: saved.version, repositoryIds: [99] }), reject(400));
    await assert.rejects(f.service.sync(undefined, { expectedVersion: saved.version - 1, repositoryIds: [40] }), reject(409));
    assert.equal(calls.length, 0);

    const retry = { expectedVersion: saved.version, repositoryIds: [40] };
    await assert.rejects(f.service.sync((...summary) => audit.push(summary), retry), (error: unknown) => {
      if (!(error instanceof GitlabIntegrationError)) return false;
      const details = error.details as GitlabSyncFailure;
      assert.equal(error.status, 502);
      assert.equal(details.settingsVersion, saved.version);
      assert.deepEqual(details.repositories, [actual.repositories[0]]);
      assert.equal(JSON.stringify(details).includes(token), false);
      return true;
    });
    assert.equal(f.service.settings().lastSyncAt, actual.settings.lastSyncAt);
    assert.deepEqual(links(f).map(link => link.projectId), [42]);
    assert.deepEqual(calls.map(call => call.projectId), [40, 40]);
    assert.deepEqual(audit, [[1, 1, 1]]);

    calls.length = 0;
    unavailable = false;
    const recovered = await f.service.sync((...summary) => audit.push(summary), retry);
    assert.equal(recovered.partial, false);
    assert.deepEqual(recovered.repositories.map(repo => [repo.projectId, repo.status, repo.counts.create]), [[40, 'ok', 1]]);
    assert.deepEqual(calls.map(call => call.projectId), [40, 40]);
    assert.deepEqual(links(f).map(link => link.projectId).sort(), [40, 42]);
    assert.equal(recovered.settings.lastError, null);
    assert.equal((await f.service.sync(undefined, retry)).linked, 0);
    assert.deepEqual(f.store.all('issues'), snapshot);
    assert.deepEqual(f.events, []);
  } finally { await mock.close(); f.close(); }
});

test('preview only reuses a saved token on its own URL and rejects settings changed in flight', async () => {
  const f = fixture();
  const token = `synthetic-stored-${randomUUID()}`;
  const seenTokens: (string|string[]|undefined)[] = [];
  let hold = false;
  let held: ServerResponse | undefined;
  let announce = () => {};
  const received = new Promise<void>(resolve => { announce = resolve; });
  const mock = await mockServer((path,res,req) => {
    seenTokens.push(req.headers['private-token']);
    if (hold && path.includes('/merge_requests?')) { held = res; announce(); return; }
    res.end('[]');
  });
  try {
    const first = f.configure({baseUrl:`${mock.url}/old`,token});
    const nextUrl = `${mock.url}/new`;
    await f.service.previewSync({expectedVersion:first.version,baseUrl:`${mock.url}/old/`});
    assert.deepEqual(seenTokens.splice(0), [token,token]);
    await f.service.previewSync({expectedVersion:first.version,baseUrl:nextUrl});
    assert.deepEqual(seenTokens.splice(0), [undefined,undefined]);
    assert.equal(f.service.settings().tokenConfigured, true);

    hold = true;
    const pending = f.service.previewSync({expectedVersion:first.version});
    await received;
    const changed = f.service.configure({expectedVersion:first.version,baseUrl:nextUrl});
    assert.equal(changed.tokenConfigured, false);
    held!.end('[]');
    await assert.rejects(pending, (error:unknown) => error instanceof GitlabIntegrationError && error.status === 409);
    const beforeStale = seenTokens.length;
    await assert.rejects(f.service.previewSync({expectedVersion:first.version}), (error:unknown) => error instanceof GitlabIntegrationError && error.status === 409);
    assert.equal(seenTokens.length, beforeStale);
    assert.deepEqual(f.service.settings(), changed);
    assert.deepEqual(links(f), []);
  } finally { held?.end(); await mock.close(); f.close(); }
});

test('opt-in history preview and sync link keyed branches and explicit recent commits using canonical repository addresses', async () => {
  const f = fixture();
  const token = 'synthetic-history-read-token';
  const branch = 'feature/NEO-1-history';
  const branchSha = commitSha('a'), keyedSha = commitSha('b'), nonKeyedSha = commitSha('c');
  const time = '2026-01-02T03:04:05.000Z';
  const calls: { path: string; method: string | undefined; token: string | string[] | undefined }[] = [];
  const mock = await mockServer((path, res, req) => {
    calls.push({ path, method: req.method, token: req.headers['private-token'] });
    const url = new URL(path, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/forge/api/v4/projects/42') {
      res.end(JSON.stringify({ id: 42, path_with_namespace: 'team/repo', web_url: 'https://git.example.test/wrong/repo' }));
    } else if (url.pathname.endsWith('/repository/branches')) {
      res.end(JSON.stringify([
        { name: branch, commit: { id: branchSha } },
        { name: 'release/ABSENT-3', commit: { id: nonKeyedSha } },
        { name: 'feature/NEO-3?invalid', commit: { id: nonKeyedSha } },
      ]));
    } else if (url.pathname.endsWith('/repository/commits')) {
      res.end(JSON.stringify([
        { id: keyedSha, title: 'NEO-2 existing commit', message: 'NEO-2 existing commit', committed_date: time,
          web_url: 'https://git.example.test/wrong/repo/-/commit/' + keyedSha },
        { id: nonKeyedSha, title: 'Recent commit with no ticket key', message: 'Changes to the default branch', ref: branch, committed_date: time },
        { id: commitSha('d'), title: 'ABSENT-4 no local issue', message: 'ABSENT-4', committed_date: time },
        { id: 'not-a-sha', title: 'NEO-3 invalid commit', message: 'NEO-3', committed_date: time },
      ]));
    } else res.end('[]');
  });
  try {
    const baseUrl = `${mock.url}/forge`;
    const original = f.configure({ baseUrl, token });
    const issues = f.store.all('issues');
    const preview = await f.service.previewSync({ expectedVersion: original.version, includeHistory: true });
    assert.equal(preview.repositories[0].status, 'ok');
    assert.ok(Number(preview.counts.branches) >= 1 && Number(preview.counts.commits) >= 1);
    assert.deepEqual(preview.candidates.map(({ kind, issueKey, action }) => [kind, issueKey, action]).sort(), [
      ['branch', 'NEO-1', 'create'], ['commit', 'NEO-2', 'create'],
    ]);
    assert.deepEqual(f.service.settings(), original);
    assert.deepEqual(links(f), []);
    assert.deepEqual(f.store.all('gitlab_push_cursors'), []);
    assert.ok(calls.every(call => call.method === 'GET' && call.token === token));
    assert.equal(JSON.stringify(preview).includes(token), false);
    assert.ok(calls.some(call => call.path === '/forge/api/v4/projects/42'));
    const requested = calls.map(call => new URL(call.path, mock.url));
    const branches = requested.find(url => url.pathname.endsWith('/repository/branches'));
    const commits = requested.find(url => url.pathname.endsWith('/repository/commits'));
    assert.equal(branches?.searchParams.get('page'), '1');
    assert.equal(branches?.searchParams.get('per_page'), '100');
    assert.equal(commits?.searchParams.get('all'), 'true');
    assert.equal(commits?.searchParams.get('per_page'), '100');

    const applied = await f.service.sync(undefined, { includeHistory: true });
    assert.equal(applied.linked, 2);
    assert.equal(applied.historyCounts?.branches, preview.counts.branches);
    assert.equal(applied.historyCounts?.commits, preview.counts.commits);
    const stored = links(f);
    const storedBranch = stored.find(link => link.kind === 'branch')!;
    const storedCommit = stored.find(link => link.kind === 'commit')!;
    assert.equal(storedBranch.issueId, 'issue-1');
    assert.equal(storedBranch.sourceSha, branchSha);
    assert.equal(storedBranch.sourceBranch, branch);
    assert.equal(storedBranch.branchObservationSource, 'sync');
    assert.equal(storedBranch.webUrl, `${baseUrl}/team/repo/-/tree/${encodeURIComponent(branch)}`);
    assert.equal(storedCommit.issueId, 'issue-2');
    assert.equal(storedCommit.sourceSha, keyedSha);
    assert.ok(!storedCommit.sourceBranch);
    assert.equal(storedCommit.webUrl, `${baseUrl}/team/repo/-/commit/${keyedSha}`);
    assert.equal((await f.service.sync(undefined, { includeHistory: true })).linked, 0);
    assert.deepEqual(links(f), stored);
    assert.deepEqual(f.store.all('issues'), issues);
    assert.deepEqual(f.events, []);

    // Native restore of a read observation must leave the first authenticated push authoritative.
    f.store.transaction(() => f.service.resetForImport(stored));
    const pushed = pushPayload(branch, commitSha('e'), branchSha, [{ id: keyedSha, message: 'NEO-2 existing commit', timestamp: time }]);
    pushed.project.path_with_namespace = 'team/repo';
    const result = f.service.webhook(request(pushed, { 'X-Gitlab-Event': 'Push Hook' }));
    assert.equal(result.linked, 2);
    const afterPush = links(f);
    const authoritative = afterPush.find(link => link.id === storedBranch.id)!;
    assert.equal(authoritative.branchObservationSource, undefined);
    assert.equal(authoritative.sourceSha, branchSha);
    assert.equal(afterPush.find(link => link.id === storedCommit.id)?.sourceBranch, branch);
    assert.equal(afterPush.length, 2);
    assert.deepEqual(f.events, []);
  } finally { await mock.close(); f.close(); }
});

test('an authenticated deletion between reading and saving a GitLab history snapshot stays authoritative', async () => {
  const f = fixture();
  const branch = 'feature/NEO-1-history-race';
  const branchSha = commitSha('a'), zero = commitSha('0');
  const advertisedBranches = [{ name: branch, commit: { id: branchSha } }];
  let held: ServerResponse | undefined;
  let hold = true;
  let announce = () => {};
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const mock = await mockServer((path, res) => {
    const url = new URL(path, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/forge/api/v4/projects/42') {
      res.end(JSON.stringify({ id: 42, path_with_namespace: 'team/repo' }));
    } else if (url.pathname.endsWith('/repository/branches')) {
      if (hold) { held = res; announce(); }
      else res.end(JSON.stringify(advertisedBranches));
    } else res.end('[]');
  });
  try {
    f.configure({ baseUrl: `${mock.url}/forge` });
    const pending = f.service.sync(undefined, { includeHistory: true });
    await Promise.race([entered, pending.then(() => assert.fail('The branch read must be in flight'))]);
    await assert.rejects(f.service.sync(undefined, { includeHistory: true }),
      (error: unknown) => error instanceof GitlabIntegrationError && error.status === 409);
    const initial = pushPayload(branch, zero, branchSha);
    initial.project.path_with_namespace = 'team/repo';
    assert.equal(f.service.webhook(request(initial)).linked, 1);
    const removed = pushPayload(branch, branchSha, zero);
    removed.project.path_with_namespace = 'team/repo';
    assert.equal(f.service.webhook(request(removed)).linked, 1);
    const tombstone = links(f)[0];
    assert.equal(tombstone.state, 'deleted');

    hold = false;
    held!.end(JSON.stringify(advertisedBranches));
    assert.equal((await pending).linked, 0);
    assert.deepEqual(links(f), [tombstone]);
    assert.equal((await f.service.sync(undefined, { includeHistory: true })).linked, 0);
    assert.deepEqual(links(f), [tombstone]);
    assert.deepEqual(f.events, []);
  } finally { held?.end(); await mock.close(); f.close(); }
});

test('GitLab project identity and settings version guard history before writing branch and commit links', async () => {
  const f = fixture();
  const branchSha = commitSha('a');
  let servedProjectId = 99;
  let hold = false;
  let failCommits = false;
  let held: ServerResponse | undefined;
  let announce = () => {};
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const mock = await mockServer((path, res) => {
    const url = new URL(path, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/forge/api/v4/projects/42') {
      res.end(JSON.stringify({ id: servedProjectId, path_with_namespace: 'team/repo' }));
    } else if (url.pathname.endsWith('/repository/branches')) {
      if (hold) { held = res; announce(); }
      else res.end(JSON.stringify([{ name: 'feature/NEO-1-cas', commit: { id: branchSha } }]));
    } else if (url.pathname.endsWith('/repository/commits') && failCommits) {
      res.writeHead(503).end(JSON.stringify({ message: 'synthetic remote body' }));
    } else if (url.pathname.endsWith('/merge_requests')) {
      res.end(JSON.stringify([{ id: 101, iid: 7, title: 'NEO-1 merge request', web_url: 'https://git.example.test/mr/7' }]));
    } else res.end('[]');
  });
  try {
    const original = f.configure({ baseUrl: `${mock.url}/forge` });
    const rejectSync = (status: number) => (error: unknown) => error instanceof GitlabIntegrationError && error.status === status;
    const identityPreview = await f.service.previewSync({ expectedVersion: original.version, includeHistory: true });
    assert.equal(identityPreview.repositories[0].status, 'error');
    assert.equal(identityPreview.repositories[0].error?.stage, 'project');
    assert.deepEqual(identityPreview.candidates, []);
    await assert.rejects(f.service.sync(undefined, { includeHistory: true }), rejectSync(502));
    assert.deepEqual(links(f), []);

    servedProjectId = 42;
    failCommits = true;
    await assert.rejects(f.service.sync(undefined, { includeHistory: true }), rejectSync(502));
    assert.deepEqual(links(f), []);
    assert.deepEqual(f.store.all('gitlab_push_cursors'), []);
    assert.equal(JSON.stringify(f.service.settings()).includes('synthetic remote body'), false);

    failCommits = false;
    hold = true;
    const pending = f.service.sync(undefined, { includeHistory: true });
    const stale = assert.rejects(pending, rejectSync(409));
    await Promise.race([entered, pending.then(() => assert.fail('The history read must be in flight'))]);
    const changed = f.configure({ expectedVersion: original.version, projectIds: [99] });
    held!.end(JSON.stringify([{ name: 'feature/NEO-1-cas', commit: { id: branchSha } }]));
    await stale;
    assert.deepEqual(f.service.settings(), changed);
    assert.deepEqual(links(f), []);
    assert.deepEqual(f.store.all('gitlab_push_cursors'), []);
    assert.deepEqual(f.events, []);
  } finally { held?.end(); await mock.close(); f.close(); }
});
