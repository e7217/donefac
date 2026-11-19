import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, Issue, Project, ProjectIssueOrder, ProjectWorkflow, ReportingLedgerData, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number; issueOrders: ProjectIssueOrder[]; reportingLedger: ReportingLedgerData };
type MoveResult = { order: ProjectIssueOrder; issue: Issue };
const projectPath = (projectId: string) => `/projects/${projectId}/issue-order`;

async function server(dataDir: string) {
  const runtime = createApp({ dataDir, outboundWorker: false });
  const listener = runtime.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('테스트 서버 주소를 확인할 수 없습니다.');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function request<T = unknown>(path: string, method = 'GET', body?: unknown, token?: string) {
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  }
  async function read<T>(path: string) {
    const response = await request<T>(path);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function createIssue(projectId: string, title: string, status = 'todo') {
    const response = await request<Issue>('/issues', 'POST', { projectId, title, status });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  function move(order: ProjectIssueOrder, issue: Issue, anchor: Issue | null, position: 'before' | 'after', status?: string) {
    return request<MoveResult>(projectPath(order.projectId), 'PATCH', moveBody(order, issue, anchor, position, status));
  }
  return {
    request, read, createIssue, move,
    order: (projectId: string) => read<ProjectIssueOrder>(projectPath(projectId)),
    snapshot: () => read<WorkspaceSnapshot>('/workspace'),
    async close() { await new Promise<void>(resolve => listener.close(() => resolve())); runtime.close(); },
  };
}

function moveBody(order: ProjectIssueOrder, issue: Issue, anchor: Issue | null, position: 'before' | 'after', status?: string) {
  return { issueId: issue.id, expectedVersion: order.version, expectedIssueVersion: issue.version, anchorId: anchor?.id ?? null, position, ...(status === undefined ? {} : { status }) };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-issue-order-'));
  let current = await server(dir);
  return {
    get api() { return current; },
    async restart() { await current.close(); current = await server(dir); },
    async close() { await current.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('manual project order persists across restart, preserves hidden peers and handles issue membership', async () => {
  const f = await fixture();
  try {
    const created = await f.api.request<Project>('/projects', 'POST', { key: 'RANK', name: '공유 업무 순서' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const projectId = created.data.id;
    const empty = await f.api.order(projectId);
    assert.deepEqual(empty.issueIds, []);
    const a = await f.api.createIssue(projectId, '첫 번째 업무');
    const hiddenOne = await f.api.createIssue(projectId, '필터에서 가려진 업무 1');
    const hiddenTwo = await f.api.createIssue(projectId, '필터에서 가려진 업무 2');
    const b = await f.api.createIssue(projectId, '두 번째 업무');
    const initial = await f.api.order(projectId);
    assert.deepEqual(initial.issueIds, [a.id, hiddenOne.id, hiddenTwo.id, b.id]);
    assert.notEqual(initial.version, empty.version);
    const otherProject = await f.api.order('project-neo');
    const foreign = (await f.api.snapshot()).issues.find(issue => issue.projectId === otherProject.projectId)!;
    assert.equal((await f.api.move(initial, b, foreign, 'before')).status, 409);
    assert.equal((await f.api.move(initial, foreign, b, 'before')).status, 409);
    assert.equal((await f.api.move(initial, b, b, 'before')).status, 400);

    const moved = await f.api.move(initial, b, a, 'before');
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.deepEqual(moved.data.order.issueIds, [b.id, a.id, hiddenOne.id, hiddenTwo.id]);
    assert.notEqual(moved.data.order.version, initial.version);
    assert.deepEqual(moved.data.issue, b);
    const snapshot = await f.api.snapshot();
    assert.deepEqual(snapshot.issueOrders?.find(order => order.projectId === projectId), moved.data.order);
    assert.ok(snapshot.activities.some(activity => activity.resourceType === 'issue' && activity.resourceId === b.id && /순서/.test(activity.action)));
    assert.deepEqual(await f.api.order(otherProject.projectId), otherProject);
    const noOp = await f.api.move(moved.data.order, b, a, 'before');
    assert.equal(noOp.status, 200, JSON.stringify(noOp.data));
    assert.deepEqual(noOp.data, moved.data);
    assert.deepEqual((await f.api.snapshot()).activities, snapshot.activities);
    assert.equal((await f.api.move(initial, a, null, 'before')).status, 409);

    const next = await f.api.createIssue(projectId, '새로 만든 업무');
    const afterCreate = await f.api.order(projectId);
    assert.deepEqual(afterCreate.issueIds, [...moved.data.order.issueIds, next.id]);
    assert.equal((await f.api.move(moved.data.order, b, a, 'after')).status, 409);
    const deleted = await f.api.request<{ trashEntryId: string }>(`/issues/${b.id}?expectedVersion=${b.version}`, 'DELETE');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const afterDelete = await f.api.order(projectId);
    assert.deepEqual(afterDelete.issueIds, [a.id, hiddenOne.id, hiddenTwo.id, next.id]);
    assert.equal((await f.api.move(afterDelete, a, b, 'after')).status, 409);
    assert.equal((await f.api.request(`/trash/${deleted.data.trashEntryId}/restore`, 'POST', {})).status, 200);
    const afterRestore = await f.api.order(projectId);
    assert.deepEqual(afterRestore.issueIds, [...afterDelete.issueIds, b.id]);
    assert.equal((await f.api.move(afterCreate, a, b, 'after')).status, 409);

    await f.restart();
    assert.deepEqual(await f.api.order(projectId), afterRestore);
  } finally { await f.close(); }
});

test('board movement atomically checks the current column, required fields and issue version', async () => {
  const f = await fixture();
  try {
    const projectId = 'project-neo';
    const moving = await f.api.createIssue(projectId, '완료 열로 옮길 일');
    const anchor = await f.api.createIssue(projectId, '기존 완료 업무', 'done');
    const workflowPath = `/projects/${projectId}/workflow`;
    const workflow = await f.api.read<ProjectWorkflow>(workflowPath);
    const updated = await f.api.request(workflowPath, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'done' ? { ...edge, requiredFields: ['description'] } : edge),
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    const initial = await f.api.order(projectId);
    const before = await f.api.snapshot();
    const missing = await f.api.move(initial, moving, anchor, 'after', 'done');
    assert.equal(missing.status, 422, JSON.stringify(missing.data));
    assert.match(JSON.stringify(missing.data), /description/);
    assert.deepEqual(await f.api.order(projectId), initial);
    assert.deepEqual(await f.api.snapshot(), before);

    const shiftedAnchor = await f.api.request<Issue>(`/issues/${anchor.id}`, 'PATCH', { expectedVersion: anchor.version, status: 'in_progress' });
    assert.equal(shiftedAnchor.status, 200, JSON.stringify(shiftedAnchor.data));
    assert.equal((await f.api.move(initial, moving, anchor, 'after', 'done')).status, 409);
    const shiftedOrder = await f.api.order(projectId);
    assert.equal((await f.api.move(shiftedOrder, moving, shiftedAnchor.data, 'after', 'done')).status, 409);
    assert.deepEqual(await f.api.order(projectId), shiftedOrder);
    const restoredAnchor = await f.api.request<Issue>(`/issues/${anchor.id}`, 'PATCH', { expectedVersion: shiftedAnchor.data.version, status: 'done' });
    assert.equal(restoredAnchor.status, 200, JSON.stringify(restoredAnchor.data));
    const detailed = await f.api.request<Issue>(`/issues/${moving.id}`, 'PATCH', { expectedVersion: moving.version, description: '검증 결과 첨부 완료' });
    assert.equal(detailed.status, 200, JSON.stringify(detailed.data));
    const current = await f.api.order(projectId);
    assert.equal((await f.api.move(current, moving, restoredAnchor.data, 'after', 'done')).status, 409);
    const success = await f.api.move(current, detailed.data, restoredAnchor.data, 'after', 'done');
    assert.equal(success.status, 200, JSON.stringify(success.data));
    assert.deepEqual(success.data.order.issueIds.slice(-2), [anchor.id, moving.id]);
    assert.equal(success.data.issue.status, 'done');
    assert.equal(success.data.issue.version, detailed.data.version + 1);
    assert.ok(success.data.issue.completedAt);
    const backup = await f.api.read<Backup>('/export');
    assert.ok(backup.reportingLedger.events.some(event => event.issueId === moving.id && event.before?.statusId === 'todo' && event.after?.statusId === 'done'));
  } finally { await f.close(); }
});

test('schema 23 validates the complete project order and restore invalidates earlier order versions', async () => {
  const f = await fixture();
  try {
    const projectId = 'project-neo';
    const a = await f.api.createIssue(projectId, '백업 전 업무 A');
    const b = await f.api.createIssue(projectId, '백업 전 업무 B');
    const initial = await f.api.order(projectId);
    const first = await f.api.move(initial, b, a, 'before');
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const exported = await f.api.read<Backup>('/export');
    assert.equal(exported.schemaVersion, 23);
    assert.deepEqual(exported.issueOrders.find(order => order.projectId === projectId)?.issueIds, first.data.order.issueIds);
    const second = await f.api.move(first.data.order, a, b, 'before');
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.deepEqual(second.data.order.issueIds, initial.issueIds);
    for (const modification of ['duplicates', 'foreign', 'missing-project'] as const) {
      const invalid = structuredClone(exported);
      const record = invalid.issueOrders.find(order => order.projectId === projectId)!;
      if (modification === 'duplicates') record.issueIds[1] = record.issueIds[0];
      else if (modification === 'foreign') record.issueIds[1] = invalid.issues.find(issue => issue.projectId !== projectId)!.id;
      else invalid.issueOrders = invalid.issueOrders.filter(order => order.projectId !== projectId);
      assert.equal((await f.api.request('/import', 'POST', { data: invalid })).status, 400, modification);
      assert.deepEqual(await f.api.order(projectId), second.data.order);
    }

    assert.equal((await f.api.request('/import', 'POST', { data: exported })).status, 200);
    const restored = await f.api.order(projectId);
    assert.deepEqual(restored.issueIds, first.data.order.issueIds);
    assert.notEqual(restored.version, first.data.order.version);
    const refreshedB = (await f.api.snapshot()).issues.find(issue => issue.id === b.id)!;
    assert.equal((await f.api.move(first.data.order, refreshedB, a, 'after')).status, 409);

    const { issueOrders: priorOrders, ...legacyFields } = exported;
    assert.ok(priorOrders.length);
    assert.equal((await f.api.request('/import', 'POST', { data: { ...legacyFields, schemaVersion: 22 } })).status, 200);
    const legacy = await f.api.order(projectId);
    assert.deepEqual(legacy.issueIds, initial.issueIds);
    assert.notEqual(legacy.version, initial.version);
  } finally { await f.close(); }
});

test('scoped automation keys can read or reorder only within their authorized project', async () => {
  const f = await fixture();
  try {
    const projectId = 'project-neo';
    const a = await f.api.createIssue(projectId, 'API 순서 A');
    const b = await f.api.createIssue(projectId, 'API 순서 B');
    const path = `/v1${projectPath(projectId)}`;
    const readonly = await f.api.request<ApiKeyCreated>('/api-keys', 'POST', { name: '순서 조회', access: 'read', projectIds: [projectId], expiresAt: null });
    const writable = await f.api.request<ApiKeyCreated>('/api-keys', 'POST', { name: '순서 편집', access: 'write', projectIds: [projectId], expiresAt: null });
    assert.equal(readonly.status, 201, JSON.stringify(readonly.data));
    assert.equal(writable.status, 201, JSON.stringify(writable.data));
    const order = await f.api.order(projectId);
    const read = await f.api.request<ProjectIssueOrder>(path, 'GET', undefined, readonly.data.token);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.deepEqual(read.data, order);
    assert.equal((await f.api.request(`/v1${projectPath('project-team')}`, 'GET', undefined, readonly.data.token)).status, 403);
    const body = moveBody(order, b, a, 'before');
    assert.equal((await f.api.request(path, 'PATCH', body, readonly.data.token)).status, 403);
    assert.deepEqual(await f.api.order(projectId), order);
    const written = await f.api.request<MoveResult>(path, 'PATCH', body, writable.data.token);
    assert.equal(written.status, 200, JSON.stringify(written.data));
    assert.deepEqual(written.data.order.issueIds.slice(-2), [b.id, a.id]);
    assert.equal(written.data.issue.version, b.version);
  } finally { await f.close(); }
});
