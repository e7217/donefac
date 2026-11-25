import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, Comment, Issue, IssueChangeHistoryPage, IssueStatusChangeRequest, IssueStatusChangeResult,
  Project, ProjectIssueSchema, ProjectWorkflow, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types.js';

const writer = 'user-min';
const assignee = 'user-seo';
const reporter = 'user-jun';
const mentionedUser = 'user-yun';
type TransitionError = { details?: { reason?: string; currentVersion?: number; requiredFields?: string[] } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-issue-status-comment-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const listener = runtime.app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    return { runtime, listener, base: `http://127.0.0.1:${address.port}/api` };
  }
  let service = await start();
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    const { runtime, listener } = service;
    listener.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
    finally { runtime.close(); }
  }
  async function restart(beforeStart?: () => void) {
    await stop();
    beforeStart?.();
    service = await start();
    stopped = false;
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  async function call<T = unknown>(status: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': writer, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }

  const project = await call<Project>(201, '/projects', 'POST', { key: 'STATUS', name: '인수인계 검토' });
  const workflowPath = `/projects/${project.id}/workflow`;
  const workspace = () => call<WorkspaceSnapshot>(200, '/workspace');
  const createIssue = (title: string, fields: Partial<Issue> = {}) =>
    call<Issue>(201, '/issues', 'POST', { projectId: project.id, title, status: 'todo', ...fields });
  const update = (issue: Issue, changes: Partial<Issue>, actorId = writer) =>
    call<Issue>(200, `/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, ...changes }, { 'X-Actor-Id': actorId });
  async function requestFor(issue: Issue, options: Partial<IssueStatusChangeRequest> = {}): Promise<IssueStatusChangeRequest> {
    const [{ restoreGeneration }, workflow] = await Promise.all([workspace(), call<ProjectWorkflow>(200, workflowPath)]);
    assert.ok(restoreGeneration);
    return { requestId: randomUUID(), expectedVersion: issue.version, expectedWorkflowVersion: workflow.version,
      restoreGeneration, status: 'in_progress', comment: { body: '합성 인수인계 댓글' }, ...options };
  }
  const path = (issue: Issue) => `/issues/${issue.id}/status-change`;
  const transition = (issue: Issue, body: IssueStatusChangeRequest) => call<IssueStatusChangeResult>(200, path(issue), 'POST', body);
  const comments = (issue: Issue) => call<Comment[]>(200, `/comments?resourceType=issue&resourceId=${issue.id}`);
  const history = (issue: Issue) => call<IssueChangeHistoryPage>(200, `/issues/${issue.id}/change-history`);
  const live = async (issue: Issue) => (await workspace()).issues.find(current => current.id === issue.id);
  async function inbox(actorId: string, issue: Issue) {
    const { items } = await call<TeamNotificationPage>(200, '/notifications', 'GET', undefined, { 'X-Actor-Id': actorId });
    return items.filter(item => item.targetId === issue.id);
  }
  return { call, dataDir, project, workflowPath, workspace, createIssue, update, requestFor, path, transition, comments, history, live, inbox, restart };
}

test('a handoff saves status, assignee, an ordinary comment and notifications exactly once across retries', async t => {
  const beganAt = Date.parse('2026-11-20T16:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: beganAt });
  const f = await fixture(t);
  const issue = await f.createIssue('다음 담당자에게 넘길 업무', { reporterId: reporter });
  const before = await f.workspace();
  const member = before.users.find(user => user.id === mentionedUser);
  assert.ok(member);
  const prefix = '🔎 ';
  const mention = `@${member.name}`;
  const body = `${prefix}${mention} 다음 배포의 로그를 확인해 주세요.`;
  const mentions = [{ userId: member.id, from: prefix.length, to: prefix.length + mention.length }];
  const input = await f.requestFor(issue, { assigneeId: assignee, comment: { body: `  ${body}  `, mentions } });

  const firstResults = await Promise.all([f.transition(issue, input), f.transition(issue, input)]);
  const saved = firstResults.find(result => !result.duplicate);
  const replay = firstResults.find(result => result.duplicate);
  assert.ok(saved && replay);
  assert.deepEqual(replay.receipt, saved.receipt);
  assert.deepEqual(replay.issue, saved.issue);
  assert.deepEqual(saved.receipt, { requestId: input.requestId, issueId: issue.id, projectId: issue.projectId,
    appliedVersion: issue.version + 1, status: input.status, assigneeId: assignee, commentId: saved.receipt.commentId });
  assert.ok(saved.receipt.commentId);
  assert.equal(saved.issue.version, issue.version + 1);
  assert.equal(saved.issue.status, 'in_progress');
  assert.equal(saved.issue.assigneeId, assignee);
  const [comment] = await f.comments(issue);
  assert.deepEqual(await f.comments(issue), [{ id: saved.receipt.commentId, resourceType: 'issue', resourceId: issue.id,
    authorId: writer, body, mentions, createdAt: comment.createdAt }]);
  assert.deepEqual((await f.inbox(mentionedUser, issue)).map(({ kind, actorId, commentId }) => [kind, actorId, commentId]),
    [['issue-comment-mentioned', writer, comment.id]]);
  assert.deepEqual((await f.inbox(assignee, issue)).map(({ kind }) => kind).sort(), ['issue-assigned', 'issue-comment']);
  assert.deepEqual((await f.inbox(reporter, issue)).map(({ kind }) => kind).sort(), ['issue-comment', 'issue-status-changed']);
  assert.deepEqual(await f.inbox(writer, issue), []);

  const activities = (await f.workspace()).activities.filter(activity => !before.activities.some(prior => prior.id === activity.id));
  assert.ok(activities.every(activity => activity.resourceId === issue.id && activity.actorId === writer));
  assert.deepEqual(activities.map(activity => activity.action).sort(), ['댓글 작성', '티켓 변경'].sort());
  const { entries } = await f.history(issue);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].issueVersion, saved.issue.version);
  assert.equal(entries[0].actorId, writer);
  assert.deepEqual(Object.fromEntries(entries[0].changes.map(change => [change.field, change.after.value])), {
    status: 'in_progress', assigneeId: assignee,
  });

  const advanced = await f.update(saved.issue, { title: '새 담당자가 편집한 업무', status: 'review' }, assignee);
  // A historical mention should not need revalidation when verifying the saved request.
  await f.call(200, `/users/${mentionedUser}`, 'PATCH', { name: '새 표시 이름' });
  const beforeRetry = await f.workspace();
  const retried = await f.transition(issue, input);
  assert.deepEqual(retried, { duplicate: true, issue: advanced, receipt: saved.receipt });
  assert.deepEqual(await f.workspace(), beforeRetry);
  assert.deepEqual(await f.comments(issue), [comment]);
  assert.equal((await f.inbox(mentionedUser, issue)).length, 1);

  t.mock.timers.setTime(beganAt + 7 * 24 * 60 * 60 * 1000);
  const expired = await f.call<TransitionError>(409, f.path(issue), 'POST', input);
  assert.equal(expired.details?.currentVersion, advanced.version);
  assert.deepEqual(await f.comments(issue), [comment]);
});

test('status handoff merges typed field input and guards the issue schema before committing its receipt', async t => {
  const f = await fixture(t);
  const schemaPath = `/projects/${f.project.id}/issue-schema`;
  const baseline = await f.call<ProjectIssueSchema>(200, schemaPath);
  const fields = [
    { id: 'review_flag', name: '추가 확인 완료', kind: 'checkbox' },
    { id: 'review_count', name: '남은 확인 횟수', kind: 'number' },
    { id: 'review_reference', name: '참고 사항', kind: 'text' },
  ].map(field => ({ ...field, description: '', required: false, archived: false, issueTypes: [], options: [] }));
  const schema = await f.call<ProjectIssueSchema>(200, schemaPath, 'PATCH', { ...baseline, expectedVersion: baseline.version, fields });
  const workflow = await f.call<ProjectWorkflow>(200, f.workflowPath);
  await f.call(200, f.workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version, transitions: workflow.transitions.map(edge =>
    edge.from === 'todo' && edge.to === 'in_progress' ? { ...edge, requiredFields: ['description', 'custom:review_flag', 'custom:review_count'] } : edge) });
  const issue = await f.createIssue('속성을 보완해 인수인계할 업무', { customFields: { review_reference: '기존 참고 값' } });
  const input = await f.requestFor(issue, { assigneeId: assignee, description: '업무 설명 확정',
    customFields: { review_flag: false, review_count: 0 }, expectedIssueSchemaVersion: schema.version });
  await f.call(400, f.path(issue), 'POST', { ...input, expectedIssueSchemaVersion: undefined });
  const stale = await f.call<TransitionError>(409, f.path(issue), 'POST', { ...input, expectedIssueSchemaVersion: schema.version - 1 });
  assert.equal(stale.details?.reason, 'schema_changed');
  await f.call(400, f.path(issue), 'POST', { ...input, customFields: { review_flag: 'false', review_count: 0 } });
  assert.deepEqual(await f.live(issue), issue);
  assert.deepEqual(await f.comments(issue), []);

  const saved = await f.transition(issue, input);
  assert.deepEqual(saved.issue.customFields, { review_flag: false, review_count: 0, review_reference: '기존 참고 값' });
  assert.equal(saved.issue.description, input.description);
  assert.equal(saved.issue.status, input.status);
  assert.equal(saved.issue.assigneeId, assignee);
  assert.equal(saved.issue.version, issue.version + 1);
  assert.deepEqual((await f.comments(issue)).map(({ id }) => id), [saved.receipt.commentId]);
  const changedIntent = await f.call<TransitionError>(409, f.path(issue), 'POST', { ...input, customFields: { ...input.customFields, review_count: 1 } });
  assert.equal(changedIntent.details?.reason, 'request_reused');
  await f.call(200, schemaPath, 'PATCH', { ...schema, expectedVersion: schema.version, fields: schema.fields.map(field => ({ ...field, name: `${field.name} 수정` })) });
  assert.deepEqual(await f.transition(issue, input), { ...saved, duplicate: true });
  assert.deepEqual((await f.comments(issue)).map(({ id }) => id), [saved.receipt.commentId]);
});

test('plain status changes identify the exact request when the same actor submits identical edits', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('여러 탭에서 열어 둔 업무', { reporterId: reporter });
  const input = await f.requestFor(issue, { assigneeId: assignee, comment: undefined });
  const competing = { ...input, requestId: randomUUID() };
  const results = await Promise.all([f.transition(issue, input), f.transition(issue, input)]);
  const saved = results.find(result => !result.duplicate);
  const duplicate = results.find(result => result.duplicate);
  assert.ok(saved && duplicate);
  assert.deepEqual(saved.receipt, { requestId: input.requestId, issueId: issue.id, projectId: issue.projectId,
    appliedVersion: issue.version + 1, status: input.status, assigneeId: assignee, commentId: null });
  assert.deepEqual(duplicate, { ...saved, duplicate: true });

  const stale = await f.call<TransitionError>(409, f.path(issue), 'POST', competing);
  assert.equal(stale.details?.currentVersion, saved.issue.version);
  const changedIntent = await f.call<TransitionError>(409, f.path(issue), 'POST', { ...input, comment: { body: '다른 요청' } });
  assert.equal(changedIntent.details?.reason, 'request_reused');
  assert.deepEqual((await f.inbox(assignee, issue)).map(({ kind }) => kind), ['issue-assigned']);
  assert.deepEqual((await f.inbox(reporter, issue)).map(({ kind }) => kind), ['issue-status-changed']);

  const reassigned = await f.update(saved.issue, { assigneeId: null }, assignee);
  const beforeRetry = await f.workspace();
  assert.deepEqual(await f.transition(issue, input), { issue: reassigned, receipt: saved.receipt, duplicate: true });
  assert.deepEqual(await f.workspace(), beforeRetry);
  assert.deepEqual(await f.comments(issue), []);
  const history = (await f.history(issue)).entries;
  const statusEntries = history.filter(entry => entry.changes.some(change => change.field === 'status'));
  assert.deepEqual(statusEntries.map(({ actorId, issueVersion }) => [actorId, issueVersion]), [[writer, saved.issue.version]]);
});

test('one request proves its own actor and intent while stale, no-op and API-key attempts add no comments', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('한 번만 상태를 바꿀 업무');
  const other = await f.createIssue('다른 사람이 먼저 편집할 업무');
  const input = await f.requestFor(issue);
  const saved = await f.transition(issue, input);
  const before = await f.workspace();

  const mismatches: { path: string; body: IssueStatusChangeRequest; headers?: Record<string, string> }[] = [
    { path: f.path(issue), body: input, headers: { 'X-Actor-Id': assignee } },
    { path: f.path(other), body: input },
    { path: f.path(issue), body: { ...input, comment: { body: '다른 댓글 내용' } } },
    { path: f.path(issue), body: { ...input, comment: undefined } },
    { path: f.path(issue), body: { ...input, status: 'review' } },
    { path: f.path(issue), body: { ...input, assigneeId: null } },
  ];
  for (const attempt of mismatches) {
    const error = await f.call<TransitionError>(409, attempt.path, 'POST', attempt.body, attempt.headers);
    assert.equal(error.details?.reason, 'request_reused');
  }
  const noOp = await f.requestFor(saved.issue, { status: saved.issue.status });
  const unchanged = await f.call<TransitionError>(409, f.path(issue), 'POST', noOp);
  assert.equal(unchanged.details?.reason, 'status_unchanged');
  const staleWorkflow = await f.requestFor(other, { expectedWorkflowVersion: input.expectedWorkflowVersion + 1 });
  const workflowError = await f.call<TransitionError>(409, f.path(other), 'POST', staleWorkflow);
  assert.equal(workflowError.details?.reason, 'workflow_changed');
  const commentInput = await f.requestFor(other);
  for (const comment of [null, {}, { body: '   ' }, { body: 'x', mentions: [{ userId: assignee, from: 0, to: 1 }] }]) {
    await f.call(400, f.path(other), 'POST', { ...commentInput, comment });
  }
  assert.deepEqual(await f.workspace(), before);
  assert.equal((await f.comments(issue)).length, 1);
  assert.deepEqual(await f.comments(other), []);

  const secondInput = await f.requestFor(other, { assigneeId: assignee });
  const { token } = await f.call<ApiKeyCreated>(201, '/api-keys', 'POST', {
    name: '합성 프로젝트 쓰기 키', access: 'write', projectIds: [f.project.id],
  });
  const authorization = { Authorization: `Bearer ${token}` };
  await f.call(403, `/v1${f.path(other)}`, 'POST', secondInput, authorization);
  const matchingStatus = await f.call<Issue>(200, `/v1/issues/${other.id}`, 'PATCH', {
    expectedVersion: other.version, expectedWorkflowVersion: secondInput.expectedWorkflowVersion,
    status: secondInput.status, assigneeId: assignee,
  }, authorization);
  assert.equal(matchingStatus.status, secondInput.status);
  const competing = await f.call<TransitionError>(409, f.path(other), 'POST', secondInput, { 'X-Actor-Id': assignee });
  assert.equal(competing.details?.currentVersion, matchingStatus.version);
  assert.deepEqual(await f.comments(other), []);

  await f.call(200, `/issues/${issue.id}`, 'DELETE', { expectedVersion: saved.issue.version });
  const archived = await f.call<TransitionError>(409, f.path(issue), 'POST', input);
  assert.equal(archived.details?.reason, 'receipt_unavailable');
});

test('workflow validation and a late receipt write error roll back every side effect before a successful exact retry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T16:30:00Z') });
  const f = await fixture(t);
  const workflow = await f.call<ProjectWorkflow>(200, f.workflowPath);
  await f.call<ProjectWorkflow>(200, f.workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, defaultDueWorkdays: 1 } : status),
    transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review'
      ? { ...edge, requiredFields: ['description', 'dueDate'] } : edge),
  });
  const original = await f.createIssue('검토 요건과 마감일이 있는 업무', { reporterId: reporter });
  const request = await f.requestFor(original, { status: 'review', assigneeId: assignee });
  const blocked = await f.call<TransitionError>(422, f.path(original), 'POST', request);
  assert.deepEqual(blocked.details?.requiredFields, ['description']);
  assert.deepEqual(await f.live(original), original);
  assert.deepEqual(await f.comments(original), []);

  const ready = await f.update(original, { description: '필수 검토 근거' });
  const attempted = { ...request, expectedVersion: ready.version };
  const before = await f.workspace();
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_status_change_receipt BEFORE INSERT ON issue_status_change_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic late status change receipt failure'); END`);
    await f.call(500, f.path(ready), 'POST', attempted);
    assert.deepEqual(await f.workspace(), before);
    assert.deepEqual(await f.comments(ready), []);
    assert.deepEqual(await f.inbox(assignee, ready), []);
    assert.deepEqual(await f.inbox(reporter, ready), []);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_status_change_receipt');
    db.close();
  }

  const saved = await f.transition(ready, attempted);
  assert.equal(saved.duplicate, false);
  assert.equal(saved.issue.version, ready.version + 1);
  assert.equal(saved.issue.dueDate, '2026-11-23');
  assert.equal((await f.comments(ready))[0]?.id, saved.receipt.commentId);
  assert.equal((await f.transition(ready, attempted)).duplicate, true);
  assert.equal((await f.comments(ready)).length, 1);
});

test('status handoff validates priority and target dates, records explicit values, and preserves old receipts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T16:30:00Z') });
  const f = await fixture(t);
  const workflow = await f.call<ProjectWorkflow>(200, f.workflowPath);
  await f.call<ProjectWorkflow>(200, f.workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => ['in_progress', 'review'].includes(status.id) ? { ...status, defaultDueWorkdays: 1 } : status),
    transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review'
      ? { ...edge, requiredFields: ['dueDate'] } : edge),
  });
  const automatic = await f.createIssue('워크플로의 자동 날짜');
  const automaticInput = await f.requestFor(automatic, { status: 'review', comment: undefined });
  const automaticSaved = await f.transition(automatic, automaticInput);
  assert.equal(automaticSaved.issue.dueDate, '2026-11-23');
  assert.equal(Object.hasOwn(automaticSaved.receipt, 'dueDate'), false);
  await f.restart(() => {
    const database = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
    try { database.exec('ALTER TABLE issue_status_change_requests DROP COLUMN properties_json'); }
    finally { database.close(); }
  });
  assert.deepEqual(await f.transition(automatic, automaticInput), { ...automaticSaved, duplicate: true });

  const issue = await f.createIssue('팀에서 선택한 우선순위와 마감일');
  const input = await f.requestFor(issue, { status: 'review', priority: 'urgent', dueDate: '2026-12-01' });
  const before = await f.workspace();
  for (const changes of [{ priority: 'critical' }, { priority: null }, { dueDate: '' }, { dueDate: '2026-02-30' }]) {
    await f.call(400, f.path(issue), 'POST', { ...input, ...changes });
  }
  const missing = await f.call<TransitionError>(422, f.path(issue), 'POST', { ...input, dueDate: null });
  assert.deepEqual(missing.details?.requiredFields, ['dueDate']);
  assert.deepEqual(await f.workspace(), before);
  assert.deepEqual(await f.comments(issue), []);
  const saved = await f.transition(issue, input);
  assert.equal(saved.issue.dueDate, input.dueDate);
  assert.equal(saved.issue.priority, input.priority);
  assert.equal(saved.receipt.dueDate, input.dueDate);
  assert.equal(saved.receipt.priority, input.priority);
  assert.ok(saved.receipt.commentId);
  const { entries } = await f.history(issue);
  assert.deepEqual(Object.fromEntries(entries[0].changes.map(change => [change.field, change.after.value])),
    { status: 'review', dueDate: '2026-12-01', priority: 'urgent' });

  const peer = await f.update(saved.issue, { dueDate: '2026-12-03', priority: 'low' }, assignee);
  await f.restart();
  assert.deepEqual(await f.transition(issue, input), { issue: peer, receipt: saved.receipt, duplicate: true });
  for (const changes of [{ priority: 'high' }, { dueDate: '2026-12-03' }]) {
    const rejected = await f.call<TransitionError>(409, f.path(issue), 'POST', { ...input, ...changes });
    assert.equal(rejected.details?.reason, 'request_reused');
  }
  assert.deepEqual((await f.comments(issue)).map(comment => comment.id), [saved.receipt.commentId]);

  for (const date of [null, '2026-12-08']) {
    const clearIssue = await f.createIssue('명시적으로 목표 마감일을 비우는 업무', { dueDate: date });
    const clearInput = await f.requestFor(clearIssue, { dueDate: null, comment: undefined });
    const cleared = await f.transition(clearIssue, clearInput);
    assert.equal(cleared.issue.dueDate, null);
    assert.equal(cleared.receipt.dueDate, null);
    assert.deepEqual(await f.transition(clearIssue, clearInput), { ...cleared, duplicate: true });
  }
});

test('portable import preserves committed comments and rejects an outdated generation even with current versions', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('복원할 상태 변경 업무');
  const before = await f.call(200, '/export');
  const input = await f.requestFor(issue);
  const saved = await f.transition(issue, input);
  const [comment] = await f.comments(issue);
  assert.equal(comment.id, saved.receipt.commentId);
  const committed = await f.call(200, '/export');

  await f.call(200, '/import', 'POST', { data: committed });
  const stale = await f.call<TransitionError>(409, f.path(issue), 'POST', input);
  assert.equal(stale.details?.reason, 'workspace_changed');
  assert.deepEqual(await f.comments(issue), [comment]);
  assert.equal((await f.live(issue))?.status, saved.issue.status);

  await f.call(200, '/import', 'POST', { data: before });
  const restored = await f.live(issue);
  assert.ok(restored && restored.version > saved.issue.version);
  assert.deepEqual(restored, { ...issue, version: restored.version });
  const current = await f.requestFor(restored);
  assert.notEqual(current.restoreGeneration, input.restoreGeneration);
  const reverted = await f.call<TransitionError>(409, f.path(restored), 'POST', {
    ...current, requestId: input.requestId, restoreGeneration: input.restoreGeneration,
  });
  assert.equal(reverted.details?.reason, 'workspace_changed');
  assert.deepEqual(await f.live(restored), restored);
  assert.deepEqual(await f.comments(restored), []);

  const reapplied = await f.transition(restored, current);
  assert.equal(reapplied.duplicate, false);
  assert.notEqual(reapplied.receipt.commentId, saved.receipt.commentId);
  assert.deepEqual((await f.comments(issue)).map(row => row.id), [reapplied.receipt.commentId]);
});

test('portable import clears plain receipts and rejects retries from the replaced workspace generation', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('상태 전이를 복원할 업무');
  const backup = await f.call(200, '/export');
  const input = await f.requestFor(issue, { comment: undefined });
  const saved = await f.transition(issue, input);

  await f.call(200, '/import', 'POST', { data: backup });
  const restored = await f.live(issue);
  assert.ok(restored && restored.version > saved.issue.version);
  const stale = await f.call<TransitionError>(409, f.path(restored), 'POST', { ...input, expectedVersion: restored.version });
  assert.equal(stale.details?.reason, 'workspace_changed');
  assert.deepEqual(await f.live(restored), restored);

  const refreshed = await f.requestFor(restored, { requestId: input.requestId, comment: undefined });
  const reapplied = await f.transition(restored, refreshed);
  assert.equal(reapplied.duplicate, false);
  assert.equal(reapplied.receipt.commentId, null);
  assert.equal(reapplied.issue.version, restored.version + 1);
  assert.deepEqual(await f.comments(restored), []);
});
