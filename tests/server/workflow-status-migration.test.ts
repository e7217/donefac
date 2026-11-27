import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Issue, IssueAssignmentRule, IssueAssignmentRunPage, IssueBulkEditPreview, IssueBulkEditResult,
  Project, ProjectIssueSchema, ProjectWorkflow, ReportingLedgerData, TeamNotificationPage, WebhookDelivery,
  WebhookEndpointCreated, WorkspaceSnapshot,
} from '../../shared/types.js';

const editor = 'user-min';
const reviewer = 'user-seo';
const fromStatusId = 'old_review';
const toStatusId = 'done';
const workflowPath = (projectId: string) => `/projects/${projectId}/workflow`;
const migrationPath = (projectId: string, action: 'preview' | 'apply') => `${workflowPath(projectId)}/status-migration-${action}`;
const bulkPath = (projectId: string, action: 'preview' | 'apply') => `/projects/${projectId}/issues/bulk-${action}`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-workflow-status-migration-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      base: `http://127.0.0.1:${address.port}/api`,
      async close() {
        await new Promise<void>(resolve => server.close(() => resolve()));
        runtime.close();
      },
    };
  }
  let service = await start();
  const database = new DatabaseSync(join(directory, 'donefac.sqlite'));
  t.after(async () => {
    database.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function request<T>(path: string, method = 'GET', body?: unknown, actor = editor) {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function expectStatus<T = unknown>(status: number, path: string, method = 'GET', body?: unknown, actor = editor) {
    const response = await request<T>(path, method, body, actor);
    assert.equal(response.status, status, JSON.stringify(response.data));
    return response.data;
  }
  async function createWorkflow(key: string, requireAssignee = false) {
    const project = await expectStatus<Project>(201, '/projects', 'POST', { key, name: `${key} 상태 정리` });
    const original = await expectStatus<ProjectWorkflow>(200, workflowPath(project.id));
    const workflow = await expectStatus<ProjectWorkflow>(200, workflowPath(project.id), 'PATCH', {
      ...original, expectedVersion: original.version,
      statuses: [...original.statuses, { id: fromStatusId, label: '이전 검토', color: '#5a6fa3', category: 'review' }],
      fieldRules: requireAssignee ? [{ issueType: '*', statusId: toStatusId, requiredFields: ['assigneeId'] }] : [],
    });
    return workflow;
  }
  function createIssue(projectId: string, title: string, fields: Partial<Issue> = {}) {
    return expectStatus<Issue>(201, '/issues', 'POST', { projectId, title, status: fromStatusId, ...fields });
  }
  function preview(workflow: ProjectWorkflow) {
    return expectStatus<IssueBulkEditPreview>(200, migrationPath(workflow.projectId, 'preview'), 'POST', {
      fromStatusId, toStatusId, expectedWorkflowVersion: workflow.version,
    });
  }
  function apply(projectId: string, previewId: string, actor = editor) {
    return request<IssueBulkEditResult>(migrationPath(projectId, 'apply'), 'POST', { previewId }, actor);
  }
  function snapshot() { return expectStatus<WorkspaceSnapshot>(200, '/workspace'); }
  function ledger() {
    return expectStatus<{ reportingLedger: ReportingLedgerData }>(200, '/export').then(value => value.reportingLedger.events);
  }
  function assignments(projectId: string) {
    return expectStatus<IssueAssignmentRunPage>(200, `/projects/${projectId}/assignment-runs`);
  }
  function inbox() { return expectStatus<TeamNotificationPage>(200, '/notifications', 'GET', undefined, reviewer); }
  function deliveries() { return expectStatus<WebhookDelivery[]>(200, '/webhook-deliveries'); }
  async function enableWebhook(projectId: string) {
    const { endpoint } = await expectStatus<WebhookEndpointCreated>(201, '/webhook-endpoints', 'POST', {
      name: '상태 일괄 변경 검증 수신처', url: 'http://127.0.0.1:9/receiver', eventTypes: ['issue.updated'], projectIds: [projectId],
    });
    await expectStatus(200, `/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  async function restart() {
    await service.close();
    service = await start();
  }
  return { database, expectStatus, createWorkflow, createIssue, preview, apply, snapshot, ledger, assignments, inbox, deliveries, enableWebhook, restart };
}

test('status migration inspects the exact active project cohort, validates destination fields and preserves normal issue effects', async t => {
  const f = await fixture(t);
  const workflow = await f.createWorkflow('FSM', true);
  const { projectId } = workflow;
  const other = await f.createWorkflow('OTHER');
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.expectStatus<ProjectIssueSchema>(200, schemaPath);
  await f.expectStatus(200, schemaPath, 'PATCH', {
    expectedVersion: schema.version, issueTypes: schema.issueTypes, fields: [{
      id: 'approval_code', name: '승인 코드', kind: 'text', description: '', required: true,
      issueTypes: [], options: [], archived: false, visibleWhen: { statusIds: [toStatusId], fieldMatch: null },
    }],
  });
  const issue = await f.createIssue(projectId, '승인할 업무 하나', { customFields: { approval_code: 'A17' } });
  const blocked = await f.createIssue(projectId, '승인 코드가 없는 업무');
  const archived = await f.createIssue(projectId, '휴지통의 원래 검토 업무');
  const excluded = await f.createIssue(projectId, '같은 프로젝트의 다른 상태', { status: 'todo' });
  const foreign = await f.createIssue(other.projectId, '다른 프로젝트의 같은 상태');
  const { trashEntryId } = await f.expectStatus<{ trashEntryId: string }>(200, `/issues/${archived.id}`, 'DELETE', { expectedVersion: archived.version });
  const rule = await f.expectStatus<IssueAssignmentRule>(201, `/projects/${projectId}/assignment-rules`, 'POST', {
    name: '승인 완료 담당자', enabled: true, fromStatuses: [fromStatusId], toStatusId, issueTypes: [],
    assigneeId: reviewer, mode: 'unassigned', priority: 10,
  });
  await f.enableWebhook(projectId);
  const unconfiguredEdit = await f.expectStatus<{ error: string }>(422, `/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status: toStatusId });
  assert.match(unconfiguredEdit.error, /허용되지 않은 상태 전이/);

  const before = await f.snapshot();
  const ledgerBefore = await f.ledger();
  const notificationsBefore = await f.inbox();
  const rejected = await f.preview(workflow);
  assert.equal(rejected.previewId, null);
  assert.equal(rejected.changed, 1);
  assert.equal(rejected.blocked, 1);
  assert.deepEqual(new Set(rejected.rows.map(row => row.id)), new Set([issue.id, blocked.id]));
  const invalidRow = rejected.rows.find(row => row.id === blocked.id);
  assert.equal(invalidRow?.outcome, 'blocked');
  assert.match(invalidRow?.reason ?? '', /승인 코드/);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.ledger(), ledgerBefore);
  assert.deepEqual(await f.inbox(), notificationsBefore);
  assert.equal((await f.assignments(projectId)).total, 0);
  assert.deepEqual(await f.deliveries(), []);

  const repaired = await f.expectStatus<Issue>(200, `/issues/${blocked.id}`, 'PATCH', {
    expectedVersion: blocked.version, customFields: { approval_code: 'B29' },
  });
  const reviewed = await f.preview(workflow);
  assert.ok(reviewed.previewId);
  assert.equal(reviewed.changed, 2);
  assert.equal(reviewed.blocked, 0);
  assert.ok(reviewed.rows.every(row => row.before.status === fromStatusId && row.after?.status === toStatusId && row.after.assigneeId === reviewer));
  await f.expectStatus(404, bulkPath(projectId, 'apply'), 'POST', { previewId: reviewed.previewId });
  assert.equal((await f.apply(other.projectId, reviewed.previewId)).status, 404);
  assert.equal((await f.apply(projectId, reviewed.previewId, reviewer)).status, 404);
  const ordinary = await f.expectStatus<IssueBulkEditPreview>(200, bulkPath(projectId, 'preview'), 'POST', {
    issues: [{ id: excluded.id, expectedVersion: excluded.version }], changes: { status: 'review' },
  });
  assert.ok(ordinary.previewId);
  assert.equal((await f.apply(projectId, ordinary.previewId)).status, 404);

  const [applied, retry] = await Promise.all([f.apply(projectId, reviewed.previewId), f.apply(projectId, reviewed.previewId)]);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(retry, applied);
  assert.deepEqual(new Map(applied.data.updated.map(row => [row.id, row.version])), new Map([
    [issue.id, issue.version + 1], [repaired.id, repaired.version + 1],
  ]));
  const result = await f.snapshot();
  for (const previous of [issue, repaired]) {
    const updated = result.issues.find(row => row.id === previous.id);
    assert.ok(updated);
    assert.equal(updated.version, previous.version + 1);
    assert.equal(updated.status, toStatusId);
    assert.equal(updated.assigneeId, reviewer);
    assert.ok(updated.completedAt);
    assert.deepEqual(updated.customFields, previous.customFields);
  }
  assert.deepEqual(result.issues.find(row => row.id === excluded.id), excluded);
  assert.deepEqual(result.issues.find(row => row.id === foreign.id), foreign);
  assert.equal(result.issues.some(row => row.id === archived.id), false);
  assert.deepEqual(await f.expectStatus<ProjectWorkflow>(200, workflowPath(projectId)), workflow);
  const runs = await f.assignments(projectId);
  assert.equal(runs.total, 2);
  assert.ok(runs.items.every(run => run.ruleId === rule.id && run.actorId === editor && run.outcome === 'assigned'));
  const tracked = (await f.ledger()).filter(event => [issue.id, repaired.id].includes(event.issueId)
    && event.before?.statusId === fromStatusId && event.after?.statusId === toStatusId);
  assert.equal(tracked.length, 2);
  assert.ok(tracked.every(event => event.kind === 'changed' && event.actorId === editor && event.after?.category === 'done'));
  const assigned = (await f.inbox()).items.filter(item => item.kind === 'issue-assigned' && [issue.id, repaired.id].includes(item.targetId));
  assert.equal(assigned.length, 2);
  assert.ok(assigned.every(item => item.actorId === editor));

  await f.restart();
  assert.deepEqual(await f.apply(projectId, reviewed.previewId), applied);
  assert.deepEqual(await f.snapshot(), result);
  assert.deepEqual(await f.assignments(projectId), runs);
  await f.expectStatus(200, `/trash/${trashEntryId}/restore`, 'POST', {});
  assert.equal((await f.snapshot()).issues.find(row => row.id === archived.id)?.status, fromStatusId);
});

test('status migration detects cohort drift and commits all reviewed tickets or none', async t => {
  const f = await fixture(t);
  const workflow = await f.createWorkflow('FSR');
  const { projectId } = workflow;
  const first = await f.createIssue(projectId, '먼저 검토할 업무');
  const request = { fromStatusId, toStatusId, expectedWorkflowVersion: workflow.version };
  const previewPath = migrationPath(projectId, 'preview');
  await f.expectStatus(400, previewPath, 'POST', { ...request, toStatusId: fromStatusId });
  await f.expectStatus(400, previewPath, 'POST', { ...request, fromStatusId: 'not_a_status' });
  await f.expectStatus(409, previewPath, 'POST', { ...request, expectedWorkflowVersion: workflow.version - 1 });
  const reviewed = await f.preview(workflow);
  assert.ok(reviewed.previewId);
  const newcomer = await f.createIssue(projectId, '미리보기 이후 이 상태에 들어온 업무');
  const beforeCohortRejection = await f.snapshot();
  assert.equal((await f.apply(projectId, reviewed.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), beforeCohortRejection);

  const beforeRename = await f.preview(workflow);
  assert.ok(beforeRename.previewId);
  const edited = await f.expectStatus<Issue>(200, `/issues/${newcomer.id}`, 'PATCH', {
    expectedVersion: newcomer.version, title: '미리보기 이후 고친 업무 제목',
  });
  const beforeVersionRejection = await f.snapshot();
  assert.equal((await f.apply(projectId, beforeRename.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), beforeVersionRejection);

  const clean = await f.preview(workflow);
  assert.ok(clean.previewId);
  assert.deepEqual(new Set(clean.rows.map(row => row.id)), new Set([first.id, edited.id]));
  await f.enableWebhook(projectId);
  const beforeFailure = await f.snapshot();
  const ledgerBefore = await f.ledger();
  f.database.exec(`CREATE TRIGGER reject_second_migration_write BEFORE UPDATE ON issues
    WHEN json_extract(NEW.json,'$.status') = 'done' AND EXISTS (
      SELECT 1 FROM issues WHERE project_id = NEW.project_id AND json_extract(json,'$.status') = 'done'
    ) BEGIN SELECT RAISE(ABORT, 'synthetic second migration write failure'); END;`);
  assert.equal((await f.apply(projectId, clean.previewId)).status, 500);
  assert.deepEqual(await f.snapshot(), beforeFailure);
  assert.deepEqual(await f.ledger(), ledgerBefore);
  assert.deepEqual(await f.deliveries(), []);
  f.database.exec('DROP TRIGGER reject_second_migration_write');

  const applied = await f.apply(projectId, clean.previewId);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.updated.length, 2);
  assert.equal((await f.deliveries()).length, 2);
  const empty = await f.preview(workflow);
  assert.equal(empty.previewId, null);
  assert.deepEqual(empty.rows, []);
});
