import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  CycleCopyPreview, CycleCopyResult, Dependency, Issue, PlanningItem, ProjectWorkflow, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const copyPath = (cycle: PlanningItem) => `/planning-items/${cycle.id}/copy`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-cycle-copy-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const database = new DatabaseSync(join(directory, 'donefac.sqlite'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function request<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, actor = actorId): Promise<T> {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data as T;
  }
  const plan = (name: string, fields: Partial<PlanningItem> = {}) =>
    request<PlanningItem>('/planning-items', 'POST', { projectId, kind: 'cycle', name, ...fields }, 201);
  const issue = (title: string, fields: Partial<Issue> = {}) =>
    request<Issue>('/issues', 'POST', { projectId, title, ...fields }, 201);
  const link = (before: Issue, after: Issue, fields: Partial<Dependency> = {}) =>
    request<Dependency>('/dependencies', 'POST', { predecessorId: before.id, successorId: after.id, ...fields }, 201);
  const preview = (cycle: PlanningItem, name: string, issues: Issue[], dateShiftDays = 0, status = 200) =>
    request<CycleCopyPreview>(`${copyPath(cycle)}-preview`, 'POST', {
      expectedVersion: cycle.version, name, dateShiftDays, issues: issues.map(({ id, version }) => ({ id, expectedVersion: version })),
    }, status);
  const apply = <T = CycleCopyResult>(cycle: PlanningItem, previewId: string | null, status = 201, actor = actorId) =>
    request<T>(copyPath(cycle), 'POST', { previewId }, status, actor);
  const workspace = () => request<WorkspaceSnapshot>('/workspace');
  return { request, plan, issue, link, preview, apply, workspace, database };
}

test('cycle copy preserves the selected schedule and hierarchy in normal project order', async t => {
  const { plan, issue, link, preview, apply, workspace, request } = await fixture(t);
  const cycle = await plan('반복 배포 원본', { description: '주간 배포 절차', status: 'active', ownerId: 'user-min',
    startDate: '2026-12-01', endDate: '2026-12-03', targetDate: '2026-12-04' });
  const first = await issue('릴리스 준비', { cycleId: cycle.id, status: 'done', description: '**검증**', descriptionFormat: 'markdown',
    priority: 'high', assigneeId: 'user-min', collaboratorIds: ['user-seo'], labels: ['릴리스'], estimate: 2, plannedEffortMinutes: 90,
    startDate: '2026-12-01', endDate: '2026-12-02', dueDate: '2026-12-03' });
  const second = await issue('배포 점검', { cycleId: cycle.id, parentId: first.id, startDate: '2026-12-02', endDate: '2026-12-03' });
  const outside = await issue('복제 범위 바깥', { cycleId: cycle.id });
  const third = await issue('후속 공지', { cycleId: cycle.id, parentId: outside.id });
  const inward = await link(outside, second);
  const outward = await link(first, outside);
  const internal = await link(first, second, { type: 'SS', lagDays: 2 });
  const original = await workspace();
  const workflow = await request<ProjectWorkflow>(`/projects/${projectId}/workflow`);
  const overview = await preview(cycle, '반복 배포 새 계획', [third, second, first], 7);
  assert.ok(overview.previewId && overview.expiresAt);
  assert.deepEqual(overview.errors, []);
  assert.deepEqual(overview.cycle, { name: '반복 배포 새 계획', ownerId: 'user-min',
    startDate: '2026-12-08', endDate: '2026-12-10', targetDate: '2026-12-11' });
  assert.deepEqual(overview.rows.map(({ sourceIssueId, parentKey, statusId, startDate, endDate, dueDate }) =>
    [sourceIssueId, parentKey, statusId, startDate, endDate, dueDate]), [
    [first.id, null, workflow.initialStatusId, '2026-12-08', '2026-12-09', '2026-12-10'],
    [second.id, first.key, workflow.initialStatusId, '2026-12-09', '2026-12-10', null],
    [third.id, null, workflow.initialStatusId, null, null, null],
  ]);
  assert.deepEqual(overview.omitted, { parents: 1, dependencies: 2 });
  assert.equal(overview.dependencies.length, 1);
  assert.match(overview.dependencies[0].warning ?? '', /2026-12-10/u);
  assert.deepEqual(await workspace(), original);

  const copied = await apply(cycle, overview.previewId);
  assert.equal(copied.cycle.status, 'planned');
  assert.equal(copied.cycle.description, cycle.description);
  assert.equal(copied.dependencies, 1);
  assert.deepEqual(copied.issues.map(row => row.sourceIssueId), [first.id, second.id, third.id]);
  const current = await workspace();
  const targetIds = copied.issues.map(row => row.id);
  const targets = targetIds.map(id => current.issues.find(row => row.id === id)!);
  assert.ok(targets.every(row => row.projectId === projectId && row.cycleId === copied.cycle.id &&
    row.status === workflow.initialStatusId && row.completedAt === null && row.version === 1));
  assert.deepEqual(targets.map(row => row.parentId), [null, targetIds[0], null]);
  const { description, descriptionFormat, assigneeId, collaboratorIds, priority, labels, estimate, plannedEffortMinutes } = targets[0];
  assert.deepEqual({ description, descriptionFormat, assigneeId, collaboratorIds, priority, labels, estimate, plannedEffortMinutes },
    { description: first.description, descriptionFormat: 'markdown', assigneeId: first.assigneeId, collaboratorIds: first.collaboratorIds,
      priority: first.priority, labels: first.labels, estimate: first.estimate, plannedEffortMinutes: first.plannedEffortMinutes });
  const newLinks = current.dependencies.filter(row => targetIds.includes(row.predecessorId) || targetIds.includes(row.successorId));
  assert.deepEqual(newLinks.map(({ predecessorId, successorId, type, lagDays }) => [predecessorId, successorId, type, lagDays]),
    [[targetIds[0], targetIds[1], 'SS', 2]]);
  assert.deepEqual(current.dependencies.filter(row => [inward.id, outward.id, internal.id].includes(row.id)),
    original.dependencies.filter(row => [inward.id, outward.id, internal.id].includes(row.id)));
  assert.deepEqual(current.issues.filter(row => !targetIds.includes(row.id)), original.issues);
  assert.deepEqual(await apply(cycle, overview.previewId, 200), { ...copied, duplicate: true });
  assert.deepEqual(await workspace(), current);
});

test('cycle copy guards actor, source, edge, calendar and required fields against an old review', async t => {
  const { plan, issue, link, preview, apply, request, workspace } = await fixture(t);
  const source = await plan('검토 원본');
  const other = await plan('다른 사이클');
  const parent = await issue('선행 업무', { cycleId: source.id });
  const child = await issue('하위 업무', { cycleId: source.id, parentId: parent.id });
  const outside = await issue('외부 업무', { cycleId: other.id });
  const edge = await link(parent, child);
  const proposed = () => preview(source, '검토한 복제', [parent, child], -3);
  const stale = async (view: CycleCopyPreview, cycle = source, actor = actorId) => {
    assert.ok(view.previewId);
    const result = await apply<{ details: { reason: string } }>(cycle, view.previewId, 409, actor);
    assert.equal(result.details.reason, 'stale_preview');
  };
  await preview(source, '잘못된 선택', [child, child], 0, 400);
  await preview(source, '범위 밖 선택', [outside], 0, 409);
  await preview(source, '범위 밖 이동', [child], 3651, 400);
  const initial = await proposed();
  await stale(initial, other);
  await stale(initial, source, 'user-min');
  await request(`/dependencies/${edge.id}`, 'PATCH', { expectedVersion: edge.version, type: 'FF', lagDays: 1 });
  await stale(initial);
  const beforeCalendar = await proposed();
  const calendarPath = `/projects/${projectId}/calendar`;
  const calendar = await request<WorkCalendar>(calendarPath);
  await request(calendarPath, 'PATCH', { expectedVersion: calendar.version, name: '변경한 팀 달력' });
  await stale(beforeCalendar);
  const beforeWorkflow = await proposed();
  const workflowPath = `/projects/${projectId}/workflow`;
  const workflow = await request<ProjectWorkflow>(workflowPath);
  const requiredCycle = await request<ProjectWorkflow>(workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    fieldRules: [{ issueType: '*', statusId: workflow.initialStatusId, requiredFields: ['cycle'] }] });
  await stale(beforeWorkflow);
  const valid = await proposed();
  assert.ok(valid.previewId, JSON.stringify(valid.errors));
  await request(workflowPath, 'PATCH', { ...requiredCycle, expectedVersion: requiredCycle.version,
    fieldRules: [{ issueType: '*', statusId: requiredCycle.initialStatusId, requiredFields: ['cycle', 'dueDate'] }] });
  await stale(valid);
  const invalid = await proposed();
  assert.equal(invalid.previewId, null);
  assert.deepEqual(invalid.errors.map(row => row.key), [parent.key, child.key]);
  assert.ok(invalid.errors.every(row => /마감/u.test(row.message)), JSON.stringify(invalid.errors));
  assert.ok(!(await workspace()).planningItems?.some(row => row.name === '검토한 복제'));
});

test('cycle copy rolls back late errors and invalidates receipts on an exchange backup import', async t => {
  const { database, plan, issue, link, preview, apply, workspace, request } = await fixture(t);
  const source = await plan('트랜잭션 원본');
  const first = await issue('원본 업무 하나', { cycleId: source.id });
  const second = await issue('원본 업무 둘', { cycleId: source.id, parentId: first.id });
  await link(first, second);
  const overview = await preview(source, '한 번만 복제', [first, second]);
  assert.ok(overview.previewId);
  const receipt = () => database.prepare('SELECT json, expires_at FROM cycle_copy_requests WHERE id=?').get(overview.previewId);
  const beforeReceipt = receipt();
  const before = await workspace();
  database.exec(`CREATE TRIGGER reject_cycle_copy_receipt BEFORE UPDATE ON cycle_copy_requests BEGIN
    SELECT RAISE(ABORT, 'synthetic cycle copy receipt failure');
  END`);
  try {
    await apply(source, overview.previewId, 500);
    assert.deepEqual(receipt(), beforeReceipt);
    assert.deepEqual(await workspace(), before);
  } finally {
    database.exec('DROP TRIGGER reject_cycle_copy_receipt');
  }
  const copied = await apply(source, overview.previewId);
  assert.deepEqual(await apply(source, overview.previewId, 200), { ...copied, duplicate: true });
  const data = await request('/export');
  await request('/import', 'POST', { data });
  const conflict = await apply<{ details: { reason: string } }>(source, overview.previewId, 409);
  assert.equal(conflict.details.reason, 'stale_preview');
  const imported = await workspace();
  assert.equal(imported.planningItems?.filter(row => row.id === copied.cycle.id).length, 1);
  assert.equal(imported.issues.filter(row => row.cycleId === copied.cycle.id).length, 2);
});
