import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, AutomationRule, Issue, IssueAssignmentPreview, IssueAssignmentRule, IssueAssignmentRuleInput, IssueAssignmentRunPage,
  IssueChangeHistoryEntry, IssueChangeHistoryPage,
  ProjectIssueOrder, ProjectWorkflow, TeamNotification, TeamNotificationPage, WebhookDelivery, WebhookEndpointCreated,
  WebhookEnvelope, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const projectPath = `/projects/${projectId}`;
const rulesPath = `${projectPath}/assignment-rules`;
const runsPath = `${projectPath}/assignment-runs`;
const target = 'user-seo';
const editor = 'user-min';
const headersFor = (actorId: string) => ({ 'X-Actor-Id': actorId });
type Backup = WorkspaceSnapshot & {
  schemaVersion: number; issueAssignmentRules: IssueAssignmentRule[]; teamNotifications: TeamNotification[]; issueChangeHistory: IssueChangeHistoryEntry[];
};

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-issue-assignment-'));
  const runtime = createApp({ dataDir: dir, outboundWorker: false });
  const listener = runtime.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const observer = new Store(dir);
  t.after(async () => {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    runtime.close();
    observer.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function expectStatus<T>(status: number, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const response = await call<T>(path, method, body, headers);
    assert.equal(response.status, status, JSON.stringify(response.data));
    return response.data;
  }
  function ruleInput(overrides: Partial<IssueAssignmentRuleInput> = {}): IssueAssignmentRuleInput {
    return {
      name: '검토 담당자 배정', enabled: true, fromStatuses: ['todo'], toStatusId: 'review', issueTypes: [],
      assigneeId: target, mode: 'unassigned', priority: 10, ...overrides,
    };
  }
  function createRule(overrides: Partial<IssueAssignmentRuleInput> = {}) {
    return expectStatus<IssueAssignmentRule>(201, rulesPath, 'POST', ruleInput(overrides));
  }
  function createIssue(title: string, overrides: Partial<Issue> = {}) {
    return expectStatus<Issue>(201, '/issues', 'POST', { projectId, title, status: 'todo', ...overrides });
  }
  async function setWorkflowRequirements(fields: ProjectWorkflow['transitions'][number]['requiredFields'], to = 'review') {
    const path = `${projectPath}/workflow`;
    const workflow = await expectStatus<ProjectWorkflow>(200, path);
    assert.ok(workflow.transitions.some(edge => edge.from === 'todo' && edge.to === to));
    return expectStatus<ProjectWorkflow>(200, path, 'PATCH', {
      ...workflow, expectedVersion: workflow.version,
      transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === to ? { ...edge, requiredFields: fields } : edge),
    });
  }
  async function enableEndpoint() {
    const { endpoint } = await expectStatus<WebhookEndpointCreated>(201, '/webhook-endpoints', 'POST', {
      name: '합성 상태 이벤트 수신처', url: 'http://127.0.0.1:9/receiver', eventTypes: ['issue.updated'], projectIds: [projectId],
    });
    await expectStatus(200, `/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  async function envelope() {
    const deliveries = await expectStatus<WebhookDelivery[]>(200, '/webhook-deliveries');
    assert.equal(deliveries.length, 1);
    return (await expectStatus<{ envelope: WebhookEnvelope }>(200, `/webhook-deliveries/${deliveries[0].id}`)).envelope;
  }
  return {
    call, expectStatus, ruleInput, createRule, createIssue, setWorkflowRequirements, enableEndpoint, envelope, observer,
    runs: () => expectStatus<IssueAssignmentRunPage>(200, runsPath),
    snapshot: () => expectStatus<WorkspaceSnapshot>(200, '/workspace'),
    inbox: (user: string) => expectStatus<TeamNotificationPage>(200, '/notifications', 'GET', undefined, headersFor(user)),
    update: (issue: Issue, fields: Partial<Issue>) => call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, ...fields }, headersFor(editor)),
  };
}

test('preview and a direct status edit apply assignment before validating required workflow fields', async t => {
  const f = await fixture(t);
  const eligible = await f.createIssue('검토할 업무', { description: '검토 요청' });
  const missing = await f.createIssue('설명이 없는 업무');
  await f.setWorkflowRequirements(['assigneeId', 'description']);
  const rule = await f.createRule();
  await f.enableEndpoint();

  const before = await f.snapshot();
  const preview = await f.expectStatus<IssueAssignmentPreview>(200, `${rulesPath}/preview`, 'POST', {
    rule: f.ruleInput({ enabled: false }), issueIds: [eligible.id, missing.id],
  });
  const eligibleOutcome = preview.outcomes.find(outcome => outcome.issueId === eligible.id);
  assert.equal(eligibleOutcome?.outcome, 'assigned');
  assert.equal(eligibleOutcome.assigneeId, target);
  assert.equal(eligibleOutcome.fromStatusId, 'todo');
  assert.equal(eligibleOutcome.toStatusId, 'review');
  const blocked = preview.outcomes.find(outcome => outcome.issueId === missing.id);
  assert.equal(blocked?.outcome, 'blocked');
  assert.match(blocked.reason, /설명|description/);
  assert.deepEqual(await f.snapshot(), before);

  const failed = await f.update(missing, { status: 'review' });
  assert.equal(failed.status, 422, JSON.stringify(failed.data));
  assert.match(JSON.stringify(failed.data), /설명|description/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.runs()).total, 0);
  assert.deepEqual(await f.expectStatus(200, '/webhook-deliveries'), []);
  assert.deepEqual((await f.inbox(target)).items, []);

  // The issue editor submits all fields, including its unchanged current assignee.
  const updated = await f.update(eligible, { status: 'review', assigneeId: eligible.assigneeId });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.status, 'review');
  assert.equal(updated.data.assigneeId, target);
  assert.equal(updated.data.version, eligible.version + 1);
  const runs = await f.runs();
  assert.equal(runs.total, 1);
  assert.deepEqual(runs.items.map(run => ({
    ruleId: run.ruleId, issueId: run.issueId, issueVersion: run.issueVersion, source: run.source, actorId: run.actorId,
    sourceEventId: run.sourceEventId, previousAssigneeId: run.previousAssigneeId, assigneeId: run.assigneeId, outcome: run.outcome,
  })), [{
    ruleId: rule.id, issueId: eligible.id, issueVersion: updated.data.version, source: 'user', actorId: editor,
    sourceEventId: null, previousAssigneeId: null, assigneeId: target, outcome: 'assigned',
  }]);
  const event = await f.envelope();
  assert.deepEqual(event.changedFields.sort(), ['assigneeId', 'status']);
  assert.equal(event.resource.id, eligible.id);
  assert.equal(event.resource.version, updated.data.version);
  assert.equal(event.actorId, editor);
  assert.equal(event.origin, 'user');
  const activity = (await f.snapshot()).activities.filter(item => item.resourceId === eligible.id && item.action === '담당자 자동 배정');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].actorId, editor);
  assert.ok(activity[0].detail.includes(rule.name));
  assert.deepEqual((await f.inbox(target)).items.map(item => [item.kind, item.actorId, item.targetId]), [
    ['issue-assigned', editor, eligible.id],
  ]);
});

test('rule priority preserves current assignees and manual changes and ignores non-transitions', async t => {
  const f = await fixture(t);
  const existing = await f.createIssue('기존 담당자 보존', { assigneeId: 'user-jun' });
  const clearing = await f.createIssue('직접 담당자 해제', { assigneeId: 'user-jun' });
  const manual = await f.createIssue('직접 담당자 지정');
  const unchanged = await f.createIssue('변경할 상태 없음');
  const foreign = await f.createIssue('다른 프로젝트', { projectId: 'project-team' });
  const lower = await f.createRule({ name: '후순위 덮어쓰기', mode: 'replace', assigneeId: 'user-yun', priority: 50 });
  const first = await f.createRule();

  const preserved = await f.update(existing, { status: 'review' });
  assert.equal(preserved.status, 200, JSON.stringify(preserved.data));
  assert.equal(preserved.data.assigneeId, 'user-jun');
  const disabled = await f.expectStatus<IssueAssignmentRule>(200, `${rulesPath}/${first.id}`, 'PATCH', { expectedVersion: first.version, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal((await f.call(`${rulesPath}/${first.id}`, 'PATCH', { expectedVersion: first.version, enabled: true })).status, 409);

  const cleared = await f.update(clearing, { status: 'review', assigneeId: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.assigneeId, null);
  const selected = await f.update(manual, { status: 'review', assigneeId: 'user-jun' });
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  assert.equal(selected.data.assigneeId, 'user-jun');
  const sameStatus = await f.update(unchanged, { title: '현재 상태 수정', status: unchanged.status });
  assert.equal(sameStatus.status, 200, JSON.stringify(sameStatus.data));
  assert.equal(sameStatus.data.assigneeId, null);
  const otherProject = await f.update(foreign, { status: 'review' });
  assert.equal(otherProject.status, 200, JSON.stringify(otherProject.data));
  assert.equal(otherProject.data.assigneeId, null);
  assert.equal((await f.createIssue('검토 상태에서 신규 생성', { status: 'review' })).assigneeId, null);

  const runs = await f.runs();
  assert.equal(runs.total, 3);
  const byIssue = new Map(runs.items.map(run => [run.issueId, run]));
  assert.equal(byIssue.get(existing.id)?.ruleId, first.id);
  assert.equal(byIssue.get(existing.id)?.outcome, 'skipped');
  for (const issue of [clearing, manual]) {
    assert.equal(byIssue.get(issue.id)?.ruleId, lower.id);
    assert.equal(byIssue.get(issue.id)?.outcome, 'skipped');
  }
  await f.expectStatus(200, `${rulesPath}/${first.id}?expectedVersion=${disabled.version}`, 'DELETE');
  assert.deepEqual((await f.expectStatus<IssueAssignmentRule[]>(200, rulesPath)).map(rule => rule.id), [lower.id]);
});

test('guarded status edits distinguish explicit unchanged or empty assignees from automatic assignment', async t => {
  const f = await fixture(t);
  const same = await f.createIssue('상태와 함께 현재 담당자를 명시', { assigneeId: 'user-jun' });
  const empty = await f.createIssue('상태와 함께 미지정을 명시');
  const automatic = await f.createIssue('담당자 자동 배정 유지', { assigneeId: 'user-jun' });
  const rule = await f.createRule({ mode: 'replace' });
  const required = await f.setWorkflowRequirements(['assigneeId']);

  function move<T>(issue: Issue, workflowVersion: number, selection: { assigneeId?: string | null } = {}) {
    return f.call<T>(`/issues/${issue.id}`, 'PATCH', {
      expectedVersion: issue.version, expectedWorkflowVersion: workflowVersion, status: 'review', ...selection,
    }, headersFor(editor));
  }

  const before = await f.snapshot();
  const stale = await move<{ details: unknown }>(same, required.version - 1, { assigneeId: 'user-yun' });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.details, { reason: 'workflow_changed', currentWorkflowVersion: required.version });
  const missing = await move<{ details: unknown }>(empty, required.version, { assigneeId: null });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.data.details, { requiredFields: ['assigneeId'] });
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.runs()).total, 0);
  assert.deepEqual((await f.inbox(target)).items, []);

  const selected = await move<Issue>(same, required.version, { assigneeId: same.assigneeId });
  assert.equal(selected.status, 200);
  assert.equal(selected.data.assigneeId, same.assigneeId);
  assert.equal(selected.data.status, 'review');
  assert.equal(selected.data.version, same.version + 1);
  const assigned = await move<Issue>(automatic, required.version);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.assigneeId, target);

  const optional = await f.setWorkflowRequirements([]);
  const unassigned = await move<Issue>(empty, optional.version, { assigneeId: null });
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.data.assigneeId, null);
  assert.equal(unassigned.data.status, 'review');
  assert.equal(unassigned.data.version, empty.version + 1);

  const runs = await f.runs();
  assert.equal(runs.total, 3);
  const byIssue = new Map(runs.items.map(run => [run.issueId, run]));
  for (const issue of [selected.data, unassigned.data, assigned.data]) {
    const run = byIssue.get(issue.id);
    assert.equal(run?.ruleId, rule.id);
    assert.equal(run.assigneeId, issue.assigneeId);
    assert.equal(run.outcome, issue.id === automatic.id ? 'assigned' : 'skipped');
  }
});

test('board and scoped API status changes share assignment while native import restores disabled definitions', async t => {
  const f = await fixture(t);
  const board = await f.createIssue('보드에서 옮길 업무', { assigneeId: 'user-jun' });
  const integration = await f.createIssue('API로 옮길 업무');
  const afterImport = await f.createIssue('복원한 뒤 옮길 업무');
  const rule = await f.createRule({ mode: 'replace' });
  const order = await f.expectStatus<ProjectIssueOrder>(200, `${projectPath}/issue-order`);
  const moved = await f.expectStatus<{ issue: Issue }>(200, `${projectPath}/issue-order`, 'PATCH', {
    issueId: board.id, expectedVersion: order.version, expectedIssueVersion: board.version,
    anchorId: null, position: 'after', status: 'review',
  }, headersFor(editor));
  assert.equal(moved.issue.assigneeId, target);
  assert.equal(moved.issue.version, board.version + 1);
  const boardHistory = await f.expectStatus<IssueChangeHistoryPage>(200, `/issues/${board.id}/change-history`);
  assert.equal(boardHistory.entries.length, 1);
  assert.equal(boardHistory.entries[0].actorId, editor);
  assert.deepEqual(new Map(boardHistory.entries[0].changes.map(change => [change.field, change.after.value])),
    new Map([['assigneeId', target], ['status', 'review']]));

  const key = await f.expectStatus<ApiKeyCreated>(201, '/api-keys', 'POST', {
    name: '합성 업무 쓰기', access: 'write', projectIds: [projectId], expiresAt: null,
  }, headersFor('user-jun'));
  const keyHeaders = { Authorization: `Bearer ${key.token}`, ...headersFor('user-yun') };
  assert.equal((await f.call(`/v1${rulesPath}`, 'POST', f.ruleInput(), keyHeaders)).status, 403);
  const apiEdit = await f.expectStatus<Issue>(200, `/v1/issues/${integration.id}`, 'PATCH', { expectedVersion: integration.version, status: 'review' }, keyHeaders);
  assert.equal(apiEdit.assigneeId, target);
  assert.equal(apiEdit.version, integration.version + 1);
  const history = await f.runs();
  assert.equal(history.total, 2);
  assert.deepEqual(history.items.map(run => [run.issueId, run.actorId]).sort(), [[board.id, editor], [integration.id, 'user-jun']].sort());
  const page = await f.expectStatus<IssueAssignmentRunPage>(200, `${runsPath}?offset=1&limit=1`);
  assert.equal(page.total, 2);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.items.map(run => run.id), [history.items[1].id]);

  const backup = await f.expectStatus<Backup>(200, '/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.issueAssignmentRules, [rule]);
  assert.ok(!JSON.stringify(backup).includes(history.items[0].id));
  await f.expectStatus(200, '/import', 'POST', { data: backup });
  const restored = await f.expectStatus<IssueAssignmentRule[]>(200, rulesPath);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, rule.id);
  assert.equal(restored[0].enabled, false);
  assert.ok(restored[0].version > rule.version);
  assert.equal((await f.runs()).total, 0);

  const current = (await f.snapshot()).issues.find(issue => issue.id === afterImport.id);
  assert.ok(current);
  const updated = await f.update(current, { status: 'review' });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.assigneeId, null);
  assert.equal((await f.runs()).total, 0);

  const previousSchema: Partial<Backup> = { ...backup, schemaVersion: 31, teamNotifications: backup.teamNotifications.map(item =>
    item.kind === 'issue-status-changed' ? { ...item, detail: undefined } : item) };
  delete previousSchema.issueAssignmentRules;
  delete previousSchema.issueChangeHistory;
  await f.expectStatus(200, '/import', 'POST', { data: previousSchema });
  assert.deepEqual(await f.expectStatus(200, rulesPath), []);
});

test('an authenticated GitLab transition applies a required assignee once and can retry after run storage fails', async t => {
  const f = await fixture(t);
  const issue = await f.createIssue('GitLab으로 완료할 업무');
  await f.setWorkflowRequirements(['assigneeId'], 'done');
  const rule = await f.createRule({ name: '완료 담당자 배정', toStatusId: 'done' });
  await f.enableEndpoint();
  const secret = 'synthetic-assignment-inbound-secret';
  const baseUrl = 'http://gitlab.synthetic.test';
  await f.expectStatus(200, '/integrations/gitlab', 'PATCH', { expectedVersion: 1, baseUrl, projectIds: [42], webhookSecret: secret });
  await f.expectStatus<AutomationRule>(201, '/automation-rules', 'POST', {
    projectId, name: '병합 후 완료', trigger: 'merge_request.merged', enabled: true, gitlabProjectIds: [42],
    branchPattern: 'feature/*', issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: 'user-jun', priority: 100,
  });
  const body = { object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
    id: 467, iid: 467, action: 'merge', state: 'merged', title: `${issue.key} synthetic`,
    source_branch: `feature/${issue.key}`, url: `${baseUrl}/-/merge_requests/467`, updated_at: new Date().toISOString(),
  } };
  const webhookId = randomUUID();
  const hook = () => f.call<{ duplicate?: boolean }>('/integrations/gitlab/webhook', 'POST', body, { 'X-Gitlab-Token': secret, 'webhook-id': webhookId });
  const before = await f.snapshot();
  f.observer.db.exec("CREATE TRIGGER reject_assignment_run BEFORE INSERT ON issue_assignment_runs BEGIN SELECT RAISE(ABORT,'synthetic assignment run rejection'); END;");
  const failed = await hook();
  assert.equal(failed.status, 500, JSON.stringify(failed.data));
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.expectStatus(200, '/automation-runs'), []);
  assert.deepEqual(await f.expectStatus(200, '/webhook-deliveries'), []);
  const historyPath = `/issues/${issue.id}/change-history`;
  assert.deepEqual(await f.expectStatus<IssueChangeHistoryPage>(200, historyPath), { entries: [], nextBeforeVersion: null });
  assert.equal((await f.runs()).total, 0);
  assert.deepEqual((await f.inbox(target)).items, []);

  f.observer.db.exec('DROP TRIGGER reject_assignment_run');
  const success = await hook();
  assert.equal(success.status, 200, JSON.stringify(success.data));
  assert.notEqual(success.data.duplicate, true);
  const saved = (await f.snapshot()).issues.find(item => item.id === issue.id);
  assert.equal(saved?.version, issue.version + 1);
  assert.equal(saved.assigneeId, target);
  assert.equal(saved.status, 'done');
  assert.ok(saved.completedAt);

  const event = await f.envelope();
  assert.equal(event.origin, 'automation');
  assert.equal(event.actorId, 'user-jun');
  assert.ok(event.sourceEventId);
  assert.deepEqual(event.changedFields.sort(), ['assigneeId', 'completedAt', 'status']);
  const runs = await f.runs();
  assert.equal(runs.total, 1);
  assert.equal(runs.items[0].ruleId, rule.id);
  assert.equal(runs.items[0].source, 'gitlab');
  assert.equal(runs.items[0].sourceEventId, event.sourceEventId);
  assert.equal(runs.items[0].actorId, event.actorId);
  assert.equal(runs.items[0].issueVersion, event.resource.version);
  assert.deepEqual((await f.inbox(target)).items.map(item => [item.kind, item.actorId, item.targetId]), [
    ['issue-assigned', 'user-jun', issue.id],
  ]);
  assert.equal((await hook()).data.duplicate, true);
  assert.equal((await f.runs()).total, 1);
  assert.equal((await f.envelope()).id, event.id);
  const { entries } = await f.expectStatus<IssueChangeHistoryPage>(200, historyPath);
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].origin, entries[0].actorId, entries[0].issueVersion], ['automation', 'user-jun', saved.version]);
  assert.deepEqual(new Map(entries[0].changes.map(change => [change.field, change.after.value])),
    new Map([['assigneeId', target], ['status', 'done']]));
});
