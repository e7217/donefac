import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { createApp } from '../../server/app.js';
import type {
  ApiKeyCreated, AutomaticSchedulePreview, DeliveryBlockerDraftResult, DeliveryBlockerReport, Dependency, Issue, IssueRelation,
  IssueRelationView, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, PlanningItem,
  ProjectWorkflow, ScheduleAnchorChange, ScheduleBlockerLinkPage, SchedulePasteApplyResult, SchedulePastePreview, SourceImport, SourceReconciliationAudit,
  SourceRecordArchive, TeamScheduleBlocker,
  WorkCalendar, WorkspaceSnapshot,
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

  async function request<T = unknown>(path: string, method = 'GET', input?: unknown, actor = ACTOR, token?: string) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200) {
    const response = await request<T>(path, method, input);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  async function uploadBytes(filename: string, bytes: Buffer, instanceKey = INSTANCE) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': ACTOR },
      body: new Uint8Array(bytes),
    });
    const summary = await response.json() as LegacyPackageSummary;
    assert.equal(response.status, 201, JSON.stringify(summary));
    return summary;
  }
  const upload = (name: string, issues: ReturnType<typeof sourceIssue>[], instanceKey = INSTANCE) =>
    uploadBytes(`${name}.json`, Buffer.from(JSON.stringify({ issues })), instanceKey);
  const options = (pkg: LegacyPackageSummary) => call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  const apply = (plan: MigrationPreview, actor = ACTOR) => request<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
    expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
  }, actor);
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const backup = () => call<Backup>('/export');
  async function relations(issue: Issue): Promise<IssueRelation[]> {
    const projected = await call<IssueRelationView[]>(`/issues/${issue.id}/relations`);
    // Existing migration checks compare the archived fields across both ends.
    for (const relation of projected) delete relation.verifiedBlockerDirection;
    return projected;
  }
  async function importInitial(issues: ReturnType<typeof sourceIssue>[], sharedProjectKey?: string, instanceKey = INSTANCE) {
    const pkg = await upload('initial', issues, instanceKey);
    const { defaultConfiguration } = await options(pkg);
    if (sharedProjectKey) defaultConfiguration.projects = defaultConfiguration.projects.map(project =>
      ({ ...project, key: sharedProjectKey, name: `${sharedProjectKey} 이관 프로젝트` }));
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
  return { dataDir, call, request, upload, uploadBytes, options, preview, apply, workspace, backup, relations, importInitial, appendConfiguration };
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

test('Jira relation-only follow-up links separately migrated projects using exact Jira origin identities', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100')], 'ALPHA');
  await f.importInitial([sourceIssue('200', [], 'OTHER')], 'BRAVO');
  const foreignCollisionTitle = '다른 Jira에서 같은 숫자 ID를 쓰는 업무';
  await f.importInitial([sourceIssue('200', [], 'OTHER', foreignCollisionTitle), sourceIssue('900', [], 'OTHER')], 'FOREIGN', `${INSTANCE}-foreign`);

  const initial = await f.workspace();
  const a = original(initial, '100');
  const b = original(initial, '200', 'OTHER');
  const foreign = original(initial, '900', 'OTHER');
  const foreignCollision = initial.issues.find(issue => issue.title === foreignCollisionTitle)!;
  const aProject = initial.projects.find(project => project.id === a.projectId)!;
  const bProject = initial.projects.find(project => project.id === b.projectId)!;
  assert.notEqual(a.projectId, b.projectId);
  assert.notEqual(b.projectId, foreign.projectId);

  const delta = await f.upload('A-follow-up-with-no-new-tickets', [sourceIssue('100', [
    link('701', '200'), link('702', '900'), link('703', '200', 'outward', RELATES),
  ])]);
  const append = await f.appendConfiguration(delta);
  assert.equal(append.appendTo!.projectId, a.projectId);
  append.appendTo!.refreshRelations = true;
  append.excludedRecords.push(`${delta.id}/relation:703`);

  const stale = await f.preview(append);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  const edited = await f.call<Issue>(`/issues/${b.id}`, 'PATCH', { expectedVersion: b.version, title: 'B에서 편집한 제목' });
  assert.equal((await f.apply(stale)).status, 409);
  assert.deepEqual(await f.relations(a), []);

  const beforeApply = await f.workspace();
  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.equal(review.counts.issues, 0);
  assert.equal(review.counts.issueRelations, 1);
  assert.equal(review.counts.newJiraRelations, 1);
  assert.equal(review.counts.skippedJiraRelations, 1);
  assert.deepEqual(review.jiraRelationRefresh, [{
    recordId: `${delta.id}/relation:701`, sourceKey: a.key, targetKey: b.key, type: 'Blocks',
    sourceProjectName: aProject.name, targetProjectName: bProject.name,
  }]);
  assert.ok(review.notices.some(notice => notice.code === 'JIRA_RELATION_SCOPE_UNRESOLVED' && notice.recordId === `${delta.id}/relation:702`));
  assert.deepEqual(await f.relations(b), []);

  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  assert.deepEqual(new Set(receipt.projectIds), new Set([a.projectId, b.projectId]));
  const [imported] = await f.relations(a);
  assert.ok(imported);
  assert.deepEqual([imported.sourceIssueId, imported.targetIssueId, imported.type, imported.origin], [a.id, b.id, 'Blocks', undefined]);
  assert.deepEqual(await f.relations(b), [imported]);
  assert.deepEqual(await f.relations(foreign), []);
  assert.deepEqual(await f.relations(foreignCollision), []);
  const workspace = await f.workspace();
  assert.deepEqual(workspace.issues, beforeApply.issues);
  assert.deepEqual(workspace.issues.find(issue => issue.id === b.id), edited);
  assert.deepEqual(workspace.dependencies, beforeApply.dependencies);
  const backup = await f.backup();
  const records = backup.sourceRecords.filter(row => row.sourceImportId === receipt.id && row.record.kind === 'relation');
  assert.deepEqual(records.map(row => [row.record.sourceId, row.jiraRelationId ?? null, row.excluded ?? false]).sort(), [
    ['701', imported.id, false], ['702', null, false], ['703', null, true],
  ]);
  const auditPath = `/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`;
  const proof = await f.call<SourceReconciliationAudit>(auditPath);
  assert.equal(proof.targetContent.issueRelations.count, 1);
  assert.match(proof.targetContent.issueRelations.sha256, /^[a-f0-9]{64}$/);

  const replay = await f.apply(review);
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.import.id, receipt.id);
  const incomplete = structuredClone(backup);
  incomplete.sourceImports.find(row => row.id === receipt.id)!.projectIds = [a.projectId];
  await f.call('/import', 'POST', { data: incomplete }, 400);
  const expanded = structuredClone(backup);
  expanded.sourceImports.find(row => row.id === receipt.id)!.projectIds.push(foreign.projectId);
  await f.call('/import', 'POST', { data: expanded }, 400);
  assert.deepEqual(await f.relations(b), [imported]);
  await f.call('/import', 'POST', { data: backup });
  assert.deepEqual(await f.relations(a), [imported]);
  assert.deepEqual(await f.relations(b), [imported]);
  const restored = (await f.call<SourceImport[]>('/source-imports')).find(row => row.id === receipt.id)!;
  assert.ok(restored.version > receipt.version);
  const restoredAudit = await f.call<SourceReconciliationAudit>(`/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${restored.version}`);
  assert.deepEqual(restoredAudit.targetContent.issueRelations, proof.targetContent.issueRelations);

  const repeated = await f.upload('B-follow-up-mirrored-side', [sourceIssue('200', [link('701', '100', 'inward'), link('704', '100', 'inward')], 'OTHER')]);
  const repeat = await f.appendConfiguration(repeated);
  assert.equal(repeat.appendTo!.projectId, b.projectId);
  repeat.appendTo!.refreshRelations = true;
  const noChanges = await f.preview(repeat);
  assert.equal(noChanges.canApply, false);
  assert.equal(noChanges.counts.newJiraRelations, 0);
  assert.equal(noChanges.counts.skippedJiraRelations, 2);
  assert.deepEqual(await f.relations(a), [imported]);

  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    assert.equal(db.prepare('DELETE FROM issue_relations WHERE id=?').run(imported.id).changes, 1);
  } finally { db.close(); }
  const afterRemoval = await f.backup();
  await f.call('/import', 'POST', { data: afterRemoval });
  assert.deepEqual((await f.backup()).sourceImports.find(row => row.id === receipt.id)?.projectIds, receipt.projectIds);
  assert.deepEqual(await f.relations(a), []);
  const archivedRepeat = await f.upload('B-follow-up-after-link-removal', [
    sourceIssue('200', [link('701', '100', 'inward')], 'OTHER', 'B의 같은 관계를 포함한 후속 원본'),
  ]);
  const archivedAppend = await f.appendConfiguration(archivedRepeat);
  archivedAppend.appendTo!.refreshRelations = true;
  const retained = await f.preview(archivedAppend);
  assert.equal(retained.canApply, false);
  assert.equal(retained.counts.newJiraRelations, 0);
  assert.equal(retained.counts.skippedJiraRelations, 1);
});

test('a selected proven Jira blocker schedules across project calendars without activating other imported relations', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100'), sourceIssue('300')], 'ALPHA');
  await f.importInitial([sourceIssue('200', [], 'OTHER'), sourceIssue('400', [], 'OTHER')], 'BRAVO');
  const delta = await f.upload('handoff-from-proven-inward-relations', [sourceIssue('200', [
    link('801', '100', 'inward'), link('802', '300', 'inward'),
  ], 'OTHER')]);
  const config = await f.appendConfiguration(delta);
  config.appendTo!.refreshRelations = true;
  const migration = await f.apply(await f.preview(config));
  assert.equal(migration.status, 201, JSON.stringify(migration.data));
  const originalReceipt = migration.data.import;

  const workspace = await f.workspace();
  const schedule = (issue: Issue, startDate: string, endDate: string) => f.call<Issue>(`/issues/${issue.id}`, 'PATCH', {
    expectedVersion: issue.version, startDate, endDate,
  });
  const source = await schedule(original(workspace, '100'), '2026-11-19', '2026-11-20');
  const later = await schedule(original(workspace, '300'), '2026-11-26', '2026-11-27');
  const target = await schedule(original(workspace, '200', 'OTHER'), '2026-11-16', '2026-11-17');
  const successor = await schedule(original(workspace, '400', 'OTHER'), '2026-11-16', '2026-11-16');
  const local = await f.call<Dependency>('/dependencies', 'POST', {
    predecessorId: target.id, successorId: successor.id, type: 'FS', lagDays: 0,
  }, 201);
  await f.call<Dependency>('/dependencies', 'POST', {
    predecessorId: source.id, successorId: later.id, type: 'FS', lagDays: 2,
  }, 201);
  const [selected] = await f.relations(source);
  const [unselected] = await f.relations(later);
  assert.deepEqual([selected.sourceIssueId, selected.targetIssueId], [source.id, target.id]);
  const backup = await f.backup();
  const unproven: IssueRelation = { id: randomUUID(), sourceIssueId: later.id, targetIssueId: successor.id,
    type: 'Blocks', version: 1, createdAt: CREATED };
  const stored = backup.issueRelations.find(relation => relation.id === selected.id)!;
  // A compatible legacy backup can store the outward pair in the original inward row order.
  [stored.sourceIssueId, stored.targetIssueId] = [target.id, source.id];
  backup.issueRelations.push(unproven);
  await f.call('/import', 'POST', { data: backup });
  assert.deepEqual(await f.relations(source), [stored]);
  const relationPath = `/issues/${source.id}/relations`;
  const activeReceipt = (await f.call<SourceImport[]>('/source-imports')).find(row => row.id === originalReceipt.id)!;
  const auditPath = `/source-imports/${activeReceipt.id}/reconciliation/audit?expectedVersion=${activeReceipt.version}`;
  const sourceAudit = await f.call<SourceReconciliationAudit>(auditPath);
  const calendar = async (projectId: string, exceptions: WorkCalendar['exceptions']) => {
    const path = `/projects/${projectId}/calendar`;
    const current = await f.call<WorkCalendar>(path);
    return f.call<WorkCalendar>(path, 'PATCH', { ...current, expectedVersion: current.version, workingWeekdays: [1, 2, 3, 4, 5], exceptions });
  };
  const sourceHours = [{ date: '2026-11-23', isWorking: false, label: '선행 프로젝트 휴무' }];
  const targetHours = [
    { date: '2026-11-21', isWorking: true, label: '후행 프로젝트 토요일 근무' },
    { date: '2026-11-23', isWorking: false, label: '후행 프로젝트 월요일 휴무' },
  ];
  let sourceCalendar = await calendar(source.projectId, sourceHours);
  const targetCalendar = await calendar(target.projectId, targetHours);
  const blockers = () => f.call<TeamScheduleBlocker[]>('/schedule/team-blockers');
  assert.ok((await blockers()).some(row => row.id === unselected.id));
  assert.ok(!(await blockers()).some(row => row.id === unproven.id));
  const previewPath = '/schedule/team-follow-up-preview';
  const applyPath = '/schedule/team-follow-up-apply';
  await f.call(previewPath, 'POST', { relationId: unproven.id, expectedVersion: unproven.version }, 404);
  const preview = (relation: IssueRelation, anchorChange?: ScheduleAnchorChange) => f.call<AutomaticSchedulePreview>(previewPath, 'POST', {
    relationId: relation.id, expectedVersion: relation.version, anchorChange,
  });
  const plannedDates = (proposal: AutomaticSchedulePreview) => proposal.changes.map(row => [row.id, row.toStart, row.toEnd]);
  const expected = [[target.id, '2026-11-21', '2026-11-24'], [successor.id, '2026-11-25', '2026-11-25']];

  const rowInput = (issue: Issue, startDate: string, endDate: string) => ({ projectId: issue.projectId,
    issue: { id: issue.id, expectedVersion: issue.version }, changes: { startDate, endDate }, reviewIncomingTeamBlockers: true,
  });
  const currentIssues = (await f.workspace()).issues;
  const targetInput = currentIssues.find(issue => issue.id === target.id)!;
  const premature = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 'POST', rowInput(targetInput, '2026-11-20', '2026-11-24'));
  assert.equal(premature.previewId, null);
  assert.equal(premature.errors.length, 2);
  assert.ok(premature.errors.some(({ message }) => message.includes(source.key) && message.includes('2026-11-21 이후')));
  assert.ok(premature.errors.some(({ message }) => message.includes(later.key) && message.includes('2026-11-30 이후')));
  const valid = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 'POST', rowInput(targetInput, '2026-11-30', '2026-12-01'));
  assert.ok(valid.previewId);
  const currentSuccessor = currentIssues.find(issue => issue.id === successor.id)!;
  const unproved = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 'POST', rowInput(currentSuccessor, '2026-11-18', '2026-11-18'));
  assert.ok(unproved.previewId);

  const native = await f.call<IssueRelation>(relationPath, 'POST', { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' }, 201);
  await f.call('/schedule/row-edit/apply', 'POST', { previewId: valid.previewId }, 409);
  const preferred = (await blockers()).filter(row => row.sourceIssueId === source.id && row.targetIssueId === target.id);
  assert.deepEqual(preferred, [{ id: native.id, sourceIssueId: source.id, targetIssueId: target.id, version: native.version }]);
  assert.deepEqual(plannedDates(await preview(native)), expected);
  await f.call(`${relationPath}/${native.id}?expectedVersion=${native.version}`, 'DELETE');
  assert.deepEqual((await blockers()).find(row => row.id === selected.id), {
    id: selected.id, sourceIssueId: source.id, targetIssueId: target.id, version: selected.version, origin: 'jira',
  });

  const before = await f.workspace();
  const archivedRelations = (await f.backup()).issueRelations;
  const proposal = await preview(selected);
  assert.deepEqual(proposal.blocking, []);
  assert.equal(proposal.teamFollowUp?.sourceIssueId, source.id);
  assert.equal(proposal.teamFollowUp?.sourceEndDate, source.endDate);
  assert.equal(proposal.teamFollowUp?.targetIssueId, target.id);
  assert.equal(proposal.calendarVersions?.[source.projectId], sourceCalendar.version);
  assert.equal(proposal.calendarVersions?.[target.projectId], targetCalendar.version);
  assert.deepEqual(plannedDates(proposal), expected);
  const currentSource = before.issues.find(issue => issue.id === source.id)!;
  const anchorChange = { id: source.id, expectedVersion: currentSource.version, startDate: source.startDate, endDate: '2026-11-24' };
  const moved = await preview(selected, anchorChange);
  assert.deepEqual(moved.blocking, []);
  assert.equal(moved.teamFollowUp?.sourceEndDate, anchorChange.endDate);
  assert.deepEqual(moved.teamFollowUp?.anchorChange, anchorChange);
  assert.deepEqual(plannedDates(moved).sort(), [
    [source.id, source.startDate, '2026-11-24'], [target.id, '2026-11-25', '2026-11-26'],
    [successor.id, '2026-11-27', '2026-11-27'], [later.id, '2026-11-27', '2026-11-30'],
  ].sort());
  assert.deepEqual(await f.workspace(), before);

  sourceCalendar = await calendar(source.projectId, [...sourceHours, { date: '2026-11-30', isWorking: false, label: '달력 버전 검증' }]);
  const beforeApply = await f.workspace();
  await f.call(applyPath, 'POST', { previewId: proposal.previewId }, 409);
  assert.deepEqual(await f.workspace(), beforeApply);
  const reviewed = await preview(selected);
  assert.equal(reviewed.calendarVersions?.[source.projectId], sourceCalendar.version);
  const resultPath = `/schedule/team-follow-up-result/${reviewed.previewId}`;
  assert.deepEqual(await f.call(resultPath), { applied: false });
  const result = await f.call<SchedulePasteApplyResult>(applyPath, 'POST', { previewId: reviewed.previewId });
  assert.deepEqual(await f.call(resultPath), result);
  assert.deepEqual(result.updated.map(issue => [issue.id, issue.startDate, issue.endDate]), expected);
  const committed = await f.workspace();
  for (const issue of [source, later, target, successor]) {
    assert.equal(committed.issues.find(row => row.id === issue.id)?.status, issue.status);
  }
  assert.deepEqual(committed.dependencies, beforeApply.dependencies);
  assert.deepEqual(await f.relations(source), [stored]);
  await f.call('/schedule/undo', 'POST', { undoId: result.undoId });
  const final = await f.workspace();
  for (const issue of [source, later, target, successor]) {
    const restored = final.issues.find(row => row.id === issue.id)!;
    assert.deepEqual([restored.startDate, restored.endDate, restored.dueDate, restored.status], [issue.startDate, issue.endDate, issue.dueDate, issue.status]);
  }
  assert.deepEqual(final.dependencies, beforeApply.dependencies);
  assert.ok(final.dependencies.some(dependency => dependency.id === local.id));
  assert.deepEqual((await f.backup()).issueRelations, archivedRelations);
  assert.deepEqual((await f.call<SourceReconciliationAudit>(auditPath)).targetContent.issueRelations, sourceAudit.targetContent.issueRelations);
});

test('a handoff batch activates only the selected verified Jira blockers and rechecks every source proof', async t => {
  const f = await fixture(t);
  const targets = ['200', '300', '400'];
  await f.importInitial([sourceIssue('100')], 'ALPHA');
  await f.importInitial(targets.map(id => sourceIssue(id, [], 'OTHER')), 'BRAVO');
  const delta = await f.upload('multi-handoff-jira-proof', targets.map(id => sourceIssue(id, [link(`8${id}`, '100', 'inward')], 'OTHER')));
  const config = await f.appendConfiguration(delta);
  config.appendTo!.refreshRelations = true;
  const migration = await f.apply(await f.preview(config));
  assert.equal(migration.status, 201, JSON.stringify(migration.data));

  const workspace = await f.workspace();
  const schedule = (issue: Issue, date: string) => f.call<Issue>(`/issues/${issue.id}`, 'PATCH', {
    expectedVersion: issue.version, startDate: date, endDate: date,
  });
  let source = await schedule(original(workspace, '100'), '2026-11-20');
  const [first, second, unselected] = await Promise.all(targets.map(id => schedule(original(workspace, id, 'OTHER'), '2026-11-16')));
  const blockers = (await f.call<TeamScheduleBlocker[]>('/schedule/team-blockers')).filter(relation => relation.sourceIssueId === source.id);
  assert.deepEqual(new Set(blockers.map(relation => relation.targetIssueId)), new Set([first.id, second.id, unselected.id]));
  assert.ok(blockers.every(relation => relation.origin === 'jira'));
  const selected = [second, first].map(target => blockers.find(relation => relation.targetIssueId === target.id)!);
  const relations = selected.map(({ id, version }) => ({ relationId: id, expectedVersion: version }));
  const previewPath = '/schedule/team-follow-up-preview', applyPath = '/schedule/team-follow-up-apply';
  const review = (anchorChange?: ScheduleAnchorChange) => f.call<AutomaticSchedulePreview>(previewPath, 'POST', { relations, anchorChange });
  const firstReview = await review();
  assert.deepEqual(firstReview.blocking, []);
  assert.deepEqual(firstReview.teamFollowUp?.relations, relations.map((relation, index) => ({ ...relation, targetIssueId: selected[index].targetIssueId })));
  assert.deepEqual(firstReview.changes.map(change => [change.id, change.toStart, change.toEnd]),
    [[second.id, '2026-11-23', '2026-11-23'], [first.id, '2026-11-23', '2026-11-23']]);

  const dateChange = () => ({ id: source.id, expectedVersion: source.version, startDate: source.startDate, endDate: '2026-11-24' });
  const anchored = await review(dateChange());
  assert.deepEqual(anchored.blocking, []);
  assert.equal(anchored.changes[0]?.id, source.id);
  assert.deepEqual(anchored.changes.map(change => [change.id, change.toStart, change.toEnd]).sort(),
    [[source.id, '2026-11-20', '2026-11-24'], [second.id, '2026-11-25', '2026-11-25'], [first.id, '2026-11-25', '2026-11-25']].sort());
  const applied = await f.call<SchedulePasteApplyResult>(applyPath, 'POST', { previewId: anchored.previewId });
  assert.deepEqual(await f.call(applyPath, 'POST', { previewId: anchored.previewId }), applied);
  assert.deepEqual((await f.workspace()).issues.find(issue => issue.id === unselected.id), unselected);
  await f.call('/schedule/undo', 'POST', { undoId: applied.undoId });
  const restored = await f.workspace();
  source = restored.issues.find(issue => issue.id === source.id)!;
  for (const originalIssue of [first, second]) {
    const item = restored.issues.find(issue => issue.id === originalIssue.id)!;
    assert.deepEqual([item.startDate, item.endDate, item.version], [originalIssue.startDate, originalIssue.endDate, originalIssue.version + 2]);
  }

  const stale = await review(dateChange());
  assert.deepEqual(stale.blocking, []);
  const proof = (await f.backup()).sourceRecords.find(row => row.jiraRelationId === selected[1].id);
  assert.ok(proof);
  const database = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    assert.equal(database.prepare('DELETE FROM source_records WHERE id=?').run(proof.id).changes, 1);
  } finally { database.close(); }
  const beforeRejection = await f.workspace();
  await f.call(applyPath, 'POST', { previewId: stale.previewId }, 409);
  assert.deepEqual(await f.call(`/schedule/team-follow-up-result/${stale.previewId}`), { applied: false });
  assert.deepEqual(await f.workspace(), beforeRejection);
});

test('project blocker batch can combine Jira proven direction with native blockers and rejects missing proof at apply', async t => {
  const f = await fixture(t);
  await f.importInitial([
    sourceIssue('100'), sourceIssue('200', [link('810', '100', 'inward')]), sourceIssue('300'),
  ]);
  const workspace = await f.workspace();
  const source = original(workspace, '100');
  const successor = original(workspace, '200');
  const other = original(workspace, '300');
  const archivedOnly = await f.call<Issue>('/issues', 'POST', { projectId: source.projectId, title: '원본 근거 없이 보관한 차단' }, 201);
  const backup = await f.backup();
  const jira = backup.issueRelations.find(row => [source.id, successor.id].includes(row.sourceIssueId) &&
    [source.id, successor.id].includes(row.targetIssueId));
  assert.ok(jira, 'Expected the imported Jira relation between both local issues');
  const proof = backup.sourceRecords.find(row => row.jiraRelationId === jira.id);
  assert.ok(proof);
  const unresolved: IssueRelation = { id: randomUUID(), sourceIssueId: archivedOnly.id,
    targetIssueId: successor.id, type: 'Blocks', version: 1, createdAt: CREATED };
  // The proof is authoritative even when a compatible backup retains inward source order.
  [jira.sourceIssueId, jira.targetIssueId] = [successor.id, source.id];
  backup.issueRelations.push(unresolved);
  await f.call('/import', 'POST', { data: backup });

  const path = '/schedule/blocker-links';
  const list = () => f.call<{ items: TeamScheduleBlocker[]; offset: number; total: number }>(`${path}?projectId=${source.projectId}&offset=0`);
  const listTeam = () => f.call<ScheduleBlockerLinkPage>(`${path}?scope=team`);
  const add = (issue: Issue) => f.call<IssueRelation>(`/issues/${issue.id}/relations`, 'POST', {
    otherIssueId: successor.id, type: 'blocks', direction: 'outgoing',
  }, 201);
  const preview = (relations: readonly IssueRelation[]) => f.call<SchedulePastePreview>(`${path}/preview`, 'POST', {
    projectId: source.projectId, relations: relations.map(({ id, version }) => ({ id, version })),
  });
  const native = await add(other);
  const duplicate = await add(source);
  const samePair = (await list()).items.filter(row => row.sourceIssueId === source.id && row.targetIssueId === successor.id);
  assert.deepEqual(samePair, [{ id: duplicate.id, sourceIssueId: source.id, targetIssueId: successor.id, version: duplicate.version }]);
  assert.deepEqual((await listTeam()).items.filter(row => row.sourceIssueId === source.id && row.targetIssueId === successor.id),
    samePair.map(row => ({ ...row, projectId: source.projectId })));
  const overshadowed = await preview([jira]);
  assert.equal(overshadowed.previewId, null);
  assert.ok(overshadowed.errors.length);
  await f.call(`/issues/${source.id}/relations/${duplicate.id}?expectedVersion=${duplicate.version}`, 'DELETE');
  const displayed = await list();
  assert.equal(displayed.total, 2);
  assert.equal(displayed.offset, 0);
  assert.deepEqual(displayed.items.find(row => row.id === jira.id), {
    id: jira.id, sourceIssueId: source.id, targetIssueId: successor.id, version: jira.version, origin: 'jira',
  });
  assert.deepEqual(displayed.items.find(row => row.id === native.id), {
    id: native.id, sourceIssueId: other.id, targetIssueId: successor.id, version: native.version,
  });
  assert.deepEqual((await listTeam()).items, displayed.items.map(row => ({ ...row, projectId: source.projectId })));
  assert.ok(!(await preview([unresolved])).previewId);

  const originalRelations = (await f.backup()).issueRelations;
  const before = await f.workspace();
  const reviewed = await preview([jira, native]);
  assert.ok(reviewed.previewId);
  assert.deepEqual(reviewed.errors, []);
  assert.deepEqual(reviewed.dependencyChanges?.map(row => [row.predecessorKey, row.successorKey, row.after]), [
    [source.key, successor.key, { type: 'FS', lagDays: 0 }],
    [other.key, successor.key, { type: 'FS', lagDays: 0 }],
  ]);
  const result = await f.call<SchedulePasteApplyResult>(`${path}/apply`, 'POST', { previewId: reviewed.previewId });
  assert.equal(result.dependencyChanges, 2);
  assert.deepEqual(result.updated, []);
  const committed = await f.workspace();
  assert.deepEqual(committed.dependencies.filter(row => row.successorId === successor.id).map(row => row.predecessorId).sort(),
    [source.id, other.id].sort());
  assert.deepEqual((await f.backup()).issueRelations, originalRelations);
  await f.call('/schedule/undo', 'POST', { undoId: result.undoId });
  assert.deepEqual((await f.workspace()).dependencies, before.dependencies);

  const stale = await preview([jira, native]);
  assert.ok(stale.previewId);
  const teamStale = await f.call<SchedulePastePreview>(`${path}/preview`, 'POST', {
    projectId: null, relations: [jira, native].map(({ id, version }) => ({ id, version, projectId: source.projectId })),
  });
  assert.ok(teamStale.previewId, JSON.stringify(teamStale.errors));
  assert.deepEqual(teamStale.dependencyChanges, stale.dependencyChanges?.map(row => ({ ...row, projectId: source.projectId })));
  const database = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    assert.equal(database.prepare('DELETE FROM source_records WHERE id=?').run(proof.id).changes, 1);
  } finally { database.close(); }
  assert.deepEqual((await list()).items.map(row => row.id), [native.id]);
  const afterProofLoss = await f.workspace();
  await f.call(`${path}/apply`, 'POST', { previewId: stale.previewId }, 409);
  await f.call(`${path}/apply`, 'POST', { previewId: teamStale.previewId }, 409);
  assert.deepEqual(await f.workspace(), afterProofLoss);
  assert.deepEqual((await f.backup()).issueRelations, originalRelations);
});

test('proven Jira blockers keep canonical direction in reports, release readiness and protected transitions', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100')], 'ALPHA');
  await f.importInitial([
    sourceIssue('201', [], 'OTHER'),
    sourceIssue('203', [], 'OTHER'),
    sourceIssue('202', [
      link('901', '201', 'inward'),
      link('903', '203', 'inward', { ...BLOCKS, id: '10002', inward: 'depends on', outward: 'depends on' }),
    ], 'OTHER'),
  ], 'BRAVO');
  const delta = await f.upload('report-proven-cross-link', [sourceIssue('202', [link('902', '100', 'inward')], 'OTHER')]);
  const config = await f.appendConfiguration(delta);
  config.appendTo!.refreshRelations = true;
  const migration = await f.apply(await f.preview(config));
  assert.equal(migration.status, 201, JSON.stringify(migration.data));

  const workspace = await f.workspace();
  const cross = original(workspace, '100');
  const local = original(workspace, '201', 'OTHER');
  const target = original(workspace, '202', 'OTHER');
  const ambiguous = original(workspace, '203', 'OTHER');
  const unprovenSource = await f.call<Issue>('/issues', 'POST', { projectId: target.projectId, title: '원본 기록이 없는 차단 이름' }, 201);
  const unproven: IssueRelation = { id: randomUUID(), sourceIssueId: unprovenSource.id, targetIssueId: target.id,
    type: 'Blocks', version: 1, createdAt: CREATED };
  const beforeRestore = await f.backup();
  const inverted = beforeRestore.issueRelations.find(relation => relation.sourceIssueId === cross.id && relation.targetIssueId === target.id);
  assert.ok(inverted);
  [inverted.sourceIssueId, inverted.targetIssueId] = [target.id, cross.id];
  beforeRestore.issueRelations.push(unproven);
  await f.call('/import', 'POST', { data: beforeRestore });

  const reportPath = `/projects/${target.projectId}/delivery-blockers`;
  const reason = '?reason=issue_block';
  const report = (path = reportPath + reason) => f.call<DeliveryBlockerReport>(path);
  const targetRelations = `/issues/${target.id}/relations`;
  const crossRelations = `/issues/${cross.id}/relations`;
  const incoming = await f.call<IssueRelationView[]>(targetRelations);
  const crossInbound = incoming.find(relation => relation.id === inverted.id);
  assert.deepEqual(crossInbound, { ...inverted, verifiedBlockerDirection: 'incoming' });
  assert.deepEqual(await f.call<IssueRelationView[]>(crossRelations), [{ ...inverted, verifiedBlockerDirection: 'outgoing' }]);
  const relationWith = (issue: Issue) => incoming.find(relation =>
    relation.sourceIssueId === issue.id || relation.targetIssueId === issue.id);
  assert.deepEqual(incoming.filter(relation => relation.verifiedBlockerDirection).map(relation => relation.id).sort(),
    [relationWith(local)!.id, inverted.id].sort());
  const aggregate = await f.call<ScheduleBlockerLinkPage>('/schedule/blocker-links?scope=team');
  assert.deepEqual(aggregate.items, [{
    id: relationWith(local)!.id, sourceIssueId: local.id, targetIssueId: target.id,
    version: relationWith(local)!.version, projectId: target.projectId, origin: 'jira',
  }]);
  for (const candidate of [ambiguous, unprovenSource]) {
    const raw = relationWith(candidate);
    assert.ok(raw);
    assert.equal(raw.verifiedBlockerDirection, undefined);
  }
  const incomingIssues = (value: DeliveryBlockerReport) => value.items.find(row => row.issue.id === target.id)?.blockers.items;
  const initial = await report();
  assert.equal(initial.total, 1);
  assert.deepEqual(new Map(incomingIssues(initial)?.map(source => [source.id, source.origin])), new Map([[cross.id, 'jira'], [local.id, 'jira']]));
  assert.equal((await report(`/projects/${cross.projectId}/delivery-blockers${reason}`)).total, 0);

  const scoped = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '릴리스 범위 쓰기', access: 'write', projectIds: [target.projectId] }, 201);
  const crossScope = await f.call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '두 프로젝트 범위 읽기', access: 'read', projectIds: [target.projectId, cross.projectId],
  }, 201);
  const readWithKey = <T>(path: string, token: string) => f.request<T>(`/v1${path}`, 'GET', undefined, ACTOR, token);
  const localReport = await readWithKey<DeliveryBlockerReport>(reportPath + reason, scoped.token);
  assert.equal(localReport.status, 200);
  assert.deepEqual(incomingIssues(localReport.data)?.map(source => [source.id, source.origin]), [[local.id, 'jira']]);
  assert.ok(!JSON.stringify(localReport.data).includes(cross.title));
  const visibleReport = await readWithKey<DeliveryBlockerReport>(reportPath + reason, crossScope.token);
  assert.equal(visibleReport.status, 200);
  assert.deepEqual(visibleReport.data.items, initial.items);
  assert.equal(visibleReport.data.revision, initial.revision);
  const hiddenRelation = await readWithKey<IssueRelationView[]>(targetRelations, scoped.token);
  assert.equal(hiddenRelation.status, 200);
  assert.ok(!hiddenRelation.data.some(relation => relation.id === inverted.id));

  const native = await f.call<IssueRelation>(crossRelations, 'POST', {
    otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
  }, 201);
  const withNative = await report();
  assert.equal(withNative.total, 1);
  assert.deepEqual(new Map(incomingIssues(withNative)?.map(source => [source.id, source.origin])), new Map([[cross.id, undefined], [local.id, 'jira']]));
  assert.equal((await f.call<IssueRelationView[]>(targetRelations)).find(relation => relation.id === inverted.id)?.verifiedBlockerDirection, undefined);
  assert.notEqual(withNative.revision, initial.revision);
  await f.call(`${crossRelations}/${native.id}?expectedVersion=${native.version}`, 'DELETE');
  assert.equal((await report()).revision, initial.revision);

  const release = await f.call<PlanningItem>('/planning-items', 'POST', {
    projectId: target.projectId, name: '이관 차단 검증 릴리스', kind: 'release', targetDate: '2030-02-09',
  }, 201);
  const restored = (await f.workspace()).issues.find(issue => issue.id === target.id)!;
  const assigned = await f.call<Issue>(`/issues/${target.id}`, 'PATCH', {
    expectedVersion: restored.version, releaseId: release.id, startDate: '2030-02-01', endDate: '2030-02-03',
  });
  const scope = `?releaseId=${release.id}&reason=issue_block`;
  const readiness = await report(reportPath + scope);
  assert.equal(readiness.counts.open, 1);
  assert.deepEqual(incomingIssues(readiness)?.map(source => source.origin), ['jira', 'jira']);
  assert.equal(readiness.items[0].releaseSchedule, undefined);
  const created = await f.call<DeliveryBlockerDraftResult>(`${reportPath}/meeting-draft`, 'POST', {
    requestId: randomUUID(), title: '확인된 Jira 차단 회의', releaseId: release.id, reason: 'issue_block', revision: readiness.revision,
  }, 201);
  assert.match(created.document.plainText, /Jira 이관 관계/u);
  assert.ok(created.document.plainText.includes(cross.title));
  assert.ok(created.document.plainText.includes(local.title));
  assert.ok(!created.document.plainText.includes(unprovenSource.title));
  assert.ok(JSON.stringify(created.document.content).includes(`reports/blockers?release=${release.id}&reason=issue_block`));

  const completed = { id: 'completed-test', color: '#428655', label: '검증 완료', category: 'done' } as const;
  async function addCompletion(projectId: string, from: string, guarded = false) {
    const path = `/projects/${projectId}/workflow`;
    const current = await f.call<ProjectWorkflow>(path);
    await f.call<ProjectWorkflow>(path, 'PATCH', {
      ...current, expectedVersion: current.version, statuses: [...current.statuses, completed],
      transitions: [...current.transitions, { from, to: completed.id, requiredFields: [], issueTypes: [],
        ...(guarded ? { requireResolvedBlockers: true } : {}) }],
    });
  }
  await addCompletion(target.projectId, target.status, true);
  await addCompletion(cross.projectId, cross.status);
  const close = (issue: Issue, status = 200) => f.call<Issue>(`/issues/${issue.id}`, 'PATCH', {
    expectedVersion: issue.version, status: completed.id,
  }, status);
  const afterConfiguration = await f.workspace();
  const current = (issue: Issue) => afterConfiguration.issues.find(value => value.id === issue.id)!;
  await close(current(local));
  const hiddenOnly = await readWithKey<DeliveryBlockerReport>(reportPath + scope, scoped.token);
  assert.equal(hiddenOnly.data.total, 0);
  const protectedResult = await f.request(`/v1/issues/${assigned.id}`, 'PATCH', {
    expectedVersion: current(assigned).version, status: completed.id,
  }, ACTOR, scoped.token);
  assert.deepEqual(protectedResult, { status: 422, data: {
    error: '열린 차단 업무를 해결한 뒤 상태를 변경해 주세요.', details: { reason: 'open_issue_blockers' },
  } });
  await close(current(cross));
  assert.equal((await report(reportPath + scope)).total, 0);
  assert.equal((await close(current(assigned))).status, completed.id);
  const after = await f.backup();
  assert.deepEqual(after.issueRelations, beforeRestore.issueRelations);
});

test('relation-only Jira administrator XML needs a proven project to anchor a cross-project review', async t => {
  const f = await fixture(t);
  await f.importInitial([sourceIssue('100')]);
  await f.importInitial([sourceIssue('200', [], 'OTHER')]);
  const workspace = await f.workspace();
  const a = original(workspace, '100');
  const b = original(workspace, '200', 'OTHER');
  const native = await f.call<IssueRelation>(`/issues/${b.id}/relations`, 'POST', {
    otherIssueId: a.id, type: 'related', direction: 'outgoing',
  }, 201);
  const sparse = (name: string, project = '') => f.uploadBytes(`${name}.zip`, zip([{ path: 'entities.xml', bytes: Buffer.from(`
    <entity-engine-xml version="9.12">
      ${project}
      <IssueLinkType id="10000" linkname="Blocks" inward="is blocked by" outward="blocks"/>
      <IssueLinkType id="10001" linkname="Relates" inward="relates to" outward="relates to"/>
      <IssueLink id="711" linktype="10001" source="100" destination="200"/>
      <IssueLink id="712" linktype="10000" source="200" destination="100"/>
    </entity-engine-xml>`),
  }]));

  const noProject = await sparse('without-anchor');
  assert.equal((await f.options(noProject)).appendTarget, undefined);
  const both = await sparse('ambiguous-anchor', '<Project id="10100" pkey="OLD" name="Old"/><Project id="20200" pkey="OTHER" name="Other"/>');
  assert.equal((await f.options(both)).appendTarget, undefined);
  const unrelated = await sparse('unrelated-anchor', '<Project id="30300" pkey="WRONG" name="Wrong"/>');
  assert.equal((await f.options(unrelated)).appendTarget, undefined);

  const anchored = await sparse('project-A-anchor', '<Project id="10100" pkey="OLD" name="Old"/>');
  const append = await f.appendConfiguration(anchored);
  assert.equal(append.appendTo!.projectId, a.projectId);
  append.appendTo!.refreshRelations = true;
  const review = await f.preview(append);
  assert.equal(review.canApply, true, JSON.stringify(review.notices));
  assert.equal(review.counts.issues, 0);
  assert.equal(review.counts.newJiraRelations, 1);
  assert.equal(review.counts.skippedJiraRelations, 1);
  assert.deepEqual(review.jiraRelationRefresh?.map(({ recordId, sourceKey, targetKey, type }) => [recordId, sourceKey, targetKey, type]),
    [[`${anchored.id}/relation:712`, b.key, a.key, 'Blocks']]);
  const applied = await f.apply(review);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const relations = await f.relations(a);
  assert.equal(relations.length, 2);
  assert.ok(relations.some(relation => relation.id === native.id));
  const added = relations.find(relation => relation.id !== native.id)!;
  assert.deepEqual([added.sourceIssueId, added.targetIssueId, added.type], [b.id, a.id, 'Blocks']);
  assert.deepEqual(await f.relations(b), relations);
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
