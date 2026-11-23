import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { Issue, Project, SchedulePasteApplyResult, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const actor = 'user-min';
const peer = 'user-seo';
const previewPath = '/schedule/manual-preview';
const applyPath = '/schedule/manual-apply';
const beforeDates = { startDate: '2026-11-20', endDate: '2026-11-20', dueDate: '2026-11-26' };
const dates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });
const hierarchyShift = ({ id, version }: Issue, workingDays = true) => ({ hierarchy: { id, expectedVersion: version }, days: 1, workingDays });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-hierarchy-shift-'));
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
  async function call<T = unknown>(path: string, expectedStatus: number, method = 'GET', data?: unknown, actorId = actor) {
    const response = await fetch(server.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json() as T;
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'TREE', name: '하위 일정 이동 검토' });
  return {
    call, project,
    state: () => call<WorkspaceSnapshot>('/workspace', 200),
    async restart() { await server.close(); server = await start(); },
    issue: (title: string, fields: Partial<Pick<Issue, 'parentId' | 'projectId' | 'status' | 'startDate' | 'endDate' | 'dueDate'>> = {}) =>
      call<Issue>('/issues', 201, 'POST', { title, projectId: project.id, ...beforeDates, ...fields }),
    edit: (issue: Issue, fields: Partial<Pick<Issue, 'parentId' | 'title' | 'startDate' | 'endDate'>> = {}) =>
      call<Issue>(`/issues/${issue.id}`, 200, 'PATCH', { expectedVersion: issue.version, ...fields }, peer),
    preview: (body: unknown, status = 200) => call<SchedulePreview>(previewPath, status, 'POST', body),
    async review(anchor: Issue, workingDays = true) {
      const preview = await call<SchedulePreview>(previewPath, 200, 'POST', hierarchyShift(anchor, workingDays));
      assert.ok(preview.previewId, JSON.stringify(preview));
      return { ...preview, previewId: preview.previewId };
    },
    apply: (previewId: string, status = 200, actorId = actor) =>
      call<SchedulePasteApplyResult>(applyPath, status, 'POST', { previewId }, actorId),
  };
}

test('anchored hierarchy shifts eligible dates together across all depths and preserves deadlines, skipped rows and replay', async t => {
  const f = await fixture(t);
  const tail = await f.issue('선택 밖의 선행 업무', { startDate: '2026-11-23', endDate: '2026-11-23' });
  const anchor = await f.issue('상위 업무');
  const child = await f.issue('직접 하위 업무', { parentId: anchor.id });
  const grandchild = await f.issue('간접 하위 업무', { parentId: child.id });
  const closed = await f.issue('완료한 하위 업무', { parentId: anchor.id, status: 'done' });
  const cancelled = await f.issue('취소한 하위 업무', { parentId: closed.id, status: 'cancelled' });
  const partial = await f.issue('종료일만 정한 업무', { parentId: cancelled.id, startDate: null });
  const undated = await f.issue('일정 미정 업무', { parentId: child.id, startDate: null, endDate: null });
  const otherProject = await f.call<Project>('/projects', 201, 'POST', { key: 'ELSE', name: '다른 프로젝트' });
  const foreign = await f.issue('범위 밖 업무', { projectId: otherProject.id });
  await f.call('/dependencies', 201, 'POST', { predecessorId: tail.id, successorId: grandchild.id, type: 'FS', lagDays: 0 });
  const calendarPath = `/projects/${f.project.id}/calendar`;
  const calendar = await f.call<WorkCalendar>(calendarPath, 200);
  await f.call(calendarPath, 200, 'PATCH', {
    expectedVersion: calendar.version, exceptions: [{ date: '2026-11-21', isWorking: true, label: '토요일 추가 근무' }],
  });

  const initial = await f.state();
  const preview = await f.review(anchor);
  const changedIssues = [anchor, child, grandchild, partial];
  assert.deepEqual(new Map(preview.changes.map(change => [change.id, [change.toStart, change.toEnd]])),
    new Map(changedIssues.map(issue => [issue.id, [issue.startDate && '2026-11-21', '2026-11-21']])));
  assert.deepEqual(new Map(preview.skipped?.map(item => [item.id, item])), new Map([
    [closed.id, { id: closed.id, key: closed.key, title: closed.title, reason: 'closed' }],
    [cancelled.id, { id: cancelled.id, key: cancelled.key, title: cancelled.title, reason: 'closed' }],
    [undated.id, { id: undated.id, key: undated.key, title: undated.title, reason: 'unscheduled' }],
  ]));
  assert.ok(preview.warnings.some(warning => warning.includes(`${tail.key} → ${grandchild.key}`)));
  assert.deepEqual(await f.state(), initial);
  await f.apply(preview.previewId, 409, peer);

  await f.restart();
  const [applied, replayed] = await Promise.all([f.apply(preview.previewId), f.apply(preview.previewId)]);
  assert.ok(applied.undoId);
  assert.deepEqual(replayed, applied);
  assert.deepEqual(applied.warnings, preview.warnings);
  assert.deepEqual(new Map(applied.updated.map(issue => [issue.id, [issue.version, dates(issue)]])), new Map(changedIssues.map(issue => [
    issue.id, [issue.version + 1, { startDate: issue.startDate && '2026-11-21', endDate: '2026-11-21', dueDate: issue.dueDate }],
  ])));
  const written = await f.state();
  for (const issue of [closed, cancelled, undated, tail, foreign]) {
    assert.deepEqual(written.issues.find(value => value.id === issue.id), issue);
  }
  for (const issue of changedIssues) {
    assert.equal(written.activities.filter(activity => activity.resourceId === issue.id && activity.action === '일정 변경').length, 1);
  }

  const undone = await f.call<Pick<SchedulePasteApplyResult, 'updated'>>('/schedule/undo', 200, 'POST', { undoId: applied.undoId });
  assert.deepEqual(new Map(undone.updated.map(issue => [issue.id, [issue.version, dates(issue)]])),
    new Map(changedIssues.map(issue => [issue.id, [issue.version + 2, dates(issue)]])));
  assert.deepEqual(await f.apply(preview.previewId), applied);
  const restored = await f.state();
  for (const issue of changedIssues) assert.deepEqual(dates(restored.issues.find(value => value.id === issue.id)!), dates(issue));
});

test('adding and reparenting descendants invalidates a hierarchy shift without writing any date', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('이동할 상위 업무');
  const child = await f.issue('이동할 하위 업무', { parentId: anchor.id });
  const elsewhere = await f.issue('다른 가지의 상위 업무');
  await f.preview({ ...hierarchyShift(anchor), issueIds: [anchor.id] }, 400);

  const beforeChild = await f.review(anchor, false);
  const newGrandchild = await f.issue('검토 뒤 추가한 미정 업무', { parentId: child.id, startDate: null, endDate: null });
  const expanded = await f.state();
  await f.apply(beforeChild.previewId, 409);
  assert.deepEqual(await f.state(), expanded);

  const beforeReparent = await f.review(anchor, false);
  assert.ok(beforeReparent.skipped?.some(item => item.id === newGrandchild.id));
  const reparented = await f.edit(newGrandchild, { parentId: anchor.id });
  const rearranged = await f.state();
  await f.apply(beforeReparent.previewId, 409);
  assert.deepEqual(await f.state(), rearranged);

  const beforeLeaving = await f.review(anchor, false);
  await f.edit(reparented, { parentId: elsewhere.id });
  const contracted = await f.state();
  await f.apply(beforeLeaving.previewId, 409);
  assert.deepEqual(await f.state(), contracted);

  const changedAnchor = await f.edit(anchor, { title: '검토 기준 수정' });
  await f.preview(hierarchyShift(anchor, false), 409);
  const current = await f.review(changedAnchor, false);
  assert.deepEqual(new Set(current.changes.map(issue => issue.id)), new Set([anchor.id, child.id]));
  assert.equal(current.skipped?.length ?? 0, 0);
});
