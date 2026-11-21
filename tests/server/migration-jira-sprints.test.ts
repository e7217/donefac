import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { CycleCompletionPreview, CycleCompletionResult, Issue, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, PlanningItem, SourceImport, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const instance = 'synthetic-jira-sprints';
const originalProject = '4100';
const sprintField = '10104';
const actor = 'user-seo';
const start = '2025-01-06';
const end = '2025-01-17';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-sprints-'));
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
  const origin = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(route: string, method = 'GET', input?: unknown, status = 200): Promise<T> {
    const response = await fetch(origin + route, {
      method,
      headers: { 'X-Actor-Id': actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${raw}`);
    return JSON.parse(raw) as T;
  }
  async function upload(filename: string, bytes: Buffer): Promise<LegacyPackageSummary> {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: instance });
    const response = await fetch(`${origin}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'X-Actor-Id': actor, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const raw = await response.text();
    assert.equal(response.status, 201, raw);
    return JSON.parse(raw) as LegacyPackageSummary;
  }
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  const apply = <T = MigrationApplyResult>(plan: MigrationPreview, status = 201) =>
    call<T>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, status);
  return { dataDir, call, upload, options, preview, apply };
}

function adminPackage(): Buffer {
  const issue = (id: string, number: number, title: string) => `<Issue id="${id}" project="${originalProject}" number="${number}" summary="${title}"
    status="1" issuetype="3" created="2025-01-01T00:00:00Z" updated="2025-01-02T00:00:00Z"/>`;
  const hasSprint = (id: number, issueId: string, sprintId: string) =>
    `<CustomFieldValue id="${id}" issue="${issueId}" customfield="${sprintField}" stringvalue="${sprintId}"/>`;
  const hasFixVersion = (versionId: string) =>
    `<NodeAssociation sourceNodeId="4402" sourceNodeEntity="Issue" sinkNodeId="${versionId}" sinkNodeEntity="Version" associationType="IssueFixVersion"/>`;
  const sprint = (id: string, name: string, isClosed: boolean) => `<row><integer>${id}</integer><string>${name}</string>
    <long>${Date.parse(start)}</long><long>${Date.parse(end)}</long><boolean>true</boolean><boolean>${isClosed}</boolean>
    <integer>53</integer></row>`;
  const entities = `<entity-engine-xml version="9.12"><Project id="${originalProject}" pkey="JIRA" name="스프린트 원본"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <CustomField id="${sprintField}" cfname="Sprint" customfieldtypekey="com.pyxis.greenhopper.jira:gh-sprint"/>
    <Version id="6301" project="${originalProject}" vname="통합 계획" released="false"/>
    <Version id="6302" project="${originalProject}" vname="별도 릴리스" released="false"/>
    ${issue('4401', 1, '과거 이력과 진행 스프린트')}${issue('4402', 2, '후보가 있는 업무')}
    ${hasSprint(1, '4401', '5101')}${hasSprint(2, '4401', '5102')}
    ${hasSprint(3, '4402', '5102')}${hasSprint(4, '4402', '5103')}
    ${hasFixVersion('6301')}${hasFixVersion('6302')}</entity-engine-xml>`;
  const activeObjects = `<backup xmlns="http://www.atlassian.com/ao"><data tableName="AO_60DB71_SPRINT">
    <column name="ID"/><column name="NAME"/><column name="START_DATE"/><column name="END_DATE"/>
    <column name="STARTED"/><column name="CLOSED"/><column name="RAPID_VIEW_ID"/>
    ${sprint('5101', '지난 사이클', true)}${sprint('5102', '통합 계획', false)}${sprint('5103', '선택할 사이클', false)}
    </data></backup>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(entities) }, { path: 'activeobjects.xml', bytes: Buffer.from(activeObjects) }]);
}

function restPackage(): Buffer {
  const task = (id: string, number: number, title: string, sprintId: number, name: string, state: string) => ({
    id, key: `JIRA-${number}`, fields: {
      project: { key: 'JIRA', name: '스프린트 원본' }, summary: title,
      created: '2025-02-01T00:00:00Z', updated: '2025-02-02T00:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      sprint: { id: sprintId, name, state, startDate: '2025-02-10', endDate: '2025-02-21', originBoardId: 53 },
    },
  });
  return Buffer.from(JSON.stringify({ issues: [
    task('4401', 1, '과거 이력과 진행 스프린트', 5102, 'Jira에서 바뀐 이름', 'active'),
    task('4403', 3, '기존 사이클에 붙일 업무', 5102, 'Jira에서 바뀐 이름', 'active'),
    task('4404', 4, '새 사이클에 붙일 업무', 5104, '새 REST 사이클', 'future'),
  ] }));
}

test('Jira sprint and version choices survive restore and append preserves team plans with independent concurrency guards', async t => {
  const f = await fixture(t);
  const pkg = await f.upload('sprint-admin.zip', adminPackage());
  const { defaultConfiguration } = await f.options(pkg);
  const config = { ...defaultConfiguration, timezone: 'Asia/Seoul' };
  const choice = `${pkg.id}/issue:4402`;
  await f.call('/migrations/preview', 'POST', { configuration: {
    ...config, jiraSprintSelections: { [`${pkg.id}/page:4402`]: '5103' },
  } }, 400);
  const initial = await f.preview(config);
  assert.deepEqual(initial.jiraSprintChoices?.find(value => value.recordId === choice)?.candidates.map(value => value.sourceId).sort(), ['5102', '5103']);
  assert.deepEqual(initial.jiraReleaseChoices?.find(value => value.recordId === choice)?.candidates.map(value => value.sourceId).sort(), ['6301', '6302']);
  const reviewed = await f.preview({ ...config, jiraSprintSelections: { [choice]: '5103' }, jiraReleaseSelections: { [choice]: '6301' } });
  assert.ok(reviewed.canApply, JSON.stringify(reviewed.notices));
  const { import: receipt } = await f.apply(reviewed);
  const [projectId] = receipt.projectIds;
  const snapshot = async () => f.call<WorkspaceSnapshot>('/workspace');
  const plan = async (kind: string, name: string) => {
    const item = (await snapshot()).planningItems?.find(value => value.projectId === projectId && value.kind === kind && value.name === name);
    assert.ok(item, name);
    return item;
  };
  const issue = async (title: string) => {
    const item = (await snapshot()).issues.find(value => value.projectId === projectId && value.title === title);
    assert.ok(item, title);
    return item;
  };
  const [active, previous, selected, release] = await Promise.all([
    plan('cycle', '통합 계획'), plan('cycle', '지난 사이클'), plan('cycle', '선택할 사이클'), plan('release', '통합 계획'),
  ]);
  const sprintIdentity = createHash('sha256').update(JSON.stringify([instance, '5102', projectId])).digest('hex');
  assert.equal(active.id, `jira_sprint_${sprintIdentity}`);
  assert.equal(active.status, 'active');
  assert.equal(active.startDate, start);
  assert.equal(active.endDate, end);
  assert.equal(previous.status, 'completed');
  const first = await issue('과거 이력과 진행 스프린트');
  assert.equal(first.cycleId, active.id);
  const another = await issue('후보가 있는 업무');
  assert.equal(another.cycleId, selected.id);
  assert.equal(another.releaseId, release.id);

  await f.call<Issue>(`/issues/${first.id}`, 'PATCH', { expectedVersion: first.version, cycleId: selected.id });
  await f.call<PlanningItem>(`/planning-items/${active.id}`, 'PATCH', { expectedVersion: active.version, name: '팀이 바꾼 사이클' });
  await f.call('/import', 'POST', { data: await f.call('/export') });
  const restored = (await f.call<SourceImport[]>('/source-imports')).find(value => value.id === receipt.id);
  assert.deepEqual(restored?.configuration.jiraSprintSelections, { [choice]: '5103' });
  assert.deepEqual(restored?.configuration.jiraReleaseSelections, { [choice]: '6301' });
  assert.equal((await issue('후보가 있는 업무')).cycleId, selected.id);

  const additional = await f.upload('sprint-append.json', restPackage());
  const options = await f.options(additional);
  assert.equal(options.appendTarget?.projectId, projectId);
  assert.ok(options.appendTarget);
  const { statuses, issueTypes } = options.appendTarget;
  const appendConfig: MigrationConfiguration = {
    ...options.defaultConfiguration, timezone: 'Asia/Seoul',
    appendTo: { projectId, refreshExisting: true,
      statuses: Object.fromEntries(options.statuses.map(value => [value.id, statuses.find(state => state.label === value.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(value => [value.id, issueTypes.find(type => type.name === value.label)!.id])),
      fields: {},
    },
  };
  const stale = await f.preview(appendConfig);
  assert.ok(stale.canApply, JSON.stringify(stale.notices));
  const renamed = await plan('cycle', '팀이 바꾼 사이클');
  await f.call<PlanningItem>(`/planning-items/${active.id}`, 'PATCH', { expectedVersion: renamed.version, endDate: '2025-01-21' });
  assert.match((await f.apply<{ error: string }>(stale, 409)).error, /사이클이 변경/);
  const fresh = await f.preview(appendConfig);
  assert.ok(fresh.canApply, JSON.stringify(fresh.notices));
  const currentRelease = await plan('release', '통합 계획');
  await f.call<PlanningItem>(`/planning-items/${release.id}`, 'PATCH', { expectedVersion: currentRelease.version, targetDate: '2025-02-25' });

  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_jira_sprint_issue BEFORE INSERT ON issues
      WHEN json_extract(NEW.json,'$.title')='새 사이클에 붙일 업무'
      BEGIN SELECT RAISE(ABORT,'synthetic sprint issue write failure'); END`);
    await f.apply(fresh, 500);
    assert.equal((await snapshot()).planningItems?.some(value => value.name === '새 REST 사이클'), false);
    assert.equal((await snapshot()).issues.some(value => value.title === '기존 사이클에 붙일 업무'), false);
    assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).map(value => value.id), [receipt.id]);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_jira_sprint_issue');
    db.close();
  }
  await f.apply(fresh);
  const reuse = await issue('기존 사이클에 붙일 업무');
  assert.equal(reuse.cycleId, active.id);
  assert.equal(reuse.cycle, '팀이 바꾼 사이클');
  assert.equal((await issue('과거 이력과 진행 스프린트')).cycleId, selected.id);
  assert.equal((await plan('cycle', '팀이 바꾼 사이클')).endDate, '2025-01-21');
  assert.equal((await issue('새 사이클에 붙일 업무')).cycleId, (await plan('cycle', '새 REST 사이클')).id);
  assert.equal((await snapshot()).planningItems?.filter(value => value.projectId === projectId && value.kind === 'cycle').length, 4);
});

test('a shared Jira sprint is scoped to each destination project and repeated names stay distinct', async t => {
  const f = await fixture(t);
  const title = 'Iteration';
  const task = (project: string, number: number, sprintId: number, boardId: number) => ({
    id: `${project}-id-${number}`, key: `${project}-${number}`, fields: {
      project: { key: project, name: project }, summary: `${project} 업무 ${number}`,
      created: '2025-01-01T00:00:00Z', updated: '2025-01-02T00:00:00Z',
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
      sprint: { id: sprintId, name: title, state: 'active', startDate: start, endDate: end, originBoardId: boardId },
    },
  });
  const input = await f.upload('shared-board-sprints.json', Buffer.from(JSON.stringify({ issues: [
    task('AAA', 1, 5102, 53), task('AAA', 2, 5103, 54), task('BBB', 1, 5102, 53),
  ] })));
  const { defaultConfiguration } = await f.options(input);
  const preview = await f.preview(defaultConfiguration);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.counts.jiraSprints, 3);
  assert.equal(preview.counts.jiraSprintLinks, 3);
  await f.apply(preview);

  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  const a = snapshot.projects.find(project => project.key === 'AAA')!;
  const b = snapshot.projects.find(project => project.key === 'BBB')!;
  const aCycles = snapshot.planningItems!.filter(item => item.projectId === a.id && item.kind === 'cycle');
  const bCycles = snapshot.planningItems!.filter(item => item.projectId === b.id && item.kind === 'cycle');
  assert.deepEqual(aCycles.map(item => item.name).sort(), [`${title} (#5102)`, `${title} (#5103)`]);
  assert.deepEqual(bCycles.map(item => item.name), [title]);
  const allCycles = new Map([...aCycles, ...bCycles].map(item => [item.id, item]));
  const migrated = snapshot.issues.filter(issue => issue.projectId === a.id || issue.projectId === b.id);
  assert.equal(new Set(migrated.map(issue => issue.cycleId)).size, 3);
  for (const issue of migrated) assert.equal(allCycles.get(issue.cycleId!)?.projectId, issue.projectId);

  const source = aCycles.find(item => item.name === `${title} (#5102)`)!;
  const destination = aCycles.find(item => item.name === `${title} (#5103)`)!;
  const path = `/planning-items/${source.id}/complete`;
  const review = await f.call<CycleCompletionPreview>(`${path}/preview`, 'POST', {
    expectedVersion: source.version, destinationId: destination.id,
  });
  assert.ok(review.previewId);
  const carried = migrated.find(issue => issue.cycleId === source.id)!;
  assert.deepEqual(review.issues.map(issue => [issue.id, issue.disposition]), [[carried.id, 'carry']]);
  const result = await f.call<CycleCompletionResult>(path, 'POST', { previewId: review.previewId });
  assert.equal(result.cycle.status, 'completed');
  assert.equal(result.destination?.id, destination.id);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  const moved = after.issues.find(issue => issue.id === carried.id)!;
  assert.deepEqual(moved, { ...carried, cycle: destination.name, cycleId: destination.id,
    version: carried.version + 1, updatedAt: moved.updatedAt });
  const otherProjectIssue = migrated.find(issue => issue.projectId === b.id)!;
  assert.deepEqual(after.issues.find(issue => issue.id === otherProjectIssue.id), otherProjectIssue);
});
