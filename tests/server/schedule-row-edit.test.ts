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
  Dependency, Issue, Project, SchedulePasteApplyResult, SchedulePastePreview, ScheduleRowEditInput, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

const reviewPath = '/schedule/row-edit/preview';
const applyPath = '/schedule/row-edit/apply';
const undoPath = '/schedule/undo';
const actor = 'user-yun';
const otherActor = 'user-seo';
const versionOf = ({ id, version }: Issue) => ({ id, expectedVersion: version });
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const linkFields = ({ type, lagDays }: Dependency) => ({ type, lagDays });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-schedule-row-edit-'));
  async function start() {
    const service = createApp({ dataDir: dir, outboundWorker: false, deadlineReminderWorker: false });
    const server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { service, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let running = await start();
  async function stop() {
    const { server, service } = running;
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { service.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const request = (path: string, method = 'GET', body?: unknown, actorId = actor) => fetch(running.base + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, actorId?: string) {
    const response = await request(path, method, body, actorId);
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'ROWEDIT', name: '간트 행 편집 테스트' });
  return {
    call, request, dir, project,
    async restart() { await stop(); running = await start(); },
    issue(title: string, fields: Partial<Pick<Issue, 'projectId' | 'startDate' | 'endDate' | 'dueDate'>> = {}) {
      return call<Issue>('/issues', 201, 'POST', {
        projectId: project.id, title, startDate: '2026-11-23', endDate: '2026-11-24', dueDate: '2026-11-27', ...fields,
      });
    },
    link(predecessor: Issue, successor: Issue) {
      return call<Dependency>('/dependencies', 201, 'POST', { predecessorId: predecessor.id, successorId: successor.id });
    },
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
    review: (body: unknown, status = 200) => call<SchedulePastePreview>(reviewPath, status, 'POST', body),
    apply: (previewId: string, status = 200, actorId?: string) =>
      call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
    undo: (undoId: string, status = 200) => call<Omit<SchedulePasteApplyResult, 'undoId'>>(undoPath, status, 'POST', { undoId }),
  };
}

function reviewId(review: SchedulePastePreview): string {
  assert.deepEqual(review.errors, []);
  assert.ok(review.previewId);
  assert.ok(review.expiresAt);
  return review.previewId;
}

function findLink(snapshot: WorkspaceSnapshot, predecessor: Issue, successor: Issue) {
  return snapshot.dependencies.find(link => link.predecessorId === predecessor.id && link.successorId === successor.id);
}

test('row edit previews and writes dates plus one successor link and recovers a lost apply response across restart', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('행 편집할 업무');
  const related = await f.issue('후행 업무', { startDate: '2026-11-24', endDate: '2026-11-26' });
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-25', dueDate: null },
    dependency: { action: 'add', relatedIssue: versionOf(related), direction: 'successor', type: 'FS', lagDays: 1 },
  };
  const before = await f.workspace();
  const review = await f.review(input);
  const previewId = reviewId(review);
  assert.equal(review.unchanged, 0);
  assert.deepEqual(review.changes, [{
    id: anchor.id, key: anchor.key, title: anchor.title, version: anchor.version,
    fromStart: anchor.startDate, fromEnd: anchor.endDate, fromDue: anchor.dueDate,
    toStart: anchor.startDate, toEnd: '2026-11-25', toDue: null,
  }]);
  assert.deepEqual(review.dependencyChanges, [{
    line: 1, predecessorKey: anchor.key, predecessorTitle: anchor.title,
    successorKey: related.key, successorTitle: related.title, before: null, after: { type: 'FS', lagDays: 1 },
  }]);
  assert.ok(review.warnings.some(warning => warning.includes(`${anchor.key} → ${related.key}`)));
  await f.apply(previewId, 409, otherActor);
  await f.call('/schedule/paste-apply', 404, 'POST', { previewId });
  await f.call('/schedule/bulk-dates/apply', 404, 'POST', { previewId });
  const unrelated = reviewId(await f.call<SchedulePastePreview>('/schedule/bulk-dates/preview', 200, 'POST', {
    projectId: f.project.id, issues: [versionOf(anchor)], changes: { endDate: '2026-11-27' },
  }));
  await f.apply(unrelated, 404);
  assert.deepEqual(await f.workspace(), before);

  const discarded = await f.request(applyPath, 'POST', { previewId });
  assert.equal(discarded.status, 200);
  await discarded.body?.cancel();
  const applied = await f.workspace();
  const link = findLink(applied, anchor, related);
  assert.ok(link);
  assert.deepEqual(linkFields(link), { type: 'FS', lagDays: 1 });
  assert.deepEqual(applied.issues.find(issue => issue.id === related.id), related);
  assert.equal(applied.dependencies.length, before.dependencies.length + 1);
  await f.restart();
  const replay = await f.apply(previewId);
  assert.ok(replay.undoId);
  assert.equal(replay.dependencyChanges, 1);
  assert.deepEqual(replay.warnings, review.warnings);
  assert.equal(replay.updated.length, 1);
  assert.equal(replay.updated[0].id, anchor.id);
  assert.equal(replay.updated[0].version, anchor.version + 1);
  assert.deepEqual(dates(replay.updated[0]), { startDate: anchor.startDate, endDate: '2026-11-25', dueDate: null });
  assert.deepEqual(await f.apply(previewId), replay);
  assert.deepEqual(await f.workspace(), applied);

  const undone = await f.undo(replay.undoId);
  assert.equal(undone.dependencyChanges, 1);
  assert.equal(undone.updated[0].version, anchor.version + 2);
  assert.deepEqual(dates(undone.updated[0]), dates(anchor));
  const reverted = await f.workspace();
  assert.deepEqual(reverted.dependencies, before.dependencies);
  assert.deepEqual(reverted.issues.find(issue => issue.id === related.id), related);
  await f.undo(replay.undoId, 409);
  assert.deepEqual(await f.workspace(), reverted);
});

test('row edit preserves predecessor direction on update and shares link-only removal undo', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('연결 수정할 업무');
  const predecessor = await f.issue('연결 유지할 선행 업무');
  const link = await f.link(predecessor, anchor);
  const update: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { startDate: '2026-11-24' },
    dependency: { action: 'update', id: link.id, expectedVersion: link.version!, relatedIssue: versionOf(predecessor), type: 'SS', lagDays: -2 },
  };
  const review = await f.review(update);
  assert.deepEqual(review.dependencyChanges?.map(({ predecessorKey, successorKey, before, after }) => ({ predecessorKey, successorKey, before, after })), [{
    predecessorKey: predecessor.key, successorKey: anchor.key, before: { type: 'FS', lagDays: 0 }, after: { type: 'SS', lagDays: -2 },
  }]);
  const applied = await f.apply(reviewId(review));
  const edited = findLink(await f.workspace(), predecessor, anchor);
  assert.ok(edited && edited.version);
  assert.equal(edited.id, link.id);
  assert.ok(edited.version > (link.version ?? 1));
  assert.deepEqual(linkFields(edited), { type: 'SS', lagDays: -2 });
  assert.equal(applied.updated[0].startDate, '2026-11-24');

  const undone = await f.undo(applied.undoId);
  assert.deepEqual(dates(undone.updated[0]), dates(anchor));
  const restored = findLink(await f.workspace(), predecessor, anchor);
  assert.ok(restored && restored.version);
  assert.equal(restored.id, link.id);
  assert.ok(restored.version > edited.version);
  assert.deepEqual(linkFields(restored), linkFields(link));

  const removal: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(undone.updated[0]), changes: {},
    dependency: { action: 'remove', id: restored.id, expectedVersion: restored.version, relatedIssue: versionOf(predecessor) },
  };
  const removalReview = await f.review(removal);
  assert.deepEqual(removalReview.changes, []);
  assert.equal(removalReview.dependencyChanges?.[0].after, null);
  const removed = await f.apply(reviewId(removalReview));
  assert.equal(removed.dependencyChanges, 1);
  assert.deepEqual(removed.updated, []);
  assert.equal(findLink(await f.workspace(), predecessor, anchor), undefined);
  assert.equal((await f.undo(removed.undoId)).dependencyChanges, 1);
  const replaced = findLink(await f.workspace(), predecessor, anchor);
  assert.ok(replaced);
  assert.equal(replaced.id, link.id);
  assert.deepEqual(linkFields(replaced), linkFields(link));
});

test('row edit rejects apply after anchor, related issue, link or calendar changes with no partial date writes', async t => {
  const f = await fixture(t);
  const scenarios = ['anchor issue', 'related issue', 'dependency', 'calendar'] as const;
  for (const scenario of scenarios) {
    const anchor = await f.issue(`행 편집: ${scenario}`);
    const related = await f.issue(`연결 업무: ${scenario}`);
    const link = await f.link(anchor, related);
    const input: ScheduleRowEditInput = {
      projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-27' },
      dependency: { action: 'update', id: link.id, expectedVersion: link.version!, relatedIssue: versionOf(related), type: 'FF', lagDays: 1 },
    };
    const previewId = reviewId(await f.review(input));
    if (scenario === 'anchor issue' || scenario === 'related issue') {
      const issue = scenario === 'anchor issue' ? anchor : related;
      await f.call(`/issues/${issue.id}`, 200, 'PATCH', { expectedVersion: issue.version, title: '검토 중 변경된 업무' }, otherActor);
    } else if (scenario === 'dependency') {
      await f.call(`/dependencies/${link.id}`, 200, 'PATCH', { expectedVersion: link.version, lagDays: 2 }, otherActor);
    } else {
      const calendarPath = `/projects/${f.project.id}/calendar`;
      const calendar = await f.call<WorkCalendar>(calendarPath);
      await f.call(calendarPath, 200, 'PATCH', { ...calendar, expectedVersion: calendar.version, workingWeekdays: [1, 2, 3, 4] }, otherActor);
    }
    const before = await f.workspace();
    await f.apply(previewId, 409);
    assert.deepEqual(await f.workspace(), before, scenario);
  }
});

test('row edit preview cannot authorize invalid dates, self links, cycles, duplicate pairs or foreign references', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('편집할 업무');
  const related = await f.issue('같은 프로젝트 업무');
  const another = await f.issue('별도 연결 업무');
  const foreign = await f.issue('다른 프로젝트 업무', { projectId: 'project-neo' });
  const link = await f.link(related, anchor);
  const otherLink = await f.link(related, another);
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-25' },
    dependency: { action: 'add', relatedIssue: versionOf(another), direction: 'predecessor', type: 'FS', lagDays: 0 },
  };
  const before = await f.workspace();
  for (const malformed of [
    { ...input, changes: { startDate: '2026-02-29' } },
    { ...input, changes: { title: '일정 편집 범위 밖의 값' } },
    { ...input, dependency: { ...input.dependency, direction: 'other' } },
    { ...input, dependency: { ...input.dependency, lagDays: 3651 } },
  ]) await f.review(malformed, 400);

  const base = { ...input, dependency: undefined };
  const add = (relatedIssue: Issue, direction: 'predecessor' | 'successor' = 'predecessor'): ScheduleRowEditInput => ({
    ...base, dependency: { action: 'add', relatedIssue: versionOf(relatedIssue), direction, type: 'FS', lagDays: 0 },
  });
  const invalid: ScheduleRowEditInput[] = [
    { ...base, changes: { endDate: '2026-11-22' } },
    { ...base, issue: versionOf(foreign) },
    { ...base, issue: { id: anchor.id, expectedVersion: anchor.version + 1 } },
    add(foreign), add(anchor), add(related), add(related, 'successor'),
    { ...add(another), dependency: { action: 'add', relatedIssue: { id: another.id, expectedVersion: another.version + 1 },
      direction: 'predecessor', type: 'FS', lagDays: 0 } },
    { ...base, dependency: { action: 'remove', id: link.id, expectedVersion: (link.version ?? 1) + 1, relatedIssue: versionOf(related) } },
    { ...base, dependency: { action: 'remove', id: otherLink.id, expectedVersion: otherLink.version ?? 1, relatedIssue: versionOf(related) } },
  ];
  for (const value of invalid) {
    const review = await f.review(value);
    assert.equal(review.previewId, null, JSON.stringify(value));
    assert.equal(review.expiresAt, null);
    assert.ok(review.errors.length);
  }
  const noop = await f.review({ ...base, changes: { endDate: anchor.endDate } });
  assert.equal(noop.previewId, null);
  assert.equal(noop.unchanged, 1);
  assert.deepEqual(noop.errors, []);
  assert.deepEqual(await f.workspace(), before);
});

test('row edit rolls back a failed dependency insert and rejects undo when its applied link was changed', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('롤백 검증할 업무');
  const related = await f.issue('추가할 선행 업무');
  const previewId = reviewId(await f.review({
    projectId: f.project.id, issue: versionOf(anchor), changes: { dueDate: '2026-11-26' },
    dependency: { action: 'add', relatedIssue: versionOf(related), direction: 'predecessor', type: 'FF', lagDays: 0 },
  }));
  const before = await f.workspace();
  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_row_dependency BEFORE INSERT ON dependencies
      BEGIN SELECT RAISE(ABORT,'synthetic row dependency insert failure'); END`);
    try {
      await f.apply(previewId, 500);
      assert.deepEqual(await f.workspace(), before);
      assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    } finally { database.exec('DROP TRIGGER fail_row_dependency'); }
  } finally { database.close(); }

  const applied = await f.apply(previewId);
  const link = findLink(await f.workspace(), related, anchor);
  assert.ok(link);
  await f.call(`/dependencies/${link.id}`, 200, 'PATCH', { expectedVersion: link.version, lagDays: 1 }, otherActor);
  const beforeUndo = await f.workspace();
  await f.undo(applied.undoId, 409);
  assert.deepEqual(await f.workspace(), beforeUndo);
  assert.equal(beforeUndo.issues.find(issue => issue.id === anchor.id)?.dueDate, '2026-11-26');
});
