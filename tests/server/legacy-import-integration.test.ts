import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync,readFileSync,statSync,writeFileSync,readdirSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { LegacyImportService } from '../../server/legacy-import.js';
import type { LegacyPackageSummary,LegacyRecordPage,LegacyRecord,WorkspaceSnapshot,LegacyDiagnosticPage,LegacyPackageDetail,ApiKeyCreated } from '../../shared/types.js';

const csv=Buffer.from('Issue id,Issue key,Summary,Description,Reporter,Created,Comment\r\n100,OLD-1,한글 원본,"보존할 첫 줄\r\n두 번째 줄",original.author,2020-01-01 12:00:00,"2020-01-02;original.author;보존 댓글"\r\n');
async function fixture(directory?:string){
  const dir=directory||mkdtempSync(join(tmpdir(),'teamspace-legacy-integration-')),service=createApp({dataDir:dir,outboundWorker:false}),server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  async function call<T=unknown>(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json() as T};}
  async function upload(bytes=csv,filename='export.csv',instanceKey='original-jira'){const response=await fetch(`${base}/legacy-import/packages?filename=${encodeURIComponent(filename)}&instanceKey=${encodeURIComponent(instanceKey)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Actor-Id':'user-seo'},body:bytes});return{status:response.status,data:await response.json() as LegacyPackageSummary};}
  return{dir,call,upload,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));service.close();}};
}

test('actual worker analysis persists originals and exact records without changing current business data',async()=>{
  const f=await fixture();try{
    const before=(await f.call<WorkspaceSnapshot>('/workspace')).data,response=await f.upload();assert.equal(response.status,201,JSON.stringify(response.data));const summary=response.data;assert.equal(summary.applySupported,false);assert.equal(summary.source.format,'jira-csv');assert.equal(summary.source.instanceKey,'original-jira');assert.equal(summary.actorId,'user-seo');assert.equal(summary.counts.issue,1);assert.ok(summary.warnings>0);
    const file=join(f.dir,'legacy-imports',summary.id+'.bundle');assert.deepEqual(readFileSync(file),csv);assert.equal(statSync(file).mode&0o777,0o600);assert.equal(summary.sha256,createHash('sha256').update(csv).digest('hex'));
    const after=(await f.call<WorkspaceSnapshot>('/workspace')).data;for(const key of ['users','projects','issues','documents','resourceLinks','dependencies'] as const)assert.deepEqual(after[key],before[key]);assert.equal((await f.call<unknown[]>('/webhook-deliveries')).data.length,0);
    const records=(await f.call<LegacyRecordPage>(`/legacy-import/packages/${summary.id}/records?kind=issue&limit=1&offset=0&q=OLD-1`)).data;assert.equal(records.total,1);assert.equal(records.records.length,1);assert.ok(!Object.hasOwn(records.records[0],'text'));assert.ok(!Object.hasOwn(records.records[0],'metadata'));assert.match(records.records[0].textPreview,/보존할 첫 줄/);
    const record=(await f.call<LegacyRecord>(`/legacy-import/packages/${summary.id}/records/${encodeURIComponent(records.records[0].id)}`)).data;assert.equal(record.text,'보존할 첫 줄\r\n두 번째 줄');assert.equal(record.authorId,'original.author');assert.equal(record.createdAt,'2020-01-01 12:00:00');assert.equal(records.records[0].textBytes,Buffer.byteLength(record.text));
    const diagnostics=(await f.call<LegacyDiagnosticPage>(`/legacy-import/packages/${summary.id}/diagnostics?severity=warning&limit=1`)).data;assert.ok(diagnostics.total>0);assert.equal(diagnostics.diagnostics.length,1);assert.equal(diagnostics.diagnostics[0].severity,'warning');
    const detail=(await f.call<LegacyPackageDetail>(`/legacy-import/packages/${summary.id}`)).data;assert.equal(detail.files[0].sha256,summary.sha256);assert.equal((await f.upload()).status,200);assert.equal((await f.call<LegacyPackageSummary[]>('/legacy-import/packages')).data.length,1);
    const backup=(await f.call<Record<string,unknown>>('/export')).data;assert.ok(!JSON.stringify(backup).includes('보존할 첫 줄'));assert.ok(!Object.hasOwn(backup,'legacyPackages'));assert.equal((await f.call('/import','POST',{data:backup})).status,200);assert.equal((await f.call<LegacyPackageSummary[]>('/legacy-import/packages')).data.length,1);
    await f.close();const reopened=await fixture(f.dir);try{assert.equal((await reopened.call<LegacyPackageSummary[]>('/legacy-import/packages')).data[0].id,summary.id);assert.deepEqual(readFileSync(file),csv);}finally{await reopened.close();}
  }finally{try{await f.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}
});

test('HTTP validation rejects malformed files, unsupported queries and public API key access without persisting sources',async()=>{
  const f=await fixture();try{
    assert.equal((await f.call('/legacy-import/packages','POST',{filename:'not-a-file'})).status,415);assert.equal((await f.upload(Buffer.from('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><entity-engine-xml/>'),'entities.xml')).status,400);assert.equal((await f.upload(Buffer.from('{broken'),'export.json')).status,400);
    assert.equal((await f.upload(csv,'../escape.csv')).status,400);assert.equal((await f.upload(csv,'export.csv','')).status,400);assert.deepEqual(readdirSync(join(f.dir,'legacy-imports')),[]);
    const created=await f.upload(),id=created.data.id;assert.equal(created.status,201);for(const suffix of ['/records?limit=0','/records?offset=-1','/records?limit=2&limit=3','/records?unknown=x','/diagnostics?severity=bad','?unknown=x'])assert.equal((await f.call(`/legacy-import/packages/${id}${suffix}`)).status,400,suffix);
    const key=(await f.call<ApiKeyCreated>('/api-keys','POST',{name:'원본 접근 불가',access:'write',projectIds:null,expiresAt:null})).data;assert.equal((await f.call('/v1/legacy-import/packages','GET',undefined,{Authorization:`Bearer ${key.token}`})).status,403);
    assert.equal((await f.call(`/legacy-import/packages/${id}?expectedVersion=2`,'DELETE')).status,409);assert.ok(existsSync(join(f.dir,'legacy-imports',id+'.bundle')));assert.equal((await f.call(`/legacy-import/packages/${id}?expectedVersion=1`,'DELETE')).status,200);assert.equal((await f.call<LegacyPackageSummary[]>('/legacy-import/packages')).data.length,0);assert.deepEqual(readdirSync(join(f.dir,'legacy-imports')),[]);
  }finally{await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('analysis metadata, audit and original file roll back together; delete audit failure retains exact source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-legacy-rollback-')),store=new Store(dir),service=new LegacyImportService(store,dir);try{
    await assert.rejects(service.upload(csv,{filename:'export.csv',instanceKey:'jira'},'source-actor',()=>{throw new Error('synthetic audit failure');}),/synthetic audit/);assert.equal(service.list().length,0);assert.deepEqual(readdirSync(join(dir,'legacy-imports')),[]);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM legacy_records').get()!.count,0);
    const created=await service.upload(csv,{filename:'export.csv',instanceKey:'jira'},'source-actor');assert.throws(()=>service.remove(created.summary.id,1,()=>{throw new Error('synthetic delete failure');}),/synthetic delete/);assert.equal(service.list().length,1);assert.deepEqual(readFileSync(join(dir,'legacy-imports',created.summary.id+'.bundle')),csv);
  }finally{service.close();store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('worker busy and shutdown guards settle pending requests without accessing a closed store; startup recovers orphans',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamspace-legacy-close-')),store=new Store(dir),service=new LegacyImportService(store,dir);
  try{
    const upload=service.upload(csv,{filename:'export.csv',instanceKey:'jira'},'source-actor');await assert.rejects(service.upload(csv,{filename:'export.csv',instanceKey:'jira-2'},'source-actor'),error=>(error as {status:number}).status===409);service.close();store.db.close();await assert.rejects(upload,error=>(error as {status:number}).status===503);
    const root=join(dir,'legacy-imports'),pending=join(root,randomUUID()+'.pending'),orphan=join(root,randomUUID()+'.bundle');writeFileSync(pending,'uncommitted');writeFileSync(orphan,'orphan');writeFileSync(join(root,'operator-note.txt'),'keep');const nextStore=new Store(dir),next=new LegacyImportService(nextStore,dir);try{assert.equal(existsSync(pending),false);assert.equal(existsSync(orphan),false);assert.equal(readFileSync(join(root,'operator-note.txt'),'utf8'),'keep');}finally{next.close();nextStore.db.close();}
  }finally{service.close();try{store.db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
