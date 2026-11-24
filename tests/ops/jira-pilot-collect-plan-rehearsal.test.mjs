import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startRehearsalPilot } from '../../scripts/pilot-migration-runtime.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const collector = 'scripts/jira-pilot-collect.mjs';
const rehearsal = 'scripts/pilot-migration.mjs';
const credential = 'Bearer synthetic-jira-batch-rehearsal';
const date = '2026-10-01T00:00:00.000Z';
const jiraProject = { id: '10', key: 'SRC', name: 'Synthetic Jira project' };
const jiraIssues = [1, 2, 3].map(number => ({ id: String(number + 100), key: `SRC-${number}` }));
const title = issue => `Synthetic ticket ${issue.key}`;

async function jira(t) {
  const api = '/jira/rest/api/2';
  const details = [], unexpected = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    function send(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }
    if (request.method !== 'GET' || request.headers.authorization !== credential) {
      unexpected.push(url.pathname);
      return send(403, { error: 'Invalid fixture request' });
    }
    const startAt = Number(url.searchParams.get('startAt'));
    if (url.pathname === `${api}/search` && url.searchParams.get('fields') === 'project') {
      // The source may return a smaller page than the requested size.
      const issues = jiraIssues.slice(startAt, startAt + 2).map(issue => ({ ...issue, fields: { project: jiraProject } }));
      return send(200, { issues, startAt, total: jiraIssues.length, maxResults: 2 });
    }
    const route = /^\/jira\/rest\/api\/2\/issue\/(\d+)(?:\/(comment|worklog))?$/.exec(url.pathname);
    const issue = jiraIssues.find(item => item.id === route?.[1]);
    if (!issue) {
      unexpected.push(url.pathname);
      return send(404, { error: 'Unknown fixture route' });
    }
    if (route[2]) {
      return send(200, { startAt, total: 0, maxResults: 100, [route[2] === 'comment' ? 'comments' : 'worklogs']: [] });
    }
    details.push(issue.id);
    const linkType = { id: '7', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
    const issuelinks = issue === jiraIssues[1] ? [{ id: '21', type: linkType, outwardIssue: jiraIssues[2] }] : [];
    return send(200, { ...issue, self: `${url.origin}${api}/issue/${issue.id}`, fields: {
      project: jiraProject, summary: title(issue), created: date, updated: date, issuelinks,
      status: { id: '1', name: 'Open' }, issuetype: { id: '2', name: 'Task' },
    }, changelog: { startAt: 0, total: 0, maxResults: 100, histories: [] } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/jira`, details, unexpected };
}

async function run(t, script, args, expectedCode = 0) {
  const result = await execute(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG }, timeout: 45_000, signal: t.signal,
  }).then(value => ({ ...value, code: 0 }), error => {
    if (typeof error.code !== 'number') throw error;
    return error;
  });
  assert.equal(result.code, expectedCode, `${script} ${args[0]}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function json(pilot, path, { status = 200, ...options } = {}) {
  const response = await pilot.request(path, options);
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function readTickets(pilot, projectId, baseUrl) {
  const snapshot = await json(pilot, '/workspace');
  const issues = snapshot.issues.filter(issue => issue.projectId === projectId);
  assert.equal(issues.length, jiraIssues.length);
  assert.equal(new Set(issues.map(issue => issue.id)).size, jiraIssues.length);
  const tickets = await Promise.all(jiraIssues.map(async source => {
    const issue = issues.find(item => item.title === title(source));
    assert.ok(issue, source.key);
    const links = await json(pilot, `/atlassian-links?targetType=issue&targetId=${issue.id}`);
    assert.deepEqual(links.map(({ product, url }) => [product, url]), [['jira', `${baseUrl}/browse/${source.key}`]]);
    return issue;
  }));
  const relations = await json(pilot, `/issues/${tickets[1].id}/relations`);
  assert.deepEqual(relations.map(({ sourceIssueId, targetIssueId, type }) => [sourceIssueId, targetIssueId, type]),
    [[tickets[1].id, tickets[2].id, 'Blocks']]);
  return tickets.map(issue => issue.id);
}

test('two Jira collection batches import as one project and survive physical restore', { timeout: 120_000 }, async t => {
  const source = await jira(t);
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-jira-batch-rehearsal-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const config = join(scratch, 'jira.json'), plan = join(scratch, 'plan.json');
  const files = ['part-one.zip', 'part-two.zip'];
  const authFile = join(scratch, 'jira-auth');
  await writeFile(authFile, `${credential}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ baseUrl: source.baseUrl, projectKey: 'SRC', authFile }), { mode: 0o600 });
  const planned = JSON.parse(await run(t, collector, ['plan', config, plan, '--batch-size', '2']));
  assert.equal(planned.issueCount, jiraIssues.length);
  assert.equal(planned.batchCount, files.length);
  for (const [index, file] of files.entries()) {
    const collection = JSON.parse(await run(t, collector, ['batch', config, plan, String(index + 1), join(scratch, file)]));
    assert.equal(collection.issueCount, index === 0 ? 2 : 1);
    assert.equal(collection.planSha256, planned.sha256);
    assert.equal(collection.sha256, createHash('sha256').update(await readFile(join(scratch, file))).digest('hex'));
  }
  assert.deepEqual(source.details, jiraIssues.map(issue => issue.id));

  const manifest = join(scratch, 'manifest.json'), root = join(scratch, 'run');
  await writeFile(manifest, JSON.stringify({ packages: files.map(file => ({ file, product: 'jira', instanceKey: 'synthetic-jira-batches' })) }));
  await run(t, rehearsal, ['stage', manifest, root]);
  const workspace = join(root, 'workspace');
  const { packages } = JSON.parse(await readFile(join(workspace, '.teamspace-rehearsal', 'stage.json')));
  const pilot = await startRehearsalPilot(workspace, { signal: t.signal });
  let receipt, originalTicketIds;
  try {
    const { users: [actor] } = await json(pilot, '/workspace');
    const headers = { 'X-Actor-Id': actor.id };
    const query = new URLSearchParams(packages.map(({ packageId }) => ['packageId', packageId]));
    const { defaultConfiguration: configuration } = await json(pilot, `/migrations/options?${query}`, { headers });
    assert.equal(configuration.projects.length, files.length);
    configuration.projects = configuration.projects.map(project => ({ ...project, key: 'MOVED', name: 'One migrated Jira project' }));
    configuration.sourceBaseUrls = Object.fromEntries(packages.map(({ packageId }) => [packageId, source.baseUrl]));
    const preview = await json(pilot, '/migrations/preview', { method: 'POST', headers, status: 201, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    assert.equal(preview.counts.projects, 1);
    assert.equal(preview.counts.issues, jiraIssues.length);
    assert.equal(preview.counts.issueRelations, 1);
    ({ import: receipt } = await json(pilot, `/migrations/previews/${preview.id}/apply`, { method: 'POST', headers, status: 201,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } }));
    assert.equal(receipt.projectIds.length, 1);
    assert.equal(receipt.packages.length, files.length);
    originalTicketIds = await readTickets(pilot, receipt.projectIds[0], source.baseUrl);
  } finally { await pilot.close(); }

  // The existing rehearsal reports permission and workflow reviews separately from restore integrity.
  await run(t, rehearsal, ['verify', root], 2);
  const attempts = (await readdir(root)).filter(name => name.startsWith('verification-'));
  assert.equal(attempts.length, 1);
  const attempt = join(root, attempts[0]);
  const report = JSON.parse(await readFile(join(attempt, 'report.json')));
  assert.deepEqual(report.comparison, { status: 'review', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true });
  for (const { evidence } of [report.source, report.restore]) {
    assert.equal(evidence.checks.pendingPackages, 0);
    assert.equal(evidence.receipts.length, 1);
    const [audited] = evidence.receipts;
    assert.equal(audited.id, receipt.id);
    assert.equal(audited.projectCount, 1);
    assert.deepEqual(audited.primaryRecords.map(record => [record.records.expected, record.records.observed, record.counts.linked, record.invalidTargets])
      .sort((a, b) => a[0] - b[0]), [[1, 1, 1, 0], [2, 2, 2, 0]]);
    assert.equal(audited.targetContent.issueRelations.count, 1);
  }
  const restored = await startRehearsalPilot(join(attempt, 'restored'), { signal: t.signal });
  try { assert.deepEqual(await readTickets(restored, receipt.projectIds[0], source.baseUrl), originalTicketIds); }
  finally { await restored.close(); }
  assert.deepEqual(source.unexpected, []);
});
