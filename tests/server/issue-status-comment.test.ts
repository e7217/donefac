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
  Project, ProjectWorkflow, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types.js';

const writer = 'user-min';
const assignee = 'user-seo';
const reporter = 'user-jun';
const mentionedUser = 'user-yun';
type TransitionError = { details?: { reason?: string; currentVersion?: number; requiredFields?: string[] } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-issue-status-comment-'));
  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
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
  return { call, dataDir, project, workflowPath, workspace, createIssue, update, requestFor, path, transition, comments, history, live, inbox };
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
  for (const comment of [{ body: '   ' }, { body: 'x', mentions: [{ userId: assignee, from: 0, to: 1 }] }]) {
    await f.call(400, f.path(other), 'POST', await f.requestFor(other, { comment }));
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
