import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { createApp } from '../../server/app.js';
import type {
  Dependency, Issue, IssueRelation, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, SourceImport, SourceReconciliationAudit, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';

const ACTOR = 'user-seo';
const INSTANCE = 'synthetic-jira-relation-refresh';
const CREATED = '2020-09-01T09:00:00Z';
const UPDATED = '2020-09-02T09:00:00Z';
const BLOCKS = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const RELATES = { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to' };

type Backup = WorkspaceSnapshot & { issueRelations: IssueRelation[]; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] };

function link(id: string, issueId: string, direction: 'inward' | 'outward' = 'outward', type = BLOCKS) {
  return { id, type, [`${direction}Issue`]: { id: issueId } };
}

function sourceIssue(id: string, links: ReturnType<typeof link>[] = [], sourceProject = 'OLD', title = `${sourceProject} 원본 ${id}`) {
  return { id, key: `${sourceProject}-${id}`, fields: {
    project: { id: sourceProject === 'OLD' ? '10100' : '20200', key: sourceProject, name: `${sourceProject} Jira 프로젝트` },
    summary: title, created: CREATED, updated: UPDATED, issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' },
    issuelinks: links,
  } };
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-relation-refresh-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally {
      runtime.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;

  async function request<T = unknown>(path: string, method = 'GET', input?: unknown, actor = ACTOR) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200) {
    const response = await request<T>(path, method, input);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  async function uploadBytes(filename: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: INSTANCE });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': ACTOR },
      body: new Uint8Array(bytes),
    });
    const summary = await response.json() as LegacyPackageSummary;
    assert.equal(response.status, 201, JSON.stringify(summary));
    return summary;
  }
  const upload = (name: string, issues: ReturnType<typeof sourceIssue>[]) =>
    uploadBytes(`${name}.json`, Buffer.from(JSON.stringify({ issues })));
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  const apply = (plan: MigrationPreview, actor = ACTOR) => request<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
    expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
  }, actor);
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const backup = () => call<Backup>('/export');
  const relations = (issue: Issue) => call<IssueRelation[]>(`/issues/${issue.id}/relations`);
  async function importInitial(issues: ReturnType<typeof sourceIssue>[], sharedProjectKey?: string) {
    const pkg = await upload('initial', issues);
    const { defaultConfiguration } = await options(pkg);
    if (sharedProjectKey) defaultConfiguration.projects = defaultConfiguration.projects.map(project =>
      ({ ...project, key: sharedProjectKey, name: '합쳐서 이관한 Jira 프로젝트' }));
    const plan = await preview(defaultConfiguration);
    assert.ok(plan.canApply, JSON.stringify(plan.notices));
    const applied = await apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    return applied.data.import;
  }
  async function appendConfiguration(pkg: LegacyPackageSummary): Promise<MigrationConfiguration> {
    const configuration = await options(pkg);
    const target = configuration.appendTarget;
    assert.ok(target && target.instanceKey === INSTANCE);
    return {
      ...configuration.defaultConfiguration,
      appendTo: {
        projectId: target.projectId,
        statuses: Object.fromEntries(configuration.statuses.map(row => [row.id, target.statuses.find(status => status.label === row.label)!.id])),
        issueTypes: Object.fromEntries(configuration.issueTypes.map(row => [row.id, target.issueTypes.find(type => type.name === row.label)!.id])),
        fields: Object.fromEntries(configuration.fields.map(row => [row.id, null])),
      },
    };
  }
  return { dataDir, call, upload, uploadBytes, preview, apply, workspace, backup, relations, importInitial, appendConfiguration };
}

function original(workspace: WorkspaceSnapshot, sourceId: string, project = 'OLD') {
  const result = workspace.issues.find(issue => issue.title === `${project} 원본 ${sourceId}`);
  assert.ok(result, `Missing migrated Jira issue ${project}-${sourceId}`);
  return result;
}

test('Jira follow-up explicitly imports one mirrored blocking link between existing issues and exposes its Gantt handoff', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100'), sourceIssue('200')]);

  const archivedOnly = await f.upload('new-issue-with-older-link', [
    sourceIssue('100', [link('301', '200')]), sourceIssue('300'),
  ]);
  const archivedPlan = await f.preview(await f.appendConfiguration(archivedOnly));
  assert.equal(archivedPlan.canApply, true, JSON.stringify(archivedPlan.notices));
  assert.equal(archivedPlan.counts.issues, 1);
  assert.equal(archivedPlan.counts.issueRelations, 0);
  const archivedImport = await f.apply(archivedPlan);
  assert.equal(archivedImport.status, 201, JSON.stringify(archivedImport.data));
  const previousRecord = (await f.backup()).sourceRecords.find(row =>
    row.sourceImportId === archivedImport.data.import.id && row.record.kind === 'relation' && row.record.sourceId === '301');
  assert.ok(previousRecord && !previousRecord.jiraRelationId);

  const before = await f.workspace();
  const blocker = original(before, '100');
  const blocked = original(before, '200');
  const delta = await f.upload('mirror-link-only', [sourceIssue('200', [link('301', '100', 'inward')]), sourceIssue('100', [link('301', '200')])]);
  const append = await f.appendConfiguration(delta);
  assert.equal((await f.preview(append)).canApply, false);
  await f.call('/migrations/preview', 'POST', { configuration: { ...append, appendTo: { ...append.appendTo, refreshRelations: false } } }, 400);
  append.appendTo!.refreshRelations = true;
  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.equal(review.counts.issues, 0);
  assert.equal(review.counts.retainedIssues, 2);
  assert.equal(review.counts.issueRelations, 1);
  assert.equal(review.counts.newJiraRelations, 1);
  assert.equal(review.counts.skippedJiraRelations, 0);
  assert.deepEqual(review.jiraRelationRefresh, [{ recordId: `${delta.id}/relation:301`, sourceKey: blocker.key, targetKey: blocked.key, type: 'Blocks' }]);
  assert.deepEqual(await f.relations(blocker), []);
  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const [relation] = await f.relations(blocker);
  assert.ok(relation);
  assert.deepEqual(await f.relations(blocked), [relation]);
  assert.deepEqual([relation.sourceIssueId, relation.targetIssueId, relation.type, relation.origin], [blocker.id, blocked.id, 'Blocks', undefined]);
  const after = await f.workspace();
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(after.dependencies, before.dependencies);
  const { id: importId, version } = applied.data.import;
  assert.equal(after.activities.filter(row => row.action === 'Jira 원본 변경분 반영' && row.resourceId === importId).length, 1);
  assert.deepEqual(after.activities.filter(row => row.action === 'Jira 업무 관계 이관').map(row => row.resourceId).sort(),
    [blocker.id, blocked.id].sort());
  const record = (await f.backup()).sourceRecords.find(row => row.sourceImportId === importId && row.record.sourceId === '301' && row.record.kind === 'relation');
  assert.equal(record?.jiraRelationId, relation.id);
  const proof = await f.call<SourceReconciliationAudit>(`/source-imports/${importId}/reconciliation/audit?expectedVersion=${version}`);
  assert.equal(proof.targetContent.issueRelations.count, 1);
  assert.match(proof.targetContent.issueRelations.sha256, /^[a-f0-9]{64}$/);
  const replay = await f.apply(review);
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.import.id, importId);
  assert.deepEqual(await f.relations(blocker), [relation]);
  assert.deepEqual((await f.workspace()).activities, after.activities);

  const dependency = await f.call<Dependency>(`/issues/${blocker.id}/relations/${relation.id}/schedule-dependency`, 'POST', {
    expectedVersion: relation.version, predecessorId: blocker.id, successorId: blocked.id, type: 'FS', lagDays: 0,
  }, 201);
  assert.deepEqual([dependency.predecessorId, dependency.successorId], [blocker.id, blocked.id]);
});

test('Jira follow-up skips existing equivalences and foreign endpoints, and a restored receipt prevents old link revival', async t => {
  const f = await fixture(t);
  await f.importInitial([
    sourceIssue('100', [link('401', '300', 'outward', RELATES)]), sourceIssue('200'), sourceIssue('300'), sourceIssue('900', [], 'OTHER'),
  ], 'RELATION');
  const current = await f.workspace();
  const a = original(current, '100');
  const b = original(current, '200');
  const foreign = original(current, '900', 'OTHER');
  assert.equal(a.projectId, foreign.projectId);
  const [olderImported] = await f.relations(a);
  assert.equal(olderImported.type, 'Relates');
  const native = await f.call<IssueRelation>(`/issues/${a.id}/relations`, 'POST', { otherIssueId: b.id, type: 'blocks', direction: 'outgoing' }, 201);
  const delta = await f.upload('mixed-links', [sourceIssue('100', [
    link('401', '300', 'outward', RELATES), link('402', '200', 'inward'), link('403', '200'), link('404', '900'), link('405', '999'),
  ])]);
  const append = await f.appendConfiguration(delta);
  append.appendTo!.refreshRelations = true;
  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.equal(review.counts.newJiraRelations, 1);
  assert.equal(review.counts.skippedJiraRelations, 4);
  assert.deepEqual(review.jiraRelationRefresh?.map(({ sourceKey, targetKey, type }) => [sourceKey, targetKey, type]), [[b.key, a.key, 'Blocks']]);
  const result = await f.apply(review);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const relations = await f.relations(a);
  assert.ok(relations.some(relation => relation.id === olderImported.id));
  assert.ok(relations.some(relation => relation.id === native.id));
  const imported = relations.find(relation => relation.sourceIssueId === b.id && relation.targetIssueId === a.id);
  assert.ok(imported);
  assert.equal(relations.length, 3);
  assert.deepEqual(await f.relations(foreign), []);
  const archived = (await f.backup()).sourceRecords.filter(row => row.sourceImportId === result.data.import.id && row.record.kind === 'relation');
  assert.deepEqual(archived.filter(row => row.jiraRelationId).map(row => [row.record.sourceId, row.jiraRelationId]), [['402', imported.id]]);

  const activeProof = await f.backup();
  await f.call('/import', 'POST', { data: activeProof });
  const restored = (await f.relations(a)).find(row => row.id === imported.id);
  assert.ok(restored);
  assert.deepEqual([restored.sourceIssueId, restored.targetIssueId, restored.type], [b.id, a.id, 'Blocks']);
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    assert.equal(db.prepare('DELETE FROM issue_relations WHERE id=?').run(imported.id).changes, 1);
  } finally { db.close(); }
  const removedProof = await f.backup();
  assert.ok(removedProof.sourceRecords.some(row => row.jiraRelationId === imported.id));
  await f.call('/import', 'POST', { data: removedProof });
  assert.ok((await f.backup()).sourceRecords.some(row => row.jiraRelationId === imported.id));

  const another = await f.upload('separate-repeated-export', [sourceIssue('200', [link('402', '300')], 'OLD', 'Jira에서 편집한 관계 소유자의 제목')]);
  const repeats = await f.appendConfiguration(another);
  repeats.appendTo!.refreshRelations = true;
  const repeated = await f.preview(repeats);
  assert.equal(repeated.canApply, false);
  assert.equal(repeated.counts.newJiraRelations, 0);
  assert.equal(repeated.counts.skippedJiraRelations, 1);
  assert.ok(repeated.notices.some(notice => notice.code === 'JIRA_REFRESH_NO_CHANGES'));
  assert.equal((await f.relations(a)).some(row => row.id === imported.id), false);
  assert.deepEqual((await f.relations(b)).map(row => row.id), [native.id]);
});

test('Jira relation review detects a concurrent native link and rolls back links and receipts on a late write failure', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100'), sourceIssue('200')]);
  const beforeReview = await f.workspace();
  const a = original(beforeReview, '100');
  const b = original(beforeReview, '200');
  const delta = await f.uploadBytes('sparse-relation-export.zip', zip([{ path: 'entities.xml', bytes: Buffer.from(`
    <entity-engine-xml version="9.12">
      <IssueLinkType id="10000" linkname="Blocks" inward="is blocked by" outward="blocks"/>
      <IssueLink id="501" linktype="10000" source="100" destination="200"/>
    </entity-engine-xml>`),
  }]));
  const append = await f.appendConfiguration(delta);
  append.appendTo!.refreshRelations = true;
  const stale = await f.preview(append);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  assert.equal(stale.counts.issues, 0);
  assert.equal(stale.counts.newJiraRelations, 1);
  const native = await f.call<IssueRelation>(`/issues/${a.id}/relations`, 'POST', { otherIssueId: b.id, type: 'blocks', direction: 'outgoing' }, 201);
  assert.equal((await f.apply(stale)).status, 409);
  assert.deepEqual(await f.relations(a), [native]);
  const duplicate = await f.preview(append);
  assert.equal(duplicate.canApply, false);
  assert.equal(duplicate.counts.skippedJiraRelations, 1);
  await f.call(`/issues/${a.id}/relations/${native.id}?expectedVersion=${native.version}`, 'DELETE');

  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  const beforeCommit = await f.backup();
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER synthetic_jira_relation_audit_failure BEFORE INSERT ON activities
      WHEN json_extract(NEW.json,'$.action')='Jira 원본 변경분 반영' AND json_extract(NEW.json,'$.resourceType')='source-import'
      BEGIN SELECT RAISE(ABORT, 'synthetic Jira relation audit failure'); END`);
    assert.equal((await f.apply(review)).status, 500);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS synthetic_jira_relation_audit_failure');
    db.close();
  }
  const afterFailure = await f.backup();
  assert.deepEqual(afterFailure.issues, beforeCommit.issues);
  assert.deepEqual(afterFailure.issueRelations, beforeCommit.issueRelations);
  assert.deepEqual(afterFailure.sourceImports, beforeCommit.sourceImports);
  assert.deepEqual(afterFailure.sourceRecords, beforeCommit.sourceRecords);
  assert.deepEqual(afterFailure.activities, beforeCommit.activities);
  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await f.relations(a)).length, 1);
  const { id, version } = applied.data.import;
  const proof = await f.call<SourceReconciliationAudit>(`/source-imports/${id}/reconciliation/audit?expectedVersion=${version}`);
  assert.equal(proof.targetContent.issueRelations.count, 1);
});

test('Jira follow-up archives link ID conflicts within and across packages while preserving separately proven links', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100'), sourceIssue('200'), sourceIssue('300'), sourceIssue('400')]);
  const before = await f.workspace();
  const a = original(before, '100');
  const b = original(before, '200');
  const c = original(before, '300');
  const d = original(before, '400');
  const delta = await f.upload('contradictory-mirror', [
    sourceIssue('100', [link('601', '200'), link('603', '200')]),
    sourceIssue('300', [link('601', '100', 'inward'), link('602', '400')]),
  ]);
  const another = await f.upload('conflict-in-another-package', [sourceIssue('100', [link('603', '900')])]);
  const append = await f.appendConfiguration(delta);
  append.appendTo!.refreshRelations = true;
  append.packageIds.push(another.id);
  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.ok(review.notices.some(notice => notice.code === 'SOURCE_JIRA_RELATION_RECORD_CONFLICT' && notice.severity === 'warning'));
  assert.ok(review.notices.some(notice => notice.code === 'JIRA_RELATION_ID_CONFLICT' && notice.severity === 'warning'));
  assert.equal(review.counts.newJiraRelations, 1);
  assert.equal(review.counts.skippedJiraRelations, 3);
  assert.deepEqual(review.jiraRelationRefresh, [{ recordId: `${delta.id}/relation:602`, sourceKey: c.key, targetKey: d.key, type: 'Blocks' }]);

  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.deepEqual(await f.relations(a), []);
  assert.deepEqual(await f.relations(b), []);
  const [relation] = await f.relations(c);
  assert.ok(relation);
  assert.equal(relation.targetIssueId, d.id);
  assert.deepEqual(await f.relations(d), [relation]);
  const archived = (await f.backup()).sourceRecords.filter(row => row.sourceImportId === applied.data.import.id && row.record.kind === 'relation');
  assert.deepEqual(archived.map(row => [row.record.sourceId, row.jiraRelationId ?? null]).sort(), [
    ['601', null], ['602', relation.id], ['603', null], ['603', null],
  ]);
});
