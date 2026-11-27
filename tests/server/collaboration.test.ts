import test from 'node:test';
import { COLLABORATION_SCHEMA } from '../../shared/collaboration.js';
import { COLLABORATION_BLOCK_ORDER_ROOT, collaborationBlockId, moveCollaborationBlock, projectCollaborationBlocks } from '../../shared/collaboration-block-order.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { TeamNotificationPage } from '../../shared/types.js';
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

async function fixture(dir=mkdtempSync(join(tmpdir(),'donefac-collab-'))){
  const service=createApp({dataDir:dir});const server=service.app.listen(0,'127.0.0.1');service.attachWebSocket(server);await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;let closed=false;
  const request=async(path:string,method='GET',body?:unknown,actorId='user-min')=>{const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Actor-Id':actorId},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as any};};
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

test('block reorder commits projected snapshots while concurrent and offline edits keep their XML identity through backup', async () => {
  const f = await fixture();
  const peers: Peer[] = [];
  const offline = new Y.Doc();
  try {
    const paragraph = (value: string) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
    const created = await f.request('/documents', 'POST', { projectId: 'project-neo', title: '공동 블록 순서 검증',
      content: { type: 'doc', content: [paragraph('첫째'), paragraph('둘째'), paragraph('셋째')] } });
    assert.equal(created.status, 201);
    const { id } = created.data;
    const enabled = await f.request(`/documents/${id}/collaboration/enable`, 'POST', { expectedVersion: created.data.version });
    assert.equal(enabled.status, 200);
    const { epoch } = enabled.data;
    const { p: mover } = await connected(f, id, 'user-min', epoch);
    const { p: writer } = await connected(f, id, 'user-seo', epoch);
    peers.push(mover, writer);
    const baseline = Y.encodeStateAsUpdate(mover.doc);
    Y.applyUpdate(offline, baseline);
    const vector = Y.encodeStateVector(offline);
    const root = mover.doc.getXmlFragment('default');
    const first = root.get(0) as Y.XmlElement, second = root.get(1) as Y.XmlElement;
    const firstId = collaborationBlockId(first), secondId = collaborationBlockId(second);
    assert.ok(firstId && secondId);
    const movedText = (second.get(0) as Y.XmlText);
    const position = Y.createRelativePositionFromTypeIndex(movedText, 1);
    assert.equal(moveCollaborationBlock(root, secondId, firstId, 'before'), true);

    const writerBlock = writer.doc.getXmlFragment('default').get(1) as Y.XmlElement;
    const writerText = writerBlock.get(0) as Y.XmlText;
    writerText.insert(writerText.length, ' 팀 입력');
    const offlineText = (offline.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText;
    offlineText.insert(0, '오프라인 ');
    const move = Y.encodeStateAsUpdate(mover.doc, vector);
    const update = Y.encodeStateAsUpdate(writer.doc, vector);
    await sendUpdate(writer, epoch, update);
    const moved = await sendUpdate(mover, epoch, move);
    assert.deepEqual(moved.document.content.content, [paragraph('둘째 팀 입력'), paragraph('첫째'), paragraph('셋째')]);
    Y.applyUpdate(mover.doc, Buffer.from((await mover.next('update')).update, 'base64'));
    assert.equal(root.get(1), second);
    assert.equal(projectCollaborationBlocks(root)[0], second);
    assert.equal(Y.createAbsolutePositionFromRelativePosition(position, mover.doc)?.type, movedText);

    const { p: reconnect } = await connected(f, id, 'user-jun', epoch);
    peers.push(reconnect);
    const finished = await sendUpdate(reconnect, epoch, Y.encodeStateAsUpdate(offline, vector));
    const expected = [paragraph('오프라인 둘째 팀 입력'), paragraph('첫째'), paragraph('셋째')];
    assert.deepEqual(finished.document.content.content, expected);
    assert.match(finished.document.plainText, /^오프라인 둘째 팀 입력/u);
    const checkpoint = await f.request(`/documents/${id}/checkpoint`, 'POST', { summary: '현재 순서' });
    assert.equal(checkpoint.status, 200);
    assert.deepEqual(checkpoint.data.content.content, expected);

    const backup = await f.request('/export');
    const downgraded = structuredClone(backup.data);
    downgraded.collabStates.find((state: { documentId: string }) => state.documentId === id).schemaVersion = 17;
    assert.equal((await f.request('/import', 'POST', { data: downgraded })).status, 422);
    assert.deepEqual((await f.request(`/documents/${id}/collaboration`)).data.document.content.content, expected);
    const imported = await f.request('/import', 'POST', { data: backup.data });
    assert.equal(imported.status, 200);
    const restored = (await f.request(`/documents/${id}/collaboration`)).data;
    assert.notEqual(restored.epoch, epoch);
    assert.deepEqual(restored.document.content.content, expected);
    const { p: afterRestore } = await connected(f, id, 'user-seo', restored.epoch);
    peers.push(afterRestore);
    const restoredRoot = afterRestore.doc.getXmlFragment('default');
    assert.equal(collaborationBlockId(projectCollaborationBlocks(restoredRoot)[0]), secondId);
  } finally { offline.destroy(); peers.forEach(p => p.dispose()); await f.close(); f.remove(); }
});

test('schema 17 startup upgrade keeps the epoch, XML state and late pending edits', async () => {
  const f = await fixture();
  let reopened: typeof f | undefined;
  let client: Peer | undefined;
  const offline = new Y.Doc();
  try {
    const session = await make(f), id = session.document.id;
    ({ p: client } = await connected(f, id, 'user-min', session.epoch));
    const state = Y.encodeStateAsUpdate(client.doc), vector = Y.encodeStateVector(client.doc);
    Y.applyUpdate(offline, state);
    const paragraph = offline.getXmlFragment('default').get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(0, '설치 전 ');
    client.dispose(); client = undefined;
    await f.close();
    const disk = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
    try { disk.prepare('UPDATE collaboration_documents SET schema_version=17 WHERE document_id=?').run(id); }
    finally { disk.close(); }
    reopened = await fixture(f.dir);
    const upgraded = (await reopened.request(`/documents/${id}/collaboration`)).data;
    assert.equal(upgraded.epoch, session.epoch);
    assert.equal(upgraded.document.version, session.document.version);
    assert.equal(upgraded.schemaVersion, COLLABORATION_SCHEMA);
    ({ p: client } = await connected(reopened, id, 'user-min', upgraded.epoch));
    const ack = await sendUpdate(client, upgraded.epoch, Y.encodeStateAsUpdate(offline, vector));
    assert.equal(ack.document.plainText, '설치 전 원본');
  } finally { offline.destroy(); client?.dispose(); await reopened?.close(); await f.close(); f.remove(); }
});

test('recovery copy retries share one durable document while retaining each actor and recovered generation', async () => {
  const f = await fixture();
  try {
    const { document: source, epoch } = await make(f);
    const path = `/documents/${source.id}/recovery-copy`;
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '전송 전 복구한 본문' }] }] };
    const payload = { epoch, content, labels: ['복구'] };
    assert.equal((await f.request(path, 'POST', [])).status, 400);
    assert.equal((await f.request(path, 'POST', { content })).status, 400);
    assert.equal((await f.request(path, 'POST', { ...payload, content: { type: 'paragraph' } })).status, 422);
    const responses = await Promise.all([f.request(path, 'POST', payload),
      f.request(path, 'POST', { ...payload, content: { ...content, attrs: {} } })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    const document = responses[0].data;
    assert.deepEqual(responses[1].data, document);
    assert.equal(document.plainText, '전송 전 복구한 본문');
    assert.deepEqual(document.labels, ['복구']);
    const original = (await f.request(`/documents/${source.id}/collaboration`)).data.document;
    assert.equal(original.plainText, '원본');
    assert.equal((await f.request(`/documents/${document.id}/revisions`)).data.length, 1);

    const edited = await f.request(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: '팀이 정리한 사본' });
    assert.equal(edited.status, 200);
    const trash = await f.request(`/documents/${document.id}`, 'DELETE');
    assert.equal(trash.status, 200);
    assert.equal((await f.request(path, 'POST', payload)).status, 409);
    assert.equal((await f.request(`/trash/${trash.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    const backup = await f.request('/export');
    assert.equal((await f.request('/import', 'POST', { data: backup.data })).status, 200);
    const replay = await f.request(path, 'POST', { content, epoch, labels: [] });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.id, document.id);
    assert.equal(replay.data.title, edited.data.title);
    assert.deepEqual(replay.data.labels, ['복구']);

    const [teammate, otherEpoch] = await Promise.all([
      f.request(path, 'POST', payload, 'user-seo'), f.request(path, 'POST', { ...payload, epoch: randomUUID() }),
    ]);
    assert.equal(teammate.status, 201);
    assert.equal(otherEpoch.status, 201);
    assert.equal(new Set([document.id, teammate.data.id, otherEpoch.data.id]).size, 3);

    assert.equal((await f.request(`/documents/${source.id}`, 'DELETE')).status, 200);
    const recoveredFromTrash = await f.request(path, 'POST', { ...payload, epoch: randomUUID() });
    assert.equal(recoveredFromTrash.status, 201);
    assert.equal(recoveredFromTrash.data.projectId, source.projectId);
    assert.equal(recoveredFromTrash.data.plainText, document.plainText);

    const key = await f.request('/api-keys', 'POST', { name: '복구 사본 정책 확인', access: 'write', projectIds: null });
    assert.equal(key.status, 201);
    const scoped = await fetch(`${f.base}/api/v1${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${key.data.token}`,
    }, body: JSON.stringify(payload) });
    assert.equal(scoped.status, 403);
    await scoped.body?.cancel();
  } finally { await f.close(); f.remove(); }
});

test('two clients merge concurrent text without duplicate initialization; ACK commits survive restart and checkpoints are immutable',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof fixture>>|undefined;const peers:Peer[]=[];
  try{
    const session=await make(f),id=session.document.id,epoch=session.epoch;
    const watcher='user-seo';
    const subscribed=await f.request(`/notifications/subscriptions/document/${id}`,'PUT',{subscribed:true},watcher);
    assert.equal(subscribed.status,200);
    assert.deepEqual(subscribed.data,{subscribed:true});
    async function watchNotifications(){
      const result=await f.request('/notifications','GET',undefined,watcher);
      assert.equal(result.status,200);
      return (result.data as TeamNotificationPage).items.filter(item=>item.targetId===id);
    }
    const again=await f.request(`/documents/${id}/collaboration/enable`,'POST',{expectedVersion:1});assert.equal(again.data.epoch,epoch);assert.equal(again.data.document.version,session.document.version);
    const a=await connected(f,id,'user-min',epoch),b=await connected(f,id,'user-seo',epoch);peers.push(a.p,b.p);
    assert.equal(a.welcome.peers.length,1);assert.equal(b.welcome.peers.length,2);assert.equal(text(a.p).toString(),'원본');assert.equal(text(b.p).toString(),'원본');
    const va=Y.encodeStateVector(a.p.doc),vb=Y.encodeStateVector(b.p.doc);text(a.p).insert(0,'A');text(b.p).insert(0,'B');const ua=Y.encodeStateAsUpdate(a.p.doc,va),ub=Y.encodeStateAsUpdate(b.p.doc,vb);
    const requestA=randomUUID();const ackAPromise=sendUpdate(a.p,epoch,ua,requestA),ackBPromise=sendUpdate(b.p,epoch,ub);const [ackA,ackB]=await Promise.all([ackAPromise,ackBPromise]);assert.equal(Math.max(ackA.document.version,ackB.document.version),session.document.version+2);
    const remoteA=await a.p.next('update'),remoteB=await b.p.next('update');Y.applyUpdate(a.p.doc,Buffer.from(remoteA.update,'base64'));Y.applyUpdate(b.p.doc,Buffer.from(remoteB.update,'base64'));assert.deepEqual(content(a.p),content(b.p));assert.match(text(a.p).toString(),/^(?:AB|BA)원본$/);
    const snapshot=(await f.request('/workspace')).data.documents.find((d:any)=>d.id===id);assert.deepEqual(snapshot.content,content(a.p));const version=snapshot.version;
    const duplicate=await sendUpdate(a.p,epoch,ua,requestA);assert.equal(duplicate.document.version,version);const repeated=await sendUpdate(a.p,epoch,ua);assert.equal(repeated.document.version,version);
    const disk=new DatabaseSync(join(f.dir,'donefac.sqlite'),{readOnly:true});const row=disk.prepare('SELECT json FROM documents WHERE id=?').get(id) as {json:string};assert.equal(JSON.parse(row.json).version,version);const state=disk.prepare('SELECT state FROM collaboration_documents WHERE document_id=?').get(id) as {state:Uint8Array};const durable=new Y.Doc();Y.applyUpdate(durable,state.state);assert.deepEqual(yDocToProsemirrorJSON(durable,'default'),snapshot.content);durable.destroy();disk.close();
    const before=(await f.request(`/documents/${id}/revisions`)).data;assert.equal(before.length,1);
    assert.deepEqual(await watchNotifications(),[]);
    const checkpoint=await f.request(`/documents/${id}/checkpoint`,'POST',{summary:'검토 가능한 이력'});assert.equal(checkpoint.status,200);assert.equal(checkpoint.data.version,version);assert.deepEqual(checkpoint.data.content,snapshot.content);
    const notified=await watchNotifications();
    assert.deepEqual(notified.map(({kind,actorId,recipientId})=>({kind,actorId,recipientId})),[
      {kind:'document-updated',actorId:'user-min',recipientId:watcher},
    ]);
    assert.equal((await f.request(`/documents/${id}/checkpoint`,'POST',{})).data.id,checkpoint.data.id);
    assert.deepEqual(await watchNotifications(),notified);
    const metadata=await f.request(`/documents/${id}`,'PATCH',{expectedVersion:version,title:'함께 편집한 문서'});assert.equal(metadata.status,200);assert.equal((await f.request(`/documents/${id}/collaboration`)).data.epoch,epoch);const metaBroadcast=await a.p.next('update');assert.equal(metaBroadcast.document.title,'함께 편집한 문서');assert.deepEqual(Buffer.from(metaBroadcast.update,'base64'),Buffer.from([0,0]));
    const localState=Y.encodeStateAsUpdate(a.p.doc);await f.close();reopened=await fixture(f.dir);const restart=await connected(reopened,id,'user-jun',epoch,{state:localState});peers.push(restart.p);assert.equal(restart.welcome.document.title,'함께 편집한 문서');assert.equal(restart.welcome.document.version,version+1);assert.deepEqual(content(restart.p),snapshot.content);assert.equal(text(restart.p).toString(),text(a.p).toString());
    const history=(await reopened.request(`/documents/${id}/revisions`)).data;assert.deepEqual(history.find((r:any)=>r.id===checkpoint.data.id).content,checkpoint.data.content);
  }finally{peers.forEach(p=>p.dispose());if(reopened)await reopened.close();await f.close();f.remove();}
});

test('metadata-only document label edits reach live peers and watchers without resetting the body', async () => {
  const f = await fixture(); let peer: Peer | undefined;
  try {
    const { document, epoch } = await make(f), path = `/documents/${document.id}`, watcher = 'user-seo';
    const watch = await f.request(`/notifications/subscriptions/document/${document.id}`, 'PUT', { subscribed: true }, watcher);
    assert.equal(watch.status, 200);
    ({ p: peer } = await connected(f, document.id, watcher, epoch));

    const labeled = await f.request(path, 'PATCH', { expectedVersion: document.version, labels: [' Release '] });
    assert.equal(labeled.status, 200);
    const changed = await peer.next('update');
    assert.equal(changed.epoch, epoch);
    assert.deepEqual(changed.document.labels, ['Release']);
    assert.deepEqual(changed.document.content, document.content);
    assert.deepEqual(Buffer.from(changed.update, 'base64'), Buffer.from([0, 0]));
    assert.deepEqual(content(peer), document.content);

    const unchanged = await f.request(path, 'PATCH', { expectedVersion: labeled.data.version, labels: ['Release', 'release'] });
    assert.equal(unchanged.status, 200);
    assert.equal((await peer.next('update')).epoch, epoch);
    const notifications = (await f.request('/notifications', 'GET', undefined, watcher)).data as TeamNotificationPage;
    assert.deepEqual(notifications.items.filter(item => item.targetId === document.id).map(item => item.kind), ['document-updated']);

    const state = Y.encodeStateVector(peer.doc);
    text(peer).insert(0, '추가 ');
    const edited = await sendUpdate(peer, epoch, Y.encodeStateAsUpdate(peer.doc, state));
    assert.deepEqual(edited.document.labels, ['Release']);
    assert.equal(edited.document.plainText, '추가 원본');
    const session = await f.request(`${path}/collaboration`);
    assert.equal(session.data.epoch, epoch);
    assert.deepEqual(session.data.document.labels, ['Release']);
  } finally { peer?.dispose(); await f.close(); f.remove(); }
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
    for(const mutate of [(d:Y.Doc)=>d.getXmlFragment('default').push([new Y.XmlElement('unsupportedWidget')]),(d:Y.Doc)=>(d.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('unknownAttribute','bad'),(d:Y.Doc)=>d.getMap('other-root').set('bad',true),(d:Y.Doc)=>d.getMap(COLLABORATION_BLOCK_ORDER_ROOT).set('invalid',true),(d:Y.Doc)=>d.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push(['invalid'])]){
      const bad=new Y.Doc();Y.applyUpdate(bad,initial);mutate(bad);a.p.send({type:'update',epoch:s.epoch,requestId:randomUUID(),update:Buffer.from(Y.encodeStateAsUpdate(bad,vector)).toString('base64')});assert.equal((await a.p.next('error')).code,'INVALID_SCHEMA');bad.destroy();
    }
    const unchanged=(await f.request(`/documents/${s.document.id}/collaboration`)).data;assert.equal(unchanged.document.version,s.document.version);assert.equal(unchanged.document.plainText,'원본');
    const wrong=await peer(f,s.document.id,'user-seo',s.epoch,{schemaVersion:COLLABORATION_SCHEMA+1});peers.push(wrong);assert.equal((await wrong.next('error')).code,'SCHEMA_MISMATCH');assert.equal(await wrong.closed,4400);
    text(a.p).insert(0,'정상');const accepted=await sendUpdate(a.p,s.epoch,Y.encodeStateAsUpdate(a.p.doc,vector));assert.equal(accepted.document.plainText,'정상원본');assert.equal(accepted.document.version,s.document.version+1);
  }finally{peers.forEach(p=>p.dispose());await f.close();f.remove();}
});

test('current peers commit an issue summary and reject a newly missing saved view atomically', async () => {
  const f = await fixture();
  const peers: Peer[] = [];
  try {
    const session = await make(f);
    const {id} = session.document;
    const writer = await connected(f,id,'user-min',session.epoch);
    const reader = await connected(f,id,'user-seo',session.epoch);
    peers.push(writer.p,reader.p);
    const vector = Y.encodeStateVector(writer.p.doc);
    const summary = new Y.XmlElement('issueSummary');
    summary.setAttribute('projectId','project-neo');
    summary.setAttribute('label','공동 회의 업무 현황');
    summary.setAttribute('groupBy','assignee');
    writer.p.doc.getXmlFragment('default').push([summary]);
    const accepted = await sendUpdate(writer.p,session.epoch,Y.encodeStateAsUpdate(writer.p.doc,vector));
    assert.equal(accepted.document.version,session.document.version+1);
    assert.deepEqual(accepted.document.content.content.at(-1), {
      type:'issueSummary', attrs:{projectId:'project-neo',savedViewId:null,label:'공동 회의 업무 현황',groupBy:'assignee'},
    });
    const replicated = await reader.p.next('update');
    Y.applyUpdate(reader.p.doc,Buffer.from(replicated.update,'base64'));
    assert.deepEqual(content(reader.p),content(writer.p));

    const previous = Y.encodeStateVector(writer.p.doc);
    summary.setAttribute('savedViewId','gone-while-editing');
    writer.p.send({
      type:'update', epoch:session.epoch, requestId:randomUUID(),
      update:Buffer.from(Y.encodeStateAsUpdate(writer.p.doc,previous)).toString('base64'),
    });
    assert.equal((await writer.p.next('error')).code,'REFERENCE_NOT_FOUND');
    const persisted = await f.request(`/documents/${id}/collaboration`);
    assert.deepEqual(persisted.data.document,accepted.document);
  } finally { peers.forEach(p=>p.dispose()); await f.close(); f.remove(); }
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
    const live=await connected(f,id,'user-jun',reset.epoch);peers.push(live.p);const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);assert.ok(exported.collabStates.some((state:any)=>state.documentId===id));assert.ok(Array.isArray(exported.workflows));assert.ok(Array.isArray(exported.savedViews));
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
