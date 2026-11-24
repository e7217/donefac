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
  ISSUE_BULK_EDIT_LIMIT, ISSUE_BULK_LABEL_LIMIT, ISSUE_BULK_LABEL_MAX_LENGTH, type CustomFieldDefinition, type CustomFieldValue, type Issue, type IssueAssignmentRule, type IssueAssignmentRunPage, type IssueBulkEditChanges,
  type IssueBulkEditPreview, type IssueBulkEditResult, type IssueFieldBreakdown, type IssueFieldBreakdownPage, type ProjectIssueSchema, type ProjectWorkflow, type SavedView, type TeamNotificationPage,
  type TeamIssueBulkEditPreviewInput, type WebhookDelivery, type WebhookEndpointCreated, type WebhookEnvelope, type WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const otherProjectId = 'project-team';
const editor = 'user-min';
const reviewer = 'user-seo';
const alternate = 'user-yun';
const rulesPath = `/projects/${projectId}/assignment-rules`;
const runsPath = `/projects/${projectId}/assignment-runs`;
const workflowPath = `/projects/${projectId}/workflow`;
const schemaPath = `/projects/${projectId}/issue-schema`;
const bulkPath = (project = projectId) => `/projects/${project}/issues/bulk`;
const teamBulkPath = '/team/issues/bulk';
const issueFields = ({ status, priority, assigneeId }: Issue) => ({ status, priority, assigneeId });
const issueVersions = (issues: Issue[]) => issues.map(({ id, version }) => ({ id, expectedVersion: version }));
const parentLabel = ({ id, key, title }: Issue) => ({ id, key, title });

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
  function editIssue({ id, version }: Issue, fields: Partial<Issue>) {
    return expectStatus<Issue>(200, `/issues/${id}`, 'PATCH', { ...fields, expectedVersion: version });
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
  async function installFields(fields: CustomFieldDefinition[]) {
    const before = await expectStatus<ProjectIssueSchema>(200, schemaPath);
    return expectStatus<ProjectIssueSchema>(200, schemaPath, 'PATCH', { ...before, expectedVersion: before.version, fields });
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
  return { call, expectStatus, createIssue, editIssue, createRule, requireForReview, installFields, enableEndpoint, database, snapshot, deliveries, runs, inbox, preview, apply, restart };
}

function customField(id: string, name: string, kind: CustomFieldDefinition['kind'], options: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return { id, name, kind, archived: false, description: '', required: false, issueTypes: [], options: [], ...options };
}

test('project bulk parent review can make a selected ancestor and child siblings and clear their shared parent', async t => {
  const f = await fixture(t);
  const original = await f.createIssue('기존 상위 업무');
  const destination = await f.createIssue('새 공통 상위 업무');
  const ancestor = await f.editIssue(await f.createIssue('선택한 상위 업무'), { parentId: original.id });
  const child = await f.editIssue(await f.createIssue('선택한 하위 업무', { labels: ['유지'], description: '유지할 설명' }), { parentId: ancestor.id });
  const unchanged = await f.editIssue(await f.createIssue('이미 연결된 업무'), { parentId: destination.id });
  const before = await f.snapshot();

  const priorityOnly = await f.preview([child], { priority: 'high' });
  assert.equal(priorityOnly.rows[0].parents, undefined);
  assert.equal(Object.hasOwn(priorityOnly.rows[0].before, 'parentId'), false);
  assert.equal(Object.hasOwn(priorityOnly.rows[0].after!, 'parentId'), false);

  const first = await f.preview([child, ancestor, unchanged], { parentId: destination.id });
  assert.ok(first.previewId);
  assert.deepEqual([first.changed, first.unchanged, first.blocked], [2, 1, 0]);
  assert.deepEqual(first.rows.map(row => [row.id, row.before.parentId, row.after?.parentId, row.parents]), [child, ancestor, unchanged]
    .map((issue, index) => [issue.id, issue.parentId, destination.id,
      { before: parentLabel([ancestor, original, destination][index]), after: parentLabel(destination) }]));
  assert.deepEqual(await f.snapshot(), before);

  const [applied, duplicate] = await Promise.all([f.apply(first.previewId), f.apply(first.previewId)]);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(duplicate, applied);
  assert.deepEqual(applied.data, {
    previewId: first.previewId, updated: [child, ancestor].map(({ id, key, version }) => ({ id, key, version: version + 1 })), unchanged: 1,
  });
  const after = new Map((await f.snapshot()).issues.map(issue => [issue.id, issue]));
  const updatedChild = after.get(child.id)!;
  const updatedAncestor = after.get(ancestor.id)!;
  assert.deepEqual([updatedChild.parentId, updatedAncestor.parentId], [destination.id, destination.id]);
  assert.deepEqual({ ...updatedChild, parentId: child.parentId, version: child.version, updatedAt: child.updatedAt }, child);
  assert.deepEqual(after.get(unchanged.id), unchanged);
  assert.deepEqual(after.get(destination.id), destination);

  const clear = await f.preview([updatedAncestor, updatedChild], { parentId: null });
  assert.ok(clear.previewId);
  assert.deepEqual(clear.rows.map(row => [row.before.parentId, row.after?.parentId, row.parents]), [ancestor, child]
    .map(() => [destination.id, null, { before: parentLabel(destination), after: null }]));
  assert.equal((await f.apply(clear.previewId)).status, 200);
  const cleared = await f.snapshot();
  const clearedIssues = cleared.issues.filter(issue => issue.id === child.id || issue.id === ancestor.id);
  assert.equal(clearedIssues.length, 2);
  assert.ok(clearedIssues.every(issue => issue.parentId === null));
  const noop = await f.preview(clearedIssues, { parentId: null });
  assert.deepEqual([noop.previewId, noop.unchanged, noop.blocked], [null, 2, 0]);
  await f.restart();
  assert.deepEqual(await f.apply(first.previewId), applied);
  assert.deepEqual(await f.snapshot(), cleared);
});

test('project bulk parent review blocks self, descendant and cross-project destinations atomically and checks workflow fields', async t => {
  const f = await fixture(t);
  const ancestor = await f.createIssue('선택한 상위 업무');
  const child = await f.editIssue(await f.createIssue('중간 하위 업무'), { parentId: ancestor.id });
  const descendant = await f.editIssue(await f.createIssue('더 깊은 하위 업무'), { parentId: child.id });
  const unrelated = await f.createIssue('다른 선택 업무');
  const foreign = await f.createIssue('다른 프로젝트 상위 업무', { projectId: otherProjectId });
  await f.requireForReview(['parentId']);
  const before = await f.snapshot();

  for (const invalid of [ancestor, descendant]) {
    const preview = await f.preview([ancestor, unrelated], { parentId: invalid.id });
    assert.deepEqual([preview.previewId, preview.changed, preview.blocked], [null, 1, 1]);
    assert.deepEqual(preview.rows.map(row => row.outcome), ['blocked', 'changed']);
    assert.equal(preview.rows[0].after, null);
    assert.match(preview.rows[0].reason ?? '', /순환/);
  }
  const outside = await f.preview([ancestor, unrelated], { parentId: foreign.id });
  assert.deepEqual([outside.previewId, outside.changed, outside.blocked], [null, 0, 2]);
  assert.ok(outside.rows.every(row => row.after === null && row.parents?.after === null && /같은 프로젝트/.test(row.reason ?? '')));
  await f.expectStatus(400, `${teamBulkPath}-preview`, 'POST', {
    issues: [{ ...issueVersions([child])[0], projectId }], changes: { parentId: null },
  });

  const withoutParent = await f.preview([child], { status: 'review', parentId: null });
  assert.deepEqual([withoutParent.previewId, withoutParent.blocked], [null, 1]);
  assert.match(withoutParent.rows[0].reason ?? '', /상위|parentId/);
  const withParent = await f.preview([unrelated], { status: 'review', parentId: ancestor.id });
  assert.ok(withParent.previewId);
  assert.equal(withParent.rows[0].after?.status, 'review');
  assert.deepEqual(await f.snapshot(), before);
});

test('project bulk parent receipt stops on changed ancestry, reviewed title, or a deleted destination', async t => {
  const f = await fixture(t);
  const newRoot = await f.createIssue('더 위로 이동할 상위 업무');
  const ancestor = await f.createIssue('변경 전 조상 업무');
  const destination = await f.editIssue(await f.createIssue('미리보기에서 확인할 상위 업무'), { parentId: ancestor.id });
  const previous = await f.createIssue('현재 상위 업무');
  const linked = await f.editIssue(await f.createIssue('기존에 연결된 업무'), { parentId: previous.id });
  const unlinked = await f.createIssue('연결할 또 다른 업무');
  const children = [linked, unlinked];

  const first = await f.preview(children, { parentId: destination.id });
  assert.ok(first.previewId);
  await f.editIssue(ancestor, { parentId: newRoot.id });
  const reparented = await f.snapshot();
  assert.equal((await f.apply(first.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), reparented);

  const second = await f.preview(children, { parentId: destination.id });
  assert.ok(second.previewId);
  const renamedParent = await f.editIssue(previous, { title: '현재 상위 업무의 새 제목' });
  const renamed = await f.snapshot();
  assert.equal((await f.apply(second.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), renamed);

  const third = await f.preview(children, { parentId: destination.id });
  assert.ok(third.previewId);
  assert.deepEqual(third.rows[0].parents?.before, parentLabel(renamedParent));
  await f.expectStatus(200, `/issues/${destination.id}?expectedVersion=${destination.version}`, 'DELETE');
  const deleted = await f.snapshot();
  assert.equal((await f.apply(third.previewId)).status, 409);
  assert.deepEqual(await f.snapshot(), deleted);
});

test('team bulk uses each project workflow and writes an actor-bound receipt for a single atomic edit', async t => {
  const f = await fixture(t);
  const first = await f.createIssue('개발 프로젝트 검토');
  const second = await f.createIssue('다른 프로젝트 배포', { projectId: otherProjectId, labels: ['기존'] });
  const rule = await f.createRule();
  const firstWorkflow = await f.requireForReview(['assigneeId']);
  const otherWorkflowPath = `/projects/${otherProjectId}/workflow`;
  const workflow = await f.expectStatus<ProjectWorkflow>(200, otherWorkflowPath);
  const protectedWorkflow = await f.expectStatus<ProjectWorkflow>(200, otherWorkflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, label: '다른 프로젝트의 검토' } : status),
    transitions: workflow.transitions.map(edge => edge.from === 'todo' && edge.to === 'review' ? { ...edge, requiredFields: ['description'] } : edge),
  });
  const targets = [first, second].map(({ id, version, projectId }) => ({ id, expectedVersion: version, projectId }));
  const preview = (input: TeamIssueBulkEditPreviewInput) => f.expectStatus<IssueBulkEditPreview>(200, `${teamBulkPath}-preview`, 'POST', input);
  const apply = (previewId: string, actor = editor) => f.call<IssueBulkEditResult>(`${teamBulkPath}-apply`, 'POST', { previewId }, actor);
  const before = await f.snapshot();

  const commonOnly = await preview({ issues: targets, changes: { priority: 'high', assigneeId: null } });
  assert.ok(commonOnly.previewId);
  assert.deepEqual(commonOnly.rows.map(row => [row.after?.status, row.after?.assigneeId]), [['todo', null], ['todo', null]]);
  const workflowVersions = { [projectId]: firstWorkflow.version, [otherProjectId]: protectedWorkflow.version };
  const blocked = await preview({ issues: targets, changes: {}, statuses: { [projectId]: 'review', [otherProjectId]: 'review' }, workflowVersions });
  assert.equal(blocked.previewId, null);
  assert.deepEqual(blocked.rows.map(row => [row.projectId, row.outcome, row.after?.status]), [
    [projectId, 'changed', 'review'], [otherProjectId, 'blocked', undefined],
  ]);
  assert.match(blocked.rows[1].reason ?? '', /설명|description/);
  assert.deepEqual(await f.snapshot(), before);

  const input: TeamIssueBulkEditPreviewInput = {
    issues: targets, changes: { priority: 'high', addLabels: ['팀 편집'] }, statuses: { [projectId]: 'review', [otherProjectId]: 'done' }, workflowVersions,
  };
  const fromUnselected = { ...input, statuses: { ...input.statuses, 'unselected-project': 'review' } };
  for (const invalid of [fromUnselected, { ...input, statuses: {}, workflowVersions: {}, changes: {} }, { ...input, changes: { status: 'review' } },
    { ...input, workflowVersions: undefined }, { ...input, workflowVersions: { [projectId]: firstWorkflow.version, other: 1 } },
    { ...input, workflowVersions: { ...workflowVersions, [otherProjectId]: 1.5 } },
    { ...input, changes: { customFields: { risk: false } } }, { ...input, issues: [targets[0], { ...targets[0], projectId: otherProjectId }] }]) {
    await f.expectStatus(400, `${teamBulkPath}-preview`, 'POST', invalid);
  }
  await f.expectStatus(404, `${teamBulkPath}-preview`, 'POST', { ...input, statuses: { [projectId]: 'review' },
    workflowVersions: { [projectId]: firstWorkflow.version }, issues: [targets[0], { ...targets[1], projectId }] });

  const stale = await preview(input);
  assert.ok(stale.previewId);
  const updatedWorkflow = await f.expectStatus<ProjectWorkflow>(200, otherWorkflowPath, 'PATCH', {
    ...protectedWorkflow, expectedVersion: protectedWorkflow.version,
    statuses: protectedWorkflow.statuses.map(status => status.id === 'done' ? { ...status, label: '다른 프로젝트의 완료' } : status),
  });
  const beforeStaleApply = await f.snapshot();
  assert.equal((await apply(stale.previewId)).status, 409);
  const stalePreview = await f.expectStatus<{ details: { projectId: string; currentWorkflowVersion: number } }>(409, `${teamBulkPath}-preview`, 'POST', input);
  assert.deepEqual(stalePreview.details, { projectId: otherProjectId, currentWorkflowVersion: updatedWorkflow.version });
  assert.deepEqual(await f.snapshot(), beforeStaleApply);

  const reviewed = await preview({ ...input, workflowVersions: { ...workflowVersions, [otherProjectId]: updatedWorkflow.version } });
  assert.ok(reviewed.previewId);
  assert.deepEqual(reviewed.rows.map(row => [row.projectId, row.after?.status, row.after?.assigneeId, row.after?.priority, row.after?.labels]), [
    [projectId, 'review', reviewer, 'high', ['팀 편집']], [otherProjectId, 'done', null, 'high', ['기존', '팀 편집']],
  ]);
  const legacy = await f.preview([first], { status: 'review' });
  assert.ok(legacy.previewId);
  assert.equal((await apply(legacy.previewId)).status, 404);
  assert.equal((await f.apply(reviewed.previewId)).status, 404);
  assert.equal((await apply(reviewed.previewId, reviewer)).status, 404);

  const targetId = second.id.replaceAll("'", "''");
  f.database.exec(`CREATE TRIGGER reject_second_project_change BEFORE UPDATE ON issues
    WHEN OLD.id = '${targetId}' BEGIN SELECT RAISE(ABORT, 'synthetic second project failure'); END;`);
  assert.equal((await apply(reviewed.previewId)).status, 500);
  assert.deepEqual(await f.snapshot(), beforeStaleApply);
  assert.equal((await f.runs()).total, 0);
  f.database.exec('DROP TRIGGER reject_second_project_change');

  const [applied, duplicate] = await Promise.all([apply(reviewed.previewId), apply(reviewed.previewId)]);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(duplicate, applied);
  assert.deepEqual(applied.data.updated, [first, second].map(({ id, key, version }) => ({ id, key, version: version + 1 })));
  assert.deepEqual((await f.runs()).items.map(({ issueId, ruleId }) => [issueId, ruleId]), [[first.id, rule.id]]);
  const after = await f.snapshot();
  const afterIssues = new Map(after.issues.map(issue => [issue.id, issue]));
  assert.deepEqual([first, second].map(issue => issueFields(afterIssues.get(issue.id)!)), [
    { status: 'review', priority: 'high', assigneeId: reviewer }, { status: 'done', priority: 'high', assigneeId: null },
  ]);
  await f.restart();
  assert.deepEqual(await apply(reviewed.previewId), applied);
  assert.deepEqual(await f.snapshot(), after);
});

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

test('field breakdown bulk requires exact cohort and matching revision until a bound receipt commits', async t => {
  const f = await fixture(t);
  const prefix = '보고서 편집 범위';
  const first = await f.createIssue(`${prefix} 대상 첫째`, { labels: ['첫 근거', '공통'] });
  const second = await f.createIssue(`${prefix} 대상 둘째`, { labels: ['공통', '둘 근거'] });
  const otherAssignee = await f.createIssue(`${prefix} 다른 열`, { assigneeId: alternate });
  const otherStatus = await f.createIssue(`${prefix} 다른 행`, { status: 'review' });
  const outsideView = await f.createIssue('저장된 보기 밖의 업무');
  const otherProject = await f.createIssue(`${prefix} 다른 프로젝트`, { projectId: otherProjectId });
  const filters = { query: prefix, status: 'all', assigneeId: 'all', type: 'all' };
  let view = await f.expectStatus<SavedView>(201, '/views', 'POST', { projectId, name: '검토 업무 범위', layout: 'board', filters });
  const viewPath = `/views/${view.id}`;
  const path = `/projects/${projectId}/field-breakdown`;
  const query = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id };
  const selection = [first, second];
  const compareIssue = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const changes = { assigneeId: reviewer };

  async function currentCell() {
    const report = await f.expectStatus<IssueFieldBreakdown>(200, path, 'POST', query);
    const row = report.groups.find(group => group.count === 3);
    const column = report.comparison?.columns.find(column => column.label === '미지정');
    assert.ok(row && column);
    return { ...query, revision: report.revision, bucketId: row.id, comparisonBucketId: column.id };
  }
  const propose = (fieldBreakdown: Awaited<ReturnType<typeof currentCell>>) =>
    f.expectStatus<IssueBulkEditPreview>(200, `${bulkPath()}-preview`, 'POST', { issues: issueVersions(selection), changes, fieldBreakdown });
  async function stalePreview(fieldBreakdown: Awaited<ReturnType<typeof currentCell>>, issues: Issue[]) {
    const rejected = await f.expectStatus<{ details: { reason: string } }>(409, `${bulkPath()}-preview`, 'POST', {
      issues: issueVersions(issues), changes, fieldBreakdown,
    });
    assert.equal(rejected.details.reason, 'field_breakdown_stale');
  }

  await f.enableEndpoint();
  const initial = await currentCell();
  const plain = await f.expectStatus<IssueFieldBreakdownPage>(200, `${path}/issues`, 'POST', initial);
  assert.equal(plain.editTargets, undefined);
  const editable = await f.expectStatus<IssueFieldBreakdownPage>(200, `${path}/issues`, 'POST', { ...initial, includeEditTargets: true });
  assert.deepEqual(editable.issues, plain.issues);
  assert.deepEqual(editable.editTargets?.map(target => target.id), editable.issues.map(issue => issue.id));
  assert.deepEqual(editable.editTargets?.slice().sort(compareIssue), selection.map(({ id, version, labels }) => ({ id, version, labels })).sort(compareIssue));
  const page = await f.expectStatus<IssueFieldBreakdownPage>(200, `${path}/issues`, 'POST', { ...initial, includeEditTargets: true, offset: 1 });
  assert.deepEqual(page.editTargets, editable.editTargets?.slice(1));

  const before = await f.snapshot();
  for (const ineligible of [otherAssignee, otherStatus, outsideView, otherProject]) await stalePreview(initial, [first, ineligible]);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.deliveries(), []);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM issue_bulk_edit_previews').get()?.count, 0);

  const wholeRow = await f.expectStatus<IssueBulkEditPreview>(200, `${bulkPath()}-preview`, 'POST', {
    issues: issueVersions([first, otherAssignee]), changes, fieldBreakdown: { ...initial, comparisonBucketId: undefined },
  });
  assert.ok(wholeRow.previewId);
  assert.deepEqual(wholeRow.rows.map(row => row.id), [first.id, otherAssignee.id]);
  assert.deepEqual(await f.snapshot(), before);

  view = await f.expectStatus<SavedView>(200, viewPath, 'PATCH', { expectedVersion: view.version, name: '같은 업무의 새 보기 버전' });
  await stalePreview(initial, selection);
  const secondRevision = await currentCell();
  assert.notEqual(secondRevision.revision, initial.revision);
  const pending = await propose(secondRevision);
  assert.ok(pending.previewId);
  assert.deepEqual(pending.rows.map(row => row.id), selection.map(issue => issue.id));
  view = await f.expectStatus<SavedView>(200, viewPath, 'PATCH', {
    expectedVersion: view.version, filters: { ...filters, query: `${prefix} 대상 첫째` },
  });
  const staleApply = await f.expectStatus<{ details: { reason: string } }>(409, `${bulkPath()}-apply`, 'POST', { previewId: pending.previewId });
  assert.equal(staleApply.details.reason, 'field_breakdown_stale');
  assert.deepEqual((await f.snapshot()).issues, before.issues);
  assert.deepEqual(await f.deliveries(), []);

  view = await f.expectStatus<SavedView>(200, viewPath, 'PATCH', { expectedVersion: view.version, filters });
  const latest = await currentCell();
  assert.notEqual(latest.revision, secondRevision.revision);
  const ready = await propose(latest);
  assert.ok(ready.previewId);
  assert.equal(ready.changed, 2);
  assert.equal(ready.blocked, 0);
  assert.equal((await f.apply(ready.previewId, reviewer)).status, 404);
  const saved = await f.apply(ready.previewId);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.updated, selection.map(issue => ({ id: issue.id, key: issue.key, version: issue.version + 1 })));
  const applied = await f.snapshot();
  for (const issue of selection) assert.equal(applied.issues.find(row => row.id === issue.id)?.assigneeId, reviewer);
  for (const issue of [otherAssignee, otherStatus, outsideView, otherProject]) {
    assert.deepEqual(applied.issues.find(row => row.id === issue.id), issue);
  }
  await f.expectStatus(409, `${path}/issues`, 'POST', latest);
  const deliveries = await f.deliveries();
  assert.equal(deliveries.length, 2);
  await f.expectStatus(200, `${viewPath}?expectedVersion=${view.version}`, 'DELETE');
  await f.restart();
  assert.deepEqual(await f.apply(ready.previewId), saved);
  assert.equal((await f.apply(ready.previewId, reviewer)).status, 404);
  assert.deepEqual((await f.snapshot()).issues, applied.issues);
  assert.deepEqual(await f.deliveries(), deliveries);
});

test('custom field bulk projects requested values with their types and preserves unrelated fields and unchanged issues', async t => {
  const f = await fixture(t);
  const options = [{ id: 'red', name: '빨강', archived: false }, { id: 'blue', name: '파랑', archived: false }, { id: 'legacy', name: '이전 분류', archived: false }];
  const fields = [
    customField('memo', '비울 메모', 'text'), customField('score', '검토 점수', 'number'),
    customField('verified', '검토 여부', 'checkbox'), customField('state', '분류', 'select', { options }),
    customField('areas', '범위', 'multi_select', { options }), customField('inspector', '검토자', 'user'),
    customField('review_date', '검토 날짜', 'date'), customField('guide', '가이드 주소', 'url'),
    customField('keep', '유지할 내용', 'text'),
  ];
  await f.installFields(fields);
  const desired: Record<string, CustomFieldValue> = {
    score: 0, verified: false, state: 'red', areas: ['blue', 'red'], inspector: reviewer,
    review_date: '2026-12-03', guide: 'https://example.test/review',
  };
  const customFields = { ...desired, memo: null };
  const prior: Record<string, CustomFieldValue> = {
    memo: '지울 메모', score: 7, verified: true, state: 'blue', areas: ['blue', 'legacy'], inspector: alternate,
    review_date: '2026-11-28', guide: 'https://example.test/previous',
  };
  const changed = await f.createIssue('일괄 편집할 사용자 정의 값', { customFields: { ...prior, keep: '첫째 기록 보존' } });
  const unchanged = await f.createIssue('이미 같은 값과 없는 메모', { customFields: { ...desired, keep: '둘째 기록 보존' } });
  const outside = await f.createIssue('선택 밖 사용자 정의 값', { customFields: { ...prior, keep: '선택 밖 기록 보존' } });
  await f.installFields(fields.map(field => field.id === 'areas' ? {
    ...field, options: field.options.map(option => option.id === 'legacy' ? { ...option, archived: true } : option),
  } : field));
  const before = await f.snapshot();
  await f.enableEndpoint();

  const archived = await f.preview([changed, unchanged], { customFields: { areas: ['blue', 'legacy'] } });
  assert.deepEqual([archived.previewId, archived.unchanged, archived.blocked], [null, 1, 1]);
  assert.equal(archived.rows[1].id, unchanged.id);
  assert.match(archived.rows[1].reason ?? '', /범위|이전 분류/);

  const plan = await f.preview([changed, unchanged], { customFields });
  assert.ok(plan.previewId);
  assert.deepEqual([plan.changed, plan.unchanged, plan.blocked], [1, 1, 0]);
  const [update, keep] = plan.rows;
  assert.deepEqual(update.before.customFields, prior);
  assert.deepEqual(update.after?.customFields, customFields);
  assert.deepEqual(keep.before.customFields, customFields);
  assert.deepEqual(keep.after?.customFields, customFields);
  assert.equal(keep.outcome, 'unchanged');
  const empty = await f.preview([unchanged], { customFields: { memo: null } });
  assert.equal(empty.previewId, null);
  assert.equal(empty.unchanged, 1);
  assert.deepEqual(empty.rows[0].before.customFields, { memo: null });
  assert.deepEqual(empty.rows[0].after?.customFields, { memo: null });
  const reorder = await f.preview([unchanged], { customFields: { areas: ['red', 'blue'] } });
  assert.equal(reorder.previewId, null);
  assert.equal(reorder.unchanged, 1);
  assert.deepEqual((await f.snapshot()).issues, before.issues);
  assert.deepEqual(await f.deliveries(), []);

  const saved = await f.apply(plan.previewId);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data, { previewId: plan.previewId, updated: [{ id: changed.id, key: changed.key, version: changed.version + 1 }], unchanged: 1 });
  const after = await f.snapshot();
  const updated = after.issues.find(issue => issue.id === changed.id);
  assert.ok(updated?.customFields);
  assert.equal(updated.customFields.memo ?? null, null);
  const remaining = Object.fromEntries(Object.entries(updated.customFields).filter(([id]) => id !== 'memo'));
  assert.deepEqual(remaining, { ...desired, keep: '첫째 기록 보존' });
  assert.deepEqual(after.issues.find(issue => issue.id === unchanged.id), unchanged);
  assert.deepEqual(after.issues.find(issue => issue.id === outside.id), outside);
  const deliveries = await f.deliveries();
  assert.equal(deliveries.length, 1);
  await f.restart();
  assert.deepEqual(await f.apply(plan.previewId), saved);
  assert.deepEqual((await f.snapshot()).issues, after.issues);
  assert.deepEqual(await f.deliveries(), deliveries);
});

test('custom field bulk checks resulting status, visibility and requirements together and invalidates stale proposals atomically', async t => {
  const f = await fixture(t);
  const fields = [
    customField('needs_proof', '증빙 사용', 'checkbox'),
    customField('proof', '검토 증빙', 'text', { required: true, visibleWhen: { statusIds: ['review'], fieldMatch: { fieldId: 'needs_proof', value: true } } }),
    customField('score', '검증 점수', 'number'),
    customField('local', '작업 전용 필드', 'text', { issueTypes: ['작업'] }),
    customField('old_note', '보관 전 값', 'text'),
    customField('transition_note', '전이 필수 근거', 'text', { visibleWhen: { statusIds: ['cancelled'], fieldMatch: null } }),
  ];
  await f.installFields(fields);
  await f.requireForReview(['custom:score']);
  const first = await f.createIssue('증빙이 적용되는 업무', { type: '작업', customFields: { needs_proof: true, old_note: '보관 원문' } });
  const second = await f.createIssue('증빙을 숨긴 다른 유형 업무', { type: '버그', customFields: { needs_proof: false } });
  await f.installFields(fields.map(field => field.id === 'old_note' ? { ...field, archived: true } : field));
  const before = await f.snapshot();

  const hidden = await f.preview([first, second], { status: 'review', customFields: { score: 0, proof: '최종 검토 근거' } });
  assert.deepEqual([hidden.previewId, hidden.changed, hidden.blocked], [null, 1, 1]);
  assert.equal(hidden.rows[0].after?.status, 'review');
  assert.deepEqual(hidden.rows[0].after?.customFields, { score: 0, proof: '최종 검토 근거' });
  assert.equal(hidden.rows[1].after, null);
  assert.match(hidden.rows[1].reason ?? '', /검토 증빙/);
  for (const [selected, changes, missing] of [
    [[first], { status: 'review', customFields: { score: 0 } }, '검토 증빙'],
    [[first], { status: 'review', customFields: { proof: '최종 검토 근거' } }, '검증 점수'],
    [[first, second], { customFields: { local: '유형에만 필요한 값' } }, '작업 전용 필드'],
    [[first], { customFields: { old_note: null } }, '보관 전 값'],
    [[first], { customFields: { transition_note: '일반 설정에서는 숨은 값' } }, '전이 필수 근거'],
  ] as const) {
    const blocked = await f.preview([...selected], changes);
    assert.equal(blocked.previewId, null);
    assert.equal(blocked.blocked, 1);
    assert.ok(blocked.rows.some(row => row.reason?.includes(missing)), JSON.stringify(blocked.rows));
  }
  assert.deepEqual((await f.snapshot()).issues, before.issues);

  await f.requireForReview(['custom:score', 'custom:transition_note']);
  const changes = { status: 'review', customFields: { needs_proof: true, score: 0, proof: '최종 검토 근거', transition_note: '이번 전이에 필요한 근거' } } as const;
  const prepared = await f.preview([first, second], changes);
  assert.ok(prepared.previewId);
  assert.equal(prepared.changed, 2);
  await f.installFields(fields.map(field => field.id === 'proof' ? { ...field, name: '바뀐 검토 증빙' } : field.id === 'old_note' ? { ...field, archived: true } : field));
  assert.equal((await f.apply(prepared.previewId)).status, 409);
  assert.deepEqual((await f.snapshot()).issues, before.issues);

  const fresh = await f.preview([first, second], changes);
  assert.ok(fresh.previewId);
  const changedRow = await f.expectStatus<Issue>(200, `/issues/${second.id}`, 'PATCH', { expectedVersion: second.version, title: '외부에서 수정한 업무 제목' });
  const stale = await f.snapshot();
  assert.equal((await f.apply(fresh.previewId)).status, 409);
  assert.deepEqual((await f.snapshot()).issues, stale.issues);

  const final = await f.preview([first, changedRow], changes);
  assert.ok(final.previewId);
  assert.deepEqual(final.rows.map(row => row.after?.customFields), [changes.customFields, changes.customFields]);
  assert.equal((await f.apply(final.previewId)).status, 200);
  const saved = (await f.snapshot()).issues;
  const firstSaved = saved.find(issue => issue.id === first.id);
  const secondSaved = saved.find(issue => issue.id === second.id);
  assert.ok(firstSaved && secondSaved);
  assert.equal(firstSaved.status, 'review');
  assert.equal(secondSaved.status, 'review');
  assert.deepEqual(firstSaved.customFields, { ...changes.customFields, old_note: '보관 원문' });
  assert.deepEqual(secondSaved.customFields, changes.customFields);
  const clearRequired = await f.preview([firstSaved, secondSaved], { customFields: { proof: null } });
  assert.deepEqual([clearRequired.previewId, clearRequired.changed, clearRequired.blocked], [null, 0, 2]);
  assert.deepEqual((await f.snapshot()).issues, saved);
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
