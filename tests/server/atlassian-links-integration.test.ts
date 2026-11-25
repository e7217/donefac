import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { AtlassianLink, AtlassianLinkPreview } from '../../shared/atlassian-links.js';
import type { AtlassianSearchTarget } from '../../shared/atlassian-search.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { ApiKeyCreated, Comment, DocPage, DocumentTreeMovePreview, Issue, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, ProjectIssueSchema, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types.js';

type Export = WorkspaceSnapshot & { schemaVersion: number; atlassianLinks: AtlassianLink[] };
const linksRoute = '/atlassian-links';
const previewRoute = (id: string) => `${linksRoute}/${id}/preview`;
const targetRoute = (targetType: string, targetId: string) => `${linksRoute}?${new URLSearchParams({targetType,targetId})}`;
const resolveRoute = (url: string) => `${linksRoute}/resolve?${new URLSearchParams({ url })}`;
const migratedJiraRoute = (url: string) => `${linksRoute}/resolve-migrated-jira-target?${new URLSearchParams({ url })}`;
const searchRoute = (query: string) => `/search?${new URLSearchParams({ q: query })}`;

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
  assert.deepEqual(await call(migratedJiraRoute(jira.url)), { target: null });
  assert.equal(requests.length, 0);
  assert.deepEqual(await call(targetRoute('issue','issue-1')),[jira]);
  assert.deepEqual(await call(targetRoute('document','doc-overview')),[wiki]);
  assert.deepEqual(await call(targetRoute('issue','issue-2')),[]);
  assert.deepEqual(await call(linksRoute,'POST',{targetType:'issue',targetId:'issue-1',product:'jira',url:jira.url},201),jira);
  assert.deepEqual(await call(resolveRoute(base+'/jira/browse/leg-17?page=comments#comments')),
    { targets: [{ targetType: 'issue', targetId: 'issue-1' }] });
  assert.deepEqual(await call(resolveRoute(base+'/jira/browse/leg-17?focusedCommentId=9#comments')), { targets: [] });
  assert.deepEqual(await call(resolveRoute(base+'/wiki/spaces/TEAM/pages/1234/Retitled%20Page')),
    { targets: [{ targetType: 'document', targetId: 'doc-overview' }] });
  const search = await call<{ issues: Issue[]; documents: DocPage[] }>(searchRoute(wiki.url));
  assert.deepEqual(search.issues, []);
  assert.deepEqual(search.documents.map(document => document.id), ['doc-overview']);
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

test('external links suffice without remote setup and survive trash and native backup, with rollback on invalid restore', async t => {
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
  assert.deepEqual(await call(resolveRoute(jira.url)), { targets: [] });
  const backup = await call<Export>('/export');
  assert.equal(backup.schemaVersion,NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(new Set(backup.atlassianLinks.map(link=>link.id)),new Set([jira.id,confluence.id]));

  const damaged = {...backup,atlassianLinks:backup.atlassianLinks.map(link=>link.id===jira.id?{...link,targetId:'missing-issue'}:link)};
  await call('/import','POST',{data:damaged},400);
  await call('/import','POST',{data:{...backup,schemaVersion:26}},400);
  assert.deepEqual(await call(targetRoute('document',document.id)),[confluence]);
  await call('/import','POST',{data:{...backup,schemaVersion:27}});
  await call(`/trash/${archive.trashEntryId}/restore`,'POST');
  assert.deepEqual(await call(targetRoute('issue',issue.id)),[jira]);
  assert.deepEqual(await call(resolveRoute(jira.url)), { targets: [{ targetType: 'issue', targetId: issue.id }] });
  const again = await call<{trashEntryId:string}>(`/issues/${issue.id}`,'DELETE');
  await call(`/trash/${again.trashEntryId}`,'DELETE');
  assert.deepEqual((await call<Export>('/export')).atlassianLinks,[confluence]);
  await call(`${linksRoute}/${confluence.id}`,'DELETE',undefined,204);
  assert.deepEqual(await call(targetRoute('document',document.id)),[]);
  assert.deepEqual(await call(resolveRoute(confluence.url)), { targets: [] });
});

test('original address search matches local targets by exact installation and source identity', async t => {
  const { call, base } = await appFixture(t, scratch(t));
  const classic = 'https://wiki.example.invalid/wiki/pages/viewpage.action?pageId=99999999999999999999';
  const modern = 'https://wiki.example.invalid/wiki/spaces/TEAM/pages/99999999999999999999/Old+Title';
  const samePage = 'https://wiki.example.invalid/wiki/spaces/OTHER/pages/99999999999999999999/Renamed';
  const sameIdElsewhere = 'https://wiki.example.invalid/other/pages/viewpage.action?pageId=99999999999999999999';
  const display = 'https://wiki.example.invalid/wiki/display/TEAM/Release%20Notes';
  const issue = await call<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '원본 주소 검사 업무' }, 201);
  const document = await call<DocPage>('/documents', 'POST', { projectId: 'project-neo', title: '원본 주소 검사 문서' }, 201);
  const unrelated = await call<DocPage>('/documents', 'POST', { title: classic }, 201);
  const documentTarget = { targetType: 'document', targetId: document.id } as const;
  const issueTarget = { targetType: 'issue', targetId: issue.id } as const;
  const link = (url: string, target: AtlassianSearchTarget, product = 'confluence') =>
    call<AtlassianLink>(linksRoute, 'POST', { ...target, product, url }, 201);
  await link(classic, documentTarget);
  await link(modern, documentTarget);
  await link(modern, issueTarget);
  await link(display, documentTarget);
  await link(sameIdElsewhere, { targetType: 'document', targetId: unrelated.id });

  const numeric = await fetch(base + resolveRoute(samePage + '?utm_source=hidden#marker'));
  assert.equal(numeric.status, 200);
  assert.equal(numeric.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await numeric.json(), { targets: [documentTarget, issueTarget] });
  assert.deepEqual(await call(resolveRoute(classic)), { targets: [documentTarget, issueTarget] });
  assert.deepEqual(await call(resolveRoute(sameIdElsewhere)), {
    targets: [{ targetType: 'document', targetId: unrelated.id }],
  });
  assert.deepEqual(await call(resolveRoute(classic.replace('wiki.example.invalid', 'different.example.invalid'))), { targets: [] });
  assert.deepEqual(await call(resolveRoute(display + '?tracking=ignored#marker')), { targets: [documentTarget] });
  assert.deepEqual(await call(resolveRoute(display.replace('TEAM', 'OTHER'))), { targets: [] });
  assert.deepEqual(await call(resolveRoute(display.replace('Release', 'release'))), { targets: [] });
  const result = await call<{ issues: Issue[]; documents: DocPage[] }>(searchRoute(classic));
  assert.deepEqual(Object.keys(result).sort(), ['documents', 'issues']);
  assert.deepEqual(result.issues.map(value => value.id), [issue.id]);
  assert.deepEqual(result.documents.map(value => value.id), [document.id]);
  const text = await call<{ issues: Issue[]; documents: DocPage[] }>(searchRoute(document.title));
  assert.deepEqual(text.documents.map(value => value.id), [document.id]);

  await call(resolveRoute(samePage + '?pageId=300'), 'GET', undefined, 400);
  await call(resolveRoute(classic + '&pageId=99999999999999999999'), 'GET', undefined, 400);
  await call(resolveRoute(classic.replace('https://', 'https://user:password@')), 'GET', undefined, 400);
  await call(resolveRoute(classic) + '&url=duplicate', 'GET', undefined, 400);
  await call(resolveRoute(classic) + '&unknown=true', 'GET', undefined, 400);
  const { token } = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '읽기 키', access: 'read', projectIds: ['project-neo'] }, 201);
  await call('/v1' + resolveRoute(classic), 'GET', undefined, 403, token);

  const gitlabWithJiraSuffix = 'https://git.example.invalid/group/repo/-/tree/browse/LEG-1';
  await link(gitlabWithJiraSuffix, issueTarget, 'jira');
  assert.deepEqual(await call(resolveRoute(gitlabWithJiraSuffix)), { targets: [issueTarget] });
  assert.deepEqual(await call(searchRoute(gitlabWithJiraSuffix)), { issues: [], documents: [] });
});

test('archived Confluence titles find genuinely imported pages only while their numeric origin link is active', async t => {
  const { base, call } = await appFixture(t, scratch(t));
  const origin = 'https://wiki.example.invalid/company/wiki';
  const title = '기존 Release + 검토';
  const refreshedTitle = '새 원본 제목';
  const appendedTitle = '추가 문서 제목';
  const display = (value: string, installation = origin, spaceKey = 'TEAM') =>
    `${installation}/display/${spaceKey}/${encodeURIComponent(value).replaceAll('%20', '+')}`;
  const numeric = (id: string, installation = origin) => `${installation}/pages/viewpage.action?pageId=${id}`;
  const target = ({ id }: DocPage) => ({ targetType: 'document', targetId: id });
  const resolve = (url: string) => call<{ targets: AtlassianSearchTarget[] }>(resolveRoute(url));
  const page = (id: string, sourceTitle: string, version = 1) => [
    `<object class="Page"><id name="id">${id}</id><property name="title">${sourceTitle}</property><property name="version">${version}</property>`,
    '<property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-01T00:00:00Z</property>',
    `<property name="lastModificationDate">2020-01-0${version}T00:00:00Z</property></object>`,
    `<object class="BodyContent"><id name="id">30${id}</id><property name="body"><![CDATA[<p>보관한 이관 문서 ${version}</p>]]></property>`,
    `<property name="content" class="Page"><id name="id">${id}</id></property></object>`,
  ].join('');
  async function migrate(instanceKey: string, pages: string[], projectKey: string, appendTo?: string) {
    const space = '<object class="Space"><id name="id">42</id><property name="key">TEAM</property><property name="name">원본 팀 공간</property></object>';
    const bytes = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${space}${pages.join('')}</hibernate-generic>`) }]);
    const params = new URLSearchParams({ filename: `${projectKey}.zip`, product: 'confluence', instanceKey });
    const upload = await fetch(`${base}/legacy-import/packages?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' }, body: new Uint8Array(bytes),
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const imported = await upload.json() as LegacyPackageSummary;
    const { defaultConfiguration: configuration } = await call<MigrationOptions>(`/migrations/options?packageId=${imported.id}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key: projectKey }));
    configuration.sourceBaseUrls[imported.id] = origin;
    if (appendTo) configuration.appendPagesTo = { projectId: appendTo, refreshExisting: true };
    const reviewed = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
    assert.ok(reviewed.canApply, JSON.stringify(reviewed.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${reviewed.id}/apply`, 'POST', {
      expectedVersion: reviewed.version, acknowledgements: reviewed.requiredAcknowledgements,
    }, 201);
  }

  const first = await migrate('confluence-display-a', [page('100', title)], 'BOOK');
  const [projectId] = first.import.projectIds;
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const document = (await workspace()).documents.find(candidate => candidate.projectId === projectId && candidate.title === title);
  assert.ok(document);
  const [originalLink] = await call<AtlassianLink[]>(targetRoute('document', document.id));
  assert.equal(originalLink.url, numeric('100'));
  const lookalike = await call<DocPage>('/documents', 'POST', { projectId, title }, 201);
  const addNumeric = (owner: DocPage, installation: string) => call<AtlassianLink>(linksRoute, 'POST', {
    ...target(owner), product: 'confluence', url: numeric('100', installation),
  }, 201);
  await addNumeric(lookalike, origin);
  const otherInstallation = 'https://wiki.example.invalid/another/wiki';
  await addNumeric(document, otherInstallation);

  assert.deepEqual(await resolve(display(title) + '?tracking=hide#ignored'), { targets: [target(document)] });
  assert.deepEqual(await resolve(display(title, otherInstallation)), { targets: [] });
  assert.deepEqual(await resolve(display(title, origin, 'OTHER')), { targets: [] });
  const localTitle = '팀에서 수정한 제목';
  await call(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: localTitle });
  assert.deepEqual(await resolve(display(localTitle)), { targets: [] });
  const searched = await call<{ issues: Issue[]; documents: DocPage[] }>(searchRoute(display(title)));
  assert.deepEqual(searched.issues, []);
  assert.deepEqual(searched.documents.map(value => [value.id, value.title]), [[document.id, localTitle]]);

  await migrate('confluence-display-a', [page('100', refreshedTitle, 2), page('101', appendedTitle)], 'BOOK', projectId);
  const appended = (await workspace()).documents.find(candidate => candidate.projectId === projectId && candidate.title === appendedTitle);
  assert.ok(appended);
  assert.deepEqual(await resolve(display(refreshedTitle)), { targets: [target(document)] });
  assert.deepEqual(await resolve(display(appendedTitle)), { targets: [target(appended)] });
  assert.deepEqual(await resolve(display(title)), { targets: [target(document)] });

  const second = await migrate('confluence-display-b', [page('200', title)], 'BKMK');
  const alternative = (await workspace()).documents.find(candidate => candidate.projectId === second.import.projectIds[0] && candidate.title === title);
  assert.ok(alternative);
  assert.deepEqual(new Set((await resolve(display(title))).targets.map(value => value.targetId)), new Set([document.id, alternative.id]));
  const backup = await call<Export>('/export');
  await call('/import', 'POST', { data: backup });
  assert.deepEqual(await resolve(display(refreshedTitle)), { targets: [target(document)] });
  const trash = await call<{ trashEntryId: string }>(`/documents/${document.id}`, 'DELETE');
  assert.deepEqual(await resolve(display(title)), { targets: [target(alternative)] });
  await call(`/trash/${trash.trashEntryId}/restore`, 'POST');
  assert.deepEqual(await resolve(display(refreshedTitle)), { targets: [target(document)] });

  await call(`${linksRoute}/${originalLink.id}`, 'DELETE', undefined, 204);
  assert.deepEqual(await resolve(display(title)), { targets: [target(alternative)] });
  assert.deepEqual(await resolve(display(refreshedTitle)), { targets: [] });
  await call(linksRoute, 'POST', { ...target(document), product: 'confluence', url: display(refreshedTitle) }, 201);
  assert.deepEqual(await resolve(display(refreshedTitle)), { targets: [target(document)] });
});

test('Confluence comment permalinks require a proven active source comment and exact owning page', async t => {
  const { base, call } = await appFixture(t, scratch(t));
  const origin = 'https://wiki.example.invalid/team/wiki';
  const sourceTitle = 'Source Release Notes';
  const parentSourceId = '9007199254740997';
  const object = (type: string, id: string, fields: string) => `<object class="${type}"><id name="id">${id}</id>${fields}</object>`;
  const prop = (name: string, text: string) => `<property name="${name}"><![CDATA[${text}]]></property>`;
  const ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const dated = prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-01T00:00:00Z');
  const content = (type: string, id: string, text: string) =>
    object('BodyContent', `${type === 'Page' ? '1' : '2'}${id}`, prop('body', text) + ref('content', type, id));
  const storage = '<p>앞부분 <ac:inline-comment-marker ac:ref="release-marker">배포 기준</ac:inline-comment-marker> 뒷부분</p>';
  const page = (id: string, title: string, markup = '<p>본문</p>') => object('Page', id,
    prop('title', title) + prop('version', '1') + ref('space', 'Space', '42') + dated) + content('Page', id, markup);
  const comment = (id: string, pageId: string, text: string, parent?: string) => object('Comment', id,
    ref('containerContent', 'Page', pageId) + (parent ? ref('parent', 'Comment', parent) : '') + dated) + content('Comment', id, `<p>${text}</p>`);
  const attribute = object('ContentProperty', '802', prop('name', 'inline-marker-ref') + prop('stringValue', 'release-marker') +
    ref('contentEntity', 'Comment', parentSourceId));
  async function migrate(records: string, instanceKey: string, key: string, appendProjectId?: string) {
    const space = object('Space', '42', prop('key', 'TEAM') + prop('name', '원본 팀 공간'));
    const bytes = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${space}${records}</hibernate-generic>`) }]);
    const params = new URLSearchParams({ filename: `${key}.zip`, product: 'confluence', instanceKey });
    const upload = await fetch(`${base}/legacy-import/packages?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' }, body: new Uint8Array(bytes),
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const imported = await upload.json() as LegacyPackageSummary;
    const { defaultConfiguration: configuration } = await call<MigrationOptions>(`/migrations/options?packageId=${imported.id}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key }));
    if (appendProjectId) configuration.appendPagesTo = { projectId: appendProjectId, refreshHistory: true };
    else configuration.sourceBaseUrls[imported.id] = origin;
    const preview = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
    assert.ok(preview.canApply, JSON.stringify(preview.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 'POST', {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    }, 201);
  }
  const instance = 'confluence-conversation';
  const first = await migrate(page('100', sourceTitle, storage) + page('101', 'Other Page') +
    comment(parentSourceId, '100', '원문이 있는 문장 댓글') + attribute + comment('301', '100', '직접 답글', parentSourceId) +
    comment('302', '101', '다른 문서의 일반 댓글'), instance, 'TALK');
  const [projectId] = first.import.projectIds;
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const doc = (await workspace()).documents.find(value => value.projectId === projectId && value.title === sourceTitle);
  const other = (await workspace()).documents.find(value => value.projectId === projectId && value.title === 'Other Page');
  assert.ok(doc && other);
  const readComments = (document: DocPage) => call<Comment[]>(`/comments?resourceType=document&resourceId=${document.id}`);
  const comments = await readComments(doc);
  const root = comments.find(value => value.documentSource?.text === '배포 기준');
  const reply = comments.find(value => value.parentCommentId === root?.id && value.body === '직접 답글');
  const [ordinary] = await readComments(other);
  assert.ok(root && reply && ordinary);
  const classic = (pageId: string, commentId: string) => `${origin}/pages/viewpage.action?pageId=${pageId}&focusedCommentId=${commentId}#comment-${commentId}`;
  const rootUrl = classic('100', parentSourceId);
  const replyUrl = `${origin}/display/TEAM/Source+Release+Notes?focusedCommentId=301#comment-301`;
  const otherUrl = `${origin}/spaces/TEAM/pages/101/Other+Page?focusedCommentId=302`;
  const resolve = (url: string) => call<{ targets: AtlassianSearchTarget[] }>(resolveRoute(url));
  const target = (document: DocPage, comment: Comment) => ({ targetType: 'document', targetId: document.id, commentId: comment.id });
  await call(linksRoute, 'POST', { targetType: 'document', targetId: 'doc-overview', product: 'confluence', url: rootUrl }, 201);
  assert.deepEqual(await resolve(rootUrl), { targets: [target(doc, root)] });
  assert.deepEqual(await resolve(replyUrl), { targets: [target(doc, reply)] });
  assert.deepEqual(await resolve(otherUrl), { targets: [target(other, ordinary)] });
  for (const url of [classic('101', parentSourceId), classic('100', '302'), classic('100', '399'),
    rootUrl.replace('/team/wiki/', '/other/wiki/'), replyUrl.replace('/TEAM/', '/OTHER/'), rootUrl.replace('wiki.example.invalid', 'other.example.invalid')]) {
    assert.deepEqual(await resolve(url), { targets: [] });
  }
  await call(resolveRoute(rootUrl.replace(`#comment-${parentSourceId}`, '#comment-301')), 'GET', undefined, 400);
  const exact = await call<{ issues: Issue[]; documents: DocPage[]; documentCommentIds: Record<string, string> }>(searchRoute(replyUrl));
  assert.deepEqual(exact.issues, []);
  assert.deepEqual(exact.documents.map(value => value.id), [doc.id]);
  assert.deepEqual(exact.documentCommentIds, { [doc.id]: reply.id });
  assert.deepEqual(await call(searchRoute(classic('101', parentSourceId))), { issues: [], documents: [] });

  await migrate(page('100', sourceTitle, storage) + comment('303', '100', '상위 객체 없이 추가한 답글', parentSourceId), instance, 'TAKU', projectId);
  const appended = (await readComments(doc)).find(value => value.body === '상위 객체 없이 추가한 답글');
  assert.ok(appended && appended.parentCommentId === root.id);
  const appendedUrl = classic('100', '303');
  assert.deepEqual(await resolve(appendedUrl), { targets: [target(doc, appended)] });
  const archived = await call<{ trashItemId: string }>(`/comments/${root.id}`, 'DELETE');
  for (const url of [rootUrl, replyUrl, appendedUrl]) assert.deepEqual(await resolve(url), { targets: [] });
  await call(`/trash/items/${archived.trashItemId}/restore`, 'POST');
  assert.deepEqual(await resolve(replyUrl), { targets: [target(doc, reply)] });
  await call('/import', 'POST', { data: await call<Export>('/export') });
  assert.deepEqual(await resolve(appendedUrl), { targets: [target(doc, appended)] });
  const move = { projectId: 'project-neo', parentId: null };
  const review = await call<DocumentTreeMovePreview>(`/documents/${doc.id}/move-preview`, 'POST', move);
  await call(`/documents/${doc.id}/move`, 'POST', { ...move, token: review.token });
  assert.equal((await workspace()).documents.find(value => value.id === doc.id)?.projectId, 'project-neo');
  assert.deepEqual(await resolve(replyUrl), { targets: [target(doc, reply)] });

  await migrate(page('100', sourceTitle) + comment(parentSourceId, '100', '다른 원본 인스턴스의 같은 ID'), 'confluence-overlap', 'OVRP');
  assert.deepEqual(await resolve(rootUrl), { targets: [] });
  assert.deepEqual(await resolve(replyUrl), { targets: [target(doc, reply)] });
});

test('Jira comment locators require one active, unrestricted comment and its proven source issue and installation', async t => {
  const { base, call } = await appFixture(t, scratch(t));
  const origin = 'https://jira.example.invalid/company/jira';
  const instance = 'jira-comment-locator';
  const longId = '90071992547409931234';
  const author = { name: 'source-writer', displayName: '원본 댓글 작성자' };
  const created = '2020-01-01T00:00:00Z';
  const jiraComment = (id: string, body: string, restricted = false) => ({
    id, body, author, created, ...(restricted ? { visibility: { type: 'role', value: 'Administrators' } } : {}),
  });
  const jiraIssue = (id: string, number: number, title: string, comments: ReturnType<typeof jiraComment>[]) => ({
    id, key: `SRC-${number}`, fields: {
      project: { id: '4020', key: 'SRC', name: 'Jira 원본 프로젝트' }, summary: title,
      created, updated: created, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      comment: { comments },
    },
  });
  async function migrate(key: string, issues: ReturnType<typeof jiraIssue>[], instanceKey = instance, appendProjectId?: string,
    excludeIssues: readonly string[] = []) {
    const params = new URLSearchParams({ filename: `${key}.json`, product: 'jira', instanceKey });
    const upload = await fetch(`${base}/legacy-import/packages?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' },
      body: JSON.stringify({ issues }),
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const imported = await upload.json() as LegacyPackageSummary;
    const { defaultConfiguration: configuration, identities, statuses, issueTypes, appendTarget } = await call<MigrationOptions>(`/migrations/options?packageId=${imported.id}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key }));
    const sourceUser = identities.find(identity => identity.sourceValue === author.name);
    assert.ok(sourceUser);
    configuration.users[sourceUser.id] = 'user-min';
    configuration.excludedRecords = [
      ...excludeIssues.map(id => `${imported.id}/issue:${id}`),
      ...issues.flatMap(issue => issue.fields.comment.comments
        .filter(comment => comment.visibility).map(comment => `${imported.id}/comment:${comment.id}`)),
    ];
    if (appendProjectId) {
      assert.ok(appendTarget);
      configuration.appendTo = { projectId: appendProjectId, refreshHistory: true, fields: {},
        statuses: Object.fromEntries(statuses.map(row => [row.id, appendTarget.statuses.find(status => status.label === row.label)!.id])),
        issueTypes: Object.fromEntries(issueTypes.map(row => [row.id, appendTarget.issueTypes.find(type => type.name === row.label)!.id])),
      };
    } else configuration.sourceBaseUrls[imported.id] = origin;
    const preview = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
    assert.ok(preview.canApply, JSON.stringify(preview.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 'POST', {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    }, 201);
  }
  const initial = await migrate('JIRAEX', [
    jiraIssue('1200', 1, '이관한 댓글의 원래 업무', [jiraComment(longId, '첫 번째 이관 댓글'), jiraComment('302', '두 번째 이관 댓글'), jiraComment('303', '공개하지 않을 댓글', true)]),
    { ...jiraIssue('1201', 2, '다른 원래 업무', [jiraComment('304', '다른 업무 댓글')]), key: 'src-2' },
  ]);
  const [projectId] = initial.import.projectIds;
  const { issues, jiraMigrationOrigins } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(jiraMigrationOrigins, [origin]);
  const issue = issues.find(issue => issue.projectId === projectId && issue.title === '이관한 댓글의 원래 업무');
  const other = issues.find(issue => issue.projectId === projectId && issue.title === '다른 원래 업무');
  assert.ok(issue && other && issue.key !== 'SRC-1');
  const comments = (issue: Issue) => call<Comment[]>(`/comments?resourceType=issue&resourceId=${issue.id}`);
  const first = (await comments(issue)).find(comment => comment.body === '첫 번째 이관 댓글');
  const second = (await comments(issue)).find(comment => comment.body === '두 번째 이관 댓글');
  const [otherComment] = await comments(other);
  assert.ok(first && second && otherComment);
  const firstUrl = `${origin}/browse/SRC-1?focusedCommentId=${longId}#comment-${longId}`;
  const secondUrl = `${origin}/browse/SRC-1#comment-302`;
  const conflicting = firstUrl.replace(`#comment-${longId}`, '#comment-302');
  const showAsText = 'https://example.invalid/not-an-atlassian-locator?ordinary=value';
  const manualIssue = await call<Issue>('/issues', 'POST', { projectId, title: '수동 링크가 있는 업무', description: `${conflicting}\n${showAsText}` }, 201);
  const bareIssueUrl = firstUrl.split('?')[0];
  const resolve = (url: string) => call<{ targets: AtlassianSearchTarget[] }>(resolveRoute(url));
  const resolveMigrated = (url: string) => call(migratedJiraRoute(url));
  const expected = (issue: Issue, comment: Comment) => ({ targets: [{ targetType: 'issue', targetId: issue.id, commentId: comment.id }] });
  const migrated = (issue: Issue, comment?: Comment) => ({ target: { issueId: issue.id, ...(comment ? { commentId: comment.id } : {}) } });
  await call(linksRoute, 'POST', { targetType: 'issue', targetId: manualIssue.id, product: 'jira', url: firstUrl }, 201);
  const manualOnly = `${origin}/browse/SRC-999`;
  await call(linksRoute, 'POST', { targetType: 'issue', targetId: manualIssue.id, product: 'jira', url: manualOnly }, 201);
  assert.deepEqual(await resolveMigrated(manualOnly), { target: null });
  assert.deepEqual(await resolve(firstUrl), expected(issue, first));
  assert.deepEqual(await resolve(secondUrl), expected(issue, second));
  assert.deepEqual(await resolve(`${origin}/browse/src-2?focusedId=304#comment-304`), expected(other, otherComment));
  assert.deepEqual(await resolveMigrated(bareIssueUrl), migrated(issue));
  assert.deepEqual(await resolveMigrated(firstUrl), migrated(issue, first));
  assert.deepEqual(await resolveMigrated(`${bareIssueUrl}?page=issuetabpanels%3Acomment-tabpanel&focusedCommentId=302`), migrated(issue, second));
  assert.deepEqual(await resolveMigrated(`${origin}/browse/src-2?focusedId=304#comment-304`), migrated(other, otherComment));
  const [originLink] = await call<AtlassianLink[]>(targetRoute('issue', issue.id));
  await call(`${linksRoute}/${originLink.id}`, 'DELETE', undefined, 204);
  assert.deepEqual(await resolve(firstUrl), { targets: [] });
  assert.deepEqual(await resolveMigrated(firstUrl), migrated(issue, first));
  await call(linksRoute, 'POST', { targetType: 'issue', targetId: issue.id, product: 'jira', url: bareIssueUrl }, 201);
  const search = await call<{ documents: DocPage[]; issues: Issue[]; issueCommentIds: Record<string, string> }>(searchRoute(secondUrl));
  assert.deepEqual(search.issues.map(value => value.id), [issue.id]);
  assert.deepEqual(search.documents, []);
  assert.deepEqual(search.issueCommentIds, { [issue.id]: second.id });

  const wrongInstallation = firstUrl.replace('/company/jira/', '/elsewhere/jira/');
  await call(linksRoute, 'POST', { targetType: 'issue', targetId: issue.id, product: 'jira', url: wrongInstallation }, 201);
  for (const url of [firstUrl.replace('SRC-1', 'SRC-2'), firstUrl.replace('jira.example', 'other.example'), wrongInstallation,
    `${bareIssueUrl}#comment-303`, `${bareIssueUrl}#comment-304`, `${bareIssueUrl}#comment-999`]) {
    assert.deepEqual(await resolve(url), { targets: [] });
    assert.deepEqual(await resolveMigrated(url), { target: null });
  }
  for (const malformed of [conflicting, `${bareIssueUrl}?focusedCommentId=302&later=true`, `${bareIssueUrl}?focusedId=${longId}`,
    `${bareIssueUrl}#comments`, `${bareIssueUrl}?page=worklog-tabpanel&focusedCommentId=302`]) {
    await call(migratedJiraRoute(malformed), 'GET', undefined, 400);
  }
  const { token } = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '이관 링크 읽기 키', access: 'read', projectIds: [projectId] }, 201);
  await call('/v1' + migratedJiraRoute(bareIssueUrl), 'GET', undefined, 403, token);
  await call(resolveRoute(conflicting), 'GET', undefined, 400);
  assert.deepEqual(await call(searchRoute(conflicting)), { issues: [], documents: [] });
  assert.deepEqual((await call<{ issues: Issue[] }>(searchRoute(showAsText))).issues.map(value => value.id), [manualIssue.id]);

  await migrate('JIRAUP', [jiraIssue('1200', 1, '이관한 댓글의 원래 업무', [jiraComment('305', '추가한 원본 댓글')])], instance, projectId);
  const appended = (await comments(issue)).find(comment => comment.body === '추가한 원본 댓글');
  assert.ok(appended);
  const appendedUrl = `${bareIssueUrl}#comment-305`;
  assert.deepEqual(await resolve(appendedUrl), expected(issue, appended));
  assert.deepEqual(await resolveMigrated(appendedUrl), migrated(issue, appended));
  const archived = await call<{ trashItemId: string }>(`/comments/${first.id}`, 'DELETE');
  assert.deepEqual(await resolve(firstUrl), { targets: [] });
  assert.deepEqual(await resolveMigrated(firstUrl), { target: null });
  assert.deepEqual(await resolve(secondUrl), expected(issue, second));
  await call(`/trash/items/${archived.trashItemId}/restore`, 'POST');
  const backup = await call<Export>('/export');
  assert.equal(backup.jiraMigrationOrigins, undefined);
  await call('/import', 'POST', { data: backup });
  assert.deepEqual(await resolve(firstUrl), expected(issue, first));
  assert.deepEqual(await resolve(appendedUrl), expected(issue, appended));
  assert.deepEqual(await resolveMigrated(firstUrl), migrated(issue, first));

  const destination = 'project-team';
  const [workspace, schema, workflow] = await Promise.all([
    call<WorkspaceSnapshot>('/workspace'), call<ProjectIssueSchema>(`/projects/${destination}/issue-schema`),
    call<ProjectWorkflow>(`/projects/${destination}/workflow`),
  ]);
  const current = workspace.issues.find(value => value.id === issue.id);
  const activeType = schema.issueTypes.find(type => !type.archived);
  assert.ok(current && activeType);
  const move: IssueProjectMoveInput = { projectId: destination, expectedVersion: current.version, includeConnected: false,
    mappings: [{ issueId: issue.id, type: activeType.id, status: workflow.initialStatusId }] };
  const movePath = `/issues/${issue.id}/project-move`;
  const review = await call<IssueProjectMovePreview>(`${movePath}/preview`, 'POST', move);
  assert.ok(review.token, JSON.stringify(review.blockers));
  const moved = await call<IssueProjectMoveResult>(`${movePath}/apply`, 'POST', { ...move, token: review.token });
  assert.equal(moved.issues[0].projectId, destination);
  assert.deepEqual(await resolve(firstUrl), expected(issue, first));
  assert.deepEqual(await resolve(appendedUrl), expected(issue, appended));
  assert.deepEqual(await resolveMigrated(firstUrl), migrated(issue, first));

  await migrate('JIRAALT', [jiraIssue('1200', 1, '다른 인스턴스의 원래 업무', [jiraComment(longId, '같은 원본 번호의 별도 댓글')])], 'jira-other-instance');
  assert.deepEqual(await resolve(firstUrl), { targets: [] });
  assert.deepEqual(await resolve(secondUrl), expected(issue, second));
  assert.deepEqual(await resolveMigrated(bareIssueUrl), { target: null });
  assert.deepEqual(await resolveMigrated(firstUrl), { target: null });
  assert.deepEqual(await resolveMigrated(secondUrl), { target: null });

  const otherUrl = `${origin}/browse/SRC-2`;
  const removedIssue = await call<{ trashEntryId: string }>(`/issues/${other.id}`, 'DELETE');
  assert.deepEqual(await resolveMigrated(otherUrl), { target: null });
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).jiraMigrationOrigins, [origin]);
  await call(`/trash/${removedIssue.trashEntryId}/restore`, 'POST');
  assert.deepEqual(await resolveMigrated(otherUrl), migrated(other));

  await migrate('JIRAOLD', [jiraIssue('5901', 2, '원본 번호가 다른 제외 업무', []),
    jiraIssue('5902', 3, '후속 업무', [jiraComment('5903', '후속 댓글')])], instance, projectId, ['5901']);
  assert.deepEqual(await resolveMigrated(otherUrl), { target: null });
});
