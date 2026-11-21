import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationMappingFile, MigrationMappingRestore,
  MigrationOptions, MigrationPreview, User, WorkspaceSnapshot,
} from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const exportPath = '/migrations/mapping/export';
const importPath = '/migrations/mapping/import';
const jiraInstance = 'synthetic-mapping-jira';
const confluenceInstance = 'synthetic-mapping-wiki';
const legacyUser = 'archived-author';
const userEmail = 'migration-assignee@example.test';
const jiraTitle = '원본 이관 일정 업무';
const wikiTitle = '원본 이관 프로젝트 문서';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-mapping-transfer-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const actor = { 'X-Actor-Id': 'user-seo' };
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, expected = 200): Promise<T> {
    const response = await fetch(base + path, {
      method, headers: { ...actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }
  async function stage(product: 'jira' | 'confluence', instanceKey: string, filename: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename, product, instanceKey });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body) as LegacyPackageSummary;
  }
  return {
    call, stage,
    options: (packages: LegacyPackageSummary[]) => call<MigrationOptions>(`/migrations/options?${new URLSearchParams(packages.map(value => ['packageId', value.id]))}`),
    user: (name: string, email: string) => call<User>('/users', 'POST', { name, email }, 201),
    snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    preview: (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201),
    apply: (preview: MigrationPreview) => call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 'POST', {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    }, 201),
  };
}

const archive = (entities: string) => zip([{ path: 'entities.xml', bytes: Buffer.from(entities) }]);
const datePicker = 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker';
function jiraArchive(title = jiraTitle) {
  return archive(`<entity-engine-xml>
    <Project id="42" pkey="ORIG" name="원본 Jira 프로젝트"/>
    <User id="11" userName="${legacyUser}" displayName="원본 작성자" emailAddress="old-jira-user@example.test" active="1"/>
    <Status id="1" pname="Ready"/><IssueType id="3" pname="Task"/>
    <CustomField id="42101" name="Start date" customfieldtypekey="${datePicker}"/>
    <CustomField id="42102" name="End date" customfieldtypekey="${datePicker}"/>
    <Issue id="100" project="42" number="1" summary="${title}" status="1" issuetype="3" assignee="${legacyUser}"
      created="2025-03-01T00:00:00Z" updated="2025-03-02T00:00:00Z" duedate="2025-03-28 00:00:00.000"/>
    <Issue id="101" project="42" number="2" summary="이관 제외 업무" status="1" issuetype="3"
      created="2025-03-01T00:00:00Z" updated="2025-03-02T00:00:00Z"/>
    <CustomFieldValue id="51001" issue="100" customfield="42101" datevalue="2025-03-10 00:00:00.000"/>
    <CustomFieldValue id="51002" issue="100" customfield="42102" datevalue="2025-03-14 00:00:00.000"/>
    <Version id="4301" project="42" vname="이관할 배포" startdate="2025-03-01 00:00:00.0" releasedate="2025-03-24 00:00:00.0" released="false"/>
    <Version id="4302" project="42" vname="다른 후보" releasedate="2025-03-21 00:00:00.0" released="false"/>
    <NodeAssociation sourceNodeId="100" sourceNodeEntity="Issue" sinkNodeId="4301" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
    <NodeAssociation sourceNodeId="100" sourceNodeEntity="Issue" sinkNodeId="4302" sinkNodeEntity="Version" associationType="IssueFixVersion"/>
  </entity-engine-xml>`);
}

function confluenceArchive() {
  return archive(`<hibernate-generic>
    <object class="Space"><id name="id">50</id><property name="key">WIKI</property><property name="name">원본 위키</property></object>
    <object class="Page"><id name="id">501</id><property name="title">${wikiTitle}</property>
      <property name="version">1</property><property name="space" class="Space"><id name="id">50</id></property>
      <property name="creationDate">2025-03-01T00:00:00Z</property><property name="lastModificationDate">2025-03-02T00:00:00Z</property></object>
    <object class="BodyContent"><id name="id">601</id><property name="body"><![CDATA[<p>실제 복원 시험 본문</p>]]></property>
      <property name="content" class="Page"><id name="id">501</id></property></object>
  </hibernate-generic>`);
}

test('mapping transfer only binds exact re-staged source bytes and restores settings on a different workspace before separate apply', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  const jiraBytes = jiraArchive();
  const wikiBytes = confluenceArchive();
  const priorJira = await source.stage('jira', jiraInstance, 'jira-original.zip', jiraBytes);
  const priorWiki = await source.stage('confluence', confluenceInstance, 'wiki-original.zip', wikiBytes);
  const oldUser = await source.user('이전 워크스페이스 담당자', userEmail.toUpperCase());
  const original = await source.options([priorJira, priorWiki]);
  const author = original.identities.find(value => value.sourceValue === legacyUser);
  assert.ok(author);
  const configuration: MigrationConfiguration = {
    ...original.defaultConfiguration,
    projects: original.containers.map(container => ({ containerId: container.id,
      key: container.packageId === priorJira.id ? 'MAPPED' : 'KNOW', name: `이관 대상 ${container.name}` })),
    users: { ...original.defaultConfiguration.users, [author.id]: oldUser.id },
    statuses: Object.fromEntries(original.statuses.map(status => [status.id, 'review'])),
    issueTypes: Object.fromEntries(original.issueTypes.map(type => [type.id, '버그'])),
    sourceBaseUrls: { [priorJira.id]: 'https://jira.example.test/team', [priorWiki.id]: 'https://wiki.example.test/team' },
    timezone: 'Asia/Seoul', datePolicy: 'import-time',
    excludedRecords: [`${priorJira.id}/issue:101`], jiraReleaseSelections: { [`${priorJira.id}/issue:100`]: '4301' },
  };
  const mapping = await source.call<MigrationMappingFile>(exportPath, 'POST', { configuration });
  assert.equal(mapping.format, 'teamspace-migration-mapping');
  assert.equal(mapping.version, 1);
  assert.deepEqual(mapping.packages, [priorJira, priorWiki].map(value => ({
    id: value.id, sha256: value.sha256, product: value.source.product, instanceKey: value.source.instanceKey, format: value.source.format,
  })));
  assert.deepEqual(mapping.configuration, configuration);
  assert.deepEqual(mapping.mappedUsers, { [oldUser.id]: createHash('sha256').update(userEmail).digest('hex') });
  assert.ok(!JSON.stringify(mapping).includes(jiraTitle));
  assert.ok(!JSON.stringify(mapping).includes(wikiTitle));
  assert.ok(!JSON.stringify(mapping).toLowerCase().includes(userEmail));
  assert.deepEqual((await source.call<MigrationMappingRestore>(importPath, 'POST', { mapping })).configuration, configuration);

  await target.stage('jira', `${jiraInstance}-other`, 'jira-wrong-instance.zip', jiraBytes);
  await target.stage('jira', jiraInstance, 'jira-changed.zip', jiraArchive('바뀐 원본 업무'));
  const nextWiki = await target.stage('confluence', confluenceInstance, 'wiki-restaged.zip', wikiBytes);
  const snapshot = await target.snapshot();
  const missingPackage = await target.call<{ details: { reason: string } }>(importPath, 'POST', { mapping }, 409);
  assert.equal(missingPackage.details.reason, 'package_missing');
  assert.deepEqual(await target.snapshot(), snapshot);

  const nextJira = await target.stage('jira', jiraInstance, 'jira-restaged.zip', jiraBytes);
  assert.notEqual(nextJira.id, priorJira.id);
  assert.notEqual(nextWiki.id, priorWiki.id);
  const missingUser = await target.call<{ details: { reason: string } }>(importPath, 'POST', { mapping }, 409);
  assert.equal(missingUser.details.reason, 'mapped_user_missing');
  const newUser = await target.user('새 워크스페이스 담당자', userEmail);
  assert.notEqual(newUser.id, oldUser.id);

  const beforeRestore = await target.snapshot();
  const restored = await target.call<MigrationMappingRestore>(importPath, 'POST', { mapping });
  const options = await target.options([nextJira, nextWiki]);
  assert.deepEqual(restored.options, options);
  const newAuthor = options.identities.find(value => value.sourceValue === legacyUser);
  assert.ok(newAuthor);
  assert.notEqual(newAuthor.id, author.id);
  assert.deepEqual(restored.configuration, {
    ...options.defaultConfiguration,
    projects: options.containers.map(container => ({ containerId: container.id,
      key: container.packageId === nextJira.id ? 'MAPPED' : 'KNOW', name: `이관 대상 ${container.name}` })),
    users: { ...options.defaultConfiguration.users, [newAuthor.id]: newUser.id },
    statuses: Object.fromEntries(options.statuses.map(status => [status.id, 'review'])),
    issueTypes: Object.fromEntries(options.issueTypes.map(type => [type.id, '버그'])),
    sourceBaseUrls: { [nextJira.id]: 'https://jira.example.test/team', [nextWiki.id]: 'https://wiki.example.test/team' },
    timezone: configuration.timezone, datePolicy: configuration.datePolicy,
    excludedRecords: [`${nextJira.id}/issue:101`], jiraReleaseSelections: { [`${nextJira.id}/issue:100`]: '4301' },
  });
  assert.deepEqual(await target.snapshot(), beforeRestore);

  const reviewed = await target.preview(restored.configuration);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.deepEqual(reviewed.samples.find(sample => sample.title === jiraTitle)?.schedule, { startDate: '2025-03-10', endDate: '2025-03-14' });
  assert.ok(reviewed.samples.some(sample => sample.title === wikiTitle));
  assert.ok(!reviewed.samples.some(sample => sample.title === '이관 제외 업무'));
  assert.deepEqual(await target.snapshot(), beforeRestore);
  await target.apply(reviewed);
  const applied = await target.snapshot();
  const issue = applied.issues.find(value => value.title === jiraTitle);
  const wiki = applied.documents.find(value => value.title === wikiTitle);
  assert.ok(issue && wiki);
  assert.equal(issue.key, 'MAPPED-1');
  assert.equal(issue.assigneeId, newUser.id);
  assert.equal(issue.dueDate, '2025-03-28');
  assert.equal(applied.planningItems?.find(item => item.id === issue.releaseId)?.name, '이관할 배포');
  assert.equal(applied.projects.find(project => project.id === wiki.projectId)?.key, 'KNOW');
  assert.ok(!applied.issues.some(value => value.title === '이관 제외 업무'));
});

test('mapping transfer restores active Jira append choices only for the existing bound project', async t => {
  const f = await fixture(t);
  const original = await f.stage('jira', jiraInstance, 'jira-original.zip', jiraArchive());
  const initial = (await f.options([original])).defaultConfiguration;
  const firstPlan = await f.preview({ ...initial, timezone: 'Asia/Seoul',
    jiraReleaseSelections: { [`${original.id}/issue:100`]: '4301' } });
  assert.equal(firstPlan.canApply, true, JSON.stringify(firstPlan.notices));
  const { import: { projectIds: [projectId] } } = await f.apply(firstPlan);
  const appendedTitle = '복원한 매핑으로 추가한 Jira 업무';
  const bytes = Buffer.from(JSON.stringify({ issues: [{ id: '102', key: 'ORIG-3', fields: {
    project: { id: '42', key: 'ORIG', name: '원본 Jira 프로젝트' }, summary: appendedTitle,
    status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
    created: '2025-03-03T00:00:00Z', updated: '2025-03-04T00:00:00Z',
  } }] }));
  const staged = await f.stage('jira', jiraInstance, 'jira-update.json', bytes);
  const options = await f.options([staged]);
  assert.equal(options.appendTarget?.projectId, projectId);
  const workflowStatus = options.appendTarget?.statuses.find(status => status.label === 'Ready');
  const issueType = options.appendTarget?.issueTypes.find(type => type.name === 'Task');
  assert.ok(workflowStatus && issueType);
  const configuration: MigrationConfiguration = {
    ...options.defaultConfiguration, timezone: 'Asia/Seoul',
    appendTo: { projectId, refreshExisting: true,
      statuses: { [options.statuses[0].id]: workflowStatus.id }, issueTypes: { [options.issueTypes[0].id]: issueType.id }, fields: {},
    },
  };
  const exported = await f.call<MigrationMappingFile>(exportPath, 'POST', { configuration });
  assert.deepEqual(exported.configuration.appendTo, configuration.appendTo);
  await f.call(`/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`, 'DELETE');
  const restaged = await f.stage('jira', jiraInstance, 'jira-update-restaged.json', bytes);
  assert.notEqual(restaged.id, staged.id);
  const before = await f.snapshot();

  const wrong = structuredClone(exported);
  wrong.configuration.appendTo!.projectId = 'project-team';
  const rejected = await f.call<{ details: { reason: string } }>(importPath, 'POST', { mapping: wrong }, 409);
  assert.equal(rejected.details.reason, 'append_target_unavailable');
  assert.deepEqual(await f.snapshot(), before);

  const restored = await f.call<MigrationMappingRestore>(importPath, 'POST', { mapping: exported });
  assert.equal(restored.options.appendTarget?.projectId, projectId);
  assert.deepEqual(restored.configuration.appendTo, {
    ...configuration.appendTo,
    statuses: { [restored.options.statuses[0].id]: workflowStatus.id },
    issueTypes: { [restored.options.issueTypes[0].id]: issueType.id },
  });
  assert.deepEqual(restored.configuration.packageIds, [restaged.id]);
  assert.deepEqual(await f.snapshot(), before);
  const reviewed = await f.preview(restored.configuration);
  assert.equal(reviewed.canApply, true, JSON.stringify(reviewed.notices));
  assert.equal(reviewed.counts.issues, 1);
  const applied = await f.apply(reviewed);
  assert.deepEqual(applied.import.projectIds, [projectId]);
  const after = await f.snapshot();
  assert.deepEqual(after.projects, before.projects);
  const added = after.issues.find(issue => issue.title === appendedTitle);
  assert.ok(added);
  assert.equal(added.projectId, projectId);
  assert.equal(added.status, workflowStatus.id);
  assert.equal(added.type, issueType.id);
});
