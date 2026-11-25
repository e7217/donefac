import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { COLLABORATION_SCHEMA } from '../shared/collaboration.ts';
import { zip } from '../tests/fixtures/legacy-export-zip.mjs';
import { startPilotTestProxy } from './pilot-test-proxy.mjs';

const mode = process.argv[2];
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && mode === '--team'), 'Usage: node scripts/test-pilot.mjs [--team]');
const teamSeconds = mode === '--team' ? Number(process.env.TEAMSPACE_PILOT_TEAM_SECONDS ?? 75) : null;
if (teamSeconds !== null) {
  assert.ok(Number.isSafeInteger(teamSeconds) && teamSeconds >= 30 && teamSeconds <= 1800,
    'TEAMSPACE_PILOT_TEAM_SECONDS must be an integer from 30 to 1800.');
}

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'teamspace-pilot-'));
const source = join(scratch, 'source');
const backup = join(scratch, 'backup');
const restored = join(scratch, 'restored');
const pilots = new Set();
const interruption = new AbortController();
let browserChild;
let browserShutdownTimer;

function interrupt(signal, exitCode) {
  if (interruption.signal.aborted) return;
  process.exitCode = exitCode;
  interruption.abort(new Error(`Pilot rehearsal interrupted (${signal}).`));
  const child = browserChild;
  if (child) {
    child.kill('SIGINT');
    browserShutdownTimer = setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }
}
const onInterrupt = () => interrupt('SIGINT', 130);
const onTerminate = () => interrupt('SIGTERM', 143);

async function deadline(completion, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function start(dataDir, demo = false, access) {
  interruption.signal.throwIfAborted();
  const env = {...process.env, TEAMSPACE_PILOT_PORT: '0', TEAMSPACE_PILOT_DEMO: demo ? '1' : '0', TEAMSPACE_PILOT_OUTBOUND: '0'};
  delete env.TEAMSPACE_PILOT_ORIGIN;
  delete env.TEAMSPACE_PILOT_ACCESS_FILE;
  if (access) {
    env.TEAMSPACE_PILOT_ORIGIN = access.origin;
    env.TEAMSPACE_PILOT_ACCESS_FILE = access.file;
  }
  const child = spawn('bash', ['scripts/pilot-lock.sh', dataDir, process.execPath, '--import', 'tsx', 'server/pilot.ts'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  const exit = once(child, 'exit');
  pilots.add({ child, exit });
  let logs = '';
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-3000); });
  const ready = new Promise(resolve => {
    child.stdout.on('data', chunk => {
      logs = (logs + chunk).slice(-3000);
      const url = /Teamspace pilot listening on (http:\/\/127\.0\.0\.1:\d+)\s/.exec(logs)?.[1];
      if (url) resolve(url);
    });
  });
  const url = await deadline(Promise.race([ready, exit.then(([code, signal]) => {
    throw new Error(`Pilot exited during startup (${code ?? signal}).\n${logs}`);
  })]), 25_000, 'Pilot startup timed out.');
  interruption.signal.throwIfAborted();
  return {child,exit,url};
}

async function stop({child,exit}) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try {
    const [code] = await deadline(exit, 15_000, 'Pilot shutdown timed out.');
    assert.equal(code, 0);
  } catch (error) {
    child.kill('SIGKILL');
    await exit.catch(() => {});
    throw error;
  } finally {
    for (const active of pilots) if (active.child === child) pilots.delete(active);
  }
}

async function call(url, path, { method = 'GET', body, headers = {}, status = 200 } = {}) {
  const response = await fetch(new URL(`/api${path}`, url), {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(25_000)]),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  return response;
}

function requestTeamPilot(proxy, path, { method = 'GET', body, headers = {} } = {}) {
  const target = new URL(path, proxy.origin);
  assert.equal(target.origin, proxy.origin, 'Invalid team pilot test route.');
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method, headers, ca: proxy.certificate, agent: false,
      signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(25_000)]),
    }, response => {
      buffer(response).then(bytes => resolve({ status: response.statusCode, headers: response.headers, bytes }), reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function openTeamPilot(proxy, access, dataDir, retiredCookies) {
  const pilot = await start(dataDir, false, access);
  proxy.setBackendPort(Number(new URL(pilot.url).port));
  const sessionProbe = '/api/workspace';
  assert.equal((await requestTeamPilot(proxy, sessionProbe)).status, 401, 'Anonymous HTTPS could read the pilot workspace.');
  for (const cookie of retiredCookies) {
    assert.equal((await requestTeamPilot(proxy, sessionProbe, { headers: { Cookie: cookie } })).status, 401,
      'A prior session could read the restarted or restored workspace.');
  }

  const login = await requestTeamPilot(proxy, '/pilot-access', {
    method: 'POST', headers: { Origin: proxy.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: access.code }).toString(),
  });
  assert.equal(login.status, 303, 'The team pilot did not accept the synthetic key.');
  const [cookie] = login.headers['set-cookie'] ?? [];
  const token = /^__Host-teamspace-pilot=([A-Za-z0-9_-]{43});/.exec(cookie)?.[1];
  assert.ok(token && /; Secure; HttpOnly; SameSite=Lax$/.test(cookie), 'Missing opaque secure team session.');
  const session = `__Host-teamspace-pilot=${token}`;
  assert.ok(!retiredCookies.has(session), 'A new session must have a fresh cookie.');
  retiredCookies.add(session);

  const request = async (path, { method = 'GET', body, headers = {}, status = 200 } = {}) => {
    const reply = await requestTeamPilot(proxy, `/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers, Origin: proxy.origin, Cookie: session },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    assert.equal(reply.status, status, `${method} ${path} returned ${reply.status} through the HTTPS proxy.`);
    return new Response(reply.bytes.length ? reply.bytes : null, { status: reply.status, headers: reply.headers });
  };
  const api = async (path, options) => (await request(path, options)).json();
  return { ...pilot, request, api };
}

function cli(action, from, to) {
  interruption.signal.throwIfAborted();
  const result = spawnSync(process.execPath, ['scripts/pilot-backup.mjs', action, from, to], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function fileHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

const jiraAuthorKey = 'pilot-jira-author';
const jiraRestrictedWorklog = 'history:worklog:32';

async function applyPilotSourceMigration(request, actorId, authorId) {
  const jiraAttachment = Buffer.from('Jira 관리자 백업에 따로 보관한 첨부 바이트\x00\n');
  const jira = zip([
    {path: 'entities.xml', bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><entity-engine-xml>
      <ApplicationUser id="10" userKey="${jiraAuthorKey}" lowerUserName="pilotalice"/>
      <User id="11" userName="pilotalice" displayName="파일럿 Jira 원본 작성자" active="1"/>
      <Project id="20" pkey="OLD" name="파일럿 원본 프로젝트"/>
      <Status id="1" pname="Open"/>
      <Status id="3" pname="In Progress"/>
      <IssueType id="5" pname="Task"/>
      <Issue id="100" project="20" number="1" summary="파일럿 원본 업무" creator="pilotalice" reporter="pilotalice" assignee="pilotalice" status="1" issuetype="5" created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"><description>보관할 원본 내용</description></Issue>
      <Issue id="101" project="20" number="2" summary="파일럿 두 번째 업무" status="3" issuetype="5" created="2020-01-02T00:00:00Z" updated="2020-01-03T00:00:00Z"><description>진행 상태의 원본</description></Issue>
      <Worklog id="31" issue="100" author="pilotalice" timeworked="91" startdate="2020-01-02 00:30:00" created="2020-01-02T00:31:00+09:00"><body>원본 작업 시간</body></Worklog>
      <Worklog id="32" issue="100" author="pilotalice" timeworked="60" startdate="2020-01-02 01:30:00" created="2020-01-02T01:31:00+09:00" rolelevel="123"><body>공개 제한 작업 시간</body></Worklog>
      <FileAttachment id="800" issue="100" filename="jira-origin.bin" filesize="${jiraAttachment.length}" mimetype="application/octet-stream" author="pilotalice" created="2020-01-02T00:00:00Z"/>
    </entity-engine-xml>`)},
    {path: 'attachments/OLD/OLD-1/800', bytes: jiraAttachment},
  ]);
  const wikiVersions = [Buffer.from('보존할 첨부 첫 버전\r\n'), Buffer.from('보존할 첨부 두 번째 버전\x00\n')];
  const sharedWikiAttachment = Buffer.from('다른 공간의 같은 이름 첨부\x00\n');
  const confluence = zip([
    {path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">SYN</property><property name="name">파일럿 원본 공간</property></object>
      <object class="Space"><id name="id">43</id><property name="key">ALT</property><property name="name">파일럿 공유 공간</property></object>
      <object class="Page"><id name="id">100</id><property name="title">파일럿 원본 설계 문서</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property></object>
      <object class="Page"><id name="id">101</id><property name="title">파일럿 공유 자료</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property></object>
      <object class="Page"><id name="id">102</id><property name="title">파일럿 공유 자료</property><property name="version">1</property><property name="space" class="Space"><id name="id">43</id></property><property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property></object>
      <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>이관 뒤 검토할 설계 내용</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OLD-1</ac:parameter></ac:structured-macro><p><ac:link><ri:page ri:content-title="파일럿 공유 자료"/></ac:link></p><p><ac:link><ri:attachment ri:filename="pilot-origin.bin"><ri:page ri:space-key="ALT" ri:content-title="파일럿 공유 자료"/></ri:attachment><ac:plain-text-link-body>다른 공간의 원본 첨부</ac:plain-text-link-body></ac:link></p>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
      <object class="BodyContent"><id name="id">301</id><property name="body"><![CDATA[<p>설계 문서와 같은 원본 공간</p>]]></property><property name="content" class="Page"><id name="id">101</id></property></object>
      <object class="BodyContent"><id name="id">302</id><property name="body"><![CDATA[<p>공유 첨부를 가진 다른 원본 공간</p>]]></property><property name="content" class="Page"><id name="id">102</id></property></object>
      <object class="Attachment"><id name="id">700</id><property name="title">pilot-origin.bin</property><property name="version">2</property><property name="containerContent" class="Page"><id name="id">100</id></property><collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection><property name="creationDate">2020-01-02T00:00:00Z</property></object>
      <object class="Attachment"><id name="id">701</id><property name="title">pilot-origin.bin</property><property name="version">1</property><property name="containerContent" class="Page"><id name="id">100</id></property><property name="originalVersion" class="Attachment"><id name="id">700</id></property><property name="creationDate">2020-01-01T00:00:00Z</property></object>
      <object class="Attachment"><id name="id">702</id><property name="title">pilot-origin.bin</property><property name="version">1</property><property name="containerContent" class="Page"><id name="id">102</id></property><property name="creationDate">2020-01-02T00:00:00Z</property></object>
    </hibernate-generic>`)},
    ...wikiVersions.map((bytes, index) => ({path: `attachments/100/700/${index + 1}`, bytes})),
    {path: 'attachments/102/702/1', bytes: sharedWikiAttachment},
  ]);
  const headers = { 'X-Actor-Id': actorId };
  async function stage(filename, product, body) {
    const query = new URLSearchParams({filename, product, instanceKey: `pilot-${product}`});
    return (await request(`/legacy-import/packages?${query}`, {
      method: 'POST', status: 201, headers: {...headers, 'Content-Type': 'application/octet-stream'}, body,
    })).json();
  }
  const jiraPackage = await stage('pilot-jira-backup.zip', 'jira', jira);
  const wikiPackage = await stage('pilot-confluence-space.zip', 'confluence', confluence);
  assert.equal(jiraPackage.source.format, 'jira-backup-xml');
  assert.equal(wikiPackage.source.format, 'confluence-xml');
  const query = new URLSearchParams();
  for (const info of [jiraPackage, wikiPackage]) query.append('packageId', info.id);
  const options = await (await request(`/migrations/options?${query}`, {headers})).json();
  const migration = options.defaultConfiguration;
  migration.projects = migration.projects.map(project => ({...project, key: 'PILOTIMP', name: '파일럿 합성 이관'}));
  const originalAuthor = options.identities.find(identity => identity.packageId === jiraPackage.id && identity.sourceValue === jiraAuthorKey);
  assert.ok(originalAuthor, 'The Jira administrator backup must expose the stable author key for mapping.');
  migration.users[originalAuthor.id] = authorId;
  migration.timezone = 'Asia/Seoul';
  migration.sourceBaseUrls = {
    [jiraPackage.id]: 'https://jira.example.test/jira',
    [wikiPackage.id]: 'https://wiki.example.test/confluence',
  };
  async function previewMigration() {
    return (await request('/migrations/preview', {
      method: 'POST', status: 201, headers, body: {configuration: migration},
    })).json();
  }
  async function applyMigration(preview, status) {
    return (await request(`/migrations/previews/${preview.id}/apply`, {
      method: 'POST', status, headers,
      body: {expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements},
    })).json();
  }
  const restrictedRecord = `${jiraPackage.id}/${jiraRestrictedWorklog}`;
  const blocked = await previewMigration();
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.notices.some(notice => notice.code === 'RESTRICTED_CONTENT' && notice.recordId === restrictedRecord));
  await applyMigration(blocked, 409);
  migration.excludedRecords = [restrictedRecord];
  const preview = await previewMigration();
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.counts.atlassianLinks, 5);
  assert.equal(preview.counts.unlinkedAtlassianRecords, 0);
  assert.equal(preview.counts.worklogs, 1);
  const {import: receipt} = await applyMigration(preview, 201);
  assert.deepEqual(receipt.counts, preview.counts);
  return {
    receipt, authorId,
    packages: [{summary: jiraPackage, bytes: jira}, {summary: wikiPackage, bytes: confluence}],
    expectedFiles: [
      {product: 'jira', sourceId: '800', packageSha256: jiraPackage.sha256, bytes: jiraAttachment},
      {product: 'confluence', sourceId: '701', packageSha256: wikiPackage.sha256, bytes: wikiVersions[0]},
      {product: 'confluence', sourceId: '700', packageSha256: wikiPackage.sha256, bytes: wikiVersions[1]},
      {product: 'confluence', sourceId: '702', packageSha256: wikiPackage.sha256, bytes: sharedWikiAttachment},
    ],
  };
}

async function verifyPilotSourceMigration(request, migration, expectedAssigneeId = migration.authorId) {
  const {receipt, authorId, expectedFiles} = migration;
  assert.equal(receipt.projectIds.length, 1);
  const [projectId] = receipt.projectIds;
  const base = `/source-imports/${receipt.id}/reconciliation`;
  const workspace = await (await request('/workspace')).json();
  const issue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 원본 업무');
  const otherIssue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 두 번째 업무');
  const documents = workspace.documents.filter(item => item.projectId === projectId);
  const document = documents.find(item => item.title === '파일럿 원본 설계 문서');
  const sameSpaceDocument = documents.find(item => item.plainText.includes('설계 문서와 같은 원본 공간'));
  const remoteDocument = documents.find(item => item.plainText.includes('공유 첨부를 가진 다른 원본 공간'));
  const workflow = workspace.workflows.find(item => item.projectId === projectId);
  const nextStatus = workflow?.statuses.find(status => status.category === 'in_progress')?.id;
  assert.ok(issue && otherIssue && nextStatus);
  assert.equal(issue.assigneeId, expectedAssigneeId);
  assert.match(issue.description, /보관할 원본 내용/);
  assert.ok(document && sameSpaceDocument && remoteDocument);
  assert.equal(sameSpaceDocument.title, remoteDocument.title);
  assert.ok(document.plainText.includes('이관 뒤 검토할 설계 내용'));
  assert.ok(document.content.content.some(node => node.type === 'issueReference' && node.attrs.issueId === issue.id));
  assert.deepEqual(document.content.content.filter(node => node.type === 'documentReference').map(node => node.attrs.documentId), [sameSpaceDocument.id]);
  assert.ok(workspace.resourceLinks.some(link => link.issueId === issue.id && link.documentId === document.id));
  const originalLinks = [];
  for (const [targetType, targetId, originalUrl] of [
    ['issue', issue.id, 'https://jira.example.test/jira/browse/OLD-1'],
    ['issue', otherIssue.id, 'https://jira.example.test/jira/browse/OLD-2'],
    ['document', document.id, 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=100'],
    ['document', sameSpaceDocument.id, 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=101'],
    ['document', remoteDocument.id, 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=102'],
  ]) {
    const query = new URLSearchParams({targetType, targetId});
    const links = await (await request(`/atlassian-links?${query}`)).json();
    assert.deepEqual(links.map(link => link.url), [originalUrl]);
    originalLinks.push(links[0]);
  }
  const reconciliation = await (await request(base)).json();
  const sourceRows = reconciliation.rows;
  for (const [product, kind, sourceId, key, target] of [
    ['jira', 'issue', '100', 'OLD-1', issue],
    ['jira', 'issue', '101', 'OLD-2', otherIssue],
    ['confluence', 'page', '100', null, document],
    ['confluence', 'page', '101', null, sameSpaceDocument],
    ['confluence', 'page', '102', null, remoteDocument],
  ]) {
    const sourceRow = sourceRows.find(row => row.product === product && row.kind === kind && row.sourceId === sourceId);
    assert.equal(sourceRow?.sourceKey, key);
    assert.equal(sourceRow.target?.id, target.id);
    assert.equal(sourceRow.status, 'linked');
  }
  const worklogs = await (await request(`/issues/${issue.id}/worklogs`)).json();
  assert.equal(worklogs.totalEntries, 1);
  assert.equal(worklogs.totalMinutes, 91 / 60);
  const [worklog] = worklogs.entries;
  assert.equal(worklog.authorId, authorId);
  assert.equal(worklog.durationSeconds, 91);
  assert.equal(worklog.workDate, '2020-01-02');
  assert.equal(worklog.note, '원본 작업 시간');
  const worklogRow = sourceRows.find(row => row.kind === 'history' && row.sourceId === 'worklog:31');
  assert.equal(worklogRow?.sourceRecordId, worklog.sourceRecordId);
  assert.equal(worklogRow.status, 'linked');
  assert.equal(worklogRow?.target?.id, worklog.id);
  assert.equal(worklogRow?.target?.type, 'worklog');
  const origin = await (await request(`/source-imports/${receipt.id}/records/${worklog.sourceRecordId}`)).json();
  assert.equal(origin.record.authorId, jiraAuthorKey);
  const restricted = sourceRows.find(row => row.kind === 'history' && row.sourceId === 'worklog:32');
  assert.equal(restricted?.status, 'excluded');
  assert.equal(restricted.target, null);
  const audit = await (await request(`${base}/audit?expectedVersion=${receipt.version}`)).json();
  assert.equal(audit.receiptVersion, receipt.version);
  assert.equal(receipt.integrity.version, 1);
  assert.equal(audit.integrity.status, 'verified');
  assert.deepEqual(audit.integrity.records, {expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords});
  assert.deepEqual(audit.integrity.boundAttachments, {expected: expectedFiles.length, observed: expectedFiles.length});
  assert.equal(audit.integrity.unmatchedRecords, 0);
  assert.equal(audit.integrity.columnMismatches, 0);
  assert.equal(audit.integrity.packages.length, receipt.packages.length);
  for (const checked of audit.integrity.packages) {
    const baseline = receipt.integrity.packages.find(item => item.stagingId === checked.stagingId);
    assert.equal(checked.status, 'verified');
    assert.deepEqual(checked.recordsSha256, {expected: baseline.recordsSha256, observed: baseline.recordsSha256});
  }
  assert.deepEqual(audit.recordCounts, reconciliation.counts);
  assert.equal(audit.recordCounts.missing, 0);
  assert.deepEqual(audit.attachmentCounts, {verified: expectedFiles.length, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0});
  assert.equal(audit.attachments.length, expectedFiles.length);
  for (const {product, sourceId, packageSha256, bytes} of expectedFiles) {
    const checked = audit.attachments.find(file => file.product === product && file.sourceId === sourceId);
    assert.equal(checked?.status, 'verified');
    assert.equal(checked.packageSha256, packageSha256);
    assert.equal(checked.size, bytes.length);
    assert.equal(checked.sha256, createHash('sha256').update(bytes).digest('hex'));
    const download = await request(`/attachment-versions/${checked.fileId}/download`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  const sharedFile = audit.attachments.find(file => file.product === 'confluence' && file.sourceId === '702');
  const attachmentLabel = document.content.content.flatMap(node => node.content ?? []).find(node => node.text === '다른 공간의 원본 첨부');
  assert.deepEqual(attachmentLabel?.marks?.map(mark => mark.attrs.href), [`/api/attachments/${sharedFile.fileId}/content`]);
  const sharedDownload = await request(`/attachments/${sharedFile.fileId}/content`);
  assert.deepEqual(Buffer.from(await sharedDownload.arrayBuffer()), expectedFiles.find(file => file.sourceId === '702').bytes);
  return {
    issue, otherIssue, document, nextStatus, originalLinks, sourceRows, worklog,
    integrity: audit.integrity, recordCounts: audit.recordCounts, attachments: audit.attachments,
  };
}

async function applyPilotCrossProjectJiraRelation(url, actorId, sourceIssue) {
  const headers = { 'X-Actor-Id': actorId };
  const sourceRow = (id, key, project, summary, issuelinks = []) => ({ id, key, fields: {
    project, summary, created: '2020-01-01T00:00:00Z', updated: '2020-01-03T00:00:00Z',
    status: { id: '1', name: 'Open' }, issuetype: { id: '5', name: 'Task' }, issuelinks,
  } });
  async function stageAndReadOptions(filename, issue) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: 'pilot-jira' });
    const { id } = await (await call(url, `/legacy-import/packages?${query}`, { method: 'POST', status: 201,
      headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(JSON.stringify({ issues: [issue] })),
    })).json();
    return (await call(url, `/migrations/options?${new URLSearchParams({ packageId: id })}`, { headers })).json();
  }
  const previewFor = async configuration => (await call(url, '/migrations/preview', { method: 'POST', status: 201,
    headers, body: { configuration }, })).json();
  const apply = async preview => (await (await call(url, `/migrations/previews/${preview.id}/apply`, {
    method: 'POST', status: 201, headers,
    body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
  })).json()).import;

  const peerTitle = '파일럿 다른 Jira 프로젝트 업무';
  const peer = await stageAndReadOptions('pilot-jira-peer.json', sourceRow('201', 'PEER-1',
    { id: '21', key: 'PEER', name: '파일럿 다른 원본 프로젝트' }, peerTitle));
  const peerConfig = peer.defaultConfiguration;
  peerConfig.projects = peerConfig.projects.map(project => ({ ...project, key: 'PILOTPEER', name: '파일럿 다른 Jira 프로젝트' }));
  const peerReceipt = await apply(await previewFor(peerConfig));
  const workspace = await (await call(url, '/workspace', { headers })).json();
  const targetIssue = workspace.issues.find(issue => issue.projectId === peerReceipt.projectIds[0] && issue.title === peerTitle);
  assert.ok(targetIssue);
  assert.notEqual(sourceIssue.projectId, targetIssue.projectId);

  const delta = await stageAndReadOptions('pilot-jira-cross-relation.json', sourceRow('100', 'OLD-1',
    { id: '20', key: 'OLD', name: '파일럿 원본 프로젝트' }, '파일럿 원본 업무', [{ id: '610', outwardIssue: { id: '201' },
      type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } }]));
  const { appendTarget } = delta;
  assert.equal(appendTarget?.projectId, sourceIssue.projectId);
  const preview = await previewFor({ ...delta.defaultConfiguration, appendTo: { projectId: sourceIssue.projectId,
    statuses: {}, issueTypes: {}, fields: {}, refreshRelations: true } });
  assert.ok(preview.canApply, JSON.stringify(preview.notices));
  assert.equal(preview.counts.issues, 0);
  assert.equal(preview.counts.newJiraRelations, 1);
  const [row] = preview.jiraRelationRefresh;
  assert.deepEqual([row.sourceKey, row.targetKey, row.sourceProjectName, row.targetProjectName],
    [sourceIssue.key, targetIssue.key, '파일럿 합성 이관', '파일럿 다른 Jira 프로젝트']);
  const receipt = await apply(preview);
  assert.deepEqual(new Set(receipt.projectIds), new Set([sourceIssue.projectId, targetIssue.projectId]));
  return { receipt, sourceIssueId: sourceIssue.id, targetIssueId: targetIssue.id, targetProjectId: targetIssue.projectId };
}

async function verifyPilotCrossProjectJiraRelation(url, { receipt, sourceIssueId, targetIssueId, targetProjectId }) {
  const [source, target, audit, blockers, report] = await Promise.all([
    call(url, `/issues/${sourceIssueId}/relations`),
    call(url, `/issues/${targetIssueId}/relations`),
    call(url, `/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`),
    call(url, '/schedule/team-blockers'),
    call(url, `/projects/${targetProjectId}/delivery-blockers?reason=issue_block`),
  ].map(response => response.then(item => item.json())));
  assert.equal(source.length, 1);
  assert.equal(source[0].verifiedBlockerDirection, 'outgoing');
  assert.deepEqual(target, [{ ...source[0], verifiedBlockerDirection: 'incoming' }]);
  const [relation] = source;
  assert.deepEqual([relation.sourceIssueId, relation.targetIssueId, relation.type], [sourceIssueId, targetIssueId, 'Blocks']);
  assert.equal(audit.integrity.status, 'verified');
  assert.equal(audit.targetContent.issueRelations.count, 1);
  assert.match(audit.targetContent.issueRelations.sha256, /^[a-f0-9]{64}$/);
  const blocker = blockers.find(row => row.id === relation.id);
  assert.deepEqual(blocker, { id: relation.id, sourceIssueId, targetIssueId, version: relation.version, origin: 'jira' });
  const reported = report.items.find(row => row.issue.id === targetIssueId)?.blockers;
  assert.equal(reported?.total, 1);
  assert.deepEqual(reported.items.map(({ id, origin }) => ({ id, origin })), [{ id: sourceIssueId, origin: 'jira' }]);
  return { relation, blocker, reported, evidence: audit.targetContent.issueRelations };
}

async function browser(url, teamFixture, accessFile) {
  interruption.signal.throwIfAborted();
  const playwright = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  const env = { ...process.env, TEAMSPACE_PILOT_TEST_URL: url };
  delete env.TEAMSPACE_PILOT_TEAM_FIXTURE;
  delete env.TEAMSPACE_PILOT_TEST_ACCESS_FILE;
  if (teamFixture) {
    env.TEAMSPACE_PILOT_TEAM_FIXTURE = JSON.stringify(teamFixture);
    env.TEAMSPACE_PILOT_TEST_ACCESS_FILE = accessFile;
    delete env.DEBUG;
    delete env.PWDEBUG;
    delete env.NODE_DEBUG;
  }
  const child = spawn(process.execPath, [playwright, 'test', '--config=playwright.pilot.config.ts', `--output=${join(scratch,'browser')}`, '--reporter=line'], {
    cwd: repo, stdio: 'inherit', env, detached: process.platform !== 'win32',
  });
  browserChild = child;
  try {
    const [code, signal] = await once(child, 'exit');
    interruption.signal.throwIfAborted();
    assert.equal(code, 0, `Pilot browser checks failed (${code ?? signal}).`);
  } finally {
    browserChild = undefined;
    clearTimeout(browserShutdownTimer);
  }
}

const syntheticToken = randomUUID();
const manualBranchName = 'feature/existing-refactor';
const manualCommitSha = 'd'.repeat(40);
let authenticatedReads = 0;
const gitlab = createServer((request, response) => {
  if (request.method !== 'GET' || request.headers['private-token'] !== syntheticToken) {
    response.writeHead(403).end();
    return;
  }
  const project = `http://${request.headers.host}/platform/pilot`;
  const url = new URL(request.url, project);
  const projectEndpoint = '/api/v4/projects/42';
  let payload;
  if (url.pathname === '/api/v4/projects' && url.searchParams.get('search') === 'platform') {
    payload = [{ id: 42, name: 'Pilot Repository', web_url: project, path_with_namespace: 'platform/pilot' }];
  } else if (url.pathname === projectEndpoint) {
    payload = { id: 42, web_url: project, path_with_namespace: 'platform/pilot' };
  } else if (url.pathname === `${projectEndpoint}/repository/branches/${encodeURIComponent(manualBranchName)}`) {
    payload = { name: manualBranchName, commit: { id: manualCommitSha } };
  } else if (url.pathname === `${projectEndpoint}/repository/commits/${manualCommitSha}`) {
    payload = { id: manualCommitSha, title: 'Repository refactor', committed_date: '2020-01-02T00:00:00Z' };
  } else if (url.pathname === `${projectEndpoint}/merge_requests`) {
    payload = [{ id: 530, iid: 12, title: 'OLD-1 파일럿 원본 업무', source_branch: 'feature/OLD-1',
      web_url: `${project}/-/merge_requests/12`, state: 'merged', updated_at: '2020-01-02T01:02:00Z' }];
  } else if (url.pathname === `${projectEndpoint}/pipelines` || url.pathname === `${projectEndpoint}/deployments`) {
    payload = [];
  } else {
    response.writeHead(404).end();
    return;
  }
  authenticatedReads++;
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
});

async function teamSnapshot(api, fixture, evidence) {
  const documentPath = `/documents/${fixture.documentId}`;
  const session = await api(`${documentPath}/collaboration`);
  const workspace = await api('/export');
  const current = workspace.documents.find(document => document.id === fixture.documentId);
  const recovery = workspace.documents.find(document => document.id === evidence.recoveryDocumentId);
  const state = workspace.collabStates.find(value => value.documentId === fixture.documentId);
  assert.ok(current && recovery && state, 'The original document, the recovery copy and persisted collaboration state must exist.');
  assert.equal(session.enabled, true);
  assert.equal(session.epoch, evidence.finalEpoch);
  assert.equal(state.epoch, session.epoch);
  assert.equal(state.schemaVersion, session.schemaVersion);
  assert.ok(typeof state.state === 'string' && state.state.length > 0, 'The saved Yjs payload must be present.');
  assert.equal(current.version, evidence.documentVersion);
  assert.ok(current.plainText === evidence.plainText, 'The browser and canonical document must agree on the saved text.');
  assert.ok(JSON.stringify(current) === JSON.stringify(session.document), 'The collaboration session must expose the canonical document.');
  assert.ok(!current.plainText.includes(evidence.staleMarker), 'The original document must exclude the stale offline edit.');
  assert.ok(recovery.plainText === evidence.recoveryText, 'The stored recovery copy must match the copy observed by the browser.');
  assert.equal(recovery.plainText.split(evidence.staleMarker).length, 2, 'The recovery copy must contain the stale offline edit once.');
  assert.equal(recovery.projectId, fixture.projectId);
  assert.equal(recovery.authorId, fixture.actorIds.at(-1));
  assert.deepEqual(new Set(workspace.users.map(user => user.id)), new Set(fixture.actorIds));

  const traffic = evidence.workspaceTraffic;
  const issue = workspace.issues.find(value => value.id === fixture.issueId);
  const issueList = workspace.documents.find(document => document.id === traffic.issueListDocumentId);
  assert.ok(issue && issueList && issueList.id !== current.id && issueList.id !== recovery.id, 'The concurrent issue and issue list must exist.');
  assert.equal(traffic.issueId, issue.id);
  assert.equal(issue.version, traffic.issueVersion);
  assert.equal(issue.plannedEffortMinutes, traffic.plannedEffortMinutes);
  assert.equal(issue.startDate, traffic.workingDate);
  assert.equal(issue.endDate, traffic.workingDate);
  const statusHandoff = traffic.statusHandoff;
  assert.equal(statusHandoff.observerId, fixture.actorIds[1]);
  assert.equal(issue.assigneeId, statusHandoff.observerId);
  const { entries: issueHistory } = await api(`/issues/${encodeURIComponent(issue.id)}/change-history`);
  const statusRevision = issueHistory.find(entry => entry.id === statusHandoff.history.id);
  assert.deepEqual(statusRevision, statusHandoff.history);
  const bulk = traffic.bulkDates;
  const otherIssue = workspace.issues.find(value => value.id === bulk.otherIssueId && value.projectId === bulk.otherProjectId);
  assert.ok(otherIssue && otherIssue.projectId !== issue.projectId);
  assert.equal(issue.dueDate, bulk.dueDate);
  assert.equal(otherIssue.dueDate, bulk.dueDate);
  assert.equal(otherIssue.version, bulk.otherIssueVersion);
  const competingEdit = bulk.competingEdit;
  assert.equal(competingEdit.actorId, fixture.actorIds[2]);
  assert.equal(otherIssue.version, competingEdit.version + 1);
  assert.deepEqual([otherIssue.startDate, otherIssue.endDate], [competingEdit.date, competingEdit.date]);
  const replayBulkDates = (actorId, previewId) => api('/schedule/bulk-dates/apply', {
    method: 'POST', headers: { 'X-Actor-Id': actorId }, body: { previewId },
  });
  const [replay, competingReplay, competingHistory] = await Promise.all([
    replayBulkDates(fixture.actorIds[0], bulk.previewId),
    replayBulkDates(competingEdit.actorId, competingEdit.previewId),
    api(`/issues/${encodeURIComponent(otherIssue.id)}/change-history`),
  ]);
  assert.equal(replay.undoId, bulk.undoId);
  assert.equal(replay.updated.length, 2);
  assert.deepEqual(replay.updated.find(value => value.id === issue.id), issue);
  assert.deepEqual(replay.updated.find(value => value.id === otherIssue.id), otherIssue);
  assert.equal(competingReplay.undoId, competingEdit.undoId);
  assert.equal(competingReplay.updated.length, 1);
  const { id, version, startDate, endDate, dueDate } = competingReplay.updated[0];
  assert.deepEqual({ id, version, startDate, endDate, dueDate },
    { id: otherIssue.id, version: competingEdit.version, startDate: competingEdit.date, endDate: competingEdit.date, dueDate: null });
  const competingRevision = competingHistory.entries.find(entry => entry.id === competingEdit.historyId);
  assert.ok(competingRevision);
  assert.equal(competingRevision.issueId, otherIssue.id);
  assert.equal(competingRevision.actorId, competingEdit.actorId);
  assert.equal(competingRevision.issueVersion, competingEdit.version);
  assert.deepEqual(Object.fromEntries(competingRevision.changes.map(change => [change.field, [change.before.value, change.after.value]])),
    { startDate: [null, competingEdit.date], endDate: [null, competingEdit.date] });
  const [dueDateRevision] = competingHistory.entries;
  assert.ok(dueDateRevision);
  assert.equal(dueDateRevision.issueId, otherIssue.id);
  assert.equal(dueDateRevision.actorId, fixture.actorIds[0]);
  assert.equal(dueDateRevision.issueVersion, otherIssue.version);
  assert.deepEqual(dueDateRevision.changes.map(change => [change.field, change.before.value, change.after.value]), [['dueDate', null, bulk.dueDate]]);
  const handoff = traffic.handoff;
  const anchor = workspace.issues.find(value => value.id === handoff.anchorId && value.projectId === fixture.projectId);
  const downstream = workspace.issues.find(value => value.id === handoff.issueId && value.projectId === bulk.otherProjectId);
  const blocker = workspace.issueRelations.find(value => value.id === handoff.relationId);
  const otherCalendar = workspace.calendars.find(value => value.projectId === bulk.otherProjectId);
  assert.ok(anchor && downstream && blocker && otherCalendar);
  assert.deepEqual([anchor.startDate, anchor.endDate], [handoff.anchorDate, handoff.anchorDate]);
  assert.deepEqual([downstream.startDate, downstream.endDate], [handoff.date, handoff.date]);
  assert.deepEqual([blocker.sourceIssueId, blocker.targetIssueId, blocker.type], [anchor.id, downstream.id, 'blocks']);
  assert.ok(otherCalendar.exceptions.some(value => value.date === handoff.dayOff && value.isWorking === false));
  const handoffReceipt = await api(`/schedule/team-follow-up-result/${handoff.previewId}`, {
    headers: { 'X-Actor-Id': fixture.actorIds[0] },
  });
  assert.equal(handoffReceipt.undoId, handoff.undoId);
  assert.deepEqual(handoffReceipt.updated, [anchor, downstream]);
  const listNode = issueList.content.content?.find(node => node.type === 'issueList' && node.attrs?.projectId === fixture.projectId);
  const view = workspace.savedViews?.find(value => value.id === listNode?.attrs.savedViewId && value.projectId === fixture.projectId);
  assert.ok(listNode && view, 'The issue list must retain its project and same-project saved view.');
  const scheduled = traffic.scheduledSuccessor;
  assert.ok(scheduled && scheduled.issueId !== issue.id, 'The dependency schedule must include a different successor.');
  const successor = workspace.issues.find(value => value.id === scheduled.issueId && value.projectId === fixture.projectId);
  const dependency = workspace.dependencies.find(value => value.id === scheduled.dependencyId);
  assert.ok(successor && dependency, 'The committed successor schedule and its dependency must exist.');
  assert.deepEqual([successor.version, successor.startDate, successor.endDate], [scheduled.issueVersion, scheduled.startDate, scheduled.endDate]);
  assert.deepEqual([dependency.predecessorId, dependency.successorId, dependency.type, dependency.lagDays],
    [issue.id, successor.id, 'FS', scheduled.lagDays]);

  const gitlab = evidence.gitlabTraffic;
  assert.ok(gitlab?.issue && gitlab.issue.id === fixture.gitlabIssueId && gitlab.issue.projectId === fixture.projectId);
  const gitlabIssue = workspace.issues.find(value => value.id === gitlab.issue.id);
  const gitlabRule = workspace.automationRules.find(rule => rule.id === gitlab.rule.id);
  const gitlabRuns = workspace.automationRuns.filter(run => run.issueId === gitlab.issue.id);
  const storedLinks = workspace.gitlabLinks.filter(link => link.issueId === gitlab.issue.id);
  const [gitlabLinks, webhookStatus, gitlabSettings] = await Promise.all([
    api(`/issues/${gitlab.issue.id}/gitlab-links?kind=pipeline`), api('/integrations/gitlab/webhook-status'),
    api('/integrations/gitlab'),
  ]);
  assert.deepEqual(gitlabIssue, gitlab.issue);
  assert.deepEqual(gitlabRule, gitlab.rule);
  assert.deepEqual(gitlabRuns, gitlab.runs);
  assert.deepEqual(gitlabLinks, gitlab.links);
  assert.deepEqual(storedLinks.toSorted((a, b) => a.id.localeCompare(b.id)), gitlabLinks.links.toSorted((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(webhookStatus, gitlab.webhookStatus);
  assert.equal(gitlabSettings.signingTokenConfigured, true);
  assert.deepEqual(gitlabSettings.jiraRoutes, gitlab.settings.jiraRoutes);

  return {
    documentVersion: current.version, epoch: state.epoch, recoveryVersion: recovery.version, issueVersion: issue.version,
    // Hash complete records to compare the exact persisted fields without printing the body or Yjs bytes on mismatch.
    digest: createHash('sha256').update(JSON.stringify({ current, recovery, state, issue, otherIssue, downstream, blocker,
      otherCalendar, successor, dependency, issueList, view, statusRevision, competingReplay, competingRevision, dueDateRevision,
      gitlabIssue, gitlabRule, gitlabRuns, gitlabLinks, webhookStatus })).digest('hex'),
  };
}

async function verifyTeamMigration(pilot, migration, dataDir, fixture) {
  const audit = await verifyPilotSourceMigration(pilot.request, migration, fixture.actorIds[1]);
  assert.equal(audit.issue.id, fixture.issueId);
  assert.equal(audit.document.id, fixture.documentId);
  assert.equal(audit.otherIssue.id, fixture.gitlabIssueId);
  for (const {summary} of migration.packages) {
    assert.equal(fileHash(join(dataDir, 'legacy-imports', `${summary.id}.bundle`)), summary.sha256);
  }
  return createHash('sha256').update(JSON.stringify(audit)).digest('hex');
}

async function runTeamPilot(seconds) {
  const file = join(scratch, 'team-access-key');
  const code = randomBytes(32).toString('hex');
  writeFileSync(file, `${code}\n`, { flag: 'wx', mode: 0o600 });
  const proxy = await startPilotTestProxy(scratch);
  try { await rehearseTeamPilot(seconds, proxy, { origin: proxy.origin, file, code }); }
  finally { await proxy.close(); }
}

async function rehearseTeamPilot(seconds, proxy, access) {
  const retiredCookies = new Set();
  const pilot = await openTeamPilot(proxy, access, source, retiredCookies);
  const actorIds = [];
  for (let index = 1; index <= 20; index++) {
    const actorNumber = String(index).padStart(2, '0');
    const user = await pilot.api('/users', {
      method: 'POST', status: 201, body: { name: `합성 팀원 ${actorNumber}`, email: `pilot-${actorNumber}@example.invalid` },
    });
    actorIds.push(user.id);
  }
  assert.equal(new Set(actorIds).size, 20);
  const headers = { 'X-Actor-Id': actorIds[0] };
  const migration = await applyPilotSourceMigration(pilot.request, actorIds[0], actorIds[0]);
  const imported = await verifyPilotSourceMigration(pilot.request, migration);
  assert.notEqual(imported.issue.status, imported.nextStatus);
  assert.equal(imported.otherIssue.status, imported.nextStatus);
  const workflowPath = `/projects/${imported.issue.projectId}/workflow`;
  const workflow = await pilot.api(workflowPath);
  const review = { id: 'pilot_review', label: '검토', category: 'review', color: '#668899' };
  await pilot.api(workflowPath, { method: 'PATCH', headers, body: {
    ...workflow, expectedVersion: workflow.version, statuses: [...workflow.statuses, review],
    transitions: [...workflow.transitions, { from: imported.nextStatus, to: review.id, issueTypes: [], requiredFields: [] }],
  } });
  const planned = new Date();
  do { planned.setUTCDate(planned.getUTCDate() + 1); } while ([0, 6].includes(planned.getUTCDay()));
  const workingDate = planned.toISOString().slice(0, 10);
  const issue = await pilot.api(`/issues/${imported.issue.id}`, {
    method: 'PATCH', headers, body: {
      expectedVersion: imported.issue.version, startDate: workingDate, endDate: workingDate, plannedEffortMinutes: 30,
    },
  });
  const editingParagraph = '파일럿 공동 편집 기록';
  const document = await pilot.api(`/documents/${imported.document.id}`, {
    method: 'PATCH', headers, body: {
      expectedVersion: imported.document.version,
      content: { type: 'doc', content: [...imported.document.content.content,
        { type: 'paragraph', content: [{ type: 'text', text: editingParagraph }] }] },
    },
  });
  const session = await pilot.api(`/documents/${document.id}/collaboration/enable`, {
    method: 'POST', headers, body: { expectedVersion: document.version },
  });
  assert.ok(session.enabled && session.epoch);
  const evidencePath = join(scratch, 'team-evidence.json');
  const fixture = {
    actorIds, projectId: issue.projectId, documentId: document.id, issueId: issue.id,
    title: document.title, initialText: session.document.plainText, editingParagraph,
    migratedIssueKey: issue.key, originalJiraKey: 'OLD-1', gitlabIssueId: imported.otherIssue.id,
    gitlabOriginalJiraKey: 'OLD-2', gitlabJiraInstanceKey: 'pilot-jira',
    initialEpoch: session.epoch, seconds, evidencePath,
  };
  console.log(`Team pilot started: ${actorIds.length} actors over HTTPS, at least ${seconds}s of shared editing on migrated content.`);
  await browser(proxy.origin, fixture, access.file);

  const browserEvidence = readFileSync(evidencePath, 'utf8');
  assert.ok(!browserEvidence.includes(access.code), 'The browser evidence must exclude the access key.');
  const evidence = JSON.parse(browserEvidence);
  assert.deepEqual(evidence.authentication, { transport: 'https', browserSessions: actorIds.length });
  assert.equal(evidence.documentId, document.id);
  assert.deepEqual(evidence.migrationReference, {projectId: fixture.projectId, issueId: issue.id, documentId: document.id,
    currentIssueKey: issue.key, originalJiraKey: fixture.originalJiraKey});
  assert.equal(evidence.originalEpoch, session.epoch);
  assert.ok(typeof evidence.finalEpoch === 'string' && evidence.finalEpoch !== session.epoch);
  assert.ok(Number.isSafeInteger(evidence.documentVersion) && evidence.documentVersion > session.document.version);
  assert.ok(typeof evidence.plainText === 'string' && evidence.plainText.includes(fixture.initialText));
  assert.ok(typeof evidence.staleMarker === 'string' && evidence.staleMarker.length > 0);
  assert.ok(typeof evidence.recoveryText === 'string' && evidence.recoveryText.includes(evidence.staleMarker));
  assert.ok(typeof evidence.recoveryDocumentId === 'string' && evidence.recoveryDocumentId !== document.id);
  assert.equal(evidence.peerCount, actorIds.length);
  assert.ok(Number.isSafeInteger(evidence.rounds) && evidence.rounds >= 2);
  assert.ok(Number.isSafeInteger(evidence.editCount) && evidence.editCount >= actorIds.length);
  assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= seconds * 1_000);
  assert.ok(evidence.workspaceTraffic, 'The browser must verify issue and issue-list changes during editing.');
  const { statusHandoff } = evidence.workspaceTraffic;
  const { history } = statusHandoff;
  assert.equal(history.issueId, issue.id);
  assert.equal(history.issueVersion, issue.version + 1);
  assert.equal(history.actorId, actorIds[0]);
  assert.equal(statusHandoff.observerId, actorIds[1]);
  const handoffChanges = Object.fromEntries(history.changes.map(change => [change.field, [change.before.value, change.after.value]]));
  assert.deepEqual(handoffChanges.status, [issue.status, imported.nextStatus]);
  assert.deepEqual(handoffChanges.assigneeId, [actorIds[0], actorIds[1]]);
  const baseline = await teamSnapshot(pilot.api, fixture, evidence);
  const migrationBaseline = await verifyTeamMigration(pilot, migration, source, fixture);
  await stop(pilot);
  proxy.setBackendPort(null);

  const reopened = await openTeamPilot(proxy, access, source, retiredCookies);
  assert.deepEqual(await teamSnapshot(reopened.api, fixture, evidence), baseline, 'The source changed across a restart.');
  assert.equal(await verifyTeamMigration(reopened, migration, source, fixture), migrationBaseline, 'Migration evidence changed across a restart.');
  await stop(reopened);
  proxy.setBackendPort(null);

  const saved = cli('backup', source, backup);
  assert.equal(saved.status, 0, saved.stderr);
  for (const entry of readdirSync(backup, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    assert.ok(!bytes.includes(access.code) && [...retiredCookies].every(cookie => !bytes.includes(cookie.split('=')[1])),
      'The pilot backup must exclude the access key and active session tokens.');
  }
  const recovery = cli('restore', backup, restored);
  assert.equal(recovery.status, 0, recovery.stderr);
  const copy = await openTeamPilot(proxy, access, restored, retiredCookies);
  assert.deepEqual(await teamSnapshot(copy.api, fixture, evidence), baseline, 'The separate restoration changed the saved data.');
  assert.equal(await verifyTeamMigration(copy, migration, restored, fixture), migrationBaseline, 'The separate restoration changed migration evidence.');
  await stop(copy);
  console.log(`Team pilot passed: ${evidence.peerCount} independent HTTPS browser sessions, ${evidence.rounds} rounds, ${evidence.editCount} retained edits, ` +
    `${(evidence.elapsedMs / 1000).toFixed(1)}s. Re-authenticated after restart and separate restore, then matched Jira and Confluence records and attachment bytes, ` +
    'documents, cross-project schedules and receipts, GitLab pipeline links by original Jira key, and the single automation transition.');
}

async function runStandardPilot() {
  const empty = await start(join(scratch, 'empty'));
  const emptyWorkspace = await (await call(empty.url, '/workspace')).json();
  assert.deepEqual(emptyWorkspace.users, []);
  assert.deepEqual(emptyWorkspace.projects, []);
  await stop(empty);

  const pilot = await start(source, true);
  await browser(pilot.url);
  const workspace = await (await call(pilot.url, '/workspace')).json();
  const projectId = workspace.projects[0].id;
  const assigneeId = workspace.users[0].id;
  const workloadDate = '2026-11-23';
  const workloadPath = `/projects/${projectId}/workload?startDate=${workloadDate}&endDate=${workloadDate}`;
  const capacityPath = `/projects/${projectId}/workload-capacity`;
  const teamCapacityPath = '/workload-capacity';
  const teamWorkloadPath = `/workload?startDate=${workloadDate}&endDate=${workloadDate}`;
  const initialCapacity = await (await call(pilot.url,capacityPath)).json();
  await call(pilot.url,capacityPath,{method:'PATCH',body:{expectedVersion:initialCapacity.version,members:[{userId:assigneeId,dailyMinutes:240}]}});
  const teamCapacity = await (await call(pilot.url,teamCapacityPath)).json();
  const savedTeamCapacity = await (await call(pilot.url,teamCapacityPath,{
    method:'PATCH',body:{expectedVersion:teamCapacity.version,exceptions:[{userId:assigneeId,date:workloadDate,availableMinutes:320}]},
  })).json();
  const issueCreation = {
    method:'POST', headers:{'X-Actor-Id':workspace.users[1].id},
    body:{requestId:randomUUID(),projectId,title:'파일럿 백업 복원 업무',assigneeId,startDate:workloadDate,endDate:workloadDate,estimate:2,plannedEffortMinutes:300},
  };
  const issue = await (await call(pilot.url, '/issues', {...issueCreation,status:201})).json();
  assert.deepEqual(await (await call(pilot.url,'/issues',issueCreation)).json(),issue);
  const issueCreationEvidence = async url => {
    const [current, inbox] = await Promise.all([
      call(url,'/workspace').then(response=>response.json()),
      call(url,'/notifications',{headers:{'X-Actor-Id':assigneeId}}).then(response=>response.json()),
    ]);
    assert.deepEqual(current.issues.filter(item=>item.projectId===projectId&&item.title===issue.title).map(item=>item.id),[issue.id]);
    assert.equal(current.activities.filter(item=>item.resourceId===issue.id&&item.action==='티켓 생성').length,1);
    assert.equal(inbox.items.filter(item=>item.targetId===issue.id&&item.kind==='issue-assigned').length,1);
  };
  await issueCreationEvidence(pilot.url);
  const parallelProjectId = workspace.projects[1].id;
  const parallel = await (await call(pilot.url,'/issues',{
    method:'POST',status:201,body:{projectId:parallelProjectId,title:'파일럿 병행 업무',assigneeId,startDate:workloadDate,endDate:workloadDate,plannedEffortMinutes:90},
  })).json();
  const rulesPath = `/projects/${parallelProjectId}/assignment-rules`;
  const runsPath = `/projects/${parallelProjectId}/assignment-runs`;
  const schemaPath = `/projects/${parallelProjectId}/issue-schema`;
  const parallelSchema = await (await call(pilot.url, schemaPath)).json();
  const commonField = {description: '', issueTypes: [], options: [], archived: false};
  const savedSchema = await (await call(pilot.url, schemaPath, {
    method: 'PATCH', body: { ...parallelSchema, expectedVersion: parallelSchema.version, fields: [...parallelSchema.fields,
      {...commonField, id: 'pilot_gate', name: '파일럿 추가 확인', kind: 'checkbox', required: false},
      {...commonField, id: 'pilot_proof', name: '파일럿 확인 내용', kind: 'text', required: true,
        visibleWhen: {statusIds: ['in_progress'], fieldMatch: {fieldId: 'pilot_gate', value: true}}},
    ] },
  })).json();
  assert.deepEqual(savedSchema.fields.find(field => field.id === 'pilot_proof').visibleWhen, {
    statusIds: ['in_progress'], fieldMatch: {fieldId: 'pilot_gate', value: true},
  });
  const routingIssue = await (await call(pilot.url, '/issues', {
    method: 'POST', status: 201, body: {projectId: parallelProjectId, title: '파일럿 담당자 배정 업무', customFields: {pilot_gate: true}},
  })).json();
  const rule = await (await call(pilot.url, rulesPath, {
    method: 'POST', status: 201,
    body: {name: '파일럿 진행 업무 배정', enabled: true, fromStatuses: [routingIssue.status], toStatusId: 'in_progress', assigneeId: workspace.users[1].id},
  })).json();
  const blockedTransition = await (await call(pilot.url, `/issues/${routingIssue.id}`, {
    method: 'PATCH', status: 422, body: {status: rule.toStatusId, expectedVersion: routingIssue.version},
  })).json();
  assert.deepEqual(blockedTransition.details.requiredFields, ['custom:pilot_proof']);
  const routedIssue = await (await call(pilot.url, `/issues/${routingIssue.id}`, {
    method: 'PATCH', body: {status: rule.toStatusId, expectedVersion: routingIssue.version,
      customFields: {pilot_gate: true, pilot_proof: '착수 조건 확인'}},
  })).json();
  assert.equal(routedIssue.assigneeId, rule.assigneeId);
  assert.equal(routedIssue.version, routingIssue.version + 1);
  const fieldBreakdownPath = `/projects/${parallelProjectId}/field-breakdown`;
  const fieldBreakdownQuery = { fieldId: 'pilot_proof', comparisonFieldId: 'pilot_gate' };
  const fieldBreakdownPreset = await (await call(pilot.url, `${fieldBreakdownPath}-presets`, {
    method: 'POST', status: 201, body: { name: '파일럿 사용자 정의 교차 집계', query: fieldBreakdownQuery },
  })).json();
  const verifyFieldBreakdown = async url => {
    const presets = await (await call(url, `${fieldBreakdownPath}-presets`)).json();
    assert.deepEqual(presets.find(preset => preset.id === fieldBreakdownPreset.id), fieldBreakdownPreset);
    const report = await (await call(url, fieldBreakdownPath, { method: 'POST', body: fieldBreakdownPreset.query })).json();
    assert.equal(report.comparison.field.id, 'pilot_gate');
    const row = report.groups.find(group => group.label === '착수 조건 확인');
    const column = report.comparison.columns.find(group => group.label === '예');
    assert.ok(row && column);
    assert.equal(report.comparison.counts[row.id][column.id], 1);
    const members = await (await call(url, `${fieldBreakdownPath}/issues`, { method: 'POST', body: {
      ...fieldBreakdownPreset.query, revision: report.revision, bucketId: row.id, comparisonBucketId: column.id,
    } })).json();
    assert.deepEqual(members.issues.map(item => item.id), [routedIssue.id]);
  };
  await verifyFieldBreakdown(pilot.url);
  const pastePath = `/projects/${parallelProjectId}/issues/paste`;
  const pasteText = [
    ['제목', '임시 키', '시작일', '종료일', '선행 업무', '연결 유형', '근무일 간격'],
    ['파일럿 신규 연결 검토', 'review', '2027-04-06', '2027-04-06', `new:prep,${routedIssue.key}`, 'FS,SS', '0,-1'],
    ['파일럿 신규 연결 준비', 'prep', '2027-04-05', '2027-04-05', '', '', ''],
  ].map(row => row.join('\t')).join('\n');
  const pastePreview = await (await call(pilot.url, `${pastePath}-preview`, { method: 'POST', body: { text: pasteText } })).json();
  assert.ok(pastePreview.previewId);
  assert.deepEqual(pastePreview.errors, []);
  assert.deepEqual(pastePreview.rows[0].predecessors.map(link => [link.predecessor.kind, link.type, link.lagDays]),
    [['new', 'FS', 0], ['existing', 'SS', -1]]);
  assert.equal(pastePreview.rows[0].predecessors[0].predecessor.line, 3);
  assert.ok(pastePreview.rows[0].predecessors[1].warning);
  const pasteBody = { previewId: pastePreview.previewId };
  const linkedPaste = await (await call(pilot.url, `${pastePath}-apply`, { method: 'POST', status: 201, body: pasteBody })).json();
  const [pastedReview, pastedPrep] = linkedPaste.issues;
  assert.deepEqual(linkedPaste.issues.map(item => item.title), pastePreview.rows.map(item => item.title));
  assert.equal(Number(pastedPrep.key.split('-').at(-1)), Number(pastedReview.key.split('-').at(-1)) + 1);
  assert.deepEqual(linkedPaste.dependencies.map(link => [link.predecessorId, link.successorId, link.type, link.lagDays]),
    [[pastedPrep.id, pastedReview.id, 'FS', 0], [routedIssue.id, pastedReview.id, 'SS', -1]]);
  const verifyLinkedPaste = async url => {
    const replay = await (await call(url, `${pastePath}-apply`, { method: 'POST', body: pasteBody })).json();
    assert.deepEqual(replay, { ...linkedPaste, duplicate: true });
    const live = await (await call(url, '/workspace')).json();
    assert.deepEqual(new Set(live.dependencies.filter(link => link.successorId === pastedReview.id).map(link => link.id)),
      new Set(linkedPaste.dependencies.map(link => link.id)));
    assert.deepEqual(live.issues.filter(item => item.id === pastedReview.id || item.id === pastedPrep.id).map(item => [item.startDate, item.endDate]),
      [[pastedReview.startDate, pastedReview.endDate], [pastedPrep.startDate, pastedPrep.endDate]]);
  };
  await verifyLinkedPaste(pilot.url);
  const assignmentRuns = await (await call(pilot.url, runsPath)).json();
  assert.equal(assignmentRuns.total, 1);
  assert.equal(assignmentRuns.items[0].issueId, routedIssue.id);
  assert.equal(assignmentRuns.items[0].outcome, 'assigned');
  const reservationPath = `/issues/${issue.id}/time-reservations`;
  const reservedTime = {userId:assigneeId,startAt:`${workloadDate}T00:00:00.000Z`,endAt:`${workloadDate}T01:00:00.000Z`};
  const reservation = await (await call(pilot.url,reservationPath,{
    method:'POST',status:201,body:{...reservedTime,requestId:randomUUID()},
  })).json();
  const calendarPath = `/time-reservations?${new URLSearchParams({startAt:reservedTime.startAt,endAt:reservedTime.endAt,userId:assigneeId})}`;
  const document = await (await call(pilot.url,'/documents',{
    method:'POST',status:201,body:{projectId,title:'파일럿 백업 복원 문서',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'고정할 원본 문서'}]}]}},
  })).json();
  const documentPath = `/documents/${document.id}`;
  const decisionText = '고정할 원본 문서';
  const decisionLink = (await (await call(pilot.url, `${documentPath}/decision-links`, { method: 'POST', status: 201, body: {
    requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: routedIssue.id,
    sourceSelection: { from: 1, to: decisionText.length + 1, text: decisionText },
  } })).json()).link;
  const decisionReportPath = `/projects/${parallelProjectId}/decision-follow-ups`;
  const decisionFilters = { status: 'all', q: document.title };
  const decisionReportQuery = `${decisionReportPath}?${new URLSearchParams(decisionFilters)}`;
  const decisions = await (await call(pilot.url, decisionReportQuery)).json();
  assert.deepEqual(decisions.items.map(item => item.linkId), [decisionLink.id]);
  const decisionDraftBody = { ...decisionFilters, revision: decisions.revision, requestId: randomUUID(),
    title: '파일럿 결정 후속 회의 초안', destinationProjectId: null };
  const decisionDraftPath = `${decisionReportPath}/meeting-draft`;
  const decisionDraft = await (await call(pilot.url, decisionDraftPath, { method: 'POST', status: 201, body: decisionDraftBody })).json();
  assert.equal(decisionDraft.document.projectId, null);
  assert.ok(decisionDraft.document.plainText.includes(decisionText));
  const verifyDecisionDraft = async url => {
    const replay = await (await call(url, decisionDraftPath, { method: 'POST', body: decisionDraftBody })).json();
    assert.deepEqual(replay, { document: decisionDraft.document, duplicate: true });
    const [workspace, page, revisions] = await Promise.all([
      call(url, '/workspace').then(response => response.json()),
      call(url, decisionReportQuery).then(response => response.json()),
      call(url, `/documents/${decisionDraft.document.id}/revisions`).then(response => response.json()),
    ]);
    assert.deepEqual(page.items.map(item => item.linkId), [decisionLink.id]);
    const backlinks = workspace.resourceLinks.filter(link => link.documentId === decisionDraft.document.id);
    assert.deepEqual(backlinks.map(item => [item.issueId, item.kind, item.documentSource]), [[routedIssue.id, '결정 후속 업무 회의', undefined]]);
    assert.deepEqual(revisions.map(revision => revision.content), [decisionDraft.document.content]);
  };
  await verifyDecisionDraft(pilot.url);
  const propertyBlock = { type: 'documentProperties', attrs: { group: 'decision', hidden: true,
    entries: [{ name: '상태', value: '검토 완료' }, { name: '검토일', value: '2027-04-06' }] } };
  const propertyReportBlock = { type: 'documentPropertyReport', attrs: { projectId, group: 'decision', labels: ['pilot-decision'],
    match: 'all', columns: ['상태', '검토일'], sort: 'title', descending: false, limit: 30, title: '파일럿 결정 목록' } };
  const propertySource = await (await call(pilot.url, '/documents', { method: 'POST', status: 201, body: {
    projectId, title: '파일럿 결정 속성', labels: ['pilot-decision'], content: { type: 'doc', content: [propertyBlock] },
  } })).json();
  const propertyReport = await (await call(pilot.url, '/documents', { method: 'POST', status: 201, body: {
    projectId, title: '파일럿 결정 속성 보고서', content: { type: 'doc', content: [propertyReportBlock] },
  } })).json();
  const propertySessionPath = `/documents/${propertySource.id}/collaboration`;
  const propertySession = await (await call(pilot.url, `${propertySessionPath}/enable`, {
    method: 'POST', body: { expectedVersion: propertySource.version },
  })).json();
  const verifyDocumentProperties = async url => {
    const [workspace, session, revisions] = await Promise.all([
      call(url, '/workspace').then(response => response.json()),
      call(url, propertySessionPath).then(response => response.json()),
      call(url, `/documents/${propertyReport.id}/revisions`).then(response => response.json()),
    ]);
    assert.deepEqual(workspace.documents.find(item => item.id === propertySource.id)?.content.content, [propertyBlock]);
    assert.deepEqual(workspace.documents.find(item => item.id === propertyReport.id)?.content.content, [propertyReportBlock]);
    assert.deepEqual(revisions.map(item => item.content.content), [[propertyReportBlock]]);
    assert.equal(session.enabled, true);
    assert.equal(session.epoch, propertySession.epoch);
    assert.equal(session.schemaVersion, COLLABORATION_SCHEMA);
    assert.equal(session.document.plainText, '');
    assert.deepEqual(session.document.content.content, [propertyBlock]);
  };
  await verifyDocumentProperties(pilot.url);
  const tableText = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
  const archiveTable = {
    type: 'doc', content: [{ type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { colspan: 2, align: 'center' }, content: [tableText('검토 표')] },
        { type: 'tableHeader', attrs: { rowspan: 2 }, content: [tableText('공통 확인')] },
      ] },
      { type: 'tableRow', content: [
        { type: 'tableHeader', content: [tableText('결과')] },
        { type: 'tableCell', attrs: { align: 'right' }, content: [tableText('검토 완료', [{ type: 'bold' }]), tableText('확인 내용')] },
      ] },
    ] }],
  };
  const tableSource = await (await call(pilot.url, '/documents', { method: 'POST', status: 201, body: {
    projectId, title: '파일럿 병합 표', content: archiveTable,
  } })).json();
  const archiveExportPath = `/document-exports/markdown.zip?${new URLSearchParams({ scope: 'subtree', source: 'saved', documentId: tableSource.id })}`;
  const exportedTable = Buffer.from(await (await call(pilot.url, archiveExportPath)).arrayBuffer());
  const archiveContentHeaders = { 'Content-Type': 'application/octet-stream' };
  const tablePreview = await (await call(pilot.url, '/document-markdown-import/preview?projectId=&parentId=', {
    method: 'POST', headers: archiveContentHeaders, body: exportedTable,
  })).json();
  assert.equal(tablePreview.format, 'teamspace');
  assert.deepEqual(tablePreview.warnings, []);
  const tableApplyPath = `/document-markdown-import/apply?previewId=${encodeURIComponent(tablePreview.id)}`;
  const tableApplyOptions = { method: 'POST', headers: archiveContentHeaders, body: exportedTable };
  const importedTable = await (await call(pilot.url, tableApplyPath, { ...tableApplyOptions, status: 201 })).json();
  const [importedTableId] = importedTable.rootIds;
  const verifyImportedTable = async url => {
    assert.deepEqual(await (await call(url, tableApplyPath, tableApplyOptions)).json(), { ...importedTable, duplicate: true });
    const [{ documents }, revisions] = await Promise.all([
      call(url, '/workspace').then(response => response.json()),
      call(url, `/documents/${importedTableId}/revisions`).then(response => response.json()),
    ]);
    const restored = documents.find(item => item.id === importedTableId);
    assert.equal(restored.projectId, null);
    assert.deepEqual(restored.content, tableSource.content);
    assert.deepEqual(revisions.map(revision => revision.content), [tableSource.content]);
  };
  await verifyImportedTable(pilot.url);
  const collaboration = await (await call(pilot.url,`${documentPath}/collaboration/enable`,{
    method:'POST',body:{expectedVersion:document.version},
  })).json();
  const requested = await (await call(pilot.url,`${documentPath}/publication`,{
    method:'POST',body:{action:'request',expectedVersion:0,workspaceGeneration:null,expectedDocumentVersion:collaboration.document.version,reviewerId:workspace.users[1].id},
  })).json();
  const publication = await (await call(pilot.url,`${documentPath}/publication`,{
    method:'POST',headers:{'X-Actor-Id':workspace.users[1].id},body:{action:'publish',expectedVersion:requested.version,workspaceGeneration:requested.workspaceGeneration},
  })).json();
  const reviewerHeaders = {'X-Actor-Id':workspace.users[1].id};
  const inbox = await (await call(pilot.url,'/notifications',{headers:reviewerHeaders})).json();
  const reviewNotification = inbox.items.find(item=>item.targetId===document.id && item.kind==='document-review-requested');
  assert.ok(reviewNotification);
  await call(pilot.url,`/notifications/${reviewNotification.id}/read`,{method:'PATCH',headers:reviewerHeaders});
  const readInbox = await (await call(pilot.url,'/notifications',{headers:reviewerHeaders})).json();
  const readNotification = readInbox.items.find(item=>item.id===reviewNotification.id);
  assert.equal(typeof readNotification?.readAt,'string');
  const file = Buffer.from('Teamspace pilot attachment\n동일한 첨부 바이트\n');
  const target = `/attachments?resourceType=issue&resourceId=${encodeURIComponent(issue.id)}&filename=pilot.bin`;
  const attachment = await (await call(pilot.url,target,{
    method:'POST',status:201,headers:{'Content-Type':'application/octet-stream','X-File-Type':'application/octet-stream'},body:file,
  })).json();
  const revisedFile = Buffer.from('Teamspace pilot attachment v2\n최신 첨부 바이트\n');
  const updatedAttachment = await (await call(pilot.url,`/attachments/${attachment.id}/versions?expectedVersionId=${attachment.currentVersionId}&filename=pilot.bin`,{
    method:'POST',status:201,headers:{'Content-Type':'application/octet-stream'},body:revisedFile,
  })).json();
  assert.equal(updatedAttachment.id,attachment.id);
  assert.equal(updatedAttachment.versionCount,2);
  const comment = await (await call(pilot.url,'/comments',{
    method:'POST',status:201,body:{resourceType:'issue',resourceId:issue.id,body:'파일럿에서 개별 복구할 합성 댓글'},
  })).json();
  const commentArchive = await (await call(pilot.url,`/comments/${comment.id}`,{method:'DELETE'})).json();
  const archivedContents = ['개별 복구 파일 첫 버전','개별 복구 파일 두 번째 버전'].map(text=>Buffer.from(text));
  const archivedRoot = await (await call(pilot.url,target,{
    method:'POST',status:201,headers:{'Content-Type':'application/octet-stream'},body:archivedContents[0],
  })).json();
  const archivedHead = await (await call(pilot.url,`/attachments/${archivedRoot.id}/versions?expectedVersionId=${archivedRoot.currentVersionId}&filename=pilot-child.bin`,{
    method:'POST',status:201,headers:{'Content-Type':'application/octet-stream'},body:archivedContents[1],
  })).json();
  const fileArchive = await (await call(pilot.url,`/attachments/${archivedRoot.id}?expectedVersionId=${archivedHead.currentVersionId}`,{method:'DELETE'})).json();
  await call(pilot.url,`/attachments/${archivedHead.currentVersionId}/content`,{status:404});
  const migration = await applyPilotSourceMigration(call.bind(null, pilot.url), assigneeId, workspace.users[1].id);
  const sourceAudit = await verifyPilotSourceMigration(call.bind(null, pilot.url), migration);
  assert.notEqual(sourceAudit.issue.status, sourceAudit.nextStatus);
  assert.equal(sourceAudit.otherIssue.status, sourceAudit.nextStatus);
  const jiraRelationMigration = await applyPilotCrossProjectJiraRelation(pilot.url, assigneeId, sourceAudit.issue);
  const jiraRelationAudit = await verifyPilotCrossProjectJiraRelation(pilot.url, jiraRelationMigration);
  const key = await (await call(pilot.url,'/api-keys',{
    method:'POST',status:201,body:{name:'파일럿 복원 키',access:'read',projectIds:[projectId],expiresAt:null},
  })).json();

  gitlab.listen(0,'127.0.0.1');
  await once(gitlab,'listening');
  const settings = await (await call(pilot.url,'/integrations/gitlab')).json();
  const syntheticWebhookSecret = `pilot-webhook-${randomUUID()}`;
  const gitlabBase = `http://127.0.0.1:${gitlab.address().port}`;
  const search = await call(pilot.url, '/integrations/gitlab/repository-search', {
    method: 'POST', body: { expectedVersion: settings.version, baseUrl: gitlabBase, token: syntheticToken, query: 'platform', page: 1 },
  });
  assert.equal(search.headers.get('cache-control'), 'no-store');
  const discovery = await search.json();
  assert.deepEqual(discovery.repositories, [{ id: 42, name: 'Pilot Repository', pathWithNamespace: 'platform/pilot', webUrl: `${gitlabBase}/platform/pilot` }]);
  assert.deepEqual(await (await call(pilot.url, '/integrations/gitlab')).json(), settings);
  const readsAfterDiscovery = authenticatedReads;
  assert.equal(readsAfterDiscovery, 1);
  const [repository] = discovery.repositories;
  const jiraRoutes = [{repositoryId:repository.id,projectId:sourceAudit.issue.projectId,jiraInstanceKey:'pilot-jira'}];
  const gitlabIssuePath = `/issues/${sourceAudit.issue.id}/gitlab-links`;
  const gitlabLinksPath = `${gitlabIssuePath}?kind=merge_request`;
  const gitlabSettings = await (await call(pilot.url,'/integrations/gitlab',{
    method:'PATCH',body:{expectedVersion:settings.version,baseUrl:gitlabBase,projectIds:[repository.id],token:syntheticToken,webhookSecret:syntheticWebhookSecret,jiraRoutes},
  })).json();
  const gitlabWebhook = {
    method: 'POST', headers: { 'X-Gitlab-Token': syntheticWebhookSecret, 'Idempotency-Key': randomUUID() },
    body: { object_kind: 'push', project_id: 42, ref: 'refs/heads/preview-without-ticket', before: '0'.repeat(40), after: 'a'.repeat(40), commits: [] },
  };
  const webhookStatusPath = '/integrations/gitlab/webhook-status';
  const receipt = await (await call(pilot.url, '/integrations/gitlab/webhook', gitlabWebhook)).json();
  assert.deepEqual(receipt, { ok: true, linked: 0, duplicate: false, runs: [] });
  const pipelineReceipt = await (await call(pilot.url, '/integrations/gitlab/webhook', {
    method: 'POST', headers: { 'X-Gitlab-Token': syntheticWebhookSecret, 'Idempotency-Key': randomUUID() },
    body: { object_kind: 'pipeline', project: { id: repository.id, web_url: repository.webUrl },
      object_attributes: { id: 915, ref: 'preview-without-ticket', sha: 'a'.repeat(40), status: 'running',
        updated_at: new Date().toISOString() } },
  })).json();
  assert.deepEqual(pipelineReceipt, { ok: true, linked: 0, duplicate: false, runs: [] });
  const inboundStatus = await call(pilot.url, webhookStatusPath);
  assert.equal(inboundStatus.headers.get('cache-control'), 'no-store');
  const gitlabWebhookStatus = await inboundStatus.json();
  const [inboundRepository] = gitlabWebhookStatus.repositories;
  assert.equal(inboundRepository.lastDelivery.authentication, 'secret-token');
  assert.equal(inboundRepository.lastDelivery.event, 'pipeline');
  assert.equal(inboundRepository.lastAcceptedByEvent.push.event, 'push');
  assert.deepEqual(inboundRepository.lastAcceptedByEvent.pipeline, inboundRepository.lastDelivery);
  const firstSync = await (await call(pilot.url,'/integrations/gitlab/sync',{method:'POST',body:{}})).json();
  assert.equal(firstSync.linked,1);
  const { settingsVersion, ...deploymentResult } = await (await call(pilot.url, '/integrations/gitlab/deployments/sync', {
    method: 'POST', body: { repositoryId: 42, expectedVersion: gitlabSettings.version },
  })).json();
  assert.equal(settingsVersion, gitlabSettings.version);
  assert.equal(deploymentResult.deploymentsRead, 0);
  const syncStatusPath = '/integrations/gitlab/sync-status';
  const readsBeforeStatus = authenticatedReads;
  const syncStatusResponse = await call(pilot.url, syncStatusPath);
  assert.equal(syncStatusResponse.headers.get('cache-control'), 'no-store');
  const syncStatus = await syncStatusResponse.json();
  assert.equal(authenticatedReads, readsBeforeStatus);
  assert.equal(syncStatus.settingsVersion, gitlabSettings.version);
  assert.equal(syncStatus.repositories.length, 1);
  const [repositoryStatus] = syncStatus.repositories;
  assert.equal(repositoryStatus.repositoryId, 42);
  assert.equal(repositoryStatus.activity.includeHistory, false);
  assert.deepEqual(repositoryStatus.activity.result, firstSync.repositories[0]);
  assert.equal(repositoryStatus.activity.lastSuccessfulAt, repositoryStatus.activity.completedAt);
  assert.equal(repositoryStatus.deployments.status, 'ok');
  assert.deepEqual(repositoryStatus.deployments.result, deploymentResult);
  assert.equal(repositoryStatus.deployments.lastSuccessfulAt, repositoryStatus.deployments.completedAt);
  const gitlabActivity = await (await call(pilot.url,gitlabLinksPath)).json();
  assert.deepEqual(gitlabActivity.links.map(link => [link.issueId, link.originalJiraKey]), [[sourceAudit.issue.id, 'OLD-1']]);
  const attachDevelopment = async url => (await call(pilot.url,gitlabIssuePath,{
    method:'POST',status:201,body:{repositoryId:42,url,expectedSettingsVersion:gitlabSettings.version},
  })).json();
  const manualBranch = await attachDevelopment(`${gitlabBase}/platform/pilot/-/tree/${manualBranchName}?ref_type=heads`);
  const manualCommit = await attachDevelopment(`${gitlabBase}/platform/pilot/-/commit/${manualCommitSha}`);
  assert.deepEqual([manualBranch.kind,manualBranch.sourceBranch,manualBranch.sourceSha,manualCommit.kind,manualCommit.sourceSha],
    ['branch',manualBranchName,manualCommitSha,'commit',manualCommitSha]);
  assert.ok(manualBranch.manualLinkId && manualCommit.manualLinkId);
  const afterGitlabSync = await (await call(pilot.url,'/workspace')).json();
  assert.equal(afterGitlabSync.issues.find(item => item.id === sourceAudit.issue.id)?.status,sourceAudit.issue.status);
  const trashedIssue = await (await call(pilot.url,`/issues/${issue.id}?expectedVersion=${issue.version}`,{method:'DELETE'})).json();
  await call(pilot.url,`/attachments/${attachment.id}/content`,{status:404});
  assert.deepEqual(await (await call(pilot.url,calendarPath)).json(),[]);
  const replacementReservation = await (await call(pilot.url,`/issues/${parallel.id}/time-reservations`,{
    method:'POST',status:201,body:{...reservedTime,requestId:randomUUID()},
  })).json();
  const prerequisiteProject = await (await call(pilot.url, '/projects', { method: 'POST', status: 201,
    body: { key: 'PRER', name: '파일럿 선행 업무' } })).json();
  const prerequisiteAnchor = await (await call(pilot.url, '/issues', { method: 'POST', status: 201,
    body: { projectId: prerequisiteProject.id, title: '파일럿 기존 후행 업무', startDate: '2027-04-05', endDate: '2027-04-08' } })).json();
  const prerequisiteCalendar = await (await call(pilot.url, `/projects/${prerequisiteProject.id}/calendar`)).json();
  const prerequisitePath = `/issues/${prerequisiteAnchor.id}/schedule-predecessors`;
  const prerequisiteRequest = { requestId: randomUUID(), expectedSuccessorVersion: prerequisiteAnchor.version,
    expectedCalendarVersion: prerequisiteCalendar.version, type: 'FS', lagDays: 0, issue: {
      projectId: prerequisiteProject.id, title: '파일럿 신규 선행 업무', startDate: '2027-04-02', endDate: '2027-04-02',
    } };
  const prerequisite = await (await call(pilot.url, prerequisitePath, {
    method: 'POST', status: 201, body: prerequisiteRequest,
  })).json();
  const prerequisiteLinksPath = `/projects/${prerequisiteProject.id}/dependencies`;
  const [prerequisiteLink] = await (await call(pilot.url, prerequisiteLinksPath)).json();
  assert.deepEqual(prerequisiteLink, { id: prerequisiteLink.id, predecessorId: prerequisite.id, successorId: prerequisiteAnchor.id,
    type: 'FS', lagDays: 0, version: 1 });
  const verifyPrerequisite = async url => {
    const replay = await (await call(url, prerequisitePath, { method: 'POST', body: prerequisiteRequest })).json();
    assert.deepEqual(replay, prerequisite);
    assert.deepEqual(await (await call(url, prerequisiteLinksPath)).json(), [prerequisiteLink]);
    const live = await (await call(url, '/workspace')).json();
    const issues = live.issues.filter(item => item.projectId === prerequisiteProject.id);
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.find(item => item.id === prerequisiteAnchor.id), prerequisiteAnchor);
    assert.deepEqual(issues.find(item => item.id === prerequisite.id), prerequisite);
  };
  await verifyPrerequisite(pilot.url);
  const progressProject = await (await call(pilot.url, '/projects', { method: 'POST', status: 201,
    body: { key: 'CYPR', name: '파일럿 사이클 진행 추이' } })).json();
  const progressDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const progressCycle = await (await call(pilot.url, '/planning-items', { method: 'POST', status: 201,
    body: { projectId: progressProject.id, kind: 'cycle', name: '파일럿 관측 사이클', status: 'active', startDate: progressDate } })).json();
  const progressIssue = await (await call(pilot.url, '/issues', { method: 'POST', status: 201, body: {
    projectId: progressProject.id, title: '파일럿 사이클 진행 검증 업무', cycleId: progressCycle.id,
  } })).json();
  const progressIssuePath = `/issues/${progressIssue.id}`;
  const estimated = await (await call(pilot.url, progressIssuePath, { method: 'PATCH',
    body: { expectedVersion: progressIssue.version, estimate: 8 } })).json();
  const removedFromCycle = await (await call(pilot.url, progressIssuePath, { method: 'PATCH',
    body: { expectedVersion: estimated.version, cycleId: null } })).json();
  await call(pilot.url, progressIssuePath, { method: 'PATCH', body: { expectedVersion: removedFromCycle.version, cycleId: progressCycle.id } });
  const progressPath = `/projects/${progressProject.id}/cycles/${progressCycle.id}/progress?${new URLSearchParams({ throughDate: progressDate, date: progressDate })}`;
  const readProgress = async url => (await call(url, progressPath)).json();
  const cycleProgress = await readProgress(pilot.url);
  assert.ok(cycleProgress.revision);
  assert.deepEqual(cycleProgress.days.at(-1).state, { scopeIssues: 1, remainingIssues: 1, completedIssues: 0, cancelledIssues: 0,
    scopeEstimate: 8, remainingEstimate: 8, missingScopeEstimate: 0, missingRemainingEstimate: 0 });
  assert.deepEqual(cycleProgress.days.at(-1).changes, { added: 2, removed: 1, completed: 0, cancelled: 0,
    reopened: 0, estimateChanged: 1, reclassified: 0 });
  assert.deepEqual(cycleProgress.evidence.items.map(item => item.issueId), Array(4).fill(progressIssue.id));
  const hierarchyProject = await (await call(pilot.url, '/projects', { method: 'POST', status: 201,
    body: { key: 'HSHIFT', name: '파일럿 업무 계층 일정 이동' } })).json();
  const createHierarchyIssue = async body => (await call(pilot.url, '/issues', { method: 'POST', status: 201,
    body: { projectId: hierarchyProject.id, ...body } })).json();
  const hierarchyRoot = await createHierarchyIssue({ title: '파일럿 상위 업무', startDate: '2027-04-05', endDate: '2027-04-08', dueDate: '2027-04-15' });
  const hierarchyChild = await createHierarchyIssue({ title: '파일럿 직접 하위 업무', startDate: '2027-04-06', endDate: '2027-04-07', parentId: hierarchyRoot.id });
  const hierarchyGrandchild = await createHierarchyIssue({ title: '파일럿 간접 하위 업무', startDate: '2027-04-07', parentId: hierarchyChild.id });
  const hierarchyUnscheduled = await createHierarchyIssue({ title: '파일럿 일정이 없는 하위 업무', parentId: hierarchyRoot.id });
  const hierarchyReview = await (await call(pilot.url, '/schedule/manual-preview', { method: 'POST', body: {
    hierarchy: { id: hierarchyRoot.id, expectedVersion: hierarchyRoot.version }, days: 2, workingDays: false,
  } })).json();
  assert.deepEqual(hierarchyReview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [hierarchyRoot.id, '2027-04-07', '2027-04-10'],
    [hierarchyChild.id, '2027-04-08', '2027-04-09'],
    [hierarchyGrandchild.id, '2027-04-09', null],
  ]);
  assert.deepEqual(hierarchyReview.skipped, [{ id: hierarchyUnscheduled.id, key: hierarchyUnscheduled.key,
    title: hierarchyUnscheduled.title, reason: 'unscheduled' }]);
  const applyHierarchyShift = async url => (await call(url, '/schedule/manual-apply', { method: 'POST',
    body: { previewId: hierarchyReview.previewId } })).json();
  const hierarchyApplied = await applyHierarchyShift(pilot.url);
  assert.ok(hierarchyApplied.undoId);
  assert.deepEqual(hierarchyApplied.updated.map(({ id, startDate, endDate }) => [id, startDate, endDate]),
    hierarchyReview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]));
  const verifyHierarchyShift = async url => {
    assert.deepEqual(await applyHierarchyShift(url), hierarchyApplied);
    const { issues } = await (await call(url, '/workspace')).json();
    const byId = new Map(issues.map(issue => [issue.id, issue]));
    for (const issue of hierarchyApplied.updated) assert.deepEqual(byId.get(issue.id), issue);
    assert.deepEqual(byId.get(hierarchyUnscheduled.id), hierarchyUnscheduled);
    assert.equal(byId.get(hierarchyRoot.id).dueDate, hierarchyRoot.dueDate);
    assert.equal(byId.get(hierarchyGrandchild.id).parentId, hierarchyChild.id);
  };
  await verifyHierarchyShift(pilot.url);
  const locked = cli('backup',source,backup);
  assert.equal(locked.status,75,locked.stderr);
  assert.equal(existsSync(backup),false);
  await stop(pilot);

  const saved = cli('backup',source,backup);
  assert.equal(saved.status,0,saved.stderr);
  const recovery = cli('restore',backup,restored);
  assert.equal(recovery.status,0,recovery.stderr);
  assert.notEqual(cli('restore',backup,restored).status,0);

  const corrupt = join(scratch,'corrupt-backup');
  const failed = join(scratch,'failed-restore');
  cpSync(backup,corrupt,{recursive:true});
  writeFileSync(join(corrupt,'data','uploads',attachment.id),Buffer.from('tampered'));
  assert.notEqual(cli('restore',corrupt,failed).status,0);
  assert.equal(existsSync(failed),false);
  assert.equal(fileHash(join(source,'.credential-key')),fileHash(join(restored,'.credential-key')));

  const copy = await start(restored);
  const restoredTrash = await (await call(copy.url,`/trash?scope=project&projectId=${projectId}`)).json();
  assert.equal(restoredTrash.items.find(item=>item.id===trashedIssue.trashEntryId)?.resourceId,issue.id);
  const unavailable = await (await call(copy.url,'/issues',{...issueCreation,status:409})).json();
  assert.equal(unavailable.details.reason,'result_unavailable');
  const childArchives = await (await call(copy.url,`/trash/items?scope=project&projectId=${projectId}`)).json();
  assert.deepEqual(new Set(childArchives.items.filter(item=>item.ownerId===issue.id).map(item=>item.id)),new Set([commentArchive.trashItemId,fileArchive.trashItemId]));
  assert.ok(childArchives.items.filter(item=>item.ownerId===issue.id).every(item=>item.ownerAvailable===false));
  await call(copy.url,`/trash/items/${fileArchive.trashItemId}/restore`,{method:'POST',body:{},status:409});
  await call(copy.url,`/attachments/${attachment.id}/content`,{status:404});
  const undone = await (await call(copy.url,`/trash/${trashedIssue.trashEntryId}/restore`,{method:'POST',body:{}})).json();
  assert.equal(undone.resourceId,issue.id);
  assert.ok(undone.warnings.some(warning=>warning.includes('시간 배정 1건')));
  assert.deepEqual(await (await call(copy.url,reservationPath)).json(),[
    {...reservation,version:reservation.version+1,state:'needs-review'},
  ]);
  assert.deepEqual(await (await call(copy.url,calendarPath)).json(),[replacementReservation]);
  const restoredIssue = await (await call(copy.url,`/v1/issues/${issue.id}`,{
    headers:{Authorization:`Bearer ${key.token}`},
  })).json();
  assert.equal(restoredIssue.title,issue.title);
  assert.equal(restoredIssue.estimate,2);
  assert.equal(restoredIssue.plannedEffortMinutes,300);
  assert.deepEqual(await (await call(copy.url,'/issues',issueCreation)).json(),restoredIssue);
  await issueCreationEvidence(copy.url);
  await call(copy.url,`/attachments/${archivedRoot.id}/content`,{status:404});
  const commentsPath = `/comments?resourceType=issue&resourceId=${issue.id}`;
  assert.ok(!(await (await call(copy.url,commentsPath)).json()).some(item=>item.id===comment.id));
  await call(copy.url,`/trash/items/${commentArchive.trashItemId}/restore`,{method:'POST',body:{}});
  await call(copy.url,`/trash/items/${fileArchive.trashItemId}/restore`,{method:'POST',body:{}});
  assert.deepEqual((await (await call(copy.url,commentsPath)).json()).find(item=>item.id===comment.id),comment);
  const restoredChildFiles = [archivedRoot.id,archivedHead.currentVersionId];
  for (const [index,id] of restoredChildFiles.entries()) {
    const downloaded = await call(copy.url,`/attachment-versions/${id}/download`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),archivedContents[index]);
  }
  const restoredWorkload = await (await call(copy.url,`/v1${workloadPath}`,{
    headers:{Authorization:`Bearer ${key.token}`},
  })).json();
  const restoredLoadRow = restoredWorkload.rows.find(row=>row.userId===assigneeId);
  assert.equal(restoredLoadRow?.scheduledMinutes,300);
  assert.equal(restoredLoadRow?.availableMinutes,240);
  assert.equal(restoredLoadRow?.overloadedDays,1);
  assert.deepEqual(await (await call(copy.url,teamCapacityPath)).json(),savedTeamCapacity);
  const restoredTeam = await (await call(copy.url,teamWorkloadPath)).json();
  const restoredTeamRow = restoredTeam.rows.find(row=>row.userId===assigneeId);
  assert.equal(restoredTeamRow?.scheduledMinutes,390);
  assert.equal(restoredTeamRow?.availableMinutes,320);
  assert.equal(restoredTeamRow?.overloadedDays,1);
  assert.deepEqual(new Map(restoredTeamRow.days[0].allocations.map(allocation=>[allocation.issueId,allocation.projectId])),new Map([
    [issue.id,projectId],[parallel.id,parallelProjectId],
  ]));
  assert.deepEqual(await (await call(copy.url, rulesPath)).json(), [rule]);
  assert.deepEqual(await (await call(copy.url, runsPath)).json(), assignmentRuns);
  assert.deepEqual(await (await call(copy.url, schemaPath)).json(), savedSchema);
  const restoredRouting = (await (await call(copy.url, '/workspace')).json()).issues.find(item => item.id === routedIssue.id);
  assert.deepEqual(restoredRouting.customFields, routedIssue.customFields);
  await verifyFieldBreakdown(copy.url);
  await verifyLinkedPaste(copy.url);
  await verifyDecisionDraft(copy.url);
  await verifyDocumentProperties(copy.url);
  await verifyImportedTable(copy.url);
  await verifyPrerequisite(copy.url);
  const restoredCycleProgress = await readProgress(copy.url);
  assert.equal(restoredCycleProgress.revision, cycleProgress.revision);
  assert.deepEqual(restoredCycleProgress.days, cycleProgress.days);
  assert.deepEqual(restoredCycleProgress.evidence, cycleProgress.evidence);
  await verifyHierarchyShift(copy.url);
  const hierarchyUndo = await (await call(copy.url, '/schedule/undo', { method: 'POST',
    body: { undoId: hierarchyApplied.undoId } })).json();
  const hierarchyDates = ({ id, parentId, startDate, endDate, dueDate }) => ({ id, parentId, startDate, endDate, dueDate });
  assert.deepEqual(hierarchyUndo.updated.map(hierarchyDates), [hierarchyRoot, hierarchyChild, hierarchyGrandchild].map(hierarchyDates));
  await call(copy.url, `/issues/${routedIssue.id}`, {method: 'PATCH', status: 422,
    body: {expectedVersion: restoredRouting.version, customFields: {pilot_gate: true, pilot_proof: null}}});
  const restoredCollaboration = await (await call(copy.url,`${documentPath}/collaboration`)).json();
  assert.equal(restoredCollaboration.enabled,true);
  assert.equal(restoredCollaboration.document.plainText,collaboration.document.plainText);
  const restoredPublication = await (await call(copy.url,`${documentPath}/publication`)).json();
  assert.deepEqual(restoredPublication.publishedRevision,publication.publishedRevision);
  const restoredInbox = await (await call(copy.url,'/notifications',{headers:reviewerHeaders})).json();
  assert.deepEqual(restoredInbox.items.find(item=>item.id===reviewNotification.id),readNotification);
  const restoredFile = await call(copy.url,`/attachments/${attachment.id}/content`);
  assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()),file);
  const restoredVersions = await (await call(copy.url,`/v1/attachments/${attachment.id}/versions`,{
    headers:{Authorization:`Bearer ${key.token}`},
  })).json();
  assert.deepEqual(restoredVersions.map(version=>version.id),[updatedAttachment.currentVersionId,attachment.id]);
  const restoredRevision = await call(copy.url,`/v1/attachment-versions/${updatedAttachment.currentVersionId}/download`,{
    headers:{Authorization:`Bearer ${key.token}`},
  });
  assert.deepEqual(Buffer.from(await restoredRevision.arrayBuffer()),revisedFile);
  for (const {summary, bytes} of migration.packages) {
    const restoredPackage = await (await call(copy.url, `/legacy-import/packages/${summary.id}`)).json();
    assert.equal(restoredPackage.summary.sha256, summary.sha256);
    assert.deepEqual(readFileSync(join(restored, 'legacy-imports', `${summary.id}.bundle`)), bytes);
  }
  const restoredAudit = await verifyPilotSourceMigration(call.bind(null, copy.url), migration);
  assert.deepEqual(restoredAudit, sourceAudit, 'Migrated items, source rows, worklogs, links and file audit must agree across physical restore.');
  assert.deepEqual(await verifyPilotCrossProjectJiraRelation(copy.url, jiraRelationMigration), jiraRelationAudit);
  const restoredGitlab = await (await call(copy.url,'/integrations/gitlab')).json();
  assert.deepEqual(restoredGitlab.jiraRoutes,jiraRoutes);
  assert.deepEqual(await (await call(copy.url,gitlabLinksPath)).json(),gitlabActivity);
  const restoredBranchPath = `${gitlabIssuePath}?kind=branch`;
  assert.deepEqual((await (await call(copy.url,restoredBranchPath)).json()).links,[manualBranch]);
  assert.deepEqual((await (await call(copy.url,`${gitlabIssuePath}?kind=commit`)).json()).links,[manualCommit]);
  assert.deepEqual(await (await call(copy.url, webhookStatusPath)).json(), gitlabWebhookStatus);
  const readsBeforeRestoredStatus = authenticatedReads;
  assert.deepEqual(await (await call(copy.url, syncStatusPath)).json(), syncStatus);
  assert.equal(authenticatedReads, readsBeforeRestoredStatus);
  assert.equal((await (await call(copy.url, '/integrations/gitlab/webhook', gitlabWebhook)).json()).duplicate, true);
  const [afterReplay] = (await (await call(copy.url, webhookStatusPath)).json()).repositories;
  assert.equal(afterReplay.lastDelivery.duplicate, true);
  assert.deepEqual(afterReplay.lastAcceptedByEvent, inboundRepository.lastAcceptedByEvent);
  const nextHead = 'e'.repeat(40);
  const afterRestore = await (await call(copy.url, '/integrations/gitlab/webhook', {
    method:'POST',headers:{'X-Gitlab-Token':syntheticWebhookSecret,'Idempotency-Key':randomUUID()},
    body:{object_kind:'push',project_id:42,ref:`refs/heads/${manualBranchName}`,before:manualCommitSha,after:nextHead,commits:[]},
  })).json();
  assert.deepEqual(afterRestore,{ok:true,linked:1,duplicate:false,runs:[]});
  const [afterRestoredPush] = (await (await call(copy.url, webhookStatusPath)).json()).repositories;
  assert.deepEqual(afterRestoredPush.lastAcceptedByEvent.push, afterRestoredPush.lastDelivery);
  assert.equal(afterRestoredPush.lastAcceptedByEvent.push.linked, 1);
  assert.deepEqual(afterRestoredPush.lastAcceptedByEvent.pipeline, inboundRepository.lastAcceptedByEvent.pipeline);
  const [updatedBranch] = (await (await call(copy.url,restoredBranchPath)).json()).links;
  assert.deepEqual([updatedBranch.id,updatedBranch.manualLinkId,updatedBranch.sourceSha],[manualBranch.id,manualBranch.manualLinkId,nextHead]);
  const updatedMigratedIssue = await (await call(copy.url, `/issues/${restoredAudit.issue.id}`, {
    method: 'PATCH', body: {expectedVersion: restoredAudit.issue.version, status: restoredAudit.nextStatus},
  })).json();
  assert.equal(updatedMigratedIssue.status, restoredAudit.nextStatus);
  assert.equal(updatedMigratedIssue.version, restoredAudit.issue.version + 1);
  const restoredSync = await (await call(copy.url,'/integrations/gitlab/sync',{method:'POST',body:{}})).json();
  assert.equal(restoredSync.linked,0);
  assert.equal(authenticatedReads - readsAfterDiscovery, 10);
  await stop(copy);
  console.log('Pilot rehearsal passed for browser workflows, Jira and Confluence migration, GitLab activity, cold backup integrity, ticket creation retries, ticket form conditions, automation history, time reservations and individual trash restore.');
}

process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  if (teamSeconds === null) await runStandardPilot();
  else await runTeamPilot(teamSeconds);
} catch (error) {
  if (!interruption.signal.aborted) throw error;
  console.error(interruption.signal.reason.message);
} finally {
  for (const pilot of pilots) await stop(pilot).catch(() => {});
  if (gitlab.listening) await new Promise(resolve => gitlab.close(resolve));
  rmSync(scratch,{recursive:true,force:true});
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}
