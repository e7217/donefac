import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import { createServer,type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Request } from 'express';
import { Store } from '../../server/store.js';
import { seed } from '../../server/seed.js';
import { GitlabIntegrationService,GitlabIntegrationError } from '../../server/gitlab-integration.js';
import type { AutomationEvent,GitlabLink,GitlabSettings } from '../../shared/types.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'teamspace-gitlab-')),store=new Store(dir);seed(store);const events:AutomationEvent[]=[],connections:{before:GitlabSettings;after:GitlabSettings}[]=[];let rejectEvent=false;const service=new GitlabIntegrationService(store,{processEvent:event=>{if(rejectEvent)throw new Error('audit rollback');events.push(event);return[];},onConnectionChanged:(before,after)=>{connections.push({before,after});return 0;}});return{store,service,events,connections,rejectEvent:(value:boolean)=>{rejectEvent=value;},configure:(values:Record<string,unknown>={})=>service.configure({expectedVersion:service.settings().version,baseUrl:'https://git.example.test',projectIds:[42],webhookSecret:'legacy-secret',...values}),close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};}
function request(body:unknown,headers:Record<string,string>={},raw=Buffer.from(JSON.stringify(body))):Request{const values=Object.fromEntries(Object.entries({'x-gitlab-token':'legacy-secret','x-gitlab-event-uuid':randomUUID(),...headers}).map(([key,value])=>[key.toLowerCase(),value]));return{body,headers:values,gitlabRawBody:raw,header:(name:string)=>values[name.toLowerCase()]} as unknown as Request;}
function mr(values:Record<string,unknown>={}){return{object_kind:'merge_request',project:{id:42,web_url:'https://git.example.test/team/repo'},object_attributes:{id:101,iid:7,title:'NEO-1 동작 확인',description:'설명',source_branch:'feature/NEO-1',last_commit:{id:'sha-a'},state:'merged',action:'merge',updated_at:new Date(Date.now()-1000).toISOString(),url:'https://git.example.test/team/repo/-/merge_requests/7',...values}};}
function pipeline(values:Record<string,unknown>={}){return{object_kind:'pipeline',project:{id:42,web_url:'https://git.example.test/team/repo'},object_attributes:{id:200,ref:'feature/NEO-1',sha:'sha-a',status:'success',finished_at:new Date(Date.now()-1000).toISOString(),...values}};}
function rejects(action:()=>unknown,status=400){assert.throws(action,(error:unknown)=>error instanceof GitlabIntegrationError&&error.status===status);}
const links=(f:ReturnType<typeof fixture>)=>f.store.all<GitlabLink>('gitlab_links');
async function mockServer(handler:(path:string,response:ServerResponse)=>void){const server=createServer((req,res)=>handler(req.url||'',res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No mock address');return{url:`http://127.0.0.1:${address.port}`,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));}};}

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
