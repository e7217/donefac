import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import {
  ISSUE_BULK_EDIT_LIMIT, ISSUE_BULK_LABEL_LIMIT, ISSUE_BULK_LABEL_MAX_LENGTH, type Issue, type IssueAssignmentRule, type IssueAssignmentRunPage, type IssueBulkEditChanges,
  type IssueBulkEditPreview, type IssueBulkEditResult, type ProjectWorkflow, type TeamNotificationPage,
  type WebhookDelivery, type WebhookEndpointCreated, type WebhookEnvelope, type WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const otherProjectId = 'project-team';
const editor = 'user-min';
const reviewer = 'user-seo';
const alternate = 'user-yun';
const rulesPath = `/projects/${projectId}/assignment-rules`;
const runsPath = `/projects/${projectId}/assignment-runs`;
const workflowPath = `/projects/${projectId}/workflow`;
const bulkPath = (project = projectId) => `/projects/${project}/issues/bulk`;
const issueFields = ({ status, priority, assigneeId }: Issue) => ({ status, priority, assigneeId });
const issueVersions = (issues: Issue[]) => issues.map(({ id, version }) => ({ id, expectedVersion: version }));

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-issue-bulk-edit-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false });
    const listener = runtime.app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    let running = true;
    return {
      url: `http://127.0.0.1:${address.port}/api`,
      async close() {
        if (!running) return;
        running = false;
        await new Promise<void>(resolve => listener.close(() => resolve()));
        runtime.close();
      },
    };
  }
  let service = await start();
  const database = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
  t.after(async () => {
    database.close();
    await service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = editor) {
    const response = await fetch(service.url + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function expectStatus<T>(status: number, path: string, method = 'GET', body?: unknown, actor = editor) {
    const result = await call<T>(path, method, body, actor);
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  }
  function snapshot() { return expectStatus<WorkspaceSnapshot>(200, '/workspace'); }
  function runs() { return expectStatus<IssueAssignmentRunPage>(200, runsPath); }
  function inbox() { return expectStatus<TeamNotificationPage>(200, '/notifications', 'GET', undefined, reviewer); }
  function deliveries() { return expectStatus<WebhookDelivery[]>(200, '/webhook-deliveries'); }
  function createIssue(title: string, fields: Partial<Issue> = {}) {
    return expectStatus<Issue>(201, '/issues', 'POST', { title, projectId, status: 'todo', priority: 'medium', ...fields });
  }
  function createRule() {
    return expectStatus<IssueAssignmentRule>(201, rulesPath, 'POST', {
      name: '합성 검토 배정', enabled: true, fromStatuses: ['todo'], toStatusId: 'review', issueTypes: [],
      assigneeId: reviewer, mode: 'unassigned', priority: 10,
    });
  }
  async function requireForReview(requiredFields: ProjectWorkflow['transitions'][number]['requiredFields']) {
    const workflow = await expectStatus<ProjectWorkflow>(200, workflowPath);
    return expectStatus<ProjectWorkflow>(200, workflowPath, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review' ? { ...edge, requiredFields } : edge),
    });
  }
  async function enableEndpoint() {
    const { endpoint } = await expectStatus<WebhookEndpointCreated>(201, '/webhook-endpoints', 'POST', {
      name: '합성 일괄 편집 수신처', url: 'http://127.0.0.1:9/receiver', eventTypes: ['issue.updated'], projectIds: [projectId],
    });
    await expectStatus(200, `/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  function preview(issues: Issue[], changes: IssueBulkEditChanges) {
    return expectStatus<IssueBulkEditPreview>(200, `${bulkPath()}-preview`, 'POST', { issues: issueVersions(issues), changes });
  }
  function apply(previewId: string, actor = editor, project = projectId) {
    return call<IssueBulkEditResult>(`${bulkPath(project)}-apply`, 'POST', { previewId }, actor);
  }
  async function restart() {
    await service.close();
    service = await start();
  }
  return { call, expectStatus, createIssue, createRule, requireForReview, enableEndpoint, database, snapshot, deliveries, runs, inbox, preview, apply, restart };
}

test('bulk review shows blocked and unchanged rows, assigns automatically, and replays the exact receipt after restart', async t => {
  const f = await fixture(t);
  const eligible = await f.createIssue('다음 단계 검토', { description: '검토 대상' });
  const invalid = await f.createIssue('설명이 없는 항목');
  const unchanged = await f.createIssue('이미 검토 중', { status: 'review', priority: 'high', assigneeId: reviewer });
  await f.requireForReview(['assigneeId', 'description']);
  const rule = await f.createRule();
  await f.enableEndpoint();

  const before = await f.snapshot();
  const inboxBefore = await f.inbox();
  const changes = { status: 'review', priority: 'high' } as const;
  const mixed = await f.preview([eligible, invalid, unchanged], changes);
  assert.deepEqual({ id: mixed.previewId, changed: mixed.changed, blocked: mixed.blocked, unchanged: mixed.unchanged }, {
    id: null, changed: 1, blocked: 1, unchanged: 1,
  });
  const byId = new Map(mixed.rows.map(row => [row.id, row]));
  assert.equal(byId.get(eligible.id)?.outcome, 'changed');
  assert.deepEqual(byId.get(eligible.id)?.before, issueFields(eligible));
  assert.deepEqual(byId.get(eligible.id)?.after, { status: 'review', priority: 'high', assigneeId: reviewer });
  assert.equal(byId.get(invalid.id)?.outcome, 'blocked');
  assert.equal(byId.get(invalid.id)?.after, null);
  assert.match(byId.get(invalid.id)?.reason || '', /설명|description/);
  assert.equal(byId.get(unchanged.id)?.outcome, 'unchanged');
  assert.equal((await f.preview([unchanged], changes)).previewId, null);

  const manualClear = await f.preview([eligible], { ...changes, assigneeId: null });
  assert.equal(manualClear.previewId, null);
  assert.equal(manualClear.blocked, 1);
  assert.match(manualClear.rows[0].reason || '', /담당자|assigneeId/);

  const valid = await f.preview([eligible, unchanged], changes);
  assert.ok(valid.previewId);
  assert.ok(valid.expiresAt);
  assert.equal((await f.apply(valid.previewId, reviewer)).status, 404);
  assert.equal((await f.apply(valid.previewId, editor, otherProjectId)).status, 404);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.inbox(), inboxBefore);
  assert.deepEqual(await f.deliveries(), []);
  assert.equal((await f.runs()).total, 0);

  const result = await f.apply(valid.previewId);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data, { previewId: valid.previewId, updated: [{ id: eligible.id, key: eligible.key, version: eligible.version + 1 }], unchanged: 1 });
  const after = await f.snapshot();
  const changed = after.issues.find(issue => issue.id === eligible.id);
  assert.ok(changed);
  assert.deepEqual(issueFields(changed), byId.get(eligible.id)?.after);
  assert.deepEqual(after.issues.find(issue => issue.id === unchanged.id), unchanged);
  assert.deepEqual(after.issues.find(issue => issue.id === invalid.id), invalid);

  const history = await f.runs();
  assert.equal(history.total, 1);
  assert.deepEqual(history.items.map(run => [run.ruleId, run.issueId, run.actorId, run.outcome]), [[rule.id, eligible.id, editor, 'assigned']]);
  const assigned = (await f.inbox()).items.filter(item => item.targetId === eligible.id);
  assert.deepEqual(assigned.map(item => [item.kind, item.actorId]), [['issue-assigned', editor]]);
  const events = await f.deliveries();
  assert.equal(events.length, 1);
  const { envelope } = await f.expectStatus<{ envelope: WebhookEnvelope }>(200, `/webhook-deliveries/${events[0].id}`);
  assert.equal(envelope.resource.id, eligible.id);
  assert.equal(envelope.resource.version, eligible.version + 1);
  assert.deepEqual(envelope.changedFields.sort(), ['assigneeId', 'priority', 'status']);

  assert.deepEqual(await f.apply(valid.previewId), result);
  await f.restart();
  assert.deepEqual(await f.apply(valid.previewId), result);
  assert.equal((await f.apply(valid.previewId, reviewer)).status, 404);
  assert.deepEqual(await f.snapshot(), after);
  assert.deepEqual(await f.runs(), history);
  assert.deepEqual(await f.deliveries(), events);
  const backup = await f.expectStatus(200, '/export');
  assert.ok(!JSON.stringify(backup).includes(valid.previewId));
  await f.expectStatus(200, '/import', 'POST', { data: backup });
  assert.equal((await f.apply(valid.previewId)).status, 404);
});

test('bulk due dates and label edits preserve unrelated labels and replay the same applied receipt', async t => {
  const f = await fixture(t);
  const dueDate = '2026-12-18';
  const first = await f.createIssue('첫 라벨 구성', { labels: ['alpha', '독립', 'old', 'legacy,tag', ' old '], dueDate: '2026-11-27' });
  const second = await f.createIssue('두 번째 라벨 구성', { labels: ['beta', 'Alpha', 'old'] });
  const unchanged = await f.createIssue('이미 같은 변경', { labels: ['유지', 'new', 'Alpha'], dueDate });
  const outside = await f.createIssue('선택하지 않은 업무', { labels: ['old'], dueDate: '2026-11-30' });
  const chosen = [first, second, unchanged];
  const changes = { dueDate, removeLabels: ['old', 'legacy,tag', ' old '], addLabels: ['new', 'Alpha'] };
  const expectedLabels = [['alpha', '독립', 'new', 'Alpha'], ['beta', 'Alpha', 'new'], unchanged.labels];
  await f.enableEndpoint();
  const before = await f.snapshot();
  const reviewed = await f.preview(chosen, changes);
  assert.ok(reviewed.previewId);
  assert.equal(reviewed.changed, 2);
  assert.equal(reviewed.unchanged, 1);
  assert.equal(reviewed.blocked, 0);
  assert.deepEqual(reviewed.rows.map(({ before }) => [before.dueDate, before.labels]), chosen.map(issue => [issue.dueDate, issue.labels]));
  assert.deepEqual(reviewed.rows.map(({ after }) => [after?.dueDate, after?.labels]), expectedLabels.map(labels => [dueDate, labels]));
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.deliveries(), []);

  const receipt = await f.apply(reviewed.previewId);
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.data.updated.map(({ id, version }) => [id, version]), [first, second].map(issue => [issue.id, issue.version + 1]));
  assert.equal(receipt.data.unchanged, 1);
  const updated = await f.snapshot();
  const issues = new Map(updated.issues.map(issue => [issue.id, issue]));
  assert.deepEqual(chosen.map(issue => [issues.get(issue.id)?.dueDate, issues.get(issue.id)?.labels]), expectedLabels.map(labels => [dueDate, labels]));
  assert.deepEqual(issues.get(unchanged.id), unchanged);
  assert.deepEqual(issues.get(outside.id), outside);
  const deliveries = await f.deliveries();
  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    const { envelope } = await f.expectStatus<{ envelope: WebhookEnvelope }>(200, `/webhook-deliveries/${delivery.id}`);
    assert.deepEqual(envelope.changedFields.sort(), ['dueDate', 'labels']);
  }
  await f.restart();
  assert.deepEqual(await f.apply(reviewed.previewId), receipt);
  assert.deepEqual(await f.snapshot(), updated);
  assert.deepEqual(await f.deliveries(), deliveries);

  const updatedFirst = issues.get(first.id)!;
  const clear = await f.preview([updatedFirst], { dueDate: null });
  assert.ok(clear.previewId);
  assert.deepEqual(clear.rows[0].after, { ...issueFields(updatedFirst), dueDate: null });
  assert.equal((await f.apply(clear.previewId)).status, 200);
  const cleared = await f.snapshot();
  assert.equal(cleared.issues.find(issue => issue.id === first.id)?.dueDate, null);
  assert.deepEqual(cleared.issues.find(issue => issue.id === first.id)?.labels, expectedLabels[0]);
  assert.deepEqual(cleared.issues.find(issue => issue.id === second.id), issues.get(second.id));
});

test('bulk due dates and label removals honor workflow requirements and reject ambiguous operations', async t => {
  const f = await fixture(t);
  const date = '2026-11-30';
  const first = await f.createIssue('라벨을 일부 제거', { dueDate: date, labels: ['old', 'keep'] });
  const second = await f.createIssue('라벨이 필요한 업무', { dueDate: date, labels: ['old'] });
  await f.requireForReview(['dueDate', 'labels']);
  const before = await f.snapshot();
  const remove = await f.preview([first, second], { status: 'review', removeLabels: ['old'] });
  assert.equal(remove.previewId, null);
  assert.equal(remove.changed, 1);
  assert.equal(remove.blocked, 1);
  assert.deepEqual(remove.rows[0].after?.labels, ['keep']);
  assert.equal(remove.rows[1].after, null);
  const clear = await f.preview([first, second], { status: 'review', dueDate: null });
  assert.equal(clear.previewId, null);
  assert.equal(clear.blocked, 2);
  assert.ok(clear.rows.every(({ after, reason }) => after === null && /마감일|dueDate/u.test(reason ?? '')));

  const previewPath = `${bulkPath()}-preview`;
  for (const changes of [{ dueDate: '2026-02-29' }, { dueDate: '' }, { addLabels: [] }, { removeLabels: 'old' },
    { addLabels: ['dup', 'dup'] }, { addLabels: ['old'], removeLabels: ['old'] }, { labels: [] },
    { addLabels: ['a'.repeat(ISSUE_BULK_LABEL_MAX_LENGTH + 1)] },
    { removeLabels: Array.from({ length: ISSUE_BULK_LABEL_LIMIT + 1 }, (_, index) => `label-${index}`) }]) {
    await f.expectStatus(400, previewPath, 'POST', { issues: issueVersions([first]), changes });
  }
  const noChange = await f.preview([first], { dueDate: date, addLabels: ['keep'], removeLabels: ['missing'] });
  assert.equal(noChange.previewId, null);
  assert.equal(noChange.unchanged, 1);
  assert.deepEqual(await f.snapshot(), before);
});

test('issue and rule changes invalidate reviewed batches and project-scoped validation rejects foreign and duplicate targets', async t => {
  const f = await fixture(t);
  const original = await f.createIssue('상태 변경 검토');
  const second = await f.createIssue('함께 변경할 업무');
  const foreign = await f.createIssue('다른 프로젝트 업무', { projectId: otherProjectId });
  const changes = { status: 'review', priority: 'urgent' } as const;
  const previewPath = `${bulkPath()}-preview`;
  const rule = await f.createRule();

  assert.equal((await f.call(previewPath, 'POST', { issues: issueVersions([original, foreign]), changes })).status, 404);
  assert.equal((await f.call(previewPath, 'POST', { issues: issueVersions([original, original]), changes })).status, 400);
  assert.equal((await f.call(previewPath, 'POST', { issues: issueVersions([original]), changes: { description: '지원하지 않는 입력' } })).status, 400);
  assert.equal((await f.call(previewPath, 'POST', { issues: issueVersions([original]), changes: { priority: 'sometimes' } })).status, 400);
  const tooMany = Array.from({ length: ISSUE_BULK_EDIT_LIMIT + 1 }, () => ({ id: randomUUID(), expectedVersion: 1 }));
  assert.equal((await f.call(previewPath, 'POST', { issues: tooMany, changes })).status, 400);

  const stale = await f.preview([original, second], changes);
  assert.ok(stale.previewId);
  const edited = await f.expectStatus<Issue>(200, `/issues/${second.id}`, 'PATCH', { expectedVersion: second.version, title: '다른 작업자가 수정함' });
  const stateAfterEdit = await f.snapshot();
  assert.equal((await f.apply(stale.previewId)).status, 409);
  assert.equal((await f.call(previewPath, 'POST', { issues: issueVersions([original, second]), changes })).status, 409);
  assert.deepEqual(await f.snapshot(), stateAfterEdit);

  const guarded = await f.preview([original, edited], changes);
  assert.ok(guarded.previewId);
  await f.expectStatus(200, `${rulesPath}/${rule.id}`, 'PATCH', { expectedVersion: rule.version, assigneeId: alternate });
  const stateAfterRule = await f.snapshot();
  assert.equal((await f.apply(guarded.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), stateAfterRule);
  assert.equal((await f.runs()).total, 0);

  const reviewedBeforeWorkflowChange = await f.preview([original], changes);
  assert.ok(reviewedBeforeWorkflowChange.previewId);
  const workflow = await f.expectStatus<ProjectWorkflow>(200, workflowPath);
  await f.expectStatus(200, workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, label: '팀 검토' } : status),
  });
  const stateAfterWorkflow = await f.snapshot();
  assert.equal((await f.apply(reviewedBeforeWorkflowChange.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), stateAfterWorkflow);

  const revised = await f.preview([original, edited], { ...changes, assigneeId: null });
  assert.ok(revised.previewId);
  assert.ok(revised.rows.every(row => row.after?.assigneeId === null));
  assert.equal((await f.apply(revised.previewId)).status, 200);
  const after = await f.snapshot();
  for (const issue of [original, edited]) {
    assert.deepEqual(issueFields(after.issues.find(item => item.id === issue.id)!), { ...changes, assigneeId: null });
  }
  assert.deepEqual(after.issues.find(issue => issue.id === foreign.id), foreign);
});

test('a new or reopened blocker invalidates an otherwise current bulk review without committing any row', async t => {
  const f = await fixture(t);
  const target = await f.createIssue('차단 상태를 검토할 업무');
  const other = await f.createIssue('정상 일괄 검토 업무');
  let source = await f.createIssue('다른 프로젝트 선행 업무', { projectId: otherProjectId });
  const workflow = await f.expectStatus<ProjectWorkflow>(200, workflowPath);
  await f.expectStatus(200, workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review'
      ? { ...edge, requireResolvedBlockers: true } : edge),
  });

  const changes = { status: 'review', priority: 'urgent' } as const;
  const beforeLink = await f.preview([target, other], changes);
  assert.ok(beforeLink.previewId);
  await f.expectStatus(201, `/issues/${source.id}/relations`, 'POST', {
    otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
  });
  const blockedReview = await f.preview([target, other], changes);
  assert.equal(blockedReview.previewId, null);
  assert.equal(blockedReview.blocked, 1);
  assert.equal(blockedReview.changed, 1);
  assert.equal(blockedReview.rows[0].id, target.id);
  assert.match(blockedReview.rows[0].reason ?? '', /열린 차단 업무/u);
  assert.ok(!JSON.stringify(blockedReview).includes(source.key));
  const afterLink = await f.snapshot();
  assert.equal((await f.apply(beforeLink.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), afterLink);

  const sourceStatus = (status: 'done' | 'todo') => f.expectStatus<Issue>(200, `/issues/${source.id}`, 'PATCH', {
    status, expectedVersion: source.version,
  });
  source = await sourceStatus('done');
  const beforeReopen = await f.preview([target, other], changes);
  assert.ok(beforeReopen.previewId);
  source = await sourceStatus('todo');
  const afterReopen = await f.snapshot();
  assert.equal((await f.apply(beforeReopen.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), afterReopen);

  await sourceStatus('done');
  const reviewed = await f.preview([target, other], changes);
  assert.ok(reviewed.previewId);
  const applied = await f.apply(reviewed.previewId);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.updated.length, 2);
  const after = await f.snapshot();
  for (const { id, version } of [target, other]) {
    const issue = after.issues.find(item => item.id === id)!;
    assert.equal(issue.version, version + 1);
    assert.deepEqual(issueFields(issue), { ...changes, assigneeId: null });
  }
});

test('a late database error rolls back the whole bulk edit with each side effect and permits the same reviewed batch to retry', async t => {
  const f = await fixture(t);
  const first = await f.createIssue('첫 번째 적용 기록');
  const second = await f.createIssue('두 번째 적용 기록');
  await f.createRule();
  await f.enableEndpoint();
  const proposed = await f.preview([first, second], { status: 'review' });
  assert.ok(proposed.previewId);
  const before = await f.snapshot();
  const inboxBefore = await f.inbox();

  f.database.exec(`CREATE TRIGGER reject_second_assignment BEFORE INSERT ON issue_assignment_runs
    WHEN (SELECT COUNT(*) FROM issue_assignment_runs) > 0
    BEGIN SELECT RAISE(ABORT, 'synthetic second assignment failure'); END;`);
  assert.equal((await f.apply(proposed.previewId)).status, 500);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.inbox(), inboxBefore);
  assert.deepEqual(await f.deliveries(), []);
  assert.equal((await f.runs()).total, 0);

  f.database.exec('DROP TRIGGER reject_second_assignment');
  const [applied, duplicate] = await Promise.all([f.apply(proposed.previewId), f.apply(proposed.previewId)]);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(duplicate, applied);
  assert.deepEqual(new Map(applied.data.updated.map(issue => [issue.id, issue.version])), new Map([
    [first.id, first.version + 1], [second.id, second.version + 1],
  ]));
  assert.equal((await f.runs()).total, 2);
  assert.equal((await f.deliveries()).length, 2);
  assert.deepEqual(await f.apply(proposed.previewId), applied);
});
