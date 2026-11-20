import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startRehearsalPilot } from '../../scripts/pilot-migration-runtime.mjs';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const date = '2020-03-01T00:00:00Z';
const privateTitle = 'synthetic-private-issue-title';
const privateRelatedTitle = 'synthetic-private-related-issue-title';
const privateRelease = 'synthetic-private-release-name';
const privateSprint = 'synthetic-private-sprint-name';
const privateBody = 'synthetic-private-document-body';
const privateJiraComment = 'synthetic-private-jira-comment';
const privateConfluenceComment = 'synthetic-private-confluence-comment';
const privateRevision = 'synthetic-private-historical-document-body';
const privateWorklog = 'synthetic-private-worklog-note';
const privateOldStatus = 'synthetic-private-previous-status';
const jiraAuthor = 'synthetic-jira-author-key';
const privateJiraDisplayName = 'Migration fixture Jira author';
const confluenceAuthor = 'synthetic-confluence-author-key';
const confluenceGroup = 'synthetic-private-confluence-group';
const originalFrom = 'synthetic-source-instance';
const attachment = Buffer.from('synthetic source attachment\0');

function fixturePackages() {
  const jira = zip([
    { path: 'entities.xml', bytes: Buffer.from(`<entity-engine-xml>
      <ApplicationUser id="21" userKey="${jiraAuthor}" lowerUserName="audit-jira-user"/>
      <User id="22" userName="audit-jira-user" displayName="${privateJiraDisplayName}" active="1"/>
      <Project id="10" pkey="SRC" name="Jira fixture"/><Status id="1" pname="Open"/><IssueType id="2" pname="Task"/>
      <Issue id="100" project="10" number="1" summary="${privateTitle}" status="1" issuetype="2" created="${date}" updated="${date}"/>
      <Issue id="101" project="10" number="2" summary="${privateRelatedTitle}" status="1" issuetype="2" created="${date}" updated="${date}"/>
      <Version id="13" project="10" vname="${privateRelease}" releasedate="2020-03-08" released="true"/>
      <NodeAssociation sourceNodeId="100" sourceNodeEntity="Issue" sinkNodeId="13" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
      <CustomField id="70" cfname="Sprint" customfieldtypekey="com.pyxis.greenhopper.jira:gh-sprint"/>
      <CustomFieldValue id="71" issue="100" customfield="70" stringvalue="14"/>
      <IssueLinkType id="600" linkname="Blocks" inward="is blocked by" outward="blocks"/>
      <IssueLink id="601" linktype="600" source="100" destination="101"/>
      <ChangeGroup id="320" issue="100" author="audit-jira-user" created="2020-03-02T09:15:00+0900"/>
      <ChangeItem id="321" group="320" fieldtype="jira" field="status" oldvalue="2" oldstring="${privateOldStatus}" newvalue="1" newstring="Open"/>
      <ChangeItem id="322" group="320" fieldtype="jira" field="summary" oldstring="Earlier title" newstring="${privateTitle}"/>
      <Action id="400" issue="100" author="audit-jira-user" type="comment" created="${date}" body="${privateJiraComment}"/>
      <Worklog id="500" issue="100" author="audit-jira-user" startdate="${date}" timeworked="91" created="${date}" updated="${date}" body="${privateWorklog}"/>
      <FileAttachment id="700" issue="100" filename="original.bin" filesize="${attachment.length}" created="${date}"/>
    </entity-engine-xml>`) },
    { path: 'activeobjects.xml', bytes: Buffer.from(`<backup><data tableName="AO_60DB71_SPRINT">
      <column name="ID"/><column name="NAME"/><column name="STARTED"/><column name="CLOSED"/>
      <column name="START_DATE"/><column name="END_DATE"/>
      <row><integer>14</integer><string>${privateSprint}</string><boolean>true</boolean><boolean>false</boolean>
        <long>${Date.parse(date)}</long><long>${Date.parse('2020-03-10T00:00:00Z')}</long></row>
    </data></backup>`) },
    { path: 'attachments/SRC/SRC-1/700', bytes: attachment },
  ]);
  const confluence = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id><property name="name">audit-wiki-user</property>
      <property name="displayName">Migration fixture Confluence author</property></object>
    <object class="Space"><id name="id">20</id><property name="key">WIKI</property><property name="name">Confluence fixture</property></object>
    <object class="SpacePermission"><id name="id">21</id><property name="type">VIEWSPACE</property>
      <property name="groupName">${confluenceGroup}</property><property name="space" class="Space"><id name="id">20</id></property></object>
    <object class="Page"><id name="id">200</id><property name="title">Original page</property><property name="version">2</property>
      <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id></property>
      <collection name="historicalVersions"><element class="Page"><id name="id">201</id></element></collection></object>
    <object class="Page"><id name="id">201</id><property name="title">Historical page</property><property name="version">1</property>
      <property name="contentStatus">historical</property><property name="originalVersion" class="Page"><id name="id">200</id></property>
      <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id></property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>${privateBody}</p>]]></property>
      <property name="content" class="Page"><id name="id">200</id></property></object>
    <object class="BodyContent"><id name="id">301</id><property name="body"><![CDATA[<p>${privateRevision}</p>]]></property>
      <property name="content" class="Page"><id name="id">201</id></property></object>
    <object class="Comment"><id name="id">400</id><property name="containerContent" class="Page"><id name="id">200</id></property>
      <property name="creationDate">${date}</property><property name="creator" class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id></property></object>
    <object class="BodyContent"><id name="id">401</id><property name="body"><![CDATA[<p>${privateConfluenceComment}</p>]]></property>
      <property name="content" class="Comment"><id name="id">400</id></property></object>
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
  for (const value of [root, privateTitle, privateRelatedTitle, privateRelease, privateSprint, privateBody, privateJiraComment, privateConfluenceComment,
    privateRevision, privateWorklog, privateOldStatus, jiraAuthor, privateJiraDisplayName, confluenceAuthor, confluenceGroup, originalFrom,
    'private-wiki.zip', 'private-jira.zip', attachment.toString()]) {
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
  let importedIssueId, importedStatusHistory;
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
    const { defaultConfiguration: configuration, identities } = await json(base, `/migrations/options?${query}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key: 'REH', name: 'Rehearsal fixture' }));
    configuration.sourceBaseUrls = Object.fromEntries(staged.packages.map(pkg => [pkg.packageId, `https://${pkg.product}.example.invalid`]));
    for (const sourceValue of [jiraAuthor, confluenceAuthor]) {
      const identity = identities.find(value => value.sourceValue === sourceValue);
      assert.ok(identity, `Fixture author ${sourceValue} was not analyzed`);
      configuration.users[identity.id] = actor;
    }
    const preview = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    assert.equal(preview.counts.issues, 2);
    assert.equal(preview.counts.documents, 1);
    assert.equal(preview.counts.comments, 2);
    assert.equal(preview.counts.revisions, 2);
    assert.equal(preview.counts.worklogs, 1);
    assert.equal(preview.counts.issueRelations, 1);
    assert.equal(preview.counts.jiraReleases, 1);
    assert.equal(preview.counts.jiraReleaseLinks, 1);
    assert.equal(preview.counts.jiraSprints, 1);
    assert.equal(preview.counts.jiraSprintLinks, 1);
    assert.ok(preview.requiredAcknowledgements.includes('SOURCE_CONFLUENCE_SPACE_PERMISSION_REVIEW'));
    await json(base, `/migrations/previews/${preview.id}/apply`, { method: 'POST', actor, status: 201,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } });
    const imported = await json(base, '/workspace');
    const issue = imported.issues.find(value => value.title === privateTitle);
    const related = imported.issues.find(value => value.title === privateRelatedTitle);
    const [document] = imported.documents;
    assert.ok(issue && related && document);
    assert.equal(imported.planningItems.length, 2);
    const release = imported.planningItems.find(item => item.kind === 'release');
    const sprint = imported.planningItems.find(item => item.kind === 'cycle');
    assert.deepEqual([release?.name, release?.targetDate, issue.releaseId], [privateRelease, '2020-03-08', release?.id]);
    assert.deepEqual([sprint?.name, sprint?.startDate, sprint?.endDate, sprint?.status, issue.cycleId],
      [privateSprint, '2020-03-01', '2020-03-10', 'active', sprint?.id]);
    const [jiraComments, wikiComments, revisions, worklogs, relations, statusHistory] = await Promise.all([
      json(base, `/comments?resourceType=issue&resourceId=${issue.id}`),
      json(base, `/comments?resourceType=document&resourceId=${document.id}`),
      json(base, `/documents/${document.id}/revisions`),
      json(base, `/issues/${issue.id}/worklogs`),
      json(base, `/issues/${issue.id}/relations`),
      json(base, `/issues/${issue.id}/jira-status-history`),
    ]);
    assert.deepEqual(jiraComments.map(({ body, authorId }) => [body, authorId]), [[privateJiraComment, actor]]);
    assert.deepEqual(wikiComments.map(({ body, authorId }) => [body, authorId]), [[privateConfluenceComment, actor]]);
    assert.deepEqual(revisions.sort((left, right) => left.version - right.version)
      .map(({ version, title, plainText, authorId }) => [version, title, plainText, authorId]), [
      [1, 'Historical page', privateRevision, actor],
      [2, 'Original page', privateBody, actor],
    ]);
    assert.deepEqual(worklogs.entries.map(({ note, durationSeconds, authorId }) => [note, durationSeconds, authorId]), [[privateWorklog, 91, actor]]);
    assert.deepEqual(relations.map(({ sourceIssueId, targetIssueId, type }) => [sourceIssueId, targetIssueId, type]), [[issue.id, related.id, 'Blocks']]);
    assert.equal(statusHistory.total, 1);
    assert.deepEqual(statusHistory.entries.map(({ from, to, changedAt, originalAuthorName }) => [from, to, changedAt, originalAuthorName]), [
      [{ id: '2', label: privateOldStatus }, { id: '1', label: 'Open' }, '2020-03-02T00:15:00.000Z', privateJiraDisplayName],
    ]);
    importedIssueId = issue.id;
    importedStatusHistory = statusHistory;
  } finally {
    review.child.kill('SIGINT');
    const stopped = await review.exited;
    assert.equal(stopped.code, 130, stopped.stderr);
  }

  const requiresReview = await launch(['verify', root], env).exited;
  assert.equal(requiresReview.code, 2, requiresReview.stderr);
  const { attempt, report } = await readReport(root, requiresReview);
  assert.equal(report.status, 'review');
  assert.equal(report.source.evidence.checks.pendingPackages, 0);
  assert.equal(report.source.evidence.checks.receiptsWithWarnings, 1);
  assert.equal(report.source.evidence.receipts.length, 1);
  const [receipt] = report.source.evidence.receipts;
  assert.deepEqual(report.source.evidence.packages.map(pkg => pkg.receiptIds), [[receipt.id], [receipt.id]]);
  assert.equal(receipt.noticesAvailable, true);
  assert.equal(receipt.attachmentCounts.verified, 1);
  assert.deepEqual(receipt.notices.find(notice => notice.code === 'SOURCE_CONFLUENCE_SPACE_PERMISSION_REVIEW'),
    { severity: 'warning', code: 'SOURCE_CONFLUENCE_SPACE_PERMISSION_REVIEW', count: 1 });
  const { targetContent } = receipt;
  assert.equal(targetContent.version, 1);
  for (const [section, count] of Object.entries({ comments: 2, revisions: 2, worklogs: 1, issueRelations: 1 })) {
    assert.equal(targetContent[section].count, count);
    assert.match(targetContent[section].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(targetContent[section]).sort(), ['count', 'sha256']);
  }
  assert.deepEqual(report.restore.evidence.receipts[0].targetContent, targetContent);
  const { jiraStatusHistory } = receipt;
  assert.match(jiraStatusHistory.projected.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(jiraStatusHistory, {
    sourceChanges: 1, projected: { count: 1, sha256: jiraStatusHistory.projected.sha256 }, duplicate: 0, excluded: 0,
    restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0,
  });
  assert.deepEqual(report.restore.evidence.receipts[0].jiraStatusHistory, jiraStatusHistory);
  assert.equal(report.source.evidence.checks.receiptsWithJiraHistoryReview, 0);
  assert.equal(report.source.evidence.workspace.counts.issues, 2);
  assert.equal(report.source.evidence.workspace.counts.documents, 1);
  assert.equal(report.source.evidence.workspace.counts.planningItems, 2);
  assert.equal(report.comparison.status, 'review');
  assert.equal(report.comparison.matches, true);
  assert.deepEqual(report.source.bundles, report.restore.bundles);
  assert.ok(existsSync(join(attempt, 'backup', 'manifest.json')));
  assert.ok(existsSync(join(attempt, 'restored', 'teamspace.sqlite')));
  const restored = await startRehearsalPilot(join(attempt, 'restored'));
  try {
    assert.deepEqual(await json(restored.url, `/issues/${importedIssueId}/jira-status-history`), importedStatusHistory);
  } finally {
    await restored.close();
  }

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
