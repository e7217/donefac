import test from 'node:test';
import { COLLABORATION_SCHEMA } from '../../shared/collaboration.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { createApp } from '../../server/app.js';
import { MAX_COLLABORATION_UPDATE } from '../../server/collaboration.js';

async function fixture(dir=mkdtempSync(join(tmpdir(),'teamspace-collab-'))){
  const service=createApp({dataDir:dir});const server=service.app.listen(0,'127.0.0.1');service.attachWebSocket(server);await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;let closed=false;
  const request=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Actor-Id':'user-min'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as any};};
  return{dir,base,request,close:async()=>{if(closed)return;closed=true;service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));},remove:()=>rmSync(dir,{recursive:true,force:true})};
}
class Peer {
  ws:WebSocket;messages:any[]=[];waiters:{predicate:(value:any)=>boolean;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
  doc=new Y.Doc();closed:Promise<number>;
  constructor(url:string){
    this.ws=new WebSocket(url);this.ws.on('error',()=>{});
    this.ws.on('message',raw=>{const value=JSON.parse(raw.toString());const index=this.waiters.findIndex(waiter=>waiter.predicate(value));if(index<0)this.messages.push(value);else{const waiter=this.waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(value);}});
    this.closed=new Promise(resolve=>this.ws.once('close',code=>resolve(code)));
  }
  send(value:unknown){this.ws.send(JSON.stringify(value));}
  next(type:string,requestId?:string){return this.take(value=>value.type===type&&(requestId===undefined||value.requestId===requestId));}
  take(predicate:(value:any)=>boolean):Promise<any>{
    const index=this.messages.findIndex(predicate);if(index>=0)return Promise.resolve(this.messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{this.waiters=this.waiters.filter(value=>value!==waiter);reject(new Error(`WS message timeout; queued=${JSON.stringify(this.messages)}`));},5000)};waiter.timer.unref();this.waiters.push(waiter);});
  }
  dispose(){this.ws.terminate();this.doc.destroy();for(const waiter of this.waiters){clearTimeout(waiter.timer);}this.waiters=[];}
}
async function peer(f:Awaited<ReturnType<typeof fixture>>,documentId:string,actorId:string,epoch:string|null,options:{schemaVersion?:number;state?:Uint8Array}={}){
  const p=new Peer(`${f.base.replace('http:','ws:')}/api/collaboration?${new URLSearchParams({documentId,actorId})}`);await once(p.ws,'open');
  if(options.state)Y.applyUpdate(p.doc,options.state);
  p.send({type:'hello',epoch,schemaVersion:options.schemaVersion??COLLABORATION_SCHEMA,stateVector:Buffer.from(Y.encodeStateVector(p.doc)).toString('base64')});
  return p;
}
async function connected(f:Awaited<ReturnType<typeof fixture>>,documentId:string,actorId:string,epoch:string|null,options:{state?:Uint8Array}={}){
  const p=await peer(f,documentId,actorId,epoch,options),welcome=await p.next('welcome');Y.applyUpdate(p.doc,Buffer.from(welcome.update,'base64'));return{p,welcome};
}
async function make(f:Awaited<ReturnType<typeof fixture>>){
  const created=await f.request('/documents','POST',{projectId:'project-neo',title:'공동 편집 검증',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'원본'}]}]}});assert.equal(created.status,201);
  const disabled=await f.request(`/documents/${created.data.id}/collaboration`);assert.equal(disabled.data.enabled,false);
  const enabled=await f.request(`/documents/${created.data.id}/collaboration/enable`,'POST',{expectedVersion:created.data.version});assert.equal(enabled.status,200);assert.equal(enabled.data.enabled,true);return enabled.data;
}
function text(p:Peer){return(p.doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;}
function content(p:Peer){return yDocToProsemirrorJSON(p.doc,'default');}
async function sendUpdate(p:Peer,epoch:string,update:Uint8Array,requestId=randomUUID()){
  p.send({type:'update',epoch,requestId,update:Buffer.from(update).toString('base64')});return p.next('ack',requestId);
}

test('two clients merge concurrent text without duplicate initialization; ACK commits survive restart and checkpoints are immutable',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof fixture>>|undefined;const peers:Peer[]=[];
  try{
    const session=await make(f),id=session.document.id,epoch=session.epoch;
    const again=await f.request(`/documents/${id}/collaboration/enable`,'POST',{expectedVersion:1});assert.equal(again.data.epoch,epoch);assert.equal(again.data.document.version,session.document.version);
    const a=await connected(f,id,'user-min',epoch),b=await connected(f,id,'user-seo',epoch);peers.push(a.p,b.p);
    assert.equal(a.welcome.peers.length,1);assert.equal(b.welcome.peers.length,2);assert.equal(text(a.p).toString(),'원본');assert.equal(text(b.p).toString(),'원본');
    const va=Y.encodeStateVector(a.p.doc),vb=Y.encodeStateVector(b.p.doc);text(a.p).insert(0,'A');text(b.p).insert(0,'B');const ua=Y.encodeStateAsUpdate(a.p.doc,va),ub=Y.encodeStateAsUpdate(b.p.doc,vb);
    const requestA=randomUUID();const ackAPromise=sendUpdate(a.p,epoch,ua,requestA),ackBPromise=sendUpdate(b.p,epoch,ub);const [ackA,ackB]=await Promise.all([ackAPromise,ackBPromise]);assert.equal(Math.max(ackA.document.version,ackB.document.version),session.document.version+2);
    const remoteA=await a.p.next('update'),remoteB=await b.p.next('update');Y.applyUpdate(a.p.doc,Buffer.from(remoteA.update,'base64'));Y.applyUpdate(b.p.doc,Buffer.from(remoteB.update,'base64'));assert.deepEqual(content(a.p),content(b.p));assert.match(text(a.p).toString(),/^(?:AB|BA)원본$/);
    const snapshot=(await f.request('/workspace')).data.documents.find((d:any)=>d.id===id);assert.deepEqual(snapshot.content,content(a.p));const version=snapshot.version;
    const duplicate=await sendUpdate(a.p,epoch,ua,requestA);assert.equal(duplicate.document.version,version);const repeated=await sendUpdate(a.p,epoch,ua);assert.equal(repeated.document.version,version);
    const disk=new DatabaseSync(join(f.dir,'teamspace.sqlite'),{readOnly:true});const row=disk.prepare('SELECT json FROM documents WHERE id=?').get(id) as {json:string};assert.equal(JSON.parse(row.json).version,version);const state=disk.prepare('SELECT state FROM collaboration_documents WHERE document_id=?').get(id) as {state:Uint8Array};const durable=new Y.Doc();Y.applyUpdate(durable,state.state);assert.deepEqual(yDocToProsemirrorJSON(durable,'default'),snapshot.content);durable.destroy();disk.close();
    const before=(await f.request(`/documents/${id}/revisions`)).data;assert.equal(before.length,1);
    const checkpoint=await f.request(`/documents/${id}/checkpoint`,'POST',{summary:'검토 가능한 이력'});assert.equal(checkpoint.status,200);assert.equal(checkpoint.data.version,version);assert.deepEqual(checkpoint.data.content,snapshot.content);
    assert.equal((await f.request(`/documents/${id}/checkpoint`,'POST',{})).data.id,checkpoint.data.id);
    const metadata=await f.request(`/documents/${id}`,'PATCH',{expectedVersion:version,title:'함께 편집한 문서'});assert.equal(metadata.status,200);assert.equal((await f.request(`/documents/${id}/collaboration`)).data.epoch,epoch);const metaBroadcast=await a.p.next('update');assert.equal(metaBroadcast.document.title,'함께 편집한 문서');assert.deepEqual(Buffer.from(metaBroadcast.update,'base64'),Buffer.from([0,0]));
    const localState=Y.encodeStateAsUpdate(a.p.doc);await f.close();reopened=await fixture(f.dir);const restart=await connected(reopened,id,'user-jun',epoch,{state:localState});peers.push(restart.p);assert.equal(restart.welcome.document.title,'함께 편집한 문서');assert.equal(restart.welcome.document.version,version+1);assert.deepEqual(content(restart.p),snapshot.content);assert.equal(text(restart.p).toString(),text(a.p).toString());
    const history=(await reopened.request(`/documents/${id}/revisions`)).data;assert.deepEqual(history.find((r:any)=>r.id===checkpoint.data.id).content,checkpoint.data.content);
  }finally{peers.forEach(p=>p.dispose());if(reopened)await reopened.close();await f.close();f.remove();}
});

test('out-of-order Yjs updates persist pending structs and resolve when missing predecessors arrive',async()=>{
  const f=await fixture();let p:Peer|undefined;
  try{
    const s=await make(f);({p}=await connected(f,s.document.id,'user-min',s.epoch));const updates:Uint8Array[]=[];p.doc.on('update',value=>updates.push(value));text(p).insert(0,'X');text(p).insert(1,'Y');assert.equal(updates.length,2);
    await sendUpdate(p,s.epoch,updates[1]);assert.equal((await f.request(`/documents/${s.document.id}/collaboration`)).data.document.plainText,'원본');
    await sendUpdate(p,s.epoch,updates[0]);assert.equal((await f.request(`/documents/${s.document.id}/collaboration`)).data.document.plainText,'XY원본');
  }finally{p?.dispose();await f.close();f.remove();}
});

test('a ready idle collaboration peer stays connected beyond the initial hello deadline',async()=>{
  const f=await fixture();let p:Peer|undefined;
  try{
    const s=await make(f);({p}=await connected(f,s.document.id,'user-min',s.epoch));
    await new Promise(resolve=>setTimeout(resolve,11000));
    assert.equal(p.ws.readyState,WebSocket.OPEN);p.send({type:'ping'});assert.equal((await p.next('pong')).type,'pong');
  }finally{p?.dispose();await f.close();f.remove();}
});

test('invalid, oversized and unsupported-schema edits never mutate the canonical room; a healthy update still works',async()=>{
  const f=await fixture();const peers:Peer[]=[];
  try{
    const s=await make(f),a=await connected(f,s.document.id,'user-min',s.epoch);peers.push(a.p);const initial=Y.encodeStateAsUpdate(a.p.doc),vector=Y.encodeStateVector(a.p.doc);
    const invalidBinary=randomUUID();a.p.send({type:'update',epoch:s.epoch,requestId:invalidBinary,update:Buffer.from([255,1]).toString('base64')});assert.equal((await a.p.next('error')).code,'INVALID_UPDATE');
    a.p.send({type:'update',epoch:s.epoch,requestId:randomUUID(),update:Buffer.alloc(MAX_COLLABORATION_UPDATE+1).toString('base64')});assert.equal((await a.p.next('error')).code,'UPDATE_TOO_LARGE');
    for(const mutate of [(d:Y.Doc)=>d.getXmlFragment('default').push([new Y.XmlElement('unsupportedWidget')]),(d:Y.Doc)=>(d.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('unknownAttribute','bad'),(d:Y.Doc)=>d.getMap('other-root').set('bad',true)]){
      const bad=new Y.Doc();Y.applyUpdate(bad,initial);mutate(bad);a.p.send({type:'update',epoch:s.epoch,requestId:randomUUID(),update:Buffer.from(Y.encodeStateAsUpdate(bad,vector)).toString('base64')});assert.equal((await a.p.next('error')).code,'INVALID_SCHEMA');bad.destroy();
    }
    const unchanged=(await f.request(`/documents/${s.document.id}/collaboration`)).data;assert.equal(unchanged.document.version,s.document.version);assert.equal(unchanged.document.plainText,'원본');
    const wrong=await peer(f,s.document.id,'user-seo',s.epoch,{schemaVersion:COLLABORATION_SCHEMA+1});peers.push(wrong);assert.equal((await wrong.next('error')).code,'SCHEMA_MISMATCH');assert.equal(await wrong.closed,4400);
    text(a.p).insert(0,'정상');const accepted=await sendUpdate(a.p,s.epoch,Y.encodeStateAsUpdate(a.p.doc,vector));assert.equal(accepted.document.plainText,'정상원본');assert.equal(accepted.document.version,s.document.version+1);
  }finally{peers.forEach(p=>p.dispose());await f.close();f.remove();}
});

test('restore and native import rotate epochs and reject old offline edits; rejected imports preserve live rooms',async()=>{
  const f=await fixture();const peers:Peer[]=[];
  try{
    const s=await make(f),id=s.document.id;const a=await connected(f,id,'user-min',s.epoch);peers.push(a.p);const checkpoint=(await f.request(`/documents/${id}/checkpoint`,'POST',{})).data;
    const vector=Y.encodeStateVector(a.p.doc);text(a.p).insert(0,'편집');const ack=await sendUpdate(a.p,s.epoch,Y.encodeStateAsUpdate(a.p.doc,vector));
    const offlineVector=Y.encodeStateVector(a.p.doc);text(a.p).insert(0,'오프라인');const offline=Y.encodeStateAsUpdate(a.p.doc,offlineVector);
    const restored=await f.request(`/documents/${id}/restore`,'POST',{revisionId:checkpoint.id,expectedVersion:ack.document.version});assert.equal(restored.status,200);assert.equal(restored.data.plainText,'원본');const reset=await a.p.next('reset');assert.notEqual(reset.epoch,s.epoch);assert.equal(await a.p.closed,4409);
    const stale=await peer(f,id,'user-min',s.epoch);peers.push(stale);assert.equal((await stale.next('reset')).epoch,reset.epoch);assert.equal(await stale.closed,4409);
    const fresh=await connected(f,id,'user-seo',reset.epoch);peers.push(fresh.p);assert.equal(text(fresh.p).toString(),'원본');
    fresh.p.send({type:'update',epoch:s.epoch,requestId:randomUUID(),update:Buffer.from(offline).toString('base64')});assert.equal((await fresh.p.next('reset')).epoch,reset.epoch);assert.equal(await fresh.p.closed,4409);
    const live=await connected(f,id,'user-jun',reset.epoch);peers.push(live.p);const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,7);assert.ok(exported.collabStates.some((state:any)=>state.documentId===id));assert.ok(Array.isArray(exported.workflows));assert.ok(Array.isArray(exported.savedViews));
    const mismatch=structuredClone(exported);mismatch.documents.find((d:any)=>d.id===id).content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'불일치 내용'}]}]};const rejected=await f.request('/import','POST',{data:mismatch});assert.equal(rejected.status,422);assert.equal((await f.request(`/documents/${id}/collaboration`)).data.epoch,reset.epoch);live.p.send({type:'ping'});assert.equal((await live.p.next('pong')).type,'pong');
    const imported=await f.request('/import','POST',{data:exported});assert.equal(imported.status,200);const importedReset=await live.p.next('reset');assert.notEqual(importedReset.epoch,reset.epoch);assert.equal(await live.p.closed,4409);const latest=(await f.request(`/documents/${id}/collaboration`)).data;assert.equal(latest.epoch,importedReset.epoch);assert.equal(latest.document.plainText,'원본');assert.ok(latest.document.version>restored.data.version);
    const old=await peer(f,id,'user-min',reset.epoch);peers.push(old);assert.equal((await old.next('reset')).epoch,latest.epoch);assert.equal(await old.closed,4409);
    const schema3=structuredClone(exported);schema3.schemaVersion=3;delete schema3.planningItems;
    for(const issue of schema3.issues){delete issue.cycleId;delete issue.moduleId;delete issue.releaseId;}
    assert.equal((await f.request('/import','POST',{data:schema3})).status,200);
    const legacySession=(await f.request(`/documents/${id}/collaboration`)).data;assert.equal(legacySession.enabled,true);assert.notEqual(legacySession.epoch,latest.epoch);
    const legacyPeer=await connected(f,id,'user-min',legacySession.epoch);peers.push(legacyPeer.p);assert.equal(text(legacyPeer.p).toString(),'원본');
    const legacyWorkspace=(await f.request('/workspace')).data;assert.equal(legacyWorkspace.workflows.length,exported.workflows.length);assert.equal(legacyWorkspace.savedViews.length,exported.savedViews.length);assert.ok(legacyWorkspace.planningItems.length>0);
  }finally{peers.forEach(p=>p.dispose());await f.close();f.remove();}
});
