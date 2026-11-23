import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startRehearsalPilot } from '../../scripts/pilot-migration-runtime.mjs';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const date = '2020-03-01T00:00:00Z';
const issueCount = 1200;
const pageCount = 300;
const jiraKey = 'LJR';
const attachmentBytes = 2 * 1024 * 1024;
const jiraAttachmentInterval = 100;
const wikiAttachmentInterval = 25;
const commentInterval = 20;
const worklogInterval = 30;
const issueId = number => 1_000 + number;
const pageId = number => 20_000 + number;
const pageParent = number => Math.floor(number / 2);
const issueTitle = number => `Synthetic Jira ticket ${number}`;
const pageTitle = number => `Synthetic Confluence page ${number}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function sampleAttachment(path, sourceId) {
  // Use reproducible, incompressible synthetic bytes to exercise actual upload and backup volume.
  return { path, sourceId: String(sourceId), bytes: createHash('shake256', { outputLength: attachmentBytes }).update(path).digest() };
}

function archive(input, content, files) {
  return { input, bytes: zip([{ path: 'entities.xml', bytes: Buffer.from(content) }, ...files]),
    files: new Map(files.map(({ sourceId, bytes }) => [sourceId, digest(bytes)])) };
}

function jiraArchive() {
  const issues = [], links = [], history = [], metadata = [], files = [];
  for (let number = 1; number <= issueCount; number++) {
    const id = issueId(number);
    issues.push(`<Issue id="${id}" project="10" number="${number}" summary="${issueTitle(number)}" status="${number % 2 ? 1 : 3}" issuetype="${number % 3 ? 2 : 4}" assignee="fixture-user" created="${date}" updated="${date}"><description>Synthetic description ${number}</description></Issue>`);
    if (number > 1) links.push(`<IssueLink id="${id + 3_000}" linktype="${number % 2 ? 501 : 500}" source="${issueId(number - 1)}" destination="${id}"/>`);
    if (number % commentInterval === 0) history.push(`<Action id="${id + 6_000}" issue="${id}" author="fixture-user" type="comment" created="${date}" body="Synthetic Jira comment ${number}"/>`);
    if (number % worklogInterval === 0) history.push(`<Worklog id="${id + 8_000}" issue="${id}" author="fixture-user" startdate="${date}" timeworked="91" created="${date}" updated="${date}" body="Synthetic Jira worklog ${number}"/>`);
    if (number % jiraAttachmentInterval === 0) {
      const attachmentId = id + 10_000;
      metadata.push(`<FileAttachment id="${attachmentId}" issue="${id}" filename="fixture-${number}.bin" filesize="${attachmentBytes}" mimetype="application/octet-stream" created="${date}"/>`);
      files.push(sampleAttachment(`attachments/${jiraKey}/${jiraKey}-${number}/${attachmentId}`, attachmentId));
    }
  }
  const content = `<entity-engine-xml>
    <ApplicationUser id="21" userKey="fixture-jira-user" lowerUserName="fixture-user"/>
    <User id="22" userName="fixture-user" displayName="Synthetic Jira author" active="1"/>
    <Project id="10" pkey="${jiraKey}" name="Synthetic Jira project"/>
    <Status id="1" pname="Open"/><Status id="3" pname="In Progress"/>
    <IssueType id="2" pname="Task"/><IssueType id="4" pname="Bug"/>
    <IssueLinkType id="500" linkname="Blocks" inward="is blocked by" outward="blocks"/>
    <IssueLinkType id="501" linkname="Relates" inward="relates to" outward="relates to"/>
    ${[...issues, ...links, ...history, ...metadata].join('\n')}
  </entity-engine-xml>`;
  return archive({ file: 'jira-admin.zip', product: 'jira', instanceKey: 'scale-jira' }, content, files);
}

function confluenceArchive() {
  const records = [], files = [];
  for (let number = 1; number <= pageCount; number++) {
    const id = pageId(number);
    const parent = number > 1 ? `<property name="parent" class="Page"><id name="id">${pageId(pageParent(number))}</id></property>` : '';
    const jiraMacro = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${jiraKey}-${number * 4}</ac:parameter></ac:structured-macro>`;
    records.push(`<object class="Page"><id name="id">${id}</id><property name="title">${pageTitle(number)}</property>
      <property name="version">1</property><property name="space" class="Space"><id name="id">20</id></property>
      <property name="creationDate">${date}</property><property name="lastModificationDate">${date}</property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">fixture-wiki-user</id></property>${parent}</object>
      <object class="BodyContent"><id name="id">${id + 1_000}</id><property name="body"><![CDATA[<p>Synthetic wiki content ${number}</p>${jiraMacro}]]></property>
      <property name="content" class="Page"><id name="id">${id}</id></property></object>`);
    if (number % wikiAttachmentInterval === 0) {
      const attachmentId = id + 3_000;
      records.push(`<object class="Attachment"><id name="id">${attachmentId}</id><property name="title">fixture-${number}.bin</property>
        <property name="version">1</property><property name="containerContent" class="Page"><id name="id">${id}</id></property>
        <property name="creationDate">${date}</property></object>`);
      files.push(sampleAttachment(`attachments/${id}/${attachmentId}/1`, attachmentId));
    }
  }
  const content = `<hibernate-generic><object class="ConfluenceUserImpl"><id name="key">fixture-wiki-user</id>
    <property name="name">fixture-wiki-user</property><property name="displayName">Synthetic Confluence author</property></object>
    <object class="Space"><id name="id">20</id><property name="key">LWK</property><property name="name">Synthetic wiki space</property></object>
    ${records.join('\n')}</hibernate-generic>`;
  return archive({ file: 'confluence-space.zip', product: 'confluence', instanceKey: 'scale-confluence' }, content, files);
}

async function runRehearsal(args, expectedExit) {
  let result;
  try {
    result = await execute(process.execPath, ['--import', 'tsx', 'scripts/pilot-migration.mjs', ...args], {
      cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG }, timeout: 180_000,
    });
  } catch (error) {
    assert.equal(error.code, expectedExit, `${args[0]} failed\n${error.stdout}\n${error.stderr}`);
    return;
  }
  assert.equal(expectedExit, 0, `${args[0]} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`);
}

async function json(pilot, path, { status = 200, ...options } = {}) {
  const response = await pilot.request(path, { ...options, timeoutMs: 120_000 });
  const data = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data).slice(0, 1_000)}`);
  return data;
}

async function checkWorkspace(pilot) {
  const workspace = await json(pilot, '/workspace');
  const issues = new Map(workspace.issues.map(item => [item.title, item]));
  const pages = new Map(workspace.documents.map(item => [item.title, item]));
  assert.equal(issues.size, issueCount);
  assert.equal(pages.size, pageCount);
  for (const number of [2, Math.floor(issueCount / 2) + 1, issueCount]) {
    const predecessor = issues.get(issueTitle(number - 1));
    const successor = issues.get(issueTitle(number));
    assert.ok(predecessor && successor);
    const relations = await json(pilot, `/issues/${predecessor.id}/relations`);
    const relation = relations.find(item => item.sourceIssueId === predecessor.id && item.targetIssueId === successor.id);
    assert.equal(relation?.type, number % 2 ? 'Relates' : 'Blocks');
  }
  const links = new Set(workspace.resourceLinks.map(link => `${link.documentId}/${link.issueId}`));
  for (let number = 1; number <= pageCount; number++) {
    const page = pages.get(pageTitle(number));
    const issue = issues.get(issueTitle(number * 4));
    assert.ok(page && issue);
    assert.equal(page.parentId, number > 1 ? pages.get(pageTitle(pageParent(number)))?.id : null);
    assert.ok(links.has(`${page.id}/${issue.id}`), `Wiki page ${number} must link to Jira issue ${number * 4}`);
  }
  return { firstIssue: issues.get(issueTitle(jiraAttachmentInterval)).id, lastPage: pages.get(pageTitle(pageCount)).id };
}

async function checkAttachments(pilot, receipt, archives) {
  const result = await json(pilot, `/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`);
  for (const { input, bytes, files } of archives) {
    const fileRows = result.attachments.filter(row => row.product === input.product);
    const archiveHash = digest(bytes);
    assert.equal(fileRows.length, files.size);
    for (const row of fileRows) {
      assert.equal(row.packageSha256, archiveHash);
      assert.equal(row.status, 'verified');
      assert.equal(row.size, attachmentBytes);
      assert.equal(row.sha256, files.get(row.sourceId));
      const download = await pilot.request(`/attachment-versions/${row.fileId}/download`);
      assert.equal(download.status, 200);
      assert.equal(digest(Buffer.from(await download.arrayBuffer())), row.sha256);
    }
  }
}

test('mixed Jira and Confluence migration at team backlog scale survives a physical restore', { timeout: 300_000 }, async t => {
  const started = performance.now();
  const scratch = await mkdtemp(join(tmpdir(), 'teamspace-migration-scale-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'run');
  const manifest = join(scratch, 'manifest.json');
  const profilePath = join(scratch, 'profile.json');
  const archives = [jiraArchive(), confluenceArchive()];
  for (const { bytes, input } of archives) await writeFile(join(scratch, input.file), bytes);
  await writeFile(manifest, JSON.stringify({ packages: archives.map(({ input }) => input) }));

  await runRehearsal(['profile', manifest, profilePath], 2);
  const profileRaw = await readFile(profilePath);
  const profile = JSON.parse(profileRaw);
  assert.equal(profile.status, 'review');
  assert.deepEqual(profile.packages.map(pkg => pkg.analysis.diagnostics.filter(item => item.severity !== 'info')
    .map(({ code, count }) => [code, count])), [[], [['CONFLUENCE_TIMEZONE_UNKNOWN', 1], ['MISSING_REFERENCE', pageCount]]]);
  assert.deepEqual(profile.packages.map(item => [item.sha256, item.size]), archives.map(({ bytes }) => [digest(bytes), bytes.length]));
  assert.equal(profile.packages[0].analysis.counts.issue, issueCount);
  assert.equal(profile.packages[1].analysis.counts.page, pageCount);
  await runRehearsal(['stage', manifest, root, '--profile', profilePath], 0);
  const staged = JSON.parse(await readFile(join(root, 'stage.json')));
  assert.equal(staged.profile.sha256, digest(profileRaw));

  const expected = { issues: issueCount, documents: pageCount, issueRelations: issueCount - 1, resourceLinks: pageCount,
    comments: issueCount / commentInterval, worklogs: issueCount / worklogInterval,
    attachmentVersions: issueCount / jiraAttachmentInterval + pageCount / wikiAttachmentInterval };
  const source = await startRehearsalPilot(join(root, 'workspace'));
  let original, importedReceipt;
  try {
    const { users: [actor] } = await json(source, '/workspace');
    const headers = { 'X-Actor-Id': actor.id };
    const query = new URLSearchParams(staged.packages.map(item => ['packageId', item.packageId]));
    const { defaultConfiguration: configuration, identities } = await json(source, `/migrations/options?${query}`, { headers });
    configuration.projects = configuration.projects.map(project => ({ ...project, key: 'SCALE', name: 'Synthetic migration scale' }));
    configuration.timezone = 'Asia/Seoul';
    for (const sourceValue of ['fixture-jira-user', 'fixture-wiki-user']) {
      const identity = identities.find(item => item.sourceValue === sourceValue);
      assert.ok(identity);
      configuration.users[identity.id] = actor.id;
    }
    const preview = await json(source, '/migrations/preview', { method: 'POST', status: 201, headers, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices.slice(0, 10)));
    for (const [key, count] of Object.entries(expected)) assert.equal(preview.counts[key], count, key);
    const applied = await json(source, `/migrations/previews/${preview.id}/apply`, { method: 'POST', status: 201, headers,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } });
    importedReceipt = applied.import;
    original = await checkWorkspace(source);
    await checkAttachments(source, importedReceipt, archives);
  } finally { await source.close(); }

  await runRehearsal(['verify', root], 2); // Reproducing legacy project and space permissions remains a review item.
  const attempts = (await readdir(root)).filter(name => name.startsWith('verification-'));
  assert.equal(attempts.length, 1);
  const attempt = join(root, attempts[0]);
  const report = JSON.parse(await readFile(join(attempt, 'report.json')));
  assert.deepEqual(report.comparison, { status: 'review', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true });
  for (const observation of [report.source, report.restore]) {
    assert.deepEqual(observation.bundles, staged.packages.map(({ packageId }) => ({ packageId, status: 'verified' })));
    const { workspace, checks, receipts } = observation.evidence;
    assert.equal(workspace.counts.issues, issueCount);
    assert.equal(workspace.counts.documents, pageCount);
    assert.deepEqual(Object.entries(checks).filter(([, count]) => count !== 0), [['receiptsWithWarnings', 1]]);
    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    assert.equal(receipt.id, importedReceipt.id);
    assert.deepEqual(receipt.notices.filter(notice => notice.severity !== 'info').map(notice => notice.code),
      ['COMMENT_FORMAT_PLAIN_TEXT', 'ISSUE_DESCRIPTION_PLAIN_TEXT', 'PROJECT_ACCESS_NOT_REPRODUCED', 'WORKFLOW_RULES_NOT_REPRODUCED']);
    assert.deepEqual(receipt.attachmentCounts, { verified: expected.attachmentVersions, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0 });
    for (const [kind, count] of [['issue', issueCount], ['page', pageCount]]) {
      const primary = receipt.primaryRecords.find(item => item.kind === kind);
      assert.deepEqual(primary?.records, { expected: count, observed: count });
      assert.equal(primary.counts.linked, count);
      assert.equal(primary.invalidTargets, 0);
    }
    for (const kind of ['comments', 'worklogs', 'issueRelations']) assert.equal(receipt.targetContent[kind].count, expected[kind]);
  }
  const restored = await startRehearsalPilot(join(attempt, 'restored'));
  try {
    assert.deepEqual(await checkWorkspace(restored), original);
    const { receipts: [receipt] } = report.restore.evidence;
    await checkAttachments(restored, receipt, archives);
  }
  finally { await restored.close(); }
  const totalMiB = profile.totals.bytes / (1024 * 1024);
  t.diagnostic(`${issueCount} Jira issues, ${expected.issueRelations} relations, ${pageCount} Confluence pages and ${expected.attachmentVersions} attachments (${totalMiB.toFixed(1)} MiB of archives) restored in ${((performance.now() - started) / 1000).toFixed(1)}s`);
});
