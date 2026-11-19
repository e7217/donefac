import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'teamspace-pilot-'));
const source = join(scratch, 'source');
const backup = join(scratch, 'backup');
const restored = join(scratch, 'restored');
const pilots = new Set();

async function deadline(completion, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function start(dataDir, demo = false) {
  const child = spawn('bash', ['scripts/pilot-lock.sh', dataDir, process.execPath, '--import', 'tsx', 'server/pilot.ts'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, TEAMSPACE_PILOT_PORT: '0', TEAMSPACE_PILOT_DEMO: demo ? '1' : '0', TEAMSPACE_PILOT_OUTBOUND: '0',
    },
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
    signal: AbortSignal.timeout(25_000),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  return response;
}

function cli(action, from, to) {
  const result = spawnSync(process.execPath, ['scripts/pilot-backup.mjs', action, from, to], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function fileHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

async function browser(url) {
  const playwright = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  const child = spawn(process.execPath, [playwright, 'test', '--config=playwright.pilot.config.ts', `--output=${join(scratch,'browser')}`, '--reporter=line'], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, TEAMSPACE_PILOT_TEST_URL: url },
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `Pilot browser checks failed (${code ?? signal}).`);
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

try {
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
  const initialCapacity = await (await call(pilot.url,capacityPath)).json();
  await call(pilot.url,capacityPath,{method:'PATCH',body:{expectedVersion:initialCapacity.version,members:[{userId:assigneeId,dailyMinutes:240}]}});
  const issue = await (await call(pilot.url, '/issues', {
    method:'POST', status:201, body:{projectId,title:'파일럿 백업 복원 업무',assigneeId,startDate:workloadDate,endDate:workloadDate,estimate:2,plannedEffortMinutes:300},
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
  const original = Buffer.from('Issue key,Summary,Description\r\nOLD-1,파일럿 원본 업무,보관할 원본 내용\r\n');
  const archive = await (await call(pilot.url,'/legacy-import/packages?filename=pilot.csv&instanceKey=pilot-synthetic&product=jira',{
    method:'POST',status:201,headers:{'Content-Type':'application/octet-stream'},body:original,
  })).json();
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
  const restoredPackage = await (await call(copy.url,`/legacy-import/packages/${archive.id}`)).json();
  assert.equal(restoredPackage.summary.sha256,archive.sha256);
  assert.deepEqual(readFileSync(join(restored,'legacy-imports',`${archive.id}.bundle`)),original);
  await call(copy.url,'/integrations/gitlab/sync',{method:'POST',body:{}});
  assert.equal(authenticatedReads,2);
  await stop(copy);
  console.log('Pilot rehearsal passed: browser workflows, single-writer lock, cold copy, integrity rejection and restored data.');
} finally {
  for (const pilot of pilots) await stop(pilot).catch(() => {});
  if (gitlab.listening) await new Promise(resolve => gitlab.close(resolve));
  rmSync(scratch,{recursive:true,force:true});
}
