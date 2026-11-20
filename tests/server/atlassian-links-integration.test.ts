import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { AtlassianLink, AtlassianLinkPreview } from '../../shared/atlassian-links.js';
import type { ApiKeyCreated, DocPage, Issue, WorkspaceSnapshot } from '../../shared/types.js';

type Export = WorkspaceSnapshot & { schemaVersion: number; atlassianLinks: AtlassianLink[] };
const linksRoute = '/atlassian-links';
const previewRoute = (id: string) => `${linksRoute}/${id}/preview`;
const targetRoute = (targetType: string, targetId: string) => `${linksRoute}?${new URLSearchParams({targetType,targetId})}`;

function scratch(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-atlassian-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function appFixture(t: TestContext, directory: string, atlassianEnv: NodeJS.ProcessEnv = {NODE_ENV:'test'}) {
  const app = createApp({ dataDir: join(directory, 'data'), outboundWorker: false, atlassianEnv });
  const listener = app.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    app.close();
  });
  async function call<T = unknown>(path: string, method = 'GET', payload?: unknown, status = 200, token?: string) {
    const response = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', 'X-Actor-Id': 'user-min', ...(token ? {Authorization:`Bearer ${token}`} : {}),
    }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return { base, call };
}

test('linked Jira and Confluence metadata is fetched on demand from the configured read-only instance', async t => {
  const directory = scratch(t);
  const jiraSecret = 'mock-jira-private-credential';
  const wikiSecret = 'mock-wiki-private-credential';
  const jiraAuth = `Bearer ${jiraSecret}`;
  const wikiAuth = `Basic ${Buffer.from(`readonly-user:${wikiSecret}`).toString('base64')}`;
  const requests: { method: string | undefined; url: string; authorization: string | undefined }[] = [];
  const slowReadStarted=Promise.withResolvers<void>();
  const finishSlowRead=Promise.withResolvers<void>();
  const origin = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push({method:req.method,url:url.pathname+url.search,authorization:req.headers.authorization});
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/jira/rest/api/2/issue/LEG-17') {
      res.end(JSON.stringify({ key:'LEG-17',fields:{summary:'원본 Jira 티켓',status:{name:'진행 중'},updated:'2026-11-20T00:00:00.000+0000',description:jiraSecret} }));
    } else if (url.pathname === '/wiki/rest/api/content/1234') {
      res.end(JSON.stringify({ id:'1234',type:'page',status:'current',title:'원본 Confluence 문서',space:{key:'TEAM'},version:{number:7,when:'2026-11-20T01:00:00.000Z'},body:{storage:{value:wikiSecret}} }));
    } else if (url.pathname === '/jira/rest/api/2/issue/LEG-19') {
      slowReadStarted.resolve();
      void finishSlowRead.promise.then(()=>res.end(JSON.stringify({ key:'LEG-19',fields:{summary:'제거된 링크의 원본 제목'} })));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => origin.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  const jiraFile = join(directory,'jira-auth'), wikiFile = join(directory,'wiki-auth');
  writeFileSync(jiraFile, jiraAuth+'\n', {mode:0o600});
  writeFileSync(wikiFile, wikiAuth+'\n', {mode:0o600});
  const {call,base:apiBase} = await appFixture(t, directory, {
    NODE_ENV:'test',
    TEAMSPACE_JIRA_BASE_URL:base+'/jira', TEAMSPACE_JIRA_AUTH_FILE:jiraFile,
    TEAMSPACE_CONFLUENCE_BASE_URL:base+'/wiki', TEAMSPACE_CONFLUENCE_AUTH_FILE:wikiFile,
  });
  const before = await call<WorkspaceSnapshot>('/workspace');
  const jira = await call<AtlassianLink>(linksRoute,'POST',{targetType:'issue',targetId:'issue-1',product:'jira',url:base+'/jira/browse/LEG-17?focusedCommentId=9#comments'},201);
  const wiki = await call<AtlassianLink>(linksRoute,'POST',{targetType:'document',targetId:'doc-overview',product:'confluence',url:base+'/wiki/pages/viewpage.action?pageId=1234#approval'},201);
  assert.equal(jira.url,base+'/jira/browse/LEG-17');
  assert.equal(wiki.url,base+'/wiki/pages/viewpage.action?pageId=1234');
  assert.deepEqual(await call(targetRoute('issue','issue-1')),[jira]);
  assert.deepEqual(await call(targetRoute('document','doc-overview')),[wiki]);
  assert.deepEqual(await call(targetRoute('issue','issue-2')),[]);
  assert.deepEqual(await call(linksRoute,'POST',{targetType:'issue',targetId:'issue-1',product:'jira',url:jira.url},201),jira);
  assert.equal(requests.length,0);

  const jiraView = await call<AtlassianLinkPreview>(previewRoute(jira.id));
  const wikiView = await call<AtlassianLinkPreview>(previewRoute(wiki.id));
  assert.equal(jiraView.title,'원본 Jira 티켓');
  assert.equal(jiraView.status,'진행 중');
  assert.equal(jiraView.locator,'LEG-17');
  assert.equal(wikiView.title,'원본 Confluence 문서');
  assert.ok(wikiView.locator);
  assert.deepEqual(requests.map(value=>[value.method,value.url.split('?')[0],value.authorization]),[
    ['GET','/jira/rest/api/2/issue/LEG-17',jiraAuth],['GET','/wiki/rest/api/content/1234',wikiAuth],
  ]);
  const bad = await call<AtlassianLink>(linksRoute,'POST',{targetType:'issue',targetId:'issue-2',product:'jira',url:base+'/other/browse/LEG-17'},201);
  await call(previewRoute(bad.id),'GET',undefined,403);
  assert.equal(requests.length,2);
  const payload = JSON.stringify([await call<Export>('/export'), jiraView, wikiView]);
  assert.ok(!payload.includes(jiraSecret)&&!payload.includes(wikiSecret)&&!payload.includes(wikiAuth));
  const after = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues,before.issues);
  assert.deepEqual(after.documents,before.documents);

  const slow = await call<AtlassianLink>(linksRoute,'POST',{targetType:'issue',targetId:'issue-2',product:'jira',url:base+'/jira/browse/LEG-19'},201);
  const pending=fetch(apiBase+previewRoute(slow.id));
  try {
    await Promise.race([slowReadStarted.promise,pending.then(()=>{throw new Error('원본 지연 검증에서 조회가 먼저 종료되었습니다.');})]);
    await call(`${linksRoute}/${slow.id}`,'DELETE',undefined,204);
  } finally { finishSlowRead.resolve(); }
  const deleted=await pending;
  assert.equal(deleted.status,404);
  assert.ok(!(await deleted.text()).includes('제거된 링크의 원본 제목'));
});

test('external links suffice without remote setup and survive trash and schema 27 backup, with rollback on invalid restore', async t => {
  const {call} = await appFixture(t,scratch(t));
  const issue = await call<Issue>('/issues','POST',{projectId:'project-neo',title:'이관 기간 업무 연결'},201);
  const document = await call<DocPage>('/documents','POST',{projectId:'project-neo',title:'이관 기간 문서 연결'},201);
  const jira = await call<AtlassianLink>(linksRoute,'POST',{targetType:'issue',targetId:issue.id,product:'jira',url:'https://jira.example.test/browse/EXT-1'},201);
  const confluence = await call<AtlassianLink>(linksRoute,'POST',{targetType:'document',targetId:document.id,product:'confluence',url:'https://wiki.example.test/display/TEAM/Release+Notes'},201);
  const unconfigured = await call<{error:string}>(previewRoute(confluence.id),'GET',undefined,409);
  assert.match(unconfigured.error,/설정|주소/u);
  const {token} = await call<ApiKeyCreated>('/api-keys','POST',{name:'범위 키',access:'write',projectIds:['project-neo']},201);
  await call('/v1'+targetRoute('issue',issue.id),'GET',undefined,403,token);
  await call('/v1'+previewRoute(jira.id),'GET',undefined,403,token);
  const archive = await call<{trashEntryId:string}>(`/issues/${issue.id}`,'DELETE');
  await call(targetRoute('issue',issue.id),'GET',undefined,404);
  await call(previewRoute(jira.id),'GET',undefined,404);
  const backup = await call<Export>('/export');
  assert.equal(backup.schemaVersion,27);
  assert.deepEqual(new Set(backup.atlassianLinks.map(link=>link.id)),new Set([jira.id,confluence.id]));

  const damaged = {...backup,atlassianLinks:backup.atlassianLinks.map(link=>link.id===jira.id?{...link,targetId:'missing-issue'}:link)};
  await call('/import','POST',{data:damaged},400);
  await call('/import','POST',{data:{...backup,schemaVersion:26}},400);
  assert.deepEqual(await call(targetRoute('document',document.id)),[confluence]);
  await call('/import','POST',{data:backup});
  await call(`/trash/${archive.trashEntryId}/restore`,'POST');
  assert.deepEqual(await call(targetRoute('issue',issue.id)),[jira]);
  const again = await call<{trashEntryId:string}>(`/issues/${issue.id}`,'DELETE');
  await call(`/trash/${again.trashEntryId}`,'DELETE');
  assert.deepEqual((await call<Export>('/export')).atlassianLinks,[confluence]);
  await call(`${linksRoute}/${confluence.id}`,'DELETE',undefined,204);
  assert.deepEqual(await call(targetRoute('document',document.id)),[]);
});
