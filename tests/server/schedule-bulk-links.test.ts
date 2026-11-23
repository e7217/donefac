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
  Dependency, Issue, Project, ScheduleBulkLinkInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot,
} from '../../shared/types.js';

const previewPath = '/schedule/bulk-links/preview';
const applyPath = '/schedule/bulk-links/apply';
const undoPath = '/schedule/undo';
const reference = ({ id, version }: Issue) => ({ id, expectedVersion: version });
const findLink = (state: WorkspaceSnapshot, predecessor: Issue, successor: Issue) => state.dependencies.find(link =>
  link.predecessorId === predecessor.id && link.successorId === successor.id);

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-bulk-links-'));
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
  const project = await call<Project>('/projects', 201, 'POST', { key: 'BULKL', name: '일괄 선후행 연결' });
  return {
    call, dir, project,
    issue: (title: string, projectId = project.id, dates: Partial<Pick<Issue, 'startDate' | 'endDate'>> = {}) =>
      call<Issue>('/issues', 201, 'POST', {
        title, projectId, startDate: '2026-11-19', endDate: '2026-11-20', dueDate: '2026-11-27', ...dates,
      }),
    link: (predecessor: Issue, successor: Issue, type: Dependency['type'] = 'FS', lagDays = 0) => call<Dependency>('/dependencies', 201, 'POST', {
      predecessorId: predecessor.id, successorId: successor.id, type, lagDays,
    }),
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
    review: (body: unknown) => call<SchedulePastePreview>(previewPath, 200, 'POST', body),
    apply: (previewId: string, status = 200, actorId?: string) => call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
  };
}

function input(anchor: Issue, issues: Issue[], direction: ScheduleBulkLinkInput['direction'] = 'predecessor'): ScheduleBulkLinkInput {
  return { projectId: anchor.projectId, anchor: reference(anchor), issues: issues.map(reference), direction, type: 'FS', lagDays: 2 };
}

test('bulk link keeps the existing rule and applies only new links once, with atomic rollback and one undo', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('공통 선행 업무');
  const first = await f.issue('새 연결 첫 업무');
  const kept = await f.issue('이전 설정을 유지하는 업무');
  const last = await f.issue('시작일 미정 업무', f.project.id, { startDate: null });
  const original = await f.link(anchor, kept, 'SS', -1);
  const before = await f.workspace();
  const review = await f.review(input(anchor, [first, kept, last]));
  assert.ok(review.previewId);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.changes, []);
  assert.equal(review.unchanged, 1);
  assert.deepEqual(review.dependencyChanges?.map(change =>
    [change.line, change.predecessorKey, change.successorKey, change.before, change.after]), [
    [1, anchor.key, first.key, null, { type: 'FS', lagDays: 2 }],
    [3, anchor.key, last.key, null, { type: 'FS', lagDays: 2 }],
  ]);
  assert.deepEqual(review.retainedDependencies?.map(change =>
    [change.line, change.predecessorKey, change.successorKey, change.before, change.after]), [
    [2, anchor.key, kept.key, { type: 'SS', lagDays: -1 }, { type: 'SS', lagDays: -1 }],
  ]);
  assert.ok(review.warnings.some(warning =>
    warning.includes(`${anchor.key} → ${first.key}`) && warning.includes('2026-11-25')));
  const missingDate = review.warnings.find(warning =>
    warning.includes(`${anchor.key} → ${last.key}`) && warning.includes('날짜 미정'));
  assert.ok(missingDate);
  assert.deepEqual(await f.workspace(), before);
  await f.apply(review.previewId, 409, 'user-seo');
  await f.call('/schedule/row-edit/apply', 404, 'POST', { previewId: review.previewId });
  await f.call('/schedule/paste-apply', 404, 'POST', { previewId: review.previewId });

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_second_bulk_link BEFORE INSERT ON dependencies
      WHEN json_extract(NEW.json,'$.type')='FS' AND EXISTS (
        SELECT 1 FROM dependencies WHERE predecessor_id=NEW.predecessor_id AND json_extract(json,'$.type')='FS'
      ) BEGIN SELECT RAISE(ABORT,'synthetic second bulk link failure'); END`);
    await f.apply(review.previewId, 500);
    assert.deepEqual(await f.workspace(), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    database.exec('DROP TRIGGER fail_second_bulk_link');

    const applied = await f.apply(review.previewId);
    assert.equal(applied.dependencyChanges, 2);
    assert.deepEqual(applied.updated, []);
    assert.ok(applied.warnings.includes(missingDate));
    assert.deepEqual(await f.apply(review.previewId), applied);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 1);
    const current = await f.workspace();
    assert.deepEqual(current.issues, before.issues);
    assert.deepEqual(findLink(current, anchor, kept), original);
    for (const issue of [first, last]) {
      const link = findLink(current, anchor, issue);
      assert.equal(link?.type, 'FS');
      assert.equal(link?.lagDays, 2);
    }

    const undone = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: applied.undoId });
    assert.equal(undone.dependencyChanges, 2);
    assert.deepEqual(undone.updated, []);
    const restored = await f.workspace();
    assert.deepEqual(restored.dependencies, before.dependencies);
    assert.deepEqual(restored.issues, before.issues);
    await f.call(undoPath, 409, 'POST', { undoId: applied.undoId });
  } finally { database.close(); }
});

test('bulk predecessor selection rejects invalid or stale references and retains an incoming pair unchanged', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('공통 후행 업무');
  const first = await f.issue('앞선 첫 업무');
  const second = await f.issue('앞선 둘째 업무');
  const foreign = await f.issue('다른 프로젝트 업무', 'project-neo');
  const original = await f.link(first, anchor, 'SF', -2);
  const body = input(anchor, [first, second], 'successor');
  const before = await f.workspace();
  for (const invalid of [
    { ...body, issues: [reference(first)] },
    { ...body, issues: [reference(first), reference(first)] },
    { ...body, issues: [reference(first), reference(anchor)] },
    { ...body, issues: Array.from({ length: 101 }, (_, index) => ({ id: `candidate-${index}`, expectedVersion: 1 })) },
    { ...body, direction: 'reverse' },
    { ...body, type: 'invalid' },
    { ...body, lagDays: 2.5 },
    { ...body, lagDays: 3651 },
  ]) await f.call(previewPath, 400, 'POST', invalid);
  await f.call(previewPath, 404, 'POST', { ...body, projectId: 'project-missing' });

  const foreignResult = await f.review({ ...body, issues: [reference(first), reference(foreign)] });
  assert.equal(foreignResult.previewId, null);
  assert.deepEqual(foreignResult.errors.map(error => error.issueId), [foreign.id]);
  assert.ok(!JSON.stringify(foreignResult).includes(foreign.title));
  const stale = await f.review({ ...body, anchor: { id: anchor.id, expectedVersion: anchor.version + 1 } });
  assert.equal(stale.previewId, null);
  assert.ok(stale.errors.some(error => error.issueId === anchor.id));
  const staleTarget = await f.review({ ...body, issues: [reference(first), { id: second.id, expectedVersion: second.version + 1 }] });
  assert.equal(staleTarget.previewId, null);
  assert.deepEqual(staleTarget.errors.map(error => [error.line, error.issueId]), [[2, second.id]]);
  assert.deepEqual(await f.workspace(), before);

  const preview = await f.review(body);
  assert.ok(preview.previewId);
  assert.deepEqual(preview.retainedDependencies?.map(change => [change.predecessorKey, change.successorKey]), [[first.key, anchor.key]]);
  assert.deepEqual(preview.dependencyChanges?.map(change => [change.predecessorKey, change.successorKey]), [[second.key, anchor.key]]);
  const applied = await f.apply(preview.previewId);
  assert.equal(applied.dependencyChanges, 1);
  assert.deepEqual(findLink(await f.workspace(), first, anchor), original);
  assert.ok(findLink(await f.workspace(), second, anchor));

  const allRetained = await f.review({ ...body, type: 'FF', lagDays: -10 });
  assert.equal(allRetained.previewId, null);
  assert.deepEqual(allRetained.errors, []);
  assert.deepEqual(allRetained.dependencyChanges, []);
  assert.equal(allRetained.unchanged, 2);
  assert.deepEqual(allRetained.retainedDependencies?.map(change => [change.before, change.after]), [
    [{ type: 'SF', lagDays: -2 }, { type: 'SF', lagDays: -2 }],
    [{ type: 'FS', lagDays: 2 }, { type: 'FS', lagDays: 2 }],
  ]);
});

test('bulk linking rechecks a retained rule and rejects a late or already existing dependency cycle', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 업무');
  const kept = await f.issue('기존 연결');
  const candidate = await f.issue('새 후행 업무');
  const firstMiddle = await f.issue('간접 경로 첫 업무');
  const secondMiddle = await f.issue('간접 경로 둘째 업무');
  const existing = await f.link(anchor, kept, 'SS');
  await f.link(candidate, firstMiddle);
  await f.link(secondMiddle, anchor);
  const initial = input(anchor, [candidate, kept]);
  const staleTarget = await f.review(initial);
  assert.ok(staleTarget.previewId);
  const current = await f.call<Issue>(`/issues/${candidate.id}`, 200, 'PATCH', {
    expectedVersion: candidate.version, title: '방금 편집한 새 후행 업무',
  }, 'user-seo');
  const beforeChanged = await f.workspace();
  await f.apply(staleTarget.previewId, 409);
  assert.deepEqual(await f.workspace(), beforeChanged);

  const body = input(anchor, [current, kept]);
  const firstPreview = await f.review(body);
  assert.ok(firstPreview.previewId);
  const edited = await f.call<Dependency>(`/dependencies/${existing.id}`, 200, 'PATCH', {
    expectedVersion: existing.version, type: 'FF',
  }, 'user-seo');
  const beforeStale = await f.workspace();
  await f.apply(firstPreview.previewId, 409);
  assert.deepEqual(await f.workspace(), beforeStale);

  const secondPreview = await f.review(body);
  assert.ok(secondPreview.previewId);
  await f.link(firstMiddle, secondMiddle);
  const beforeCycle = await f.workspace();
  const rejected = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId: secondPreview.previewId });
  assert.match(rejected.error, /순환/u);
  const invalid = await f.review(body);
  assert.equal(invalid.previewId, null);
  assert.ok(invalid.errors.some(error => error.message.includes('순환')));
  assert.deepEqual(await f.workspace(), beforeCycle);
  assert.deepEqual(findLink(beforeCycle, anchor, kept), edited);
  assert.equal(findLink(beforeCycle, anchor, candidate), undefined);
});
