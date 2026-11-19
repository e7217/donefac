import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc,yDocToProsemirrorJSON } from 'y-prosemirror';
import { Store } from '../../server/store.js';
import { DocumentContentService,DocumentContentError } from '../../server/document-content.js';
import { CollaborationService,CollaborationError } from '../../server/collaboration.js';
import { createEditorSchema } from '../../shared/editor-schema.js';
import { COLLABORATION_SCHEMA,type CollaborationServerMessage } from '../../shared/collaboration.js';
import type { DocPage,Issue,RichContent } from '../../shared/types.js';

const now='2026-11-16T00:00:00.000Z',schema=createEditorSchema();
const body=(text='원본'):RichContent=>({type:'doc',content:[{type:'paragraph',content:text?[{type:'text',text}]:undefined}]});
const ref=(type:string,id:string,label=''):RichContent=>({type,attrs:{[type==='issueReference'?'issueId':'documentId']:id,label}});
const issueList=():RichContent=>({type:'issueList',attrs:{projectId:'project-test',savedViewId:null,label:'검증할 업무'}});
const document=(id:string,content=body()):DocPage=>({id,projectId:'project-test',parentId:null,title:id,content,plainText:'원본',icon:'📄',status:'draft',version:1,authorId:'user-test',createdAt:now,updatedAt:now});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'teamspace-document-content-')),store=new Store(dir);store.put('users',{id:'user-test',name:'문서 담당',email:'doc@example.test',color:'#668899'});store.put('projects',{id:'project-test',key:'DOC',name:'문서',description:'',color:'#668899',createdAt:now});
  for(const id of ['doc-a','doc-b','doc-c'])store.put('documents',document(id));
  const contents=new DocumentContentService(store);return{store,contents,close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
function rejects(action:()=>unknown,code='INVALID_SCHEMA'){assert.throws(action,(error:unknown)=>error instanceof DocumentContentError&&error.code===code);}
function encode(content:RichContent){const doc=prosemirrorJSONToYDoc(schema,content,'default');try{return Buffer.from(Y.encodeStateAsUpdate(doc));}finally{doc.destroy();}}
function insertState(store:Store,id:string,content:RichContent,version=1,epoch=randomUUID(),bytes=encode(content)){
  store.db.prepare('INSERT INTO collaboration_documents(document_id,epoch,schema_version,state,updated_at) VALUES(?,?,?,?,?)').run(id,epoch,version,bytes,now);return{epoch,bytes};
}
class Peer{
  ws:WebSocket;queue:CollaborationServerMessage[]=[];waiters:{type:CollaborationServerMessage['type'];resolve:(message:CollaborationServerMessage)=>void}[]=[];
  constructor(url:string){this.ws=new WebSocket(url);this.ws.on('message',raw=>{const message=JSON.parse(raw.toString()) as CollaborationServerMessage;const index=this.waiters.findIndex(waiter=>waiter.type===message.type);if(index>=0)this.waiters.splice(index,1)[0].resolve(message);else this.queue.push(message);});}
  send(value:unknown){this.ws.send(JSON.stringify(value));}
  async next<T extends CollaborationServerMessage['type']>(type:T):Promise<Extract<CollaborationServerMessage,{type:T}>>{const index=this.queue.findIndex(message=>message.type===type);if(index>=0)return this.queue.splice(index,1)[0] as Extract<CollaborationServerMessage,{type:T}>;const message=await Promise.race([new Promise<CollaborationServerMessage>(resolve=>this.waiters.push({type,resolve})),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`No ${type} message`)),3000);timer.unref();})]);return message as Extract<CollaborationServerMessage,{type:T}>;}
}

test('strict canonical content accepts references/details and rejects malformed attributes, IDs and block structure',()=>{
  const f=fixture();try{
    const content:RichContent={type:'doc',content:[ref('issueReference','issue-example'),ref('documentReference','doc-b','설계 문서'),ref('documentInclude','doc-c'),{type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'검증 결과'}]},{type:'detailsContent',content:[{type:'paragraph',content:[{type:'text',text:'검증 통과',marks:[{type:'bold'}]}]}]}]}]};
    const normalized=f.contents.normalize(content);assert.equal(normalized.content.content![0].attrs!.label,'');assert.ok(normalized.plainText.includes('설계 문서'));assert.ok(normalized.plainText.includes('검증 결과'));assert.ok(normalized.plainText.includes('검증 통과'));
    const malformed:unknown[]=[{type:'doc',content:[{type:'heading',attrs:{level:'1'}}]},{type:'doc',content:[ref('issueReference','')]},{type:'doc',content:[ref('documentInclude','x'.repeat(201))]},{type:'doc',content:[ref('documentReference','doc-b','x'.repeat(301))]},{type:'doc',content:[{...ref('documentReference','doc-b'),attrs:{documentId:'doc-b',label:null}}]},{type:'doc',content:[{type:'details',attrs:{open:true},content:[]}]},{type:'doc',content:[{type:'details',content:[{type:'detailsContent',content:[{type:'paragraph'}]}]}]},{type:'doc',content:[{type:'paragraph',attrs:{unknown:true}}]},{type:'doc',content:[{type:'untrustedWidget'}]}];
    for(const value of malformed)rejects(()=>f.contents.normalize(value));
    rejects(()=>f.contents.normalize(undefined));
    const image=f.contents.normalize({type:'doc',content:[{type:'image',attrs:{src:'/api/attachments/example/content?inline=1',alt:'화면'}}]});assert.ok(image.plainText.includes('화면'));
  }finally{f.close();}
});

test('missing target preservation and prospective include graph validation distinguish includes from ordinary references',()=>{
  const f=fixture();try{
    const missing={type:'doc',content:[ref('issueReference','deleted-issue','예전 업무')]} as RichContent;
    rejects(()=>f.contents.validate('doc-a',missing), 'REFERENCE_NOT_FOUND');f.contents.validate('doc-a',missing,missing);
    f.contents.validate('doc-a',{type:'doc',content:[ref('issueReference','deleted-issue','이름 편집')]},missing);
    f.contents.validate('doc-a',missing,undefined,{allowMissing:true});
    f.contents.validate('doc-a',{type:'doc',content:[ref('issueReference','imported-issue')]},undefined,{issues:[{id:'imported-issue'} as Issue]});
    f.store.put('documents',document('doc-b',{type:'doc',content:[ref('documentInclude','doc-c')]}));
    f.contents.validate('doc-a',{type:'doc',content:[ref('documentInclude','doc-b')]});
    f.store.put('documents',document('doc-a',{type:'doc',content:[ref('documentInclude','doc-b')]}));
    rejects(()=>f.contents.validate('doc-c',{type:'doc',content:[ref('documentInclude','doc-a')]}),'INCLUDE_CYCLE');
    rejects(()=>f.contents.validate('doc-c',{type:'doc',content:[ref('documentInclude','doc-c')]}),'INCLUDE_CYCLE');
    f.contents.validate('doc-c',{type:'doc',content:[ref('documentReference','doc-a')]});
  }finally{f.close();}
});

test('startup upgrades v1 and v2 rooms atomically, preserving Yjs bytes and leaving current rooms untouched',()=>{
  const f=fixture();try{
    const initial=new CollaborationService(f.store,f.contents);
    const current=initial.enable('doc-c',1,'user-test');
    initial.close();
    const a=insertState(f.store,'doc-a',body('보존할 원본'));
    const b=insertState(f.store,'doc-b',{type:'doc',content:[ref('documentReference','doc-c','두 번째 원본')]},2);
    const request=f.store.db.prepare('INSERT INTO collaboration_requests(document_id,epoch,request_id,hash) VALUES(?,?,?,?)');
    request.run('doc-a',a.epoch,'old-request-v1','old-hash');
    request.run('doc-b',b.epoch,'old-request-v2','old-hash');
    request.run('doc-c',current.epoch,'current-request','current-hash');
    const migrated=new CollaborationService(f.store,f.contents);try{
      for(const [id,prior,label] of [['doc-a',a,'보존할 원본'],['doc-b',b,'두 번째 원본']] as const){
        const session=migrated.session(id);
        assert.equal(session.schemaVersion,COLLABORATION_SCHEMA);
        assert.notEqual(session.epoch,prior.epoch);
        assert.equal(session.document.version,2);
        const state=migrated.exportStates().find(value=>value.documentId===id)!;
        assert.deepEqual(Buffer.from(state.state,'base64'),prior.bytes);
        assert.ok(session.document.plainText.includes(label));
      }
      assert.deepEqual(migrated.session('doc-c'),current);
      assert.deepEqual(f.store.db.prepare('SELECT request_id FROM collaboration_requests').all().map(row=>row.request_id),['current-request']);
      const before=migrated.session('doc-a');const second=new CollaborationService(f.store,f.contents);try{assert.deepEqual(second.session('doc-a'),before);}finally{second.close();}
    }finally{migrated.close();}
  }finally{f.close();}
});

test('one invalid persisted room prevents every migration write, and legacy imports reject new-node states',()=>{
  const f=fixture();try{
    const initial=new CollaborationService(f.store,f.contents);initial.close();const a=insertState(f.store,'doc-a',body('유효한 원본'));insertState(f.store,'doc-b',{type:'doc',content:[issueList()]},2);
    assert.throws(()=>new CollaborationService(f.store,f.contents),(error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
    const row=f.store.db.prepare('SELECT epoch,schema_version,state FROM collaboration_documents WHERE document_id=?').get('doc-a') as {epoch:string;schema_version:number;state:Uint8Array};assert.equal(row.epoch,a.epoch);assert.equal(row.schema_version,1);assert.deepEqual(Buffer.from(row.state),a.bytes);assert.equal(f.store.get<DocPage>('documents','doc-a')!.version,1);
    f.store.db.exec('DELETE FROM collaboration_documents');const service=new CollaborationService(f.store,f.contents);try{
      const legacyDoc=document('doc-a',f.contents.normalize(body('기존 형식')).content);
      const legacy={documentId:'doc-a',epoch:randomUUID(),schemaVersion:1,state:encode(legacyDoc.content).toString('base64')};
      const valid=service.validateImport([legacy],[legacyDoc]);
      assert.equal(valid[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.notEqual(valid[0].epoch,legacy.epoch);
      const referenced=document('doc-b',f.contents.normalize({type:'doc',content:[ref('documentReference','doc-c')]}).content);
      const prior={documentId:'doc-b',epoch:randomUUID(),schemaVersion:2,state:encode(referenced.content).toString('base64')};
      assert.equal(service.validateImport([prior],[referenced])[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.throws(()=>service.validateImport([{...prior,schemaVersion:1}],[referenced]),(error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
      const listed=document('doc-c',f.contents.normalize({type:'doc',content:[issueList()]}).content);
      const current={documentId:'doc-c',epoch:randomUUID(),schemaVersion:COLLABORATION_SCHEMA,state:encode(listed.content).toString('base64')};
      assert.equal(service.validateImport([current],[listed])[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.throws(()=>service.validateImport([{...current,schemaVersion:2}],[listed]),(error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
      assert.throws(()=>service.validateImport([{...current,schemaVersion:99}],[listed]),CollaborationError);
      f.store.transaction(()=>{f.store.put('documents',legacyDoc);service.replaceImported(valid);});assert.ok(service.session('doc-a').document.plainText.includes('기존 형식'));
    }finally{service.close();}
  }finally{f.close();}
});

test('historical body restoration permits missing targets only explicitly and still enforces the include DAG',()=>{
  const f=fixture(),service=new CollaborationService(f.store,f.contents);try{
    const initial=service.enable('doc-a',1,'user-test'),historical={...initial.document,content:{type:'doc',content:[ref('documentReference','deleted-doc','과거 참조')]} as RichContent,version:initial.document.version+1};
    assert.throws(()=>f.store.transaction(()=>{f.store.put('documents',historical);service.replaceBody(historical);}),(error:unknown)=>error instanceof CollaborationError&&error.code==='REFERENCE_NOT_FOUND');assert.deepEqual(service.session('doc-a'),initial);
    const restored=f.store.transaction(()=>{f.store.put('documents',historical);return service.replaceBody(historical,{allowMissing:true});});assert.ok(restored.plainText.includes('과거 참조'));const epoch=service.session('doc-a').epoch;assert.notEqual(epoch,initial.epoch);
    const cycle={...restored,content:{type:'doc',content:[ref('documentInclude','doc-a')]} as RichContent,version:restored.version+1};assert.throws(()=>f.store.transaction(()=>{f.store.put('documents',cycle);service.replaceBody(cycle,{allowMissing:true});}),(error:unknown)=>error instanceof CollaborationError&&error.code==='INCLUDE_CYCLE');assert.equal(service.session('doc-a').epoch,epoch);assert.equal(JSON.stringify(service.session('doc-a').document),JSON.stringify(restored));
    f.store.put('documents',document('doc-b',{type:'doc',content:[ref('documentInclude','doc-b')]}));assert.throws(()=>service.enable('doc-b',1,'user-test'),(error:unknown)=>error instanceof CollaborationError&&error.code==='INCLUDE_CYCLE');assert.equal(service.session('doc-b').enabled,false);
  }finally{service.close();f.close();}
});

test('multi-room imports validate the whole prospective graph including non-live documents and preserve strict state equality',()=>{
  const f=fixture(),service=new CollaborationService(f.store,f.contents);try{
    const documents=[document('doc-a',{type:'doc',content:[ref('documentInclude','doc-b')]}),document('doc-b',{type:'doc',content:[ref('documentInclude','doc-c')]}),document('doc-c',{type:'doc',content:[ref('documentReference','deleted-doc')]})];
    const before=structuredClone(documents),states=documents.slice(0,2).map(document=>({documentId:document.id,epoch:randomUUID(),schemaVersion:COLLABORATION_SCHEMA,state:encode(document.content).toString('base64')}));
    assert.equal(service.validateImport(states,documents).length,2);assert.deepEqual(documents,before);assert.deepEqual(service.exportStates(),[]);
    const cycle=structuredClone(documents);cycle[2].content={type:'doc',content:[ref('documentInclude','doc-a')]};assert.throws(()=>service.validateImport(states,cycle),(error:unknown)=>error instanceof CollaborationError&&error.code==='INCLUDE_CYCLE');
    const mismatch=structuredClone(documents);mismatch[1].content=body('Yjs 상태와 다른 문서');assert.throws(()=>service.validateImport(states,mismatch),(error:unknown)=>error instanceof CollaborationError&&error.code==='SNAPSHOT_MISMATCH');assert.deepEqual(service.exportStates(),[]);
  }finally{service.close();f.close();}
});

test('live updates validate references/includes before durable ACK and reject v1 and v2 protocol clients',async()=>{
  const f=fixture(),service=new CollaborationService(f.store,f.contents),server=createServer();service.attachWebSocket(server);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No server address');const url=`ws://127.0.0.1:${address.port}/api/collaboration?documentId=doc-a&actorId=user-test`;const peers:Peer[]=[];
  try{
    const session=service.enable('doc-a',1,'user-test');
    for(const schemaVersion of [1,2]){
      const old=new Peer(url);
      peers.push(old);
      await once(old.ws,'open');
      old.send({type:'hello',epoch:null,schemaVersion});
      assert.equal((await old.next('error')).code,'SCHEMA_MISMATCH');
      assert.equal(old.queue.length,0);
    }
    const peer=new Peer(url);peers.push(peer);await once(peer.ws,'open');peer.send({type:'hello',epoch:null,schemaVersion:COLLABORATION_SCHEMA});const welcome=await peer.next('welcome');const ydoc=new Y.Doc();Y.applyUpdate(ydoc,Buffer.from(welcome.update,'base64'));
    try{
      const before=service.exportStates()[0];const invalidDoc=prosemirrorJSONToYDoc(schema,{type:'doc',content:[ref('documentInclude','doc-a')]},'default');let invalidUpdate:Uint8Array;try{invalidUpdate=Y.encodeStateAsUpdate(invalidDoc);}finally{invalidDoc.destroy();}
      peer.send({type:'update',epoch:session.epoch,requestId:'invalid-cycle',update:Buffer.from(invalidUpdate).toString('base64')});assert.equal((await peer.next('error')).code,'INCLUDE_CYCLE');assert.deepEqual(service.exportStates()[0],before);assert.equal(service.session('doc-a').document.version,session.document.version);assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM collaboration_requests').get() as {n:number}).n,0);
      const bad=new Y.XmlElement('documentReference');bad.setAttribute('documentId','missing-doc');bad.setAttribute('label','없음');let update:Uint8Array|undefined;ydoc.on('update',value=>{update=value;});ydoc.getXmlFragment('default').insert(1,[bad]);peer.send({type:'update',epoch:session.epoch,requestId:'missing-target',update:Buffer.from(update!).toString('base64')});assert.equal((await peer.next('error')).code,'REFERENCE_NOT_FOUND');assert.deepEqual(service.exportStates()[0],before);
      const clean=new Y.Doc();Y.applyUpdate(clean,Buffer.from(welcome.update,'base64'));try{const reference=new Y.XmlElement('documentReference');reference.setAttribute('documentId','doc-b');reference.setAttribute('label','관련 설계');let accepted:Uint8Array|undefined;clean.on('update',value=>{accepted=value;});clean.getXmlFragment('default').insert(1,[reference]);peer.send({type:'update',epoch:session.epoch,requestId:'valid-reference',update:Buffer.from(accepted!).toString('base64')});const ack=await peer.next('ack');assert.equal(ack.requestId,'valid-reference');assert.ok(ack.document.plainText.includes('관련 설계'));assert.equal(JSON.stringify(ack.document.content),JSON.stringify(f.contents.normalize(yDocToProsemirrorJSON(clean,'default')).content));assert.equal(service.session('doc-a').document.version,session.document.version+1);}finally{clean.destroy();}
    }finally{ydoc.destroy();}
  }finally{for(const peer of peers)peer.ws.terminate();service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
