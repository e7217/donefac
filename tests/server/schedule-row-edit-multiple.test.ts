import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { MAX_SCHEDULE_ROW_DEPENDENCY_EDITS, type Dependency, type Issue, type Project, type SchedulePasteApplyResult,
  type SchedulePastePreview, type ScheduleRowDependencyEdit, type WorkspaceSnapshot } from '../../shared/types.js';

const reviewPath = '/schedule/row-edit/preview';
const applyPath = '/schedule/row-edit/apply';
const versionOf = ({ id, version }: Issue) => ({ id, expectedVersion: version });
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const pair = (state: WorkspaceSnapshot, predecessor: Issue, successor: Issue) => state.dependencies.find(link =>
  link.predecessorId === predecessor.id && link.successorId === successor.id);

const add = (related: Issue, direction: 'predecessor' | 'successor', type: Dependency['type'], lagDays = 0): ScheduleRowDependencyEdit =>
  ({ action: 'add', relatedIssue: versionOf(related), direction, type, lagDays });
const remove = (link: Dependency, related: Issue): Extract<ScheduleRowDependencyEdit, { action: 'remove' }> =>
  ({ action: 'remove', id: link.id, expectedVersion: link.version ?? 1, relatedIssue: versionOf(related) });
const update = (link: Dependency, related: Issue, type: Dependency['type'], lagDays: number): ScheduleRowDependencyEdit =>
  ({ ...remove(link, related), action: 'update', type, lagDays });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-row-multiple-'));
  const service = createApp({ dataDir: dir, outboundWorker: false, deadlineReminderWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, actorId = 'user-yun') {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'LINKROW', name: '다중 연결 편집' });
  return {
    call, dir, project,
    issue: (title: string, projectId = project.id) => call<Issue>('/issues', 201, 'POST', {
      title, projectId, startDate: '2026-11-23', endDate: '2026-11-24', dueDate: '2026-11-27',
    }),
    link: (predecessor: Issue, successor: Issue) => call<Dependency>('/dependencies', 201, 'POST', {
      predecessorId: predecessor.id, successorId: successor.id,
    }),
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
    review: (body: unknown, status = 200) => call<SchedulePastePreview>(reviewPath, status, 'POST', body),
    apply: (previewId: string, status = 200, actorId?: string) => call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
  };
}

test('multi-link row edit projects reversal, update and insertion together, rolls back a late write and undoes the entire apply', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 업무');
  const reverse = await f.issue('방향 교체');
  const updated = await f.issue('규칙 변경');
  const added = await f.issue('새 후행 업무');
  const oldDirection = await f.link(anchor, reverse);
  const oldRule = await f.link(updated, anchor);
  const before = await f.workspace();
  const preview = await f.review({
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-25', dueDate: null },
    dependencies: [add(reverse, 'predecessor', 'SS'), update(oldRule, updated, 'FF', 2), remove(oldDirection, reverse), add(added, 'successor', 'SF', 1)],
  });
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.previewId);
  assert.deepEqual(preview.dependencyChanges?.map(change => [change.line, change.predecessorKey, change.successorKey, change.before?.type, change.after?.type]), [
    [1, reverse.key, anchor.key, undefined, 'SS'], [2, updated.key, anchor.key, 'FS', 'FF'],
    [3, anchor.key, reverse.key, 'FS', undefined], [4, anchor.key, added.key, undefined, 'SF'],
  ]);
  assert.ok(preview.warnings.some(warning => warning.includes(`${updated.key} → ${anchor.key}`) && warning.includes('2026-11-26')));
  assert.deepEqual(await f.workspace(), before);
  await f.apply(preview.previewId, 409, 'user-seo');

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_last_row_link BEFORE INSERT ON dependencies WHEN json_extract(NEW.json,'$.type')='SF'
      BEGIN SELECT RAISE(ABORT,'synthetic late multi-link insert failure'); END`);
    await f.apply(preview.previewId, 500);
    assert.deepEqual(await f.workspace(), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    database.exec('DROP TRIGGER fail_last_row_link');
  } finally { database.close(); }

  const applied = await f.apply(preview.previewId);
  assert.equal(applied.dependencyChanges, 4);
  assert.equal(applied.updated.length, 1);
  assert.equal(applied.updated[0].version, anchor.version + 1);
  assert.deepEqual(dates(applied.updated[0]), { startDate: anchor.startDate, endDate: '2026-11-25', dueDate: null });
  assert.deepEqual(await f.apply(preview.previewId), applied);
  const current = await f.workspace();
  assert.equal(pair(current, updated, anchor)?.id, oldRule.id);
  assert.equal(pair(current, updated, anchor)?.lagDays, 2);
  assert.equal(pair(current, anchor, reverse), undefined);
  assert.equal(pair(current, reverse, anchor)?.type, 'SS');
  assert.equal(pair(current, anchor, added)?.type, 'SF');

  const undone = await f.call<SchedulePasteApplyResult>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.equal(undone.dependencyChanges, 4);
  assert.deepEqual(dates(undone.updated[0]), dates(anchor));
  const restored = await f.workspace();
  assert.equal(pair(restored, anchor, reverse)?.id, oldDirection.id);
  assert.equal(pair(restored, updated, anchor)?.id, oldRule.id);
  assert.equal(pair(restored, updated, anchor)?.type, oldRule.type);
  assert.equal(pair(restored, reverse, anchor), undefined);
  assert.equal(pair(restored, anchor, added), undefined);
});

test('multi-link row diagnostics preserve input positions and reject duplicate targets, foreign rows and combined cycles', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준');
  const existing = await f.issue('기존 연결');
  const candidate = await f.issue('새 연결');
  const foreign = await f.issue('다른 프로젝트', 'project-neo');
  const link = await f.link(existing, anchor);
  const base = { projectId: f.project.id, issue: versionOf(anchor), changes: { dueDate: null } };
  const one = add(candidate, 'predecessor', 'SS');
  const before = await f.workspace();
  for (const invalid of [
    { dependencies: null }, { dependencies: {} }, { dependency: one, dependencies: [] },
    { dependencies: Array.from({ length: MAX_SCHEDULE_ROW_DEPENDENCY_EDITS + 1 }, () => one) },
    { dependencies: [{ ...one, lagDays: 3651 }] },
  ]) await f.review({ ...base, ...invalid }, 400);
  const datesOnly = await f.review({ ...base, dependencies: [] });
  assert.ok(datesOnly.previewId);
  assert.deepEqual(datesOnly.dependencyChanges, []);
  for (const dependencies of [
    [one, add(candidate, 'predecessor', 'FF')],
    [update(link, existing, link.type, link.lagDays), remove(link, existing)],
    [one, add(foreign, 'successor', 'FS')],
  ]) {
    const response = await f.review({ ...base, dependencies });
    assert.equal(response.previewId, null);
    assert.deepEqual(response.errors.map(error => error.line), [2]);
  }
  const cycle = await f.review({ ...base, dependencies: [one, add(candidate, 'successor', 'FF')] });
  assert.equal(cycle.previewId, null);
  assert.ok(cycle.errors.some(error => error.line === null && error.message.includes('순환')));
  assert.deepEqual(await f.workspace(), before);
});

test('multi-link apply rechecks every reviewed endpoint and a late cycle outside the incident-link guard', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준');
  const target = await f.issue('후행');
  const firstMiddle = await f.issue('먼 연결 시작');
  const secondMiddle = await f.issue('먼 연결 끝');
  const another = await f.issue('별도 선행');
  await f.link(target, firstMiddle);
  await f.link(secondMiddle, anchor);
  const body = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { dueDate: null },
    dependencies: [add(target, 'successor', 'FF'), add(another, 'predecessor', 'SS')],
  };
  const stale = await f.review(body);
  assert.ok(stale.previewId);
  const current = await f.call<Issue>(`/issues/${another.id}`, 200, 'PATCH', { expectedVersion: another.version, title: '새로 변경한 이름' }, 'user-seo');
  const beforeStaleApply = await f.workspace();
  await f.apply(stale.previewId, 409);
  assert.deepEqual(await f.workspace(), beforeStaleApply);

  const fresh = await f.review({ ...body, dependencies: [body.dependencies[0], add(current, 'predecessor', 'SS')] });
  assert.ok(fresh.previewId);
  await f.link(firstMiddle, secondMiddle);
  const beforeLateApply = await f.workspace();
  const rejection = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId: fresh.previewId });
  assert.match(rejection.error, /순환/u);
  assert.deepEqual(await f.workspace(), beforeLateApply);
});
