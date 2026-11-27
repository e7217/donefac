import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { Issue, IssueChildCreationResult, ProjectIssueSchema, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const pathFor = (parentId: string) => `/issues/${parentId}/children`;
const requestFor = (parent: Issue, issue: Record<string, unknown>) => ({
  requestId: randomUUID(), expectedParentVersion: parent.version, issue,
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-issue-child-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function stop() {
    const { runtime, server } = service;
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, statuses: number | number[] = 200, actor = actorId) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.text();
    assert.ok([statuses].flat().includes(response.status), `${method} ${path}: ${response.status} ${payload}`);
    return { status: response.status, data: JSON.parse(payload) as T };
  }
  async function createParent(title: string) {
    return (await call<Issue>('/issues', 'POST', { projectId, title }, 201)).data;
  }
  async function restart() { await stop(); service = await start(); }
  return { call, createParent, directory, restart };
}

test('child creation binds the active parent and project and uses the project field and workflow rules', async t => {
  const { call, createParent } = await fixture(t);
  const parent = await createParent('기능 상위 이슈');
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const { data: schema } = await call<ProjectIssueSchema>(schemaPath);
  const type = 'child-deliverable';
  await call(schemaPath, 'PATCH', {
    ...schema,
    expectedVersion: schema.version,
    issueTypes: [...schema.issueTypes, { id: type, name: '하위 산출물', color: '#5474b5', archived: false }],
    fields: [...schema.fields, { id: 'delivery-count', name: '산출물 수', description: '', kind: 'number',
      required: true, issueTypes: [type], options: [], archived: false }],
  });
  const workflowPath = `/projects/${projectId}/workflow`;
  const { data: workflow } = await call<ProjectWorkflow>(workflowPath);
  await call(workflowPath, 'PATCH', {
    ...workflow,
    expectedVersion: workflow.version,
    fieldRules: [...workflow.fieldRules, { issueType: type, statusId: workflow.initialStatusId, requiredFields: ['description'] }],
  });

  const inputs = { title: '세부 구현', type };
  const request = requestFor(parent, inputs);
  const { data: missing } = await call<{ details: { reason: string } }>(pathFor('missing-issue'), 'POST', request, 404);
  assert.equal(missing.details.reason, 'parent_missing');
  await call(pathFor(parent.id), 'POST', { ...request, requestId: 'not-a-uuid' }, 400);
  await call(pathFor(parent.id), 'POST', { ...request, expectedParentVersion: '1' }, 400);
  await call(pathFor(parent.id), 'POST', { ...request, issue: { ...inputs, projectId: 'project-team' } }, 400);
  await call(pathFor(parent.id), 'POST', { ...request, issue: { ...inputs, parentId: null } }, 400);
  await call(pathFor(parent.id), 'POST', request, 422);
  await call(pathFor(parent.id), 'POST', { ...request, issue: { ...inputs, customFields: { 'delivery-count': 0 } } }, 422);

  const valid = { ...request, issue: {
    ...inputs, projectId, parentId: parent.id, description: '검수 기준', reporterId: 'user-min', customFields: { 'delivery-count': 0 },
  } };
  const calls = await Promise.all([
    call<IssueChildCreationResult>(pathFor(parent.id), 'POST', valid, [200, 201]),
    call<IssueChildCreationResult>(pathFor(parent.id), 'POST', valid, [200, 201]),
  ]);
  assert.deepEqual(calls.map(value => value.status).sort(), [200, 201]);
  const created = calls.find(value => value.status === 201)!.data;
  assert.equal(created.duplicate, false);
  assert.deepEqual(calls.find(value => value.status === 200)!.data, { ...created, duplicate: true });
  assert.equal(created.issue.parentId, parent.id);
  assert.equal(created.issue.projectId, projectId);
  assert.equal(created.issue.reporterId, 'user-min');
  assert.equal(created.issue.status, workflow.initialStatusId);
  assert.equal(created.issue.customFields?.['delivery-count'], 0);

  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.find(issue => issue.id === parent.id), parent);
  assert.deepEqual(workspace.issues.filter(issue => issue.parentId === parent.id), [created.issue]);
  const childActivities = workspace.activities.filter(activity => activity.resourceId === created.issue.id && activity.action === '티켓 생성');
  assert.equal(childActivities.length, 1);
  assert.equal(childActivities[0].actorId, actorId);
  const parentActivities = workspace.activities.filter(activity => activity.resourceId === parent.id && activity.action === '하위 업무 생성');
  assert.equal(parentActivities.length, 1);
  assert.equal(parentActivities[0].actorId, actorId);
  assert.equal(parentActivities[0].detail, `${created.issue.key} ${created.issue.title}`);
});

test('child receipts bind the parent, actor and request across restarts and refuse a moved or removed result', async t => {
  const { call, createParent, restart } = await fixture(t);
  const parent = await createParent('결제 업무');
  const other = await createParent('다른 상위 업무');
  const request = requestFor(parent, { title: '결제 확인', labels: ['검수'] });
  const { data: created } = await call<IssueChildCreationResult>(pathFor(parent.id), 'POST', request, 201);
  const { data: updatedParent } = await call<Issue>(`/issues/${parent.id}`, 'PATCH', { expectedVersion: parent.version, title: '수정한 상위 업무' });
  await restart();

  const reordered = { ...request, issue: { labels: ['검수'], title: '결제 확인' } };
  const { data: replay } = await call<IssueChildCreationResult>(pathFor(parent.id), 'POST', reordered);
  assert.deepEqual(replay, { ...created, duplicate: true });
  const { data: stale } = await call<{ details: { currentVersion: number } }>(pathFor(parent.id), 'POST', { ...request, requestId: randomUUID() }, 409);
  assert.equal(stale.details.currentVersion, updatedParent.version);
  await call(pathFor(parent.id), 'POST', request, 409, 'user-min');
  await call(pathFor(other.id), 'POST', request, 409);
  await call(pathFor(parent.id), 'POST', { ...request, issue: { ...request.issue, title: '다른 입력' } }, 409);

  const { data: moved } = await call<Issue>(`/issues/${created.issue.id}`, 'PATCH', { expectedVersion: created.issue.version, parentId: other.id });
  await call(pathFor(parent.id), 'POST', request, 409);
  await call(`/issues/${moved.id}?expectedVersion=${moved.version}`, 'DELETE');
  await call(pathFor(parent.id), 'POST', request, 409);
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.ok(!workspace.issues.some(issue => issue.id === created.issue.id || issue.parentId === parent.id));
});

test('child creation rolls back sequence and activity on receipt failure and survives export and restore', async t => {
  const { call, createParent, directory } = await fixture(t);
  const parent = await createParent('복원 대상 상위 업무');
  const request = requestFor(parent, { title: '복원 대상 하위 업무' });
  const { data: before } = await call<WorkspaceSnapshot>('/workspace');
  const observer = new DatabaseSync(join(directory, 'donefac.sqlite'));
  const nextNumber = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number;
  let number: ReturnType<typeof nextNumber>;
  try {
    number = nextNumber();
    observer.exec("CREATE TRIGGER fail_child_receipt BEFORE INSERT ON issue_child_requests BEGIN SELECT RAISE(ABORT,'synthetic child receipt failure'); END");
    await call(pathFor(parent.id), 'POST', request, 500);
    assert.equal(nextNumber(), number);
    const { data: rolledBack } = await call<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(rolledBack.issues, before.issues);
    assert.deepEqual(rolledBack.activities, before.activities);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_child_receipt');
    observer.close();
  }

  const { data: created } = await call<IssueChildCreationResult>(pathFor(parent.id), 'POST', request, 201);
  assert.equal(created.issue.key, `${parent.key.slice(0, parent.key.lastIndexOf('-'))}-${number}`);
  const { data: backup } = await call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.issues.find(issue => issue.id === created.issue.id)?.parentId, parent.id);
  await call('/import', 'POST', { data: backup });
  const { data: stale } = await call<{ details: { currentVersion: number } }>(pathFor(parent.id), 'POST', request, 409);
  assert.ok(stale.details.currentVersion > parent.version);
  const { data: restored } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.issues.filter(issue => issue.parentId === parent.id).map(issue => issue.id), [created.issue.id]);
});
