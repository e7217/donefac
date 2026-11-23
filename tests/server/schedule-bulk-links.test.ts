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
  Dependency, Issue, IssueRelation, Project, ScheduleBulkLinkInput, SchedulePasteApplyResult, SchedulePastePreview,
  TeamScheduleBlocker, WorkspaceSnapshot,
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

const blockerPath = '/schedule/blocker-links';
type BlockerPage = { items: TeamScheduleBlocker[]; offset: number; total: number };

function blockerRoutes(f: Awaited<ReturnType<typeof fixture>>) {
  const relationsPath = (issue: Issue) => `/issues/${issue.id}/relations`;
  return {
    add: (source: Issue, target: Issue, type: IssueRelation['type'] = 'blocks') =>
      f.call<IssueRelation>(relationsPath(source), 201, 'POST', { otherIssueId: target.id, type, direction: 'outgoing' }),
    list: (offset = 0) => f.call<BlockerPage>(`${blockerPath}?projectId=${f.project.id}&offset=${offset}`),
    relations: (issue: Issue) => f.call<IssueRelation[]>(relationsPath(issue)),
    review: (relations: readonly Pick<IssueRelation, 'id' | 'version'>[]) =>
      f.call<SchedulePastePreview>(`${blockerPath}/preview`, 200, 'POST', {
        projectId: f.project.id, relations: relations.map(({ id, version }) => ({ id, version })),
      }),
    apply: (previewId: string, status = 200, actorId?: string) =>
      f.call<SchedulePasteApplyResult>(`${blockerPath}/apply`, status, 'POST', { previewId }, actorId),
  };
}

test('project blocker batch keeps original relations and existing rules while warning about dates and supporting retry and undo', async t => {
  const f = await fixture(t);
  const blockers = blockerRoutes(f);
  const source = await f.issue('차단하는 업무');
  const conflict = await f.issue('차단 후행 일정이 너무 이른 업무');
  const retained = await f.issue('선후행 연결을 이미 검토한 업무');
  const missing = await f.issue('후행 시작일 미정', f.project.id, { startDate: null });
  const [first, kept, last] = [
    await blockers.add(source, conflict), await blockers.add(source, retained), await blockers.add(source, missing),
  ];
  const saved = await f.link(source, retained, 'SS', -2);
  const before = await f.workspace();
  const originalRelations = await blockers.relations(source);
  assert.deepEqual(await blockers.list(), { offset: 0, total: 3, items: [
    { id: first.id, sourceIssueId: source.id, targetIssueId: conflict.id, version: first.version },
    { id: kept.id, sourceIssueId: source.id, targetIssueId: retained.id, version: kept.version },
    { id: last.id, sourceIssueId: source.id, targetIssueId: missing.id, version: last.version },
  ] });

  const sameRule = { type: 'SS', lagDays: -2 };
  const newRule = { type: 'FS', lagDays: 0 };
  const preview = await blockers.review([first, kept, last]);
  assert.ok(preview.previewId);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.changes, []);
  assert.equal(preview.unchanged, 1);
  assert.deepEqual(preview.dependencyChanges?.map(change =>
    [change.line, change.predecessorKey, change.successorKey, change.before, change.after]), [
    [1, source.key, conflict.key, null, newRule],
    [3, source.key, missing.key, null, newRule],
  ]);
  assert.deepEqual(preview.retainedDependencies?.map(change =>
    [change.line, change.predecessorKey, change.successorKey, change.before, change.after]), [
    [2, source.key, retained.key, sameRule, sameRule],
  ]);
  assert.ok(preview.warnings.some(warning => warning.includes(`${source.key} → ${conflict.key}`) && warning.includes('2026-11-23')));
  assert.ok(preview.warnings.some(warning => warning.includes(`${source.key} → ${missing.key}`) && warning.includes('날짜 미정')));
  assert.deepEqual(await f.workspace(), before);
  await blockers.apply(preview.previewId, 409, 'user-seo');
  await f.call(applyPath, 404, 'POST', { previewId: preview.previewId });

  const applied = await blockers.apply(preview.previewId);
  assert.equal(applied.dependencyChanges, 2);
  assert.deepEqual(applied.updated, []);
  assert.deepEqual(await blockers.apply(preview.previewId), applied);
  const current = await f.workspace();
  assert.deepEqual(current.issues, before.issues);
  assert.deepEqual(findLink(current, source, retained), saved);
  for (const target of [conflict, missing]) {
    const added = findLink(current, source, target);
    assert.ok(added);
    assert.deepEqual({ type: added.type, lagDays: added.lagDays }, newRule);
  }
  assert.deepEqual(await blockers.relations(source), originalRelations);

  const undone = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: applied.undoId });
  assert.equal(undone.dependencyChanges, 2);
  assert.deepEqual(undone.updated, []);
  const restored = await f.workspace();
  assert.deepEqual(restored.dependencies, before.dependencies);
  assert.deepEqual(restored.issues, before.issues);
  assert.deepEqual(await blockers.relations(source), originalRelations);
});

test('project blocker list pages exact local blocking pairs and rejects out-of-scope or malformed selections', async t => {
  const f = await fixture(t);
  const blockers = blockerRoutes(f);
  const source = await f.issue('차단 관계 검색 업무');
  const candidates: IssueRelation[] = [];
  for (let index = 0; index < 27; index++) {
    const issue = await f.issue(`범위 내 후행 ${index + 1}`);
    candidates.push(await blockers.add(source, issue));
  }
  const outsider = await f.issue('다른 프로젝트 후행', 'project-neo');
  const unrelated = await f.issue('같은 프로젝트 관련 업무');
  const [cross, related] = [await blockers.add(source, outsider), await blockers.add(source, unrelated, 'related')];
  for (const offset of [0, 25, 50]) {
    const page = await blockers.list(offset);
    assert.equal(page.total, 27);
    assert.equal(page.offset, offset);
    assert.deepEqual(page.items.map(row => row.id), candidates.slice(offset, offset + 25).map(row => row.id));
  }
  await f.call(`${blockerPath}?projectId=${f.project.id}&offset=-1`, 400);
  await f.call(`${blockerPath}?projectId=unavailable&offset=0`, 404);
  for (const relations of [
    [], [candidates[0], candidates[0]].map(({ id, version }) => ({ id, version })),
    [{ id: candidates[0].id, version: 0 }],
  ]) await f.call(`${blockerPath}/preview`, 400, 'POST', { projectId: f.project.id, relations });
  const before = await f.workspace();
  for (const invalid of [cross, related, { ...candidates[0], version: candidates[0].version + 1 }]) {
    const rejected = await blockers.review([candidates[1], invalid]);
    assert.equal(rejected.previewId, null);
    assert.ok(rejected.errors.some(error => error.line === 2));
    assert.doesNotMatch(JSON.stringify(rejected), /다른 프로젝트 후행/u);
  }
  assert.deepEqual(await f.workspace(), before);
});

test('project blocker batch rejects cycle and refuses application after relation, issue or graph changes', async t => {
  const f = await fixture(t);
  const blockers = blockerRoutes(f);
  const [a, b, c, d, e] = await Promise.all(['A', 'B', 'C', 'D', 'E'].map(title => f.issue(title)));
  const ab = await blockers.add(a, b);
  const bc = await blockers.add(b, c);
  const ca = await blockers.add(c, a);
  const de = await blockers.add(d, e);
  const baseline = await f.workspace();
  const impossible = await blockers.review([ab, bc, ca, de]);
  assert.equal(impossible.previewId, null);
  assert.ok(impossible.errors.some(error => /순환/u.test(error.message)));
  assert.deepEqual(await f.workspace(), baseline);

  async function rejectAfter(relations: IssueRelation[], update: () => Promise<unknown>) {
    const preview = await blockers.review(relations);
    assert.ok(preview.previewId);
    await update();
    const latest = await f.workspace();
    await blockers.apply(preview.previewId, 409);
    assert.deepEqual(await f.workspace(), latest);
    assert.equal(findLink(latest, d, e), undefined);
  }
  await rejectAfter([ab, de], () => f.call(`/issues/${a.id}/relations/${ab.id}`, 200, 'PATCH', {
    expectedVersion: ab.version, type: 'related', direction: 'outgoing',
  }, 'user-seo'));
  await rejectAfter([bc, de], () => f.call(`/issues/${b.id}/relations/${bc.id}?expectedVersion=${bc.version}`, 200, 'DELETE',
    undefined, 'user-seo'));
  await rejectAfter([ca, de], () => f.call(`/issues/${c.id}`, 200, 'PATCH', {
    expectedVersion: c.version, endDate: '2026-11-23',
  }, 'user-seo'));
  await rejectAfter([ca, de], () => f.link(a, c, 'SS', -1));
  const final = await f.workspace();
  assert.equal(findLink(final, c, a), undefined);
  assert.equal(findLink(final, d, e), undefined);
});
