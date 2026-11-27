import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
const privateChecklistItem = 'synthetic-private-checklist-item';
const checklistDue = '2026-11-28';
const privateJiraComment = 'synthetic-private-jira-comment';
const privateConfluenceComment = 'synthetic-private-confluence-comment';
const privateRevision = 'synthetic-private-historical-document-body';
const privateWorklog = 'synthetic-private-worklog-note';
const privateOldStatus = 'synthetic-private-previous-status';
const privateOtherStatus = 'synthetic-private-other-status';
const jiraAuthor = 'synthetic-jira-author-key';
const privateJiraDisplayName = 'Migration fixture Jira author';
const confluenceAuthor = 'synthetic-confluence-author-key';
const confluenceGroup = 'synthetic-private-confluence-group';
const restrictedPage = '280206';
const restrictedDescendant = '280207';
const missingPage = '98315877000281463247';
const restrictedTitle = 'synthetic-private-confluence-restricted-title';
const restrictedBody = 'synthetic-private-confluence-restricted-body';
const originalFrom = 'synthetic-source-instance';
const attachment = Buffer.from('synthetic source attachment\0');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rehearsalState = workspace => join(workspace, '.donefac-rehearsal');

function confluenceFindings(bytes, changes = {}) {
  return {
    format: 'donefac-confluence-audit-findings',
    version: 1,
    checkedAt: '2026-11-23T02:00:00.000Z',
    selection: 'explicit-pages',
    status: 'needs-review',
    archive: { sha256: digest(bytes), bytes: bytes.length },
    spacePermissions: 'manual-review',
    unidentifiedPages: 0,
    findings: [
      { pageId: '200', codes: ['VERSION_MISMATCH'] },
      { pageId: restrictedPage, codes: ['LIVE_RESTRICTED', 'RESTRICTION_MISMATCH'] },
      { pageId: restrictedDescendant, codes: ['LIVE_RESTRICTED'] },
      { pageId: missingPage, codes: ['MISSING_FROM_ARCHIVE'] },
    ],
    ...changes,
  };
}

function fixturePackages({ crossLink = false } = {}) {
  const remoteLink = crossLink ? `<RemoteIssueLink id="602" issueid="100" title="Runbook"
    url="https://confluence.example.invalid/pages/viewpage.action?pageId=200"/>` : '';
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
      ${remoteLink}
      <ChangeGroup id="320" issue="100" author="audit-jira-user" created="2020-03-02T09:15:00+0900"/>
      <ChangeItem id="321" group="320" fieldtype="jira" field="status" oldvalue="2" oldstring="${privateOldStatus}" newvalue="1" newstring="Open"/>
      <ChangeItem id="322" group="320" fieldtype="jira" field="summary" oldstring="Earlier title" newstring="${privateTitle}"/>
      <ChangeGroup id="323" issue="101" created="18/Mar/20 10:20 AM"/>
      <ChangeItem id="324" group="323" fieldtype="jira" field="status" oldvalue="2" oldstring="${privateOtherStatus}" newvalue="1" newstring="Open"/>
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
    <object class="Page"><id name="id">${restrictedPage}</id><property name="title">${restrictedTitle}</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id></property></object>
    <object class="Page"><id name="id">${restrictedDescendant}</id><property name="title">${restrictedTitle} child</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">20</id></property><property name="creationDate">${date}</property>
      <property name="creator" class="ConfluenceUserImpl"><id name="key">${confluenceAuthor}</id></property>
      <property name="parent" class="Page"><id name="id">${restrictedPage}</id></property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>${privateBody}</p><ac:task-list>
      <ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><ac:link><ri:user ri:userkey="${confluenceAuthor}"/></ac:link> ${privateChecklistItem} <time datetime="${checklistDue}"/></ac:task-body></ac:task>
    </ac:task-list>]]></property>
      <property name="content" class="Page"><id name="id">200</id></property></object>
    <object class="BodyContent"><id name="id">301</id><property name="body"><![CDATA[<p>${privateRevision}</p>]]></property>
      <property name="content" class="Page"><id name="id">201</id></property></object>
    <object class="BodyContent"><id name="id">302</id><property name="body"><![CDATA[<p>${restrictedBody}</p>]]></property>
      <property name="content" class="Page"><id name="id">${restrictedPage}</id></property></object>
    <object class="BodyContent"><id name="id">303</id><property name="body"><![CDATA[<p>${restrictedBody} child</p>]]></property>
      <property name="content" class="Page"><id name="id">${restrictedDescendant}</id></property></object>
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

function jiraFindingsPath(receipt, finding, fingerprint) {
  const query = new URLSearchParams({ expectedVersion: String(receipt.version), finding });
  if (fingerprint) query.set('expectedFingerprint', fingerprint);
  return `/source-imports/${receipt.id}/reconciliation/jira-status-findings?${query}`;
}

async function readReport(root, answer) {
  const match = /검증 결과 ((?:\.\.\/)?verification-[a-z\d]+\/report\.json) \(/i.exec(answer.stdout);
  assert.ok(match, answer.stdout + answer.stderr);
  const path = join(root, match[1]);
  const raw = await readFile(path, 'utf8');
  for (const value of [root, privateTitle, privateRelatedTitle, privateRelease, privateSprint, privateBody, privateJiraComment, privateConfluenceComment,
    privateRevision, privateWorklog, privateOldStatus, privateOtherStatus, jiraAuthor, privateJiraDisplayName, confluenceAuthor, confluenceGroup, originalFrom,
    privateChecklistItem, restrictedTitle, restrictedBody, missingPage, '"pageId"',
    'private-wiki.zip', 'private-jira.zip', attachment.toString()]) {
    assert.equal(raw.includes(value), false);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  return { attempt: join(path, '..'), report: JSON.parse(raw) };
}

test('migration rehearsal startup keeps due records unchanged', { timeout: 60_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-due-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, 'workspace');
  const initial = await startRehearsalPilot(workspace);
  const ruleId = randomUUID();
  let actor, projectId, issueId;
  try {
    const user = await json(initial.url, '/users', { method: 'POST', status: 201,
      body: { name: 'Rehearsal worker fixture', email: 'worker-fixture@example.invalid' } });
    actor = user.id;
    const project = await json(initial.url, '/projects', { method: 'POST', actor, status: 201,
      body: { key: 'DUE', name: 'Rehearsal worker fixture' } });
    projectId = project.id;
    await json(initial.url, '/notifications/deadline-reminders', { method: 'PUT', actor,
      body: { daysBefore: 0, onDueDate: false, overdue: true, expectedVersion: null } });
    const issue = await json(initial.url, '/issues', { method: 'POST', actor, status: 201,
      body: { projectId, title: 'Existing overdue issue', assigneeId: actor, dueDate: '2020-03-01' } });
    issueId = issue.id;
    const template = await json(initial.url, `/projects/${projectId}/issue-templates`, { method: 'POST', actor, status: 201,
      body: { name: 'Recurring template', defaults: { title: 'Scheduled issue', description: '', descriptionFormat: 'markdown',
        type: '작업', priority: 'medium', labels: [], customFields: {} } } });
    await json(initial.url, `/projects/${projectId}/recurring-issues`, { method: 'POST', actor, status: 201,
      body: { name: 'Weekly issue', templateId: template.id, weekday: 1, time: '09:00', enabled: true,
        assigneeId: actor, requestId: ruleId } });
  } finally { await initial.close(); }

  // Leave an elapsed weekly slot in the closed workspace without waiting for its schedule.
  const nextRunAt = '2020-03-02T00:00:00.000Z';
  const createdAt = '2020-03-01T00:00:00.000Z';
  const database = new DatabaseSync(join(workspace, 'donefac.sqlite'));
  try {
    const result = database.prepare(`UPDATE recurring_issue_rules SET next_run_at=?,
      json=json_set(json,'$.nextRunAt',?,'$.createdAt',?,'$.updatedAt',?) WHERE id=?`)
      .run(nextRunAt, nextRunAt, createdAt, createdAt, ruleId);
    assert.equal(result.changes, 1);
  } finally { database.close(); }

  const review = await startRehearsalPilot(workspace);
  try {
    const [rules, { issues }, { items }] = await Promise.all([
      json(review.url, `/projects/${projectId}/recurring-issues`),
      json(review.url, '/workspace'),
      json(review.url, '/notifications', { actor }),
    ]);
    assert.deepEqual({
      rule: rules.map(rule => ({ id: rule.id, nextRunAt: rule.nextRunAt, runs: rule.recentRuns.length })),
      issues: issues.map(issue => issue.id),
      reminders: items.filter(item => item.kind === 'issue-deadline-overdue').map(item => item.targetId),
    }, { rule: [{ id: ruleId, nextRunAt, runs: 0 }], issues: [issueId], reminders: [] });
  } finally { await review.close(); }
});

test('migration rehearsal binds Confluence reviews to profiled exports and checks receipts after cold restore', { timeout: 150_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-e2e-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, DONEFAC_DATA_DIR: join(scratch, 'other-workspace'), DONEFAC_PILOT_ACCESS_FILE: join(scratch, 'absent-key'),
    DONEFAC_PILOT_ORIGIN: 'https://rehearsal.example.invalid', DONEFAC_JIRA_BASE_URL: 'https://source.example.invalid' };
  const manifest = join(scratch, 'manifest.json'), root = join(scratch, 'run'), profilePath = join(scratch, 'profile.json');
  const packages = fixturePackages({ crossLink: true });
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
  const profiled = await launch(['profile', manifest, profilePath], env).exited;
  assert.equal(profiled.code, 2, profiled.stdout + profiled.stderr);
  const profileBytes = await readFile(profilePath);
  const profile = JSON.parse(profileBytes);
  assert.equal(profile.version, 2);
  assert.equal(profile.status, 'review');
  const expectedProfileProof = { version: 2, status: 'review', checkedAt: profile.checkedAt, sha256: digest(profileBytes) };

  const movedFile = 'relocated-jira.zip';
  await rename(join(scratch, input.packages[0].file), join(scratch, movedFile));
  input.packages[0] = { ...input.packages[0], file: movedFile, instanceKey: ` ${input.packages[0].instanceKey} ` };
  await writeFile(manifest, JSON.stringify(input));
  const wikiBytes = packages.find(item => item.product === 'confluence').bytes;
  const partialCoverage = { archivePages: 3, matchedPages: 1, permissionCheckedPages: 1, outsideSelectionPages: 2,
    otherSpacePages: 0, unassignedPages: 0 };
  const reviewInputs = [confluenceFindings(wikiBytes), confluenceFindings(wikiBytes, {
    version: 2, status: 'matched', findings: [], coverage: partialCoverage,
  })];
  const paths = [join(scratch, 'private-page-findings.json'), join(scratch, 'private-empty-findings.json')];
  const reportBytes = reviewInputs.map(value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  const reviewDigests = reportBytes.map(digest);
  for (const [index, path] of paths.entries()) await writeFile(path, reportBytes[index]);
  const stageArguments = ['stage', manifest, root, '--confluence-findings', paths[0], '--profile', profilePath,
    '--confluence-findings', paths[1]];
  const stage = await launch(stageArguments, env).exited;
  assert.equal(stage.code, 0, stage.stderr);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(existsSync(env.DONEFAC_DATA_DIR), false);
  const stateDirectory = rehearsalState(join(root, 'workspace'));
  const stagePath = join(stateDirectory, 'stage.json');
  const initial = await readFile(stagePath, 'utf8');
  const staged = JSON.parse(initial);
  assert.deepEqual(staged.profile, expectedProfileProof);
  assert.equal(staged.confluenceReviews.length, 2);
  assert.doesNotMatch(initial, /"pageId"|private-page-findings\.json|private-empty-findings\.json/);
  assert.equal(initial.includes(missingPage), false);
  assert.deepEqual(staged.packages.map(pkg => pkg.product), ['jira', 'confluence']);
  assert.deepEqual(staged.packages.map(pkg => [pkg.sha256, pkg.size, pkg.format]),
    profile.packages.map(pkg => [pkg.sha256, pkg.size, pkg.analysis.format]));
  assert.equal(staged.packages[0].instanceKey, `${originalFrom}-jira`);
  assert.equal((await stat(stagePath)).mode & 0o777, 0o600);
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await launch(stageArguments, env).exited).code, 1);
  assert.equal(await readFile(stagePath, 'utf8'), initial);
  const wikiId = staged.packages[1].packageId;
  const expectedReviews = reviewInputs.map(({ checkedAt, selection, status, spacePermissions, unidentifiedPages, findings, coverage }) => ({
    packageId: wikiId, checkedAt, selection, status, spacePermissions, findingsPages: findings.length, unidentifiedPages,
    ...(coverage ? { coverage } : {}),
  }));
  const optionsPath = packageId => `/migrations/options?${new URLSearchParams({ packageId })}`;
  for (const [index, reportSha] of reviewDigests.entries()) {
    const proof = staged.confluenceReviews.find(value => value.sha256 === reportSha);
    const { status, selection, checkedAt, archive, spacePermissions, unidentifiedPages, findings, version, coverage } = reviewInputs[index];
    assert.deepEqual(proof, { packageId: wikiId, sha256: reportSha, checkedAt, version, selection, status, archive,
      spacePermissions, pageCount: findings.length, unidentifiedPages,
      reasonCounts: index === 0 ? { LIVE_RESTRICTED: 2, MISSING_FROM_ARCHIVE: 1, RESTRICTION_MISMATCH: 1, VERSION_MISMATCH: 1 } : {},
      ...(coverage ? { coverage } : {}) });
    const snapshot = join(stateDirectory, 'confluence-findings', `${reportSha}.json`);
    assert.deepEqual(await readFile(snapshot), reportBytes[index]);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    await rm(paths[index]);
  }
  const reviewSnapshot = join(stateDirectory, 'confluence-findings', `${reviewDigests[0]}.json`);
  await rm(reviewSnapshot);
  const missingSnapshot = await launch(['review', root], env).exited;
  assert.equal(missingSnapshot.code, 1, missingSnapshot.stderr);
  assert.doesNotMatch(missingSnapshot.stdout, /이관 검토 주소/);
  await writeFile(reviewSnapshot, Buffer.concat([reportBytes[0], Buffer.from('\n')]), { mode: 0o600 });
  const changedSnapshot = await launch(['verify', root], env).exited;
  assert.equal(changedSnapshot.code, 1, changedSnapshot.stderr);
  assert.doesNotMatch(changedSnapshot.stdout, /검증 결과/);
  assert.equal((missingSnapshot.stderr + changedSnapshot.stderr).includes(missingPage), false);
  await writeFile(reviewSnapshot, reportBytes[0]);

  const differentCoverage = structuredClone(staged);
  differentCoverage.confluenceReviews[1].coverage.archivePages++;
  differentCoverage.confluenceReviews[1].coverage.outsideSelectionPages++;
  await writeFile(stagePath, JSON.stringify(differentCoverage));
  const mismatchedCoverage = await launch(['review', root], env).exited;
  assert.equal(mismatchedCoverage.code, 1);
  assert.match(mismatchedCoverage.stderr, /보관한 Confluence 페이지별 검토 파일과 리허설 기록이 다릅니다/);
  assert.doesNotMatch(mismatchedCoverage.stdout, /이관 검토 주소/);

  const differentInstance = structuredClone(staged);
  differentInstance.packages[1].instanceKey = 'incorrect-confluence-instance';
  await writeFile(stagePath, JSON.stringify(differentInstance));
  const mismatchedInstance = await launch(['review', root], env).exited;
  assert.equal(mismatchedInstance.code, 1, mismatchedInstance.stderr);
  assert.match(mismatchedInstance.stderr, /분석 기록과 원본 인스턴스가 일치하지 않습니다/);
  assert.doesNotMatch(mismatchedInstance.stdout, /이관 검토 주소/);
  await writeFile(stagePath, initial);

  const mappingSourceRoot = join(scratch, 'mapping-source');
  const mappingStage = await launch(['stage', manifest, mappingSourceRoot], env).exited;
  assert.equal(mappingStage.code, 0, mappingStage.stderr);
  const mappingReview = launch(['review', mappingSourceRoot], env);
  const mappingPath = join(scratch, 'mapping.json');
  let previousActor;
  try {
    const base = await waitForReview(mappingReview);
    const workspace = await json(base, '/workspace');
    previousActor = workspace.users[0].id;
    const mappingStageState = JSON.parse(await readFile(join(rehearsalState(join(mappingSourceRoot, 'workspace')), 'stage.json'), 'utf8'));
    const query = new URLSearchParams(mappingStageState.packages.map(pkg => ['packageId', pkg.packageId]));
    const { defaultConfiguration: configuration, identities } = await json(base, `/migrations/options?${query}`);
    configuration.projects = configuration.projects.map(project => ({ ...project, key: 'REH', name: 'Rehearsal fixture' }));
    configuration.sourceBaseUrls = Object.fromEntries(mappingStageState.packages.map(pkg => [pkg.packageId, `https://${pkg.product}.example.invalid`]));
    const mappedWiki = mappingStageState.packages.find(pkg => pkg.product === 'confluence');
    configuration.excludedRecords = [`${mappedWiki.packageId}/page:${restrictedPage}`];
    for (const sourceValue of [jiraAuthor, confluenceAuthor]) {
      const identity = identities.find(value => value.sourceValue === sourceValue);
      assert.ok(identity, `Fixture author ${sourceValue} was not analyzed`);
      configuration.users[identity.id] = previousActor;
    }
    const mapping = await json(base, '/migrations/mapping/export', { method: 'POST', actor: previousActor, body: { configuration } });
    const raw = JSON.stringify(mapping);
    for (const value of [workspace.users[0].email, privateTitle, privateBody, privateWorklog, jiraAuthor, confluenceAuthor]) {
      assert.equal(raw.includes(value), false);
    }
    await writeFile(mappingPath, raw, { mode: 0o600 });
  } finally {
    mappingReview.child.kill('SIGTERM');
    await mappingReview.exited;
  }

  const workspacePath = join(root, 'workspace');
  const pending = await launch(['verify', workspacePath], env).exited;
  assert.equal(pending.code, 2, pending.stderr);
  assert.match(pending.stdout, /검증 결과 \.\.\/verification-/);
  const pendingEvidence = (await readReport(workspacePath, pending)).report;
  assert.equal(pendingEvidence.status, 'review');
  assert.deepEqual(pendingEvidence.profile, expectedProfileProof);
  assert.deepEqual(pendingEvidence.confluenceReviews, staged.confluenceReviews);
  assert.equal(pendingEvidence.source.evidence.checks.pendingPackages, 2);
  assert.equal(pendingEvidence.restore, null);

  const review = launch(['review', root], env);
  let importedIssueId, importedStatusHistory, importedReceipt, importedRelated, importedFinding, importedDocument, importedLink, otherDocumentId;
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
    assert.notEqual(actor, previousActor);
    assert.equal(workspace.issues.length + workspace.documents.length, 0);
    const wikiOptions = await json(base, optionsPath(wikiId), { actor });
    assert.deepEqual(wikiOptions.confluenceReviews, expectedReviews);
    const jiraOptions = await json(base, optionsPath(staged.packages[0].packageId), { actor });
    assert.equal(Object.hasOwn(jiraOptions, 'confluenceReviews'), false);
    const cloneQuery = new URLSearchParams({ filename: 'same-bytes.zip', instanceKey: 'other-wiki-instance', product: 'confluence' });
    const cloneResponse = await fetch(`${base}/api/legacy-import/packages?${cloneQuery}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actor },
      body: wikiBytes, signal: AbortSignal.timeout(35_000),
    });
    assert.equal(cloneResponse.status, 201);
    const clone = await cloneResponse.json();
    assert.notEqual(clone.id, wikiId);
    assert.equal(clone.sha256, staged.packages[1].sha256);
    const cloneOptions = await json(base, optionsPath(clone.id), { actor });
    assert.equal(Object.hasOwn(cloneOptions, 'confluenceReviews'), false);
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
    const { options, configuration } = await json(base, '/migrations/mapping/import', { method: 'POST', actor, body: { mapping } });
    assert.deepEqual(options.confluenceReviews, expectedReviews);
    assert.deepEqual(configuration.packageIds, staged.packages.map(pkg => pkg.packageId));
    assert.deepEqual(configuration.excludedRecords, [`${wikiId}/page:${restrictedPage}`]);
    assert.ok(configuration.packageIds.every(id => !mapping.configuration.packageIds.includes(id)));
    assert.ok(configuration.projects.every(project => project.key === 'REH' && project.name === 'Rehearsal fixture'));
    for (const sourceValue of [jiraAuthor, confluenceAuthor]) {
      const identity = options.identities.find(value => value.sourceValue === sourceValue);
      assert.equal(configuration.users[identity.id], actor);
    }
    assert.deepEqual(await json(base, '/source-imports'), []);
    const preview = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration } });
    assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
    assert.equal(preview.counts.issues, 2);
    assert.equal(preview.counts.documents, 1);
    assert.equal(preview.counts.explicitExcludedRecords, 1);
    assert.equal(preview.counts.excludedDescendants, 1);
    assert.equal(preview.counts.comments, 2);
    assert.equal(preview.counts.revisions, 2);
    assert.equal(preview.counts.worklogs, 1);
    assert.equal(preview.counts.issueRelations, 1);
    assert.equal(preview.counts.resourceLinks, 1);
    assert.equal(preview.counts.jiraReleases, 1);
    assert.equal(preview.counts.jiraReleaseLinks, 1);
    assert.equal(preview.counts.jiraSprints, 1);
    assert.equal(preview.counts.jiraSprintLinks, 1);
    assert.ok(preview.requiredAcknowledgements.includes('SOURCE_CONFLUENCE_SPACE_PERMISSION_REVIEW'));
    const applied = await json(base, `/migrations/previews/${preview.id}/apply`, { method: 'POST', actor, status: 201,
      body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements } });
    const imported = await json(base, '/workspace');
    const issue = imported.issues.find(value => value.title === privateTitle);
    const related = imported.issues.find(value => value.title === privateRelatedTitle);
    const [document] = imported.documents;
    assert.ok(issue && related && document);
    assert.equal(imported.resourceLinks.length, 1);
    [importedLink] = imported.resourceLinks;
    assert.deepEqual(importedLink, { id: importedLink.id, issueId: issue.id, documentId: document.id, kind: 'related' });
    assert.deepEqual(imported.issueAliases[issue.id], [{ key: 'SRC-1', source: 'jira' }]);
    const resolve = url => json(base, `/atlassian-links/resolve?${new URLSearchParams({ url })}`);
    assert.deepEqual(await resolve('https://jira.example.invalid/browse/SRC-1'), { targets: [{ targetType: 'issue', targetId: issue.id }] });
    assert.deepEqual(await resolve('https://confluence.example.invalid/display/WIKI/Original%20page'),
      { targets: [{ targetType: 'document', targetId: document.id }] });
    const otherDocument = await json(base, '/documents', { method: 'POST', actor, status: 201,
      body: { projectId: document.projectId, title: 'Independent alias verification fixture' } });
    otherDocumentId = otherDocument.id;
    assert.deepEqual(document.content.content.map(block => block.type), ['paragraph', 'taskList']);
    assert.equal(document.content.content[1].content[0].attrs.checked, true);
    const expectedDocumentText = `${privateBody}\n@${confluenceAuthor} ${privateChecklistItem} ${checklistDue}`;
    assert.equal(document.plainText, expectedDocumentText);
    importedDocument = document;
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
      [2, 'Original page', expectedDocumentText, actor],
    ]);
    assert.deepEqual(worklogs.entries.map(({ note, durationSeconds, authorId }) => [note, durationSeconds, authorId]), [[privateWorklog, 91, actor]]);
    assert.deepEqual(relations.map(({ sourceIssueId, targetIssueId, type }) => [sourceIssueId, targetIssueId, type]), [[issue.id, related.id, 'Blocks']]);
    assert.equal(statusHistory.total, 1);
    assert.deepEqual(statusHistory.entries.map(({ from, to, changedAt, originalAuthorName }) => [from, to, changedAt, originalAuthorName]), [
      [{ id: '2', label: privateOldStatus }, { id: '1', label: 'Open' }, '2020-03-02T00:15:00.000Z', privateJiraDisplayName],
    ]);
    importedIssueId = issue.id;
    importedStatusHistory = statusHistory;
    importedReceipt = applied.import;
    importedRelated = related;
    importedFinding = await json(base, jiraFindingsPath(importedReceipt, 'unresolved-time'));
    assert.match(importedFinding.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(importedFinding.total, 1);
    assert.equal(importedFinding.totalChanges, 1);
    const [row] = importedFinding.rows;
    assert.deepEqual(row, { sourceRecordId: row.sourceRecordId, sourceId: '323', sourceIssueId: '101', sourceInstance: `${originalFrom}-jira`,
      changeCount: 1, reason: null });
    const archive = await json(base, `/source-imports/${importedReceipt.id}/records/${row.sourceRecordId}`);
    assert.equal(archive.record.sourceId, '323');
    assert.equal(archive.record.containerId, '101');
  } finally {
    review.child.kill('SIGINT');
    const stopped = await review.exited;
    assert.equal(stopped.code, 130, stopped.stderr);
  }

  const requiresReview = await launch(['verify', root], env).exited;
  assert.equal(requiresReview.code, 2, requiresReview.stderr);
  const { attempt, report } = await readReport(root, requiresReview);
  assert.equal(report.status, 'review');
  assert.deepEqual(report.profile, expectedProfileProof);
  assert.deepEqual(report.confluenceReviews, staged.confluenceReviews);
  assert.equal(report.source.evidence.checks.confluencePackagesWithoutFullPageCoverage, 1);
  assert.equal(report.restore.evidence.checks.confluencePackagesWithoutFullPageCoverage, 1);
  assert.equal(report.source.evidence.checks.pendingPackages, 0);
  assert.equal(report.source.evidence.checks.receiptsWithWarnings, 1);
  assert.equal(report.source.evidence.checks.receiptsWithLiveRestrictedConfluenceDocuments, 0);
  assert.equal(report.source.evidence.checks.receiptsWithPrimaryRecordCountMismatches, 0);
  assert.equal(report.source.evidence.checks.receiptsWithInvalidPrimaryTargets, 0);
  assert.equal(report.source.evidence.checks.receiptsWithArchiveOnlyPrimaryRecords, 0);
  assert.equal(report.source.evidence.checks.receiptsWithHierarchyFailures, 0);
  assert.equal(report.source.evidence.checks.receiptsWithHierarchyReview, 0);
  assert.equal(report.source.evidence.checks.receiptsWithPrimaryFieldFailures, 0);
  assert.equal(report.source.evidence.checks.receiptsWithPrimaryFieldReview, 0);
  assert.equal(report.source.evidence.checks.receiptsWithResourceLinkFailures, 0);
  assert.equal(report.source.evidence.checks.receiptsWithResourceLinkReview, 0);
  assert.equal(report.source.evidence.receipts.length, 1);
  const [receipt] = report.source.evidence.receipts;
  const coverage = new Map(receipt.primaryRecords.map(entry => [entry.kind, entry]));
  for (const { packageId, kind, counts, invalidTargets, dispositionSha256, records, hierarchy, fields } of coverage.values()) {
    const pkg = staged.packages.find(item => item.packageId === packageId);
    assert.equal(pkg.counts[kind], records.expected);
    assert.equal(records.expected, records.observed);
    assert.equal(records.observed, Object.values(counts).reduce((sum, count) => sum + count, 0));
    assert.equal(invalidTargets, 0);
    assert.match(dispositionSha256, /^[a-f0-9]{64}$/);
    assert.match(hierarchy.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(hierarchy, { matched: counts.linked + counts.trashed, changed: 0, unavailable: 0, invalid: 0, sha256: hierarchy.sha256 });
    assert.match(fields.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(fields.counts[kind === 'issue' ? 'status' : 'content'], { matched: counts.linked + counts.trashed, changed: 0, unavailable: 0, invalid: 0 });
  }
  assert.equal(coverage.get('issue').counts.linked, 2);
  assert.equal(coverage.get('page').counts.linked, 1);
  assert.equal(coverage.get('page').counts.excluded, 2);
  assert.deepEqual(report.restore.evidence.receipts[0].primaryRecords, receipt.primaryRecords);
  assert.equal(receipt.liveRestrictedConfluenceDocumentCount, 0);
  assert.equal(receipt.confluenceReviews.length, 2);
  for (const [index, reportSha] of reviewDigests.entries()) {
    const review = receipt.confluenceReviews.find(value => value.sha256 === reportSha);
    assert.match(review.dispositionsSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(review, { packageId: wikiId, sha256: reportSha, dispositionsSha256: review.dispositionsSha256,
      counts: index === 0 ? { excluded: 2, documentBound: 1, archiveOnly: 0, absent: 1 } :
        { excluded: 0, documentBound: 0, archiveOnly: 0, absent: 0 },
      liveRestrictedCounts: { excluded: index === 0 ? 2 : 0, documentBound: 0, archiveOnly: 0, absent: 0 } });
  }
  assert.deepEqual(report.restore.evidence.receipts[0].confluenceReviews, receipt.confluenceReviews);
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
  const { resourceLinkProjection } = receipt;
  assert.match(resourceLinkProjection.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(resourceLinkProjection, { version: 1, expected: 1, sha256: resourceLinkProjection.sha256,
    counts: { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 } });
  assert.deepEqual(report.restore.evidence.receipts[0].resourceLinkProjection, resourceLinkProjection);
  assert.equal(report.source.evidence.workspace.counts.resourceLinks, 1);
  for (const value of [importedLink.id, importedLink.issueId, importedLink.documentId]) assert.ok(!JSON.stringify(report).includes(value));
  const { authorAttribution } = receipt;
  assert.equal(authorAttribution.version, 1);
  assert.match(authorAttribution.fingerprint, /^[a-f0-9]{64}$/);
  const authorsByProduct = Object.fromEntries(authorAttribution.packages.map(({ packageId, kinds }) => [
    staged.packages.find(pkg => pkg.packageId === packageId).product,
    Object.fromEntries(kinds.map(({ kind, counts }) => [kind, [counts.mapped, counts['missing-fallback']]])),
  ]));
  assert.deepEqual(authorsByProduct, {
    jira: { attachment: [0, 1], comment: [1, 0], worklog: [1, 0] },
    confluence: { comment: [1, 0], document: [1, 0], revision: [1, 0] },
  });
  assert.equal(report.source.evidence.checks.receiptsWithAuthorReview, 1);
  assert.equal(report.source.evidence.checks.receiptsWithAuthorMismatches, 0);
  assert.deepEqual(report.restore.evidence.receipts[0].authorAttribution, authorAttribution);
  const { jiraStatusHistory } = receipt;
  assert.match(jiraStatusHistory.projected.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(jiraStatusHistory, {
    sourceChanges: 2, projected: { count: 2, sha256: jiraStatusHistory.projected.sha256 }, duplicate: 0, excluded: 0,
    restricted: 0, unavailable: 0, unresolvedTime: 1, unresolvedAuthor: 1,
  });
  assert.deepEqual(report.restore.evidence.receipts[0].jiraStatusHistory, jiraStatusHistory);
  assert.equal(report.source.evidence.checks.receiptsWithJiraHistoryReview, 1);
  assert.equal(report.source.evidence.workspace.counts.issues, 2);
  assert.equal(report.source.evidence.workspace.counts.documents, 2);
  assert.equal(report.source.evidence.workspace.counts.planningItems, 2);
  assert.equal(report.comparison.status, 'review');
  assert.equal(report.comparison.matches, true);
  assert.deepEqual(report.source.bundles, report.restore.bundles);
  const backupRoot = join(attempt, 'backup');
  const backupManifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8'));
  const backedUpFiles = new Map(backupManifest.files.map(({ path, sha256 }) => [path, sha256]));
  assert.equal(backedUpFiles.get('.donefac-rehearsal/stage.json'), digest(initial));
  for (const sha of reviewDigests) assert.equal(backedUpFiles.get(`.donefac-rehearsal/confluence-findings/${sha}.json`), sha);
  const backupState = rehearsalState(join(backupRoot, 'data'));
  const restoredWorkspacePath = join(attempt, 'restored');
  const restoredState = rehearsalState(restoredWorkspacePath);
  assert.ok(existsSync(join(restoredWorkspacePath, 'donefac.sqlite')));
  for (const copy of [backupState, restoredState]) {
    assert.equal(await readFile(join(copy, 'stage.json'), 'utf8'), initial);
    for (const [index, sha] of reviewDigests.entries()) {
      const snapshot = join(copy, 'confluence-findings', `${sha}.json`);
      assert.deepEqual(await readFile(snapshot), reportBytes[index]);
      assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    }
  }

  const restoredFindings = join(restoredState, 'confluence-findings', `${reviewDigests[0]}.json`);
  await writeFile(restoredFindings, reportBytes[1]);
  try {
    const swapped = await launch(['review', restoredWorkspacePath], env).exited;
    assert.equal(swapped.code, 1, swapped.stderr);
    assert.match(swapped.stderr, /보관한 Confluence 페이지별 검토 파일의 SHA-256이 다릅니다/);
    assert.doesNotMatch(swapped.stdout, /이관 검토 주소/);
    assert.deepEqual(await readFile(reviewSnapshot), reportBytes[0]);
  } finally { await writeFile(restoredFindings, reportBytes[0]); }

  const heldState = join(scratch, 'original-rehearsal-state');
  await rename(stateDirectory, heldState);
  const restored = launch(['review', restoredWorkspacePath], env);
  let legacyBackup;
  try {
    const base = await waitForReview(restored);
    const restoredWorkspace = await json(base, '/workspace');
    assert.deepEqual(restoredWorkspace.documents.find(document => document.id === importedDocument.id), importedDocument);
    const actor = restoredWorkspace.users[0].id;
    const options = await json(base, optionsPath(wikiId), { actor });
    assert.deepEqual(options.confluenceReviews, expectedReviews);
    const configuration = { ...options.defaultConfiguration,
      projects: options.defaultConfiguration.projects.map(project => ({ ...project, key: 'RESUME' })) };
    const blocked = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration } });
    assert.equal(blocked.canApply, false);
    assert.ok(blocked.notices.some(notice => notice.code === 'RESTRICTED_CONTENT' &&
      notice.recordId === `${wikiId}/page:${restrictedPage}` && notice.severity === 'error'), JSON.stringify(blocked.notices));
    await json(base, `/migrations/previews/${blocked.id}/apply`, { method: 'POST', actor, status: 409,
      body: { expectedVersion: blocked.version, acknowledgements: blocked.requiredAcknowledgements } });
    legacyBackup = await json(base, '/export');
    assert.deepEqual(await json(base, `/issues/${importedIssueId}/jira-status-history`), importedStatusHistory);
    const stablePage = jiraFindingsPath(importedReceipt, 'unresolved-time', importedFinding.fingerprint);
    assert.deepEqual(await json(base, stablePage), importedFinding);
    await json(base, `/issues/${importedRelated.id}?expectedVersion=${importedRelated.version}`, { method: 'DELETE' });
    await json(base, stablePage, { status: 409 });
    const unavailable = await json(base, jiraFindingsPath(importedReceipt, 'unavailable'));
    assert.equal(unavailable.totalChanges, 1);
    assert.deepEqual(unavailable.rows, [{ ...importedFinding.rows[0], reason: 'issue-in-trash' }]);
  } finally {
    restored.child.kill('SIGINT');
    await restored.exited;
    await rename(heldState, stateDirectory);
  }
  const original = launch(['review', root], env);
  try {
    const base = await waitForReview(original);
    assert.deepEqual(await json(base, jiraFindingsPath(importedReceipt, 'unresolved-time', importedFinding.fingerprint)), importedFinding);
  } finally {
    original.child.kill('SIGINT');
    await original.exited;
  }

  const legacyPilot = await startRehearsalPilot(join(scratch, 'legacy-checklist'));
  try {
    const base = legacyPilot.url;
    // Simulate a prior import with the exact whole-page fallback and no field checkpoint.
    const originalPage = legacyBackup.sourceRecords.find(record => record.targetId === importedDocument.id && record.record.kind === 'page');
    const savedPage = legacyBackup.documents.find(document => document.id === importedDocument.id);
    const savedRevision = legacyBackup.revisions.find(revision => revision.documentId === savedPage.id && revision.version === savedPage.version);
    assert.ok(originalPage && savedRevision);
    const plainText = originalPage.record.text;
    const content = { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: plainText }] }] };
    Object.assign(savedPage, { plainText, content });
    Object.assign(savedRevision, { plainText, content });
    delete originalPage.confluencePageFieldHashes;
    delete originalPage.confluencePageBodySourceHash;
    const legacyReceipt = legacyBackup.sourceImports.find(receipt => receipt.id === originalPage.sourceImportId);
    delete legacyReceipt.integrity;
    await json(base, '/import', { method: 'POST', body: { data: legacyBackup } });
    const actor = legacyBackup.users[0].id;

    const { filename, product, bytes } = packages.find(item => item.product === 'confluence');
    const packageQuery = new URLSearchParams({ filename, product, instanceKey: `${originalFrom}-${product}` });
    const upload = await fetch(`${base}/api/legacy-import/packages?${packageQuery}`, { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actor }, body: bytes, signal: AbortSignal.timeout(35_000) });
    const summary = await upload.json();
    assert.ok(upload.ok, JSON.stringify(summary));
    const options = await json(base, `/migrations/options?${new URLSearchParams({ packageId: summary.id })}`);
    const configuration = { ...options.defaultConfiguration, excludedRecords: [`${summary.id}/page:${restrictedPage}`],
      appendPagesTo: { projectId: savedPage.projectId, refreshExisting: true } };
    const reviewed = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration } });
    assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
    assert.ok(reviewed.requiredAcknowledgements.includes('CONFLUENCE_REFRESH_CHECKLIST_RESTORED'));
    assert.equal(reviewed.counts.updatedDocuments, 1);
    await json(base, `/migrations/previews/${reviewed.id}/apply`, { method: 'POST', actor, status: 201,
      body: { expectedVersion: reviewed.version, acknowledgements: reviewed.requiredAcknowledgements } });
    const { documents } = await json(base, '/workspace');
    const repaired = documents.find(document => document.id === savedPage.id);
    assert.equal(repaired.version, savedPage.version + 1);
    assert.deepEqual(repaired.content, importedDocument.content);
    assert.equal(repaired.plainText, importedDocument.plainText);
  } finally {
    await legacyPilot.close();
  }

  // Break the locator of each primary record while keeping both live targets and the archived sources intact.
  const issueAlias = ['jira', `${originalFrom}-jira`, 'issue', 'SRC-1'];
  const pageAlias = ['confluence', `${originalFrom}-confluence`, 'page', '200'];
  const aliasCondition = 'product=? AND source_instance=? AND kind=? AND source_alias=?';
  function changeWorkspace(action) {
    const db = new DatabaseSync(join(workspacePath, 'donefac.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      action(db);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }
  changeWorkspace(db => {
    const binding = db.prepare(`SELECT target_type, target_id, import_id FROM source_bindings WHERE ${aliasCondition}`);
    assert.deepEqual({ ...binding.get(...issueAlias) }, { target_type: 'issue', target_id: importedIssueId, import_id: importedReceipt.id });
    assert.deepEqual({ ...binding.get(...pageAlias) }, { target_type: 'document', target_id: importedDocument.id, import_id: importedReceipt.id });
    assert.equal(db.prepare(`DELETE FROM source_bindings WHERE ${aliasCondition}`).run(...issueAlias).changes, 1);
    assert.equal(db.prepare(`UPDATE source_bindings SET target_id=? WHERE ${aliasCondition}`).run(otherDocumentId, ...pageAlias).changes, 1);
  });
  try {
    const invalid = await launch(['verify', root], env).exited;
    assert.equal(invalid.code, 1, invalid.stdout + invalid.stderr);
    const { attempt: failedAttempt, report: failedAliases } = await readReport(root, invalid);
    assert.equal(failedAliases.status, 'failed');
    assert.deepEqual(failedAliases.source.bundles, report.source.bundles);
    assert.deepEqual(failedAliases.source.evidence.workspace, report.source.evidence.workspace);
    assert.equal(failedAliases.source.evidence.checks.receiptsWithInvalidPrimaryTargets, 1);
    assert.equal(failedAliases.source.evidence.checks.receiptsWithPrimaryRecordCountMismatches, 0);
    const [failedReceipt] = failedAliases.source.evidence.receipts;
    assert.equal(failedReceipt.id, importedReceipt.id);
    assert.deepEqual(failedReceipt.integrity, receipt.integrity);
    assert.equal(failedReceipt.primaryRecords.length, coverage.size);
    for (const primary of failedReceipt.primaryRecords) {
      assert.equal(primary.packageId, coverage.get(primary.kind).packageId);
      assert.deepEqual(primary.records, coverage.get(primary.kind).records);
      assert.equal(primary.invalidTargets, 1);
    }
    assert.equal(failedAliases.restore, null);
    assert.equal(failedAliases.comparison, null);
    assert.equal(existsSync(join(failedAttempt, 'backup')), false);
    assert.equal(existsSync(join(failedAttempt, 'restored')), false);
  } finally {
    changeWorkspace(db => {
      db.prepare(`INSERT INTO source_bindings(product, source_instance, kind, source_alias, target_type, target_id, import_id)
        VALUES(?,?,?,?,?,?,?)`).run(...issueAlias, 'issue', importedIssueId, importedReceipt.id);
      db.prepare(`UPDATE source_bindings SET target_id=? WHERE ${aliasCondition}`).run(importedDocument.id, ...pageAlias);
    });
  }

  const retargetedLink = { ...importedLink, issueId: importedRelated.id };
  const replacementLink = { ...retargetedLink, id: randomUUID() };
  const insertResourceLink = (db, link) => db.prepare('INSERT INTO resource_links(id, issue_id, document_id, json) VALUES(?,?,?,?)')
    .run(link.id, link.issueId, link.documentId, JSON.stringify(link));
  const removeResourceLink = (db, id) => db.prepare('DELETE FROM resource_links WHERE id=?').run(id);
  for (const [changedLink, finding] of [[retargetedLink, 'mismatch'], [replacementLink, 'missing']]) {
    changeWorkspace(db => {
      assert.equal(removeResourceLink(db, importedLink.id).changes, 1);
      insertResourceLink(db, changedLink);
    });
    try {
      const rejected = await launch(['verify', root], env).exited;
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      const { attempt: failedAttempt, report: failedLinks } = await readReport(root, rejected);
      assert.equal(failedLinks.status, 'failed');
      assert.equal(failedLinks.source.evidence.checks.receiptsWithResourceLinkFailures, 1);
      assert.equal(failedLinks.source.evidence.checks.receiptsWithResourceLinkReview, 0);
      assert.equal(failedLinks.source.evidence.workspace.counts.resourceLinks, report.source.evidence.workspace.counts.resourceLinks);
      const [audited] = failedLinks.source.evidence.receipts;
      assert.deepEqual(audited.primaryRecords, receipt.primaryRecords);
      const { sha256, ...affected } = audited.resourceLinkProjection;
      assert.notEqual(sha256, resourceLinkProjection.sha256);
      assert.deepEqual(affected, { version: 1, expected: 1, counts: { ...resourceLinkProjection.counts, linked: 0, [finding]: 1 } });
      for (const value of [changedLink.id, changedLink.issueId, changedLink.documentId]) assert.ok(!JSON.stringify(failedLinks).includes(value));
      assert.equal(failedLinks.restore, null);
      assert.equal(failedLinks.comparison, null);
      assert.equal(existsSync(join(failedAttempt, 'backup')), false);
    } finally {
      changeWorkspace(db => {
        removeResourceLink(db, changedLink.id);
        insertResourceLink(db, importedLink);
      });
    }
  }

  // Keep the source bundle and receipt intact while changing the staged issue count.
  try {
    const wrongCoverage = structuredClone(staged);
    wrongCoverage.packages[0].counts.issue++;
    await writeFile(stagePath, JSON.stringify(wrongCoverage));
    const rejectedCoverage = await launch(['verify', root], env).exited;
    assert.equal(rejectedCoverage.code, 1, rejectedCoverage.stdout + rejectedCoverage.stderr);
    const coverageFailure = (await readReport(root, rejectedCoverage)).report;
    assert.equal(coverageFailure.status, 'failed');
    assert.ok(coverageFailure.source.bundles.every(bundle => bundle.status === 'verified'));
    assert.equal(coverageFailure.source.evidence.checks.receiptsWithPrimaryRecordCountMismatches, 1);
    assert.equal(coverageFailure.source.evidence.checks.receiptsWithInvalidPrimaryTargets, 0);
    assert.deepEqual(coverageFailure.source.evidence.receipts[0].primaryRecords.find(entry => entry.kind === 'issue').records,
      { expected: 3, observed: 2 });
    assert.equal(coverageFailure.restore, null);
  } finally {
    await writeFile(stagePath, initial);
  }

  const rawPath = join(root, 'workspace', 'legacy-imports', `${staged.packages[0].packageId}.bundle`);
  const corrupted = await readFile(rawPath);
  corrupted[0] ^= 1;
  await writeFile(rawPath, corrupted);
  const failed = await launch(['verify', root], env).exited;
  assert.equal(failed.code, 1, failed.stderr);
  const failedEvidence = (await readReport(root, failed)).report;
  assert.equal(failedEvidence.status, 'failed');
  assert.deepEqual(failedEvidence.profile, expectedProfileProof);
  assert.deepEqual(failedEvidence.confluenceReviews, staged.confluenceReviews);
  assert.equal(failedEvidence.source.bundles[0].status, 'mismatch');
  assert.equal(failedEvidence.restore, null);
});

test('profile-bound stage discards rejected inputs and accepts an exact clean profile', { timeout: 90_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-bound-stage-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, DONEFAC_DATA_DIR: join(scratch, 'unused-workspace') };
  const manifest = join(scratch, 'manifest.json');
  const root = join(scratch, 'run');
  const profilePath = join(scratch, 'profile.json');
  const fixtures = fixturePackages();
  const sources = fixtures.map(item => ({ file: item.filename, product: item.product, instanceKey: `${originalFrom}-${item.product}` }));
  const writeManifest = values => writeFile(manifest, JSON.stringify({ packages: values }));
  for (const item of fixtures) await writeFile(join(scratch, item.filename), item.bytes);
  await writeManifest(sources);
  const profiled = await launch(['profile', manifest, profilePath], env).exited;
  assert.equal(profiled.code, 2, profiled.stdout + profiled.stderr);

  async function rejectsStage(report = profilePath, ordinal) {
    const before = (await readdir(scratch)).sort();
    const staged = await launch(['stage', manifest, root, '--profile', report], env).exited;
    assert.equal(staged.code, 1, staged.stdout + staged.stderr);
    if (ordinal !== undefined) assert.match(staged.stderr, new RegExp(`패키지\\s*${ordinal}(?:\\D|$)`, 'u'));
    assert.equal(existsSync(root), false);
    assert.deepEqual((await readdir(scratch)).sort(), before);
    for (const privateValue of [scratch, ...fixtures.map(item => item.filename), originalFrom, 'different-private-instance', privateTitle, privateBody]) {
      assert.equal((staged.stdout + staged.stderr).includes(privateValue), false);
    }
    return staged.stderr;
  }

  const secondFile = join(scratch, sources[1].file);
  const changed = Buffer.from(fixtures[1].bytes);
  changed[0] ^= 1;
  await writeFile(secondFile, changed);
  await rejectsStage(profilePath, 2);
  await writeFile(secondFile, changed.subarray(1));
  await rejectsStage(profilePath, 2);
  await writeFile(secondFile, fixtures[1].bytes);

  await writeManifest(sources.toReversed());
  await rejectsStage(profilePath, 1);
  await writeManifest([sources[0], { ...sources[1], product: 'jira' }]);
  await rejectsStage(profilePath, 2);
  await writeManifest([sources[0], { ...sources[1], instanceKey: 'different-private-instance' }]);
  await rejectsStage(profilePath, 2);
  await writeManifest([sources[0]]);
  await rejectsStage();

  await writeManifest(sources);
  const malformedPath = join(scratch, 'malformed-profile.json');
  await writeFile(malformedPath, `{ invalid json ${privateTitle} }`);
  await rejectsStage(malformedPath);

  const firstVersionPath = join(scratch, 'prior-profile.json');
  const report = JSON.parse(await readFile(profilePath, 'utf8'));
  const { format, checkedAt, status, limits, totals, packages } = report;
  await writeFile(firstVersionPath, JSON.stringify({ format, version: 1, checkedAt, status, limits, totals,
    packages: packages.map(({ ordinal, product, size, sha256, status, analysis }) => ({ ordinal, product, size, sha256, status, analysis })) }));
  assert.match(await rejectsStage(firstVersionPath), /profile을 다시 실행/u);

  const differentAnalysis = join(scratch, 'different-analysis-profile.json');
  report.packages[1].analysis.fileCount += 1;
  await writeFile(differentAnalysis, JSON.stringify(report));
  await rejectsStage(differentAnalysis, 2);

  const blockedPath = join(scratch, 'blocked-profile.json');
  const emptyJira = 'empty-jira.xml';
  await writeFile(join(scratch, emptyJira), '<entity-engine-xml/>');
  await writeManifest([{ file: emptyJira, product: 'jira', instanceKey: originalFrom }]);
  const blocked = await launch(['profile', manifest, blockedPath], env).exited;
  assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
  assert.equal(JSON.parse(await readFile(blockedPath, 'utf8')).status, 'blocked');
  assert.match(await rejectsStage(blockedPath), /blocked/u);

  const cleanPath = join(scratch, 'clean-profile.json');
  await writeFile(join(scratch, emptyJira), `<entity-engine-xml>
    <Project id="10" pkey="SRC" name="Jira fixture"/><Status id="1" pname="Open"/><IssueType id="2" pname="Task"/>
    <Issue id="100" project="10" number="1" summary="${privateTitle}" status="1" issuetype="2" created="${date}" updated="${date}"/>
  </entity-engine-xml>`);
  const clean = await launch(['profile', manifest, cleanPath], env).exited;
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  const renamedJira = join('moved', 'renamed.xml');
  await mkdir(join(scratch, 'moved'));
  await rename(join(scratch, emptyJira), join(scratch, renamedJira));
  await writeManifest([{ file: renamedJira, product: 'jira', instanceKey: originalFrom }]);
  assert.match(await rejectsStage(cleanPath, 1), /파일 유형과 이름/u);

  const relocatedJira = join('moved', emptyJira);
  await rename(join(scratch, renamedJira), join(scratch, relocatedJira));
  await writeManifest([{ file: relocatedJira, product: 'jira', instanceKey: originalFrom }]);
  const staged = await launch(['stage', manifest, root, '--profile', cleanPath], env).exited;
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const accepted = JSON.parse(await readFile(join(rehearsalState(join(root, 'workspace')), 'stage.json'), 'utf8'));
  assert.equal(accepted.profile.status, 'analyzed');
});

test('review rejects damaged ordinary staged packages before printing a browser address and allows a retry', { timeout: 90_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-review-integrity-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'run');
  const workspace = join(root, 'workspace');
  const manifest = join(scratch, 'manifest.json');
  const fixtures = fixturePackages();
  const sources = fixtures.map(({ filename, product }) => ({ file: filename, product, instanceKey: `${originalFrom}-${product}` }));
  for (const item of fixtures) await writeFile(join(scratch, item.filename), item.bytes);
  await writeFile(manifest, JSON.stringify({ packages: sources }));
  const staged = await launch(['stage', manifest, root], process.env).exited;
  assert.equal(staged.code, 0, staged.stderr);
  const { packages, confluenceReviews, jiraPlans } = JSON.parse(await readFile(join(rehearsalState(workspace), 'stage.json'), 'utf8'));
  assert.equal(confluenceReviews, undefined);
  assert.equal(jiraPlans, undefined);
  const second = packages[1];
  const bundle = join(workspace, 'legacy-imports', `${second.packageId}.bundle`);
  const bundleBytes = await readFile(bundle);
  assert.deepEqual(bundleBytes, fixtures[1].bytes);

  async function rejectReview(reason) {
    const review = launch(['review', root], process.env);
    try {
      await assert.rejects(() => waitForReview(review), reason);
      const result = await review.exited;
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /패키지 2/u);
      assert.doesNotMatch(result.stdout + result.stderr, /이관 검토 주소|http:\/\/127\.0\.0\.1:/u);
      for (const value of [scratch, ...fixtures.map(item => item.filename), originalFrom, privateTitle, privateBody, restrictedTitle,
        'changed-private-instance']) {
        assert.equal((result.stdout + result.stderr).includes(value), false);
      }
    } finally {
      review.child.kill('SIGINT');
      await review.exited;
    }
  }

  const changedBytes = Buffer.from(bundleBytes);
  changedBytes[0] ^= 1;
  await writeFile(bundle, changedBytes);
  await rejectReview(/SHA-256|해시/u);
  assert.deepEqual(await readFile(bundle), changedBytes);
  await writeFile(bundle, bundleBytes);

  const savedBundle = join(scratch, 'retained-source.bundle');
  await rename(bundle, savedBundle);
  try {
    await rejectReview(/누락|없습니다/u);
    assert.equal(existsSync(bundle), false);
    await mkdir(bundle);
    try { await rejectReview(/읽을 수 없/u); }
    finally { await rmdir(bundle); }
    await symlink(savedBundle, bundle);
    try {
      await rejectReview(/읽을 수 없/u);
      assert.equal((await lstat(bundle)).isSymbolicLink(), true);
      assert.deepEqual(await readFile(savedBundle), bundleBytes);
    } finally { await rm(bundle); }
  } finally {
    await rename(savedBundle, bundle);
  }

  const setAnalyzedInstance = instanceKey => {
    const db = new DatabaseSync(join(workspace, 'donefac.sqlite'));
    try {
      const result = db.prepare("UPDATE legacy_packages SET json=json_set(json, '$.source.instanceKey', ?) WHERE id=?")
        .run(instanceKey, second.packageId);
      assert.equal(result.changes, 1);
    } finally { db.close(); }
  };
  setAnalyzedInstance('changed-private-instance');
  try { await rejectReview(/분석 기록과 원본 인스턴스가 일치하지 않습니다/u); }
  finally { setAnalyzedInstance(second.instanceKey); }

  // Simulate a missing registry row without removing its associated analysis records.
  const db = new DatabaseSync(join(workspace, 'donefac.sqlite'), { enableForeignKeyConstraints: false });
  const stored = db.prepare('SELECT * FROM legacy_packages WHERE id=?').get(second.packageId);
  assert.ok(stored);
  assert.equal(db.prepare('DELETE FROM legacy_packages WHERE id=?').run(second.packageId).changes, 1);
  try {
    await rejectReview(/분석 기록과 원본 인스턴스가 일치하지 않습니다/u);
    assert.deepEqual(await readFile(bundle), bundleBytes);
  } finally {
    db.prepare('INSERT INTO legacy_packages(id,instance_key,sha256,json) VALUES(?,?,?,?)')
      .run(stored.id, stored.instance_key, stored.sha256, stored.json);
    db.close();
  }

  const review = launch(['review', root], process.env);
  try {
    const base = await waitForReview(review);
    const analyses = await json(base, '/legacy-import/packages');
    assert.equal(analyses.length, packages.length);
    for (const item of packages) {
      const current = analyses.find(value => value.id === item.packageId);
      assert.equal(current.sha256, item.sha256);
      assert.equal(current.source.instanceKey, item.instanceKey);
    }
  } finally {
    review.child.kill('SIGINT');
    const stopped = await review.exited;
    assert.equal(stopped.code, 130, stopped.stderr);
  }
});

test('review opens a legacy rehearsal with Confluence proof beside its workspace', { timeout: 60_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-legacy-layout-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'run');
  const manifest = join(scratch, 'manifest.json');
  const findings = join(scratch, 'private-review.json');
  const wiki = fixturePackages().find(pkg => pkg.product === 'confluence');
  await writeFile(join(scratch, wiki.filename), wiki.bytes);
  await writeFile(manifest, JSON.stringify({ packages: [{ file: wiki.filename, product: wiki.product, instanceKey: originalFrom }] }));
  await writeFile(findings, JSON.stringify(confluenceFindings(wiki.bytes)), { mode: 0o600 });
  const stage = await launch(['stage', manifest, root, '--confluence-findings', findings], process.env).exited;
  assert.equal(stage.code, 0, stage.stderr);

  const state = rehearsalState(join(root, 'workspace'));
  const legacyStage = join(root, 'stage.json');
  await rename(join(state, 'stage.json'), legacyStage);
  await rename(join(state, 'confluence-findings'), join(root, 'confluence-findings'));
  await rmdir(state);
  const { packages: [{ packageId }] } = JSON.parse(await readFile(legacyStage, 'utf8'));

  const review = launch(['review', root], process.env);
  try {
    const base = await waitForReview(review);
    const { users: [{ id: actor }] } = await json(base, '/workspace');
    const options = await json(base, `/migrations/options?${new URLSearchParams({ packageId })}`, { actor });
    assert.deepEqual(options.confluenceReviews, [{ packageId, checkedAt: '2026-11-23T02:00:00.000Z', selection: 'explicit-pages',
      status: 'needs-review', spacePermissions: 'manual-review', findingsPages: 4, unidentifiedPages: 0 }]);
    const preview = await json(base, '/migrations/preview', { method: 'POST', actor, status: 201, body: { configuration: options.defaultConfiguration } });
    assert.equal(preview.canApply, false);
    assert.ok(preview.notices.some(notice => notice.code === 'RESTRICTED_CONTENT' &&
      notice.recordId === `${packageId}/page:${restrictedPage}` && notice.severity === 'error'), JSON.stringify(preview.notices));
  } finally {
    review.child.kill('SIGINT');
    await review.exited;
  }
  assert.equal(existsSync(state), false);
});

test('stage rejects Confluence findings that cannot identify exactly one matching space ZIP', { timeout: 90_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-findings-reject-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const manifest = join(scratch, 'manifest.json');
  const root = join(scratch, 'run');
  const findingsPath = join(scratch, 'private-review.json');
  const duplicatePath = join(scratch, 'duplicate-review.json');
  const [jira, wiki] = fixturePackages();
  const jiraSource = { file: jira.filename, product: 'jira', instanceKey: `${originalFrom}-jira` };
  const wikiSource = { file: wiki.filename, product: 'confluence', instanceKey: `${originalFrom}-wiki` };
  const finding = confluenceFindings(wiki.bytes);
  const looseXml = Buffer.from('<hibernate-generic><object class="Space"><id name="id">20</id>' +
    '<property name="key">QA</property><property name="name">QA</property></object></hibernate-generic>');
  const looseSource = { ...wikiSource, file: 'entities.xml' };
  await Promise.all([jira, wiki, { filename: looseSource.file, bytes: looseXml }].map(item =>
    writeFile(join(scratch, item.filename), item.bytes)));
  await writeFile(duplicatePath, JSON.stringify(finding));

  const attempts = [
    { packages: [wikiSource], report: { ...finding, version: 2 } },
    { packages: [wikiSource], report: { ...finding, archive: { ...finding.archive, sha256: '0'.repeat(64) } } },
    { packages: [wikiSource], report: { ...finding, archive: { ...finding.archive, bytes: finding.archive.bytes + 1 } } },
    { packages: [jiraSource, wikiSource], report: confluenceFindings(jira.bytes) },
    { packages: [looseSource], report: confluenceFindings(looseXml) },
    { packages: [wikiSource, { ...wikiSource, instanceKey: 'duplicate-private-instance' }], report: finding },
    { packages: [wikiSource], report: finding, extra: ['--confluence-findings', duplicatePath] },
  ];
  for (const { packages, report, extra = [] } of attempts) {
    await writeFile(manifest, JSON.stringify({ packages }));
    await writeFile(findingsPath, JSON.stringify(report));
    const before = (await readdir(scratch)).sort();
    const rejected = await launch(['stage', manifest, root, '--confluence-findings', findingsPath, ...extra], process.env).exited;
    assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /Confluence|페이지별/u);
    assert.equal(existsSync(root), false);
    assert.deepEqual((await readdir(scratch)).sort(), before);
    for (const value of [scratch, jira.filename, wiki.filename, missingPage, originalFrom, restrictedTitle, 'duplicate-private-instance']) {
      assert.equal((rejected.stdout + rejected.stderr).includes(value), false);
    }
  }
});

test('stage applies the aggregate input limit before starting the workspace', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'donefac-rehearsal-stage-cap-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const manifest = join(scratch, 'manifest.json');
  const root = join(scratch, 'run');
  const bigFile = 'private-large-input.zip';
  const tinyFile = 'private-final-input.xml';
  await writeFile(join(scratch, bigFile), 'A sparse file used to measure the aggregate before archive analysis.');
  await truncate(join(scratch, bigFile), 64 * 1024 * 1024);
  await writeFile(join(scratch, tinyFile), '<entity-engine-xml/>');
  await writeFile(manifest, JSON.stringify({ packages: [
    ...Array.from({ length: 8 }, (_, index) => ({ file: bigFile, product: 'jira', instanceKey: `private-instance-${index}` })),
    { file: tinyFile, product: 'jira', instanceKey: 'private-instance-final' },
  ] }));
  const before = (await readdir(scratch)).sort();
  const stage = await launch(['stage', manifest, root], process.env).exited;
  assert.equal(stage.code, 1, stage.stdout + stage.stderr);
  assert.match(stage.stderr, /패키지\s*9(?:\D|$)/u);
  assert.match(stage.stderr, /합계/u);
  assert.deepEqual((await readdir(scratch)).sort(), before);
});
