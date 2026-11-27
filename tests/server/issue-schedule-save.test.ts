import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, Dependency, Issue, IssueChangeHistoryPage, IssueRelation, Project, ProjectWorkflow,
  SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const actorId = 'user-min';
const otherActorId = 'user-seo';
type Dates = Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>;
type StalePreviewError = { details?: { reason?: string } };
const dates = ({ startDate, endDate, dueDate }: Dates): Dates => ({ startDate, endDate, dueDate });
const issuePath = ({ id }: Issue) => `/issues/${id}`;
const previewPath = (issue: Issue) => `${issuePath(issue)}/schedule-save-preview`;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-issue-schedule-save-'));
  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
  const listener = runtime.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    listener.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
    finally {
      runtime.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function call<T = unknown>(status: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const project = (key: string, name: string) => call<Project>(201, '/projects', 'POST', { key, name });
  const primary = await project('DATES', '티켓 일정 검토');
  const workspace = () => call<WorkspaceSnapshot>(200, '/workspace');
  function createIssue(title: string, schedule: Partial<Dates> = {}, projectId = primary.id) {
    return call<Issue>(201, '/issues', 'POST', {
      title, projectId, startDate: '2026-11-20', endDate: '2026-11-20', dueDate: null, ...schedule,
    });
  }
  function edit(issue: Issue, changes: Partial<Issue>, editorId = actorId) {
    return call<Issue>(200, issuePath(issue), 'PATCH', { expectedVersion: issue.version, ...changes }, { 'X-Actor-Id': editorId });
  }
  function link(predecessor: Issue, successor: Issue) {
    return call<Dependency>(201, '/dependencies', 'POST', { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 });
  }
  function addBlocker(source: Issue, target: Issue) {
    return call<IssueRelation>(201, '/schedule/team-blockers', 'POST', {
      sourceIssueId: source.id, targetIssueId: target.id, expectedSourceVersion: source.version, expectedTargetVersion: target.version,
    });
  }
  async function setHoliday(projectId: string, date: string) {
    const calendarPath = `/projects/${projectId}/calendar`;
    const current = await call<WorkCalendar>(200, calendarPath);
    return call<WorkCalendar>(200, calendarPath, 'PATCH', {
      expectedVersion: current.version, exceptions: [{ date, isWorking: false, label: '후행 프로젝트 휴무' }],
    }, { 'X-Actor-Id': otherActorId });
  }
  async function review(issue: Issue, schedule: Dates, status?: Issue['status']) {
    const result = await call<SchedulePreview>(200, previewPath(issue), 'POST', {
      expectedVersion: issue.version, ...schedule, ...(status === undefined ? {} : { status }),
    });
    const { previewId, expiresAt } = result;
    assert.ok(previewId, JSON.stringify(result));
    assert.ok(expiresAt && Number.isFinite(Date.parse(expiresAt)));
    return { ...result, previewId, expiresAt };
  }
  return { call, dataDir, primary, project, createIssue, workspace, edit, link, addBlocker, setHoliday, review };
}

test('ticket schedule preview sees linked work and ordinary save commits dates, title and status together', async t => {
  const f = await fixture(t);
  const destination = await f.project('OTHER', '후행 프로젝트');
  const predecessor = await f.createIssue('같은 프로젝트 선행 업무', { startDate: '2026-11-17', endDate: '2026-11-18' });
  const selected = await f.createIssue('검토할 티켓', { dueDate: '2026-11-26' });
  const successor = await f.createIssue('다른 프로젝트 후행 업무', { startDate: '2026-11-24', endDate: '2026-11-25' }, destination.id);
  await f.link(predecessor, selected);
  await f.addBlocker(selected, successor);
  await f.setHoliday(destination.id, '2026-11-24');

  const before = await f.workspace();
  const nextDates = { startDate: '2026-11-18', endDate: '2026-11-23', dueDate: '2026-11-20' };
  const preview = await f.review(selected, nextDates, 'in_progress');
  assert.deepEqual(preview.changes.map(change => [change.id, change.fromStart, change.fromEnd, change.fromDue, change.toStart, change.toEnd, change.toDue]), [
    [selected.id, selected.startDate, selected.endDate, selected.dueDate, nextDates.startDate, nextDates.endDate, nextDates.dueDate],
  ]);
  assert.ok(preview.warnings.some(warning => warning.includes(`${predecessor.key} → ${selected.key}`) && warning.includes('2026-11-19')), JSON.stringify(preview.warnings));
  assert.ok(preview.warnings.some(warning => warning.includes(`${selected.key} → ${successor.key}`) && warning.includes('2026-11-25')), JSON.stringify(preview.warnings));
  assert.deepEqual(await f.workspace(), before);

  const body = { expectedVersion: selected.version, schedulePreviewId: preview.previewId, ...nextDates, status: 'in_progress' };
  await f.call(400, issuePath(selected), 'PATCH', { ...body, title: '' });
  assert.deepEqual(await f.workspace(), before);

  const db = new DatabaseSync(join(f.dataDir, 'donefac.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_reviewed_ticket_save BEFORE UPDATE OF json ON issues
      WHEN json_extract(NEW.json,'$.title')='일정 검토 후 저장 에러'
      BEGIN SELECT RAISE(ABORT,'synthetic issue schedule write failure'); END`);
    await f.call(500, issuePath(selected), 'PATCH', { ...body, title: '일정 검토 후 저장 에러' });
    assert.deepEqual(await f.workspace(), before);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_reviewed_ticket_save');
    db.close();
  }

  const saved = await f.call<Issue>(200, issuePath(selected), 'PATCH', { ...body, title: '일정과 함께 저장한 제목' });
  assert.deepEqual(dates(saved), nextDates);
  assert.equal(saved.title, '일정과 함께 저장한 제목');
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.version, selected.version + 1);
  const after = await f.workspace();
  assert.deepEqual(after.issues.filter(issue => issue.id !== selected.id), before.issues.filter(issue => issue.id !== selected.id));
  assert.deepEqual(after.dependencies, before.dependencies);
  assert.deepEqual(after.teamScheduleBlockers, before.teamScheduleBlockers);
  assert.deepEqual(after.activities.filter(activity => !before.activities.some(prior => prior.id === activity.id))
    .map(({ resourceId, actorId, action }) => ({ resourceId, actorId, action })), [
    { resourceId: selected.id, actorId, action: '티켓 변경' },
  ]);
  const history = await f.call<IssueChangeHistoryPage>(200, `${issuePath(selected)}/change-history`);
  const entry = history.entries.find(item => item.issueVersion === saved.version);
  assert.equal(entry?.actorId, actorId);
  assert.ok(entry?.changes.some(change => change.field === 'dueDate' && change.after.value === nextDates.dueDate));
});

test('ticket save replays the current result without a second write, and fences native restore', async t => {
  const f = await fixture(t);
  const ticket = await f.createIssue('티켓 저장 결과를 다시 확인할 업무');
  const another = await f.createIssue('다른 티켓');
  const before = await f.workspace();
  const changes = { ...dates(ticket), endDate: '2026-11-23' };
  const review = await f.review(ticket, changes);
  const input = { expectedVersion: ticket.version, requestId: randomUUID(), expectedRestoreGeneration: before.restoreGeneration,
    schedulePreviewId: review.previewId, ...changes, title: '검토한 업무를 저장' };
  const path = issuePath(ticket);
  const db = new DatabaseSync(join(f.dataDir, 'donefac.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_ticket_save_receipt BEFORE INSERT ON issue_save_requests
      BEGIN SELECT RAISE(ABORT,'synthetic ticket save receipt failure'); END`);
    await f.call(500, path, 'PATCH', input);
    assert.deepEqual(await f.workspace(), before);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_ticket_save_receipt');
    db.close();
  }

  const [first, replay] = await Promise.all([f.call<Issue>(200, path, 'PATCH', input), f.call<Issue>(200, path, 'PATCH', input)]);
  assert.deepEqual(replay, first);
  assert.equal(first.version, ticket.version + 1);
  assert.equal(first.endDate, changes.endDate);
  await f.call(409, path, 'PATCH', { ...input, title: '다른 입력' });
  await f.call(409, issuePath(another), 'PATCH', input);
  await f.call(409, path, 'PATCH', input, { 'X-Actor-Id': otherActorId });
  const current = await f.edit(first, { description: '다음 버전에서 추가한 설명' }, otherActorId);
  assert.deepEqual(await f.call<Issue>(200, path, 'PATCH', input), current);
  const history = await f.call<IssueChangeHistoryPage>(200, `${path}/change-history`);
  assert.deepEqual(history.entries.map(entry => entry.issueVersion), [current.version, first.version]);

  const backup = await f.call<WorkspaceSnapshot>(200, '/export');
  await f.call(200, '/import', 'POST', { data: backup });
  const restored = await f.workspace();
  assert.notEqual(restored.restoreGeneration, before.restoreGeneration);
  await f.call(409, path, 'PATCH', input);
  const restoredIssue = restored.issues.find(issue => issue.id === ticket.id)!;
  await f.call(409, path, 'PATCH', { ...input, expectedRestoreGeneration: restored.restoreGeneration, expectedVersion: restoredIssue.version });
  assert.deepEqual((await f.workspace()).issues.find(issue => issue.id === ticket.id), restoredIssue);
});

test('ticket schedule save rejects drift in an unedited predecessor, new edge and cross-project successor calendar', async t => {
  const f = await fixture(t);
  const destination = await f.project('OTHER', '후행 프로젝트');
  let prior = await f.createIssue('다른 작업자가 편집할 선행 업무', { startDate: '2026-11-17', endDate: '2026-11-18' });
  const hidden = await f.createIssue('나중에 연결될 선행 업무', { startDate: '2026-11-18', endDate: '2026-11-18' });
  const chosen = await f.createIssue('일정을 검토한 업무');
  const target = await f.createIssue('다른 프로젝트 차단 대상', { startDate: '2026-11-24', endDate: '2026-11-25' }, destination.id);
  await f.link(prior, chosen);
  await f.addBlocker(chosen, target);
  const nextDates = { ...dates(chosen), startDate: '2026-11-19', endDate: '2026-11-23' };

  async function assertStale(previewId: string) {
    const before = await f.workspace();
    const rejected = await f.call<StalePreviewError>(409, issuePath(chosen), 'PATCH', {
      expectedVersion: chosen.version, ...nextDates, title: '아직 저장하지 않은 제목', schedulePreviewId: previewId,
    });
    assert.equal(rejected.details?.reason, 'schedule_preview_stale');
    assert.deepEqual(await f.workspace(), before);
  }

  let preview = await f.review(chosen, nextDates);
  assert.deepEqual(preview.warnings, []);
  prior = await f.edit(prior, { endDate: '2026-11-19' }, otherActorId);
  await assertStale(preview.previewId);

  preview = await f.review(chosen, nextDates);
  assert.ok(preview.warnings.some(warning => warning.includes(prior.key) && warning.includes('2026-11-20')));
  await f.link(hidden, chosen);
  await assertStale(preview.previewId);

  preview = await f.review(chosen, nextDates);
  await f.setHoliday(destination.id, '2026-11-24');
  await assertStale(preview.previewId);
  const current = await f.review(chosen, nextDates);
  assert.ok(current.warnings.some(warning => warning.includes(target.key) && warning.includes('2026-11-25')));
  const saved = await f.call<Issue>(200, issuePath(chosen), 'PATCH', {
    expectedVersion: chosen.version, ...nextDates, title: '최신 검토와 함께 저장', schedulePreviewId: current.previewId,
  });
  assert.deepEqual(dates(saved), nextDates);
  assert.equal(saved.title, '최신 검토와 함께 저장');
});

test('ticket schedule proofs bind one actor, ticket and dates while ordinary API callers keep their update path', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('검토한 업무');
  const other = await f.createIssue('검토하지 않은 업무');
  const due = { ...dates(issue), dueDate: '2026-11-25' };

  const noOp = await f.call<SchedulePreview>(200, previewPath(issue), 'POST', { expectedVersion: issue.version, ...dates(issue) });
  assert.deepEqual(noOp.changes, []);
  assert.deepEqual(noOp.warnings, []);
  assert.equal(noOp.previewId, undefined);
  await f.call(400, previewPath(issue), 'POST', { expectedVersion: issue.version, startDate: null, endDate: null });
  const invalid = await f.call<SchedulePreview>(200, previewPath(issue), 'POST', {
    expectedVersion: issue.version, ...due, startDate: '2026-11-21',
  });
  assert.ok(invalid.blocking?.length);
  assert.equal(invalid.previewId, undefined);

  const preview = await f.review(issue, due);
  assert.equal(preview.changes[0]?.toDue, due.dueDate);
  const { token } = await f.call<ApiKeyCreated>(201, '/api-keys', 'POST', {
    name: '합성 프로젝트 쓰기 키', access: 'write', projectIds: [f.primary.id],
  });
  const authorization = { Authorization: `Bearer ${token}` };
  const body = { expectedVersion: issue.version, ...due, schedulePreviewId: preview.previewId };
  const before = await f.workspace();
  await f.call(400, issuePath(issue), 'PATCH', { ...body, schedulePreviewId: [preview.previewId] });
  const attempts: { path: string; body: unknown; headers: Record<string, string> }[] = [
    { path: issuePath(issue), body: { ...body, schedulePreviewId: randomUUID() }, headers: {} },
    { path: issuePath(issue), body, headers: { 'X-Actor-Id': otherActorId } },
    { path: issuePath(other), body: { ...body, expectedVersion: other.version }, headers: {} },
    { path: issuePath(issue), body: { ...body, dueDate: '2026-11-26' }, headers: {} },
    { path: issuePath(issue), body: { ...body, status: 'in_progress' }, headers: {} },
  ];
  for (const attempt of attempts) {
    const error = await f.call<StalePreviewError>(409, attempt.path, 'PATCH', attempt.body, attempt.headers);
    assert.equal(error.details?.reason, 'schedule_preview_stale');
  }
  await f.call(404, '/schedule/manual-apply', 'POST', { previewId: preview.previewId });
  await f.call(403, `/v1${previewPath(issue)}`, 'POST', { expectedVersion: issue.version, ...due }, authorization);
  await f.call(403, `/v1${issuePath(issue)}`, 'PATCH', body, authorization);
  assert.deepEqual(await f.workspace(), before);

  const saved = await f.call<Issue>(200, issuePath(issue), 'PATCH', body);
  const reused = await f.call<StalePreviewError>(409, issuePath(issue), 'PATCH', {
    ...body, expectedVersion: saved.version, title: '오래된 증명으로 바꾸는 제목',
  });
  assert.equal(reused.details?.reason, 'schedule_preview_stale');

  const legacy = await f.call<Issue>(200, `/v1${issuePath(other)}`, 'PATCH', {
    expectedVersion: other.version, endDate: '2026-11-23', title: '기존 자동화의 일정 수정',
  }, authorization);
  assert.equal(legacy.endDate, '2026-11-23');
  assert.equal(legacy.title, '기존 자동화의 일정 수정');
  const renamed = await f.edit(saved, { title: '일반 제목 수정' });
  assert.deepEqual(dates(renamed), due);
});

test('an automatic transition deadline is reviewed and committed with the ordinary workflow rules', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T16:30:00Z') });
  const f = await fixture(t);
  const workflowPath = `/projects/${f.primary.id}/workflow`;
  const workflow = await f.call<ProjectWorkflow>(200, workflowPath);
  await f.call<ProjectWorkflow>(200, workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, defaultDueWorkdays: 1 } : status),
    transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review'
      ? { ...edge, requiredFields: ['description', 'dueDate'] } : edge),
  });
  const original = await f.createIssue('검토 상태 자동 마감일');
  const nextDates = { ...dates(original), endDate: '2026-11-24' };
  const preview = await f.review(original, nextDates, 'review');
  assert.equal(preview.changes[0]?.toDue, '2026-11-23');
  const body = { expectedVersion: original.version, startDate: nextDates.startDate, endDate: nextDates.endDate,
    status: 'review', schedulePreviewId: preview.previewId };
  const before = await f.workspace();
  await f.call(422, issuePath(original), 'PATCH', body);
  assert.deepEqual(await f.workspace(), before);
  t.mock.timers.setTime(Date.parse(preview.expiresAt) + 1);
  const expired = await f.call<StalePreviewError>(409, issuePath(original), 'PATCH', { ...body, description: '검토 근거' });
  assert.equal(expired.details?.reason, 'schedule_preview_stale');
  assert.deepEqual(await f.workspace(), before);
  const current = await f.review(original, nextDates, 'review');
  const saved = await f.call<Issue>(200, issuePath(original), 'PATCH', {
    ...body, schedulePreviewId: current.previewId, description: '검토 근거',
  });
  assert.equal(saved.status, 'review');
  assert.equal(saved.dueDate, preview.changes[0]?.toDue);
  assert.equal(saved.endDate, nextDates.endDate);
});
