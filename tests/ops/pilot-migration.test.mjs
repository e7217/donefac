import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const date = '2020-03-01T00:00:00Z';
const privateTitle = 'synthetic-private-issue-title';
const privateBody = 'synthetic-private-document-body';
const originalFrom = 'synthetic-source-instance';
const attachment = Buffer.from('synthetic source attachment\0');

function fixturePackages() {
  const jira = zip([
    { path: 'entities.xml', bytes: Buffer.from(`<entity-engine-xml>
      <Project id="10" pkey="SRC" name="Jira fixture"/><Status id="1" pname="Open"/><IssueType id="2" pname="Task"/>
      <Issue id="100" project="10" number="1" summary="${privateTitle}" status="1" issuetype="2" created="${date}" updated="${date}"/>
      <FileAttachment id="700" issue="100" filename="original.bin" filesize="${attachment.length}" created="${date}"/>
    </entity-engine-xml>`) },
    { path: 'attachments/SRC/SRC-1/700', bytes: attachment },
  ]);
  const confluence = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">20</id><property name="key">WIKI</property><property name="name">Confluence fixture</property></object>
    <object class="Page"><id name="id">200</id><property name="title">Original page</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>${privateBody}</p>]]></property>
      <property name="content" class="Page"><id name="id">200</id></property></object>
  </hibernate-generic>`) }]);
  return [{ filename: 'private-jira.zip', product: 'jira', bytes: jira }, { filename: 'private-wiki.zip', product: 'confluence', bytes: confluence }];
}

function launch(args, env) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/pilot-migration.mjs', ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let onAddress;
  const address = new Promise(resolve => { onAddress = resolve; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const match = /이관 검토 주소 (http:\/\/127\.0\.0\.1:\d+)\s/.exec(stdout);
    if (match) onAddress(match[1]);
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, exited, address };
}

async function waitForReview(run) {
  let timer;
  try {
    return await Promise.race([run.address, run.exited.then(result => { throw new Error(result.stderr || 'Review exited before opening.'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Review did not open.')), 30_000); })]);
  } finally { clearTimeout(timer); }
}

async function json(base, path, { method = 'GET', body, actor, status = 200 } = {}) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function readReport(root, answer) {
  const match = /검증 결과 (verification-[a-z\d]+\/report\.json) \(/i.exec(answer.stdout);
  assert.ok(match, answer.stdout + answer.stderr);
  const path = join(root, match[1]);
  const raw = await readFile(path, 'utf8');
  for (const value of [root, privateTitle, privateBody, originalFrom, 'private-wiki.zip', 'private-jira.zip', attachment.toString()]) {
    assert.equal(raw.includes(value), false);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  return { attempt: join(path, '..'), report: JSON.parse(raw) };
}

test('migration rehearsal stages local exports, applies a reviewed plan, and compares a separate cold restore', { timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-rehearsal-e2e-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, TEAMSPACE_DATA_DIR: join(scratch, 'other-workspace'), TEAMSPACE_PILOT_ACCESS_FILE: join(scratch, 'absent-key'),
    TEAMSPACE_PILOT_ORIGIN: 'https://rehearsal.example.invalid', TEAMSPACE_JIRA_BASE_URL: 'https://source.example.invalid' };
  const manifest = join(scratch, 'manifest.json'), root = join(scratch, 'run');
  const packages = fixturePackages();
  for (const item of packages) await writeFile(join(scratch, item.filename), item.bytes);
  const input = { packages: packages.map(item => ({ file: item.filename, product: item.product, instanceKey: `${originalFrom}-${item.product}` })) };
  await writeFile(manifest, `{ "packages": [ malformed ${privateTitle} ] }`);
  const malformed = await launch(['stage', manifest, root], env).exited;
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /이관 매니페스트 JSON 형식/);
  assert.equal(malformed.stderr.includes(privateTitle), false);
  assert.equal(existsSync(root), false);
  await writeFile(manifest, JSON.stringify({ packages: [input.packages[0], { ...input.packages[1], file: 'missing.zip' }] }));
  const interrupted = await launch(['stage', manifest, root], env).exited;
  assert.equal(interrupted.code, 1);
  assert.equal(existsSync(root), false);
  await writeFile(manifest, JSON.stringify(input));
  const stage = await launch(['stage', manifest, root], env).exited;
  assert.equal(stage.code, 0, stage.stderr);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(existsSync(env.TEAMSPACE_DATA_DIR), false);
  const stagePath = join(root, 'stage.json');
  const initial = await readFile(stagePath, 'utf8');
  const staged = JSON.parse(initial);
  assert.deepEqual(staged.packages.map(pkg => pkg.product), ['jira', 'confluence']);
  assert.equal((await stat(stagePath)).mode & 0o777, 0o600);
  assert.equal((await launch(['stage', manifest, root], env).exited).code, 1);
  assert.equal(await readFile(stagePath, 'utf8'), initial);

  const pending = await launch(['verify', root], env).exited;
  assert.equal(pending.code, 2, pending.stderr);
  const pendingEvidence = (await readReport(root, pending)).report;
  assert.equal(pendingEvidence.status, 'review');
  assert.equal(pendingEvidence.source.evidence.checks.pendingPackages, 2);
  assert.equal(pendingEvidence.restore, null);

  const review = launch(['review', root], env);
  try {
    const base = await waitForReview(review);
    assert.equal((await fetch(base, { signal: AbortSignal.timeout(10_000) })).status, 200);
    const locked = await launch(['verify', root], env).exited;
    assert.equal(locked.code, 1);
    assert.match(locked.stderr, /\(75\)/);
    assert.equal((await readReport(root, locked)).report.failedStep, 'source');
    const workspace = await json(base, '/workspace');
    assert.equal(workspace.users.length, 1);
    const actor = workspace.users[0].id;
    assert.equal(workspace.issues.length + workspace.documents.length, 0);
    const query = new URLSearchParams(staged.packages.map(pkg => ['packageId', pkg.packageId]));
    const { defaultConfiguration: configuration } = await json(base, `/migrations/options?${query}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key: 'REH', name: 'Rehearsal fixture' }));
    configuration.sourceBaseUrls = Object.fromEntries(staged.packages.map(pkg => [pkg.packageId, `https://${pkg.product}.example.invalid`]));
    const preview = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    assert.equal(preview.counts.issues, 1);
    assert.equal(preview.counts.documents, 1);
    await json(base, `/migrations/previews/${preview.id}/apply`, { method: 'POST', actor, status: 201,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } });
  } finally {
    review.child.kill('SIGINT');
    const stopped = await review.exited;
    assert.equal(stopped.code, 130, stopped.stderr);
  }

  const verified = await launch(['verify', root], env).exited;
  assert.equal(verified.code, 0, verified.stderr);
  const { attempt, report } = await readReport(root, verified);
  assert.equal(report.status, 'verified');
  assert.equal(report.source.evidence.receipts.length, 1);
  assert.equal(report.source.evidence.receipts[0].attachmentCounts.verified, 1);
  assert.equal(report.source.evidence.workspace.counts.issues, 1);
  assert.equal(report.source.evidence.workspace.counts.documents, 1);
  assert.equal(report.comparison.matches, true);
  assert.deepEqual(report.source.bundles, report.restore.bundles);
  assert.ok(existsSync(join(attempt, 'backup', 'manifest.json')));
  assert.ok(existsSync(join(attempt, 'restored', 'teamspace.sqlite')));

  const rawPath = join(root, 'workspace', 'legacy-imports', `${staged.packages[0].packageId}.bundle`);
  const corrupted = await readFile(rawPath);
  corrupted[0] ^= 1;
  await writeFile(rawPath, corrupted);
  const failed = await launch(['verify', root], env).exited;
  assert.equal(failed.code, 1, failed.stderr);
  const failedEvidence = (await readReport(root, failed)).report;
  assert.equal(failedEvidence.status, 'failed');
  assert.equal(failedEvidence.source.bundles[0].status, 'mismatch');
  assert.equal(failedEvidence.restore, null);
});
