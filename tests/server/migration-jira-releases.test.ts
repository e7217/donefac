import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview,
  PlanningItem, SavedView, SourceImport, WorkspaceSnapshot,
} from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const sourceInstance = 'synthetic-jira-releases';
const sourceProjectId = '4200';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-releases-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const actor = { 'X-Actor-Id': 'user-seo' };
  async function call<T = unknown>(route: string, method = 'GET', input?: unknown, status = 200): Promise<T> {
    const response = await fetch(base + route, {
      method, headers: { ...actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const bytes = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${bytes}`);
    return JSON.parse(bytes) as T;
  }
  async function upload(bytes: Buffer, filename: string): Promise<LegacyPackageSummary> {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: sourceInstance });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const content = await response.text();
    assert.equal(response.status, 201, content);
    return JSON.parse(content) as LegacyPackageSummary;
  }
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  const apply = (plan: MigrationPreview, status = 201) => call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
    expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
  }, status);
  return { call, upload, options, preview, apply, dataDir };
}

function adminPackage(): Buffer {
  const issue = (id: number, number: number, title: string) => `<Issue id="${id}" project="${sourceProjectId}" number="${number}" summary="${title}"
    status="1" issuetype="3" created="2025-01-01T00:00:00Z" updated="2025-01-02T00:00:00Z"/>`;
  const link = (issueId: number, versionId: number, kind = 'IssueFixVersion') =>
    `<NodeAssociation sourceNodeId="${issueId}" sourceNodeEntity="Issue" sinkNodeId="${versionId}" sinkNodeEntity="Version" associationType="${kind}"/>`;
  const xml = `<entity-engine-xml version="9.12">
    <Project id="${sourceProjectId}" pkey="JIRA" name="릴리스 원본"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <Version id="4301" project="${sourceProjectId}" vname="배포 예정" startdate="2025-01-02 00:00:00.0" releasedate="2025-01-24 00:00:00.0" released="false"/>
    <Version id="4302" project="${sourceProjectId}" vname="과거 배포" releasedate="2024-12-24 00:00:00.0" released="true" archived="true"/>
    <Version id="4303" project="${sourceProjectId}" vname="문제 발견 버전" released="false"/>
    ${issue(4401, 1, '한 버전 업무')}
    ${issue(4402, 2, '복수 버전 업무')}
    ${issue(4403, 3, '과거 버전 업무')}
    ${issue(4404, 4, '영향 버전 업무')}
    ${link(4401, 4301)}${link(4402, 4301)}${link(4402, 4302)}${link(4403, 4302)}
    ${link(4404, 4303, 'IssueVersion')}
  </entity-engine-xml>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
}

function restPackage(): Buffer {
  const make = (id: string, key: string, name: string, fixVersions: object[]) => ({
    id, key, fields: {
      project: { key: 'JIRA', name: '릴리스 원본' },
      summary: name, created: '2025-02-01T00:00:00Z', updated: '2025-02-02T00:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, fixVersions,
    },
  });
  return Buffer.from(JSON.stringify({ issues: [
    make('4405', 'JIRA-5', '추가 업무', [
      { id: '4301', name: '배포 예정', released: true, archived: false, releaseDate: '2025-03-15' },
    ]),
    make('4406', 'JIRA-6', '보관 릴리스에 추가할 업무', [
      { id: '4302', name: '과거 배포', released: true, archived: true, releaseDate: '2024-12-24' },
    ]),
  ] }));
}

test('Jira release links and choices survive native restore and reviewed append checks', async t => {
  const f = await fixture(t);
  const pkg = await f.upload(adminPackage(), 'admin-release.zip');
  const { defaultConfiguration } = await f.options(pkg);
  const configuration = { ...defaultConfiguration, timezone: 'Asia/Seoul' };
  const choice = `${pkg.id}/issue:4402`;
  await f.call('/migrations/preview', 'POST', { configuration: {
    ...configuration, jiraReleaseSelections: { [`${pkg.id}/page:4402`]: '4301' },
  } }, 400);
  const initial = await f.preview(configuration);
  const candidates = initial.jiraReleaseChoices?.find(value => value.recordId === choice)?.candidates;
  assert.deepEqual(candidates?.map(value => value.sourceId).sort(), ['4301', '4302']);
  const reviewed = await f.preview({ ...configuration, jiraReleaseSelections: { [choice]: '4301' } });
  assert.ok(reviewed.canApply, JSON.stringify(reviewed.notices));
  const applied = await f.apply(reviewed);
  const [projectId] = applied.import.projectIds;
  assert.deepEqual(applied.import.configuration.jiraReleaseSelections, { [choice]: '4301' });

  const snapshot = async () => f.call<WorkspaceSnapshot>('/workspace');
  const item = async (name: string) => {
    const plan = (await snapshot()).planningItems?.find(value => value.projectId === projectId && value.name === name);
    assert.ok(plan, name);
    return plan;
  };
  const issue = async (title: string) => {
    const ticket = (await snapshot()).issues.find(value => value.projectId === projectId && value.title === title);
    assert.ok(ticket, title);
    return ticket;
  };
  const release = await item('배포 예정');
  assert.match(release.id, /^jira_release_[a-f0-9]{64}$/);
  assert.equal(release.status, 'planned');
  assert.equal(release.startDate, '2025-01-02');
  assert.equal(release.targetDate, '2025-01-24');
  const historical = await item('과거 배포');
  assert.equal(historical.status, 'archived');
  assert.equal((await issue('한 버전 업무')).releaseId, release.id);
  assert.equal((await issue('복수 버전 업무')).releaseId, release.id);
  assert.equal((await issue('과거 버전 업무')).releaseId, historical.id);
  assert.equal((await issue('영향 버전 업무')).releaseId, null);
  const reviewView = (jql: string) => f.call<JiraSavedViewPreview>('/views/jira/preview', 'POST', { projectId, jql });
  assert.deepEqual((await reviewView('project = JIRA AND fixVersion = 4301')).filters.planning, { releaseId: release.id });
  assert.deepEqual((await reviewView('fixVersion = "배포 예정"')).issues.map(row => row.title).sort(), ['복수 버전 업무', '한 버전 업무']);
  assert.deepEqual((await reviewView('fixVersion IS NULL')).issues.map(row => row.title), ['영향 버전 업무']);
  assert.deepEqual((await reviewView('fixVersion IS NOT EMPTY')).filters.planning, { releaseFilter: { kind: 'assigned' } });
  const loss = await f.call<{ error: string }>('/views/jira/preview', 'POST', { projectId, jql: 'fixVersion = 4302' }, 400);
  assert.match(loss.error, /대표 릴리스의 결과가 다릅니다/u);
  const jql = 'fixVersion IN (4301, "과거 배포") AND due IS EMPTY';
  const viewInput = { projectId, jql, name: '릴리스 공유 보기', layout: 'list', acceptProjectOrder: false };
  const viewReview = await reviewView(jql);
  assert.deepEqual(viewReview.filters.planning, { releaseFilter: { kind: 'any', ids: [release.id, historical.id].sort() }, dates: { mode: 'due_missing' } });
  assert.equal(viewReview.total, 3);
  const existing = await issue('한 버전 업무');
  await f.call(`/issues/${existing.id}`, 'PATCH', { expectedVersion: existing.version, releaseId: historical.id }, 422);
  await f.call(`/planning-items/${release.id}`, 'PATCH', { expectedVersion: release.version, name: '팀의 배포 계획' });
  await f.call('/views/jira/import', 'POST', { ...viewInput, revision: viewReview.revision }, 409);
  const freshViewReview = await reviewView(jql);
  assert.equal(freshViewReview.total, 3);
  assert.match(freshViewReview.criteria.find(criterion => criterion.field === 'fixVersion')!.label, /팀의 배포 계획/u);
  const saved = await f.call<SavedView>('/views/jira/import', 'POST', { ...viewInput, revision: freshViewReview.revision }, 201);
  assert.deepEqual(saved.filters, freshViewReview.filters);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, 126);
  await f.call('/import', 'POST', { data: { ...backup, schemaVersion: 125 } }, 400);
  await f.call('/import', 'POST', { data: backup });
  assert.deepEqual((await f.call<SavedView[]>(`/views?projectId=${projectId}`)).find(view => view.id === saved.id)?.filters, saved.filters);
  const imports = await f.call<SourceImport[]>('/source-imports');
  assert.deepEqual(imports.find(value => value.id === applied.import.id)?.configuration.jiraReleaseSelections, { [choice]: '4301' });
  const renamed = await item('팀의 배포 계획');
  assert.equal(renamed.id, release.id);
  assert.equal((await issue('과거 버전 업무')).releaseId, historical.id);

  const additional = await f.upload(restPackage(), 'later-release.json');
  const options = await f.options(additional);
  const target = options.appendTarget;
  assert.equal(target?.projectId, projectId);
  assert.ok(target);
  const appendConfiguration = {
    ...options.defaultConfiguration, timezone: 'Asia/Seoul',
    appendTo: {
      projectId,
      statuses: Object.fromEntries(options.statuses.map(state => [state.id, target.statuses.find(value => value.label === state.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(type => [type.id, target.issueTypes.find(value => value.name === type.label)!.id])),
      fields: {},
    },
  };
  const stale = await f.preview(appendConfiguration);
  assert.ok(stale.canApply, JSON.stringify(stale.notices));
  await f.call(`/planning-items/${release.id}`, 'PATCH', { expectedVersion: renamed.version, targetDate: '2025-03-02' });
  await f.apply(stale, 409);
  assert.equal((await snapshot()).issues.some(value => value.title === '추가 업무'), false);
  const fresh = await f.preview(appendConfiguration);
  assert.ok(fresh.canApply, JSON.stringify(fresh.notices));
  await f.apply(fresh);
  const additionalIssue = await issue('추가 업무');
  assert.equal(additionalIssue.releaseId, release.id);
  assert.equal(additionalIssue.release, '팀의 배포 계획');
  assert.equal((await issue('보관 릴리스에 추가할 업무')).releaseId, null);
  await f.call('/views/jira/preview', 'POST', { projectId, jql }, 400);
  assert.equal((await reviewView('fixVersion = 4301')).total, 3);
  const final = await item('팀의 배포 계획');
  assert.equal(final.targetDate, '2025-03-02');
  assert.equal(final.status, 'planned');
  await f.call(`/issues/${additionalIssue.id}`, 'PATCH', { expectedVersion: additionalIssue.version, releaseId: null });
  const changedLocally = await f.call<{ error: string }>('/views/jira/preview', 'POST', { projectId, jql: 'fixVersion = 4301' }, 400);
  assert.match(changedLocally.error, /팀에서 변경한 릴리스/u);
});

test('a Jira migration rolls back new release plans when an issue write fails', async t => {
  const f = await fixture(t);
  const pkg = await f.upload(adminPackage(), 'release-rollback.zip');
  const { defaultConfiguration } = await f.options(pkg);
  const plan = await f.preview(defaultConfiguration);
  assert.ok(plan.canApply, JSON.stringify(plan.notices));
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_jira_issue BEFORE INSERT ON issues
      WHEN json_extract(NEW.json,'$.title')='한 버전 업무'
      BEGIN SELECT RAISE(ABORT,'synthetic Jira issue write failure'); END`);
    await f.apply(plan, 500);
    const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
    assert.equal(snapshot.projects.some(project => project.key === 'JIRA'), false);
    assert.equal(snapshot.planningItems?.some(item => item.name === '배포 예정'), false);
    assert.deepEqual(await f.call('/source-imports'), []);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_jira_issue');
    db.close();
  }
  const { import: receipt } = await f.apply(plan);
  const releases = await f.call<PlanningItem[]>(`/planning-items?projectId=${receipt.projectIds[0]}&kind=release`);
  assert.ok(releases.some(item => item.name === '배포 예정'));
});
