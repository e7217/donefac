import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { MAX_SCHEDULE_BULK_DATE_ISSUES, type Dependency, type Issue, type Project, type ProjectIssueSchema, type ProjectWorkflow,
  type ScheduleBulkDateInput, type ScheduleChange, type SchedulePasteApplyResult, type SchedulePastePreview, type WorkCalendar,
  type WorkspaceSnapshot } from '../../shared/types.js';

interface PastePreview {
  projectId: string; previewId: string | null; expiresAt: string | null; changes: ScheduleChange[]; warnings: string[];
  errors: { line: number | null; key?: string; message: string }[]; unchanged: number;
}
interface Applied { undoId: string; updated: Issue[]; warnings: string[] }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-schedule-paste-'));
  const service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, actorId = 'user-yun') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  };
  const created = await call<Project>('/projects', 'POST', { key: 'PST', name: '합성 일정 붙여넣기 프로젝트' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { dir, call, project: created.data, async close() { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function issue(f: Fixture, title: string, startDate: string | null = '2026-11-19',
  endDate: string | null = '2026-11-20', dueDate: string | null = null, projectId = f.project.id) {
  const made = await f.call<Issue>('/issues', 'POST', { projectId, title, startDate, endDate, dueDate });
  assert.equal(made.status, 201, JSON.stringify(made.data)); return made.data;
}
async function workspace(f: Fixture) { return (await f.call<WorkspaceSnapshot>('/workspace')).data; }
function sheet(rows: string[][], header = ['key', 'startDate', 'endDate']) { return [header, ...rows].map(row => row.join('\t')).join('\n'); }
async function preview(f: Fixture, text: string) {
  const response = await f.call<PastePreview>('/schedule/paste-preview', 'POST', { projectId: f.project.id, text });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function validPreview(f: Fixture, target: Issue, endDate = '2026-11-24') {
  const value = await preview(f, sheet([[target.key, '2026-11-23', endDate]]));
  assert.deepEqual(value.errors, []); assert.ok(value.previewId); assert.ok(value.expiresAt); return value;
}
async function apply(f: Fixture, value: Pick<PastePreview, 'previewId'>, actorId = 'user-yun') { return f.call<Applied>('/schedule/paste-apply', 'POST', { previewId: value.previewId }, actorId); }
function dates(issues: Pick<Issue, 'id' | 'startDate' | 'endDate'>[]) { return Object.fromEntries(issues.map(value => [value.id, [value.startDate, value.endDate]])); }

const bulkDatePath = '/schedule/bulk-dates';
function bulkDateInput(f: Fixture, issues: Issue[], changes: ScheduleBulkDateInput['changes']): ScheduleBulkDateInput {
  return { projectId: f.project.id, issues: issues.map(({ id, version }) => ({ id, expectedVersion: version })), changes };
}
async function reviewBulkDates(f: Fixture, input: ScheduleBulkDateInput) {
  const reviewed = await f.call<SchedulePastePreview>(`${bulkDatePath}/preview`, 'POST', input);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  return reviewed.data;
}
function applyBulkDates(f: Fixture, review: SchedulePastePreview, actorId?: string) {
  return f.call<SchedulePasteApplyResult>(`${bulkDatePath}/apply`, 'POST', { previewId: review.previewId }, actorId);
}
const allDates = ({ startDate, endDate, dueDate }: Issue) => ({ startDate, endDate, dueDate });

test('bulk calendar dates review set, clear and keep separately, bind proposal kind and undo only changed dates', async () => {
  const f = await fixture();
  try {
    const first = await issue(f, '계획 기간이 있는 업무', '2026-11-19', '2026-11-23', '2026-11-24');
    const second = await issue(f, '마감일이 미정인 업무', '2026-11-18', '2026-11-25');
    const unchanged = await issue(f, '이미 일치한 날짜', null, '2026-11-20', '2026-11-28');
    const before = await workspace(f);
    const review = await reviewBulkDates(f, bulkDateInput(f, [first, second, unchanged], { startDate: null, dueDate: '2026-11-28' }));
    assert.ok(review.previewId);
    assert.deepEqual(review.errors, []);
    assert.equal(review.unchanged, 1);
    assert.deepEqual(review.changes.map(({ id, fromStart, fromEnd, fromDue, toStart, toEnd, toDue }) =>
      [id, fromStart, fromEnd, fromDue, toStart, toEnd, toDue]), [
      [first.id, first.startDate, first.endDate, first.dueDate, null, first.endDate, '2026-11-28'],
      [second.id, second.startDate, second.endDate, second.dueDate, null, second.endDate, '2026-11-28'],
    ]);
    assert.deepEqual(await workspace(f), before);
    const pasted = await validPreview(f, first, '2026-11-25');
    assert.equal((await applyBulkDates(f, pasted)).status, 404);
    assert.equal((await apply(f, review)).status, 404);
    assert.equal((await applyBulkDates(f, review, 'user-seo')).status, 409);
    assert.deepEqual(await workspace(f), before);

    const applied = await applyBulkDates(f, review);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.ok(applied.data.undoId);
    assert.deepEqual(applied.data.updated.map(allDates), [first, second].map(value => ({
      startDate: null, endDate: value.endDate, dueDate: '2026-11-28',
    })));
    const after = await workspace(f);
    assert.deepEqual(after.issues.find(({ id }) => id === unchanged.id), unchanged);
    assert.deepEqual(await applyBulkDates(f, review), applied);
    assert.deepEqual(await workspace(f), after);
    const undo = await f.call<{ updated: Issue[] }>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(undo.status, 200, JSON.stringify(undo.data));
    assert.deepEqual(undo.data.updated.map(allDates), [first, second].map(allDates));
    assert.ok(undo.data.updated.every(value => value.version === 3));
    const direct = await f.call<Applied>('/schedule/apply', 'POST', { changes: [{
      id: first.id, expectedVersion: undo.data.updated[0].version, startDate: first.startDate,
      endDate: '2026-11-25', dueDate: '2026-11-29',
    }] });
    assert.equal(direct.status, 200, JSON.stringify(direct.data));
    assert.equal(direct.data.updated[0].dueDate, first.dueDate);
  } finally { await f.close(); }
});

test('bulk calendar dates reject stale, absent, malformed or blocked selections while showing valid rows', async () => {
  const f = await fixture();
  try {
    const valid = await issue(f, '나중에 끝나는 업무', '2026-11-19', '2026-11-27', '2026-11-28');
    const inverted = await issue(f, '먼저 끝나는 업무', '2026-11-19', '2026-11-20', '2026-11-28');
    const prior = await issue(f, '동시 편집할 업무', '2026-11-19', '2026-11-27', '2026-11-28');
    const edited = await f.call<Issue>(`/issues/${prior.id}`, 'PATCH', { expectedVersion: prior.version, title: '다른 작업자의 현재 제목' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const removed = await issue(f, '휴지통으로 이동한 업무');
    assert.equal((await f.call(`/issues/${removed.id}`, 'DELETE')).status, 200);
    const before = await workspace(f);
    const foreign = before.issues.find(value => value.projectId !== f.project.id)!;
    const review = await reviewBulkDates(f, bulkDateInput(f, [valid, inverted, prior, removed, foreign], { startDate: '2026-11-24' }));
    assert.deepEqual(review.changes.map(change => change.id), [valid.id]);
    assert.deepEqual(review.changes.map(({ fromDue, toDue }) => [fromDue, toDue]), [['2026-11-28', '2026-11-28']]);
    assert.deepEqual(review.errors.map(error => [error.line, error.issueId, error.key]), [
      [null, inverted.id, inverted.key], [null, prior.id, prior.key], [null, removed.id, undefined], [null, foreign.id, undefined],
    ]);
    assert.equal(review.previewId, null);
    assert.equal(review.expiresAt, null);
    assert.deepEqual(await workspace(f), before);

    const input = bulkDateInput(f, [valid], { dueDate: '2028-02-29' });
    for (const invalid of [
      { ...input, issues: [] },
      { ...input, issues: [...input.issues, ...input.issues] },
      { ...input, issues: [{ id: valid.id, expectedVersion: `${valid.version}` }] },
      { ...input, issues: Array.from({ length: MAX_SCHEDULE_BULK_DATE_ISSUES + 1 }, (_, i) => ({ id: `issue-${i}`, expectedVersion: 1 })) },
      { ...input, changes: {} },
      { ...input, changes: { startDate: '2026-02-29' } },
      { ...input, changes: { dueDate: ' 2026-11-28' } },
      { ...input, changes: { endDate: '' } },
      { ...input, changes: { title: '해당 없는 항목' } },
    ]) {
      const rejected = await f.call(`${bulkDatePath}/preview`, 'POST', invalid);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    }
    assert.ok((await reviewBulkDates(f, input)).previewId);
    const noop = await reviewBulkDates(f, bulkDateInput(f, [valid], { dueDate: valid.dueDate }));
    assert.equal(noop.unchanged, 1);
    assert.equal(noop.previewId, null);
    assert.deepEqual(noop.errors, []);
    const workflowPath = `/projects/${f.project.id}/workflow`;
    const workflow = (await f.call<ProjectWorkflow>(workflowPath)).data;
    const rule = await f.call(workflowPath, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      fieldRules: [{ issueType: '*', statusId: valid.status, requiredFields: ['dueDate'] }],
    });
    assert.equal(rule.status, 200, JSON.stringify(rule.data));
    const blocked = await reviewBulkDates(f, bulkDateInput(f, [valid], { dueDate: null }));
    assert.equal(blocked.previewId, null);
    assert.match(blocked.errors[0].message, /마감일/);
  } finally { await f.close(); }
});

test('bulk calendar dates guard linked changes and roll back a failed write across dates, activity and retry state', async () => {
  const f = await fixture();
  try {
    const first = await issue(f, '첫째 일정', '2026-11-17', '2026-11-27', '2026-11-26');
    const second = await issue(f, '둘째 일정', '2026-11-18', '2026-11-26', '2026-11-26');
    const predecessor = await issue(f, '선행 일정', '2026-11-22', '2026-11-25');
    const link = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: predecessor.id, successorId: first.id, type: 'FS', lagDays: 0 });
    assert.equal(link.status, 201, JSON.stringify(link.data));
    const input = bulkDateInput(f, [first, second], { startDate: '2026-11-23', dueDate: null });
    const linkedReview = await reviewBulkDates(f, input);
    assert.ok(linkedReview.previewId);
    assert.ok(linkedReview.warnings.some(warning => warning.includes(`${predecessor.key} → ${first.key}`)));
    const edited = await f.call<Issue>(`/issues/${predecessor.id}`, 'PATCH', { expectedVersion: predecessor.version, endDate: '2026-11-26' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const beforeApply = await workspace(f);
    assert.equal((await applyBulkDates(f, linkedReview)).status, 409);
    assert.deepEqual(await workspace(f), beforeApply);

    const review = await reviewBulkDates(f, input);
    assert.ok(review.previewId);
    const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
    try {
      database.exec(`CREATE TRIGGER fail_bulk_dates_second BEFORE UPDATE ON issues
        WHEN json_extract(NEW.json,'$.title')='둘째 일정'
        BEGIN SELECT RAISE(ABORT,'synthetic bulk dates second write failure'); END`);
      try {
        assert.equal((await applyBulkDates(f, review)).status, 500);
        assert.deepEqual(await workspace(f), beforeApply);
        assert.equal(database.prepare('SELECT COUNT(*) as count FROM schedule_undos').get()?.count, 0);
      } finally { database.exec('DROP TRIGGER fail_bulk_dates_second'); }
      const applied = await applyBulkDates(f, review);
      assert.equal(applied.status, 200, JSON.stringify(applied.data));
      assert.ok(applied.data.updated.every(value => value.dueDate === null));
      assert.equal((await f.call(`/issues/${first.id}`, 'PATCH', {
        expectedVersion: applied.data.updated[0].version, dueDate: '2026-11-29',
      })).status, 200);
      const beforeUndo = await workspace(f);
      assert.equal((await f.call('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status, 409);
      assert.deepEqual(await workspace(f), beforeUndo);
    } finally { database.close(); }
  } finally { await f.close(); }
});

test('team bulk dates set, clear and keep across explicit projects, replay once, and undo the entire batch', async () => {
  const f = await fixture();
  try {
    const otherProjectId = 'project-team';
    const first = await issue(f, '첫 프로젝트의 일정과 마감', '2026-11-19', '2026-11-23', '2026-11-24');
    const second = await issue(f, '다른 프로젝트의 마감 미정', '2026-11-18', '2026-11-25', null, otherProjectId);
    const unchanged = await issue(f, '이미 같은 일정과 마감', null, '2026-11-20', '2026-11-28', otherProjectId);
    const unselected = await issue(f, '바꾸지 않는 같은 프로젝트 업무', '2026-11-17', '2026-11-24', '2026-11-24', otherProjectId);
    const input: ScheduleBulkDateInput = {
      ...bulkDateInput(f, [first, second, unchanged], { startDate: null, dueDate: '2026-11-28' }), projectId: null,
    };
    const original = await workspace(f);
    const preview = await reviewBulkDates(f, input);
    assert.equal(preview.projectId, null);
    assert.deepEqual(preview.projectIds, [f.project.id, otherProjectId].sort());
    assert.ok(preview.previewId);
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.unchanged, 1);
    assert.deepEqual(preview.changes.map(({ id, fromStart, fromEnd, fromDue, toStart, toEnd, toDue }) =>
      [id, fromStart, fromEnd, fromDue, toStart, toEnd, toDue]), [first, second].map(current =>
      [current.id, current.startDate, current.endDate, current.dueDate, null, current.endDate, '2026-11-28']));
    assert.deepEqual(await workspace(f), original);

    const applied = await applyBulkDates(f, preview);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.ok(applied.data.undoId);
    assert.deepEqual(applied.data.updated.map(current => [current.id, current.projectId, current.version, allDates(current)]),
      [first, second].map(current => [current.id, current.projectId, current.version + 1,
        { startDate: null, endDate: current.endDate, dueDate: '2026-11-28' }]));
    const after = await workspace(f);
    for (const current of [...applied.data.updated, unchanged, unselected]) {
      assert.deepEqual(after.issues.find(item => item.id === current.id), current);
    }
    assert.deepEqual(await applyBulkDates(f, preview), applied);
    assert.deepEqual(await workspace(f), after);

    const undo = await f.call<{ updated: Issue[] }>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(undo.status, 200, JSON.stringify(undo.data));
    assert.deepEqual(undo.data.updated.map(current => [current.id, current.projectId, current.version, allDates(current)]),
      [first, second].map(current => [current.id, current.projectId, current.version + 2, allDates(current)]));
    const restored = await workspace(f);
    for (const current of [...undo.data.updated, unchanged, unselected]) {
      assert.deepEqual(restored.issues.find(item => item.id === current.id), current);
    }
    assert.deepEqual(restored.dependencies, original.dependencies);
  } finally { await f.close(); }
});

test('team bulk dates fence the other project calendar, linked endpoint and unchanged selection without partial writes', async () => {
  const f = await fixture();
  try {
    const otherProjectId = 'project-team';
    const first = await issue(f, '첫 프로젝트 대상', '2026-11-17', '2026-11-27', '2026-11-28');
    const second = await issue(f, '다른 프로젝트 대상', '2026-11-18', '2026-11-26', '2026-11-27', otherProjectId);
    const unchanged = await issue(f, '다른 프로젝트에서 같은 일정', '2026-11-23', '2026-11-26', null, otherProjectId);
    const predecessor = await issue(f, '다른 프로젝트의 선택하지 않은 선행 업무', '2026-11-19', '2026-11-20', null, otherProjectId);
    const link = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: predecessor.id, successorId: second.id, type: 'FS', lagDays: 0 });
    assert.equal(link.status, 201, JSON.stringify(link.data));
    const changes = { startDate: '2026-11-23', dueDate: null };
    const input: ScheduleBulkDateInput = { ...bulkDateInput(f, [first, second, unchanged], changes), projectId: null };
    const review = await reviewBulkDates(f, input);
    assert.ok(review.previewId);
    assert.equal(review.unchanged, 1);
    assert.ok(!review.warnings.some(warning => warning.includes(`${predecessor.key} → ${second.key}`)));

    const calendarPath = `/projects/${otherProjectId}/calendar`;
    const calendar = (await f.call<WorkCalendar>(calendarPath)).data;
    const closed = await f.call<WorkCalendar>(calendarPath, 'PATCH', {
      ...calendar, expectedVersion: calendar.version,
      exceptions: [...calendar.exceptions, { date: '2026-11-23', isWorking: false, label: '둘째 프로젝트만 휴무' }],
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    const afterCalendar = await workspace(f);
    assert.equal((await applyBulkDates(f, review)).status, 409);
    assert.deepEqual(await workspace(f), afterCalendar);

    const afterHoliday = await reviewBulkDates(f, input);
    assert.ok(afterHoliday.previewId);
    assert.ok(afterHoliday.warnings.some(warning => warning.includes(`${predecessor.key} → ${second.key}`)));
    const linkedEdit = await f.call<Issue>(`/issues/${predecessor.id}`, 'PATCH', { expectedVersion: predecessor.version, endDate: '2026-11-24' });
    assert.equal(linkedEdit.status, 200, JSON.stringify(linkedEdit.data));
    const afterEndpoint = await workspace(f);
    assert.equal((await applyBulkDates(f, afterHoliday)).status, 409);
    assert.deepEqual(await workspace(f), afterEndpoint);

    const reviewed = await reviewBulkDates(f, input);
    assert.ok(reviewed.previewId);
    const concurrent = await f.call<Issue>(`/issues/${unchanged.id}`, 'PATCH', { expectedVersion: unchanged.version, title: '선택 업무의 새 제목' });
    assert.equal(concurrent.status, 200, JSON.stringify(concurrent.data));
    const beforeApply = await workspace(f);
    assert.equal((await applyBulkDates(f, reviewed)).status, 409);
    assert.deepEqual(await workspace(f), beforeApply);

    const missing = await reviewBulkDates(f, { ...input, issues: [...input.issues, { id: randomUUID(), expectedVersion: 1 }] });
    assert.equal(missing.previewId, null);
    assert.deepEqual(missing.changes.map(current => current.id), [first.id, second.id]);
    assert.equal(missing.errors.length, 2);
    assert.deepEqual(await workspace(f), beforeApply);

    const fresh = await reviewBulkDates(f, { ...bulkDateInput(f, [first, second, concurrent.data], changes), projectId: null });
    assert.equal(fresh.unchanged, 1);
    const applied = await applyBulkDates(f, fresh);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.deepEqual(applied.data.updated.map(current => current.id), [first.id, second.id]);
    const secondMoved = applied.data.updated.find(current => current.id === second.id)!;
    const remote = await f.call<Issue>(`/issues/${second.id}`, 'PATCH', { expectedVersion: secondMoved.version, dueDate: '2026-11-30' });
    assert.equal(remote.status, 200, JSON.stringify(remote.data));
    const beforeUndo = await workspace(f);
    assert.equal((await f.call('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status, 409);
    assert.deepEqual(await workspace(f), beforeUndo);
  } finally { await f.close(); }
});

test('mixed spreadsheet date edits preview without source writes, apply once, and share atomic undo with manual scheduling', async () => {
  const f = await fixture();
  try {
    const shifted = await issue(f, '이동할 합성 일정', '2026-11-19', '2026-11-20', '2026-11-26');
    const unscheduled = await issue(f, '새로 지정할 합성 일정', null, null), cleared = await issue(f, '지울 합성 일정'), unchanged = await issue(f, '빈 셀 유지');
    const before = await workspace(f);
    const value = await preview(f, sheet([
      [shifted.key, '2026-11-23', '2026-11-25'], [unscheduled.key, '2026-11-26', '2026-11-27'],
      [cleared.key, '-', '-'], [unchanged.key, '', ''],
    ], ['업무 키', '시작일', '종료일']));
    assert.equal(value.projectId, f.project.id); assert.ok(value.previewId); assert.ok(value.expiresAt); assert.deepEqual(value.errors, []); assert.equal(value.unchanged, 1); assert.equal(value.changes.length, 3);
    assert.deepEqual(await workspace(f), before);
    assert.deepEqual(dates(value.changes.map(change => ({ id: change.id, startDate: change.toStart, endDate: change.toEnd }))), {
      [shifted.id]: ['2026-11-23', '2026-11-25'], [unscheduled.id]: ['2026-11-26', '2026-11-27'], [cleared.id]: [null, null],
    });
    assert.ok(value.changes.every(change => !Object.hasOwn(change, 'fromDue') && !Object.hasOwn(change, 'toDue')));
    const applied = await apply(f, value); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.ok(applied.data.undoId); assert.equal(applied.data.updated.length, 3);
    const after = await workspace(f);
    for (const updated of applied.data.updated) { assert.equal(updated.version, 2); assert.equal(after.issues.find(item => item.id === updated.id)?.version, 2); }
    assert.equal(after.issues.find(item => item.id === shifted.id)?.dueDate, shifted.dueDate);
    assert.equal(after.issues.find(item => item.id === unchanged.id)?.version, unchanged.version);
    const retry = await apply(f, value); assert.equal(retry.status, 200); assert.deepEqual(retry.data, applied.data); assert.deepEqual(await workspace(f), after);
    const undo = await f.call<{ updated: Issue[]; warnings: string[] }>('/schedule/undo', 'POST', { undoId: applied.data.undoId });
    assert.equal(undo.status, 200, JSON.stringify(undo.data)); assert.deepEqual(dates(undo.data.updated), dates([shifted, unscheduled, cleared]));
    assert.ok(undo.data.updated.every(item => item.version === 3));
    assert.deepEqual(dates((await workspace(f)).issues.filter(item => [shifted.id, unscheduled.id, cleared.id, unchanged.id].includes(item.id))), dates([shifted, unscheduled, cleared, unchanged]));
    assert.equal((await f.call('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status, 409);
  } finally { await f.close(); }
});

test('bad dates, unknown or cross-project keys and duplicate rows cannot produce any applicable preview; blanks remain explicit no-ops', async () => {
  const f = await fixture();
  try {
    const target = await issue(f, '검증할 합성 일정'), initial = await workspace(f), foreign = initial.issues.find(item => item.projectId !== f.project.id)!;
    const invalidSheets = [
      sheet([[target.key, '2026-11-23', '2026-11-24'], ['PST-999999', '2026-11-23', '2026-11-24']]),
      sheet([[target.key, '2026-11-23', '2026-11-24'], [foreign.key, '2026-11-23', '2026-11-24']]),
      sheet([[target.key, '2026-02-30', '2026-11-24']]),
      sheet([[target.key, '2026-11-25', '2026-11-24']]),
      sheet([[target.key, '2026-11-23', '2026-11-24'], [target.key, '2026-11-26', '2026-11-27']]),
    ];
    for (const text of invalidSheets) {
      const value = await preview(f, text);
      assert.equal(value.previewId, null); assert.equal(value.expiresAt, null); assert.ok(value.errors.length > 0); assert.ok(value.errors.every(error => error.message.trim()));
      assert.ok(value.errors.some(error => error.line !== null && Number.isInteger(error.line)));
      assert.deepEqual(await workspace(f), initial);
    }
    const noop = await preview(f, sheet([[target.key, '', '']]));
    assert.equal(noop.previewId, null); assert.deepEqual(noop.errors, []); assert.equal(noop.changes.length, 0); assert.equal(noop.unchanged, 1);
    const same = await preview(f, sheet([[target.key, target.startDate!, target.endDate!]]));
    assert.equal(same.previewId, null); assert.equal(same.unchanged, 1);
    const partial = await preview(f, sheet([[target.key, '-', '']])); assert.deepEqual(partial.errors, []); assert.ok(partial.previewId);
    assert.equal(partial.changes[0].toStart, null); assert.equal(partial.changes[0].toEnd, target.endDate);
    assert.deepEqual(await workspace(f), initial);
  } finally { await f.close(); }
});

test('dueDate-only paste rejects required clears and stale goal edits without applying any other row', async () => {
  const f = await fixture();
  try {
    const first = await issue(f, '필수 목표 마감일', '2026-11-19', '2026-11-20', '2026-11-25');
    const second = await issue(f, '함께 검토할 목표 마감일', '2026-11-19', '2026-11-20', '2026-11-26');
    const workflowPath = `/projects/${f.project.id}/workflow`;
    const workflow = (await f.call<ProjectWorkflow>(workflowPath)).data;
    const saved = await f.call(workflowPath, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      fieldRules: [{ issueType: '*', statusId: first.status, requiredFields: ['dueDate'] }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const header = ['key', 'dueDate'];
    const before = await workspace(f);
    const blocked = await preview(f, sheet([[first.key, '-'], [second.key, '2026-11-28']], header));
    assert.equal(blocked.previewId, null);
    assert.deepEqual(blocked.errors.map(({ line, key }) => [line, key]), [[2, first.key]]);
    assert.match(blocked.errors[0].message, /마감일/u);
    assert.deepEqual(blocked.changes.map(({ id, toDue }) => [id, toDue]), [[second.id, '2026-11-28']]);
    assert.deepEqual(await workspace(f), before);

    const noop = await preview(f, sheet([[first.key, first.dueDate!], [second.key, '']], header));
    assert.equal(noop.previewId, null);
    assert.equal(noop.unchanged, 2);
    assert.deepEqual(noop.errors, []);
    assert.deepEqual(noop.changes, []);

    const text = sheet([[first.key, '2026-11-27'], [second.key, '2026-11-28']], header);
    const stale = await preview(f, text);
    assert.ok(stale.previewId);
    const incoming = await f.call<Issue>(`/issues/${second.id}`, 'PATCH', { expectedVersion: second.version, dueDate: '2026-11-29' });
    assert.equal(incoming.status, 200, JSON.stringify(incoming.data));
    const beforeApply = await workspace(f);
    assert.equal((await apply(f, stale)).status, 409);
    assert.deepEqual(await workspace(f), beforeApply);

    const fresh = await preview(f, text);
    assert.deepEqual(fresh.changes.map(({ fromDue, toDue }) => [fromDue, toDue]), [
      ['2026-11-25', '2026-11-27'], ['2026-11-29', '2026-11-28'],
    ]);
    const applied = await apply(f, fresh);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.deepEqual(applied.data.updated.map(allDates), [
      { ...allDates(first), dueDate: '2026-11-27' }, { ...allDates(second), dueDate: '2026-11-28' },
    ]);

    const changed = await f.call<Issue>(`/issues/${second.id}`, 'PATCH', {
      expectedVersion: applied.data.updated[1].version, dueDate: '2026-11-30',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const beforeUndo = await workspace(f);
    assert.equal((await f.call('/schedule/undo', 'POST', { undoId: applied.data.undoId })).status, 409);
    assert.deepEqual(await workspace(f), beforeUndo);
  } finally { await f.close(); }
});

test('actor, target and linked predecessor versions plus incident dependency changes reject stale proposals without date writes', async () => {
  const f = await fixture();
  try {
    const predecessor = await issue(f, '연결 선행'), target = await issue(f, '변경 대상', '2026-11-23', '2026-11-24');
    const actorPreview = await validPreview(f, target, '2026-11-25');
    const beforeActor = await workspace(f);
    assert.equal((await apply(f, actorPreview, 'user-seo')).status, 409); assert.deepEqual(await workspace(f), beforeActor);
    const targetPreview = await validPreview(f, target, '2026-11-25');
    const edited = await f.call<Issue>(`/issues/${target.id}`, 'PATCH', { expectedVersion: target.version, title: '미리보기 후 변경한 제목' }); assert.equal(edited.status, 200);
    const beforeTarget = await workspace(f); assert.equal((await apply(f, targetPreview)).status, 409); assert.deepEqual(await workspace(f), beforeTarget);
    const dependencyPreview = await validPreview(f, edited.data, '2026-11-25');
    const linked = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: predecessor.id, successorId: target.id, lagDays: 0 }); assert.equal(linked.status, 201);
    const beforeDependency = await workspace(f); assert.equal((await apply(f, dependencyPreview)).status, 409); assert.deepEqual(await workspace(f), beforeDependency);
    const linkedPreview = await validPreview(f, edited.data, '2026-11-25');
    assert.equal((await f.call(`/issues/${predecessor.id}`, 'PATCH', { expectedVersion: predecessor.version, title: '선행 업무의 병행 변경' })).status, 200);
    const beforeLinked = await workspace(f); assert.equal((await apply(f, linkedPreview)).status, 409); assert.deepEqual(await workspace(f), beforeLinked);
    const removedPreview = await validPreview(f, edited.data, '2026-11-25'); assert.equal((await f.call(`/dependencies/${linked.data.id}`, 'DELETE')).status, 200);
    const beforeRemoval = await workspace(f); assert.equal((await apply(f, removedPreview)).status, 409); assert.deepEqual(await workspace(f), beforeRemoval);
    const unrelated = await issue(f, '연결 없는 병행 업무'), isolatedPreview = await validPreview(f, edited.data, '2026-11-25');
    assert.equal((await f.call(`/issues/${unrelated.id}`, 'PATCH', { expectedVersion: unrelated.version, endDate: '2026-11-24' })).status, 200);
    const isolatedApply = await apply(f, isolatedPreview); assert.equal(isolatedApply.status, 200, JSON.stringify(isolatedApply.data));
    assert.deepEqual(isolatedApply.data.updated.map(item => item.id), [target.id]);
  } finally { await f.close(); }
});

test('calendar, workflow, schema and native-restore changes invalidate proposals even when pasted issue dates and versions stay unchanged', async () => {
  const f = await fixture();
  try {
    const target = await issue(f, '설정과 복원 보호 대상'), calendarPreview = await validPreview(f, target);
    const calendar = (await f.call<WorkCalendar>(`/projects/${f.project.id}/calendar`)).data;
    assert.equal((await f.call(`/projects/${f.project.id}/calendar`, 'PATCH', { ...calendar, expectedVersion: calendar.version, exceptions: [{ date: '2026-11-23', isWorking: false, label: '합성 회사 휴무' }] })).status, 200);
    const beforeCalendar = await workspace(f); assert.equal((await apply(f, calendarPreview)).status, 409); assert.deepEqual(await workspace(f), beforeCalendar);
    const workflowPreview = await validPreview(f, target), workflow = (await f.call<ProjectWorkflow>(`/projects/${f.project.id}/workflow`)).data;
    assert.equal((await f.call(`/projects/${f.project.id}/workflow`, 'PATCH', { ...workflow, expectedVersion: workflow.version, statuses: workflow.statuses.map(status => status.id === 'todo' ? { ...status, label: '계획 검토 대기' } : status) })).status, 200);
    const beforeWorkflow = await workspace(f); assert.equal((await apply(f, workflowPreview)).status, 409); assert.deepEqual(await workspace(f), beforeWorkflow);
    const schemaPreview = await validPreview(f, target), schema = (await f.call<ProjectIssueSchema>(`/projects/${f.project.id}/issue-schema`)).data;
    assert.equal((await f.call(`/projects/${f.project.id}/issue-schema`, 'PATCH', { ...schema, expectedVersion: schema.version, issueTypes: schema.issueTypes.map(type => type.id === '작업' ? { ...type, name: '붙여넣기 작업' } : type) })).status, 200);
    const beforeSchema = await workspace(f); assert.equal((await apply(f, schemaPreview)).status, 409); assert.deepEqual(await workspace(f), beforeSchema);
    const restorePreview = await validPreview(f, target), backup = await f.call('/export'); assert.equal(backup.status, 200);
    const restored = await f.call('/import', 'POST', { data: backup.data }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const beforeRestoreApply = await workspace(f), invalidated = await apply(f, restorePreview); assert.ok([404, 409].includes(invalidated.status), JSON.stringify(invalidated)); assert.deepEqual(await workspace(f), beforeRestoreApply);
  } finally { await f.close(); }
});

test('expired proposals cannot write dates; maintenance retains live previews and recent idempotent receipts while removing elapsed records', async () => {
  const f = await fixture();
  try {
    const target = await issue(f, '만료 및 보관 검증'), expired = await validPreview(f, target), active = await validPreview(f, target);
    assert.ok(Date.parse(expired.expiresAt!) > Date.now() + 29 * 60_000); assert.ok(Date.parse(expired.expiresAt!) <= Date.now() + 30 * 60_000);
    const db = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
    try {
      const elapsed = new Date(Date.now() - 1000).toISOString();
      db.prepare("UPDATE schedule_paste_previews SET json=json_set(json,'$.removeAfter',?) WHERE id=?").run(elapsed, expired.previewId!);
      const beforeExpiry = await workspace(f);
      assert.equal((await apply(f, expired)).status, 409); assert.deepEqual(await workspace(f), beforeExpiry);
      const used = await validPreview(f, target), applied = await apply(f, used); assert.equal(applied.status, 200);
      const receiptRow = db.prepare('SELECT json FROM schedule_paste_previews WHERE id=?').get(used.previewId!) as { json: string };
      const receipt = JSON.parse(receiptRow.json) as { id: string; removeAfter: string; [key: string]: unknown };
      assert.ok(Date.parse(receipt.removeAfter) > Date.now() + 6 * 24 * 60 * 60_000);
      assert.ok(Date.parse(receipt.removeAfter) <= Date.now() + 7 * 24 * 60 * 60_000);
      const oldReceiptId = randomUUID();
      db.prepare('INSERT INTO schedule_paste_previews(id,json) VALUES(?,?)').run(oldReceiptId, JSON.stringify({ ...receipt, id: oldReceiptId, removeAfter: elapsed }));
      const beforeCleanup = await workspace(f), live = await validPreview(f, applied.data.updated[0], '2026-11-25');
      assert.equal(db.prepare('SELECT id FROM schedule_paste_previews WHERE id=?').get(expired.previewId!), undefined);
      assert.equal(db.prepare('SELECT id FROM schedule_paste_previews WHERE id=?').get(oldReceiptId), undefined);
      for (const id of [active.previewId!, used.previewId!, live.previewId!]) assert.ok(db.prepare('SELECT id FROM schedule_paste_previews WHERE id=?').get(id));
      assert.deepEqual((await apply(f, used)).data, applied.data); assert.deepEqual(await workspace(f), beforeCleanup);
    } finally { db.close(); }
  } finally { await f.close(); }
});
