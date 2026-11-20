import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { AttachmentFiles } from '../../server/attachments.js';

async function fixture(dataDir?:string,seed=true){
  const dir=dataDir||mkdtempSync(join(tmpdir(),'teamspace-test-'));
  const service=createApp({dataDir:dir,seed});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as any};};
  return{dir,base,request,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));service.close();},remove:()=>rmSync(dir,{recursive:true,force:true})};
}
test('persisted tickets, version conflicts, parent validation and actor attribution',async()=>{
 const f=await fixture();try{
  const s=(await f.request('/workspace')).data;assert.equal(s.issues.length,12);assert.equal(s.documents.length,4);assert.equal(s.projects.length,2);
  const created=await f.request('/issues','POST',{projectId:'project-neo',title:'저장 확인',startDate:'2026-11-18',endDate:'2026-11-20'});assert.equal(created.status,201);assert.equal(created.data.key,'NEO-9');
  assert.equal((await f.request('/issues/'+created.data.id,'PATCH',{title:'버전 누락'})).status,400);
  const edited=await f.request('/issues/'+created.data.id,'PATCH',{title:'수정한 업무',expectedVersion:1},{'X-Actor-Id':'user-seo'});assert.equal(edited.status,200);assert.equal(edited.data.version,2);
  assert.equal((await f.request('/issues/'+created.data.id,'PATCH',{title:'충돌',expectedVersion:1})).status,409);
  assert.equal((await f.request('/issues/'+created.data.id,'PATCH',{parentId:created.data.id,expectedVersion:2})).status,400);
  assert.equal((await f.request('/issues/'+created.data.id,'PATCH',{startDate:'2026-02-30',expectedVersion:2})).status,400);
  assert.equal((await f.request('/issues/'+created.data.id,'PATCH',{title:'누구?',expectedVersion:2},{'X-Actor-Id':'missing'})).status,400);
  const after=(await f.request('/workspace')).data;assert.equal(after.activities.at(-1).actorId,'user-seo');
  await f.close();const next=await fixture(f.dir);try{assert.equal((await next.request('/workspace')).data.issues.find((i:any)=>i.id===created.data.id).title,'수정한 업무');}finally{await next.close();}
 }finally{try{await f.close();}catch{}f.remove();}
});
test('documents derive searchable text, preserve revisions and restore by new version',async()=>{
 const f=await fixture();try{
  const made=await f.request('/documents','POST',{projectId:'project-neo',title:'회의 결정',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'검색 가능한 원문'}]}]}},{'X-Actor-Id':'user-jun'});assert.equal(made.status,201);assert.equal(made.data.authorId,'user-jun');assert.match(made.data.plainText,/검색 가능한 원문/);
  const id=made.data.id;const revisions=(await f.request(`/documents/${id}/revisions`)).data;assert.equal(revisions.length,1);
  const edit=await f.request(`/documents/${id}`,'PATCH',{title:'바뀐 제목',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'새 내용'}]}]},expectedVersion:1});assert.equal(edit.data.version,2);
  assert.equal((await f.request(`/documents/${id}/restore`,'POST',{revisionId:revisions[0].id,expectedVersion:1})).status,409);
  const restored=await f.request(`/documents/${id}/restore`,'POST',{revisionId:revisions[0].id,expectedVersion:2});assert.equal(restored.status,200);assert.equal(restored.data.version,3);assert.equal(restored.data.title,'회의 결정');
  assert.equal((await f.request('/search?q='+encodeURIComponent('검색 가능한 원문'))).data.documents.length,1);
  assert.equal((await f.request(`/documents/${id}/revisions`)).data.length,3);
  assert.equal((await f.request('/comments','POST',{resourceType:'document',resourceId:id,body:'검토했습니다.'})).status,201);
  assert.equal((await f.request(`/comments?resourceType=document&resourceId=${id}`)).data.length,1);
 }finally{await f.close();f.remove();}
});
test('FS graph prevents cycles and cross-project dependencies; deletion cascades links',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('/dependencies','POST',{predecessorId:'issue-6',successorId:'issue-2'})).status,400);
  assert.equal((await f.request('/dependencies','POST',{predecessorId:'issue-1',successorId:'issue-10'})).status,400);
  assert.equal((await f.request('/dependencies','POST',{predecessorId:'issue-3',successorId:'issue-4',lagDays:1})).status,201);
  assert.equal((await f.request('/issues/issue-1','DELETE')).status,409);
  assert.equal((await f.request('/issues/issue-2','DELETE')).status,200);
  const s=(await f.request('/workspace')).data;assert.ok(!s.dependencies.some((x:any)=>x.predecessorId==='issue-2'));assert.ok(!s.resourceLinks.some((x:any)=>x.issueId==='issue-2'));
 }finally{await f.close();f.remove();}
});
test('schedule preview, atomic apply rollback and conflict-safe undo',async()=>{
 const f=await fixture();try{
  const make=async(title:string)=> (await f.request('/issues','POST',{projectId:'project-team',title,startDate:'2026-11-20',endDate:'2026-11-23'})).data;
  const a=await make('일정 A'),b=await make('일정 B');
  const beforeActivities=(await f.request('/workspace')).data.activities.length;
  const preview=await f.request('/schedule/preview','POST',{issueIds:[a.id,b.id],days:1,workingDays:true});assert.equal(preview.data.changes[0].toStart,'2026-11-23');assert.equal(preview.data.changes[0].toEnd,'2026-11-24');
  const bad=await f.request('/schedule/apply','POST',{changes:[{id:a.id,expectedVersion:1,startDate:'2026-11-23',endDate:'2026-11-24'},{id:b.id,expectedVersion:999,startDate:'2026-11-23',endDate:'2026-11-24'}]});assert.equal(bad.status,409);
  assert.equal((await f.request('/workspace')).data.issues.find((x:any)=>x.id===a.id).version,1);
  assert.equal((await f.request('/workspace')).data.activities.length,beforeActivities);
  const apply=await f.request('/schedule/apply','POST',{changes:preview.data.changes.map((c:any)=>({id:c.id,expectedVersion:c.version,startDate:c.toStart,endDate:c.toEnd}))});assert.equal(apply.status,200);assert.equal(apply.data.updated.length,2);
  assert.equal((await f.request('/workspace')).data.activities.filter((x:any)=>x.resourceType==='issue'&&x.action==='일정 변경'&&[a.id,b.id].includes(x.resourceId)).length,2);
  const undo=await f.request('/schedule/undo','POST',{undoId:apply.data.undoId});assert.equal(undo.status,200);assert.equal(undo.data.updated[0].startDate,'2026-11-20');assert.equal(undo.data.updated[0].version,3);
  assert.equal((await f.request('/workspace')).data.activities.filter((x:any)=>x.resourceType==='issue'&&x.action==='일정 되돌리기'&&[a.id,b.id].includes(x.resourceId)).length,2);
  assert.equal((await f.request('/schedule/undo','POST',{undoId:apply.data.undoId})).status,409);
  const again=await f.request('/schedule/apply','POST',{changes:[{id:a.id,expectedVersion:3,startDate:null,endDate:'2026-11-24'}]});assert.equal(again.status,200);
  await f.request(`/issues/${a.id}`,'PATCH',{expectedVersion:4,title:'일정 이후 편집'});
  assert.equal((await f.request('/schedule/undo','POST',{undoId:again.data.undoId})).status,409);
 }finally{await f.close();f.remove();}
});

const onePixelPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==','base64');
async function upload(f:Awaited<ReturnType<typeof fixture>>,bytes:Buffer,filename:string,resourceType='issue',resourceId='issue-1',type='application/octet-stream'){
 const response=await fetch(`${f.base}/api/attachments?${new URLSearchParams({resourceType,resourceId,filename})}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Type':type,'X-Actor-Id':'user-seo'},body:Uint8Array.from(bytes).buffer});
 return{status:response.status,data:await response.json() as any};
}
test('attachments persist bytes and hashes, reject unsafe names and oversized uploads, and control image inline serving',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('팀 검증 결과\n바이너리\0보존','utf8');
  const made=await upload(f,bytes,'검증 보고서.txt');assert.equal(made.status,201);assert.equal(made.data.authorId,'user-seo');assert.equal(made.data.size,bytes.length);assert.equal(made.data.sha256,createHash('sha256').update(bytes).digest('hex'));
  const listed=await f.request('/attachments?resourceType=issue&resourceId=issue-1');assert.equal(listed.data.length,1);
  const download=await fetch(`${f.base}/api/attachments/${made.data.id}/content`);assert.equal(download.status,200);assert.match(download.headers.get('Content-Disposition')!,/attachment;.*filename\*=UTF-8''/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.equal(download.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal((await fetch(`${f.base}/api/attachments/${made.data.id}/content?inline=1`)).status,415);
  const image=await upload(f,onePixelPng,'화면.png','document','doc-overview','image/png');assert.equal(image.status,201);assert.equal(image.data.mimeType,'image/png');
  const inline=await fetch(`${f.base}/api/attachments/${image.data.id}/content?inline=1`);assert.equal(inline.headers.get('Content-Type'),'image/png');assert.match(inline.headers.get('Content-Disposition')!,/^inline;/);assert.deepEqual(Buffer.from(await inline.arrayBuffer()),onePixelPng);
  const spoof=await upload(f,Buffer.from('<svg onload="alert(1)"></svg>'),'가짜.svg','issue','issue-1','image/png');assert.equal(spoof.data.mimeType,'application/octet-stream');assert.equal((await fetch(`${f.base}/api/attachments/${spoof.data.id}/content?inline=1`)).status,415);
  for(const filename of ['../escape.txt','sub/file.txt','sub\\file.txt','bad\r\nname.txt'])assert.equal((await upload(f,bytes,filename)).status,400);
  assert.equal((await upload(f,bytes,'없는 대상.txt','issue','missing')).status,404);
  assert.equal((await upload(f,Buffer.alloc(0),'empty.txt')).status,400);
  assert.equal((await upload(f,Buffer.alloc(20*1024*1024+1,97),'too-big.bin')).status,413);
  assert.equal((await f.request('/attachments/'+made.data.id,'DELETE')).status,200);assert.equal(existsSync(join(f.dir,'uploads',made.data.id)),false);assert.equal((await fetch(`${f.base}/api/attachments/${made.data.id}/content`)).status,404);
  assert.equal((await f.request('/documents/doc-retry','DELETE')).status,200);
  await f.request('/issues/issue-2','DELETE');
  assert.equal((await f.request('/attachments?resourceType=issue&resourceId=issue-1')).data.length,1);
 }finally{await f.close();f.remove();}
});
test('native export/import includes exact attachment bytes and accepts legacy schema2 while rolling back invalid packages',async()=>{
 const f=await fixture();try{
  const a=await upload(f,Buffer.from('보존할 첨부파일'),'설계.txt');const b=await upload(f,onePixelPng,'image.png','document','doc-retry','image/png');
  const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,28);assert.equal(exported.attachments.length,2);assert.equal(exported.attachmentContents.find((x:any)=>x.id===b.data.id).data,onePixelPng.toString('base64'));
  const extra=await upload(f,Buffer.from('나중 파일'),'later.txt','issue','issue-2');
  const corrupt=structuredClone(exported);corrupt.attachmentContents[0].data=Buffer.from('손상됨').toString('base64');assert.equal((await f.request('/import','POST',{data:corrupt})).status,400);
  assert.equal(existsSync(join(f.dir,'uploads',extra.data.id)),true);assert.deepEqual(readFileSync(join(f.dir,'uploads',b.data.id)),onePixelPng);
  const badTarget=structuredClone(exported);badTarget.attachments[0].resourceId='missing';assert.equal((await f.request('/import','POST',{data:badTarget})).status,404);assert.equal(existsSync(join(f.dir,'uploads',extra.data.id)),true);assert.equal((await f.request('/attachments?resourceType=issue&resourceId=issue-2')).data.length,1);
  assert.ok(!readdirSync(f.dir).some(name=>name.startsWith('.uploads-')));
  const imported=await f.request('/import','POST',{data:exported});assert.equal(imported.status,200);assert.equal(imported.data.counts.attachments,2);assert.equal(existsSync(join(f.dir,'uploads',extra.data.id)),false);
  const download=await fetch(`${f.base}/api/attachments/${b.data.id}/content?inline=1`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),onePixelPng);
  const schema2=structuredClone(exported);schema2.schemaVersion=2;delete schema2.workflows;delete schema2.savedViews;delete schema2.collabStates;assert.equal((await f.request('/import','POST',{data:schema2})).status,200);const legacyDownload=await fetch(`${f.base}/api/attachments/${b.data.id}/content`);assert.equal(legacyDownload.status,200);assert.deepEqual(Buffer.from(await legacyDownload.arrayBuffer()),onePixelPng);
  const documentTrash=(await f.request('/documents/doc-retry','DELETE')).data.trashEntryId;
  assert.equal(existsSync(join(f.dir,'uploads',b.data.id)),true);
  assert.equal((await fetch(`${f.base}/api/attachments/${b.data.id}/content`)).status,404);
  assert.equal((await f.request(`/trash/${documentTrash}`,'DELETE')).status,200);
  assert.equal(existsSync(join(f.dir,'uploads',b.data.id)),false);
  const issueFile=await upload(f,Buffer.from('parent cleanup'),'cleanup.txt','issue','issue-2');
  const issueTrash=(await f.request('/issues/issue-2','DELETE')).data.trashEntryId;
  assert.equal(existsSync(join(f.dir,'uploads',issueFile.data.id)),true);
  assert.equal((await f.request(`/trash/${issueTrash}`,'DELETE')).status,200);
  assert.equal(existsSync(join(f.dir,'uploads',issueFile.data.id)),false);
  writeFileSync(join(f.dir,'uploads',a.data.id),Buffer.from('disk corruption'));assert.equal((await f.request('/export')).status,503);
  const legacy=structuredClone(exported);legacy.schemaVersion=1;delete legacy.attachments;delete legacy.attachmentContents;assert.equal((await f.request('/import','POST',{data:legacy})).status,200);assert.equal((await f.request('/attachments?resourceType=issue&resourceId=issue-1')).data.length,0);
 }finally{await f.close();f.remove();}
});
test('complete attachment export refuses a package larger than64MiB without silently omitting bytes',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.alloc(16*1024*1024,97);
  for(let i=0;i<3;i++)assert.equal((await upload(f,bytes,`large-${i}.bin`)).status,201);
  const result=await f.request('/export');assert.equal(result.status,413);assert.match(result.data.error,/64MiB/);
  assert.equal((await f.request('/attachments?resourceType=issue&resourceId=issue-1')).data.length,3);
 }finally{await f.close();f.remove();}
});
test('attachment import journal recovers precommit rollback and postcommit cleanup on process reopen',async()=>{
 for(const committed of [false,true]){
  const f=await fixture();let reopened:Awaited<ReturnType<typeof fixture>>|undefined;
  try{
   const original=Buffer.from('old attachment'),replacement=Buffer.from('new attachment after import');
   const made=await upload(f,original,'recovery.txt');assert.equal(made.status,201);await f.close();
   const store=new Store(f.dir),files=new AttachmentFiles(f.dir);
   const updated={...made.data,size:replacement.length,sha256:createHash('sha256').update(replacement).digest('hex')};
   const stage=files.stageImport([updated],[{id:updated.id,data:replacement.toString('base64')}]);const generation=randomUUID();
   store.db.exec('BEGIN IMMEDIATE');store.put('attachments',updated);store.setSetting('attachmentImportGeneration',generation);files.swapImport(stage,generation);
   store.db.exec(committed?'COMMIT':'ROLLBACK');store.db.close();
   assert.equal(existsSync(join(f.dir,'.attachments-import.json')),true);
   reopened=await fixture(f.dir);const response=await fetch(`${reopened.base}/api/attachments/${updated.id}/content`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),committed?replacement:original);
   const metadata=(await reopened.request('/attachments?resourceType=issue&resourceId=issue-1')).data[0];assert.equal(metadata.sha256,committed?updated.sha256:made.data.sha256);
   assert.equal(existsSync(join(f.dir,'.attachments-import.json')),false);assert.ok(!readdirSync(f.dir).some(name=>name.startsWith('.uploads-')));
  }finally{if(reopened)await reopened.close();try{await f.close();}catch{}f.remove();}
 }
});
test('native schema export/import restores relations and validates atomically without secrets',async()=>{
 const f=await fixture();try{
  const exported=(await f.request('/export')).data;
  const broken=structuredClone(exported);broken.issues[0].parentId=broken.issues[0].id;
  assert.equal((await f.request('/import','POST',{data:broken})).status,400);assert.equal((await f.request('/workspace')).data.issues.length,12);
  const brokenLink=structuredClone(exported);brokenLink.resourceLinks[0].documentId='missing';assert.notEqual((await f.request('/import','POST',{data:brokenLink})).status,200);
  assert.equal((await f.request('/import','POST',{data:exported})).status,200);
  assert.equal((await f.request('/issues/issue-1','PATCH',{expectedVersion:1,title:'이전 편집 창'})).status,409);
  assert.equal((await f.request('/issues','POST',{projectId:'project-neo',title:'가져오기 이후 번호'})).data.key,'NEO-9');
  const s=(await f.request('/workspace')).data;assert.equal(s.dependencies.length,2);assert.equal(s.resourceLinks.length,4);
  const renamed=JSON.parse(['user-min','user-seo','user-jun','user-yun'].reduce((value,id)=>value.replaceAll(id,'imported-'+id),JSON.stringify(exported)));
  assert.equal((await f.request('/import','POST',{data:renamed},{'X-Actor-Id':'user-min'})).status,200);
  assert.equal((await f.request('/workspace','GET',undefined,{'X-Actor-Id':'user-min'})).status,200);
  assert.equal((await f.request('/users','POST',{name:'새 팀원',email:'new@example.test'},{'X-Actor-Id':'user-min'})).status,400);
 }finally{await f.close();f.remove();}
});
test('GitLab configured-only sync, encrypted write-only credentials, authenticated idempotent webhooks',async()=>{
 const f=await fixture();const requested:string[]=[];
 const mock=createServer((req,res)=>{requested.push(req.url!);assert.equal(req.headers['private-token'],'mock-private-token');res.setHeader('Content-Type','application/json');if(req.url?.includes('merge_requests'))res.end(JSON.stringify([{id:101,iid:7,title:'NEO-1 연결 검증',source_branch:'feature/NEO-1',state:'merged',web_url:'http://gitlab.test/neo/-/merge_requests/7'}]));else res.end(JSON.stringify([{id:99,ref:'feature/NEO-1',status:'success',web_url:'http://gitlab.test/neo/-/pipelines/99'}]));});mock.listen(0,'127.0.0.1');await once(mock,'listening');
 try{
  assert.equal((await f.request('/integrations/gitlab/sync','POST',{})).status,400);assert.equal(requested.length,0);
  const setup=await f.request('/integrations/gitlab','PATCH',{expectedVersion:1,baseUrl:`http://127.0.0.1:${(mock.address() as any).port}`,projectIds:[42],token:'mock-private-token',webhookSecret:'mock-webhook-secret'});assert.equal(setup.data.tokenConfigured,true);assert.ok(!JSON.stringify(setup.data).includes('mock-private-token'));
  const sync=await f.request('/integrations/gitlab/sync','POST',{});assert.equal(sync.status,200);assert.equal(sync.data.linked,2);assert.equal(requested.length,2);
  let s=(await f.request('/workspace')).data;assert.equal(s.gitlabLinks.length,2);assert.equal(s.issues.find((i:any)=>i.id==='issue-1').status,'in_progress');
  const payload={object_kind:'merge_request',project:{id:42},object_attributes:{id:102,iid:8,title:'NEO-2 웹훅',state:'opened',url:'http://gitlab.test/mr/8'}};
  assert.equal((await f.request('/integrations/gitlab/webhook','POST',payload)).status,401);
  const headers={'X-Gitlab-Token':'mock-webhook-secret','X-Gitlab-Event':'Merge Request Hook','Idempotency-Key':'same-event'};
  assert.equal((await f.request('/integrations/gitlab/webhook','POST',payload,headers)).data.linked,1);
  assert.equal((await f.request('/integrations/gitlab/webhook','POST',payload,headers)).data.duplicate,true);
  assert.ok(!JSON.stringify((await f.request('/export')).data).includes('mock-private-token'));
  const db=readFileSync(join(f.dir,'teamspace.sqlite'));assert.ok(!db.includes(Buffer.from('mock-private-token')));assert.equal(statSync(join(f.dir,'.credential-key')).mode&0o777,0o600);
 }finally{await new Promise<void>(r=>mock.close(()=>r()));await f.close();f.remove();}
});
