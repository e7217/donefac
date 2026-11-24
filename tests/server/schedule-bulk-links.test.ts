import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type {
  Dependency, Issue, IssueRelation, Project, ScheduleBlockerLinkPage,
  ScheduleBulkChainInput, ScheduleBulkLinkInput, SchedulePasteApplyResult, SchedulePastePreview, TeamScheduleBlocker, WorkCalendar, WorkspaceSnapshot,
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

function chain(projectId: string, issues: Issue[]): Extract<ScheduleBulkChainInput, { operation?: 'add' }> {
  return { mode: 'chain', projectId, issues: issues.map(reference), type: 'FF', lagDays: 1 };
}

test('mixed ordered chain projects dates for new and existing links and atomically applies, retries and undoes', async t => {
  const f = await fixture(t);
  const first = await f.issue('종료일을 채울 선행', f.project.id, { endDate: null });
  const second = await f.issue('시작일을 채울 후행', f.project.id, { startDate: null, endDate: '2026-11-30' });
  const third = await f.issue('기존 연결 후행', f.project.id, { startDate: '2026-11-30', endDate: '2026-12-01' });
  const outside = await f.issue('선택 밖 후행', f.project.id, { startDate: '2026-11-24', endDate: '2026-11-25' });
  const retained = await f.link(second, third, 'SS', -1);
  const outsideLink = await f.link(first, outside);
  const body: ScheduleBulkChainInput = { ...chain(f.project.id, [first, second, third]), type: 'FS', lagDays: 0, dates: [
    { issue: reference(first), changes: { endDate: '2026-11-25', dueDate: null } },
    { issue: reference(second), changes: { startDate: '2026-11-27' } },
  ] };
  const before = await f.workspace();
  const linkOnly = await f.review({ ...body, dates: [] });
  assert.ok(linkOnly.warnings.some(warning => warning.includes(`${first.key} → ${second.key} · 날짜 미정`)));
  const mixed = await f.review(body);
  assert.ok(mixed.previewId, JSON.stringify(mixed.errors));
  assert.deepEqual(mixed.changes.map(change => [change.id, change.fromStart, change.toStart, change.fromEnd, change.toEnd, change.fromDue, change.toDue]), [
    [first.id, first.startDate, first.startDate, null, '2026-11-25', first.dueDate, null],
    [second.id, null, '2026-11-27', second.endDate, second.endDate, undefined, undefined],
  ]);
  assert.deepEqual(mixed.dependencyChanges?.map(change => [change.predecessorKey, change.successorKey]), [[first.key, second.key]]);
  assert.deepEqual(mixed.retainedDependencies?.map(change => [change.predecessorKey, change.successorKey, change.after]), [
    [second.key, third.key, { type: retained.type, lagDays: retained.lagDays }],
  ]);
  assert.ok(!mixed.warnings.some(warning => warning.includes(`${first.key} → ${second.key}`)));
  assert.ok(mixed.warnings.some(warning => warning.includes(`${first.key} → ${outside.key}`) && warning.includes('2026-11-26')));
  assert.deepEqual(await f.workspace(), before);

  const db = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_mixed_chain_link BEFORE INSERT ON dependencies
      WHEN NEW.predecessor_id='${first.id}' AND NEW.successor_id='${second.id}'
      BEGIN SELECT RAISE(ABORT,'synthetic mixed chain link failure'); END`);
    await f.apply(mixed.previewId, 500);
    assert.deepEqual(await f.workspace(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_undos').get()?.count, 0);
    db.exec('DROP TRIGGER fail_mixed_chain_link');

    const [saved, retried] = await Promise.all([f.apply(mixed.previewId), f.apply(mixed.previewId)]);
    assert.deepEqual(retried, saved);
    assert.equal(saved.dependencyChanges, 1);
    assert.deepEqual(saved.warnings, mixed.warnings);
    assert.deepEqual(saved.updated.map(({ id, startDate, endDate, dueDate }) => [id, startDate, endDate, dueDate]), [
      [first.id, first.startDate, '2026-11-25', null], [second.id, '2026-11-27', second.endDate, second.dueDate],
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_undos').get()?.count, 1);
    const applied = await f.workspace();
    assert.equal(findLink(applied, first, second)?.type, 'FS');
    assert.deepEqual(findLink(applied, second, third), retained);
    assert.deepEqual(findLink(applied, first, outside), outsideLink);
    for (const untouched of [third, outside]) assert.deepEqual(applied.issues.find(issue => issue.id === untouched.id), untouched);

    const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: saved.undoId });
    assert.equal(undo.dependencyChanges, 1);
    assert.deepEqual(undo.updated.map(({ id, startDate, endDate, dueDate }) => [id, startDate, endDate, dueDate]),
      [first, second].map(({ id, startDate, endDate, dueDate }) => [id, startDate, endDate, dueDate]));
    assert.deepEqual((await f.workspace()).dependencies, before.dependencies);
    assert.deepEqual(await f.apply(mixed.previewId), saved);
  } finally { db.close(); }
});

test('mixed common-anchor links review anchor and target drafts, retained missing dates and incoming blockers', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('종료일을 바꿀 공통 선행');
  const first = await f.issue('종료일만 바꿀 후행');
  const second = await f.issue('시작일을 지울 기존 후행');
  const external = await f.issue('외부 차단 선행', 'project-neo', { endDate: '2026-11-25' });
  const retained = await f.link(anchor, second, 'FS');
  await f.call<IssueRelation>(`/issues/${external.id}/relations`, 201, 'POST', { type: 'blocks', direction: 'outgoing', otherIssueId: first.id });
  const body: ScheduleBulkLinkInput = { ...input(anchor, [first, second]), dates: [
    { issue: reference(anchor), changes: { endDate: '2026-11-26' } },
    { issue: reference(first), changes: { endDate: '2026-11-27' } },
    { issue: reference(second), changes: { startDate: null } },
  ] };
  const mixed = await f.review(body);
  assert.ok(mixed.previewId, JSON.stringify(mixed.errors));
  assert.deepEqual(mixed.changes.map(change => change.id), [anchor.id, first.id, second.id]);
  assert.ok(mixed.warnings.some(warning => warning.includes(`${anchor.key} → ${second.key} · 날짜 미정`)));
  assert.ok(mixed.teamBlockerWarnings?.some(warning => warning.includes(`${external.key} → ${first.key}`) && warning.includes('2026-11-26')));
  await f.call(`/issues/${external.id}`, 200, 'PATCH', { expectedVersion: external.version, title: '현 검토에서 참조한 외부 업무가 바뀜' }, 'user-seo');
  const concurrent = await f.workspace();
  const rejected = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId: mixed.previewId });
  assert.match(rejected.error, /프로젝트 간 연결 업무 또는 차단 관계가 변경되었습니다/);
  assert.deepEqual(await f.workspace(), concurrent);

  const fresh = await f.review(body);
  assert.ok(fresh.previewId);
  const applied = await f.apply(fresh.previewId);
  assert.equal(applied.dependencyChanges, 1);
  assert.deepEqual([...applied.warnings].sort(), [...fresh.warnings].sort());
  const saved = await f.workspace();
  assert.deepEqual(findLink(saved, anchor, second), retained);
  assert.equal(findLink(saved, anchor, first)?.type, 'FS');
  const updatedAnchor = applied.updated.find(issue => issue.id === anchor.id)!;
  const updatedSelected = applied.updated.filter(issue => issue.id !== anchor.id);
  const dateOnly = await f.review({ ...input(updatedAnchor, updatedSelected), dates: [
    { issue: reference(updatedAnchor), changes: { endDate: '2026-11-30' } },
  ] });
  assert.ok(dateOnly.previewId);
  assert.deepEqual(dateOnly.dependencyChanges, []);
  assert.equal(dateOnly.retainedDependencies?.length, 2);
  const final = await f.apply(dateOnly.previewId);
  assert.equal(final.dependencyChanges, undefined);
  assert.equal(final.updated[0].endDate, '2026-11-30');
  assert.deepEqual((await f.workspace()).dependencies, saved.dependencies);
});

test('mixed ordered chain rejects unmatched, invalid, stale or cyclic date and relationship proposals without partial writes', async t => {
  const f = await fixture(t);
  const first = await f.issue('첫 번째 선택');
  const second = await f.issue('두 번째 선택');
  const third = await f.issue('세 번째 선택');
  const unrelated = await f.issue('선택하지 않은 업무');
  const foreign = await f.issue('다른 프로젝트의 이름이 표시되면 안 되는 업무', 'project-neo');
  const body = chain(f.project.id, [first, second, third]);
  const date = { issue: reference(first), changes: { endDate: '2026-11-25' } };
  const before = await f.workspace();
  for (const dates of [null, [date, date], [{ ...date, issue: reference(unrelated) }], [{ ...date, issue: reference(foreign) }],
    [{ ...date, issue: { id: first.id, expectedVersion: first.version + 1 } }], [{ ...date, changes: {} }],
    [{ ...date, changes: { startDate: '2026-02-30' } }]]) {
    await f.call(previewPath, 400, 'POST', { ...body, dates });
  }
  const foreignReview = await f.review({ ...chain(f.project.id, [first, foreign, third]), dates: [{ ...date, issue: reference(foreign) }] });
  assert.equal(foreignReview.previewId, null);
  assert.deepEqual(foreignReview.errors.map(error => error.issueId), [foreign.id]);
  assert.ok(!JSON.stringify(foreignReview).includes(foreign.title));
  const badRange = await f.review({ ...body, dates: [{ ...date, changes: { startDate: '2026-11-27' } }] });
  assert.equal(badRange.previewId, null);
  assert.ok(badRange.errors.some(error => error.issueId === first.id && /시작일|종료일/.test(error.message)));
  assert.deepEqual(await f.workspace(), before);

  const candidate = { ...body, dates: [date, { issue: reference(second), changes: { endDate: '2026-11-27' } }] };
  const ready = await f.review(candidate);
  assert.ok(ready.previewId);
  const updated = await f.call<Issue>(`/issues/${second.id}`, 200, 'PATCH', { expectedVersion: second.version, endDate: '2026-11-24' }, 'user-seo');
  const concurrent = await f.workspace();
  await f.apply(ready.previewId, 409);
  const stale = await f.review(candidate);
  assert.equal(stale.previewId, null);
  assert.deepEqual(stale.errors.map(error => error.issueId), [second.id]);
  assert.deepEqual(await f.workspace(), concurrent);

  await f.link(third, first);
  const topology = await f.workspace();
  const cyclic = await f.review({ ...chain(f.project.id, [first, updated, third]), dates: [date] });
  assert.equal(cyclic.previewId, null);
  assert.ok(cyclic.errors.some(error => /순환/u.test(error.message)));
  assert.deepEqual(await f.workspace(), topology);
});

test('bulk chain follow-up keeps actual input dates fixed and guards unchanged downstream links before one reversible write', async t => {
  const f = await fixture(t);
  const first = await f.issue('날짜를 직접 바꾼 선행');
  const second = await f.issue('마감일만 직접 바꾼 후행');
  const third = await f.issue('기존 연결의 후행');
  const hidden = await f.issue('선택 범위 밖의 후행');
  const stable = await f.issue('일정이 충분히 늦은 후행', f.project.id, { startDate: '2026-12-10', endDate: '2026-12-11' });
  const incoming = await f.issue('새로 연결할 외부 선행');
  const retained = await f.link(second, third);
  const hiddenLink = await f.link(third, hidden);
  await f.link(hidden, stable);
  const body: ScheduleBulkChainInput = { ...chain(f.project.id, [first, second, third]), type: 'FS', lagDays: 0, dates: [
    { issue: reference(first), changes: { endDate: '2026-11-24' } },
    { issue: reference(second), changes: { startDate: second.startDate, dueDate: '2026-11-25' } },
  ] };
  for (const rescheduleSuccessors of ['true', null]) {
    await f.call(previewPath, 400, 'POST', { ...body, rescheduleSuccessors });
  }
  const before = await f.workspace();
  const ordinary = await f.review(body);
  const disabled = await f.review({ ...body, rescheduleSuccessors: false });
  assert.ok(ordinary.previewId);
  assert.equal(disabled.followUpIssueIds, undefined);
  assert.deepEqual(disabled.changes, ordinary.changes);
  assert.deepEqual(disabled.warnings, ordinary.warnings);

  const optIn = { ...body, rescheduleSuccessors: true };
  const preview = await f.review(optIn);
  const expected = new Map([
    [first.id, [first.startDate, '2026-11-24', first.dueDate]],
    [second.id, ['2026-11-25', '2026-11-26', '2026-11-25']],
    [third.id, ['2026-11-27', '2026-11-30', third.dueDate]],
    [hidden.id, ['2026-12-01', '2026-12-02', hidden.dueDate]],
  ]);
  const original = new Map(before.issues.map(issue => [issue.id, issue]));
  const dateRows = ({ changes }: SchedulePastePreview) => new Map(changes.map(({ id, toStart, toEnd, toDue }) =>
    [id, [toStart, toEnd, toDue === undefined ? original.get(id)?.dueDate : toDue]]));
  assert.ok(preview.previewId, JSON.stringify(preview.errors));
  assert.deepEqual(dateRows(preview), expected);
  assert.deepEqual(new Set(preview.followUpIssueIds), new Set([second.id, third.id, hidden.id]));
  assert.equal(preview.dependencyChanges?.length, 1);
  assert.deepEqual(preview.retainedDependencies?.map(item => item.after), [{ type: 'FS', lagDays: 0 }]);
  assert.ok(preview.warnings.some(warning => warning.includes(second.key) && warning.includes('목표 마감일')));
  assert.ok(!preview.warnings.some(warning => warning.includes(`${first.key} → ${second.key}`)));
  assert.deepEqual(await f.workspace(), before);

  await f.link(incoming, stable, 'SS');
  const concurrent = await f.workspace();
  await f.apply(preview.previewId, 409);
  assert.deepEqual(await f.workspace(), concurrent);
  const fresh = await f.review(optIn);
  assert.ok(fresh.previewId, JSON.stringify(fresh.errors));
  assert.deepEqual(dateRows(fresh), expected);

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_follow_up_chain_link BEFORE INSERT ON dependencies
      WHEN NEW.predecessor_id='${first.id}' AND NEW.successor_id='${second.id}'
      BEGIN SELECT RAISE(ABORT,'synthetic cascade link failure'); END`);
    await f.apply(fresh.previewId, 500);
    assert.deepEqual(await f.workspace(), concurrent);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    database.exec('DROP TRIGGER fail_follow_up_chain_link');

    const dateValues = ({ id, startDate, endDate, dueDate }: Issue) => [id, [startDate, endDate, dueDate]] as const;
    const applied = await f.apply(fresh.previewId);
    assert.equal(applied.dependencyChanges, 1);
    assert.deepEqual(new Map(applied.updated.map(dateValues)), expected);
    assert.deepEqual(applied.warnings, fresh.warnings);
    assert.deepEqual(await f.apply(fresh.previewId), applied);
    const changed = await f.workspace();
    assert.deepEqual(findLink(changed, second, third), retained);
    assert.deepEqual(findLink(changed, third, hidden), hiddenLink);
    assert.deepEqual(changed.issues.find(issue => issue.id === stable.id), stable);

    const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: applied.undoId });
    assert.equal(undo.dependencyChanges, 1);
    assert.deepEqual(new Map(undo.updated.map(dateValues)), new Map([first, second, third, hidden].map(dateValues)));
    assert.deepEqual((await f.workspace()).dependencies, concurrent.dependencies);
  } finally { database.close(); }
});

test('common-anchor follow-up uses both newly linked predecessors and blocks incomplete or conflicting fixed dates', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('공통 후행 업무');
  const first = await f.issue('이른 선행 업무', f.project.id, { startDate: '2026-11-23', endDate: '2026-11-24' });
  const second = await f.issue('늦은 선행 업무', f.project.id, { startDate: '2026-11-25', endDate: '2026-11-26' });
  const hidden = await f.issue('기간이 불완전한 하위 후행', f.project.id, { endDate: null });
  await f.link(anchor, hidden);
  const payload = { ...input(anchor, [first, second], 'successor'), lagDays: 0, rescheduleSuccessors: true };
  const before = await f.workspace();
  const missing = await f.review(payload);
  assert.equal(missing.previewId, null);
  assert.ok(missing.errors.some(({ message }) => message.includes(hidden.key) && message.includes('기간을 계산하지 않았습니다.')));
  assert.deepEqual(await f.workspace(), before);

  const available = await f.call<Issue>(`/issues/${hidden.id}`, 200, 'PATCH', { expectedVersion: hidden.version, endDate: '2026-11-20' });
  const known = await f.workspace();
  const fixed = await f.review({ ...payload, dates: [{ issue: reference(anchor), changes: { endDate: '2026-11-25' } }] });
  assert.equal(fixed.previewId, null);
  assert.ok(fixed.errors.some(({ message }) => message.includes(anchor.key) && message.includes('입력한 시작일')));
  assert.deepEqual(await f.workspace(), known);

  const preview = await f.review(payload);
  assert.ok(preview.previewId, JSON.stringify(preview.errors));
  assert.deepEqual(new Set(preview.followUpIssueIds), new Set([anchor.id, available.id]));
  const applied = await f.apply(preview.previewId);
  assert.equal(applied.dependencyChanges, 2);
  assert.deepEqual(new Map(applied.updated.map(({ id, startDate, endDate }) => [id, [startDate, endDate]])), new Map([
    [anchor.id, ['2026-11-27', '2026-11-30']], [available.id, ['2026-12-01', '2026-12-02']],
  ]));
});

test('bulk common-anchor update preserves omitted values, ignores reverse pairs and rechecks formerly missing links before apply', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('공통 기준 업무');
  const changed = await f.issue('연결 유형을 변경할 업무');
  const retained = await f.issue('이미 요청한 유형인 업무');
  const missing = await f.issue('뒤늦게 연결할 업무');
  const reversed = await f.issue('반대 방향의 업무');
  const old = await f.link(anchor, changed, 'FS', -2);
  const unchanged = await f.link(anchor, retained, 'SS', 3);
  const opposite = await f.link(reversed, anchor, 'FF', 4);
  const target = { projectId: anchor.projectId, anchor: reference(anchor),
    issues: [changed, retained, missing, reversed].map(reference), direction: 'predecessor' as const };
  const body = { ...target, operation: 'update', type: 'SS' } satisfies ScheduleBulkLinkInput;
  const before = await f.workspace();
  for (const invalid of [
    { ...target, operation: 'update' }, { ...body, type: 'bad' }, { ...body, lagDays: 3651 }, { ...body, lagDays: null },
    { ...target, operation: 'add', type: 'FS' }, { ...target, operation: 'remove', type: 'FS' },
    { ...target, operation: 'remove', lagDays: 0 }, { ...body, operation: null }, { ...body, mode: 'unknown' },
  ]) await f.call(previewPath, 400, 'POST', invalid);

  const review = await f.review(body);
  assert.ok(review.previewId, JSON.stringify(review.errors));
  assert.deepEqual(review.dependencyChanges?.map(({ successorKey, before, after }) => [successorKey, before, after]),
    [[changed.key, { type: 'FS', lagDays: -2 }, { type: 'SS', lagDays: -2 }]]);
  assert.deepEqual(review.retainedDependencies?.map(({ successorKey, before, after }) => [successorKey, before, after]),
    [[retained.key, { type: 'SS', lagDays: 3 }, { type: 'SS', lagDays: 3 }]]);
  assert.equal(review.unchanged, 1);
  assert.deepEqual(review.missingDependencies, [missing, reversed].map((issue, index) => ({
    line: index + 3, predecessorKey: anchor.key, predecessorTitle: anchor.title, successorKey: issue.key, successorTitle: issue.title,
  })));
  assert.deepEqual(await f.workspace(), before);
  const late = await f.link(anchor, missing, 'SF', -1);
  const concurrent = await f.workspace();
  await f.apply(review.previewId, 409);
  assert.deepEqual(await f.workspace(), concurrent);

  const fresh = await f.review(body);
  assert.ok(fresh.previewId);
  assert.deepEqual(fresh.missingDependencies?.map(({ successorKey }) => successorKey), [reversed.key]);
  const [saved, retry] = await Promise.all([f.apply(fresh.previewId), f.apply(fresh.previewId)]);
  assert.deepEqual(retry, saved);
  assert.equal(saved.dependencyChanges, 2);
  assert.deepEqual(saved.updated, []);
  assert.deepEqual(saved.warnings, fresh.warnings);
  const applied = await f.workspace();
  const updatedOld = findLink(applied, anchor, changed)!;
  const updatedLate = findLink(applied, anchor, missing)!;
  assert.deepEqual(updatedOld, { ...old, type: 'SS', version: updatedOld.version });
  assert.deepEqual(updatedLate, { ...late, type: 'SS', version: updatedLate.version });
  assert.ok(updatedOld.version! > old.version! && updatedLate.version! > late.version!);
  assert.deepEqual(findLink(applied, anchor, retained), unchanged);
  assert.deepEqual(findLink(applied, reversed, anchor), opposite);
  assert.equal(findLink(applied, anchor, reversed), undefined);

  const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: saved.undoId });
  assert.equal(undo.dependencyChanges, 2);
  const restored = await f.workspace();
  const restoredOld = findLink(restored, anchor, changed)!;
  const restoredLate = findLink(restored, anchor, missing)!;
  assert.deepEqual(restoredOld, { ...old, version: restoredOld.version });
  assert.deepEqual(restoredLate, { ...late, version: restoredLate.version });
  assert.ok(restoredOld.version! > updatedOld.version! && restoredLate.version! > updatedLate.version!);
  assert.deepEqual(findLink(restored, anchor, retained), unchanged);
  assert.deepEqual(findLink(restored, reversed, anchor), opposite);
});

test('ordered bulk links review lag-only changes and remove only existing adjacent pairs in one reversible write', async t => {
  const f = await fixture(t);
  const first = await f.issue('초안과 함께 연결을 해제할 선행');
  const second = await f.issue('첫 번째 후행', f.project.id, { startDate: '2026-11-23', endDate: '2026-11-24' });
  const third = await f.issue('두 번째 후행', f.project.id, { startDate: '2026-11-25', endDate: '2026-11-26' });
  const missing = await f.issue('연속 연결이 없는 업무');
  const outside = await f.issue('검토 범위 밖 연결', f.project.id, { startDate: '2026-11-30', endDate: '2026-12-01' });
  const firstLink = await f.link(first, second, 'FS');
  const secondLink = await f.link(second, third, 'FF');
  const outsideLink = await f.link(second, outside);
  const selection = { mode: 'chain' as const, projectId: f.project.id, issues: [first, second, third, missing].map(reference) };
  const lagReview = await f.review({ ...selection, operation: 'update', lagDays: 1, rescheduleSuccessors: true });
  assert.ok(lagReview.previewId, JSON.stringify(lagReview.errors));
  assert.deepEqual(lagReview.dependencyChanges?.map(({ before, after }) => [before, after]), [
    [{ type: 'FS', lagDays: 0 }, { type: 'FS', lagDays: 1 }],
    [{ type: 'FF', lagDays: 0 }, { type: 'FF', lagDays: 1 }],
  ]);
  assert.deepEqual(lagReview.followUpIssueIds, [second.id]);
  assert.deepEqual(lagReview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [[second.id, '2026-11-24', '2026-11-25']]);
  assert.deepEqual(lagReview.missingDependencies?.map(({ predecessorKey, successorKey }) => [predecessorKey, successorKey]),
    [[third.key, missing.key]]);

  const before = await f.workspace();
  const removal = await f.review({ ...selection, operation: 'remove', rescheduleSuccessors: true,
    dates: [{ issue: reference(first), changes: { endDate: '2026-11-27' } }],
  } satisfies ScheduleBulkChainInput);
  assert.ok(removal.previewId, JSON.stringify(removal.errors));
  assert.deepEqual(removal.dependencyChanges?.map(({ predecessorKey, successorKey, before, after }) => [predecessorKey, successorKey, before, after]), [
    [first.key, second.key, { type: 'FS', lagDays: 0 }, null], [second.key, third.key, { type: 'FF', lagDays: 0 }, null],
  ]);
  assert.deepEqual(removal.missingDependencies, lagReview.missingDependencies);
  assert.deepEqual(removal.retainedDependencies, []);
  assert.equal(removal.followUpIssueIds, undefined);
  assert.deepEqual(removal.changes.map(({ id }) => id), [first.id]);
  assert.deepEqual(removal.warnings, []);
  assert.deepEqual(await f.workspace(), before);

  const saved = await f.apply(removal.previewId);
  assert.equal(saved.dependencyChanges, 2);
  assert.deepEqual(saved.updated.map(({ id, endDate }) => [id, endDate]), [[first.id, '2026-11-27']]);
  const applied = await f.workspace();
  assert.equal(findLink(applied, first, second), undefined);
  assert.equal(findLink(applied, second, third), undefined);
  assert.deepEqual(findLink(applied, second, outside), outsideLink);
  const absent = await f.review({ ...selection, issues: [saved.updated[0], second, third, missing].map(reference), operation: 'remove' });
  assert.equal(absent.previewId, null);
  assert.equal(absent.missingDependencies?.length, 3);
  assert.deepEqual(absent.dependencyChanges, []);

  const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: saved.undoId });
  assert.equal(undo.dependencyChanges, 2);
  assert.deepEqual(undo.updated.map(({ id, endDate }) => [id, endDate]), [[first.id, first.endDate]]);
  const restored = await f.workspace();
  for (const [left, right, link] of [[first, second, firstLink], [second, third, secondLink]] as const) {
    const restoredLink = findLink(restored, left, right)!;
    assert.deepEqual(restoredLink, { ...link, version: restoredLink.version });
    assert.ok(restoredLink.version! > link.version!);
  }
  assert.deepEqual(findLink(restored, second, outside), outsideLink);
});

test('ordered bulk chain previews only adjacent pairs and undoes its new links without changing dates or retained rules', async t => {
  const f = await fixture(t);
  const second = await f.issue('두 번째 연결 업무');
  const fourth = await f.issue('마지막 연결 업무', f.project.id, { endDate: null });
  const first = await f.issue('첫 번째 연결 업무');
  const third = await f.issue('세 번째 연결 업무');
  const retained = await f.link(second, third, 'SS', -2);
  const before = await f.workspace();
  const body = chain(f.project.id, [first, second, third, fourth]);
  const proposal = await f.review(body);
  assert.ok(proposal.previewId, JSON.stringify(proposal.errors));
  assert.deepEqual(proposal.changes, []);
  assert.deepEqual(proposal.errors, []);
  assert.equal(proposal.unchanged, 1);
  assert.deepEqual(proposal.dependencyChanges?.map(change => [change.predecessorKey, change.successorKey, change.before, change.after]), [
    [first.key, second.key, null, { type: 'FF', lagDays: 1 }],
    [third.key, fourth.key, null, { type: 'FF', lagDays: 1 }],
  ]);
  assert.deepEqual(proposal.retainedDependencies?.map(change => [change.predecessorKey, change.successorKey, change.before, change.after]), [
    [second.key, third.key, { type: 'SS', lagDays: -2 }, { type: 'SS', lagDays: -2 }],
  ]);
  assert.ok(proposal.warnings.some(warning => warning.includes(`${third.key} → ${fourth.key}`) && warning.includes('날짜 미정')));
  assert.deepEqual(await f.workspace(), before);

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_last_chain_edge BEFORE INSERT ON dependencies
      WHEN NEW.successor_id='${fourth.id}' BEGIN SELECT RAISE(ABORT,'synthetic final chain edge failure'); END`);
    try { await f.apply(proposal.previewId, 500); }
    finally { database.exec('DROP TRIGGER fail_last_chain_edge'); }
    assert.deepEqual(await f.workspace(), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);

    const applied = await f.apply(proposal.previewId);
    assert.equal(applied.dependencyChanges, 2);
    assert.deepEqual(applied.updated, []);
    assert.deepEqual(await f.apply(proposal.previewId), applied);
    const changed = await f.workspace();
    assert.deepEqual(changed.issues, before.issues);
    assert.deepEqual(findLink(changed, second, third), retained);
    assert.equal(findLink(changed, first, third), undefined);
    assert.equal(findLink(changed, first, fourth), undefined);
    assert.equal(findLink(changed, first, second)?.type, 'FF');
    assert.equal(findLink(changed, third, fourth)?.lagDays, 1);
    assert.equal((await f.review(body)).previewId, null);

    const undo = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: applied.undoId });
    assert.equal(undo.dependencyChanges, 2);
    assert.deepEqual(undo.updated, []);
    const restored = await f.workspace();
    assert.deepEqual(restored.issues, before.issues);
    assert.deepEqual(restored.dependencies, before.dependencies);
  } finally { database.close(); }
});

test('ordered bulk chain rejects invalid scope, stale members and a cycle that needs more than one new edge', async t => {
  const f = await fixture(t);
  const first = await f.issue('첫 번째');
  const second = await f.issue('두 번째');
  const third = await f.issue('세 번째');
  const outsideFrom = await f.issue('기존 연결의 시작');
  const outsideTo = await f.issue('기존 연결의 끝');
  const foreign = await f.issue('다른 프로젝트의 이름은 노출하지 않음', 'project-neo');
  await f.link(third, outsideFrom);
  await f.link(outsideTo, first);
  const body = chain(f.project.id, [first, second, third]);
  for (const invalid of [
    { ...body, mode: 'CHAIN' }, { ...body, issues: [reference(first)] },
    { ...body, issues: [reference(first), reference(second), reference(first)] },
    { ...body, anchor: reference(first), direction: 'predecessor' },
    { ...body, lagDays: 0.5 }, { ...body, type: 'invalid' },
  ]) await f.call(previewPath, 400, 'POST', invalid);
  await f.call(previewPath, 404, 'POST', { ...body, projectId: 'missing' });

  const foreignReview = await f.review(chain(f.project.id, [first, foreign, third]));
  assert.equal(foreignReview.previewId, null);
  assert.deepEqual(foreignReview.errors.map(error => error.issueId), [foreign.id]);
  assert.ok(!JSON.stringify(foreignReview).includes(foreign.title));
  const staleReview = await f.review({ ...body, issues: [reference(first), { id: second.id, expectedVersion: second.version + 1 }, reference(third)] });
  assert.equal(staleReview.previewId, null);
  assert.deepEqual(staleReview.errors.map(error => error.issueId), [second.id]);

  const reviewed = await f.review(body);
  assert.ok(reviewed.previewId);
  const concurrent = await f.call<Issue>(`/issues/${second.id}`, 200, 'PATCH', {
    expectedVersion: second.version, title: '두 번째를 다른 작업자가 변경',
  }, 'user-seo');
  const updated = await f.workspace();
  await f.apply(reviewed.previewId, 409);
  assert.deepEqual(await f.workspace(), updated);

  const current = chain(f.project.id, [first, concurrent, third]);
  const beforeCyclePreview = await f.review(current);
  assert.ok(beforeCyclePreview.previewId);
  await f.link(outsideFrom, outsideTo);
  const topology = await f.workspace();
  const rejected = await f.call<{ error: string }>(applyPath, 409, 'POST', { previewId: beforeCyclePreview.previewId });
  assert.match(rejected.error, /순환/u);
  assert.ok((await f.review(chain(f.project.id, [first, concurrent]))).previewId);
  assert.ok((await f.review(chain(f.project.id, [concurrent, third]))).previewId);
  const cyclic = await f.review(current);
  assert.equal(cyclic.previewId, null);
  assert.ok(cyclic.errors.some(error => /순환/u.test(error.message)));
  assert.deepEqual(await f.workspace(), topology);

  // The original request shape still makes each selected issue follow one anchor.
  const legacy = await f.review(input(first, [concurrent, third], 'successor'));
  assert.ok(legacy.previewId);
  assert.deepEqual(legacy.dependencyChanges?.map(change => [change.predecessorKey, change.successorKey]), [
    [concurrent.key, first.key], [third.key, first.key],
  ]);
  assert.equal((await f.apply(legacy.previewId)).dependencyChanges, 2);
});

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

const teamBlockerReference = ({ id, version }: IssueRelation, projectId: string) => ({ id, version, projectId });

test('team blocker batch uses each calendar and atomically applies and undoes new links across projects', async t => {
  const f = await fixture(t);
  const blockers = blockerRoutes(f);
  const secondProject = await f.call<Project>('/projects', 201, 'POST', { key: 'BLKTWO', name: '두 번째 차단 검토' });
  const source = await f.issue('첫 프로젝트 선행');
  const target = await f.issue('첫 프로젝트 후행');
  const retained = await f.issue('첫 프로젝트 기존 연결');
  const otherSource = await f.issue('둘째 프로젝트 선행', secondProject.id);
  const otherTarget = await f.issue('둘째 프로젝트 후행', secondProject.id);
  const first = await blockers.add(source, target);
  const existing = await blockers.add(source, retained);
  const last = await blockers.add(otherSource, otherTarget);
  const existingLink = await f.link(source, retained, 'SS', -2);
  const calendarPath = `/projects/${secondProject.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { ...calendar, expectedVersion: calendar.version,
    exceptions: [...calendar.exceptions, { date: '2026-11-23', isWorking: false, label: '합성 휴무' }],
  });

  const before = await f.workspace();
  const beforeRelations = await Promise.all([blockers.relations(source), blockers.relations(otherSource)]);
  const preview = await f.call<SchedulePastePreview>(`${blockerPath}/preview`, 200, 'POST', {
    projectId: null, relations: [teamBlockerReference(first, f.project.id), teamBlockerReference(existing, f.project.id),
      teamBlockerReference(last, secondProject.id)],
  });
  assert.ok(preview.previewId, JSON.stringify(preview.errors));
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.projectIds, [f.project.id, secondProject.id].sort());
  assert.deepEqual(preview.dependencyChanges?.map(change => [change.line, change.projectId, change.before, change.after]), [
    [1, f.project.id, null, { type: 'FS', lagDays: 0 }], [3, secondProject.id, null, { type: 'FS', lagDays: 0 }],
  ]);
  assert.deepEqual(preview.retainedDependencies?.map(change => [change.line, change.projectId, change.before, change.after]), [
    [2, f.project.id, { type: 'SS', lagDays: -2 }, { type: 'SS', lagDays: -2 }],
  ]);
  assert.equal(preview.unchanged, 1);
  assert.ok(preview.warnings.some(warning => warning.includes(`${source.key} → ${target.key}`) && warning.includes('2026-11-23')));
  assert.ok(preview.warnings.some(warning => warning.includes(`${otherSource.key} → ${otherTarget.key}`) && warning.includes('2026-11-24')));
  await blockers.apply(preview.previewId, 409, 'user-seo');

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_second_project_blocker BEFORE INSERT ON dependencies
      WHEN NEW.successor_id='${otherTarget.id}' BEGIN SELECT RAISE(ABORT,'synthetic second project blocker failure'); END`);
    await blockers.apply(preview.previewId, 500);
    assert.deepEqual(await f.workspace(), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 0);
    database.exec('DROP TRIGGER fail_second_project_blocker');

    const applied = await blockers.apply(preview.previewId);
    assert.deepEqual(applied.updated, []);
    assert.equal(applied.dependencyChanges, 2);
    assert.deepEqual(applied.warnings, preview.warnings);
    assert.deepEqual(await blockers.apply(preview.previewId), applied);
    assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_undos').get()?.count, 1);
    const current = await f.workspace();
    assert.deepEqual(current.issues, before.issues);
    assert.deepEqual(await Promise.all([blockers.relations(source), blockers.relations(otherSource)]), beforeRelations);
    assert.deepEqual(findLink(current, source, retained), existingLink);
    assert.equal(findLink(current, source, target)?.type, 'FS');
    assert.equal(findLink(current, otherSource, otherTarget)?.type, 'FS');

    const undone = await f.call<SchedulePasteApplyResult>(undoPath, 200, 'POST', { undoId: applied.undoId });
    assert.equal(undone.dependencyChanges, 2);
    const restored = await f.workspace();
    assert.deepEqual(restored.dependencies, before.dependencies);
    assert.deepEqual(restored.issues, before.issues);
    assert.deepEqual(await Promise.all([blockers.relations(source), blockers.relations(otherSource)]), beforeRelations);
  } finally { database.close(); }
});

test('team blocker listing pages only local pairs and a preview refuses forged project ownership or drift', async t => {
  const f = await fixture(t);
  const blockers = blockerRoutes(f);
  const second = await f.call<Project>('/projects', 201, 'POST', { key: 'ZIPPAIR', name: '다른 차단 관계 프로젝트' });
  const source = await f.issue('팀 차단 관계 선행');
  const firstProjectPairs: IssueRelation[] = [];
  for (let index = 0; index < 25; index++) {
    firstProjectPairs.push(await blockers.add(source, await f.issue(`팀 차단 관계 후행 ${index + 1}`)));
  }
  const otherSource = await f.issue('둘째 팀 차단 관계 선행', second.id);
  const otherTarget = await f.issue('둘째 팀 차단 관계 후행', second.id);
  const secondProjectPair = await blockers.add(otherSource, otherTarget);
  const cross = await blockers.add(source, otherTarget);
  const nonBlocker = await blockers.add(otherTarget, otherSource, 'related');
  for (const offset of [0, 25, 50]) {
    const page = await f.call<ScheduleBlockerLinkPage>(`${blockerPath}?scope=team&offset=${offset}`);
    assert.equal(page.total, 26);
    assert.equal(page.offset, offset);
    assert.deepEqual(page.items.map(row => [row.id, row.projectId]), [
      ...firstProjectPairs.map(row => [row.id, f.project.id]), [secondProjectPair.id, second.id],
    ].slice(offset, offset + 25));
  }
  for (const query of ['scope=unknown', 'scope=team&scope=team', 'scope=team&offset=-1', 'scope=team&limit=3',
    `scope=team&projectId=${f.project.id}`, 'offset=0']) await f.call(`${blockerPath}?${query}`, 400);
  const accepted = teamBlockerReference(firstProjectPairs[0], f.project.id);
  const secondRef = teamBlockerReference(secondProjectPair, second.id);
  const preview = (relations: unknown[]) => f.call<SchedulePastePreview>(`${blockerPath}/preview`, 200, 'POST', {
    projectId: null, relations,
  });
  const before = await f.workspace();
  for (const malformed of [[], [accepted, { ...accepted, projectId: second.id }], [accepted, { ...secondRef, projectId: null }],
    [accepted, { id: secondRef.id, version: secondRef.version }], [accepted, { ...secondRef, version: 0 }]]) {
    await f.call(`${blockerPath}/preview`, 400, 'POST', { projectId: null, relations: malformed });
  }
  await f.call(`${blockerPath}/preview`, 400, 'POST', { projectId: f.project.id, relations: [accepted] });
  for (const invalid of [teamBlockerReference(cross, second.id), teamBlockerReference(nonBlocker, second.id),
    { ...secondRef, projectId: f.project.id }, { ...secondRef, projectId: 'unknown-project' }, { ...secondRef, version: secondRef.version + 1 }]) {
    const relations = invalid.id === secondRef.id ? [accepted, invalid] : [accepted, secondRef, invalid];
    const rejected = await preview(relations);
    assert.equal(rejected.previewId, null);
    assert.deepEqual(rejected.errors.map(error => error.line), [relations.length]);
  }
  assert.deepEqual(await f.workspace(), before);

  const earlierReview = await preview([accepted, secondRef]);
  assert.ok(earlierReview.previewId, JSON.stringify(earlierReview.errors));
  const calendarPath = `/projects/${second.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath);
  await f.call(calendarPath, 200, 'PATCH', { ...calendar, expectedVersion: calendar.version, name: '수정한 팀 달력' });
  const afterCalendar = await f.workspace();
  await blockers.apply(earlierReview.previewId, 409);
  assert.deepEqual(await f.workspace(), afterCalendar);

  const reviewed = await preview([accepted, secondRef]);
  assert.ok(reviewed.previewId, JSON.stringify(reviewed.errors));
  const path = `/issues/${otherSource.id}/project-move`;
  const move = { expectedVersion: otherSource.version, projectId: f.project.id, includeConnected: false, mappings: [] };
  const transfer = await f.call<IssueProjectMovePreview>(`${path}/preview`, 200, 'POST', move);
  assert.ok(transfer.token, JSON.stringify(transfer.blockers));
  const moved = await f.call<IssueProjectMoveResult>(`${path}/apply`, 200, 'POST', { ...move, token: transfer.token });
  assert.equal(moved.issues[0].projectId, f.project.id);
  const afterMove = await f.workspace();
  await blockers.apply(reviewed.previewId, 409);
  assert.deepEqual(await f.workspace(), afterMove);
  assert.equal((await preview([accepted, secondRef])).previewId, null);
});

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
