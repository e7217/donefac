import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { Dependency, Issue, Project, ProjectWorkflow, SchedulePasteApplyResult, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const actor = 'user-min';
const otherActor = 'user-seo';
const previewPath = '/schedule/manual-preview';
const applyPath = '/schedule/manual-apply';
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const shift = (issues: Issue[], workingDays = false) => ({ issueIds: issues.map(issue => issue.id), days: 1, workingDays });
const chooseDate = (issue: Issue, date: string | null) => ({ id: issue.id, expectedVersion: issue.version, startDate: date, endDate: date });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-manual-schedule-'));
  async function start() {
    const service = createApp({ dataDir: dir, outboundWorker: false, deadlineReminderWorker: false });
    const server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      async close() {
        server.closeAllConnections();
        try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { service.close(); }
      },
    };
  }
  let server = await start();
  t.after(async () => {
    try { await server.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, status: number, method = 'GET', body?: unknown, actorId = actor) {
    const response = await fetch(server.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'SHIFT', name: '수동 일정 검토' });
  const state = () => call<WorkspaceSnapshot>('/workspace', 200);
  const readPreview = (body: unknown, status = 200) => call<SchedulePreview>(previewPath, status, 'POST', body);
  return {
    call, project, state, readPreview,
    async restart() { await server.close(); server = await start(); },
    issue: (title: string, schedule: Partial<ReturnType<typeof dates>> = {}, projectId = project.id) => call<Issue>('/issues', 201, 'POST', {
      title, projectId, startDate: '2026-11-20', endDate: '2026-11-20', dueDate: '2026-11-26', ...schedule,
    }),
    edit: (issue: Issue, changes: Partial<Issue>) => call<Issue>(`/issues/${issue.id}`, 200, 'PATCH', { expectedVersion: issue.version, ...changes }, otherActor),
    link: (predecessor: Issue, successor: Issue) => call<Dependency>('/dependencies', 201, 'POST', {
      predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
    }),
    async review(body: unknown) {
      const proposal = await readPreview(body);
      assert.ok(proposal.previewId, JSON.stringify(proposal));
      assert.ok(proposal.expiresAt && Number.isFinite(Date.parse(proposal.expiresAt)));
      return { ...proposal, previewId: proposal.previewId };
    },
    apply: (previewId: string, status = 200, actorId = actor) => call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
  };
}

test('manual shift rejects a changed unselected predecessor or incident dependency before writing', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('먼저 끝날 업무', { startDate: '2026-11-16', endDate: '2026-11-17' });
  const successor = await f.issue('선택한 후행 업무');
  const link = await f.link(predecessor, successor);
  const before = await f.state();
  const old = await f.review(shift([successor], true));
  assert.deepEqual(old.warnings, []);
  assert.equal(old.changes[0].toStart, '2026-11-23');
  assert.deepEqual(await f.state(), before);

  await f.edit(predecessor, { endDate: '2026-11-24' });
  const movedPredecessor = await f.state();
  await f.apply(old.previewId, 409);
  assert.deepEqual(await f.state(), movedPredecessor);

  const updated = await f.review(shift([successor], true));
  assert.ok(updated.warnings.some(warning => warning.includes(`${predecessor.key} → ${successor.key}`) && warning.includes('2026-11-25')));
  await f.call(`/dependencies/${link.id}`, 200, 'PATCH', { expectedVersion: link.version ?? 1, lagDays: 2 }, otherActor);
  const changedLink = await f.state();
  await f.apply(updated.previewId, 409);
  assert.deepEqual(await f.state(), changedLink);

  const latest = await f.review(shift([successor], true));
  assert.ok(latest.warnings.some(warning => warning.includes('2026-11-27')));
  const applied = await f.apply(latest.previewId);
  assert.deepEqual(applied.warnings, latest.warnings);
  assert.deepEqual(applied.updated.map(issue => [issue.id, issue.version, issue.startDate]), [[successor.id, successor.version + 1, '2026-11-23']]);
});

test('manual shifts use each project calendar and guard changed calendar before applying a batch', async t => {
  const f = await fixture(t);
  const secondProject = await f.call<Project>('/projects', 201, 'POST', { key: 'SHIFT2', name: '둘째 일정 달력' });
  const primary = await f.issue('첫 프로젝트 이동');
  const secondary = await f.issue('둘째 프로젝트 이동', {}, secondProject.id);
  const calendarPath = `/projects/${secondProject.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath, 200);
  const saturday = { date: '2026-11-21', isWorking: true, label: '토요일 근무' };
  const withSaturday = await f.call<WorkCalendar>(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version, exceptions: [saturday] });
  const stale = await f.review(shift([primary, secondary], true));
  assert.deepEqual(new Map(stale.changes.map(change => [change.id, [change.toStart, change.toEnd]])), new Map([
    [primary.id, ['2026-11-23', '2026-11-23']], [secondary.id, ['2026-11-21', '2026-11-21']],
  ]));
  const holiday = { date: '2026-11-23', isWorking: false, label: '월요일 휴무' };
  await f.call<WorkCalendar>(calendarPath, 200, 'PATCH', { expectedVersion: withSaturday.version, exceptions: [holiday] }, otherActor);
  const before = await f.state();
  await f.apply(stale.previewId, 409);
  assert.deepEqual(await f.state(), before);

  const current = await f.review(shift([primary, secondary], true));
  const applied = await f.apply(current.previewId);
  assert.deepEqual(new Map(applied.updated.map(issue => [issue.id, dates(issue)])), new Map([
    [primary.id, { ...dates(primary), startDate: '2026-11-23', endDate: '2026-11-23' }],
    [secondary.id, { ...dates(secondary), startDate: '2026-11-24', endDate: '2026-11-24' }],
  ]));
});

test('absolute manual dates exclude no-ops and replay one actor-owned mutation after restart', async t => {
  const f = await fixture(t);
  const selected = await f.issue('날짜를 직접 고를 업무');
  const unrelated = await f.issue('별도로 일정이 바뀌는 업무');
  const absolute = { id: selected.id, expectedVersion: selected.version, startDate: selected.startDate, endDate: selected.endDate };
  const noOp = await f.readPreview({ changes: [absolute] });
  assert.deepEqual(noOp.changes, []);
  assert.equal(noOp.previewId, undefined);
  assert.equal(noOp.expiresAt, undefined);
  await f.readPreview({ changes: [{ ...absolute, expectedVersion: selected.version + 1 }] }, 409);

  const proposal = await f.review({ changes: [{ ...absolute, startDate: '2026-11-19', endDate: '2026-11-24' }] });
  await f.apply(proposal.previewId, 409, otherActor);
  await f.edit(unrelated, { endDate: '2026-11-24' });
  await f.restart();
  const [applied, concurrent] = await Promise.all([f.apply(proposal.previewId), f.apply(proposal.previewId)]);
  assert.ok(applied.undoId);
  assert.deepEqual(concurrent, applied);
  assert.deepEqual(applied.updated.map(issue => ({ id: issue.id, version: issue.version, ...dates(issue) })), [{
    id: selected.id, version: selected.version + 1, startDate: '2026-11-19', endDate: '2026-11-24', dueDate: selected.dueDate,
  }]);

  await f.restart();
  const written = await f.state();
  assert.equal(written.issues.find(issue => issue.id === selected.id)?.version, selected.version + 1);
  assert.equal(written.activities.filter(activity => activity.resourceId === selected.id && activity.action === '일정 변경').length, 1);
  await f.apply(proposal.previewId, 409, otherActor);
  assert.deepEqual(await f.apply(proposal.previewId), applied);
  assert.deepEqual(await f.state(), written);

  const undone = await f.call<Pick<SchedulePasteApplyResult, 'updated'>>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.deepEqual(undone.updated.map(issue => [issue.id, issue.version, dates(issue)]), [[selected.id, selected.version + 2, dates(selected)]]);
  assert.deepEqual(await f.apply(proposal.previewId), applied);
  assert.deepEqual(dates((await f.state()).issues.find(issue => issue.id === selected.id)!), dates(selected));
});

test('manual follow-up reviews shared successors once across project calendars and applies and undoes as a single proposal', async t => {
  const f = await fixture(t);
  const first = await f.issue('첫 선행');
  const second = await f.issue('둘째 선행');
  const shared = await f.issue('공통 후행', { startDate: '2026-11-23', endDate: '2026-11-23', dueDate: '2026-11-24' });
  const unchanged = await f.issue('이미 선후행 조건을 만족한 업무', { startDate: '2026-11-30', endDate: '2026-11-30' });
  const later = await f.issue('범위에 새로 연결할 업무', { startDate: '2026-12-01', endDate: '2026-12-01' });
  await f.link(first, shared);
  await f.link(second, shared);
  await f.link(shared, unchanged);
  const otherProject = await f.call<Project>('/projects', 201, 'POST', { key: 'FOLLOW', name: '토요일 근무 프로젝트' });
  const otherAnchor = await f.issue('다른 프로젝트 선행', { startDate: '2026-11-19', endDate: '2026-11-19' }, otherProject.id);
  const otherSuccessor = await f.issue('다른 프로젝트 후행', {}, otherProject.id);
  await f.link(otherAnchor, otherSuccessor);
  const calendarPath = `/projects/${otherProject.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath, 200);
  await f.call(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-21', isWorking: true, label: '토요일 근무' }],
  });

  const input = { changes: [chooseDate(first, '2026-11-23'), chooseDate(second, '2026-11-24'), chooseDate(otherAnchor, '2026-11-20')],
    rescheduleSuccessors: true };
  const expected = new Map([[first.id, '2026-11-23'], [second.id, '2026-11-24'], [shared.id, '2026-11-25'],
    [otherAnchor.id, '2026-11-20'], [otherSuccessor.id, '2026-11-21']]);
  const before = await f.state();
  const stale = await f.review(input);
  assert.equal(stale.changes.length, expected.size);
  assert.deepEqual(new Map(stale.changes.map(change => [change.id, change.toStart])), expected);
  assert.ok(stale.warnings.some(warning => warning.includes(shared.key) && warning.includes('목표 마감일')));
  assert.deepEqual(await f.state(), before);

  await f.link(unchanged, later);
  const withNewLink = await f.state();
  await f.apply(stale.previewId, 409);
  assert.deepEqual(await f.state(), withNewLink);

  const proposal = await f.review(input);
  await f.apply(proposal.previewId, 409, otherActor);
  await f.restart();
  const [applied, repeated] = await Promise.all([f.apply(proposal.previewId), f.apply(proposal.previewId)]);
  assert.deepEqual(repeated, applied);
  assert.ok(applied.undoId);
  assert.deepEqual(applied.warnings, proposal.warnings);
  assert.deepEqual(new Map(applied.updated.map(issue => [issue.id, issue.startDate])), expected);
  assert.equal(applied.updated.find(issue => issue.id === shared.id)?.dueDate, shared.dueDate);
  const originals = new Map(before.issues.filter(issue => expected.has(issue.id)).map(issue => [issue.id, dates(issue)]));
  const undone = await f.call<Pick<SchedulePasteApplyResult, 'updated'>>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, dates(issue)])), originals);
  assert.deepEqual(await f.apply(proposal.previewId), applied);
  assert.deepEqual(new Map((await f.state()).issues.filter(issue => expected.has(issue.id)).map(issue => [issue.id, dates(issue)])), originals);
});

test('manual follow-up keeps explicit unchanged anchors fixed and blocks the entire proposal when they conflict', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('미룰 선행 업무');
  const fixed = await f.issue('그대로 둘 후행 업무', { startDate: '2026-11-23', endDate: '2026-11-23' });
  const separateProject = await f.call<Project>('/projects', 201, 'POST', { key: 'SEPARATE', name: '함께 검토하는 프로젝트' });
  const separate = await f.issue('함께 이동할 업무', {}, separateProject.id);
  await f.link(predecessor, fixed);
  const changes = [chooseDate(predecessor, '2026-11-24'), chooseDate(fixed, fixed.startDate), chooseDate(separate, '2026-11-23')];
  await f.readPreview({ changes, rescheduleSuccessors: 'true' }, 400);
  await f.readPreview({ ...shift([predecessor]), rescheduleSuccessors: 'true' }, 400);
  const before = await f.state();
  const preview = await f.readPreview({ changes, rescheduleSuccessors: true });
  assert.equal(preview.previewId, undefined);
  assert.equal(preview.expiresAt, undefined);
  assert.ok(preview.blocking?.some(warning => warning.includes(fixed.key) && warning.includes('2026-11-25')));
  assert.ok(!preview.changes.some(change => change.id === fixed.id));
  assert.deepEqual(await f.state(), before);

  const legacy = await f.review({ changes, rescheduleSuccessors: false });
  assert.deepEqual(legacy.changes.map(change => change.id), [predecessor.id, separate.id]);
  assert.ok(legacy.warnings.some(warning => warning.includes(fixed.key) && warning.includes('2026-11-25')));
  assert.deepEqual(await f.state(), before);
});

test('relative follow-up moves shared successors once across project calendars and reuses the guarded result and undo', async t => {
  const f = await fixture(t);
  const first = await f.issue('첫 선행');
  const second = await f.issue('둘째 선행', { startDate: '2026-11-23', endDate: '2026-11-23' });
  const shared = await f.issue('공통 후행', { startDate: '2026-11-24', endDate: '2026-11-24', dueDate: '2026-11-24' });
  const unchanged = await f.issue('일정을 유지하는 후행', { startDate: '2026-11-27', endDate: '2026-11-27' });
  await f.link(first, shared);
  await f.link(second, shared);
  await f.link(shared, unchanged);

  const another = await f.call<Project>('/projects', 201, 'POST', { key: 'RELATIVE', name: '다른 달력 프로젝트' });
  const localFirst = await f.issue('다른 달력의 선행', {}, another.id);
  const localLast = await f.issue('다른 달력의 후행', { startDate: '2026-11-21', endDate: '2026-11-21' }, another.id);
  await f.link(localFirst, localLast);
  const path = `/projects/${another.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(path, 200);
  await f.call(path, 200, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-21', isWorking: true, label: '토요일 근무' }],
  });

  const move = shift([first, second, localFirst], true);
  const baseline = await f.state();
  const plain = await f.review({ ...move, rescheduleSuccessors: false });
  assert.deepEqual(plain.changes.map(({ id }) => id), [first.id, second.id, localFirst.id]);
  assert.equal(plain.followUpIssueIds, undefined);
  const unchangedMove = await f.readPreview({ ...move, days: 0, rescheduleSuccessors: true });
  assert.equal(unchangedMove.previewId, undefined);
  assert.deepEqual(unchangedMove.changes, []);

  const input = { ...move, rescheduleSuccessors: true };
  const expectedDates = new Map([[first.id, '2026-11-23'], [second.id, '2026-11-24'], [shared.id, '2026-11-25'],
    [localFirst.id, '2026-11-21'], [localLast.id, '2026-11-23']]);
  const stale = await f.review(input);
  assert.deepEqual(new Set(stale.followUpIssueIds), new Set([shared.id, localLast.id]));
  assert.deepEqual(new Map(stale.changes.map(({ id, toStart }) => [id, toStart])), expectedDates);
  assert.ok(stale.warnings.some(warning => warning.includes(shared.key) && warning.includes('목표 마감일')));
  assert.deepEqual(await f.state(), baseline);

  const outside = await f.issue('새 간접 후행', { startDate: '2026-11-30', endDate: '2026-11-30' });
  await f.link(unchanged, outside);
  const withLink = await f.state();
  await f.apply(stale.previewId, 409);
  assert.deepEqual(await f.state(), withLink);
  const reviewed = await f.review(input);
  await f.restart();
  const [applied, replay] = await Promise.all([f.apply(reviewed.previewId), f.apply(reviewed.previewId)]);
  assert.deepEqual(replay, applied);
  assert.deepEqual(new Map(applied.updated.map(({ id, startDate }) => [id, startDate])), expectedDates);
  assert.deepEqual(applied.warnings, reviewed.warnings);
  const undone = await f.call<Pick<SchedulePasteApplyResult, 'updated'>>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, dates(issue)])),
    new Map(baseline.issues.filter(issue => expectedDates.has(issue.id)).map(issue => [issue.id, dates(issue)])));
  assert.deepEqual(await f.apply(reviewed.previewId), applied);
});

test('hierarchy follow-up distinguishes descendants from dependency successors and revalidates each scope', async t => {
  const f = await fixture(t);
  const parent = await f.issue('상위');
  const child = await f.edit(await f.issue('하위'), { parentId: parent.id });
  const unscheduled = await f.edit(await f.issue('날짜 미정 하위', { startDate: null, endDate: null }), { parentId: parent.id });
  const related = await f.issue('계층 밖 후행', { startDate: '2026-11-23', endDate: '2026-11-23' });
  await f.link(child, related);
  const input = { hierarchy: { id: parent.id, expectedVersion: parent.version }, days: 1, workingDays: true, rescheduleSuccessors: true };
  await f.readPreview({ ...input, rescheduleSuccessors: null }, 400);
  await f.readPreview({ ...input, issueIds: [child.id] }, 400);
  const stale = await f.review(input);
  assert.deepEqual(stale.followUpIssueIds, [related.id]);
  assert.deepEqual(stale.skipped, [{ id: unscheduled.id, key: unscheduled.key, title: unscheduled.title, reason: 'unscheduled' }]);
  const newChild = await f.edit(await f.issue('새로 연결된 하위'), { parentId: parent.id });
  const updatedTree = await f.state();
  await f.apply(stale.previewId, 409);
  assert.deepEqual(await f.state(), updatedTree);

  const reviewed = await f.review(input);
  assert.deepEqual(new Map(reviewed.changes.map(({ id, toStart }) => [id, toStart])),
    new Map([[parent.id, '2026-11-23'], [child.id, '2026-11-23'], [newChild.id, '2026-11-23'], [related.id, '2026-11-24']]));
  const applied = await f.apply(reviewed.previewId);
  assert.deepEqual(new Set(applied.updated.map(({ id }) => id)), new Set([parent.id, child.id, newChild.id, related.id]));
  assert.equal((await f.state()).issues.find(issue => issue.id === unscheduled.id)?.startDate, null);
  await f.call('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.deepEqual((await f.state()).issues.map(issue => dates(issue)), updatedTree.issues.map(issue => dates(issue)));
});

test('automatic follow-up changes are checked against the same workflow rules as the chosen dates', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('일정을 선택한 선행 업무');
  const successor = await f.issue('목표 마감일이 없는 후행 업무', { startDate: '2026-11-23', endDate: '2026-11-23', dueDate: null });
  await f.link(predecessor, successor);
  const workflowPath = `/projects/${f.project.id}/workflow`;
  const workflow = await f.call<ProjectWorkflow>(workflowPath, 200);
  await f.call(workflowPath, 200, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    fieldRules: [{ issueType: '*', statusId: successor.status, requiredFields: ['dueDate'] }],
  });
  const input = { changes: [chooseDate(predecessor, '2026-11-25')], rescheduleSuccessors: true };
  const before = await f.state();
  const blocked = await f.readPreview(input);
  assert.equal(blocked.previewId, undefined);
  assert.ok(blocked.blocking?.some(warning => warning.includes(successor.key) && warning.includes('마감일')));
  assert.deepEqual(blocked.changes.map(change => change.id), [predecessor.id]);
  assert.deepEqual(await f.state(), before);

  await f.edit(successor, { dueDate: '2026-11-30' });
  const proposal = await f.review(input);
  assert.deepEqual(proposal.changes.map(change => [change.id, change.toStart]), [
    [predecessor.id, '2026-11-25'], [successor.id, '2026-11-26'],
  ]);
});
