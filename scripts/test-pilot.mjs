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

async function applyPilotSourceMigration(url, actorId) {
  const jira = Buffer.from([
    'Issue id,Issue key,Project key,Summary,Description,Created,Updated,Status,Issue Type',
    '100,OLD-1,OLD,파일럿 원본 업무,보관할 원본 내용,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task',
    '101,OLD-2,OLD,파일럿 두 번째 업무,진행 상태의 원본,2020-01-02T00:00:00Z,2020-01-03T00:00:00Z,In Progress,Task',
    '',
  ].join('\r\n'));
  const versions = [Buffer.from('보존할 첨부 첫 버전\r\n'), Buffer.from('보존할 첨부 두 번째 버전\x00\n')];
  const confluence = zip([
    {path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">SYN</property><property name="name">파일럿 원본 공간</property></object>
      <object class="Page"><id name="id">100</id><property name="title">파일럿 원본 설계 문서</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property></object>
      <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>이관 뒤 검토할 설계 내용</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OLD-1</ac:parameter></ac:structured-macro>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
      <object class="Attachment"><id name="id">700</id><property name="title">pilot-origin.bin</property><property name="version">2</property><property name="containerContent" class="Page"><id name="id">100</id></property><collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection><property name="creationDate">2020-01-02T00:00:00Z</property></object>
      <object class="Attachment"><id name="id">701</id><property name="title">pilot-origin.bin</property><property name="version">1</property><property name="containerContent" class="Page"><id name="id">100</id></property><property name="originalVersion" class="Attachment"><id name="id">700</id></property><property name="creationDate">2020-01-01T00:00:00Z</property></object>
    </hibernate-generic>`)},
    ...versions.map((bytes, index) => ({path: `attachments/100/700/${index + 1}`, bytes})),
  ]);
  const headers = { 'X-Actor-Id': actorId };
  async function stage(filename, product, body) {
    const query = new URLSearchParams({filename, product, instanceKey: `pilot-${product}`});
    return (await call(url, `/legacy-import/packages?${query}`, {
      method: 'POST', status: 201, headers: {...headers, 'Content-Type': 'application/octet-stream'}, body,
    })).json();
  }
  const jiraPackage = await stage('pilot.csv', 'jira', jira);
  const wikiPackage = await stage('pilot.zip', 'confluence', confluence);
  const query = new URLSearchParams();
  for (const info of [jiraPackage, wikiPackage]) query.append('packageId', info.id);
  const options = await (await call(url, `/migrations/options?${query}`, {headers})).json();
  const migration = options.defaultConfiguration;
  migration.projects = migration.projects.map(project => ({...project, key: 'PILOTIMP', name: '파일럿 합성 이관'}));
  migration.sourceBaseUrls = {
    [jiraPackage.id]: 'https://jira.example.test/jira',
    [wikiPackage.id]: 'https://wiki.example.test/confluence',
  };
  const preview = await (await call(url, '/migrations/preview', {
    method: 'POST', status: 201, headers, body: {configuration: migration},
  })).json();
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.counts.atlassianLinks, 3);
  assert.equal(preview.counts.unlinkedAtlassianRecords, 0);
  const {import: receipt} = await (await call(url, `/migrations/previews/${preview.id}/apply`, {
    method: 'POST', status: 201, headers,
    body: {expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements},
  })).json();
  assert.deepEqual(receipt.counts, preview.counts);
  return {receipt, versions, packages: [{summary: jiraPackage, bytes: jira}, {summary: wikiPackage, bytes: confluence}]};
}

async function verifyPilotSourceMigration(url, migration) {
  const {receipt, versions} = migration;
  assert.equal(receipt.projectIds.length, 1);
  const [projectId] = receipt.projectIds;
  const base = `/source-imports/${receipt.id}/reconciliation`;
  const workspace = await (await call(url, '/workspace')).json();
  const issue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 원본 업무');
  const otherIssue = workspace.issues.find(item => item.projectId === projectId && item.title === '파일럿 두 번째 업무');
  const document = workspace.documents.find(item => item.projectId === projectId);
  const workflow = workspace.workflows.find(item => item.projectId === projectId);
  const nextStatus = workflow?.statuses.find(status => status.category === 'in_progress')?.id;
  assert.ok(issue && otherIssue && nextStatus && nextStatus !== issue.status);
  assert.equal(document?.title, '파일럿 원본 설계 문서');
  assert.ok(document.plainText.includes('이관 뒤 검토할 설계 내용'));
  assert.ok(document.content.content.some(node => node.type === 'issueReference' && node.attrs.issueId === issue.id));
  assert.ok(workspace.resourceLinks.some(link => link.issueId === issue.id && link.documentId === document.id));
  const originalLinks = [];
  for (const [targetType, targetId, originalUrl] of [
    ['issue', issue.id, 'https://jira.example.test/jira/browse/OLD-1'],
    ['issue', otherIssue.id, 'https://jira.example.test/jira/browse/OLD-2'],
    ['document', document.id, 'https://wiki.example.test/confluence/pages/viewpage.action?pageId=100'],
  ]) {
    const query = new URLSearchParams({targetType, targetId});
    const links = await (await call(url, `/atlassian-links?${query}`)).json();
    assert.deepEqual(links.map(link => link.url), [originalUrl]);
    originalLinks.push(links[0]);
  }
  const reconciliation = await (await call(url, `${base}?kind=issue`)).json();
  assert.equal(reconciliation.rows.find(row => row.sourceKey === 'OLD-1')?.target?.id, issue.id);
  const audit = await (await call(url, `${base}/audit?expectedVersion=${receipt.version}`)).json();
  assert.equal(audit.receiptVersion, receipt.version);
  assert.deepEqual(audit.recordCounts, reconciliation.counts);
  assert.equal(audit.recordCounts.missing, 0);
  assert.deepEqual(audit.attachmentCounts, {verified: 2, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0});
  assert.equal(audit.attachments.length, versions.length);
  for (const [index, bytes] of versions.entries()) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const checked = audit.attachments.find(file => file.sha256 === sha);
    assert.equal(checked?.status, 'verified');
    assert.equal(checked.sourceId, index === 0 ? '701' : '700');
    assert.equal(checked.packageSha256, migration.packages[1].summary.sha256);
    const download = await call(url, `/attachment-versions/${checked.fileId}/download`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  return {issue, document, nextStatus, originalLinks, recordCounts: audit.recordCounts, attachments: audit.attachments};
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
  const migration = await applyPilotSourceMigration(pilot.url, assigneeId);
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
  await call(copy.url,`/attachments/${attachment.id}/content`,{status:404});
  const undone = await (await call(copy.url,`/trash/${trashedIssue.trashEntryId}/restore`,{method:'POST',body:{}})).json();
  assert.equal(undone.resourceId,issue.id);
  const restoredIssue = await (await call(copy.url,`/v1/issues/${issue.id}`,{
    headers:{Authorization:`Bearer ${key.token}`},
  })).json();
  assert.equal(restoredIssue.title,issue.title);
  assert.equal(restoredIssue.estimate,2);
  assert.equal(restoredIssue.plannedEffortMinutes,300);
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
  assert.deepEqual(restoredAudit, sourceAudit, 'The migrated ticket, document, linkage and file audit must agree across physical restore.');
  const updatedMigratedIssue = await (await call(copy.url, `/issues/${restoredAudit.issue.id}`, {
    method: 'PATCH', body: {expectedVersion: restoredAudit.issue.version, status: restoredAudit.nextStatus},
  })).json();
  assert.equal(updatedMigratedIssue.status, restoredAudit.nextStatus);
  assert.equal(updatedMigratedIssue.version, restoredAudit.issue.version + 1);
  await call(copy.url,'/integrations/gitlab/sync',{method:'POST',body:{}});
  assert.equal(authenticatedReads,2);
  await stop(copy);
  console.log('Pilot rehearsal passed: browser workflows, mixed Jira/Confluence migration audit, single-writer lock, cold copy, integrity rejection and restored data.');
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
