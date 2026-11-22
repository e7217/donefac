import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { Dependency, Issue, Project, SchedulePasteApplyResult, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const actor = 'user-min';
const otherActor = 'user-seo';
const previewPath = '/schedule/manual-preview';
const applyPath = '/schedule/manual-apply';
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const shift = (issues: Issue[], workingDays = false) => ({ issueIds: issues.map(issue => issue.id), days: 1, workingDays });

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
