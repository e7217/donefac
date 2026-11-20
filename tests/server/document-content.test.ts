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
import { getExtensionField, getSchema } from '@tiptap/core';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Store } from '../../server/store.js';
import { DocumentContentService,DocumentContentError,normalizeDocumentContent,readDocumentSelection } from '../../server/document-content.js';
import { CollaborationService,CollaborationError } from '../../server/collaboration.js';
import { createEditorExtensions, createEditorSchema } from '../../shared/editor-schema.js';
import { COLLABORATION_SCHEMA,type CollaborationServerMessage } from '../../shared/collaboration.js';
import { contentReferences, documentContentSchemaVersion, documentRevisionIncludes, MAX_CALLOUT_TITLE_LENGTH, MAX_STATUS_BADGE_LABEL_LENGTH } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import type { DocPage,DocRevision,Issue,RichContent } from '../../shared/types.js';

const now='2026-11-16T00:00:00.000Z',schema=createEditorSchema();
const body=(text='원본'):RichContent=>({type:'doc',content:[{type:'paragraph',content:text?[{type:'text',text}]:undefined}]});
function heading(text: string, sectionId?: string, level = 1): RichContent {
  return {type:'heading',attrs:{level,...(sectionId && {sectionId})},content:[{type:'text',text}]};
}
const ref=(type:string,id:string,label=''):RichContent=>({type,attrs:{[type==='issueReference'?'issueId':'documentId']:id,label}});
const issueList=():RichContent=>({type:'issueList',attrs:{projectId:'project-test',savedViewId:null,label:'검증할 업무'}});
const issueSummary=():RichContent=>({type:'issueSummary',attrs:{projectId:'project-test',savedViewId:null,label:'검증할 업무 현황',groupBy:'priority'}});
const pinnedInclude=():RichContent=>({type:'documentRevisionInclude',attrs:{documentId:'doc-b',revisionId:'revision-test',label:'검증할 문서 버전'}});
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

test('heading section IDs are canonical, unique within one document, and require content schema 7 only when present', () => {
  const legacy: RichContent = { type: 'doc', content: [heading('기존 제목')] };
  const current: RichContent = { type: 'doc', content: [heading('개정 제목', 'section_a-1'), heading('같은 제목', 'section_b')] };
  const normalizedLegacy = normalizeDocumentContent(legacy);
  assert.equal(Object.hasOwn(normalizedLegacy.content.content![0].attrs!, 'sectionId'), false);
  assert.equal(documentContentSchemaVersion(normalizedLegacy.content), 1);
  assert.equal(JSON.stringify(normalizedLegacy.content), JSON.stringify(legacy));
  const normalized = normalizeDocumentContent(current);
  assert.equal(normalized.content.content?.[0].attrs?.sectionId, 'section_a-1');
  assert.equal(documentContentSchemaVersion(normalized.content), 7);
  assert.equal(normalized.plainText, '개정 제목\n같은 제목');
  assert.equal(readDocumentSelection(normalized.content, 1, 6), '개정 제목');
  assert.equal(documentSectionHash('문서/&', 'section_a-1'), '#/all/documents/%EB%AC%B8%EC%84%9C%2F%26?section=section_a-1');
  assert.equal(documentSectionHash('doc-a', 'section_a-1', 'space', { kind: 'review', revisionId: 'rev?&' }),
    '#/space/documents/doc-a?publication=review&revision=rev%3F%26&section=section_a-1');

  for (const invalid of [null, 1, '', '_start', '잘못된 문자', 'bad/name', 'end\n', 'A'.repeat(81)]) {
    const invalidHeading = { ...heading('제목'), attrs: { level: 1, sectionId: invalid } };
    rejects(() => normalizeDocumentContent({ type: 'doc', content: [invalidHeading] }));
  }
  rejects(() => normalizeDocumentContent({ type: 'doc', content: [heading('제목', 'same'),
    { type: 'blockquote', content: [heading('중첩 제목', 'same')] }] }));
  rejects(() => normalizeDocumentContent({ type: 'doc', content: [{ type: 'paragraph', attrs: { sectionId: 'heading-only' } }] }));
  assert.equal(normalizeDocumentContent({ type: 'doc', content: [heading('다른 문서', 'section_a-1')] }).content.content?.[0].attrs?.sectionId, 'section_a-1');
});

test('editor heading copies and splits preserve the original ID and multi-heading formatting keeps each identity', () => {
  const document = schema.nodeFromJSON({ type: 'doc', content: [heading('첫 제목', 'first'), heading('둘째 제목', 'second', 3)] });
  const extension = createEditorExtensions().find(candidate => candidate.name === 'headingSections');
  assert.ok(extension);
  const plugins = getExtensionField<() => Plugin[]>(extension, 'addProseMirrorPlugins')();
  const state = EditorState.create({ doc: document, plugins });
  const first = document.firstChild!;
  const copied = state.applyTransaction(state.tr.insert(0, first)).state.doc;
  assert.deepEqual(copied.content.content.map(node => node.attrs.sectionId), [undefined, 'first', 'second']);
  const split = state.applyTransaction(state.tr.split(2)).state.doc;
  assert.deepEqual(split.content.content.map(node => node.attrs.sectionId), ['first', undefined, 'second']);
  const cut = state.applyTransaction(state.tr.delete(0, first.nodeSize)).state;
  const moved = cut.applyTransaction(cut.tr.insert(cut.doc.content.size, first)).state.doc;
  assert.deepEqual(moved.content.content.map(node => node.attrs.sectionId), ['second', 'first']);
  const reformatted = state.applyTransaction(state.tr.setBlockType(1, document.content.size - 1, schema.nodes.heading, { level: 2 })).state.doc;
  assert.deepEqual(reformatted.content.content.map(node => [node.attrs.level, node.attrs.sectionId]), [[2, 'first'], [2, 'second']]);
});

test('callouts and inline status badges preserve canonical text, selection, and required schema version', () => {
  const status = { type: 'statusBadge', attrs: { label: '검증 중' } };
  const paragraph = { type: 'paragraph', content: [{ type: 'text', text: '현재 ' }, status, { type: 'text', text: ' 상태' }] };
  const callout = { type: 'callout', attrs: { title: '배포 상태' }, content: [paragraph] };
  const { content, plainText } = normalizeDocumentContent({ type: 'doc', content: [callout] });
  assert.deepEqual({ ...content.content?.[0].attrs }, { title: '배포 상태', variant: 'info' });
  assert.deepEqual({ ...content.content?.[0].content?.[0].content?.[1].attrs }, { label: '검증 중', tone: 'neutral' });
  assert.equal(plainText, '배포 상태\n현재 검증 중 상태');
  assert.equal(readDocumentSelection(content, 5, 6), '검증 중');
  assert.equal(readDocumentSelection(content, 2, 9), '현재 검증 중 상태');
  assert.equal(documentContentSchemaVersion(content), 6);
  assert.equal(documentContentSchemaVersion({ type: 'doc', content: [paragraph] }), 6);
  const untitled = normalizeDocumentContent({ type: 'doc', content: [{ type: 'callout', content: [{ type: 'paragraph' }] }] });
  assert.deepEqual({ ...untitled.content.content?.[0].attrs }, { title: '', variant: 'info' });
  assert.equal(untitled.plainText, '');
  assert.equal(documentContentSchemaVersion(body()), 1);
});

test('callout and badge validation enforces type, length, and placement', () => {
  const paragraph = (content?: RichContent[]): RichContent => ({ type: 'paragraph', ...(content && { content }) });
  const callout = (attrs: RichContent['attrs'], content: RichContent[] = [paragraph()]): RichContent => ({ type: 'callout', attrs, content });
  const badge = (attrs: RichContent['attrs'], content?: RichContent[]): RichContent => ({ type: 'statusBadge', attrs, ...(content && { content }) });
  const doc = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
  const title = '제'.repeat(MAX_CALLOUT_TITLE_LENGTH), label = '상'.repeat(MAX_STATUS_BADGE_LABEL_LENGTH);
  const valid = doc(callout({ variant: 'warning', title }, [paragraph([badge({ tone: 'purple', label })])]));
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeDocumentContent(valid).content)), valid);
  const malformed = [
    doc(callout({ variant: 'custom' })), doc(callout({ variant: null })), doc(callout({ title: 0 })),
    doc(callout({ title: `${title}제` })), doc(callout({}, [])), doc(callout({}, [badge({ label })])),
    doc(paragraph([callout({})])), doc(badge({ label })), doc(paragraph([badge({})])),
    doc(paragraph([badge({ label: '  ' })])), doc(paragraph([badge({ label: `${label}상` })])),
    doc(paragraph([badge({ label, tone: 'custom' })])), doc(paragraph([badge({ label, tone: null })])),
    doc(paragraph([badge({ label }, [{ type: 'text', text: '추가 내용' }])])),
  ];
  for (const value of malformed) rejects(() => normalizeDocumentContent(value));
});

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

test('startup upgrades v1 through v6 rooms atomically, preserving Yjs bytes and leaving current rooms untouched',()=>{
  const f=fixture();try{
    const initial=new CollaborationService(f.store,f.contents);
    const current=initial.enable('doc-c',1,'user-test');
    initial.close();
    const a=insertState(f.store,'doc-a',body('보존할 원본'));
    const b=insertState(f.store,'doc-b',{type:'doc',content:[ref('documentReference','doc-c','두 번째 원본')]},2);
    f.store.put('documents',document('doc-d'));
    const d=insertState(f.store,'doc-d',{type:'doc',content:[issueList()]},3);
    f.store.put('documents',document('doc-e'));
    const e=insertState(f.store,'doc-e',{type:'doc',content:[issueSummary()]},4);
    f.store.put('documents',document('doc-f'));
    f.store.put('revisions',{id:'revision-test',documentId:'doc-b',version:1,title:'고정할 설계',content:body(),
      plainText:'원본',authorId:'user-test',createdAt:now,summary:'합성 저장본'} satisfies DocRevision);
    const pinned=insertState(f.store,'doc-f',{type:'doc',content:[pinnedInclude()]},5);
    const legacyHeading = { type: 'doc', content: [heading('기존 절 제목')] };
    f.store.put('documents', document('doc-g', legacyHeading));
    const legacyRoom = prosemirrorJSONToYDoc(getSchema([StarterKit]), legacyHeading, 'default');
    const legacyBytes = Buffer.from(Y.encodeStateAsUpdate(legacyRoom));
    legacyRoom.destroy();
    const g = insertState(f.store, 'doc-g', legacyHeading, 6, randomUUID(), legacyBytes);
    const request=f.store.db.prepare('INSERT INTO collaboration_requests(document_id,epoch,request_id,hash) VALUES(?,?,?,?)');
    request.run('doc-a',a.epoch,'old-request-v1','old-hash');
    request.run('doc-b',b.epoch,'old-request-v2','old-hash');
    request.run('doc-d',d.epoch,'old-request-v3','old-hash');
    request.run('doc-e',e.epoch,'old-request-v4','old-hash');
    request.run('doc-f',pinned.epoch,'old-request-v5','old-hash');
    request.run('doc-g',g.epoch,'old-request-v6','old-hash');
    request.run('doc-c',current.epoch,'current-request','current-hash');
    const migrated=new CollaborationService(f.store,f.contents);try{
      for(const [id,prior,label] of [['doc-a',a,'보존할 원본'],['doc-b',b,'두 번째 원본'],['doc-d',d,'검증할 업무'],['doc-e',e,'검증할 업무 현황'],['doc-f',pinned,'검증할 문서 버전'],['doc-g',g,'기존 절 제목']] as const){
        const session=migrated.session(id);
        assert.equal(session.schemaVersion,COLLABORATION_SCHEMA);
        assert.notEqual(session.epoch,prior.epoch);
        assert.equal(session.document.version,2);
        const state=migrated.exportStates().find(value=>value.documentId===id)!;
        assert.deepEqual(Buffer.from(state.state,'base64'),prior.bytes);
        assert.ok(session.document.plainText.includes(label));
      }
      assert.equal(JSON.stringify(migrated.session('doc-g').document.content), JSON.stringify(legacyHeading));
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
      assert.equal(service.validateImport([{...current,schemaVersion:3}],[listed])[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.throws(()=>service.validateImport([{...current,schemaVersion:2}],[listed]),(error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
      assert.throws(()=>service.validateImport([{...current,schemaVersion:99}],[listed]),CollaborationError);
      const summarized=document('doc-c',f.contents.normalize({type:'doc',content:[issueSummary()]}).content);
      const richState={...current,state:encode(summarized.content).toString('base64')};
      assert.equal(service.validateImport([richState],[summarized])[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.equal(service.validateImport([{...richState,schemaVersion:4}],[summarized])[0].schemaVersion,COLLABORATION_SCHEMA);
      assert.throws(()=>service.validateImport([{...richState,schemaVersion:3}],[summarized]),(error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
      const pinned = document('doc-c', f.contents.normalize({type:'doc', content:[pinnedInclude()]}).content);
      const pinnedState = {...current, state:encode(pinned.content).toString('base64')};
      const revisionOwner = (id: string) => id === 'revision-test' ? 'doc-b' : undefined;
      assert.equal(documentContentSchemaVersion(pinned.content), 5);
      assert.deepEqual(documentRevisionIncludes(pinned.content), [{documentId:'doc-b', revisionId:'revision-test'}]);
      assert.deepEqual(contentReferences(pinned.content), [{type:'document', id:'doc-b', kind:'include', label:'검증할 문서 버전', revisionId:'revision-test'}]);
      assert.equal(service.validateImport([pinnedState], [pinned], undefined, revisionOwner)[0].schemaVersion, COLLABORATION_SCHEMA);
      assert.equal(service.validateImport([{...pinnedState,schemaVersion:5}], [pinned], undefined, revisionOwner)[0].schemaVersion, COLLABORATION_SCHEMA);
      assert.throws(()=>service.validateImport([{...pinnedState,schemaVersion:4}], [pinned], undefined, revisionOwner),
        (error:unknown)=>error instanceof CollaborationError&&error.code==='SCHEMA_MISMATCH');
      const decorated = document('doc-c', f.contents.normalize({ type: 'doc', content: [
        { type: 'callout', attrs: { title: '배포' }, content: [{ type: 'paragraph', content: [{ type: 'statusBadge', attrs: { label: '검증 중' } }] }] },
      ] }).content);
      const decoratedState = { ...current, state: encode(decorated.content).toString('base64') };
      assert.equal(service.validateImport([decoratedState], [decorated])[0].schemaVersion, COLLABORATION_SCHEMA);
      assert.equal(service.validateImport([{ ...decoratedState, schemaVersion: 6 }], [decorated])[0].schemaVersion, COLLABORATION_SCHEMA);
      assert.throws(() => service.validateImport([{ ...decoratedState, schemaVersion: 5 }], [decorated]),
        (error: unknown) => error instanceof CollaborationError && error.code === 'SCHEMA_MISMATCH');
      const anchored = document('doc-c', normalizeDocumentContent({ type: 'doc', content: [heading('연결할 절', 'section')] }).content);
      const anchoredState = { ...current, state: encode(anchored.content).toString('base64') };
      assert.equal(service.validateImport([anchoredState], [anchored])[0].schemaVersion, COLLABORATION_SCHEMA);
      assert.throws(() => service.validateImport([{ ...anchoredState, schemaVersion: 6 }], [anchored]),
        (error: unknown) => error instanceof CollaborationError && error.code === 'SCHEMA_MISMATCH');
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

test('live updates validate references/includes before durable ACK and reject v1 through v6 protocol clients',async()=>{
  const f=fixture(),service=new CollaborationService(f.store,f.contents),server=createServer();service.attachWebSocket(server);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No server address');const url=`ws://127.0.0.1:${address.port}/api/collaboration?documentId=doc-a&actorId=user-test`;const peers:Peer[]=[];
  try{
    const session=service.enable('doc-a',1,'user-test');
    for(const schemaVersion of [1,2,3,4,5,6]){
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
      const clean=new Y.Doc();Y.applyUpdate(clean,Buffer.from(welcome.update,'base64'));
      try {
        const reference = new Y.XmlElement('documentReference');
        reference.setAttribute('documentId','doc-b');
        reference.setAttribute('label','관련 설계');
        let accepted:Uint8Array|undefined;
        clean.on('update',value=>{accepted=value;});
        clean.getXmlFragment('default').insert(1,[reference]);
        peer.send({type:'update',epoch:session.epoch,requestId:'valid-reference',update:Buffer.from(accepted!).toString('base64')});
        const ack = await peer.next('ack');
        assert.equal(ack.requestId,'valid-reference');
        assert.ok(ack.document.plainText.includes('관련 설계'));
        assert.equal(JSON.stringify(ack.document.content),JSON.stringify(f.contents.normalize(yDocToProsemirrorJSON(clean,'default')).content));
        assert.equal(service.session('doc-a').document.version,session.document.version+1);

        const revision: DocRevision = {id:'revision-test',documentId:'doc-b',version:1,title:'고정할 설계',content:body(),
          plainText:'원본',authorId:'user-test',createdAt:now,summary:'합성 저장본'};
        f.store.put('revisions', revision);
        const pin = new Y.XmlElement('documentRevisionInclude');
        for (const [key, value] of Object.entries(pinnedInclude().attrs!)) pin.setAttribute(key, String(value));
        clean.getXmlFragment('default').insert(2,[pin]);
        peer.send({type:'update',epoch:session.epoch,requestId:'valid-pin',update:Buffer.from(accepted!).toString('base64')});
        const pinnedAck = await peer.next('ack');
        assert.equal(pinnedAck.requestId,'valid-pin');
        assert.deepEqual(pinnedAck.document.content.content?.at(-1), pinnedInclude());
        assert.match(pinnedAck.document.plainText, /revision-test/);
        assert.deepEqual(service.session('doc-a').document, pinnedAck.document);
      } finally { clean.destroy(); }
    }finally{ydoc.destroy();}
  }finally{for(const peer of peers)peer.ws.terminate();service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
