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
import type { Dependency, Issue, Project, ProjectIssueSchema, ProjectWorkflow, ScheduleChange, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

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
async function issue(f: Fixture, title: string, startDate: string | null = '2026-11-19', endDate: string | null = '2026-11-20') {
  const made = await f.call<Issue>('/issues', 'POST', { projectId: f.project.id, title, startDate, endDate });
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
async function apply(f: Fixture, value: PastePreview, actorId = 'user-yun') { return f.call<Applied>('/schedule/paste-apply', 'POST', { previewId: value.previewId }, actorId); }
function dates(issues: Pick<Issue, 'id' | 'startDate' | 'endDate'>[]) { return Object.fromEntries(issues.map(value => [value.id, [value.startDate, value.endDate]])); }

test('mixed spreadsheet date edits preview without source writes, apply once, and share atomic undo with manual scheduling', async () => {
  const f = await fixture();
  try {
    const shifted = await issue(f, '이동할 합성 일정'), unscheduled = await issue(f, '새로 지정할 합성 일정', null, null), cleared = await issue(f, '지울 합성 일정'), unchanged = await issue(f, '빈 셀 유지');
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
    const applied = await apply(f, value); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.ok(applied.data.undoId); assert.equal(applied.data.updated.length, 3);
    const after = await workspace(f);
    for (const updated of applied.data.updated) { assert.equal(updated.version, 2); assert.equal(after.issues.find(item => item.id === updated.id)?.version, 2); }
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
