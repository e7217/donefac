import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { MAX_SCHEDULE_BULK_LINK_ISSUES, MAX_SCHEDULE_ROW_DEPENDENCY_EDITS, type Dependency, type Issue, type Project, type SchedulePasteApplyResult,
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
  const dir = mkdtempSync(join(tmpdir(), 'donefac-row-multiple-'));
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
    issue: (title: string, projectId = project.id, schedule: Partial<ReturnType<typeof dates>> = {}) => call<Issue>('/issues', 201, 'POST', {
      title, projectId, startDate: '2026-11-23', endDate: '2026-11-24', dueDate: '2026-11-27', ...schedule,
    }),
    link: (predecessor: Issue, successor: Issue) => call<Dependency>('/dependencies', 201, 'POST', {
      predecessorId: predecessor.id, successorId: successor.id,
    }),
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
    review: (body: unknown, status = 200) => call<SchedulePastePreview>(reviewPath, status, 'POST', body),
    apply: (previewId: string, status = 200, actorId?: string) => call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
  };
}

test('row edit saves multiple linked date drafts with their final links and checks every selected version', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 일정', f.project.id, { startDate: '2026-11-27', endDate: '2026-11-30' });
  const existing = await f.issue('연결된 선행 일정');
  const candidate = await f.issue('새 선행 일정');
  const foreign = await f.issue('다른 프로젝트의 일정', 'project-neo');
  const existingLink = await f.link(existing, anchor);
  const end = (issue: Issue, endDate: string) => ({ issue: versionOf(issue), changes: { endDate } });
  const existingEdit = end(existing, '2026-11-25');
  const candidateEdit = end(candidate, '2026-11-26');
  const input = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { startDate: '2026-11-30' },
    relatedDateEdits: [existingEdit, candidateEdit], dependencies: [add(candidate, 'predecessor', 'FS')], rescheduleSuccessors: true,
  };
  const before = await f.workspace();
  await f.review({ ...input, relatedDates: existingEdit }, 400);
  await f.review({ ...input, relatedDateEdits: Array.from({ length: MAX_SCHEDULE_BULK_LINK_ISSUES }, () => existingEdit) }, 400);
  for (const [relatedDateEdits, rejectedIssue] of [
    [[existingEdit, existingEdit], existing],
    [[existingEdit, end(anchor, '2026-12-01')], anchor],
    [[existingEdit, end(foreign, '2026-11-26')], foreign],
  ] as const) {
    const rejected = await f.review({ ...input, relatedDateEdits });
    assert.equal(rejected.previewId, null);
    assert.ok(rejected.errors.some(error => error.issueId === rejectedIssue.id));
  }
  const disconnected = await f.review({ ...input, dependencies: [...input.dependencies, remove(existingLink, existing)] });
  assert.equal(disconnected.previewId, null);
  assert.ok(disconnected.errors.some(error => error.issueId === existing.id && error.message.includes('선후행 연결')));
  const fixed = await f.review({ ...input, changes: { endDate: '2026-12-02' }, includeTeamBlockers: true,
    relatedDateEdits: [existingEdit, { issue: versionOf(candidate), changes: { startDate: candidate.startDate } }],
    dependencies: [add(candidate, 'successor', 'FS')] });
  assert.equal(fixed.previewId, null);
  assert.ok(fixed.errors.some(error => error.message.includes(candidate.key) && error.message.includes('입력한 시작일')));
  assert.deepEqual(await f.workspace(), before);

  const oldReview = await f.review(input);
  assert.deepEqual(oldReview.errors, []);
  assert.ok(oldReview.previewId);
  const changed = await f.call<Issue>(`/issues/${existing.id}`, 200, 'PATCH', {
    expectedVersion: existing.version, title: '동료가 바꾼 선행 업무 이름',
  }, 'user-seo');
  const afterPeerEdit = await f.workspace();
  await f.apply(oldReview.previewId, 409);
  assert.deepEqual(await f.workspace(), afterPeerEdit);

  const review = await f.review({ ...input, relatedDateEdits: [end(changed, '2026-11-25'), candidateEdit] });
  assert.deepEqual(review.errors, []);
  assert.ok(review.previewId);
  assert.deepEqual(review.changes.map(change => change.id), [anchor.id, existing.id, candidate.id]);
  const applied = await f.apply(review.previewId);
  assert.equal(applied.dependencyChanges, 1);
  assert.deepEqual(await f.apply(review.previewId), applied);
  const saved = await f.workspace();
  assert.equal(saved.issues.find(issue => issue.id === anchor.id)?.startDate, '2026-11-30');
  assert.equal(saved.issues.find(issue => issue.id === existing.id)?.endDate, '2026-11-25');
  assert.equal(saved.issues.find(issue => issue.id === candidate.id)?.endDate, '2026-11-26');
  assert.ok(pair(saved, candidate, anchor));

  const undone = await f.call<SchedulePasteApplyResult>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.equal(undone.dependencyChanges, 1);
  assert.deepEqual(undone.updated.map(dates), [anchor, existing, candidate].map(dates));
  const restored = await f.workspace();
  assert.equal(restored.issues.find(issue => issue.id === existing.id)?.title, changed.title);
  assert.equal(pair(restored, candidate, anchor), undefined);
  assert.equal(pair(restored, existing, anchor)?.id, existingLink.id);
});

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

  const database = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
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

test('row rescheduling uses added, removed and edited links for one atomic transitive apply and undo', async t => {
  const f = await fixture(t);
  const issue = (title: string, startDate: string, endDate: string, dueDate: string | null = null) =>
    f.issue(title, f.project.id, { startDate, endDate, dueDate });
  const anchor = await f.issue('기준 업무');
  const direct = await issue('연결 규칙을 바꿀 후행', '2026-11-25', '2026-11-26', '2026-11-27');
  const downstream = await issue('간접 후행', '2026-11-27', '2026-11-27');
  const detached = await issue('연결을 해제할 업무', '2026-11-25', '2026-11-25');
  const newSuccessor = await issue('새로 연결할 업무', '2026-11-23', '2026-11-23');
  const later = await issue('조건을 충족하는 후행', '2026-12-10', '2026-12-11');
  const laterPartial = await f.issue('시작일이 조건을 충족하는 후행', f.project.id, { startDate: '2026-12-10', endDate: null });
  const original = await f.link(anchor, direct);
  const removed = await f.link(anchor, detached);
  const transitive = await f.link(direct, downstream);
  await f.link(anchor, later);
  await f.link(anchor, laterPartial);
  const body = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-26', dueDate: null },
    dependencies: [update(original, direct, 'FS', 1), remove(removed, detached), add(newSuccessor, 'successor', 'FS')],
  };
  const before = await f.workspace();
  const legacy = await f.review(body);
  assert.deepEqual(legacy.changes.map(change => change.id), [anchor.id]);
  await f.review({ ...body, rescheduleSuccessors: 'true' }, 400);
  const preview = await f.review({ ...body, rescheduleSuccessors: true });
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.previewId);
  const expectedDates = new Map([
    [anchor.id, { startDate: '2026-11-23', endDate: '2026-11-26', dueDate: null }],
    [direct.id, { startDate: '2026-11-30', endDate: '2026-12-01', dueDate: direct.dueDate }],
    [downstream.id, { startDate: '2026-12-02', endDate: '2026-12-02', dueDate: null }],
    [newSuccessor.id, { startDate: '2026-11-27', endDate: '2026-11-27', dueDate: null }],
  ]);
  assert.deepEqual(new Map(preview.changes.map(change => [change.id, [change.toStart, change.toEnd]])),
    new Map([...expectedDates].map(([id, { startDate, endDate }]) => [id, [startDate, endDate]])));
  assert.equal(preview.changes.find(change => change.id === anchor.id)?.toDue, null);
  const dueWarning = preview.warnings.find(warning => warning.includes(direct.key) && warning.includes('목표 마감일'));
  assert.ok(dueWarning);
  assert.equal(preview.dependencyChanges?.length, 3);
  assert.deepEqual(await f.workspace(), before);

  const database = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_cascade_write BEFORE UPDATE ON issues
      WHEN json_extract(NEW.json,'$.title')='간접 후행'
      BEGIN SELECT RAISE(ABORT,'synthetic downstream row edit failure'); END`);
    await f.apply(preview.previewId, 500);
    assert.deepEqual(await f.workspace(), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    database.exec('DROP TRIGGER fail_cascade_write');
  } finally { database.close(); }

  const applied = await f.apply(preview.previewId);
  assert.equal(applied.dependencyChanges, 3);
  assert.deepEqual(new Map(applied.updated.map(value => [value.id, dates(value)])), expectedDates);
  assert.ok(applied.warnings.includes(dueWarning));
  assert.deepEqual(await f.apply(preview.previewId), applied);
  const after = await f.workspace();
  assert.deepEqual(after.issues.find(value => value.id === detached.id), detached);
  assert.deepEqual(after.issues.find(value => value.id === later.id), later);
  assert.deepEqual(after.issues.find(value => value.id === laterPartial.id), laterPartial);
  assert.equal(pair(after, anchor, direct)?.lagDays, 1);
  assert.equal(pair(after, anchor, detached), undefined);
  assert.ok(pair(after, anchor, newSuccessor));
  assert.deepEqual(pair(after, direct, downstream), transitive);

  const undone = await f.call<SchedulePasteApplyResult>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.equal(undone.dependencyChanges, 3);
  assert.deepEqual(new Map(undone.updated.map(value => [value.id, dates(value)])),
    new Map([anchor, direct, downstream, newSuccessor].map(value => [value.id, dates(value)])));
  const restored = await f.workspace();
  assert.equal(pair(restored, anchor, direct)?.id, original.id);
  assert.equal(pair(restored, anchor, direct)?.lagDays, original.lagDays);
  assert.equal(pair(restored, anchor, detached)?.id, removed.id);
  assert.equal(pair(restored, anchor, newSuccessor), undefined);
  assert.deepEqual(pair(restored, direct, downstream), transitive);
});

test('row rescheduling rejects a stale preview if a downstream task’s other predecessor changes', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 업무');
  const successor = await f.issue('후행 업무');
  const outside = await f.issue('별도 선행 업무', f.project.id, { endDate: '2026-11-26' });
  await f.link(outside, successor);
  const body = {
    projectId: f.project.id, issue: versionOf(anchor), changes: {}, rescheduleSuccessors: true,
    dependencies: [add(successor, 'successor', 'FS')],
  };
  const preview = await f.review(body);
  assert.ok(preview.previewId);
  assert.deepEqual(preview.changes.map(change => [change.id, change.toStart, change.toEnd]), [
    [successor.id, '2026-11-27', '2026-11-30'],
  ]);
  await f.call(`/issues/${outside.id}`, 200, 'PATCH', { expectedVersion: outside.version, endDate: '2026-11-30' }, 'user-seo');
  const beforeStaleApply = await f.workspace();
  await f.apply(preview.previewId, 409);
  assert.deepEqual(await f.workspace(), beforeStaleApply);
  const fresh = await f.review(body);
  assert.ok(fresh.previewId);
  assert.deepEqual(fresh.changes.map(change => [change.id, change.toStart, change.toEnd]), [
    [successor.id, '2026-12-01', '2026-12-02'],
  ]);
});

test('row rescheduling blocks a partial downstream schedule without applying a staged link', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 업무');
  const partial = await f.issue('기간이 미정인 후행 업무', f.project.id, { endDate: null });
  const before = await f.workspace();
  const preview = await f.review({
    projectId: f.project.id, issue: versionOf(anchor), changes: {}, rescheduleSuccessors: true,
    dependencies: [add(partial, 'successor', 'FS')],
  });
  assert.equal(preview.previewId, null);
  assert.ok(preview.errors.some(error => error.message.includes(partial.key) && error.message.includes('기간')));
  assert.deepEqual(await f.workspace(), before);
});
