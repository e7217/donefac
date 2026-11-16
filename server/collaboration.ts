import { randomUUID, createHash } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { createEditorSchema } from '../shared/editor-schema.js';
import { COLLABORATION_SCHEMA, type CollaborationPeer, type CollaborationSession, type CollaborationServerMessage } from '../shared/collaboration.js';
import type { DocPage, DocRevision, RichContent, User } from '../shared/types.js';
import { Store } from './store.js';

export const MAX_COLLABORATION_UPDATE=1024*1024;
const MAX_STATE=16*1024*1024,MAX_DOCUMENT=8*1024*1024;
const schema=createEditorSchema();
const iso=()=>new Date().toISOString();
export class CollaborationError extends Error { constructor(public status:number,message:string,public code='INVALID_COLLABORATION'){super(message);} }
function invalid(message:string,status=400,code?:string):never{throw new CollaborationError(status,message,code);}
export interface CollaborationExport { documentId:string;epoch:string;schemaVersion:number;state:string }
interface State {documentId:string;epoch:string;schemaVersion:number;state:Buffer}
interface Peer {socket:WebSocket;id:string;actorId:string;documentId:string;epoch:string|null;ready:boolean}

function base64(value:unknown,max:number) {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(max/3)*4)invalid('공동 편집 데이터의 크기 또는 형식이 올바르지 않습니다.',413,'UPDATE_TOO_LARGE');
  const bytes=Buffer.from(value as string,'base64');
  if(bytes.length>max)invalid('공동 편집 데이터의 크기 한도를 초과했습니다.',413,'UPDATE_TOO_LARGE');
  if(bytes.toString('base64')!==value)invalid('공동 편집 데이터의 base64 형식이 올바르지 않습니다.');
  return bytes;
}
function normalizeContent(value:unknown):{content:RichContent;plainText:string} {
  if(Buffer.byteLength(JSON.stringify(value))>MAX_DOCUMENT)invalid('문서 내용이 공동 편집 크기 한도를 초과했습니다.',413,'DOCUMENT_TOO_LARGE');
  let count=0;
  const check=(node:any,depth:number)=>{
    if(++count>30000||depth>60||!node||typeof node!=='object'||typeof node.type!=='string')invalid('공동 편집 문서 구조가 올바르지 않습니다.',422,'INVALID_SCHEMA');
    const type=schema.nodes[node.type];if(!type)invalid('지원하지 않는 문서 노드입니다.',422,'INVALID_SCHEMA');
    const attributes=(attrs:any,spec:Record<string,unknown>|undefined)=>{if(attrs===undefined)return;if(!attrs||typeof attrs!=='object'||Array.isArray(attrs)||Object.keys(attrs).some(key=>!Object.hasOwn(spec||{},key)))invalid('지원하지 않는 문서 속성입니다.',422,'INVALID_SCHEMA');};
    attributes(node.attrs,type.spec.attrs);
    if(node.marks!==undefined&&!Array.isArray(node.marks))invalid('문서 서식이 올바르지 않습니다.',422,'INVALID_SCHEMA');
    for(const mark of node.marks||[]){const type=mark&&schema.marks[mark.type];if(!type)invalid('지원하지 않는 문서 서식입니다.',422,'INVALID_SCHEMA');attributes(mark.attrs,type.spec.attrs);}
    for(const mark of node.marks||[])if(mark.type==='link'&&typeof mark.attrs?.href==='string'&&/^(?:javascript|vbscript|data):/i.test(mark.attrs.href.trim()))invalid('지원하지 않는 링크 형식입니다.',422,'INVALID_SCHEMA');
    if(node.type==='image'&&typeof node.attrs?.src==='string'&&!/^(?:https?:\/\/|\/)/i.test(node.attrs.src))invalid('이미지는 http(s) 또는 첨부파일 주소를 사용해 주세요.',422,'INVALID_SCHEMA');
    if(node.type==='heading'&&![1,2,3].includes(node.attrs?.level))invalid('제목 단계는 1~3이어야 합니다.',422,'INVALID_SCHEMA');
    if(node.content!==undefined){if(!Array.isArray(node.content))invalid('문서 블록이 올바르지 않습니다.',422,'INVALID_SCHEMA');node.content.forEach((child:any)=>check(child,depth+1));}
  };
  check(value,0);
  try{const node=schema.nodeFromJSON(value);if(node.type!==schema.topNodeType)invalid('문서 루트가 올바르지 않습니다.',422,'INVALID_SCHEMA');node.check();return{content:node.toJSON() as RichContent,plainText:node.textBetween(0,node.content.size,'\n')};}
  catch(error){if(error instanceof CollaborationError)throw error;return invalid('지원하지 않는 문서 노드·속성·서식입니다.',422,'INVALID_SCHEMA');}
}
function inspect(doc:Y.Doc) {
  for(const name of doc.share.keys())if(name!=='default')invalid('지원하지 않는 공동 편집 루트입니다.',422,'INVALID_SCHEMA');
  const root=doc.getXmlFragment('default');
  if((root as unknown as {_map:Map<unknown,unknown>})._map.size)invalid('문서 루트에 지원하지 않는 데이터가 있습니다.',422,'INVALID_SCHEMA');
  try{return normalizeContent(yDocToProsemirrorJSON(doc,'default'));}
  catch(error){if(error instanceof CollaborationError)throw error;return invalid('공동 편집 문서 형식을 읽을 수 없습니다.',422,'INVALID_SCHEMA');}
}
function decodeState(bytes:Buffer) {
  const doc=new Y.Doc();
  try{Y.applyUpdate(doc,bytes);return doc;}catch{doc.destroy();return invalid('Yjs 데이터가 올바르지 않습니다.',422,'INVALID_UPDATE');}
}

/** Yjs BLOB is authoritative. DocPage.content is committed only as its derived snapshot. */
export class CollaborationService {
  private peers=new Set<Peer>();
  private servers=new Map<HttpServer,{wss:WebSocketServer;upgrade:(req:IncomingMessage,socket:Duplex,head:Buffer)=>void}>();
  constructor(private readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_documents(
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      epoch TEXT NOT NULL,schema_version INTEGER NOT NULL,state BLOB NOT NULL,updated_at TEXT NOT NULL
    );CREATE TABLE IF NOT EXISTS collaboration_requests(
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      epoch TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,
      PRIMARY KEY(document_id,epoch,request_id)
    );`);
  }
  private document(id:string):DocPage {return this.store.get<DocPage>('documents',id)||invalid('문서를 찾을 수 없습니다.',404,'DOCUMENT_NOT_FOUND');}
  private state(id:string):State|undefined {
    const row=this.store.db.prepare('SELECT * FROM collaboration_documents WHERE document_id=?').get(id) as {document_id:string;epoch:string;schema_version:number;state:Uint8Array}|undefined;
    return row&&{documentId:row.document_id,epoch:row.epoch,schemaVersion:row.schema_version,state:Buffer.from(row.state)};
  }
  private write(state:State){this.store.db.prepare('INSERT INTO collaboration_documents(document_id,epoch,schema_version,state,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET epoch=excluded.epoch,schema_version=excluded.schema_version,state=excluded.state,updated_at=excluded.updated_at').run(state.documentId,state.epoch,state.schemaVersion,state.state,iso());}
  private fromContent(document:DocPage):{state:State;document:DocPage}{
    const normalized=normalizeContent(document.content);
    const ydoc=prosemirrorJSONToYDoc(schema,normalized.content,'default');
    try{return{state:{documentId:document.id,epoch:randomUUID(),schemaVersion:COLLABORATION_SCHEMA,state:Buffer.from(Y.encodeStateAsUpdate(ydoc))},document:{...document,...normalized}};}finally{ydoc.destroy();}
  }
  session(documentId:string):CollaborationSession {
    const document=this.document(documentId),state=this.state(documentId);
    return{enabled:!!state,epoch:state?.epoch||null,schemaVersion:state?.schemaVersion||COLLABORATION_SCHEMA,document};
  }
  enable(documentId:string,expectedVersion:unknown,actorId:string):CollaborationSession {
    if(!this.store.get('users',actorId))invalid('작업자를 찾을 수 없습니다.');
    return this.store.transaction(()=>{
      const document=this.document(documentId);
      if(this.state(documentId))return this.session(documentId);
      if(!Number.isInteger(expectedVersion)||expectedVersion!==document.version)invalid('문서가 변경되었습니다. 최신 문서를 불러온 뒤 공동 편집을 시작해 주세요.',409,'VERSION_CONFLICT');
      const seeded=this.fromContent({...document,version:document.version+1,updatedAt:iso()});
      this.write(seeded.state);this.store.put('documents',seeded.document);
      this.store.put('activities',{id:randomUUID(),resourceType:'document',resourceId:documentId,actorId,action:'공동 편집 시작',detail:'영속 Yjs 문서 생성',createdAt:iso()});
      return this.session(documentId);
    });
  }
  checkpoint(documentId:string,actorId:string,expectedVersion?:unknown,summary?:unknown):DocRevision {
    return this.store.transaction(()=>{
      const document=this.document(documentId);if(!this.state(documentId))invalid('공동 편집이 활성화되지 않았습니다.',409,'NOT_ENABLED');
      if(expectedVersion!==undefined&&expectedVersion!==document.version)invalid('문서가 변경되었습니다. 최신 버전을 확인해 주세요.',409,'VERSION_CONFLICT');
      if(typeof summary!=='undefined'&&(typeof summary!=='string'||summary.length>500))invalid('이력 설명은 500자 이하여야 합니다.');
      const prior=this.store.all<DocRevision>('revisions').find(r=>r.documentId===document.id&&r.version===document.version&&r.title===document.title&&JSON.stringify(r.content)===JSON.stringify(document.content));
      if(prior)return prior;
      const revision:DocRevision={id:randomUUID(),documentId,version:document.version,title:document.title,content:document.content,plainText:document.plainText,authorId:actorId,createdAt:iso(),summary:(summary as string)?.trim()||'공동 편집 체크포인트'};
      this.store.put('revisions',revision);this.store.put('activities',{id:randomUUID(),resourceType:'document',resourceId:documentId,actorId,action:'문서 이력 저장',detail:`버전 ${document.version}`,createdAt:iso()});return revision;
    });
  }
  /** Caller owns the surrounding REST transaction; notifications occur only after commit. */
  replaceBody(document:DocPage):DocPage {
    if(!this.state(document.id))return document;
    const seeded=this.fromContent(document);this.write(seeded.state);this.store.put('documents',seeded.document);
    this.store.db.prepare('DELETE FROM collaboration_requests WHERE document_id=?').run(document.id);return seeded.document;
  }
  deriveSnapshot(document:DocPage):DocPage {
    const state=this.state(document.id);if(!state)return document;
    const doc=decodeState(state.state);try{return{...document,...inspect(doc)};}finally{doc.destroy();}
  }
  private send(peer:Peer,message:CollaborationServerMessage){if(peer.socket.readyState===WebSocket.OPEN)peer.socket.send(JSON.stringify(message));}
  private ready(documentId:string){return[...this.peers].filter(peer=>peer.ready&&peer.documentId===documentId&&peer.socket.readyState===WebSocket.OPEN);}
  private presence(documentId:string):CollaborationPeer[]{return this.ready(documentId).flatMap(peer=>{const user=this.store.get<User>('users',peer.actorId);return user?[{id:peer.id,actorId:peer.actorId,name:user.name,color:user.color}]:[];});}
  private broadcastPresence(documentId:string){const peers=this.presence(documentId);for(const peer of this.ready(documentId))this.send(peer,{type:'presence',peers});}
  notifyMetadata(documentId:string){const state=this.state(documentId);if(!state)return;const document=this.document(documentId);for(const peer of this.ready(documentId))this.send(peer,{type:'update',epoch:state.epoch,update:Buffer.from([0,0]).toString('base64'),document});}
  reset(documentId:string,reason:string){
    const state=this.state(documentId),document=this.store.get<DocPage>('documents',documentId);
    for(const peer of [...this.peers].filter(peer=>peer.documentId===documentId)){
      if(state&&document)this.send(peer,{type:'reset',epoch:state.epoch,document,reason});
      else this.send(peer,{type:'error',code:'DOCUMENT_NOT_FOUND',message:'문서가 삭제되거나 공동 편집 데이터가 교체되었습니다.'});
      peer.ready=false;peer.socket.close(state?4409:4404,'document_reset');
    }
  }
  invalidateAll(reason:string){for(const id of new Set([...this.peers].map(peer=>peer.documentId)))this.reset(id,reason);}
  exportStates():CollaborationExport[]{return(this.store.db.prepare('SELECT document_id FROM collaboration_documents').all() as {document_id:string}[]).map(row=>{const state=this.state(row.document_id)!;return{documentId:state.documentId,epoch:state.epoch,schemaVersion:state.schemaVersion,state:state.state.toString('base64')};});}
  validateImport(value:unknown,documents:DocPage[]):State[]{
    if(!Array.isArray(value)||value.length>100000)invalid('공동 편집 상태 목록이 필요합니다.');
    const seen=new Set();return value.map(item=>{
      if(!item||typeof item.documentId!=='string'||seen.has(item.documentId)||item.schemaVersion!==COLLABORATION_SCHEMA||typeof item.epoch!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(item.epoch))invalid('공동 편집 상태의 식별자·스키마가 올바르지 않습니다.');
      seen.add(item.documentId);const document=documents.find(d=>d.id===item.documentId);if(!document)invalid('공동 편집 상태에 해당하는 문서가 없습니다.');
      const bytes=base64(item.state,MAX_STATE),ydoc=decodeState(bytes);
      try{const normalized=inspect(ydoc);if(JSON.stringify(normalized.content)!==JSON.stringify(normalizeContent(document!.content).content))invalid('공동 편집 상태와 문서 JSON 내용이 일치하지 않습니다.',422,'SNAPSHOT_MISMATCH');return{documentId:item.documentId,epoch:randomUUID(),schemaVersion:COLLABORATION_SCHEMA,state:bytes};}finally{ydoc.destroy();}
    });
  }
  replaceImported(states:State[]){this.store.db.exec('DELETE FROM collaboration_requests;DELETE FROM collaboration_documents;');for(const state of states){this.write(state);this.store.put('documents',this.deriveSnapshot(this.document(state.documentId)));}}
  private handle(peer:Peer,raw:Buffer){
    let message:any;try{message=JSON.parse(raw.toString('utf8'));}catch{return invalid('공동 편집 메시지가 올바른 JSON이 아닙니다.');}
    if(message?.type==='ping'){this.send(peer,{type:'pong'});return;}
    const state=this.state(peer.documentId);if(!state)invalid('공동 편집이 활성화되지 않았습니다.',409,'NOT_ENABLED');
    if(message?.type==='hello'){
      if(message.schemaVersion!==COLLABORATION_SCHEMA||state.schemaVersion!==COLLABORATION_SCHEMA)invalid('공동 편집 스키마 버전이 다릅니다.',409,'SCHEMA_MISMATCH');
      if(message.epoch!==null&&message.epoch!==state.epoch){this.send(peer,{type:'reset',epoch:state.epoch,document:this.document(peer.documentId),reason:'문서가 복구되거나 교체되었습니다. 이전 편집을 새 문서에 보관해 주세요.'});peer.socket.close(4409,'epoch_changed');return;}
      const doc=decodeState(state.state);
      try{let vector:Uint8Array|undefined;if(message.stateVector!==undefined){vector=base64(message.stateVector,MAX_COLLABORATION_UPDATE);try{Y.decodeStateVector(vector);}catch{invalid('Yjs 상태 벡터가 올바르지 않습니다.',422,'INVALID_STATE_VECTOR');}}const update=Y.encodeStateAsUpdate(doc,vector);peer.epoch=state.epoch;peer.ready=true;this.send(peer,{type:'welcome',epoch:state.epoch,schemaVersion:COLLABORATION_SCHEMA,update:Buffer.from(update).toString('base64'),stateVector:Buffer.from(Y.encodeStateVector(doc)).toString('base64'),document:this.document(peer.documentId),peers:this.presence(peer.documentId)});this.broadcastPresence(peer.documentId);}finally{doc.destroy();}return;
    }
    if(message?.type!=='update')invalid('지원하지 않는 공동 편집 메시지입니다.');
    if(!peer.ready)invalid('먼저 공동 편집 세션을 시작해 주세요.',409,'NOT_READY');
    if(message.epoch!==state.epoch||peer.epoch!==state.epoch){this.reset(peer.documentId,'문서의 공동 편집 세대가 변경되었습니다.');return;}
    if(typeof message.requestId!=='string'||!/^[a-zA-Z\d:_-]{1,200}$/.test(message.requestId))invalid('업데이트 요청 ID가 올바르지 않습니다.');
    const update=base64(message.update,MAX_COLLABORATION_UPDATE),digest=createHash('sha256').update(update).digest('hex');
    const prior=this.store.db.prepare('SELECT hash FROM collaboration_requests WHERE document_id=? AND epoch=? AND request_id=?').get(peer.documentId,state.epoch,message.requestId) as {hash:string}|undefined;
    if(prior&&prior.hash!==digest)invalid('같은 요청 ID에 다른 편집 데이터가 전달되었습니다.',409,'REQUEST_ID_REUSED');
    const candidate=decodeState(state.state);
    try{
      if(!prior)try{Y.applyUpdate(candidate,update);}catch{return invalid('Yjs 업데이트가 올바르지 않습니다.',422,'INVALID_UPDATE');}
      const normalized=inspect(candidate),encoded=Buffer.from(Y.encodeStateAsUpdate(candidate));if(encoded.length>MAX_STATE)invalid('공동 편집 문서 상태가 크기 한도를 초과했습니다.',413,'DOCUMENT_TOO_LARGE');
      const changed=!encoded.equals(state.state);let document=this.document(peer.documentId);
      // Even an idempotent request is acknowledged only after the request receipt commits.
      this.store.transaction(()=>{
        if(changed){document={...document,...normalized,version:document.version+1,updatedAt:iso()};this.write({...state,state:encoded});this.store.put('documents',document);}
        if(!prior)this.store.db.prepare('INSERT INTO collaboration_requests(document_id,epoch,request_id,hash) VALUES(?,?,?,?)').run(peer.documentId,state.epoch,message.requestId,digest);
      });
      this.send(peer,{type:'ack',epoch:state.epoch,requestId:message.requestId,stateVector:Buffer.from(Y.encodeStateVector(candidate)).toString('base64'),document});
      if(changed)for(const other of this.ready(peer.documentId))if(other!==peer)this.send(other,{type:'update',epoch:state.epoch,update:message.update,document});
    }finally{candidate.destroy();}
  }
  attachWebSocket(server:HttpServer){
    if(this.servers.has(server))return;
    const wss=new WebSocketServer({noServer:true,maxPayload:2*MAX_COLLABORATION_UPDATE});
    const upgrade=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{
      let url:URL;try{url=new URL(req.url||'','http://localhost');}catch{socket.destroy();return;}
      if(url.pathname!=='/api/collaboration'){socket.end('HTTP/1.1 404 Not Found\r\n\r\n');return;}
      const documentId=url.searchParams.get('documentId')||'',actorId=url.searchParams.get('actorId')||'';
      if(!this.store.get('users',actorId)||!this.store.get('documents',documentId)||!this.state(documentId)){socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        const peer:Peer={socket:ws,id:randomUUID(),actorId,documentId,epoch:null,ready:false};this.peers.add(peer);
        const timer=setTimeout(()=>{if(!peer.ready)ws.close(4408,'hello_timeout');},10000);timer.unref();
        ws.on('error',()=>{});
        ws.on('message',(data,isBinary)=>{
          try{if(isBinary)invalid('JSON 텍스트 메시지를 사용해 주세요.');this.handle(peer,Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer));}
          catch(error){const e=error instanceof CollaborationError?error:new CollaborationError(500,'공동 편집을 저장하지 못했습니다. 다시 연결해 주세요.','SERVER_ERROR');this.send(peer,{type:'error',code:e.code,message:e.message});if(e.code==='SCHEMA_MISMATCH'||e.code==='SERVER_ERROR')ws.close(e.code==='SCHEMA_MISMATCH'?4400:4500,e.code);}
        });
        ws.on('close',()=>{clearTimeout(timer);this.peers.delete(peer);this.broadcastPresence(documentId);});
      });
    };
    server.on('upgrade',upgrade);this.servers.set(server,{wss,upgrade});
  }
  close(){for(const peer of this.peers)peer.socket.terminate();this.peers.clear();for(const [server,{wss,upgrade}]of this.servers){server.removeListener('upgrade',upgrade);wss.close();}this.servers.clear();}
}
