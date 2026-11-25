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
import { isIntakeNotificationKind } from '../../shared/types.js';
import type {
  IssueIntakePage, IssueIntakeRequest, IssueIntakeResult, ProjectIssueSchema, ProjectWorkflow, TeamNotification, TeamNotificationPage, WorkspaceSnapshot,
} from '../../shared/types.js';

const project = 'project-neo';
const path = `/projects/${project}/intake`;
const reviewer = 'user-seo';
const reporter = 'user-min';
const conflict = (reason: string) => (data: { details?: { reason?: string } }) => assert.equal(data.details?.reason, reason);

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-intake-'));
  async function open() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    return { runtime, server, base };
  }
  let service = await open();
  async function close() {
    service.server.closeAllConnections();
    await new Promise<void>(resolve => service.server.close(() => resolve()));
    service.runtime.close();
  }
  const database = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  t.after(async () => {
    await close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function request<T = unknown>(url: string, method = 'GET', body?: unknown, status: number | number[] = 200, actor = reviewer) {
    const response = await fetch(service.base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as T;
    assert.ok([status].flat().includes(response.status), `${response.status} ${JSON.stringify(data)}`);
    return { status: response.status, data };
  }
  const workspace = async () => (await request<WorkspaceSnapshot>('/workspace')).data;
  const generation = async () => {
    const value = (await workspace()).restoreGeneration;
    assert.ok(value);
    return value;
  };
  const outcomeNotifications = async (actor = reporter) =>
    (await request<TeamNotificationPage>('/notifications', 'GET', undefined, 200, actor)).data.items.filter(row => isIntakeNotificationKind(row.kind));
  const pending = async (title: string, actor = reporter) => (await request<IssueIntakeResult>(path, 'POST', {
    requestId: randomUUID(), restoreGeneration: await generation(), title, description: '합성 요청 설명',
  }, 201, actor)).data.item;
  const decision = async (item: IssueIntakeRequest, body: Record<string, unknown>) => ({
    requestId: randomUUID(), restoreGeneration: await generation(), expectedVersion: item.version, ...body,
  });
  const workflowPath = `/projects/${project}/workflow`;
  const workflow = async () => (await request<ProjectWorkflow>(workflowPath)).data;
  const acceptFields = async (issue: Record<string, unknown>) => ({
    decision: 'accept', issue, expectedWorkflowVersion: (await workflow()).version,
    expectedIssueSchemaVersion: (await request<ProjectIssueSchema>(`/projects/${project}/issue-schema`)).data.version,
  });
  return { request, workspace, generation, pending, decision, workflowPath, workflow, acceptFields, database, outcomeNotifications,
    async restart() { await close(); service = await open(); } };
}

test('a project intake request is separate from the backlog and creates one ordinary ticket with its original reporter', async t => {
  const { request, workspace, generation, decision, acceptFields, restart, outcomeNotifications } = await fixture(t);
  const initial = await workspace();
  const payload = { requestId: randomUUID(), restoreGeneration: await generation(), title: '테스트 도구 요청', description: '빌드 단계를 간단히 확인한다.' };
  const create = () => request<IssueIntakeResult>(path, 'POST', payload, [200, 201], reporter);
  const first = await Promise.all([create(), create()]);
  assert.deepEqual(first.map(reply => reply.status).sort(), [200, 201]);
  const { item } = first[0].data;
  assert.deepEqual(first[1].data.item, item);
  assert.equal(item.status, 'pending');
  assert.equal(item.reporterId, reporter);
  assert.deepEqual((await workspace()).issues, initial.issues);
  assert.deepEqual(await outcomeNotifications(), []);
  const mine = (await request<IssueIntakePage>(`${path}?mine=1&q=${encodeURIComponent('빌드 단계')}`, 'GET', undefined, 200, reporter)).data;
  assert.deepEqual(mine.counts, { pending: 1, closed: 0 });
  assert.deepEqual(mine.items, [item]);
  assert.deepEqual((await request<IssueIntakePage>(`${path}?mine=1`)).data.items, []);
  const otherProject = initial.projects.find(value => value.id !== project)!;
  await request(`/projects/${otherProject.id}/intake/${item.id}`, 'GET', undefined, 404);
  conflict('request_reused')((await request<{ details?: { reason?: string } }>(path, 'POST', payload, 409)).data);

  const review = await decision(item, await acceptFields({ title: '빌드 확인 도구 추가', description: '검토 후 다듬은 작업 설명',
    type: '작업', status: 'in_progress', priority: 'high', assigneeId: reviewer, dueDate: '2027-04-09' }));
  const applied = (await request<IssueIntakeResult>(`${path}/${item.id}/decision`, 'POST', review)).data;
  assert.equal(applied.duplicate, false);
  assert.deepEqual(applied.item, { ...item, status: 'accepted', version: 2, updatedAt: applied.item.updatedAt,
    reviewerId: reviewer, issueId: applied.item.issueId, issueKey: applied.item.issueKey });
  assert.ok(applied.item.issueId && applied.item.issueKey);
  const saved = await workspace();
  assert.equal(saved.issues.length, initial.issues.length + 1);
  const issue = saved.issues.find(issue => issue.id === applied.item.issueId)!;
  assert.equal(issue.key, applied.item.issueKey);
  assert.equal(issue.reporterId, reporter);
  assert.equal(issue.assigneeId, reviewer);
  assert.equal(issue.title, '빌드 확인 도구 추가');
  assert.equal(issue.priority, 'high');
  assert.equal(issue.dueDate, '2027-04-09');
  assert.equal(saved.activities.filter(value => value.resourceId === issue.id && value.action === '티켓 생성').length, 1);
  assert.equal(saved.activities.filter(value => value.resourceId === project && value.action === '접수 업무 등록').length, 1);
  assert.deepEqual((await request<IssueIntakeRequest>(`${path}/${item.id}`)).data, applied.item);
  assert.deepEqual((await request<IssueIntakePage>(`${path}?state=closed&q=${applied.item.issueKey}`)).data.items, [applied.item]);
  const notifications = await outcomeNotifications();
  assert.equal(notifications.length, 1);
  const { id: notificationId, ...notice } = notifications[0];
  assert.ok(notificationId);
  assert.deepEqual(notice, { actorId: reviewer, recipientId: reporter, projectId: project, targetId: item.id,
    kind: 'intake-accepted', targetLabel: item.title, createdAt: applied.item.updatedAt, readAt: null });
  assert.deepEqual(await outcomeNotifications(reviewer), []);
  await restart();
  assert.deepEqual((await request<IssueIntakeResult>(`${path}/${item.id}/decision`, 'POST', review)).data, { ...applied, duplicate: true });
  assert.deepEqual((await workspace()).issues, saved.issues);
  assert.deepEqual(await outcomeNotifications(), notifications);
});

test('intake reviews guard current workflow, required dates, duplicate scope and competing decisions', async t => {
  const { request, workspace, pending, decision, workflow, workflowPath, acceptFields, outcomeNotifications } = await fixture(t);
  const item = await pending('경쟁 변경을 확인할 접수');
  const route = `${path}/${item.id}/decision`;
  const readConflict = async (body: object, reason: string) =>
    conflict(reason)((await request<{ details?: { reason?: string } }>(route, 'POST', body, 409)).data);
  const old = await decision(item, await acceptFields({}));
  const current = await workflow();
  await request(workflowPath, 'PATCH', { ...current, expectedVersion: current.version,
    fieldRules: [{ issueType: '*', statusId: current.initialStatusId, requiredFields: ['dueDate'] }] });
  await readConflict(old, 'stale_workflow');
  await request(route, 'POST', await decision(item, await acceptFields({})), 422);
  await request(route, 'POST', await decision(item, { decision: 'reject', reason: ' ' }), 400);
  const saved = await workspace();
  const otherProject = saved.projects.find(value => value.id !== project)!.id;
  const foreign = saved.issues.find(value => value.projectId === otherProject)!;
  const existing = saved.issues.find(value => value.projectId === project)!;
  await readConflict(await decision(item, { decision: 'duplicate', issueId: foreign.id, expectedIssueVersion: foreign.version }), 'stale_target');
  await readConflict(await decision(item, { decision: 'duplicate', issueId: existing.id, expectedIssueVersion: existing.version + 1 }), 'stale_target');
  const selected = await decision(item, { decision: 'duplicate', issueId: existing.id, expectedIssueVersion: existing.version });
  const duplicate = (await request<IssueIntakeResult>(route, 'POST', selected)).data;
  assert.match(duplicate.item.issueKey ?? '', new RegExp(`^${existing.key}$`));
  assert.equal(duplicate.item.status, 'duplicate');
  await readConflict(await decision(item, { decision: 'reject', reason: '늦은 사유' }), 'stale_request');
  assert.deepEqual((await workspace()).issues, saved.issues);
  const other = await pending('반려할 요청');
  const rejected = (await request<IssueIntakeResult>(`${path}/${other.id}/decision`, 'POST',
    await decision(other, { decision: 'reject', reason: '다음 분기 과제로 다시 접수합니다.' }))).data;
  assert.equal(rejected.item.status, 'rejected');
  assert.equal(rejected.item.issueId, null);
  assert.equal(rejected.item.reason, '다음 분기 과제로 다시 접수합니다.');
  const closed = (await request<IssueIntakePage>(`${path}?state=closed&offset=100`)).data;
  assert.equal(closed.offset, 0);
  assert.deepEqual(closed.counts, { pending: 0, closed: 2 });
  const self = await pending('요청자가 직접 검토할 요청', reviewer);
  await request(`${path}/${self.id}/decision`, 'POST', await decision(self, { decision: 'reject', reason: '직접 정리했습니다.' }));
  assert.deepEqual(await outcomeNotifications(reviewer), []);
  assert.deepEqual((await outcomeNotifications()).map(({ kind, targetId }) => ({ kind, targetId })), [
    { kind: 'intake-rejected', targetId: other.id }, { kind: 'intake-duplicate', targetId: item.id },
  ]);
});

test('intake issue, queue transition and receipt roll back together and survive exchange backup', async t => {
  const { request, workspace, pending, decision, acceptFields, database, outcomeNotifications } = await fixture(t);
  const item = await pending('저장 결과 실패를 검증할 요청');
  const route = `${path}/${item.id}/decision`;
  const apply = await decision(item, await acceptFields({}));
  const original = await workspace();
  const sequence = () => database.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(project);
  const beforeSequence = sequence();
  database.exec(`CREATE TRIGGER synthetic_intake_rollback BEFORE INSERT ON issue_intake_receipts BEGIN
    SELECT RAISE(ABORT, 'synthetic intake receipt failure');
  END`);
  try {
    await request(route, 'POST', apply, 500);
    assert.deepEqual((await request<IssueIntakeRequest>(`${path}/${item.id}`)).data, item);
    assert.deepEqual(await workspace(), original);
    assert.deepEqual(sequence(), beforeSequence);
    assert.deepEqual(await outcomeNotifications(), []);
  } finally {
    database.exec('DROP TRIGGER synthetic_intake_rollback');
  }
  const applied = (await request<IssueIntakeResult>(route, 'POST', apply)).data.item;
  const [notification] = await outcomeNotifications();
  await request(`/notifications/${notification.id}/read`, 'PATCH', undefined, 200, reporter);
  const stillPending = await pending('백업에서 이어서 검토할 요청');
  const data = (await request<{ schemaVersion: number; issueIntake: IssueIntakeRequest[]; teamNotifications: TeamNotification[] }>('/export')).data;
  assert.equal(data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(data.issueIntake.map(row => row.id).sort(), [applied.id, stillPending.id].sort());
  await request('/import', 'POST', { data: { ...data, issueIntake: [{ ...applied, reviewerId: null }] } }, 400);
  assert.deepEqual((await request<IssueIntakeRequest>(`${path}/${item.id}`)).data, applied);
  await request('/import', 'POST', { data: { ...data, schemaVersion: 128 } }, 400);
  await request('/import', 'POST', { data: { ...data, schemaVersion: 129 } }, 400);
  const savedNotices = await outcomeNotifications();
  assert.ok(savedNotices[0].readAt);
  const unrelatedActor = original.users.find(user => user.id !== reviewer && user.id !== reporter)!.id;
  const badTargets: Partial<TeamNotification>[] = [
    { projectId: null }, { kind: 'intake-rejected' }, { targetId: stillPending.id }, { targetId: randomUUID() },
    { recipientId: unrelatedActor }, { actorId: unrelatedActor },
  ];
  for (const invalid of badTargets) {
    const teamNotifications = data.teamNotifications.map(value => value.id === notification.id ? { ...value, ...invalid } : value);
    await request('/import', 'POST', { data: { ...data, teamNotifications } }, 400);
    assert.deepEqual(await outcomeNotifications(), savedNotices);
  }
  await request('/import', 'POST', { data: { ...data, teamNotifications: [...data.teamNotifications, { ...savedNotices[0], id: randomUUID() }] } }, 400);
  assert.deepEqual(await outcomeNotifications(), savedNotices);
  await request('/import', 'POST', { data });
  const restored = (await request<IssueIntakeRequest>(`${path}/${item.id}`)).data;
  assert.deepEqual(restored, { ...applied, version: applied.version + 1 });
  assert.deepEqual((await request<IssueIntakeRequest>(`${path}/${stillPending.id}`)).data, { ...stillPending, version: stillPending.version + 1 });
  assert.equal((await workspace()).issues.filter(value => value.id === applied.issueId).length, 1);
  assert.deepEqual(await outcomeNotifications(), savedNotices);
  conflict('workspace_changed')((await request<{ details?: { reason?: string } }>(route, 'POST', apply, 409)).data);
  await request('/import', 'POST', { data: { ...data, schemaVersion: 129,
    teamNotifications: data.teamNotifications.filter(value => !isIntakeNotificationKind(value.kind)) } });
  assert.deepEqual(await outcomeNotifications(), []);
  assert.equal((await request<IssueIntakeRequest>(`${path}/${item.id}`)).data.status, 'accepted');
});
