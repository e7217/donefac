import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { Dependency, DocPage, GitlabLink, Issue, IssueOrderMoveResult, IssueRelation, IssueTimeReservationEntry, Milestone, PlanningItem, Project, ProjectIssueOrder, ProjectIssueSchema, ProjectWorkflow, ProjectWorkloadCapacity, ResourceLink, SavedView, ScheduleBaseline, TeamScheduleBlocker, TeamWorkloadCapacity, User, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const header = 'X-Teamspace-Board-Revision';
const ganttHeader = 'X-Teamspace-Gantt-Revision';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-workspace-board-revision-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      origin: `http://127.0.0.1:${address.port}/api`,
      async close() {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        runtime.close();
      },
    };
  }
  let active = await start();
  const db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
  t.after(async () => {
    db.close();
    try { await active.close(); }
    finally { rmSync(dataDir, { force: true, recursive: true }); }
  });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(active.origin + path, {
    method, headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function call<T>(path: string, status = 200, method = 'GET', body?: unknown) {
    const response = await request(path, method, body);
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function revisions(since?: { query: 'teamBoardSince' | 'ganttSince'; token: string }, status = 200) {
    const response = await request(`/workspace${since === undefined ? '' : `?${new URLSearchParams({ [since.query]: since.token })}`}`);
    assert.equal(response.status, status);
    const boardRevision = response.headers.get(header);
    const ganttRevision = response.headers.get(ganttHeader);
    assert.ok(boardRevision && /^[a-f0-9]{32}$/u.test(boardRevision));
    assert.ok(ganttRevision && /^[a-f0-9]{32}$/u.test(ganttRevision));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 204) {
      assert.equal(await response.text(), '');
      return { boardRevision, ganttRevision, data: null };
    }
    return { boardRevision, ganttRevision, data: await response.json() as WorkspaceSnapshot };
  }
  async function workspace(since?: string, status = 200) {
    const { boardRevision, data } = await revisions(since === undefined ? undefined : { query: 'teamBoardSince', token: since }, status);
    return { revision: boardRevision, data };
  }
  return { db, request, call, workspace, revisions, async restart() { await active.close(); active = await start(); } };
}

test('workspace token checks skip document snapshot work while unchanged and survive restart', async t => {
  const f = await fixture(t);
  const initial = await f.workspace();
  assert.ok(initial.data?.documents.length);
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  assert.deepEqual(await f.workspace('0'.repeat(32)), initial);
  const ordinary = await f.request('/workspace?otherQuery=unchanged');
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get(header), initial.revision);
  assert.deepEqual(await ordinary.json(), initial.data);
  for (const suffix of ['?teamBoardSince=', '?teamBoardSince=invalid', `?teamBoardSince=${initial.revision}&teamBoardSince=${initial.revision}`]) {
    const invalid = await f.request(`/workspace${suffix}`);
    assert.equal(invalid.status, 400);
    await invalid.body?.cancel();
  }

  const doc = await f.call<DocPage>('/documents', 201, 'POST', { projectId, title: '업무 보드와 무관한 문서' });
  const changed = await f.call<DocPage>(`/documents/${doc.id}`, 200, 'PATCH', { expectedVersion: doc.version, title: '문서 제목 수정' });
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  assert.deepEqual((await f.workspace()).data?.documents.find(page => page.id === doc.id), changed);
  // A deliberately unreadable document must stay outside the matching-token fast path.
  const stored = f.db.prepare('SELECT json FROM documents WHERE id=?').get(doc.id) as { json: string };
  const ganttRevision = (await f.revisions()).ganttRevision;
  try {
    f.db.prepare('UPDATE documents SET json=? WHERE id=?').run('not valid JSON', doc.id);
    assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
    assert.deepEqual(await f.revisions({ query: 'ganttSince', token: ganttRevision }, 204), {
      boardRevision: initial.revision, ganttRevision, data: null,
    });
  } finally {
    f.db.prepare('UPDATE documents SET json=? WHERE id=?').run(stored.json, doc.id);
  }
  await f.restart();
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  await f.revisions({ query: 'ganttSince', token: ganttRevision }, 204);
  assert.deepEqual((await f.workspace()).data?.documents.find(page => page.id === doc.id), changed);
});

test('workspace restore generation fences both conditional reads without becoming backup data', async t => {
  const f = await fixture(t);
  const initial = await f.revisions();
  assert.equal(initial.data?.restoreGeneration, 'initial');
  const backup = await f.call<WorkspaceSnapshot>('/export');
  assert.equal(Object.hasOwn(backup, 'restoreGeneration'), false);

  await f.call('/import', 200, 'POST', { data: backup });
  const restored = await f.revisions({ query: 'ganttSince', token: initial.ganttRevision });
  const restoredGeneration = restored.data?.restoreGeneration;
  assert.ok(restoredGeneration && restoredGeneration !== initial.data?.restoreGeneration);
  assert.notEqual(restored.ganttRevision, initial.ganttRevision);
  assert.notEqual(restored.boardRevision, initial.boardRevision);
  assert.deepEqual(await f.revisions({ query: 'teamBoardSince', token: initial.boardRevision }), restored);
  assert.equal(Object.hasOwn(await f.call<WorkspaceSnapshot>('/export'), 'restoreGeneration'), false);

  await f.restart();
  assert.deepEqual(await f.revisions(), restored);
  await f.revisions({ query: 'ganttSince', token: restored.ganttRevision }, 204);
  await f.revisions({ query: 'teamBoardSince', token: restored.boardRevision }, 204);

  // A committed generation change must invalidate both reads even if the watched rows are identical.
  const readRawRevisions = f.db.prepare('SELECT board.token AS board, gantt.token AS gantt FROM team_board_revision AS board CROSS JOIN gantt_revision AS gantt');
  const rawRevisions = readRawRevisions.get();
  const nextGeneration = randomUUID();
  f.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(nextGeneration), 'attachmentImportGeneration');
  const next = await f.revisions({ query: 'ganttSince', token: restored.ganttRevision });
  assert.deepEqual(readRawRevisions.get(), rawRevisions);
  assert.equal(next.data?.restoreGeneration, nextGeneration);
  assert.deepEqual(next.data?.issues, restored.data?.issues);
  assert.notEqual(next.ganttRevision, restored.ganttRevision);
  assert.notEqual(next.boardRevision, restored.boardRevision);
  assert.deepEqual(await f.revisions({ query: 'teamBoardSince', token: restored.boardRevision }), next);
});

test('workspace revision includes board and issue context changes, and excludes rolled back and no-op rows', async t => {
  const f = await fixture(t);
  let current = await f.workspace();
  async function advanced() {
    const next = await f.workspace(current.revision);
    assert.notEqual(next.revision, current.revision);
    assert.ok(next.data);
    current = next;
    return next.data;
  }
  const first = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '보드 변경 확인 업무' });
  assert.deepEqual((await advanced()).issues.find(issue => issue.id === first.id), first);
  const moved = await f.call<Issue>(`/issues/${first.id}`, 200, 'PATCH', { expectedVersion: first.version, status: 'review' });
  assert.deepEqual((await advanced()).issues.find(issue => issue.id === first.id), moved);
  const second = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '정렬 검증 기준 업무' });
  await advanced();

  const project = await f.call<Project>('/projects', 201, 'POST', { key: 'SYNC', name: '보드 갱신 프로젝트', description: '' });
  assert.ok((await advanced()).projects.some(item => item.id === project.id));
  const member = await f.call<User>('/users', 201, 'POST', { name: '보드 검증 팀원', email: 'board-test@example.test' });
  assert.ok((await advanced()).users.some(item => item.id === member.id));
  const workflowPath = `/projects/${projectId}/workflow`;
  const workflow = await f.call<ProjectWorkflow>(workflowPath);
  const revisedWorkflow = await f.call<ProjectWorkflow>(workflowPath, 200, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, label: '팀 검토' } : status) });
  const afterWorkflow = await advanced();
  assert.deepEqual(afterWorkflow.workflows?.find(item => item.projectId === projectId), revisedWorkflow);
  assert.deepEqual(afterWorkflow.issues.find(issue => issue.id === first.id), moved);
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  const revisedSchema = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version,
    issueTypes: schema.issueTypes.map((type, index) => index === 0 ? { ...type, name: '업무 양식 갱신' } : type) });
  assert.deepEqual((await advanced()).issueSchemas?.find(item => item.projectId === projectId), revisedSchema);

  const orderPath = `/projects/${projectId}/issue-order`;
  const order = await f.call<ProjectIssueOrder>(orderPath);
  const ranked = await f.call<IssueOrderMoveResult>(orderPath, 200, 'PATCH', { issueId: first.id, expectedVersion: order.version,
    expectedIssueVersion: moved.version, anchorId: second.id, position: 'after' });
  const afterOrder = await advanced();
  assert.deepEqual(afterOrder.issueOrders?.find(item => item.projectId === projectId), ranked.order);
  assert.deepEqual(afterOrder.issues.find(issue => issue.id === first.id), moved);

  const link: GitlabLink = { id: randomUUID(), issueId: first.id, projectId: 42, iid: 7, kind: 'merge_request',
    title: '합성 병합 요청', webUrl: 'https://gitlab.example.test/group/project/-/merge_requests/7', state: 'opened', updatedAt: new Date().toISOString() };
  const insert = f.db.prepare('INSERT INTO gitlab_links(id,issue_id,json) VALUES(?,?,?)');
  f.db.exec('BEGIN IMMEDIATE');
  try {
    insert.run(link.id, link.issueId, JSON.stringify(link));
    assert.deepEqual(await f.workspace(current.revision, 204), { revision: current.revision, data: null });
  } finally { f.db.exec('ROLLBACK'); }
  assert.deepEqual(await f.workspace(current.revision, 204), { revision: current.revision, data: null });
  insert.run(link.id, link.issueId, JSON.stringify(link));
  assert.deepEqual((await advanced()).gitlabLinks.find(item => item.id === link.id), link);
  f.db.prepare('UPDATE gitlab_links SET json=json WHERE id=?').run(link.id);
  await f.workspace(current.revision, 204);
  f.db.prepare('DELETE FROM gitlab_links WHERE id=?').run(link.id);
  assert.ok(!(await advanced()).gitlabLinks.some(item => item.id === link.id));

  const dependency = await f.call<Dependency>('/dependencies', 201, 'POST', { predecessorId: first.id, successorId: second.id });
  assert.deepEqual((await advanced()).dependencies.find(item => item.id === dependency.id), dependency);
  const doc = await f.call<DocPage>('/documents', 201, 'POST', { projectId, title: '관련 문서' });
  await f.workspace(current.revision, 204);
  const resource = await f.call<ResourceLink>('/resource-links', 201, 'POST', { issueId: first.id, documentId: doc.id });
  assert.deepEqual((await advanced()).resourceLinks.find(item => item.id === resource.id), resource);
  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.ok(!Object.keys(backup).some(key => /boardRevision/i.test(key)));
  await f.call('/import', 200, 'POST', { data: backup });
  const restored = await advanced();
  assert.equal(restored.issues.find(issue => issue.id === first.id)?.status, moved.status);
  assert.equal(restored.resourceLinks.find(item => item.id === resource.id)?.documentId, doc.id);
  await f.workspace(current.revision, 204);
});

test('Gantt conditional reads detect schedule changes without invalidating the board revision', async t => {
  const f = await fixture(t);
  let current = await f.revisions();
  const zero = '0'.repeat(32);
  assert.deepEqual(await f.revisions({ query: 'ganttSince', token: zero }), current);
  for (const suffix of ['ganttSince=', 'ganttSince=invalid', `ganttSince=${zero}&ganttSince=${zero}`,
    `ganttSince=${current.ganttRevision}&teamBoardSince=${current.boardRevision}`]) {
    const response = await f.request(`/workspace?${suffix}`);
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }

  async function advanced(shared = false) {
    const next = await f.revisions({ query: 'ganttSince', token: current.ganttRevision });
    assert.notEqual(next.ganttRevision, current.ganttRevision);
    assert.ok(next.data);
    if (shared) assert.notEqual(next.boardRevision, current.boardRevision);
    else {
      assert.equal(next.boardRevision, current.boardRevision);
      assert.deepEqual(await f.revisions({ query: 'teamBoardSince', token: current.boardRevision }, 204), {
        boardRevision: next.boardRevision, ganttRevision: next.ganttRevision, data: null,
      });
    }
    current = next;
    return next.data;
  }

  const calendarPath = `/projects/${projectId}/calendar`;
  const initialCalendar = await f.call<WorkCalendar>(calendarPath);
  const calendar = await f.call<WorkCalendar>(calendarPath, 200, 'PATCH', {
    expectedVersion: initialCalendar.version, name: '간트 갱신 달력', workingWeekdays: [1, 2, 3, 4],
  });
  assert.deepEqual((await advanced()).calendars?.find(item => item.projectId === projectId), calendar);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.prepare('UPDATE project_calendars SET json=? WHERE id=?').run(JSON.stringify({ ...calendar, name: '커밋하지 않은 달력' }), projectId);
    await f.revisions({ query: 'ganttSince', token: current.ganttRevision }, 204);
  } finally { f.db.exec('ROLLBACK'); }
  f.db.prepare('UPDATE project_calendars SET json=json WHERE id=?').run(projectId);
  f.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('testUnrelatedWorkspaceSetting', 'true');
  await f.revisions({ query: 'ganttSince', token: current.ganttRevision }, 204);

  const plan = await f.call<PlanningItem>('/planning-items', 201, 'POST', { projectId, kind: 'cycle', name: '간트 갱신 계획' });
  assert.deepEqual((await advanced()).planningItems?.find(item => item.id === plan.id), plan);
  const view = await f.call<SavedView>('/views', 201, 'POST', { projectId, name: '간트 갱신 보기', layout: 'list',
    filters: { query: '', status: 'all', assigneeId: 'all', type: 'all' } });
  assert.deepEqual((await advanced()).savedViews?.find(item => item.id === view.id), view);
  const milestone = await f.call<Milestone>('/milestones', 201, 'POST', { projectId, title: '간트 갱신 이정표', date: '2026-12-01' });
  const withMilestone = await advanced();
  assert.deepEqual(withMilestone.milestones?.find(item => item.id === milestone.id), milestone);
  const baseline = await f.call<ScheduleBaseline>('/baselines', 201, 'POST', { projectId, name: '간트 갱신 기준선',
    expectedIssueVersions: Object.fromEntries(withMilestone.issues.filter(issue => issue.projectId === projectId).map(issue => [issue.id, issue.version])),
    expectedMilestoneVersions: { [milestone.id]: milestone.version }, expectedCalendarVersion: calendar.version });
  assert.deepEqual((await advanced()).baselines?.find(item => item.id === baseline.id), baseline);

  const capacityPath = `/projects/${projectId}/workload-capacity`;
  const originalProjectCapacity = await f.call<ProjectWorkloadCapacity>(capacityPath);
  const projectCapacity = await f.call<ProjectWorkloadCapacity>(capacityPath, 200, 'PATCH', {
    expectedVersion: originalProjectCapacity.version, defaultDailyMinutes: 350,
  });
  assert.deepEqual((await advanced()).workloadCapacities?.find(item => item.projectId === projectId), projectCapacity);
  const originalTeamCapacity = await f.call<TeamWorkloadCapacity>('/workload-capacity');
  const teamCapacity = await f.call<TeamWorkloadCapacity>('/workload-capacity', 200, 'PATCH', {
    expectedVersion: originalTeamCapacity.version, defaultDailyMinutes: 360,
  });
  assert.deepEqual((await advanced()).teamWorkloadCapacity, teamCapacity);

  const first = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '간트 갱신 선행 업무' });
  assert.deepEqual((await advanced(true)).issues.find(item => item.id === first.id), first);
  const second = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '간트 갱신 후행 업무' });
  await advanced(true);
  const dependency = await f.call<Dependency>('/dependencies', 201, 'POST', { predecessorId: first.id, successorId: second.id });
  assert.deepEqual((await advanced(true)).dependencies.find(item => item.id === dependency.id), dependency);

  const other = await f.call<Issue>('/issues', 201, 'POST', { projectId: 'project-team', title: '간트 갱신 차단 업무' });
  await advanced(true);
  const link = await f.call<IssueRelation>(`/issues/${first.id}/relations`, 201, 'POST', { otherIssueId: other.id, type: 'blocks', direction: 'outgoing' });
  const blockers = (await advanced()).teamScheduleBlockers;
  assert.deepEqual(blockers, await f.call<TeamScheduleBlocker[]>('/schedule/team-blockers'));
  assert.deepEqual(blockers?.find(item => item.id === link.id), {
    id: link.id, sourceIssueId: first.id, targetIssueId: other.id, version: link.version,
  });
  await f.revisions({ query: 'ganttSince', token: current.ganttRevision }, 204);
  const reversed = await f.call<IssueRelation>(`/issues/${first.id}/relations/${link.id}`, 200, 'PATCH', {
    expectedVersion: link.version, type: 'blocks', direction: 'incoming',
  });
  assert.deepEqual((await advanced()).teamScheduleBlockers?.find(item => item.id === link.id), {
    id: link.id, sourceIssueId: other.id, targetIssueId: first.id, version: reversed.version,
  });
  const reservationPath = `/issues/${first.id}/time-reservations`;
  const reservation = await f.call<IssueTimeReservationEntry>(reservationPath, 201, 'POST', { requestId: randomUUID(), userId: 'user-seo',
    startAt: '2026-11-23T10:00:00.000Z', endAt: '2026-11-23T11:00:00.000Z' });
  await advanced();
  assert.deepEqual(await f.call<IssueTimeReservationEntry[]>(reservationPath), [reservation]);

  await f.restart();
  await f.revisions({ query: 'ganttSince', token: current.ganttRevision }, 204);
  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.ok(!Object.keys(backup).some(key => /(?:board|gantt)Revision/i.test(key)));
  assert.equal(Object.hasOwn(backup, 'teamScheduleBlockers'), false);
  await f.call('/import', 200, 'POST', { data: backup });
  const restored = await advanced(true);
  assert.equal(restored.calendars?.find(item => item.projectId === projectId)?.name, calendar.name);
  const restoredBlocker = restored.teamScheduleBlockers?.find(item => item.id === link.id);
  assert.equal(restoredBlocker?.sourceIssueId, other.id);
  assert.ok(restoredBlocker && restoredBlocker.version > reversed.version);
  await f.revisions({ query: 'ganttSince', token: current.ganttRevision }, 204);
});
