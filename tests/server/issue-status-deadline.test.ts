import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, AutomationPreview, AutomationRule, Issue, IssueAssignmentPreview, IssueBulkEditChanges, IssueBulkEditPreview,
  IssueBulkEditResult, IssueChangeHistoryPage, ProjectWorkflow, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const workflowPath = `/projects/${projectId}/workflow`;
const calendarPath = `/projects/${projectId}/calendar`;
const bulkPath = `/projects/${projectId}/issues/bulk`;
const review = (workflow: ProjectWorkflow) => workflow.statuses.find(status => status.id === 'review')!;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-status-deadline-'));
  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const listener = runtime.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function expectStatus<T = unknown>(code: number, path: string, method = 'GET', body?: unknown,
    headers: Record<string, string> = {}) {
    const response = await fetch(baseUrl + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, code, JSON.stringify(data));
    return data;
  }
  function readWorkflow() { return expectStatus<ProjectWorkflow>(200, workflowPath); }
  async function saveWorkflow(workflow: ProjectWorkflow) {
    return expectStatus<ProjectWorkflow>(200, workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version });
  }
  async function setReviewDeadline(days: number | null, requiredFields: ProjectWorkflow['transitions'][number]['requiredFields'] = []) {
    const workflow = await readWorkflow();
    return saveWorkflow({ ...workflow,
      statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, defaultDueWorkdays: days } : status),
      transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review' ? { ...edge, requiredFields } : edge),
    });
  }
  async function setCalendar(workingWeekdays: number[], exceptions: WorkCalendar['exceptions']) {
    const calendar = await expectStatus<WorkCalendar>(200, calendarPath);
    return expectStatus<WorkCalendar>(200, calendarPath, 'PATCH', { ...calendar, expectedVersion: calendar.version, workingWeekdays, exceptions });
  }
  function createIssue(title: string, fields: Partial<Issue> = {}) {
    return expectStatus<Issue>(201, '/issues', 'POST', { projectId, title, ...fields });
  }
  function update(issue: Issue, fields: Partial<Issue>, code = 200) {
    return expectStatus<Issue>(code, `/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, ...fields });
  }
  async function readIssue(id: string) { return (await expectStatus<WorkspaceSnapshot>(200, '/workspace')).issues.find(issue => issue.id === id); }
  function preview(issues: Issue[], changes: IssueBulkEditChanges) {
    return expectStatus<IssueBulkEditPreview>(200, `${bulkPath}-preview`, 'POST', {
      issues: issues.map(issue => ({ id: issue.id, expectedVersion: issue.version })), changes,
    });
  }
  return { expectStatus, readWorkflow, saveWorkflow, setReviewDeadline, setCalendar, createIssue, update, readIssue, preview };
}

test('transition deadlines use the Seoul day and project workday exceptions before required-field validation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T16:30:00.000Z') });
  const f = await fixture(t);
  const workflow = await f.setReviewDeadline(2, ['dueDate', 'description']);
  await f.setCalendar([1, 3, 4, 5], [
    { date: '2026-11-21', isWorking: true, label: '상태를 바꾼 서울 토요일' },
    { date: '2026-11-23', isWorking: false, label: '프로젝트 휴무' },
    { date: '2026-11-24', isWorking: true, label: '화요일 추가 근무' },
  ]);
  const original = await f.createIssue('자동으로 검토 마감일 지정', { startDate: '2026-11-23', endDate: '2026-11-26' });
  assert.equal(original.dueDate, null);
  const failed = await f.expectStatus<{ details: { requiredFields: string[] } }>(422, `/issues/${original.id}`, 'PATCH', {
    expectedVersion: original.version, status: 'review',
  });
  assert.deepEqual(failed.details.requiredFields, ['description']);
  assert.deepEqual(await f.readIssue(original.id), original);

  const { token } = await f.expectStatus<ApiKeyCreated>(201, '/api-keys', 'POST', {
    name: '합성 프로젝트 쓰기 키', access: 'write', projectIds: [projectId],
  });
  const second = await f.expectStatus<Issue>(200, `/v1/issues/${original.id}`, 'PATCH', {
    expectedVersion: original.version, expectedWorkflowVersion: workflow.version, status: 'review', description: '검토 근거',
  }, { Authorization: `Bearer ${token}` });
  assert.equal(second.status, 'review');
  assert.equal(second.dueDate, '2026-11-25');
  assert.equal(second.startDate, original.startDate);
  assert.equal(second.endDate, original.endDate);

  const history = await f.expectStatus<IssueChangeHistoryPage>(200, `/issues/${original.id}/change-history`);
  const entry = history.entries.find(item => item.issueVersion === second.version);
  assert.equal(entry?.origin, 'user');
  assert.equal(entry?.actorId, actorId);
  const deadline = entry?.changes.find(change => change.field === 'dueDate');
  assert.equal(deadline?.before.value, null);
  assert.equal(deadline?.after.value, '2026-11-25');
});

test('manual dates, same-state edits, initial creation and administrative status migration keep their deadline semantics', async t => {
  const f = await fixture(t);
  const configured = await f.setReviewDeadline(1);
  const workflow = await f.saveWorkflow({ ...configured, initialStatusId: 'review', statuses: [
    ...configured.statuses, { id: 'retired_review', label: '이전 검토', color: '#6789ab', category: 'review' },
  ] });
  const created = await f.createIssue('검토 상태에서 새로 만든 업무');
  assert.equal(created.status, 'review');
  assert.equal(created.dueDate, null);
  const unchanged = await f.update(created, { status: 'review', title: '같은 상태에서 수정' });
  assert.equal(unchanged.dueDate, null);

  const dueDate = '2026-12-07';
  const dated = await f.createIssue('이미 마감일이 있는 업무', { status: 'todo', dueDate });
  assert.equal((await f.update(dated, { status: 'review' })).dueDate, dueDate);
  const explicit = await f.createIssue('상태와 수동 마감일을 함께 수정', { status: 'todo' });
  assert.equal((await f.update(explicit, { status: 'review', dueDate })).dueDate, dueDate);
  const clear = await f.createIssue('상태를 바꾸며 날짜를 지운 업무', { status: 'todo', dueDate });
  const cleared = await f.update(clear, { status: 'review', dueDate: null });
  assert.equal(cleared.status, 'review');
  assert.equal(cleared.dueDate, null);
  const explicitBlank = await f.createIssue('빈 날짜를 명시한 전이', { status: 'todo' });
  assert.equal((await f.update(explicitBlank, { status: 'review', dueDate: null })).dueDate, null);

  const migrated = await f.createIssue('마감일 미정인 이전 상태 업무', { status: 'retired_review' });
  const preview = await f.expectStatus<IssueBulkEditPreview>(200, `${workflowPath}/status-migration-preview`, 'POST', {
    fromStatusId: 'retired_review', toStatusId: 'review', expectedWorkflowVersion: workflow.version,
  });
  assert.ok(preview.previewId);
  await f.expectStatus(200, `${workflowPath}/status-migration-apply`, 'POST', { previewId: preview.previewId });
  const after = await f.readIssue(migrated.id);
  assert.equal(after?.status, 'review');
  assert.equal(after?.dueDate, null);
});

test('bulk status preview shows the derived due date and protects the reviewed result across Seoul midnight and calendar edits', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-22T14:59:59.000Z') });
  const f = await fixture(t);
  await f.setReviewDeadline(2);
  const ticket = await f.createIssue('일괄 검토 전이');
  const initial = await f.preview([ticket], { status: 'review' });
  assert.ok(initial.previewId);
  assert.equal(initial.rows[0].before.dueDate, null);
  assert.equal(initial.rows[0].after?.dueDate, '2026-11-24');
  assert.deepEqual(await f.readIssue(ticket.id), ticket);

  t.mock.timers.setTime(Date.parse('2026-11-22T15:00:00.000Z'));
  await f.expectStatus(409, `${bulkPath}-apply`, 'POST', { previewId: initial.previewId });
  const beforeCalendarEdit = await f.preview([ticket], { status: 'review' });
  assert.ok(beforeCalendarEdit.previewId);
  assert.equal(beforeCalendarEdit.rows[0].after?.dueDate, '2026-11-25');

  await f.setCalendar([1, 2, 3, 4, 5], [{ date: '2026-11-25', isWorking: false, label: '검토 기한의 휴무' }]);
  await f.expectStatus(409, `${bulkPath}-apply`, 'POST', { previewId: beforeCalendarEdit.previewId });
  assert.deepEqual(await f.readIssue(ticket.id), ticket);
  const current = await f.preview([ticket], { status: 'review' });
  assert.ok(current.previewId);
  assert.equal(current.rows[0].after?.dueDate, '2026-11-26');
  const apply = () => f.expectStatus<IssueBulkEditResult>(200, `${bulkPath}-apply`, 'POST', { previewId: current.previewId });
  const saved = await apply();
  assert.deepEqual(await apply(), saved);
  assert.equal((await f.readIssue(ticket.id))?.dueDate, '2026-11-26');
});

test('assignment preview and GitLab automation share automatic due date validation and audit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-23T02:00:00.000Z') });
  const f = await fixture(t);
  await f.setReviewDeadline(1, ['dueDate']);
  await f.expectStatus(200, '/integrations/gitlab', 'PATCH', {
    expectedVersion: 1, baseUrl: 'http://gitlab.synthetic.test', projectIds: [42], webhookSecret: 'synthetic-deadline-secret',
  });
  const issue = await f.createIssue('GitLab 병합 시 검토 기한');
  const assignment = await f.expectStatus<IssueAssignmentPreview>(200, `/projects/${projectId}/assignment-rules/preview`, 'POST', {
    rule: { name: '검토 담당자 미리보기', enabled: false, fromStatuses: ['todo'], toStatusId: 'review', issueTypes: [],
      assigneeId: actorId, mode: 'unassigned', priority: 10 },
    issueIds: [issue.id],
  });
  assert.equal(assignment.outcomes[0].outcome, 'assigned');
  const rule = await f.expectStatus<AutomationRule>(201, '/automation-rules', 'POST', {
    projectId, name: '병합 시 검토', trigger: 'merge_request.merged', enabled: true, gitlabProjectIds: [42],
    branchPattern: 'feature/*', issueTypes: [], fromStatuses: ['todo'], toStatusId: 'review', actorId, priority: 100,
  });
  const branch = `feature/${issue.key}`;
  const preview = await f.expectStatus<AutomationPreview>(200, '/automation/preview', 'POST', {
    rule, issueIds: [issue.id], sample: { trigger: 'merge_request.merged', gitlabProjectId: 42, branch },
  });
  assert.equal(preview.outcomes[0].outcome, 'changed');
  assert.deepEqual(await f.readIssue(issue.id), issue);
  await f.expectStatus(200, '/integrations/gitlab/webhook', 'POST', {
    object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
      id: 110, iid: 110, action: 'merge', state: 'merged', title: `${issue.key} 합성 이슈`, source_branch: branch,
      url: 'http://gitlab.synthetic.test/-/merge_requests/110', updated_at: new Date().toISOString(),
    },
  }, { 'X-Gitlab-Token': 'synthetic-deadline-secret' });
  const moved = await f.readIssue(issue.id);
  assert.equal(moved?.status, 'review');
  assert.equal(moved?.dueDate, '2026-11-24');
  const history = await f.expectStatus<IssueChangeHistoryPage>(200, `/issues/${issue.id}/change-history`);
  const change = history.entries.find(item => item.issueVersion === moved?.version);
  assert.equal(change?.origin, 'automation');
  assert.equal(change?.actorId, actorId);
  assert.equal(change?.changes.find(field => field.field === 'dueDate')?.after.value, moved?.dueDate);
});

test('workflow deadline settings validate and preserve old clients and native format 92 backups', async t => {
  const f = await fixture(t);
  type Backup = WorkspaceSnapshot & { schemaVersion: number };
  const previous = await f.expectStatus<Backup>(200, '/export');
  const configured = await f.setReviewDeadline(3650);
  assert.equal(review(configured).defaultDueWorkdays, 3650);
  for (const invalid of [0, -1, 0.5, 3651, '3', true, {}]) {
    await f.expectStatus(400, workflowPath, 'PATCH', { ...configured, expectedVersion: configured.version,
      statuses: configured.statuses.map(status => status === review(configured) ? { ...status, defaultDueWorkdays: invalid } : status),
    });
  }
  assert.deepEqual(await f.readWorkflow(), configured);
  const oldClient = await f.saveWorkflow({ ...configured,
    statuses: configured.statuses.map(({ id, label, category, color }) => ({ id, label, category, color })).reverse(),
  });
  assert.equal(review(oldClient).defaultDueWorkdays, 3650);
  const exported = await f.expectStatus<Backup>(200, '/export');
  assert.equal(exported.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const mislabeled = await f.expectStatus<{ error: string }>(400, '/import', 'POST', { data: { ...exported, schemaVersion: 92 } });
  assert.match(mislabeled.error, /schemaVersion 93/u);
  assert.deepEqual(await f.readWorkflow(), oldClient);

  assert.equal(Object.hasOwn(review(await f.setReviewDeadline(null)), 'defaultDueWorkdays'), false);
  await f.expectStatus(200, '/import', 'POST', { data: { ...previous, schemaVersion: 92 } });
  assert.equal(Object.hasOwn(review(await f.readWorkflow()), 'defaultDueWorkdays'), false);
  await f.expectStatus(200, '/import', 'POST', { data: { ...exported, schemaVersion: 93 } });
  const restored = await f.readWorkflow();
  assert.equal(review(restored).defaultDueWorkdays, 3650);
  assert.ok(restored.version > oldClient.version);
});
