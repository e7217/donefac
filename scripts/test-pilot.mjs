import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from '../tests/fixtures/legacy-export-zip.mjs';

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

async function start(dataDir, demo = false) {
  interruption.signal.throwIfAborted();
  const env = {...process.env, TEAMSPACE_PILOT_PORT: '0', TEAMSPACE_PILOT_DEMO: demo ? '1' : '0', TEAMSPACE_PILOT_OUTBOUND: '0'};
  delete env.TEAMSPACE_PILOT_ORIGIN;
  delete env.TEAMSPACE_PILOT_ACCESS_FILE;
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

async function applyPilotSourceMigration(url, actorId, authorId) {
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
    return (await call(url, `/legacy-import/packages?${query}`, {
      method: 'POST', status: 201, headers: {...headers, 'Content-Type': 'application/octet-stream'}, body,
    })).json();
  }
  const jiraPackage = await stage('pilot-jira-backup.zip', 'jira', jira);
  const wikiPackage = await stage('pilot-confluence-space.zip', 'confluence', confluence);
  assert.equal(jiraPackage.source.format, 'jira-backup-xml');
  assert.equal(wikiPackage.source.format, 'confluence-xml');
  const query = new URLSearchParams();
  for (const info of [jiraPackage, wikiPackage]) query.append('packageId', info.id);
  const options = await (await call(url, `/migrations/options?${query}`, {headers})).json();
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
    return (await call(url, '/migrations/preview', {
      method: 'POST', status: 201, headers, body: {configuration: migration},
    })).json();
  }
  async function applyMigration(preview, status) {
    return (await call(url, `/migrations/previews/${preview.id}/apply`, {
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

async function verifyPilotSourceMigration(url, migration) {
  const {receipt, authorId, expectedFiles} = migration;
  assert.equal(receipt.projectIds.length, 1);
  const [projectId] = receipt.projectIds;
  const base = `/source-imports/${receipt.id}/reconciliation`;
  const workspace = await (await call(url, '/workspace')).json();
  const issue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 원본 업무');
  const otherIssue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 두 번째 업무');
  const documents = workspace.documents.filter(item => item.projectId === projectId);
  const document = documents.find(item => item.title === '파일럿 원본 설계 문서');
  const sameSpaceDocument = documents.find(item => item.plainText.includes('설계 문서와 같은 원본 공간'));
  const remoteDocument = documents.find(item => item.plainText.includes('공유 첨부를 가진 다른 원본 공간'));
  const workflow = workspace.workflows.find(item => item.projectId === projectId);
  const nextStatus = workflow?.statuses.find(status => status.category === 'in_progress')?.id;
  assert.ok(issue && otherIssue && nextStatus && nextStatus !== issue.status);
  assert.equal(otherIssue.status, nextStatus);
  assert.equal(issue.assigneeId, authorId);
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
    const links = await (await call(url, `/atlassian-links?${query}`)).json();
    assert.deepEqual(links.map(link => link.url), [originalUrl]);
    originalLinks.push(links[0]);
  }
  const reconciliation = await (await call(url, base)).json();
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
  const worklogs = await (await call(url, `/issues/${issue.id}/worklogs`)).json();
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
  const origin = await (await call(url, `/source-imports/${receipt.id}/records/${worklog.sourceRecordId}`)).json();
  assert.equal(origin.record.authorId, jiraAuthorKey);
  const restricted = sourceRows.find(row => row.kind === 'history' && row.sourceId === 'worklog:32');
  assert.equal(restricted?.status, 'excluded');
  assert.equal(restricted.target, null);
  const audit = await (await call(url, `${base}/audit?expectedVersion=${receipt.version}`)).json();
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
    const download = await call(url, `/attachment-versions/${checked.fileId}/download`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  const sharedFile = audit.attachments.find(file => file.product === 'confluence' && file.sourceId === '702');
  const attachmentLabel = document.content.content.flatMap(node => node.content ?? []).find(node => node.text === '다른 공간의 원본 첨부');
  assert.deepEqual(attachmentLabel?.marks?.map(mark => mark.attrs.href), [`/api/attachments/${sharedFile.fileId}/content`]);
  const sharedDownload = await call(url, `/attachments/${sharedFile.fileId}/content`);
  assert.deepEqual(Buffer.from(await sharedDownload.arrayBuffer()), expectedFiles.find(file => file.sourceId === '702').bytes);
  return {
    issue, document, nextStatus, originalLinks, sourceRows, worklog,
    integrity: audit.integrity, recordCounts: audit.recordCounts, attachments: audit.attachments,
  };
}

async function browser(url, teamFixture) {
  interruption.signal.throwIfAborted();
  const playwright = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  const env = { ...process.env, TEAMSPACE_PILOT_TEST_URL: url };
  delete env.TEAMSPACE_PILOT_TEAM_FIXTURE;
  if (teamFixture) env.TEAMSPACE_PILOT_TEAM_FIXTURE = JSON.stringify(teamFixture);
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
let authenticatedReads = 0;
const gitlab = createServer((request, response) => {
  if (request.method !== 'GET' || request.headers['private-token'] !== syntheticToken ||
    !/^\/api\/v4\/projects\/42\/(merge_requests|pipelines)\?/.test(request.url ?? '')) {
    response.writeHead(403).end();
    return;
  }
  authenticatedReads++;
  response.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
});

async function teamSnapshot(url, fixture, evidence) {
  const documentPath = `/documents/${fixture.documentId}`;
  const session = await (await call(url, `${documentPath}/collaboration`)).json();
  const workspace = await (await call(url, '/export')).json();
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
  const listNode = issueList.content.content?.find(node => node.type === 'issueList' && node.attrs?.projectId === fixture.projectId);
  const view = workspace.savedViews?.find(value => value.id === listNode?.attrs.savedViewId && value.projectId === fixture.projectId);
  assert.ok(listNode && view, 'The issue list must retain its project and same-project saved view.');

  return {
    documentVersion: current.version, epoch: state.epoch, recoveryVersion: recovery.version, issueVersion: issue.version,
    // Hash complete records to compare the exact persisted fields without printing the body or Yjs bytes on mismatch.
    digest: createHash('sha256').update(JSON.stringify({ current, recovery, state, issue, issueList, view })).digest('hex'),
  };
}

async function runTeamPilot(seconds) {
  const pilot = await start(source);
  const actorIds = [];
  for (let index = 1; index <= 20; index++) {
    const actorNumber = String(index).padStart(2, '0');
    const user = await (await call(pilot.url, '/users', {
      method: 'POST', status: 201, body: { name: `합성 팀원 ${actorNumber}`, email: `pilot-${actorNumber}@example.invalid` },
    })).json();
    actorIds.push(user.id);
  }
  assert.equal(new Set(actorIds).size, 20);
  const headers = { 'X-Actor-Id': actorIds[0] };
  const project = await (await call(pilot.url, '/projects', {
    method: 'POST', status: 201, headers, body: { key: 'TEAM', name: '합성 팀 파일럿' },
  })).json();
  const planned = new Date();
  do { planned.setUTCDate(planned.getUTCDate() + 1); } while ([0, 6].includes(planned.getUTCDay()));
  const workingDate = planned.toISOString().slice(0, 10);
  const issue = await (await call(pilot.url, '/issues', {
    method: 'POST', status: 201, headers, body: {
      projectId: project.id, title: '동시 편집 중 검증할 업무', assigneeId: actorIds[0],
      startDate: workingDate, endDate: workingDate, plannedEffortMinutes: 30,
    },
  })).json();
  const title = '20명 공동 편집 리허설';
  const initialText = '이 문장은 팀 파일럿의 합성 원문입니다.';
  const document = await (await call(pilot.url, '/documents', {
    method: 'POST', status: 201, headers, body: {
      projectId: project.id, title,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] },
    },
  })).json();
  const session = await (await call(pilot.url, `/documents/${document.id}/collaboration/enable`, {
    method: 'POST', headers, body: { expectedVersion: document.version },
  })).json();
  assert.ok(session.enabled && session.epoch);
  const evidencePath = join(scratch, 'team-evidence.json');
  const fixture = {
    actorIds, projectId: project.id, documentId: document.id, issueId: issue.id, title, initialText,
    initialEpoch: session.epoch, seconds, evidencePath,
  };
  console.log(`Team pilot started: ${actorIds.length} actors, at least ${seconds}s of shared editing.`);
  await browser(pilot.url, fixture);

  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.documentId, document.id);
  assert.equal(evidence.originalEpoch, session.epoch);
  assert.ok(typeof evidence.finalEpoch === 'string' && evidence.finalEpoch !== session.epoch);
  assert.ok(Number.isSafeInteger(evidence.documentVersion) && evidence.documentVersion > session.document.version);
  assert.ok(typeof evidence.plainText === 'string' && evidence.plainText.includes(initialText));
  assert.ok(typeof evidence.staleMarker === 'string' && evidence.staleMarker.length > 0);
  assert.ok(typeof evidence.recoveryText === 'string' && evidence.recoveryText.includes(evidence.staleMarker));
  assert.ok(typeof evidence.recoveryDocumentId === 'string' && evidence.recoveryDocumentId !== document.id);
  assert.equal(evidence.peerCount, actorIds.length);
  assert.ok(Number.isSafeInteger(evidence.rounds) && evidence.rounds >= 2);
  assert.ok(Number.isSafeInteger(evidence.editCount) && evidence.editCount >= actorIds.length);
  assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= seconds * 1_000);
  assert.ok(evidence.workspaceTraffic, 'The browser must verify issue and issue-list changes during editing.');
  const baseline = await teamSnapshot(pilot.url, fixture, evidence);
  await stop(pilot);

  const reopened = await start(source);
  assert.deepEqual(await teamSnapshot(reopened.url, fixture, evidence), baseline, 'The source changed across a restart.');
  await stop(reopened);

  const saved = cli('backup', source, backup);
  assert.equal(saved.status, 0, saved.stderr);
  const recovery = cli('restore', backup, restored);
  assert.equal(recovery.status, 0, recovery.stderr);
  const copy = await start(restored);
  assert.deepEqual(await teamSnapshot(copy.url, fixture, evidence), baseline, 'The separate restoration changed the saved data.');
  await stop(copy);
  console.log(`Team pilot passed: ${evidence.peerCount} browser actors, ${evidence.rounds} rounds, ${evidence.editCount} retained edits, ` +
    `${(evidence.elapsedMs / 1000).toFixed(1)}s. Original document, recovery copy, issue and issue list matched after restart and separate restore.`);
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
  const issue = await (await call(pilot.url, '/issues', {
    method:'POST', status:201, body:{projectId,title:'파일럿 백업 복원 업무',assigneeId,startDate:workloadDate,endDate:workloadDate,estimate:2,plannedEffortMinutes:300},
  })).json();
  const parallelProjectId = workspace.projects[1].id;
  const parallel = await (await call(pilot.url,'/issues',{
    method:'POST',status:201,body:{projectId:parallelProjectId,title:'파일럿 병행 업무',assigneeId,startDate:workloadDate,endDate:workloadDate,plannedEffortMinutes:90},
  })).json();
  const rulesPath = `/projects/${parallelProjectId}/assignment-rules`;
  const runsPath = `/projects/${parallelProjectId}/assignment-runs`;
  const routingIssue = await (await call(pilot.url, '/issues', {
    method: 'POST', status: 201, body: {projectId: parallelProjectId, title: '파일럿 담당자 배정 업무'},
  })).json();
  const rule = await (await call(pilot.url, rulesPath, {
    method: 'POST', status: 201,
    body: {name: '파일럿 진행 업무 배정', enabled: true, fromStatuses: [routingIssue.status], toStatusId: 'in_progress', assigneeId: workspace.users[1].id},
  })).json();
  const routedIssue = await (await call(pilot.url, `/issues/${routingIssue.id}`, {
    method: 'PATCH', body: {status: rule.toStatusId, expectedVersion: routingIssue.version},
  })).json();
  assert.equal(routedIssue.assigneeId, rule.assigneeId);
  assert.equal(routedIssue.version, routingIssue.version + 1);
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
  const migration = await applyPilotSourceMigration(pilot.url, assigneeId, workspace.users[1].id);
  const sourceAudit = await verifyPilotSourceMigration(pilot.url, migration);
  const key = await (await call(pilot.url,'/api-keys',{
    method:'POST',status:201,body:{name:'파일럿 복원 키',access:'read',projectIds:[projectId],expiresAt:null},
  })).json();

  gitlab.listen(0,'127.0.0.1');
  await once(gitlab,'listening');
  const settings = await (await call(pilot.url,'/integrations/gitlab')).json();
  await call(pilot.url,'/integrations/gitlab',{
    method:'PATCH',body:{expectedVersion:settings.version,baseUrl:`http://127.0.0.1:${gitlab.address().port}`,projectIds:[42],token:syntheticToken},
  });
  const trashedIssue = await (await call(pilot.url,`/issues/${issue.id}?expectedVersion=${issue.version}`,{method:'DELETE'})).json();
  await call(pilot.url,`/attachments/${attachment.id}/content`,{status:404});
  assert.deepEqual(await (await call(pilot.url,calendarPath)).json(),[]);
  const replacementReservation = await (await call(pilot.url,`/issues/${parallel.id}/time-reservations`,{
    method:'POST',status:201,body:{...reservedTime,requestId:randomUUID()},
  })).json();
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
  const restoredAudit = await verifyPilotSourceMigration(copy.url, migration);
  assert.deepEqual(restoredAudit, sourceAudit, 'Migrated items, source rows, worklogs, links and file audit must agree across physical restore.');
  const updatedMigratedIssue = await (await call(copy.url, `/issues/${restoredAudit.issue.id}`, {
    method: 'PATCH', body: {expectedVersion: restoredAudit.issue.version, status: restoredAudit.nextStatus},
  })).json();
  assert.equal(updatedMigratedIssue.status, restoredAudit.nextStatus);
  assert.equal(updatedMigratedIssue.version, restoredAudit.issue.version + 1);
  await call(copy.url,'/integrations/gitlab/sync',{method:'POST',body:{}});
  assert.equal(authenticatedReads,2);
  await stop(copy);
  console.log('Pilot rehearsal passed: browser workflows, Jira administrator backup and Confluence space migration, single-writer lock, cold copy, integrity rejection, assignment rules and history, time reservations and individual trash restore.');
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
