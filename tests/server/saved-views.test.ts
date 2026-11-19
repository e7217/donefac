import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';

async function fixture(directory?: string) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'teamspace-views-'));
  const runtime = createApp({dataDir:dir});
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const base = `http://127.0.0.1:${address.port}/api`;
  let closed = false;
  return {
    dir,
    async request(path:string, method='GET', body?:unknown) {
      const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Actor-Id':'user-min'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
      // Test requests include both successful resources and intentionally invalid packages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {status:response.status,data:await response.json() as any};
    },
    async close() {if(closed)return;closed=true;await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();},
  };
}
const definition = {projectId:'project-neo',name:'검토 업무',layout:'board',filters:{query:' 오류 ',status:'review',assigneeId:'user-seo',type:'버그'}};

test('saved views preserve real filters across reload and enforce version-safe shared edits',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof fixture>>|undefined;
  try {
    const created=await f.request('/views','POST',definition);assert.equal(created.status,201);assert.equal(created.data.version,1);assert.equal(created.data.filters.query,' 오류 ');
    const id=created.data.id;
    assert.equal((await f.request('/views?projectId=project-neo')).data.length,1);
    assert.equal((await f.request('/views?projectId=project-team')).data.length,0);
    const updated=await f.request('/views/'+id,'PATCH',{expectedVersion:1,name:'검토할 버그',filters:{...definition.filters,query:'연결'}});assert.equal(updated.status,200);assert.equal(updated.data.version,2);
    assert.equal((await f.request('/views/'+id,'PATCH',{expectedVersion:1,name:'오래된 변경'})).status,409);
    assert.equal((await f.request('/views/'+id+'?expectedVersion=1','DELETE')).status,409);
    await f.close();reopened=await fixture(f.dir);
    const persisted=await reopened.request('/views?projectId=project-neo');assert.equal(persisted.data[0].name,'검토할 버그');assert.equal(persisted.data[0].filters.query,'연결');
    assert.equal((await reopened.request('/views/'+id+'?expectedVersion=2','DELETE')).status,200);
    assert.equal((await reopened.request('/views?projectId=project-neo')).data.length,0);
  } finally {if(reopened)await reopened.close();else await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('saved view validation rejects invalid filters and duplicate project names without changing valid views',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/views','POST',definition)).status,201);
    assert.equal((await f.request('/views','POST',definition)).status,409);
    assert.equal((await f.request('/views','POST',{...definition,projectId:'project-team'})).status,201);
    assert.equal((await f.request('/views','POST',{...definition,name:'잘못된 보기',filters:[]})).status,400);
    assert.equal((await f.request('/views','POST',{...definition,name:'없는 담당자',filters:{...definition.filters,assigneeId:'missing'}})).status,400);
    assert.equal((await f.request('/views','POST',{...definition,projectId:'missing'})).status,404);
    assert.equal((await f.request('/views?projectId=project-neo')).data.length,1);
  }finally{await f.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('native backup preserves saved view definitions and rejects bad restore atomically',async()=>{
  const f=await fixture();try{
    const created=await f.request('/views','POST',definition);assert.equal(created.status,201);
    for (const name of ['Ångström','ångström']) assert.equal((await f.request('/views','POST',{...definition,name})).status,201);
    const exported=(await f.request('/export')).data;assert.equal(exported.schemaVersion,19);assert.equal(exported.savedViews.length,3);
    assert.equal((await f.request('/views/'+created.data.id,'PATCH',{expectedVersion:1,name:'임시 변경'})).status,200);
    const bad=structuredClone(exported);bad.savedViews[0].authorId='missing';assert.equal((await f.request('/import','POST',{data:bad})).status,400);
    assert.equal((await f.request('/views?projectId=project-neo')).data.find((view:{id:string})=>view.id===created.data.id).name,'임시 변경');
    assert.equal((await f.request('/import','POST',{data:exported})).status,200);
    const list=(await f.request('/views?projectId=project-neo')).data;assert.equal(list.length,3);
    const restored=list.find((view:{id:string})=>view.id===created.data.id);assert.equal(restored.name,definition.name);assert.deepEqual(restored.filters,definition.filters);assert.ok(restored.version>2);
    assert.equal((await f.request('/views/'+restored.id,'PATCH',{expectedVersion:2,name:'이전 편집'})).status,409);
  }finally{await f.close();rmSync(f.dir,{recursive:true,force:true});}
});
