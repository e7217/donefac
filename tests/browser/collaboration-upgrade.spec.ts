import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test as base,expect,type APIRequestContext,type Download,type Page } from '@playwright/test';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { createEditorSchema } from '../../shared/editor-schema';
import type { CollaborationSession } from '../../shared/collaboration';
import type { DocPage,RichContent,WorkspaceSnapshot } from '../../shared/types';

interface UpgradeFixture{requests:APIRequestContext;document:DocPage;session:CollaborationSession;actors:string[];titlePrefix:string;serverText:string}
const test=base.extend<{upgrade:UpgradeFixture}>({
  upgrade:[async({playwright,baseURL},provide)=>{
    const requests=await playwright.request.newContext({baseURL}),titlePrefix=`형식 이전 복구 ${randomUUID()}`,serverText='현재 서버에 보관된 문장';
    try{
      const snapshot=await(await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      const response=await requests.post('/api/documents',{data:{projectId:snapshot.projects[0].id,title:`${titlePrefix} 원본`,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:serverText}]}]}}});expect(response.status()).toBe(201);const document=await response.json() as DocPage;
      const enabled=await requests.post(`/api/documents/${document.id}/collaboration/enable`,{data:{expectedVersion:document.version}});expect(enabled.status()).toBe(200);const session=await enabled.json() as CollaborationSession;
      await provide({requests,document,session,actors:snapshot.users.slice(0,2).map(user=>user.id),titlePrefix,serverText});
    }finally{try{const response=await requests.get('/api/workspace',{timeout:5000});if(response.ok()){const data=await response.json() as WorkspaceSnapshot;for(const document of data.documents.filter(document=>document.title.startsWith(titlePrefix))){const deleted=await requests.delete(`/api/documents/${document.id}`,{timeout:5000});expect([200,204,404]).toContain(deleted.status());}}}finally{await requests.dispose();}}
  },{timeout:30000}],
});

function legacyUpdate(text:string,blocks:RichContent[]=[]){const doc=prosemirrorJSONToYDoc(createEditorSchema(),{type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]},...blocks]},'default');try{return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');}finally{doc.destroy();}}
function cache(epoch:string,update:string,updatedAt='2099-01-01T00:00:00.000Z',schemaVersion=1){return JSON.stringify({epoch,schemaVersion,update,pending:true,updatedAt});}
const cacheKey=(actor:string,id:string,epoch:string,version=1)=>`teamspace:collaboration-pending:${actor}:${id}:${epoch}:${version}`;
async function open(page:Page,f:UpgradeFixture,entries:Record<string,string>){await page.addInitScript(({actor,entries})=>{localStorage.setItem('teamspace.actor',actor);for(const[key,value]of Object.entries(entries))localStorage.setItem(key,value);},{actor:f.actors[0],entries});await page.goto(`/#/${f.document.projectId}/documents/${f.document.id}`);await expect(page.getByRole('textbox',{name:'문서 제목',exact:true})).toHaveValue(f.document.title);await expect(page.locator('.docs-collaboration-recovery')).toBeVisible();}
async function stored(page:Page){return page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('teamspace:collaboration-pending:')).map(key=>[key,localStorage.getItem(key)])));}
async function canonical(f:UpgradeFixture){const data=await(await f.requests.get('/api/workspace')).json() as WorkspaceSnapshot;return data.documents.find(document=>document.id===f.document.id)!;}
async function recoveryDownload(download:Download){const path=await download.path();expect(path).not.toBeNull();return JSON.parse(readFileSync(path!,'utf8')) as {update:string;content:unknown;caches:{key:string;value:string}[]};}

test('이전 형식의 미전송 편집을 읽기 전용으로 열고 원본을 유지하며 선택한 보관 데이터만 사본으로 복구한다',async({page,upgrade:f})=>{
  const oldText='형식 1에서 연결 없이 작성한 보존 문장',olderEpoch=randomUUID(),selected=cacheKey(f.actors[0],f.document.id,f.session.epoch!),older=cacheKey(f.actors[0],f.document.id,olderEpoch),otherActor=cacheKey(f.actors[1],f.document.id,f.session.epoch!);
  const entries={[selected]:cache(f.session.epoch!,legacyUpdate(oldText)),[older]:cache(olderEpoch,legacyUpdate('이전 epoch 편집'),'2000-01-01T00:00:00.000Z'),[otherActor]:cache(f.session.epoch!,legacyUpdate('다른 팀원의 편집'))};
  let updateFrames=0;page.on('websocket',socket=>socket.on('framesent',frame=>{try{if(JSON.parse(String(frame.payload)).type==='update')updateFrames++;}catch{/* Other transport frames do not write document content. */}}));
  await open(page,f,entries);await expect(page.locator('.docs-live-prose')).toHaveText(oldText);await expect(page.locator('.docs-live-prose')).toHaveAttribute('contenteditable','false');await expect(page.getByRole('button',{name:'사본으로 보관',exact:true})).toBeEnabled();expect((await canonical(f)).plainText).toBe(f.serverText);expect(await stored(page)).toEqual(entries);
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'최신 문서 열기',exact:true}).click();await expect(page.locator('.docs-live-prose')).toHaveText(oldText);expect(await stored(page)).toEqual(entries);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'복구 데이터 내려받기',exact:true}).click();const exported=await recoveryDownload(await downloading);expect(Object.fromEntries(exported.caches.map(value=>[value.key,value.value]))).toEqual({[selected]:entries[selected],[older]:entries[older]});expect(exported.content).toBeTruthy();expect(await stored(page)).toEqual(entries);
  const copying=page.waitForResponse(response=>response.url().endsWith('/api/documents')&&response.request().method()==='POST');await page.getByRole('button',{name:'사본으로 보관',exact:true}).click();const copied=await(await copying).json() as DocPage;expect(copied.id).not.toBe(f.document.id);expect(copied.plainText).toBe(oldText);await expect(page.getByRole('textbox',{name:'문서 제목',exact:true})).toHaveValue(copied.title);await expect(page.locator('.docs-prose')).toContainText(oldText);expect((await canonical(f)).plainText).toBe(f.serverText);expect(updateFrames).toBe(0);expect(await stored(page)).toEqual({[older]:entries[older],[otherActor]:entries[otherActor]});
});

test('유효하지 않은 이전 형식 보관 데이터는 적용하지 않고 원본 바이트를 내려받을 수 있게 유지한다',async({page,upgrade:f})=>{
  const doc=new Y.Doc(),paragraph=new Y.XmlElement('paragraph'),text=new Y.XmlText();text.insert(0,'유효하지 않은 보관 편집');paragraph.setAttribute('unsupportedAttribute','hidden-data');paragraph.insert(0,[text]);doc.getXmlFragment('default').insert(0,[paragraph]);let update:string;try{update=Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');}finally{doc.destroy();}
  const selected=cacheKey(f.actors[0],f.document.id,f.session.epoch!),entries={[selected]:cache(f.session.epoch!,update!)};
  await open(page,f,entries);await expect(page.getByRole('button',{name:'사본으로 보관',exact:true})).toBeDisabled();await expect(page.locator('.docs-live-prose')).toHaveCount(0);expect((await canonical(f)).plainText).toBe(f.serverText);expect(await stored(page)).toEqual(entries);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'복구 데이터 내려받기',exact:true}).click();const exported=await recoveryDownload(await downloading);expect(exported.caches).toEqual([{key:selected,value:entries[selected]}]);expect(exported.content).toBeNull();const empty=new Y.Doc();try{Y.applyUpdate(empty,Buffer.from(exported.update,'base64'));expect(empty.getXmlFragment('default').length).toBe(0);}finally{empty.destroy();}
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'최신 문서 열기',exact:true}).click();expect(await stored(page)).toEqual(entries);expect((await canonical(f)).plainText).toBe(f.serverText);
});

test('공동 편집 형식 2의 오프라인 편집을 참조 블록과 함께 보존한다',async({page,upgrade:f})=>{
  const text='형식 2에서 오프라인으로 작성한 문장';
  const reference:RichContent={type:'documentReference',attrs:{documentId:f.document.id,label:f.document.title}};
  const oldEpoch=randomUUID();
  const selected=cacheKey(f.actors[0],f.document.id,oldEpoch,2);
  const entries={[selected]:cache(oldEpoch,legacyUpdate(text,[reference]),'2099-01-01T00:00:00.000Z',2)};
  let updateFrames=0;
  page.on('websocket',socket=>socket.on('framesent',frame=>{try{if(JSON.parse(String(frame.payload)).type==='update')updateFrames++;}catch{/* Other frames do not persist document updates. */}}));
  await open(page,f,entries);
  await expect(page.locator('.docs-live-prose')).toContainText(text);
  await expect(page.locator('.docs-live-prose')).toHaveAttribute('contenteditable','false');
  await expect(page.locator('.docs-live-prose')).toContainText(f.document.title);
  expect(await stored(page)).toEqual(entries);

  const copying=page.waitForResponse(response=>response.url().endsWith('/api/documents')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'사본으로 보관',exact:true}).click();
  const copied=await(await copying).json() as DocPage;
  expect(copied.content.content).toContainEqual(reference);
  expect(copied.plainText).toContain(text);
  await expect(page.getByRole('textbox',{name:'문서 제목',exact:true})).toHaveValue(copied.title);
  expect(await stored(page)).toEqual({});
  expect((await canonical(f)).plainText).toBe(f.serverText);
  expect(updateFrames).toBe(0);
});

test('형식 2에서 지원하지 않는 새 업무 목록 보관본은 원본 바이트를 내려받을 수 있다',async({page,upgrade:f})=>{
  const futureBlock:RichContent={type:'issueList',attrs:{projectId:f.document.projectId,savedViewId:null,label:'업무 목록'}};
  const selected=cacheKey(f.actors[0],f.document.id,f.session.epoch!,2);
  const entries={[selected]:cache(f.session.epoch!,legacyUpdate('형식 2로 표기된 원본',[futureBlock]),'2099-01-01T00:00:00.000Z',2)};
  await open(page,f,entries);
  await expect(page.getByRole('button',{name:'사본으로 보관',exact:true})).toBeDisabled();
  await expect(page.locator('.docs-live-prose')).toHaveCount(0);
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'복구 데이터 내려받기',exact:true}).click();
  const exported=await recoveryDownload(await downloading);
  expect(exported.caches).toEqual([{key:selected,value:entries[selected]}]);
  expect(exported.content).toBeNull();
  expect(await stored(page)).toEqual(entries);
  expect((await canonical(f)).plainText).toBe(f.serverText);
});

for (const { version, nodeType, blockLabel } of [
  { version: 3, nodeType: 'issueList', blockLabel: '업무 목록' },
  { version: 4, nodeType: 'issueSummary', blockLabel: '업무 현황' },
] as const) test(`형식 ${version}의 오프라인 편집을 ${blockLabel}과 함께 사본으로 보관한다`, async ({page,upgrade:f}) => {
  const text = `형식 ${version}에서 연결 없이 작성한 회의 메모`;
  const block: RichContent = {type:nodeType,attrs:{projectId:f.document.projectId,savedViewId:null,label:`형식 ${version}에 저장한 업무 범위`,
    ...(nodeType === 'issueSummary' ? { groupBy: 'priority' } : {})}};
  const previous = await canonical(f);
  const oldEpoch = randomUUID();
  const selected = cacheKey(f.actors[0],f.document.id,oldEpoch,version);
  const entries = {[selected]:cache(oldEpoch,legacyUpdate(text,[block]),'2099-01-01T00:00:00.000Z',version)};
  await open(page,f,entries);
  const recovery = page.locator('.docs-live-prose');
  await expect(recovery).toHaveAttribute('contenteditable','false');
  await expect(recovery).toContainText(text);
  await expect(recovery.getByRole('region',{name:blockLabel,exact:true})).toBeVisible();
  expect(await stored(page)).toEqual(entries);

  const copying = page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST');
  await page.getByRole('button',{name:'사본으로 보관',exact:true}).click();
  const result = await copying;
  expect(result.status(),await result.text()).toBe(201);
  const copied = await result.json() as DocPage;
  expect(copied.id).not.toBe(f.document.id);
  expect(copied.content.content).toContainEqual(block);
  expect(copied.plainText).toContain(text);
  await expect(page.getByRole('textbox',{name:'문서 제목',exact:true})).toHaveValue(copied.title);
  expect(await stored(page)).toEqual({});
  expect(await canonical(f)).toEqual(previous);
});

test('형식 7의 미전송 편집을 기존 절 ID와 함께 보관한다', async ({ page, upgrade: f }) => {
  const oldEpoch = randomUUID();
  const version = 7;
  const key = cacheKey(f.actors[0], f.document.id, oldEpoch, version);
  const section: RichContent = { type: 'heading', attrs: { level: 2, sectionId: 'prior-room-section' },
    content: [{ type: 'text', text: '미전송 절' }] };
  const entries = { [key]: cache(oldEpoch, legacyUpdate('보관할 본문', [section]), '2099-01-01T00:00:00.000Z', version) };
  const previous = await canonical(f);
  await open(page, f, entries);
  const recovery = page.locator('.docs-live-prose');
  await expect(recovery).toHaveAttribute('contenteditable', 'false');
  await expect(recovery.getByRole('heading', { name: '미전송 절' })).toHaveAttribute('data-document-section-id', 'prior-room-section');

  const copying = page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '사본으로 보관', exact: true }).click();
  const result = await copying;
  expect(result.status(), await result.text()).toBe(201);
  const copied = await result.json() as DocPage;
  expect(copied.id).not.toBe(f.document.id);
  expect(copied.content.content).toContainEqual(section);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(copied.title);
  expect(await stored(page)).toEqual({});
  expect(await canonical(f)).toEqual(previous);
});
