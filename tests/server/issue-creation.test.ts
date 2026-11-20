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
import type { ApiKeyCreated, Issue, WebhookEndpointCreated, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const assigneeId = 'user-min';
type Failure = { details: { reason: string } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-create-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  async function stop() {
    service.server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())); }
    finally { service.runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { observer.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, statuses: number | number[] = 200,
    actor = actorId, token?: string) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.ok([statuses].flat().includes(response.status), `${method} ${path}: ${response.status} ${body}`);
    return { status: response.status, data: JSON.parse(body) as T };
  }
  async function enableOutbox() {
    const { data: { endpoint } } = await call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', {
      name: '합성 업무 생성', url: 'http://127.0.0.1:9/receiver', eventTypes: ['issue.created'], projectIds: [projectId],
    }, 201);
    await call(`/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  function sideEffects() {
    const nextNumber = Number(observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number);
    const totals = ['issues', 'activities', 'team_notifications', 'webhook_events', 'webhook_deliveries', 'issue_creation_requests']
      .map(table => Number(observer.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total));
    return [nextNumber, ...totals];
  }
  return { call, enableOutbox, observer, sideEffects, async restart() { await stop(); service = await start(); } };
}

test('ordinary ticket retries allocate one issue, key, audit, notification and outbound event', async t => {
  const { call, enableOutbox, sideEffects, restart } = await fixture(t);
  await enableOutbox();
  const before = sideEffects();
  const first = { requestId: randomUUID(), projectId, title: '긴급 일정 입력', assigneeId,
    labels: ['검수'], startDate: '2026-11-23', endDate: '2026-11-27', clientData: { nested: [null, { code: 1, selected: false }] } };
  const reordered = { clientData: { nested: [null, { selected: false, code: 1 }] }, assigneeId, endDate: first.endDate,
    requestId: first.requestId.toUpperCase(), title: first.title, projectId, startDate: first.startDate, labels: first.labels };

  for (const requestId of [null, 0, '', 'invalid', '00000000-0000-1000-8000-000000000000']) {
    const { data } = await call<Failure>('/issues', 'POST', { ...first, requestId }, 400);
    assert.equal(data.details.reason, 'invalid_request_id');
  }
  assert.deepEqual(sideEffects(), before);
  const requests = await Promise.all([first, reordered].map(input => call<Issue>('/issues', 'POST', input, [200, 201])));
  assert.deepEqual(requests.map(value => value.status).sort(), [200, 201]);
  const issue = requests[0].data;
  assert.deepEqual(requests[1].data, issue);
  assert.equal(issue.key, `NEO-${before[0]}`);
  assert.equal(issue.startDate, first.startDate);
  assert.equal(issue.endDate, first.endDate);
  assert.deepEqual(sideEffects(), before.map(value => value + 1));
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.filter(value => value.title === first.title), [issue]);
  assert.equal(workspace.activities.filter(value => value.resourceId === issue.id && value.action === '티켓 생성').length, 1);

  for (const changed of [
    { ...first, title: '다른 업무' }, { ...first, dueDate: null }, { ...first, projectId: 'project-team' },
    { ...first, clientData: { nested: [null, { code: '1', selected: false }] } },
  ]) {
    const { data } = await call<Failure>('/issues', 'POST', changed, 409);
    assert.equal(data.details.reason, 'request_conflict');
  }
  assert.equal((await call<Failure>('/issues', 'POST', first, 409, assigneeId)).data.details.reason, 'request_conflict');
  const { data: updated } = await call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, title: '저장 뒤 수정' });
  await restart();
  assert.deepEqual((await call<Issue>('/issues', 'POST', reordered)).data, updated);
});

test('a failed create or receipt insert rolls back the issue and all side effects and permits retry', async t => {
  const { call, enableOutbox, observer, sideEffects } = await fixture(t);
  await enableOutbox();
  const request = { requestId: randomUUID(), projectId, title: '복구할 업무', assigneeId };
  const before = sideEffects();
  await call('/issues', 'POST', { ...request, title: '' }, 400);
  observer.exec("CREATE TRIGGER fail_issue_creation_receipt BEFORE INSERT ON issue_creation_requests BEGIN SELECT RAISE(ABORT,'synthetic issue receipt failure'); END");
  try {
    await call('/issues', 'POST', request, 500);
    assert.deepEqual(sideEffects(), before);
  } finally { observer.exec('DROP TRIGGER fail_issue_creation_receipt'); }
  const { data } = await call<Issue>('/issues', 'POST', request, 201);
  assert.equal(data.key, `NEO-${before[0]}`);
  assert.deepEqual((await call<Issue>('/issues', 'POST', request)).data, data);
  assert.deepEqual(sideEffects(), before.map(value => value + 1));

  const legacy = { projectId, title: request.title, assigneeId };
  const legacyFirst = await call<Issue>('/issues', 'POST', legacy, 201);
  const legacySecond = await call<Issue>('/issues', 'POST', legacy, 201);
  assert.notEqual(legacyFirst.data.id, legacySecond.data.id);
});

test('used issue request IDs survive deletion, trash restoration and workspace replacement', async t => {
  const { call, observer, restart } = await fixture(t);
  const input = { requestId: randomUUID(), projectId, title: '복원할 신규 업무' };
  const { data: issue } = await call<Issue>('/issues', 'POST', input, 201);
  const { data: { trashEntryId } } = await call<{ trashEntryId: string }>(`/issues/${issue.id}?expectedVersion=${issue.version}`, 'DELETE');
  const retryUnavailable = async () => {
    assert.equal((await call<Failure>('/issues', 'POST', input, 409)).data.details.reason, 'result_unavailable');
  };
  await retryUnavailable();
  await call(`/trash/${trashEntryId}/restore`, 'POST', {});
  const { data: restored } = await call<Issue>('/issues', 'POST', input);
  assert.equal(restored.id, issue.id);
  assert.ok(restored.version > issue.version);

  const { data: backup } = await call<WorkspaceSnapshot>('/export');
  assert.ok(!JSON.stringify(backup).includes(input.requestId));
  observer.exec("CREATE TRIGGER fail_issue_replacement BEFORE INSERT ON issues BEGIN SELECT RAISE(ABORT,'synthetic issue replacement failure'); END");
  try {
    await call('/import', 'POST', { data: backup }, 500);
    assert.deepEqual((await call<Issue>('/issues', 'POST', input)).data, restored);
  } finally { observer.exec('DROP TRIGGER fail_issue_replacement'); }
  await call('/import', 'POST', { data: backup });
  await restart();
  await retryUnavailable();
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.filter(value => value.title === input.title).map(value => value.id), [issue.id]);
  const { data: newIssue } = await call<Issue>('/issues', 'POST', { ...input, requestId: randomUUID() }, 201);
  assert.notEqual(newIssue.id, issue.id);
});

test('public API creation retries retain the fixed actor and enforce write and project scopes', async t => {
  const { call } = await fixture(t);
  async function key(project: string, access: 'read' | 'write', actor = actorId) {
    return (await call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 업무 생성 키', projectIds: [project], access, expiresAt: null }, 201, actor)).data.token;
  }
  const write = await key(projectId, 'write');
  const otherScope = await key('project-team', 'write');
  const otherActor = await key(projectId, 'write', assigneeId);
  const read = await key(projectId, 'read');
  const input = { requestId: randomUUID(), projectId, title: 'API 생성 재시도', actorId: assigneeId };
  const { data: issue } = await call<Issue>('/v1/issues', 'POST', input, 201, assigneeId, write);
  assert.deepEqual((await call<Issue>('/v1/issues', 'POST', input, 200, assigneeId, write)).data, issue);
  await call('/v1/issues', 'POST', input, 403, actorId, otherScope);
  await call('/v1/issues', 'POST', input, 403, actorId, read);
  assert.equal((await call<Failure>('/v1/issues', 'POST', input, 409, actorId, otherActor)).data.details.reason, 'request_conflict');
  assert.equal((await call<Failure>('/v1/issues', 'POST', { ...input, projectId: 'project-team' }, 409, actorId, otherScope)).data.details.reason, 'request_conflict');
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.filter(value => value.title === input.title), [issue]);
  assert.equal(workspace.activities.find(value => value.resourceId === issue.id && value.action === '티켓 생성')?.actorId, actorId);
});
