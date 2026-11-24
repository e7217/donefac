import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startRehearsalPilot } from '../../scripts/pilot-migration-runtime.mjs';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const collector = 'scripts/jira-pilot-collect.mjs';
const rehearsal = 'scripts/pilot-migration.mjs';
const credential = 'Bearer synthetic-jira-batch-rehearsal';
const date = '2026-10-01T00:00:00.000Z';
const jiraProject = { id: '10', key: 'SRC', name: 'Synthetic Jira project' };
const jiraIssues = [1, 2, 3].map(number => ({ id: String(number + 100), key: `SRC-${number}` }));
const title = issue => `Synthetic ticket ${issue.key}`;
const wikiPageId = '200';
const wikiTitle = 'Synthetic runbook reachable only through Jira';
const unavailableRemoteLinksNotice = 'SOURCE_JIRA_REMOTE_LINKS_UNAVAILABLE';
const wikiHref = base => `${base}/pages/viewpage.action?pageId=${wikiPageId}`;
const wikiArchive = () => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
  <object class="Space"><id name="id">20</id><property name="key">WIKI</property><property name="name">Synthetic Confluence space</property></object>
  <object class="Page"><id name="id">${wikiPageId}</id><property name="title">${wikiTitle}</property><property name="version">1</property>
    <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property></object>
  <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>Original runbook steps.</p>]]></property>
    <property name="content" class="Page"><id name="id">${wikiPageId}</id></property><property name="bodyType">2</property></object>
</hibernate-generic>`) }]);

async function jira(t) {
  const api = '/jira/rest/api/2';
  const details = [], remoteLinks = [], wikiRequests = [], unexpected = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    function send(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }
    if (url.pathname === '/wiki' || url.pathname.startsWith('/wiki/')) {
      wikiRequests.push(`${request.method} ${url.pathname}`);
      return send(404, { error: 'The runbook is available only in the offline ZIP.' });
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
    const route = /^\/jira\/rest\/api\/2\/issue\/(\d+)(?:\/(comment|worklog|remotelink))?$/.exec(url.pathname);
    const issue = jiraIssues.find(item => item.id === route?.[1]);
    if (!issue) {
      unexpected.push(url.pathname);
      return send(404, { error: 'Unknown fixture route' });
    }
    if (route[2] === 'remotelink') {
      remoteLinks.push(issue.id);
      if (issue === jiraIssues[2]) return send(403, { errorMessages: ['Remote links are unavailable for this ticket.'] });
      if (issue !== jiraIssues[0]) return send(200, []);
      return send(200, [{
        id: 401, self: `${url.origin}${api}/issue/${issue.id}/remotelink/401`,
        globalId: `appId=synthetic-wiki&pageId=${wikiPageId}`,
        application: { type: 'com.atlassian.confluence', name: 'Confluence' },
        relationship: 'Wiki Page',
        object: { url: wikiHref(`${url.origin}/wiki`), title: wikiTitle },
      }]);
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl: `${origin}/jira`, wikiBaseUrl: `${origin}/wiki`, details, remoteLinks, wikiRequests, unexpected };
}

async function run(t, script, args, expectedCode = 0) {
  const result = await execute(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG }, timeout: 45_000, signal: t.signal,
  }).then(value => ({ ...value, code: 0 }), error => {
    if (typeof error.code !== 'number') throw error;
    return error;
  });
  assert.equal(result.code, expectedCode, `${script} ${args[0]}\n${result.stdout}\n${result.stderr}`);
  return result;
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

async function readWikiBinding(pilot, receiptId, issueId, wikiBaseUrl) {
  const snapshot = await json(pilot, '/workspace');
  const document = snapshot.documents.find(item => item.title === wikiTitle);
  assert.ok(document);
  assert.equal(document.plainText, 'Original runbook steps.');
  const links = snapshot.resourceLinks.filter(link => link.documentId === document.id);
  assert.equal(links.length, 1);
  const [{ id, documentId, issueId: linkedIssueId, kind }] = links;
  assert.equal(linkedIssueId, issueId);
  assert.equal(kind, 'related');
  const originalLinks = await json(pilot, `/atlassian-links?targetType=document&targetId=${documentId}`);
  assert.deepEqual(originalLinks.map(({ product, url }) => [product, url]), [['confluence', wikiHref(wikiBaseUrl)]]);
  const receipt = (await json(pilot, '/source-imports')).find(item => item.id === receiptId);
  assert.ok(receipt);
  assert.equal(receipt.counts.resourceLinks, 1);
  const proof = { id, issueId, documentId };
  assert.deepEqual(receipt.resourceLinkProof, [proof]);
  const audit = await json(pilot, `/source-imports/${receiptId}/reconciliation/audit?expectedVersion=${receipt.version}`);
  assert.match(audit.resourceLinkProjection.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(audit.resourceLinkProjection, {
    version: 1, expected: 1, sha256: audit.resourceLinkProjection.sha256,
    counts: { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 },
  });
  return { proof, projection: audit.resourceLinkProjection };
}

test('Jira batches and their offline Confluence link survive receipt verification and physical restore', { timeout: 120_000 }, async t => {
  const source = await jira(t);
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-jira-batch-rehearsal-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const config = join(scratch, 'jira.json'), plan = join(scratch, 'plan.json');
  const files = ['part-one.zip', 'part-two.zip'];
  const wikiFile = 'runbook.zip', wikiBytes = wikiArchive();
  await writeFile(join(scratch, wikiFile), wikiBytes, { mode: 0o600 });
  const authFile = join(scratch, 'jira-auth');
  await writeFile(authFile, `${credential}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ baseUrl: source.baseUrl, projectKey: 'SRC', authFile }), { mode: 0o600 });
  const planned = JSON.parse((await run(t, collector, ['plan', config, plan, '--batch-size', '2'])).stdout);
  assert.equal(planned.issueCount, jiraIssues.length);
  assert.equal(planned.batchCount, files.length);
  const planBytes = await readFile(plan);
  assert.equal(createHash('sha256').update(planBytes).digest('hex'), planned.sha256);
  const batchHashes = [];
  for (const [index, file] of files.entries()) {
    const collection = JSON.parse((await run(t, collector, ['batch', config, plan, String(index + 1), join(scratch, file)])).stdout);
    assert.equal(collection.issueCount, index === 0 ? 2 : 1);
    assert.equal(collection.remoteLinkCount, index === 0 ? 1 : 0);
    assert.equal(collection.unavailableRemoteLinkIssues, index === 0 ? 0 : 1);
    assert.equal(collection.planSha256, planned.sha256);
    assert.equal(collection.sha256, createHash('sha256').update(await readFile(join(scratch, file))).digest('hex'));
    batchHashes.push(collection.sha256);
  }
  assert.deepEqual(source.details, jiraIssues.map(issue => issue.id));
  assert.deepEqual(source.remoteLinks, jiraIssues.map(issue => issue.id));
  assert.deepEqual(source.wikiRequests, []);

  const manifest = join(scratch, 'manifest.json'), root = join(scratch, 'run');
  const writeManifest = selected => writeFile(manifest, JSON.stringify({
    packages: [...selected.map(file => ({ file, product: 'jira', instanceKey: 'synthetic-jira-batches' })),
      { file: wikiFile, product: 'confluence', instanceKey: 'synthetic-confluence' }],
  }));
  await writeManifest(files.slice(0, 1));
  const incomplete = join(scratch, 'missing-batch');
  const rejected = await run(t, rehearsal, ['stage', manifest, incomplete, '--jira-plan', plan], 1);
  assert.match(rejected.stderr, /Jira.*(계획|묶음)/u);
  await assert.rejects(lstat(incomplete), { code: 'ENOENT' });

  await writeManifest(files.slice().reverse());
  const mixedPlan = join(scratch, 'mixed-plan.json');
  const mixed = JSON.parse(planBytes);
  // The union and sizes still agree, but neither submitted ZIP contains this exact batch.
  const [[first, second], [third]] = mixed.batches;
  mixed.batches = [[first, third], [second]];
  await writeFile(mixedPlan, JSON.stringify(mixed));
  const wrongMembership = join(scratch, 'wrong-membership');
  const mismatched = await run(t, rehearsal, ['stage', manifest, wrongMembership, '--jira-plan', mixedPlan], 1);
  assert.match(mismatched.stderr, /Jira.*(계획|묶음)/u);
  await assert.rejects(lstat(wrongMembership), { code: 'ENOENT' });

  await run(t, rehearsal, ['stage', manifest, root, '--jira-plan', plan]);
  const workspace = join(root, 'workspace');
  const { packages, jiraPlans } = JSON.parse(await readFile(join(workspace, '.teamspace-rehearsal', 'stage.json')));
  assert.deepEqual(packages.map(pkg => pkg.sha256), [...batchHashes.slice().reverse(), createHash('sha256').update(wikiBytes).digest('hex')]);
  const wikiPackage = packages.find(pkg => pkg.product === 'confluence');
  assert.ok(wikiPackage);
  const expectedPlans = [{
    sha256: planned.sha256,
    issueCount: jiraIssues.length,
    batchCount: files.length,
    packageIds: batchHashes.map(hash => packages.find(pkg => pkg.sha256 === hash).packageId),
  }];
  assert.deepEqual(jiraPlans, expectedPlans);
  const privatePlan = directory => join(directory, '.teamspace-rehearsal', 'jira-plans', `${planned.sha256}.json`);
  assert.deepEqual(await readFile(privatePlan(workspace)), planBytes);
  assert.equal((await lstat(privatePlan(workspace))).mode & 0o777, 0o600);
  // Verification and backup must use the staged private copy once the operator moves the input plan.
  await rm(plan);
  const pilot = await startRehearsalPilot(workspace, { signal: t.signal });
  let receipt, jiraProjectId, originalTicketIds, originalWikiBinding;
  try {
    const { users: [actor] } = await json(pilot, '/workspace');
    const headers = { 'X-Actor-Id': actor.id };
    const query = new URLSearchParams(packages.map(({ packageId }) => ['packageId', packageId]));
    const { defaultConfiguration: configuration, containers } = await json(pilot, `/migrations/options?${query}`, { headers });
    const wikiContainer = containers.find(value => value.packageId === wikiPackage.packageId);
    assert.ok(wikiContainer);
    assert.equal(configuration.projects.length, files.length + 1);
    configuration.projects = configuration.projects.map(project => project.containerId === wikiContainer.id
      ? { ...project, key: 'RUNBOOK', name: 'Migrated runbook space' }
      : { ...project, key: 'MOVED', name: 'One migrated Jira project' });
    configuration.sourceBaseUrls = Object.fromEntries(packages.map(pkg => [pkg.packageId,
      pkg.product === 'confluence' ? source.wikiBaseUrl : source.baseUrl]));
    const preview = await json(pilot, '/migrations/preview', { method: 'POST', headers, status: 201, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    assert.equal(preview.counts.projects, 2);
    assert.equal(preview.counts.issues, jiraIssues.length);
    assert.equal(preview.counts.documents, 1);
    assert.equal(preview.counts.issueRelations, 1);
    assert.equal(preview.counts.resourceLinks, 1);
    assert.ok(preview.notices.some(notice => notice.code === unavailableRemoteLinksNotice && notice.severity === 'warning'));
    ({ import: receipt } = await json(pilot, `/migrations/previews/${preview.id}/apply`, { method: 'POST', headers, status: 201,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } }));
    assert.equal(receipt.projectIds.length, 2);
    assert.equal(receipt.packages.length, files.length + 1);
    const { projects } = await json(pilot, '/workspace');
    jiraProjectId = projects.find(project => project.key === 'MOVED')?.id;
    assert.ok(jiraProjectId && receipt.projectIds.includes(jiraProjectId));
    originalTicketIds = await readTickets(pilot, jiraProjectId, source.baseUrl);
    originalWikiBinding = await readWikiBinding(pilot, receipt.id, originalTicketIds[0], source.wikiBaseUrl);
  } finally { await pilot.close(); }

  // The existing rehearsal reports permission and workflow reviews separately from restore integrity.
  await run(t, rehearsal, ['verify', root], 2);
  const attempts = (await readdir(root)).filter(name => name.startsWith('verification-'));
  assert.equal(attempts.length, 1);
  const attempt = join(root, attempts[0]);
  const reportText = await readFile(join(attempt, 'report.json'), 'utf8');
  const report = JSON.parse(reportText);
  assert.deepEqual(report.jiraPlans, expectedPlans);
  for (const secret of [credential, authFile, source.baseUrl, source.wikiBaseUrl, wikiTitle, '"scopeSha256"', '"batches"', ...jiraIssues.map(issue => issue.key)]) {
    assert.ok(!reportText.includes(secret), 'The verification report exposed source identifiers or collection configuration.');
  }
  assert.deepEqual(report.comparison, { status: 'review', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true });
  for (const { evidence, jiraPlanCoverage } of [report.source, report.restore]) {
    assert.deepEqual(jiraPlanCoverage, expectedPlans);
    assert.equal(evidence.checks.pendingPackages, 0);
    assert.equal(evidence.checks.receiptsWithResourceLinkFailures, 0);
    assert.equal(evidence.receipts.length, 1);
    const [audited] = evidence.receipts;
    assert.equal(audited.id, receipt.id);
    assert.equal(audited.projectCount, 2);
    assert.ok(audited.notices.some(notice => notice.code === unavailableRemoteLinksNotice && notice.severity === 'warning'));
    assert.deepEqual(audited.primaryRecords.map(record => [record.records.expected, record.records.observed, record.counts.linked, record.invalidTargets])
      .sort((a, b) => a[0] - b[0]), [[1, 1, 1, 0], [1, 1, 1, 0], [2, 2, 2, 0]]);
    assert.equal(audited.targetContent.issueRelations.count, 1);
    assert.equal(audited.jiraRelationProjection.expected, 1);
    assert.deepEqual(audited.jiraRelationProjection.counts, { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 });
    assert.deepEqual(audited.resourceLinkProjection, originalWikiBinding.projection);
  }
  const restoredPath = join(attempt, 'restored');
  const restoredStatePath = join(restoredPath, '.teamspace-rehearsal', 'stage.json');
  const restoredState = JSON.parse(await readFile(restoredStatePath));
  assert.deepEqual(restoredState.jiraPlans, expectedPlans);
  assert.deepEqual(await readFile(privatePlan(restoredPath)), planBytes);
  assert.equal((await lstat(privatePlan(restoredPath))).mode & 0o777, 0o600);
  const restored = await startRehearsalPilot(restoredPath, { signal: t.signal });
  try {
    assert.deepEqual(await readTickets(restored, jiraProjectId, source.baseUrl), originalTicketIds);
    assert.deepEqual(await readWikiBinding(restored, receipt.id, originalTicketIds[0], source.wikiBaseUrl), originalWikiBinding);
  }
  finally { await restored.close(); }

  restoredState.jiraPlans[0].packageIds.reverse();
  await writeFile(restoredStatePath, JSON.stringify(restoredState));
  const badProof = await run(t, rehearsal, ['review', restoredPath], 1);
  assert.match(badProof.stderr, /Jira.*보관한 ZIP 연결/u);
  assert.doesNotMatch(badProof.stdout, /이관 검토 주소/u);

  const db = new DatabaseSync(join(workspace, 'teamspace.sqlite'));
  try {
    const removed = db.prepare(`DELETE FROM issue_relations WHERE id IN (
      SELECT json_extract(json,'$.jiraRelationId') FROM source_records WHERE import_id=? AND kind='relation')`).run(receipt.id);
    assert.equal(removed.changes, 1);
    assert.equal(db.prepare('DELETE FROM resource_links WHERE id=?').run(originalWikiBinding.proof.id).changes, 1);
  } finally { db.close(); }
  const failedVerification = await run(t, rehearsal, ['verify', root], 1);
  const secondAttempt = (await readdir(root)).find(name => name.startsWith('verification-') && name !== attempts[0]);
  const failed = JSON.parse(await readFile(join(root, secondAttempt, 'report.json')));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.restore, null, 'Copying the damaged workspace cannot satisfy rehearsal.');
  assert.ok(failed.source?.evidence, failedVerification.stderr);
  assert.equal(failed.source.evidence.checks.receiptsWithJiraRelationFailures, 1);
  assert.equal(failed.source.evidence.receipts[0].jiraRelationProjection.counts.missing, 1);
  assert.equal(failed.source.evidence.checks.receiptsWithResourceLinkFailures, 1);
  assert.equal(failed.source.evidence.receipts[0].resourceLinkProjection.counts.missing, 1);
  assert.deepEqual(source.wikiRequests, []);
  assert.deepEqual(source.unexpected, []);
});
