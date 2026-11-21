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
import type { CycleBoardMoveInput, CycleBoardMoveResult, Issue, IssueOrderMoveResult, PlanningItem, Project,
  ProjectIssueOrder, WorkspaceSnapshot } from '../../shared/types.js';

const actor = 'user-min';
const otherActor = 'user-seo';
const cycleVersion = (plan: PlanningItem | null) => plan ? { id: plan.id, expectedVersion: plan.version } : null;
const byId = (snapshot: WorkspaceSnapshot, issue: Issue) => snapshot.issues.find(value => value.id === issue.id);
type RejectedMove = { details?: { reason: string; currentVersion?: string; currentIssueVersion?: number; currentCycleVersion?: number } };

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-cycle-board-move-'));
  async function start() {
    const app = createApp({ dataDir: dir, outboundWorker: false, deadlineReminderWorker: false });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let running = await start();
  async function stop() {
    const { app, server } = running;
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { app.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, method = 'GET', body?: unknown, actorId = actor) {
    const response = await fetch(running.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, actorId?: string) {
    const response = await request<T>(path, method, body, actorId);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'CYCLEBOARD', name: '사이클 보드 순위 검증' });
  const orderPath = `/projects/${project.id}/issue-order`;
  const movePath = `/projects/${project.id}/cycle-board/move`;
  return {
    call, request, dir, project, orderPath, movePath,
    async restart() { await stop(); running = await start(); },
    cycle(name: string, fields: Partial<Pick<PlanningItem, 'kind' | 'status' | 'projectId'>> = {}) {
      return call<PlanningItem>('/planning-items', 201, 'POST', { projectId: project.id, kind: 'cycle', status: 'active', name, ...fields });
    },
    issue(title: string, fields: Partial<Pick<Issue, 'cycleId' | 'status' | 'parentId' | 'moduleId' | 'projectId' | 'assigneeId'>> = {}) {
      return call<Issue>('/issues', 201, 'POST', {
        projectId: project.id, title, startDate: '2026-11-23', endDate: '2026-11-25', dueDate: '2026-11-30',
        plannedEffortMinutes: 180, ...fields,
      });
    },
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
    order: () => call<ProjectIssueOrder>(orderPath),
    move: (body: CycleBoardMoveInput) => call<CycleBoardMoveResult>(movePath, 200, 'POST', body),
    async reject(body: unknown, reason: string, actorId?: string) {
      const error = await call<RejectedMove>(movePath, 409, 'POST', body, actorId);
      assert.equal(error.details?.reason, reason, JSON.stringify(body));
      return error.details;
    },
  };
}

function moveInput(order: ProjectIssueOrder, issue: Issue, source: PlanningItem | null, target: PlanningItem | null,
  anchor: Issue | null, position: CycleBoardMoveInput['position']): CycleBoardMoveInput {
  return {
    requestId: randomUUID(), issueId: issue.id, expectedVersion: order.version, expectedIssueVersion: issue.version,
    sourceCycle: cycleVersion(source), targetCycle: cycleVersion(target), anchorId: anchor?.id ?? null, position,
  };
}

test('cycle board commits membership and project rank together, preserves other issue fields and replays live state after restart', async t => {
  const f = await fixture(t);
  const target = await f.cycle('예정된 목표 사이클', { status: 'planned' });
  const relatedModule = await f.cycle('별도 유지할 모듈', { kind: 'module' });
  const parent = await f.issue('부모 및 가려진 백로그 업무');
  const anchor = await f.issue('도착 위치 업무', { cycleId: target.id });
  const hidden = await f.issue('사이클의 가려진 업무', { cycleId: target.id });
  const source = await f.issue('사이클로 옮길 업무', { parentId: parent.id, moduleId: relatedModule.id, status: 'in_progress', assigneeId: actor });
  const before = await f.workspace();
  const order = await f.order();
  const command = moveInput(order, source, null, target, anchor, 'before');
  const result = await f.move(command);
  assert.equal(result.duplicate, false);
  assert.notEqual(result.order.version, order.version);
  assert.deepEqual(result.order.issueIds, [parent.id, source.id, anchor.id, hidden.id]);
  assert.deepEqual(result.issue, { ...source, cycleId: target.id, cycle: target.name, version: source.version + 1, updatedAt: result.issue.updatedAt });
  const after = await f.workspace();
  assert.deepEqual(byId(after, source), result.issue);
  assert.deepEqual(after.issues.filter(issue => issue.id !== source.id), before.issues.filter(issue => issue.id !== source.id));
  assert.deepEqual(after.planningItems, before.planningItems);
  assert.deepEqual(after.dependencies, before.dependencies);
  const activityIds = new Set(before.activities.map(activity => activity.id));
  const changes = after.activities.filter(activity => !activityIds.has(activity.id));
  assert.deepEqual(changes.map(({ resourceId, action }) => [resourceId, action]), [[source.id, '사이클 보드 이동']]);
  assert.deepEqual(await f.move(command), { ...result, duplicate: true });
  await f.reject({ ...command, position: 'after' }, 'request_reused');
  await f.reject(command, 'request_reused', otherActor);
  assert.deepEqual(await f.workspace(), after);

  const renamed = await f.call<Issue>(`/issues/${source.id}`, 200, 'PATCH', { expectedVersion: result.issue.version, title: '나중에 변경한 업무' });
  const reordered = await f.call<IssueOrderMoveResult>(f.orderPath, 200, 'PATCH', {
    issueId: hidden.id, expectedIssueVersion: hidden.version, expectedVersion: result.order.version, anchorId: parent.id, position: 'before',
  });
  assert.deepEqual(reordered.order.issueIds, [hidden.id, parent.id, source.id, anchor.id]);
  assert.deepEqual(reordered.issue, hidden);
  const later = await f.workspace();
  await f.restart();
  assert.deepEqual(await f.move(command), { order: reordered.order, issue: renamed, duplicate: true });
  assert.deepEqual(await f.workspace(), later);

  await f.call(`/issues/${source.id}?expectedVersion=${renamed.version}`, 200, 'DELETE');
  await f.reject(command, 'receipt_unavailable');
});

test('null anchors use the target lane extremes, an empty lane keeps the source rank, and no-op changes are receipt-only', async t => {
  const f = await fixture(t);
  const sourceCycle = await f.cycle('기존 사이클');
  const target = await f.cycle('도착 사이클');
  const empty = await f.cycle('업무가 없는 사이클');
  const prefix = await f.issue('백로그 시작');
  const first = await f.issue('필터 밖 첫 대상 일감', { cycleId: target.id, status: 'done' });
  const between = await f.issue('중간에 있는 백로그');
  const last = await f.issue('마지막 대상 일감', { cycleId: target.id });
  const source = await f.issue('이동할 출발 사이클 일감', { cycleId: sourceCycle.id });
  const tail = await f.issue('백로그 끝');

  const top = await f.move(moveInput(await f.order(), source, sourceCycle, target, null, 'before'));
  assert.deepEqual(top.order.issueIds, [prefix.id, source.id, first.id, between.id, last.id, tail.id]);
  const beforeNoop = await f.workspace();
  const noop = moveInput(top.order, top.issue, target, target, null, 'before');
  assert.deepEqual(await f.move(noop), { order: top.order, issue: top.issue, duplicate: false });
  assert.deepEqual(await f.move(noop), { order: top.order, issue: top.issue, duplicate: true });
  assert.deepEqual(await f.workspace(), beforeNoop);

  const bottom = await f.move(moveInput(top.order, top.issue, target, target, null, 'after'));
  assert.deepEqual(bottom.order.issueIds, [prefix.id, first.id, between.id, last.id, source.id, tail.id]);
  assert.deepEqual(bottom.issue, top.issue);
  const emptied = await f.move(moveInput(bottom.order, bottom.issue, target, empty, null, 'before'));
  assert.deepEqual(emptied.order.issueIds, bottom.order.issueIds);
  assert.notEqual(emptied.order.version, bottom.order.version);
  assert.equal(emptied.issue.cycleId, empty.id);
  assert.equal(emptied.issue.version, bottom.issue.version + 1);

  const toBacklog = await f.move(moveInput(emptied.order, emptied.issue, empty, null, tail, 'after'));
  assert.deepEqual(toBacklog.order.issueIds, [prefix.id, first.id, between.id, last.id, tail.id, source.id]);
  assert.equal(toBacklog.issue.cycleId, null);
  assert.equal(toBacklog.issue.cycle, null);
});

test('cycle board rejects stale order, moved anchors, cycle versions, wrong scope and simultaneous competing commands', async t => {
  const f = await fixture(t);
  const sourceCycle = await f.cycle('출발 사이클');
  const target = await f.cycle('다음 사이클', { status: 'planned' });
  const closed = await f.cycle('완료된 사이클', { status: 'completed' });
  const foreign = await f.cycle('다른 프로젝트의 사이클', { projectId: 'project-neo' });
  const otherPlanKind = await f.cycle('사이클이 아닌 모듈', { kind: 'module' });
  const source = await f.issue('동시에 옮길 업무', { cycleId: sourceCycle.id });
  const anchor = await f.issue('다음 사이클의 이웃', { cycleId: target.id });
  const outside = await f.issue('다른 프로젝트의 업무', { projectId: foreign.projectId, cycleId: foreign.id });
  const initial = await f.order();
  const command = moveInput(initial, source, sourceCycle, target, anchor, 'after');
  const before = await f.workspace();
  for (const plan of [closed, foreign, otherPlanKind]) await f.reject({ ...command, targetCycle: cycleVersion(plan) }, 'target_cycle_changed');
  await f.reject({ ...command, sourceCycle: null }, 'source_cycle_changed');
  await f.reject({ ...command, issueId: outside.id, expectedIssueVersion: outside.version }, 'issue_missing');
  await f.reject({ ...command, anchorId: outside.id }, 'anchor_changed');
  await f.call(f.movePath, 400, 'POST', { ...command, requestId: 'not-a-uuid' });
  await f.call(f.movePath, 400, 'POST', { ...command, targetCycle: { id: target.id, expectedVersion: 0 } });
  await f.call(f.movePath, 400, 'POST', { ...command, anchorId: source.id });
  assert.deepEqual(await f.workspace(), before);

  const patchIssue = (issue: Issue, fields: Partial<Issue>) => f.call<Issue>(`/issues/${issue.id}`, 200, 'PATCH', { expectedVersion: issue.version, ...fields });
  const removed = await patchIssue(anchor, { cycleId: null });
  const afterRemoval = await f.order();
  assert.deepEqual(afterRemoval.issueIds, initial.issueIds);
  assert.notEqual(afterRemoval.version, initial.version);
  assert.equal((await f.reject(command, 'order_changed'))?.currentVersion, afterRemoval.version);
  await f.reject({ ...command, expectedVersion: afterRemoval.version }, 'anchor_changed');
  await patchIssue(removed, { cycleId: target.id });
  const afterRestoration = await f.order();
  assert.notEqual(afterRestoration.version, initial.version);
  await f.reject(command, 'order_changed');

  const patchCycle = (cycle: PlanningItem, fields: Partial<PlanningItem>) => f.call<PlanningItem>(
    `/planning-items/${cycle.id}`, 200, 'PATCH', { expectedVersion: cycle.version, ...fields },
  );
  const sourceUpdated = await patchCycle(sourceCycle, { description: '검토 중에 수정한 출발 계획' });
  assert.equal((await f.reject({ ...command, expectedVersion: afterRestoration.version }, 'source_cycle_changed'))?.currentCycleVersion, sourceUpdated.version);
  const targetUpdated = await patchCycle(target, { status: 'archived' });
  const guarded = { ...command, sourceCycle: cycleVersion(sourceUpdated), expectedVersion: afterRestoration.version };
  await f.reject(guarded, 'target_cycle_changed');
  await f.reject({ ...guarded, targetCycle: cycleVersion(targetUpdated) }, 'target_cycle_changed');
  const reopened = await patchCycle(targetUpdated, { status: 'active' });
  const sourceEdited = await patchIssue(source, { title: '검토 중에 바뀐 업무 제목' });
  const current = { ...guarded, targetCycle: cycleVersion(reopened) };
  assert.equal((await f.reject(current, 'issue_changed'))?.currentIssueVersion, sourceEdited.version);

  const ready = await f.order();
  const attempts = [moveInput(ready, sourceEdited, sourceUpdated, reopened, anchor, 'after'),
    moveInput(ready, sourceEdited, sourceUpdated, reopened, anchor, 'before')];
  const racing = await Promise.all(attempts.map(input => f.request<CycleBoardMoveResult | RejectedMove>(f.movePath, 'POST', input)));
  assert.deepEqual(racing.map(response => response.status).sort(), [200, 409]);
  const winner = racing.findIndex(response => response.status === 200);
  const applied = racing[winner].data as CycleBoardMoveResult;
  assert.equal(applied.issue.version, sourceEdited.version + 1);
  assert.equal(applied.issue.cycleId, reopened.id);
  assert.match((racing[1 - winner].data as RejectedMove).details?.reason ?? '', /^(?:order_changed|issue_changed)$/u);
  assert.deepEqual(await f.move(attempts[winner]), { ...applied, duplicate: true });
});

test('cycle board rolls back membership, rank and side effects if the receipt cannot be stored', async t => {
  const f = await fixture(t);
  const target = await f.cycle('트랜잭션 실패 검사');
  const anchor = await f.issue('사이클에 있는 기준 업무', { cycleId: target.id });
  const moving = await f.issue('동시에 순위를 바꿀 업무');
  const command = moveInput(await f.order(), moving, null, target, anchor, 'before');
  const before = await f.workspace();
  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_cycle_board_receipt BEFORE INSERT ON cycle_board_move_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic cycle board receipt failure'); END`);
    try {
      await f.call(f.movePath, 500, 'POST', command);
      assert.deepEqual(await f.workspace(), before);
      assert.equal(database.prepare('SELECT count(*) AS count FROM cycle_board_move_requests').get()?.count, 0);
    } finally { database.exec('DROP TRIGGER fail_cycle_board_receipt'); }
    const applied = await f.move(command);
    assert.equal(applied.duplicate, false);
    assert.equal(applied.issue.cycleId, target.id);
    assert.deepEqual(applied.order.issueIds, [moving.id, anchor.id]);
    assert.deepEqual(await f.move(command), { ...applied, duplicate: true });
    assert.equal(database.prepare('SELECT count(*) AS count FROM cycle_board_move_requests').get()?.count, 1);
  } finally { database.close(); }
});

test('native restore preserves cycle membership and global rank but invalidates old commands and removes their receipts', async t => {
  const f = await fixture(t);
  const target = await f.cycle('복원할 사이클');
  const anchor = await f.issue('같은 사이클의 이웃', { cycleId: target.id });
  const source = await f.issue('복원할 이동 업무');
  const command = moveInput(await f.order(), source, null, target, anchor, 'before');
  const saved = await f.move(command);
  const backup = await f.call('/export');
  await f.call('/import', 200, 'POST', { data: backup });
  const order = await f.order();
  const workspace = await f.workspace();
  const restoredIssue = byId(workspace, source);
  const restoredCycle = workspace.planningItems?.find(plan => plan.id === target.id);
  assert.ok(restoredIssue && restoredCycle);
  assert.deepEqual(order.issueIds, saved.order.issueIds);
  assert.notEqual(order.version, saved.order.version);
  assert.equal(restoredIssue.cycleId, restoredCycle.id);
  assert.equal(restoredIssue.cycle, target.name);
  assert.ok(restoredIssue.version > saved.issue.version && restoredCycle.version > target.version);
  await f.reject(command, 'order_changed');
  const newNoop = { ...moveInput(order, restoredIssue, restoredCycle, restoredCycle, anchor, 'before'), requestId: command.requestId };
  assert.deepEqual(await f.move(newNoop), { issue: restoredIssue, order, duplicate: false });
  assert.deepEqual(await f.workspace(), workspace);
});
