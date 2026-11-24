import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { ApiKeyCreated, Comment, CustomFieldDefinition, CycleCompletionPreview, Dependency, DocPage, Issue, IssueRelation, IssueTimeReservationEntry, IssueWorklogPage, Milestone, PlanningItem, Project, ProjectIssueOrder, ProjectIssueSchema, ProjectWorklogReport, ResourceLink, WorkCalendar, WorklogEntry, WorkspaceSnapshot } from '../../shared/types.js';

type WorklogBackup = { worklogs: (WorklogEntry & { createHash: string; deletedAt: string | null })[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-project-move-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      base: `http://127.0.0.1:${address.port}/api`,
      async close() {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        runtime.close();
      },
    };
  }
  let active = await start();
  t.after(async () => {
    try { await active.close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, status = 200, method = 'GET', data?: unknown, actorId = 'user-seo', token?: string): Promise<T> {
    const response = await fetch(active.base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  const source = await request<Project>('/projects', 201, 'POST', { key: 'START', name: '출발 프로젝트' });
  const destination = await request<Project>('/projects', 201, 'POST', { key: 'END', name: '도착 프로젝트' });
  const issue = (title: string, changes: Partial<Issue> = {}) => request<Issue>('/issues', 201, 'POST', { projectId: source.id, title, ...changes });
  const moveInput = (issue: Issue, overrides: Partial<IssueProjectMoveInput> = {}): IssueProjectMoveInput => ({
    expectedVersion: issue.version, projectId: destination.id, includeConnected: false, mappings: [], ...overrides,
  });
  const path = (id: string) => `/issues/${id}/project-move`;
  const preview = (issue: Issue, body = moveInput(issue)) => request<IssueProjectMovePreview>(`${path(issue.id)}/preview`, 200, 'POST', body);
  const apply = (issue: Issue, body: IssueProjectMoveInput, token: string | null, status = 200, actorId?: string) =>
    request<IssueProjectMoveResult>(`${path(issue.id)}/apply`, status, 'POST', { ...body, token }, actorId);
  return { dataDir, source, destination, issue, request, preview, apply, moveInput,
    async restart() { await active.close(); active = await start(); } };
}

test('group movement preserves issue identity, native relations and relative order; apply is versioned and durable', async t => {
  const f = await fixture(t);
  const plan = await f.request<PlanningItem>('/planning-items', 201, 'POST', { projectId: f.source.id, kind: 'cycle', name: '기존 사이클' });
  const root = await f.issue('이동을 시작한 상위 업무', { cycleId: plan.id, startDate: '2026-11-23', endDate: '2026-11-24', description: '그대로 유지할 설명' });
  const child = await f.issue('같이 이동할 하위 업무', { parentId: root.id });
  const successor = await f.issue('같이 이동할 후행 업무');
  const separate = await f.issue('그대로 둘 일반 차단 업무');
  const existing = await f.issue('대상에 이미 저장한 업무', { projectId: f.destination.id });
  const orderPath = `/projects/${f.source.id}/issue-order`;
  const originalOrder = await f.request<ProjectIssueOrder>(orderPath);
  await f.request(orderPath, 200, 'PATCH', { issueId: child.id, expectedIssueVersion: child.version, anchorId: root.id,
    position: 'before', expectedVersion: originalOrder.version });
  const link = await f.request<Dependency>('/dependencies', 201, 'POST', { predecessorId: root.id, successorId: successor.id });
  const blocker = await f.request<IssueRelation>(`/issues/${separate.id}/relations`, 201, 'POST', { otherIssueId: root.id, type: 'blocks', direction: 'outgoing' });
  const comment = await f.request<Comment>('/comments', 201, 'POST', { resourceType: 'issue', resourceId: root.id, body: '이동 뒤에도 이어지는 댓글' });
  const page = await f.request<DocPage>('/documents', 201, 'POST', { projectId: f.source.id, title: '연결 문서' });
  const documentLink = await f.request<ResourceLink>('/resource-links', 201, 'POST', { issueId: root.id, documentId: page.id });
  const reservationsPath = `/issues/${root.id}/time-reservations`;
  const booking = await f.request<IssueTimeReservationEntry>(reservationsPath, 201, 'POST', { userId: 'user-seo', requestId: randomUUID(),
    startAt: '2026-11-23T07:00:00.000Z', endAt: '2026-11-23T08:00:00.000Z' });

  const single = await f.preview(root);
  assert.equal(single.token, null);
  assert.ok(single.blockers.some(notice => notice.code === 'connected_issues'));
  const input = f.moveInput(root, { includeConnected: true });
  const first = await f.preview(root, input);
  assert.ok(first.token);
  assert.ok(first.warnings.some(notice => notice.code === 'source_plan_cleared' && notice.issueId === root.id));
  assert.deepEqual(await f.preview(root, input), first);
  assert.deepEqual(first.issues.map(issue => [issue.id, issue.targetKey]), [[child.id, 'END-2'], [root.id, 'END-3'], [successor.id, 'END-4']]);
  await f.apply(root, input, first.token, 409, 'user-min');
  const calendarPath = `/projects/${f.destination.id}/calendar`;
  const calendar = await f.request<WorkCalendar>(calendarPath);
  await f.request(calendarPath, 200, 'PATCH', { expectedVersion: calendar.version, workingWeekdays: [1, 2, 3, 4] });
  await f.apply(root, input, first.token, 409);
  const next = await f.preview(root, input);
  assert.ok(next.token);
  assert.notEqual(next.token, first.token);
  assert.ok(next.warnings.some(notice => notice.code === 'calendar_changed'));
  const moved = await f.apply(root, input, next.token);
  assert.equal(moved.duplicate, false);
  assert.deepEqual(moved.issues.map(issue => [issue.id, issue.key, issue.parentId, issue.version]), [
    [child.id, 'END-2', root.id, child.version + 1], [root.id, 'END-3', null, root.version + 1], [successor.id, 'END-4', null, successor.version + 1],
  ]);
  const movedRoot = moved.issues.find(issue => issue.id === root.id)!;
  assert.equal(movedRoot.cycleId, null);
  assert.equal(movedRoot.description, root.description);
  assert.equal(movedRoot.startDate, root.startDate);
  assert.equal(movedRoot.endDate, root.endDate);
  assert.equal(movedRoot.createdAt, root.createdAt);
  assert.deepEqual((await f.request<ProjectIssueOrder>(orderPath)).issueIds, [separate.id]);
  assert.deepEqual((await f.request<ProjectIssueOrder>(`/projects/${f.destination.id}/issue-order`)).issueIds,
    [existing.id, child.id, root.id, successor.id]);
  const workspace = await f.request<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.dependencies.find(item => item.id === link.id), link);
  assert.deepEqual(workspace.resourceLinks.find(item => item.id === documentLink.id), documentLink);
  assert.deepEqual(await f.request(`/issues/${separate.id}/relations`), [blocker]);
  assert.deepEqual(await f.request(`/comments?resourceType=issue&resourceId=${root.id}`), [comment]);
  assert.deepEqual(await f.request(reservationsPath), [{ ...booking, projectId: f.destination.id, issueKey: movedRoot.key }]);
  await f.restart();
  assert.deepEqual(await f.apply(root, input, next.token), { ...moved, duplicate: true });
  const following = await f.issue('이동 뒤 이어지는 새 업무', { projectId: f.destination.id });
  assert.equal(following.key, 'END-5');
});

test('a transfer cannot strand milestones, cycle receipts, baselines or archived links', async t => {
  const f = await fixture(t);
  const issue = await f.issue('이동을 막는 연결이 생길 업무');
  const input = f.moveInput(issue);
  const before = await f.preview(issue, input);
  assert.ok(before.token);
  const child = await f.issue('휴지통의 하위 업무', { parentId: issue.id });
  await f.request('/dependencies', 201, 'POST', { predecessorId: issue.id, successorId: child.id });
  await f.request(`/issues/${child.id}`, 200, 'DELETE', { expectedVersion: child.version });
  const milestone = await f.request<Milestone>('/milestones', 201, 'POST', { projectId: f.source.id,
    title: '역사적 연결 검증 이정표', date: '2026-11-24', issueIds: [issue.id] });
  const cycle = await f.request<PlanningItem>('/planning-items', 201, 'POST', { projectId: f.source.id, kind: 'cycle', name: '닫을 사이클', status: 'active' });
  const completed = await f.issue('사이클 실적에 남긴 업무', { cycleId: cycle.id, status: 'done' });
  const completion = await f.request<CycleCompletionPreview>(`/planning-items/${cycle.id}/complete/preview`, 200, 'POST', { expectedVersion: cycle.version, destinationId: null });
  assert.ok(completion.previewId);
  await f.request(`/planning-items/${cycle.id}/complete`, 200, 'POST', { previewId: completion.previewId });
  const latest = await f.request<WorkspaceSnapshot>('/workspace');
  await f.request('/baselines', 201, 'POST', { projectId: f.source.id, name: '이동 전 기준선',
    expectedIssueVersions: Object.fromEntries(latest.issues.filter(item => item.projectId === f.source.id).map(item => [item.id, item.version])),
    expectedMilestoneVersions: { [milestone.id]: milestone.version },
    expectedCalendarVersion: latest.calendars!.find(calendar => calendar.projectId === f.source.id)!.version });
  const blocked = await f.preview(issue, input);
  assert.equal(blocked.token, null);
  assert.deepEqual(new Set(blocked.blockers.map(notice => notice.code)),
    new Set(['milestones', 'baselines', 'trashed_children', 'trashed_schedule_links']));
  await f.apply(issue, input, before.token, 409);
  const completedCurrent = latest.issues.find(item => item.id === completed.id)!;
  assert.ok((await f.preview(completedCurrent)).blockers.some(notice => notice.code === 'cycle_completion'));
  assert.equal((await f.issue('막힌 이동이 키 번호를 소비하지 않음', { projectId: f.destination.id })).key, 'END-1');
});

test('moving worklogs transfers their report scope while preserving entries and deletion tombstones', async t => {
  const f = await fixture(t);
  const issue = await f.issue('작업 시간과 함께 옮길 업무');
  const input = f.moveInput(issue);
  const worklogs = `/issues/${issue.id}/worklogs`;
  const reportPath = (projectId: string) => `/projects/${projectId}/worklog-report?startDate=2026-11-19&endDate=2026-11-21`;
  const preview = () => f.preview(issue, input);
  const addInput = { requestId: randomUUID(), workDate: '2026-11-19', minutes: 25, note: '삭제할 작업 메모' };
  const empty = await preview();
  const deleted = await f.request<WorklogEntry>(worklogs, 201, 'POST', addInput);
  await f.request(`${worklogs}/${deleted.id}`, 200, 'DELETE', { expectedVersion: deleted.version });
  const tombstoneOnly = await preview();
  assert.ok(tombstoneOnly.token);
  assert.notEqual(tombstoneOnly.token, empty.token);
  assert.ok(!tombstoneOnly.warnings.some(notice => notice.code === 'worklogs_transferred'));

  const activeInput = { requestId: randomUUID(), workDate: '2026-11-20', minutes: 40, note: '출발 프로젝트에서 기록' };
  const original = await f.request<WorklogEntry>(worklogs, 201, 'POST', activeInput);
  await f.apply(issue, input, tombstoneOnly.token, 409);
  const first = await preview();
  assert.ok(first.token);
  const warning = first.warnings.find(notice => notice.code === 'worklogs_transferred' && notice.issueId === issue.id);
  assert.ok(warning);
  assert.match(warning.message, /작업 시간.*대상 프로젝트/);
  const edited = await f.request<WorklogEntry>(`${worklogs}/${original.id}`, 200, 'PATCH', {
    expectedVersion: original.version, workDate: '2026-11-21', minutes: 55, note: '미리보기 뒤 수정한 작업 메모',
  });
  await f.apply(issue, input, first.token, 409);
  assert.equal((await f.request<WorkspaceSnapshot>('/workspace')).issues.find(value => value.id === issue.id)?.version, issue.version);
  const next = await preview();
  assert.ok(next.token);
  assert.notEqual(next.token, first.token);

  const source = await f.request<ApiKeyCreated>('/api-keys', 201, 'POST', { name: '출발 보고서 키', access: 'read', projectIds: [f.source.id] });
  const target = await f.request<ApiKeyCreated>('/api-keys', 201, 'POST', { name: '도착 보고서 키', access: 'read', projectIds: [f.destination.id] });
  const getReport = (projectId: string, token: string) =>
    f.request<ProjectWorklogReport>(`/v1${reportPath(projectId)}`, 200, 'GET', undefined, undefined, token);
  assert.equal((await getReport(f.source.id, source.token)).minutes, edited.minutes);
  assert.equal((await getReport(f.destination.id, target.token)).entryCount, 0);
  const originalBackup = await f.request<WorklogBackup>('/export');
  assert.equal(originalBackup.worklogs.length, 2);
  assert.ok(originalBackup.worklogs.find(value => value.id === deleted.id)?.deletedAt);

  const database = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    database.exec(`CREATE TRIGGER reject_project_move_receipt BEFORE INSERT ON issue_project_move_receipts
      BEGIN SELECT RAISE(ABORT, 'synthetic late project move failure'); END`);
    try {
      await f.apply(issue, input, next.token, 500);
      assert.deepEqual((await f.request<WorklogBackup>('/export')).worklogs, originalBackup.worklogs);
      assert.deepEqual((await f.request<WorkspaceSnapshot>('/workspace')).issues.find(value => value.id === issue.id), issue);
      assert.equal((await getReport(f.source.id, source.token)).minutes, edited.minutes);
      assert.equal((await getReport(f.destination.id, target.token)).entryCount, 0);
    } finally { database.exec('DROP TRIGGER reject_project_move_receipt'); }
  } finally { database.close(); }

  const result = await f.apply(issue, input, next.token);
  const [moved] = result.issues;
  assert.equal(moved.id, issue.id);
  assert.equal(moved.projectId, f.destination.id);
  assert.notEqual(moved.key, issue.key);
  const attribution = { projectId: moved.projectId, issueKey: moved.key, issueTitle: moved.title };
  const movedList = { entries: [{ ...edited, ...attribution }], totalMinutes: edited.minutes, totalEntries: 1 };
  assert.deepEqual(await f.request<IssueWorklogPage>(`/v1${worklogs}`, 200, 'GET', undefined, undefined, target.token), movedList);
  await f.request(`/v1${worklogs}`, 403, 'GET', undefined, undefined, source.token);
  await f.request(`/v1${reportPath(f.destination.id)}`, 403, 'GET', undefined, undefined, source.token);
  const afterSourceReport = await getReport(f.source.id, source.token);
  assert.equal(afterSourceReport.minutes, 0);
  assert.equal(afterSourceReport.entryCount, 0);
  assert.deepEqual(afterSourceReport.byIssue, []);
  const afterTargetReport = await getReport(f.destination.id, target.token);
  assert.equal(afterTargetReport.minutes, edited.minutes);
  assert.equal(afterTargetReport.entryCount, 1);
  assert.deepEqual(afterTargetReport.byIssue, [{ issueId: moved.id, key: moved.key, title: moved.title, deleted: false, minutes: edited.minutes, entries: 1 }]);

  assert.deepEqual(await f.apply(issue, input, next.token), { ...result, duplicate: true });
  assert.deepEqual(await f.request(worklogs, 201, 'POST', activeInput), movedList.entries[0]);
  await f.request(worklogs, 409, 'POST', addInput);
  const movedBackup = await f.request<WorklogBackup>('/export');
  const expectedRows = originalBackup.worklogs.map(value => ({ ...value, ...attribution }));
  assert.deepEqual(movedBackup.worklogs, expectedRows);

  const restored = await fixture(t);
  await restored.request('/import', 200, 'POST', { data: movedBackup });
  assert.deepEqual(await restored.request(worklogs), movedList);
  assert.deepEqual((await restored.request<WorklogBackup>('/export')).worklogs, expectedRows);
  assert.equal((await restored.request<ProjectWorklogReport>(reportPath(f.source.id))).minutes, 0);
  assert.deepEqual(await restored.request(reportPath(f.destination.id)), afterTargetReport);
  await restored.request(worklogs, 409, 'POST', addInput);
});

test('target custom fields carry compatible values by definition and require explicit lossless validation', async t => {
  const f = await fixture(t);
  const base = { description: '', issueTypes: [], required: false, archived: false, options: [] };
  const sourceField: CustomFieldDefinition = { ...base, id: 'initial_priority', name: '고객 영향', kind: 'select',
    options: [{ id: 'initial_high', name: '높음', archived: false }] };
  const targetField: CustomFieldDefinition = { ...sourceField, id: 'target_priority',
    options: [{ id: 'target_high', name: '높음', archived: false }, { id: 'target_low', name: '낮음', archived: false }] };
  const justification: CustomFieldDefinition = { ...base, id: 'target_reason', name: '대상 검토 내용', kind: 'text', required: true };
  for (const [id, fields] of [[f.source.id, [sourceField]], [f.destination.id, [targetField, justification]]] as const) {
    const path = `/projects/${id}/issue-schema`;
    const schema = await f.request<ProjectIssueSchema>(path);
    await f.request(path, 200, 'PATCH', { ...schema, expectedVersion: schema.version, fields });
  }
  const issue = await f.issue('값을 보존해야 하는 업무', { customFields: { initial_priority: 'initial_high' } });
  const incomplete = await f.preview(issue);
  assert.equal(incomplete.token, null);
  assert.ok(incomplete.blockers.some(notice => notice.code === 'target_validation' && notice.message.includes(justification.name)));
  assert.deepEqual(incomplete.issues[0].mapping.customFields, { target_priority: 'target_high' });
  const conflicting = f.moveInput(issue, { mappings: [{ issueId: issue.id, customFields: { target_priority: 'target_low', target_reason: '다른 값' } }] });
  const conflict = await f.preview(issue, conflicting);
  assert.equal(conflict.token, null);
  assert.ok(conflict.blockers.some(notice => notice.code === 'custom_field_incompatible'));
  const input = f.moveInput(issue, { mappings: [{ issueId: issue.id, customFields: { target_reason: '새 프로젝트에서 검토할 내용' } }] });
  const preview = await f.preview(issue, input);
  assert.ok(preview.token);
  const applied = await f.apply(issue, input, preview.token);
  assert.deepEqual(applied.issues[0].customFields, { target_priority: 'target_high', target_reason: '새 프로젝트에서 검토할 내용' });
});
