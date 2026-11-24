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
  Dependency, Issue, IssueRelation, Project, SchedulePasteApplyResult, SchedulePastePreview, SchedulePreview, ScheduleRowEditInput,
  WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

const reviewPath = '/schedule/row-edit/preview';
const applyPath = '/schedule/row-edit/apply';
const undoPath = '/schedule/undo';
const actor = 'user-yun';
const otherActor = 'user-seo';
const versionOf = ({ id, version }: Issue) => ({ id, expectedVersion: version });
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const linkFields = ({ type, lagDays }: Dependency) => ({ type, lagDays });
const handoff = (source: Issue, target: Issue) => `프로젝트 간 차단 관계 ${source.key} → ${target.key} · `;
function assertHandoffConflict(preview: Pick<SchedulePreview, 'warnings' | 'teamBlockerWarnings'>, source: Issue, target: Issue, date: string) {
  const message = preview.teamBlockerWarnings?.find(warning => warning.startsWith(handoff(source, target)));
  assert.ok(message, JSON.stringify(preview));
  assert.ok(message.includes(`후행 업무 시작일은 ${date} 이후여야 합니다.`), message);
  assert.ok(preview.warnings.includes(message));
}

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
  const request = (path: string, method = 'GET', body?: unknown, actorId = actor, headers: Record<string, string> = {}) => fetch(running.base + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, actorId?: string, headers?: Record<string, string>) {
    const response = await request(path, method, body, actorId, headers);
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
    blocker(source: Issue, target: Issue, actorId = actor) {
      return call<IssueRelation>(`/issues/${source.id}/relations`, 201, 'POST', { type: 'blocks', direction: 'outgoing', otherIssueId: target.id }, actorId);
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

test('row edit stores both projected dates and the new dependency in one retriable and reversible change', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('선행 날짜 편집');
  const successor = await f.issue('후행 날짜 편집', { startDate: '2026-11-25', endDate: '2026-11-26' });
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(successor), changes: { startDate: '2026-11-30', endDate: '2026-12-01' },
    relatedDates: { issue: versionOf(predecessor), changes: { endDate: '2026-11-27', dueDate: null } },
    dependency: { action: 'add', relatedIssue: versionOf(predecessor), direction: 'predecessor', type: 'FS', lagDays: 0 },
  };
  const before = await f.workspace();
  const conflict = await f.review({ ...input, changes: { startDate: '2026-11-26', endDate: '2026-12-01' } });
  assert.ok(conflict.warnings.some(warning => warning.includes(`${predecessor.key} → ${successor.key}`) && warning.includes('2026-11-30')));
  const preview = await f.review(input);
  const previewId = reviewId(preview);
  assert.deepEqual(preview.changes.map(({ id, fromStart, toStart, fromEnd, toEnd, fromDue, toDue }) => ({
    id, fromStart, toStart, fromEnd, toEnd, fromDue, toDue,
  })), [
    { id: successor.id, fromStart: successor.startDate, toStart: '2026-11-30', fromEnd: successor.endDate, toEnd: '2026-12-01',
      fromDue: successor.dueDate, toDue: successor.dueDate },
    { id: predecessor.id, fromStart: predecessor.startDate, toStart: predecessor.startDate, fromEnd: predecessor.endDate, toEnd: '2026-11-27',
      fromDue: predecessor.dueDate, toDue: null },
  ]);
  assert.ok(!preview.warnings.some(warning => warning.includes(`${predecessor.key} → ${successor.key}`)));

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_paired_dependency BEFORE INSERT ON dependencies
      BEGIN SELECT RAISE(ABORT,'synthetic paired dependency failure'); END`);
    try {
      await f.apply(previewId, 500);
      assert.deepEqual(await f.workspace(), before);
      assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    } finally { database.exec('DROP TRIGGER fail_paired_dependency'); }
  } finally { database.close(); }

  const applied = await f.apply(previewId);
  assert.deepEqual(applied.updated.map(({ id, version }) => ({ id, version })), [
    { id: successor.id, version: successor.version + 1 }, { id: predecessor.id, version: predecessor.version + 1 },
  ]);
  assert.deepEqual(applied.updated.map(dates), [
    { startDate: '2026-11-30', endDate: '2026-12-01', dueDate: successor.dueDate },
    { startDate: predecessor.startDate, endDate: '2026-11-27', dueDate: null },
  ]);
  assert.equal(applied.dependencyChanges, 1);
  assert.deepEqual(linkFields(findLink(await f.workspace(), predecessor, successor)!), { type: 'FS', lagDays: 0 });
  await f.restart();
  assert.deepEqual(await f.apply(previewId), applied);

  const undone = await f.undo(applied.undoId);
  assert.equal(undone.dependencyChanges, 1);
  assert.deepEqual(undone.updated.map(dates), [dates(successor), dates(predecessor)]);
  assert.deepEqual((await f.workspace()).dependencies, before.dependencies);
});

test('row edit requires a same-project linked peer with a valid current version and date window', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 일정');
  const peer = await f.issue('연결 일정');
  const foreign = await f.issue('프로젝트 밖 일정', { projectId: 'project-neo' });
  const base: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-25' },
    relatedDates: { issue: versionOf(peer), changes: { endDate: '2026-11-26' } },
  };
  const input: ScheduleRowEditInput = { ...base,
    dependency: { action: 'add', relatedIssue: versionOf(peer), direction: 'predecessor', type: 'FS', lagDays: 0 },
  };
  const before = await f.workspace();
  for (const relatedDates of [null, { issue: versionOf(peer), changes: {} },
    { issue: versionOf(peer), changes: { endDate: '2026-02-29' } },
    { issue: versionOf(peer), changes: { title: '날짜 외 변경' } }]) {
    await f.review({ ...input, relatedDates }, 400);
  }
  for (const attempted of [base,
    { ...input, relatedDates: { ...base.relatedDates!, issue: versionOf(anchor) } },
    { ...input, relatedDates: { ...base.relatedDates!, issue: versionOf(foreign) } },
    { ...input, relatedDates: { ...base.relatedDates!, issue: { id: peer.id, expectedVersion: peer.version + 1 } } },
    { ...input, relatedDates: { ...base.relatedDates!, issue: { id: 'missing-issue', expectedVersion: 1 } } },
    { ...input, relatedDates: { ...base.relatedDates!, changes: { endDate: '2026-11-22' } } },
  ]) {
    const rejected = await f.review(attempted);
    assert.equal(rejected.previewId, null, JSON.stringify(attempted));
    assert.ok(rejected.errors.length);
  }
  assert.deepEqual(await f.workspace(), before);

  const link = await f.link(peer, anchor);
  const removal = await f.review({ ...base,
    dependency: { action: 'remove', id: link.id, expectedVersion: link.version!, relatedIssue: versionOf(peer) },
  });
  assert.equal(removal.previewId, null);
  assert.ok(removal.errors.some(error => error.issueId === peer.id && error.message.includes('선후행 연결')));

  const previewId = reviewId(await f.review(base)); // Existing dependencies can supply the relation without a link edit.
  await f.call(`/issues/${peer.id}`, 200, 'PATCH', { expectedVersion: peer.version, title: '동료가 편집한 연결 일정' }, otherActor);
  const afterPeerEdit = await f.workspace();
  await f.apply(previewId, 409);
  assert.deepEqual(await f.workspace(), afterPeerEdit);
});

test('row edit preserves both explicit schedules while rescheduling successors of either row', async t => {
  const f = await fixture(t);
  const peer = await f.issue('날짜를 고친 선행');
  const anchor = await f.issue('날짜를 고친 후행', { startDate: '2026-11-25', endDate: '2026-11-26' });
  const branch = await f.issue('선행의 다른 후행', { startDate: '2026-11-25', endDate: '2026-11-25' });
  const downstream = await f.issue('두 번째 업무의 후행', { startDate: '2026-11-27', endDate: '2026-11-27' });
  await f.link(peer, branch);
  await f.link(anchor, downstream);
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { startDate: '2026-11-27', endDate: '2026-11-30' },
    relatedDates: { issue: versionOf(peer), changes: { endDate: '2026-11-26', dueDate: '2026-11-30' } },
    dependency: { action: 'add', relatedIssue: versionOf(peer), direction: 'predecessor', type: 'FS', lagDays: 0 },
    rescheduleSuccessors: true,
  };
  const conflict = await f.review({ ...input, changes: { ...input.changes, startDate: '2026-11-26' } });
  assert.equal(conflict.previewId, null);
  assert.ok(conflict.errors.some(error => error.message.includes(anchor.key) && error.message.includes('입력한 시작일')));

  const preview = await f.review(input);
  const previewId = reviewId(preview);
  const dateChanges = (changes: SchedulePastePreview['changes']) => new Map(changes.map(({ id, toStart, toEnd, toDue }) =>
    [id, { startDate: toStart, endDate: toEnd, dueDate: toDue }]));
  assert.deepEqual(dateChanges(preview.changes), new Map([
    [anchor.id, { startDate: '2026-11-27', endDate: '2026-11-30', dueDate: anchor.dueDate }],
    [peer.id, { startDate: peer.startDate, endDate: '2026-11-26', dueDate: '2026-11-30' }],
    [branch.id, { startDate: '2026-11-27', endDate: '2026-11-27', dueDate: branch.dueDate }],
    [downstream.id, { startDate: '2026-12-01', endDate: '2026-12-01', dueDate: downstream.dueDate }],
  ]));
  const applied = await f.apply(previewId);
  assert.deepEqual(new Map(applied.updated.map(issue => [issue.id, dates(issue)])), dateChanges(preview.changes));
  const undone = await f.undo(applied.undoId);
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, dates(issue)])),
    new Map([anchor, peer, branch, downstream].map(issue => [issue.id, dates(issue)])));
});

test('row edit reviews and fences incoming cross-project blockers on the peer even for an end-only edit', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('프로젝트 내부 선행');
  const peer = await f.issue('프로젝트 간 차단 연결 업무', { startDate: '2026-11-30', endDate: '2026-12-01' });
  const external = await f.issue('외부 차단 선행', { projectId: 'project-neo', endDate: '2026-11-26' });
  await f.link(anchor, peer);
  await f.blocker(external, peer);
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(anchor), changes: { endDate: '2026-11-25' },
    relatedDates: { issue: versionOf(peer), changes: { endDate: '2026-12-02' } }, reviewIncomingTeamBlockers: true,
  };
  const conflict = await f.review({ ...input, relatedDates: { issue: versionOf(peer), changes: { startDate: '2026-11-26' } } });
  assert.equal(conflict.previewId, null);
  assert.ok(conflict.errors.some(error => error.issueId === peer.id && error.message.includes(external.key)));

  const previewId = reviewId(await f.review(input));
  await f.call(`/issues/${external.id}`, 200, 'PATCH', { expectedVersion: external.version, title: '외부 선행 업무 수정' }, otherActor);
  const beforeApply = await f.workspace();
  const rejected = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId });
  assert.match(rejected.error, /프로젝트 간 선행 업무 또는 차단 관계가 변경되었습니다/u);
  assert.deepEqual(await f.workspace(), beforeApply);
});

test('row edit preserves predecessor direction on update and shares link-only removal undo', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('연결 수정할 업무');
  const predecessor = await f.issue('연결 유지할 선행 업무');
  const untouched = await f.issue('해제와 무관한 후행 업무');
  const link = await f.link(predecessor, anchor);
  await f.link(anchor, untouched);
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
    rescheduleSuccessors: true,
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
  assert.deepEqual((await f.workspace()).issues.find(issue => issue.id === untouched.id), untouched);
});

test('link-only row review adjusts the edited successor subtree and retries one applied result', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('새 선행 업무');
  const target = await f.issue('이번에 연결할 후행 업무', { startDate: '2026-11-24', endDate: '2026-11-25' });
  const downstream = await f.issue('필터 밖에서 영향을 받는 후행 업무', { startDate: '2026-11-26', endDate: '2026-11-27' });
  const sibling = await f.issue('별도 관리 중인 기존 연결 업무');
  await f.link(target, downstream);
  await f.link(predecessor, sibling);
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(predecessor), changes: {},
    dependency: { action: 'add', direction: 'successor', relatedIssue: versionOf(target), type: 'FS', lagDays: 1 },
  };
  const ordinary = await f.review(input);
  reviewId(ordinary);
  assert.deepEqual(ordinary.changes, []);
  assert.ok(ordinary.warnings.some(warning => warning.includes(`${predecessor.key} → ${target.key}`) && warning.includes('2026-11-26')));

  const reviewedInput = { ...input, rescheduleSuccessors: true };
  const proposed = await f.review(reviewedInput);
  const stale = reviewId(proposed);
  assert.deepEqual(new Set(proposed.followUpIssueIds), new Set([target.id, downstream.id]));
  const expected = new Map([
    [target.id, ['2026-11-26', '2026-11-27']],
    [downstream.id, ['2026-11-30', '2026-12-01']],
  ]);
  const proposedDates = (answer: SchedulePastePreview) => new Map(answer.changes.map(({ id, toStart, toEnd }) => [id, [toStart, toEnd]]));
  assert.deepEqual(proposedDates(proposed), expected);
  assert.equal(findLink(await f.workspace(), predecessor, target), undefined);

  const updated = await f.call<Issue>(`/issues/${downstream.id}`, 200, 'PATCH', { expectedVersion: downstream.version,
    title: '검토 뒤 수정된 후행 제목' }, otherActor);
  const before = await f.workspace();
  await f.apply(stale, 409);
  assert.deepEqual(await f.workspace(), before);
  const fresh = await f.review(reviewedInput);
  assert.deepEqual(proposedDates(fresh), expected);
  const previewId = reviewId(fresh);
  const applied = await f.apply(previewId);
  assert.equal(applied.dependencyChanges, 1);
  assert.deepEqual(new Map(applied.updated.map(({ id, startDate, endDate }) => [id, [startDate, endDate]])), expected);
  const saved = await f.workspace();
  assert.ok(findLink(saved, predecessor, target));
  for (const unchanged of [predecessor, sibling]) assert.deepEqual(saved.issues.find(issue => issue.id === unchanged.id), unchanged);
  assert.equal(saved.issues.find(issue => issue.id === updated.id)?.title, updated.title);
  assert.deepEqual(await f.apply(previewId), applied);
  assert.deepEqual(await f.workspace(), saved);

  const undone = await f.undo(applied.undoId);
  assert.equal(undone.dependencyChanges, 1);
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, dates(issue)])), new Map([target, downstream].map(issue => [issue.id, dates(issue)])));
  assert.deepEqual((await f.workspace()).dependencies, before.dependencies);
});

test('a quick link can retime cross-project successors and keep the row undo scope', async t => {
  const f = await fixture(t);
  const receiving = await f.call<Project>('/projects', 201, 'POST', { key: 'ROWDEST', name: '일정을 받는 프로젝트' });
  const predecessor = await f.issue('새 연결의 선행');
  const relay = await f.issue('공통 프로젝트의 후행');
  const target = await f.issue('가려진 프로젝트의 차단 대상', { projectId: receiving.id });
  const downstream = await f.issue('다른 프로젝트의 간접 후행', { projectId: receiving.id });
  const closing = await f.issue('검토 중 완료될 차단 대상', { projectId: receiving.id });
  const retained = await f.link(target, downstream);
  await f.blocker(relay, target);
  await f.blocker(relay, closing);
  const input: ScheduleRowEditInput = { projectId: f.project.id, issue: versionOf(predecessor), changes: {},
    dependency: { action: 'add', direction: 'successor', relatedIssue: versionOf(relay), type: 'FS', lagDays: 0 },
    rescheduleSuccessors: true, includeTeamBlockers: true,
  };
  await f.review({ ...input, rescheduleSuccessors: false }, 400);
  await f.review({ ...input, includeTeamBlockers: 'true' }, 400);
  const before = await f.workspace();
  const existing = { id: retained.id, expectedVersion: retained.version ?? 1, relatedIssue: versionOf(downstream) };
  const existingInput = { ...input, projectId: receiving.id, issue: versionOf(target) };
  const unchanged = await f.review({ ...existingInput, dependency: { ...existing, action: 'update', type: 'FS', lagDays: 0 } });
  assert.equal(unchanged.previewId, null);
  assert.equal(unchanged.unchanged, 1);
  const removal = await f.review({ ...existingInput, dependency: { ...existing, action: 'remove' } });
  reviewId(removal);
  assert.deepEqual(removal.changes, []);
  assert.equal(removal.followUpIssueIds, undefined);
  const local = await f.review({ ...input, includeTeamBlockers: false });
  reviewId(local);
  assert.deepEqual(local.followUpIssueIds, [relay.id]);
  assertHandoffConflict(local, relay, target, '2026-11-27');
  const mixed = await f.review({ ...input, changes: { endDate: '2026-11-25' },
    relatedDates: { issue: versionOf(relay), changes: { dueDate: '2026-11-26' } },
  });
  reviewId(mixed);
  assert.deepEqual(mixed.changes.slice(0, 2).map(({ id, toStart, toEnd, toDue, projectId }) => [id, toStart, toEnd, toDue, projectId]), [
    [predecessor.id, predecessor.startDate, '2026-11-25', predecessor.dueDate, f.project.id],
    [relay.id, '2026-11-26', '2026-11-27', '2026-11-26', f.project.id],
  ]);
  const old = reviewId(await f.review(input));
  assert.deepEqual(await f.workspace(), before);

  const calendarPath = `/projects/${receiving.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-27', isWorking: false, label: '검토 후 추가한 휴무' }],
  }, otherActor);
  await f.apply(old, 409);
  const beforeClosing = reviewId(await f.review(input));
  await f.call(`/issues/${closing.id}`, 200, 'PATCH', { expectedVersion: closing.version, status: 'done' }, otherActor);
  const concurrent = await f.workspace();
  await f.apply(beforeClosing, 409);
  assert.deepEqual(await f.workspace(), concurrent);

  const reviewed = await f.review(input);
  const id = reviewId(reviewed);
  const expected = new Map([[relay.id, ['2026-11-25', '2026-11-26']], [target.id, ['2026-11-30', '2026-12-01']],
    [downstream.id, ['2026-12-02', '2026-12-03']]]);
  assert.deepEqual(new Set(reviewed.followUpIssueIds), new Set(expected.keys()));
  assert.deepEqual(new Map(reviewed.changes.map(({ id, toStart, toEnd }) => [id, [toStart, toEnd]])), expected);
  assert.equal(reviewed.changes.find(change => change.id === downstream.id)?.projectId, receiving.id);
  const undoScope = { 'X-Teamspace-Schedule-Undo-Scope': `issue:${predecessor.id}` };
  const apply = () => f.call<SchedulePasteApplyResult>(applyPath, 200, 'POST', { previewId: id }, actor, undoScope);
  await f.restart();
  const result = await apply();
  assert.equal(result.dependencyChanges, 1);
  assert.deepEqual(new Map(result.updated.map(({ id, startDate, endDate }) => [id, [startDate, endDate]])), expected);
  assert.deepEqual(await apply(), result);
  const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: result.undoId }, actor, undoScope);
  assert.equal(undo.dependencyChanges, 1);
  assert.deepEqual(new Map(undo.updated.map(issue => [issue.id, dates(issue)])),
    new Map([relay, target, downstream].map(issue => [issue.id, dates(issue)])));
  assert.deepEqual((await f.workspace()).dependencies, concurrent.dependencies);
});

test('link-only row review allows connecting an undated task when schedule adjustment is off', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('날짜가 있는 선행 업무');
  const target = await f.issue('날짜를 입력하지 않은 후행 업무', { startDate: null, endDate: null });
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(predecessor), changes: {},
    dependency: { action: 'add', direction: 'successor', relatedIssue: versionOf(target), type: 'FS', lagDays: 0 },
  };
  const blocked = await f.review({ ...input, rescheduleSuccessors: true });
  assert.equal(blocked.previewId, null);
  assert.ok(blocked.errors.some(error => error.message.includes(target.key)));
  const preview = await f.review(input);
  const warning = preview.warnings.find(value => value.includes('날짜 미정') && value.includes(`${target.key} 시작일`));
  assert.ok(warning);
  const result = await f.apply(reviewId(preview));
  assert.deepEqual(result.updated, []);
  assert.ok(result.warnings.includes(warning));
  const saved = await f.workspace();
  assert.ok(findLink(saved, predecessor, target));
  assert.deepEqual(saved.issues.find(issue => issue.id === target.id), target);
});

test('reviewed reversal preserves link identity and records both sides before a guarded undo', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('기존 선행 업무');
  const successor = await f.issue('기존 후행 업무');
  const link = await f.link(predecessor, successor);
  const before = await f.workspace();
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(successor), changes: {},
    dependency: { action: 'update', id: link.id, expectedVersion: link.version!, relatedIssue: versionOf(predecessor),
      type: 'SS', lagDays: -1, reverse: true },
  };
  await f.review({ ...input, dependency: { ...input.dependency, reverse: 'true' } }, 400);
  const review = await f.review(input);
  assert.deepEqual(review.dependencyChanges, [{
    line: 1, predecessorKey: successor.key, predecessorTitle: successor.title, successorKey: predecessor.key, successorTitle: predecessor.title,
    beforeDirection: { predecessorKey: predecessor.key, successorKey: successor.key },
    before: { type: 'FS', lagDays: 0 }, after: { type: 'SS', lagDays: -1 },
  }]);
  assert.deepEqual(review.changes, []);
  assert.deepEqual(await f.workspace(), before);
  const previewId = reviewId(review);
  const applied = await f.apply(previewId);
  const saved = await f.workspace();
  const reversed = findLink(saved, successor, predecessor);
  assert.ok(reversed?.version);
  assert.equal(findLink(saved, predecessor, successor), undefined);
  assert.equal(reversed.id, link.id);
  assert.ok(reversed.version > (link.version ?? 1));
  assert.deepEqual(linkFields(reversed), { type: 'SS', lagDays: -1 });
  const eventIds = new Set(before.activities.map(event => event.id));
  const events = saved.activities.filter(event => !eventIds.has(event.id) && event.action === '선후행 방향 변경');
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map(event => event.resourceId)), new Set([predecessor.id, successor.id]));
  for (const event of events) {
    assert.equal(event.actorId, actor);
    assert.ok(event.detail.includes(`${predecessor.key} → ${successor.key}`));
    assert.ok(event.detail.includes(`${successor.key} → ${predecessor.key}`));
  }
  assert.deepEqual(await f.apply(previewId), applied);
  assert.deepEqual(await f.workspace(), saved);
  const undone = await f.undo(applied.undoId);
  assert.equal(undone.dependencyChanges, 1);
  assert.deepEqual(undone.updated, []);
  const restored = findLink(await f.workspace(), predecessor, successor);
  assert.ok(restored?.version);
  assert.equal(restored.id, link.id);
  assert.ok(restored.version > reversed.version);
  assert.deepEqual(linkFields(restored), linkFields(link));
});

test('reviewed reversal rechecks cycles at preview, apply and undo', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('순환 경로의 시작');
  const successor = await f.issue('순환 경로의 끝');
  const firstMiddle = await f.issue('간접 경로의 첫 업무');
  const lastMiddle = await f.issue('간접 경로의 마지막 업무');
  const undoMiddle = await f.issue('되돌리기 직전 연결할 업무');
  const link = await f.link(predecessor, successor);
  await f.link(predecessor, firstMiddle);
  await f.link(lastMiddle, successor);
  const input: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(successor), changes: {},
    dependency: { action: 'update', id: link.id, expectedVersion: link.version!, relatedIssue: versionOf(predecessor),
      type: 'FS', lagDays: 0, reverse: true },
  };
  const stale = reviewId(await f.review(input));
  const bridge = await f.link(firstMiddle, lastMiddle);
  const before = await f.workspace();
  const cyclic = await f.review(input);
  assert.equal(cyclic.previewId, null);
  assert.ok(cyclic.errors.some(error => error.message.includes('순환')));
  await f.apply(stale, 409);
  assert.deepEqual(await f.workspace(), before);

  await f.call(`/dependencies/${bridge.id}?expectedVersion=${bridge.version}`, 200, 'DELETE');
  const applied = await f.apply(reviewId(await f.review(input)));
  await f.link(successor, undoMiddle);
  await f.link(undoMiddle, predecessor);
  const beforeUndo = await f.workspace();
  const blocked = await f.call<{ error: string }>(undoPath, 409, 'POST', { undoId: applied.undoId });
  assert.match(blocked.error, /순환/u);
  assert.deepEqual(await f.workspace(), beforeUndo);
});

test('a reviewed removal cannot restore a pair that was recreated through two later reversals', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('해제한 원래 선행 업무');
  const successor = await f.issue('해제한 원래 후행 업무');
  const original = await f.link(predecessor, successor);
  const removal: ScheduleRowEditInput = {
    projectId: f.project.id, issue: versionOf(predecessor), changes: {},
    dependency: { action: 'remove', id: original.id, expectedVersion: original.version!, relatedIssue: versionOf(successor) },
  };
  const applied = await f.apply(reviewId(await f.review(removal)));
  const newLink = await f.link(successor, predecessor);
  const reversed = await f.call<Dependency>(`/dependencies/${newLink.id}`, 200, 'PATCH', { expectedVersion: newLink.version, reverse: true });
  assert.equal(reversed.predecessorId, predecessor.id);
  const restored = await f.call<Dependency>(`/dependencies/${reversed.id}`, 200, 'PATCH', { expectedVersion: reversed.version, reverse: true });
  await f.call(`/dependencies/${restored.id}?expectedVersion=${restored.version}`, 200, 'DELETE');
  const before = await f.workspace();
  assert.equal(findLink(before, predecessor, successor), undefined);
  assert.equal(findLink(before, successor, predecessor), undefined);
  await f.undo(applied.undoId, 409);
  assert.deepEqual(await f.workspace(), before);
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

test('row edit checks open incoming cross-project blockers with the receiving calendar and preserves missing-date warnings', async t => {
  const f = await fixture(t);
  const target = await f.issue('검토할 후행 업무', { startDate: null, endDate: null });
  const source = await f.issue('다른 프로젝트 선행 업무', { projectId: 'project-neo', endDate: '2026-11-26' });
  const unknown = await f.issue('종료일이 미정인 선행 업무', { projectId: source.projectId, startDate: null, endDate: null });
  const local = await f.issue('프로젝트 내 차단', { endDate: '2027-01-26' });
  const outgoing = await f.issue('프로젝트 간 후행', { projectId: source.projectId, endDate: '2027-01-26' });
  const closed = await f.issue('종료한 선행 업무', { projectId: source.projectId, endDate: '2027-01-26' });
  await f.call(`/issues/${closed.id}`, 200, 'PATCH', { expectedVersion: closed.version, status: 'done' });
  for (const predecessor of [source, unknown, local, closed]) await f.blocker(predecessor, target);
  await f.blocker(target, outgoing);
  const calendarPath = `/projects/${target.projectId}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { ...calendar, expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-27', isWorking: false, label: '후행 프로젝트 휴무' }],
  });
  const premature = { projectId: target.projectId, issue: versionOf(target), changes: { startDate: '2026-11-27', endDate: '2026-11-30' } };
  await f.review({ ...premature, reviewIncomingTeamBlockers: 'true' }, 400);
  const before = await f.workspace();
  const manual = await f.review({ ...premature, reviewIncomingTeamBlockers: false });
  assert.ok(reviewId(manual));
  assertHandoffConflict(manual, source, target, '2026-11-30');
  const conflict = await f.review({ ...premature, reviewIncomingTeamBlockers: true });
  assert.equal(conflict.previewId, null);
  assert.deepEqual(conflict.errors, [{ line: null, issueId: target.id, key: target.key,
    message: `프로젝트 간 선행 업무 ${source.key}의 종료일 2026-11-26에 따라 시작일은 2026-11-30 이후여야 합니다.`,
  }]);
  assert.deepEqual(await f.workspace(), before);

  const corrected = await f.review({ ...premature, changes: { startDate: '2026-11-30', endDate: '2026-12-01' }, reviewIncomingTeamBlockers: true });
  assert.ok(corrected.warnings.includes(`${handoff(unknown, target)}${unknown.key}의 종료일을 확인해 주세요.`));
  assertHandoffConflict(corrected, target, outgoing, '2026-12-02');
  const previewId = reviewId(corrected);
  const applied = await f.apply(previewId);
  assert.deepEqual(applied.warnings, corrected.warnings);
  assert.deepEqual(applied.updated.map(issue => [issue.id, issue.startDate, issue.endDate]), [[target.id, '2026-11-30', '2026-12-01']]);
  assert.deepEqual(await f.apply(previewId), applied);
  const committed = await f.workspace();
  assert.deepEqual(committed.teamScheduleBlockers, before.teamScheduleBlockers);
  assert.deepEqual(committed.dependencies, before.dependencies);
  const undone = await f.undo(applied.undoId);
  assert.deepEqual(dates(undone.updated[0]), dates(target));
});

test('row edit invalidates reviewed incoming blockers after additions, source changes and removals', async t => {
  const f = await fixture(t);
  const target = await f.issue('후행 일정 미정', { startDate: null, endDate: null });
  const source = await f.issue('선행 종료 미정', { projectId: 'project-neo', endDate: null });
  const input: ScheduleRowEditInput = { projectId: target.projectId, issue: versionOf(target),
    changes: { startDate: '2026-11-30', endDate: '2026-12-01' }, reviewIncomingTeamBlockers: true,
  };
  const expectStale = async (previewId: string) => {
    const before = await f.workspace();
    const rejection = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId });
    assert.match(rejection.error, /프로젝트 간 선행 업무 또는 차단 관계가 변경되었습니다/u);
    assert.deepEqual(await f.workspace(), before);
  };
  const originallyEmpty = reviewId(await f.review(input));
  const relation = await f.blocker(source, target, otherActor);
  await expectStale(originallyEmpty);

  const withUnknownDate = await f.review(input);
  assert.ok(withUnknownDate.warnings.some(warning => warning.includes(source.key)));
  await f.call(`/issues/${source.id}`, 200, 'PATCH', { expectedVersion: source.version, endDate: '2026-11-26' }, otherActor);
  await expectStale(reviewId(withUnknownDate));

  const withFinishedSource = reviewId(await f.review(input));
  await f.call(`/issues/${source.id}/relations/${relation.id}?expectedVersion=${relation.version}`, 200, 'DELETE', undefined, otherActor);
  await expectStale(withFinishedSource);

  const refreshed = await f.apply(reviewId(await f.review(input)));
  assert.deepEqual(refreshed.updated.map(({ id }) => id), [target.id]);
});

test('ordinary date proposals report hidden cross-project blockers and preserve advisory warnings through apply and undo', async t => {
  const f = await fixture(t);
  const source = await f.issue('프로젝트 밖 선행 티켓', { projectId: 'project-neo', endDate: '2026-11-26' });
  const target = await f.issue('검토 중인 후행 티켓', { startDate: null, endDate: '2026-12-01' });
  const localSource = await f.issue('같은 프로젝트의 별도 선행 연결', { endDate: '2026-11-30' });
  await f.blocker(source, target);
  await f.link(localSource, target);
  const calendarPath = `/projects/${target.projectId}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-27', isWorking: false, label: '후행 프로젝트 휴무' }],
  });
  const scope = { projectId: target.projectId };
  const changes = { startDate: '2026-11-27' };
  const requests = [
    { preview: '/schedule/paste-preview', body: {
      ...scope, text: `key\tstartDate\n${target.key}\t${changes.startDate}`,
    } },
    { preview: reviewPath, body: { ...scope, issue: versionOf(target), changes } },
    { preview: '/schedule/bulk-dates/preview', body: { ...scope, issues: [versionOf(target)], changes } },
    { preview: '/schedule/manual-preview', body: {
      changes: [{ ...versionOf(target), ...changes, endDate: target.endDate }],
    } },
  ];
  const before = await f.workspace();
  const [pasted] = await Promise.all(requests.map(async ({ preview, body }) => {
    const proposal = await f.call<SchedulePastePreview | SchedulePreview>(preview, 200, 'POST', body);
    assert.ok(proposal.previewId, JSON.stringify(proposal));
    assert.equal(proposal.teamBlockerWarnings?.length, 1);
    assertHandoffConflict(proposal, source, target, '2026-11-30');
    assert.ok(proposal.warnings.some(warning => warning.startsWith(`${localSource.key} → ${target.key}`)));
    return { ...proposal, previewId: proposal.previewId };
  }));
  assert.deepEqual(await f.workspace(), before);

  const dueOnly = await f.review({ ...scope, issue: versionOf(target), changes: { dueDate: '2026-12-04' } });
  assert.ok(reviewId(dueOnly));
  assert.deepEqual(dueOnly.teamBlockerWarnings ?? [], []);
  const applied = await f.call<SchedulePasteApplyResult>('/schedule/paste-apply', 200, 'POST', { previewId: pasted.previewId });
  assert.deepEqual(applied.warnings, pasted.warnings);
  assert.deepEqual(applied.updated.map(issue => [issue.id, issue.startDate, issue.endDate]), [[target.id, changes.startDate, target.endDate]]);
  assert.deepEqual((await f.workspace()).issues.find(issue => issue.id === source.id), source);
  const reverted = await f.undo(applied.undoId);
  assert.deepEqual(reverted.updated.map(issue => [issue.id, dates(issue)]), [[target.id, dates(target)]]);
});

test('team TSV reviews both proposed dates, and a new or changed hidden handoff invalidates a previously reviewed edit', async t => {
  const f = await fixture(t);
  const source = await f.issue('편집할 선행 티켓', { endDate: '2026-11-23' });
  const target = await f.issue('표 밖의 후행 티켓', { projectId: 'project-neo', startDate: '2026-11-24', endDate: '2026-11-26' });
  const paste = (rows: [Issue, string | null, string | null][]) => f.call<SchedulePastePreview>('/schedule/paste-preview', 200, 'POST', {
    projectId: null,
    text: ['key\tstartDate\tendDate', ...rows.map(([issue, start, end]) => [issue.key, start, end].join('\t'))].join('\n'),
  });
  const sourceOnly = () => paste([[source, source.startDate, '2026-11-24']]);
  const rejectStale = async (previewId: string) => {
    const witnessed = await f.workspace();
    await f.call('/schedule/paste-apply', 409, 'POST', { previewId });
    assert.deepEqual(await f.workspace(), witnessed);
  };

  const originallyUnlinked = await sourceOnly();
  assert.deepEqual(originallyUnlinked.teamBlockerWarnings ?? [], []);
  const blocker = await f.blocker(source, target, otherActor);
  await rejectStale(reviewId(originallyUnlinked));

  const outgoingOnly = await sourceOnly();
  assertHandoffConflict(outgoingOnly, source, target, '2026-11-25');
  assert.deepEqual(outgoingOnly.changes.map(change => change.id), [source.id]);
  const conflicting = await paste([[source, source.startDate, '2026-11-25'], [target, '2026-11-25', target.endDate]]);
  assertHandoffConflict(conflicting, source, target, '2026-11-26');
  const coordinated = await paste([[source, source.startDate, '2026-11-24'], [target, '2026-11-25', target.endDate]]);
  assert.ok(reviewId(coordinated));
  assert.deepEqual(coordinated.teamBlockerWarnings ?? [], []);
  assert.deepEqual(new Set(coordinated.changes.map(change => change.id)), new Set([source.id, target.id]));

  const currentTarget = await f.call<Issue>(`/issues/${target.id}`, 200, 'PATCH', {
    expectedVersion: target.version, startDate: '2026-11-25',
  }, otherActor);
  await rejectStale(reviewId(outgoingOnly));
  const beforeHoliday = await sourceOnly();
  assert.deepEqual(beforeHoliday.teamBlockerWarnings ?? [], []);
  const calendarPath = `/projects/${target.projectId}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-25', isWorking: false, label: '표에 없는 후행 프로젝트 휴무' }],
  }, otherActor);
  await rejectStale(reviewId(beforeHoliday));
  const active = await sourceOnly();
  assertHandoffConflict(active, source, target, '2026-11-26');
  await f.call(`/issues/${source.id}/relations/${blocker.id}?expectedVersion=${blocker.version}`, 200, 'DELETE', undefined, otherActor);
  await rejectStale(reviewId(active));
  assert.deepEqual((await f.workspace()).issues.find(issue => issue.id === target.id), currentTarget);
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
