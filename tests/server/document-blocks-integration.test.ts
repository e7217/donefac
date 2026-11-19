import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { contentMarkdown,contentText } from '../../src/features/document-utils.js';
import { contentReferences } from '../../shared/document-nodes.js';
import type { ApiKeyCreated,DocPage,DocRevision,RichContent,WorkspaceSnapshot } from '../../shared/types.js';
import type { CollaborationSession } from '../../shared/collaboration.js';

type Backup=WorkspaceSnapshot&{schemaVersion:number;collabStates:{documentId:string;schemaVersion:number;state:string}[]};
const p=(text:string):RichContent=>({type:'paragraph',content:[{type:'text',text}]});
const body=(...content:RichContent[]):RichContent=>({type:'doc',content});
const reference=(type:'issueReference'|'documentReference'|'documentInclude',id:string,label:string):RichContent=>({type,attrs:{[type==='issueReference'?'issueId':'documentId']:id,label}});
const details:RichContent={type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'검토 <기준>',marks:[{type:'bold'}]}]},{type:'detailsContent',content:[p('접혀 있어도 보존할 결정')]}]};
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'teamspace-document-integration-'));const service=createApp({dataDir:dir});const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;return{
  async call<T=Record<string,unknown>>(path:string,method='GET',data?:unknown,token?:string){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{'X-Actor-Id':'user-min'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json() as T};},
  async close(){service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});},
};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function make(f:Fixture,title:string,content=body(p('원본')),projectId:string|null='project-neo'){const result=await f.call<DocPage>('/documents','POST',{projectId,title,content});assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
const snapshot=async(f:Fixture)=>(await f.call<WorkspaceSnapshot>('/workspace')).data;

test('manual writes, cycles and live historical restore preserve reference IDs and folded content atomically',async()=>{
  const f=await fixture();try{
    const target=await make(f,'포함할 원본');
    const content=body(p('설계 맥락'),reference('issueReference','issue-1','검증 업무'),reference('documentInclude',target.id,'검토 원문'),details);
    const source=await make(f,'통합 설계',content);assert.deepEqual(source.content,content);assert.match(source.plainText,/접혀 있어도 보존할 결정/);assert.match(source.plainText,/검증 업무/);
    const revisions=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;const original=revisions[0];
    const without=await f.call<DocPage>(`/documents/${source.id}`,'PATCH',{expectedVersion:source.version,content:body(p('포함 관계 변경'))});assert.equal(without.status,200);
    const live=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration/enable`,'POST',{expectedVersion:without.data.version})).data;
    const linked=await f.call(`/documents/${target.id}`,'PATCH',{expectedVersion:target.version,content:body(reference('documentInclude',source.id,'역방향 원문'))});assert.equal(linked.status,200);
    const before=await snapshot(f);assert.equal((await f.call(`/documents/${source.id}/restore`,'POST',{revisionId:original.id,expectedVersion:live.document.version})).status,422);assert.deepEqual(await snapshot(f),before);
    assert.equal((await f.call(`/documents/${target.id}?expectedVersion=2`,'DELETE')).status,200);
    const restored=await f.call<DocPage>(`/documents/${source.id}/restore`,'POST',{revisionId:original.id,expectedVersion:live.document.version});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.deepEqual(restored.data.content,content);
    const session=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration`)).data;assert.notEqual(session.epoch,live.epoch);assert.equal(session.schemaVersion,2);assert.equal(session.document.plainText,restored.data.plainText);
    assert.equal((await f.call('/documents','POST',{projectId:'project-neo',title:'새 누락 참조',content})).status,422);
    const saved=(await f.call<DocRevision[]>(`/documents/${source.id}/revisions`)).data;assert.ok(saved.some(revision=>revision.version===restored.data.version&&revision.summary.includes('복구')));
  }finally{await f.close();}
});

test('scoped automation validates embedded targets and allows unchanged missing historical references',async()=>{
  const f=await fixture();try{
    const own=await make(f,'같은 프로젝트 참조'),other=await make(f,'다른 프로젝트 원문',body(p('다른 프로젝트 본문')),'project-team');
    const key=(await f.call<ApiKeyCreated>('/api-keys','POST',{name:'문서 자동화 검증',access:'write',projectIds:['project-neo'],expiresAt:null})).data;
    for(const type of ['documentReference','documentInclude'] as const)assert.equal((await f.call('/v1/documents','POST',{projectId:'project-neo',title:'범위 우회',content:body(reference(type,other.id,'타 프로젝트'))},key.token)).status,403);
    assert.equal((await f.call('/v1/documents','POST',{projectId:'project-neo',title:'업무 범위 우회',content:body(reference('issueReference','issue-10','다른 프로젝트 업무'))},key.token)).status,403);
    const content=body(reference('documentReference',own.id,'원문 스냅샷 이름'),details);
    const made=await f.call<DocPage>('/v1/documents','POST',{projectId:'project-neo',title:'자동화 문서',content},key.token);assert.equal(made.status,201,JSON.stringify(made.data));
    assert.equal((await f.call(`/documents/${own.id}?expectedVersion=1`,'DELETE')).status,200);
    const changed=await f.call<DocPage>(`/v1/documents/${made.data.id}`,'PATCH',{expectedVersion:made.data.version,content:body(p('기존 누락 링크 유지'),...content.content!)},key.token);assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(contentReferences(changed.data.content)[0].id,own.id);
    const before=await snapshot(f);assert.equal((await f.call(`/v1/documents/${made.data.id}`,'PATCH',{expectedVersion:changed.data.version,content:body(reference('documentReference','new-missing','새 누락'))},key.token)).status,404);assert.deepEqual(await snapshot(f),before);
  }finally{await f.close();}
});

test('native schema7 restores macro JSON and CRDT state with missing targets; invalid cycles and downgraded headers leave data unchanged',async()=>{
  const f=await fixture();try{
    const legacy=(await f.call<Backup>('/export')).data;legacy.schemaVersion=6;
    const target=await make(f,'사라질 원문'),source=await make(f,'포함 기록',body(reference('documentInclude',target.id,'보관할 제목'),details));
    const enabled=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration/enable`,'POST',{expectedVersion:source.version})).data;
    await f.call(`/documents/${target.id}?expectedVersion=1`,'DELETE');
    const backup=(await f.call<Backup>('/export')).data;assert.equal(backup.schemaVersion,19);assert.equal(backup.collabStates.find(state=>state.documentId===source.id)!.schemaVersion,2);
    const current=await snapshot(f),bad=structuredClone(backup);bad.documents.find(document=>document.id===source.id)!.content=body(reference('documentInclude',source.id,'순환'));
    assert.equal((await f.call('/import','POST',{data:bad})).status,422);assert.deepEqual(await snapshot(f),current);
    const downgraded={...backup,schemaVersion:6};assert.equal((await f.call('/import','POST',{data:downgraded})).status,400);assert.deepEqual(await snapshot(f),current);
    assert.equal((await f.call('/import','POST',{data:backup})).status,200);const restored=(await f.call<CollaborationSession>(`/documents/${source.id}/collaboration`)).data;assert.deepEqual(restored.document.content,enabled.document.content);assert.notEqual(restored.epoch,enabled.epoch);assert.ok(restored.document.version>enabled.document.version);
    assert.equal((await f.call('/import','POST',{data:legacy})).status,200);assert.equal((await snapshot(f)).documents.length,legacy.documents.length);
  }finally{await f.close();}
});

test('document Markdown preserves reference destinations and folded content without expanding live includes',()=>{
  const content=body(reference('issueReference','ticket/a?b','업무 [검토]'),reference('documentReference','doc/a','원문'),reference('documentInclude','included','실시간 원문'),details);
  const markdown=contentMarkdown(content);assert.ok(markdown.includes('#/all/issues?issue=ticket%2Fa%3Fb'));assert.ok(markdown.includes('#/all/documents/doc%2Fa'));assert.ok(markdown.includes('문서 포함:'));assert.ok(markdown.includes('<details>'));assert.ok(markdown.includes('<summary><strong>검토 &lt;기준&gt;</strong></summary>'));assert.ok(markdown.includes('접혀 있어도 보존할 결정'));assert.equal(contentReferences(content).length,3);assert.ok(contentText(content).includes('included'));
  assert.equal(contentText(body(p('마지막 공백  '))),'마지막 공백  ');assert.equal(contentText(body(p('원문'),{type:'paragraph'})),'원문\n');
});
