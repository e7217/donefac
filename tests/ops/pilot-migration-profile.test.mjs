import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const packageBytes = 64 * 1024 * 1024;
const totalBytes = 512 * 1024 * 1024;
const created = '2020-03-01T00:00:00Z';
const privateTitle = 'PRIVATE_TITLE_SENTINEL';
const privateFile = 'Private Source File.txt';
const privateInstance = 'private-instance-hint';
const privateObject = 'PrivateCustomType';
const privateAuthor = 'PRIVATE_AUTHOR_ID';
const privateBody = 'PRIVATE_BODY_CONTENT';
const privatePermission = 'PRIVATE_PERMISSION_GROUP';
const privateSource = 'https://private-fixture-jira.invalid/jira/rest/api/2/issue';
const privateVersion = 'PRIVATE_SOURCE_VERSION';
const privateZone = 'PRIVATE_SOURCE_ZONE';
const plainBackup = `<entity-engine-xml>
  <Project id="10" pkey="OLD" name="${privateTitle}"/><Status id="1" pname="Open"/><IssueType id="2" pname="Task"/>
  <Issue id="1000" project="10" number="1" summary="${privateTitle}" status="1" issuetype="2" created="${created}" updated="${created}"/>
</entity-engine-xml>`;

const xml = (path, content) => ({ path, bytes: Buffer.from(content) });
const json = (path, content) => xml(path, JSON.stringify(content));
const attachment = Buffer.from('PRIVATE_ATTACHMENT_BYTES\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-migration-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'private-manifest.json');
  async function write(filename, value) { await writeFile(join(directory, filename), value); }
  async function manifest(packages) { await writeFile(manifestPath, JSON.stringify({ packages })); }
  async function runCommand(args) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/pilot-migration.mjs', ...args], {
      cwd: repo, env: { ...process.env, TEAMSPACE_DATA_DIR: join(directory, 'do-not-start'),
        TEAMSPACE_PILOT_ACCESS_FILE: join(directory, 'missing-key'), TEAMSPACE_PILOT_ORIGIN: 'https://no-pilot.invalid' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
  }
  const run = (output = 'profile.json') => runCommand(['profile', manifestPath, join(directory, output)]);
  const stage = (workspace, report = 'profile.json') => runCommand(['stage', manifestPath, join(directory, workspace), '--profile', join(directory, report)]);
  return { directory, write, manifest, run, stage };
}

function assertSanitized(text, fixtureDirectory, extra = []) {
  for (const source of [fixtureDirectory, privateTitle, privateFile, privateObject, privateAuthor, privateBody,
    privatePermission, privateSource, privateInstance, privateVersion, privateZone, 'private-manifest.json', ...extra]) {
    assert.equal(text.includes(source), false, `The shareable result contained a source identifier: ${source}`);
  }
}

function source(file, product = 'jira', instanceKey = privateInstance) { return { file, product, instanceKey }; }

test('offline profile reads Jira XML, Jira REST and Confluence ZIP and writes only privacy-safe review evidence', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const jira = zip([
    xml('entities.xml', plainBackup.replace('</entity-engine-xml>', `
      <ApplicationUser id="31" userKey="${privateAuthor}" lowerUserName="${privateAuthor}"/>
      <User id="32" userName="${privateAuthor}" displayName="${privateAuthor}" active="1"/>
      <IssueLink id="600" source="1000" destination="917000123"/>
      <ChangeGroup id="33" issue="1000" author="${privateAuthor}" created="${created}"/>
      <ChangeItem id="34" group="33" fieldtype="jira" field="status" oldvalue="2" oldstring="${privateTitle}" newvalue="1" newstring="Open"/>
      <Worklog id="35" issue="1000" author="${privateAuthor}" startdate="${created}" timeworked="91" created="${created}" body="${privateBody}"/>
      <FileAttachment id="700" issue="1000" filename="${privateFile}" filesize="${attachment.length}" created="${created}"/>
      <Action id="36" issue="1000" type="${privateObject}" created="${created}"/>
    </entity-engine-xml>`)),
    { path: 'attachments/PRIVATE_SPACE/PRIVATE_ISSUE/700', bytes: attachment },
  ]);
  const jsonArchive = zip([
    json('issues/PRIVATE_ISSUE.json', { id: '1001', key: 'PRIVATE-2', self: `${privateSource}/1001`, fields: {
      summary: privateTitle, description: privateBody, created, updated: created, project: { id: '10', key: 'PRIVATE' },
      status: { id: '1', name: 'Open' }, issuetype: { id: '2', name: 'Task' },
      reporter: { accountId: privateAuthor, displayName: privateAuthor, emailAddress: 'private-fixture@example.test' },
      attachment: [{ id: '881', filename: privateFile, content: `https://private-fixture-jira.invalid/attachments/${privateFile}` }],
    } }),
    json('jira-worklogs/worklog.json', { self: `${privateSource}/1001/worklog`, startAt: 0, total: 1, worklogs: [
      { id: '350', self: `${privateSource}/1001/worklog/350`, issueId: '1001', started: created, timeSpentSeconds: 91, comment: privateBody },
    ] }),
  ]);
  const confluence = zip([
    xml('exportDescriptor.properties', `version=${privateVersion}\ntimezone=${privateZone}\n`),
    xml('entities.xml', `<hibernate-generic>
      <object class="ConfluenceUserImpl"><id name="key">${privateAuthor}</id><property name="name">${privateAuthor}</property></object>
      <object class="Space"><id name="id">200</id><property name="key">PRIVATE_SPACE</property></object>
      <object class="SpacePermission"><id name="id">201</id><property name="type">VIEWSPACE</property>
        <property name="groupName">${privatePermission}</property><property name="space" class="Space"><id name="id">200</id></property></object>
      <object class="Page"><id name="id">202</id><property name="title">${privateTitle}</property><property name="version">1</property>
        <property name="space" class="Space"><id name="id">200</id></property>
        <property name="creator" class="ConfluenceUserImpl"><id name="key">${privateAuthor}</id></property></object>
      <object class="BodyContent"><id name="id">203</id><property name="body"><![CDATA[<p>${privateBody}</p>]]></property>
        <property name="content" class="Page"><id name="id">202</id></property></object>
      <object class="${privateObject}"><id name="id">204</id><property name="body">${privateBody}</property></object>
    </hibernate-generic>`),
  ]);
  const names = ['private-jira-admin.zip', 'private-jira-REST.zip', 'private-wiki.zip'];
  await Promise.all([jira, jsonArchive, confluence].map((bytes, index) => f.write(names[index], bytes)));
  await f.manifest(names.map((name, index) => source(name, index === 2 ? 'confluence' : 'jira')));
  const before = (await readdir(f.directory)).sort();
  const result = await f.run();
  assert.equal(result.code, 2, result.stdout + result.stderr);
  const reportPath = join(f.directory, 'profile.json');
  const raw = await readFile(reportPath, 'utf8');
  assertSanitized(raw + result.stdout + result.stderr, f.directory, [...names, '917000123', 'PRIVATE_ISSUE', 'PRIVATE_SPACE', 'private-fixture@example.test']);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.directory)).sort(), [...before, 'profile.json'].sort());
  const report = JSON.parse(raw);
  assert.equal(report.format, 'teamspace-migration-source-profile');
  assert.equal(report.version, 2);
  assert.equal(report.status, 'review');
  assert.deepEqual(report.limits, { packageCount: 20, packageBytes, totalBytes });
  assert.equal(report.totals.bytes, jira.length + jsonArchive.length + confluence.length);
  assert.deepEqual(report.packages.map(item => [item.ordinal, item.product, item.analysis.format, item.sha256]), [
    [1, 'jira', 'jira-backup-xml', hash(jira)], [2, 'jira', 'jira-json', hash(jsonArchive)], [3, 'confluence', 'confluence-xml', hash(confluence)],
  ]);
  for (const item of report.packages) {
    assert.match(item.inputSha256, /^[a-f\d]{64}$/u);
    assert.notEqual(item.inputSha256, item.sha256);
  }
  const [backup, rest, wiki] = report.packages.map(item => item.analysis);
  assert.equal(backup.counts.issue, 1);
  assert.equal(backup.counts.attachment, 1);
  assert.equal(backup.coverage.references.unresolvedInPackage, 1);
  assert.deepEqual(backup.coverage.attachments, { matched: 1, unconfirmed: 0, empty: 0, overUploadLimit: 0 });
  assert.deepEqual(backup.coverage.jira, { changeGroups: 1, statusChanges: 1, worklogs: 1 });
  assert.ok(backup.diagnostics.some(group => group.code === 'MISSING_REFERENCE' && group.severity === 'warning'));
  assert.deepEqual(backup.unsupported, { types: 1, objects: 1 });
  assert.equal(rest.counts.issue, 1);
  assert.equal(rest.coverage.jira.worklogs, 1);
  assert.equal(rest.coverage.attachments.unconfirmed, 1);
  assert.equal(wiki.counts.page, 1);
  assert.deepEqual(wiki.coverage.metadata, { declaredVersionPresent: true, timezonePresent: true });
  assert.equal(wiki.coverage.confluence.pagesWithBody, 1);
  assert.equal(wiki.coverage.restrictions.spacePermissionRecords, 1);
  assert.deepEqual(wiki.unsupported, { types: 1, objects: 1 });

  const again = await f.run();
  assert.equal(again.code, 1);
  assert.match(again.stderr, /이미 있는 파일/u);
  assertSanitized(again.stdout + again.stderr, f.directory, names);
  assert.equal(await readFile(reportPath, 'utf8'), raw);
});

test('offline profile stages identified Confluence restrictions for review and blocks unresolved permission ownership', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const file = 'private-restricted-wiki.zip';
  const restrictedPage = '911337220012';
  const childPage = '911337220013';
  const ref = (field, type, id) => `<property name="${field}" class="${type}"><id name="id">${id}</id></property>`;
  const object = (type, id, content) => `<object class="${type}"><id name="id">${id}</id>${content}</object>`;
  const page = (id, title, bodyId, parent = '') => [
    object('Page', id, `<property name="title">${title}</property><property name="version">1</property>${ref('space', 'Space', '20')}${parent}`),
    object('BodyContent', bodyId, `<property name="body"><![CDATA[<p>${privateBody}</p>]]></property>${ref('content', 'Page', id)}`),
  ].join('');
  const confluence = extra => zip([xml('entities.xml', `<hibernate-generic>
    ${object('Space', '20', '<property name="key">WIKI</property><property name="name">Wiki fixture</property>')}
    ${page('200', 'Public page', '300')}
    ${page(restrictedPage, privateTitle, '301')}
    ${page(childPage, `${privateTitle} descendant`, '302', ref('parent', 'Page', restrictedPage))}
    ${object('ContentPermissionSet', '400', `<property name="type">View</property>${ref('owningContent', 'Page', restrictedPage)}`)}
    ${extra}
  </hibernate-generic>`)]);
  await f.write(file, confluence(''));
  await f.manifest([source(file, 'confluence')]);

  const profiled = await f.run();
  assert.equal(profiled.code, 2, profiled.stdout + profiled.stderr);
  const raw = await readFile(join(f.directory, 'profile.json'), 'utf8');
  const report = JSON.parse(raw);
  assert.equal(report.version, 2);
  assert.equal(report.status, 'review');
  assert.equal(report.packages[0].status, 'review');
  assert.equal(report.packages[0].analysis.coverage.restrictions.markedRecords, 2);
  assert.deepEqual(report.packages[0].analysis.diagnostics.filter(row => row.severity === 'error'), [
    { severity: 'error', code: 'CONFLUENCE_RESTRICTED_CONTENT', count: 2 },
  ]);
  const staged = await f.stage('stage');
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const state = JSON.parse(await readFile(join(f.directory, 'stage', 'workspace', '.teamspace-rehearsal', 'stage.json'), 'utf8'));
  assert.equal(state.profile.status, 'review');
  assert.equal(state.profile.sha256, hash(raw));
  assert.equal(state.packages[0].errors, 2);
  assert.equal(state.packages[0].counts.page, 3);
  assertSanitized(raw + profiled.stdout + profiled.stderr + staged.stdout + staged.stderr, f.directory, [file, restrictedPage, childPage]);

  const unresolvedSource = confluence([
    object('ContentPermissionSet', '401', '<property name="type">View</property>'),
    object('ContentPermission', '402', ref('owningSet', 'ContentPermissionSet', '403')),
  ].join(''));
  await f.write(file, unresolvedSource);
  const unresolved = await f.run('unresolved.json');
  assert.equal(unresolved.code, 1, unresolved.stdout + unresolved.stderr);
  const blocked = JSON.parse(await readFile(join(f.directory, 'unresolved.json'), 'utf8'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.packages[0].status, 'blocked');
  const blockedCodes = blocked.packages[0].analysis.diagnostics.filter(row => row.severity === 'error').map(row => row.code);
  assert.deepEqual(blockedCodes, ['CONFLUENCE_RESTRICTED_CONTENT', 'CONFLUENCE_RESTRICTION_OWNER_UNKNOWN', 'CONFLUENCE_RESTRICTION_SET_MISSING']);
  const refused = await f.stage('blocked-stage', 'unresolved.json');
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /blocked/u);
  await assert.rejects(stat(join(f.directory, 'blocked-stage')), { code: 'ENOENT' });

  const forged = structuredClone(blocked);
  const [forgedPackage] = forged.packages;
  forged.status = 'review';
  forged.totals = { ...forged.totals, review: 1, blocked: 0 };
  forgedPackage.status = 'review';
  // Bind the modified report to the actual rejected input so stage must check its parsed errors.
  forgedPackage.inputSha256 = createHash('sha256')
    .update(JSON.stringify([forged.format, forged.version, 1, 'confluence', privateInstance, ['zip']]))
    .update('\0').update(unresolvedSource).digest('hex');
  const errorCount = forgedPackage.analysis.diagnostics.filter(row => row.severity === 'error')
    .reduce((total, row) => total + row.count, 0);
  forgedPackage.analysis.diagnostics = [
    { severity: 'error', code: 'CONFLUENCE_RESTRICTED_CONTENT', count: errorCount },
    ...forgedPackage.analysis.diagnostics.filter(row => row.severity !== 'error'),
  ];
  forgedPackage.analysis.coverage.restrictions.markedRecords = errorCount;
  await f.write('forged.json', JSON.stringify(forged));
  const rejected = await f.stage('forged-stage', 'forged.json');
  assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /패키지 1.*분석 형식·건수 또는 진단/u);
  await assert.rejects(stat(join(f.directory, 'forged-stage')), { code: 'ENOENT' });
});

test('offline profile continues after missing, malformed, oversized and duplicate packages', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const names = ['missing-private.xml', 'malformed-private.xml', 'oversized-private.zip', 'good-private.xml', 'duplicate-private.xml', 'good-other-private.xml'];
  const good = Buffer.from(plainBackup);
  await f.write(names[1], `<entity-engine-xml><Issue id="${privateAuthor}">`);
  await f.write(names[2], 'sparse file');
  await truncate(join(f.directory, names[2]), packageBytes + 1);
  for (const name of names.slice(3)) await f.write(name, good);
  await f.manifest(names.map((name, index) => source(name, index === 4 ? 'confluence' : 'jira', index === 4 ? ` ${privateInstance} `
    : index === 5 ? 'another-private-instance' : privateInstance)));
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const raw = await readFile(join(f.directory, 'profile.json'), 'utf8');
  assertSanitized(raw + result.stdout + result.stderr, f.directory, [...names, 'another-private-instance']);
  const report = JSON.parse(raw);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.packages.map(item => [item.status, item.failure ?? null]), [
    ['blocked', 'FILE_NOT_FOUND'], ['blocked', 'ANALYSIS_REJECTED'], ['blocked', 'FILE_NOT_SUPPORTED'],
    ['analyzed', null], ['blocked', 'DUPLICATE_PACKAGE'], ['analyzed', null],
  ]);
  assert.deepEqual(report.totals, { packages: 6, analyzed: 2, review: 0, blocked: 4,
    bytes: good.length * 3 + Buffer.byteLength(`<entity-engine-xml><Issue id="${privateAuthor}">`) });
  assert.equal(report.packages[4].sha256, hash(good));
  assert.equal(report.packages[4].inputSha256, undefined);
  assert.equal(report.packages[0].sha256, undefined);
  assert.equal(report.packages[2].sha256, undefined);
  assert.equal(report.packages[5].analysis.counts.issue, 1);

  await f.manifest([source(names[3])]);
  const clean = await f.run('clean-profile.json');
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  const cleanReport = JSON.parse(await readFile(join(f.directory, 'clean-profile.json'), 'utf8'));
  assert.equal(cleanReport.status, 'analyzed');
  assert.equal(cleanReport.packages[0].sha256, report.packages[5].sha256);
  assert.notEqual(cleanReport.packages[0].inputSha256, report.packages[5].inputSha256);
});

test('offline profile bounds the manifest count and skips a file that exceeds the remaining aggregate buffer budget', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const largeInput = 'private-sparse.zip';
  await f.write(largeInput, 'not an archive');
  await truncate(join(f.directory, largeInput), packageBytes);
  await f.write('private-final.xml', plainBackup);

  await f.manifest(Array.from({ length: 21 }, () => source(largeInput)));
  const invalid = await f.run();
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /1~20/u);
  await assert.rejects(stat(join(f.directory, 'profile.json')), { code: 'ENOENT' });

  await f.manifest([...Array.from({ length: 8 }, () => source(largeInput)), source('private-final.xml')]);
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const raw = await readFile(join(f.directory, 'profile.json'), 'utf8');
  assertSanitized(raw + result.stdout + result.stderr, f.directory, [largeInput, 'private-final.xml']);
  const report = JSON.parse(raw);
  assert.equal(report.totals.bytes, totalBytes);
  assert.equal(report.packages[0].failure, 'ANALYSIS_REJECTED');
  assert.ok(report.packages.slice(1, -1).every(item => item.failure === 'DUPLICATE_PACKAGE'));
  assert.deepEqual(report.packages.at(-1), { ordinal: 9, product: 'jira', status: 'blocked', failure: 'TOTAL_SIZE_LIMIT' });
});
