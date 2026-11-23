import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { documentSectionHash, markdownImportSectionId } from '../../shared/document-sections.js';
import type { ApiKeyCreated, DependencyType, DocPage, DocRevision, Issue, IssueCloneResult, IssueRelation, PlanningItem, ProjectWorkflow, SchedulePreview, WebhookEndpointCreated, WorkCalendar, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const assigneeId = 'user-min';
type Failure = { details: { reason: string } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-create-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  async function stop() {
    service.server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())); }
    finally { service.runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { observer.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, statuses: number | number[] = 200,
    actor = actorId, token?: string) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.ok([statuses].flat().includes(response.status), `${method} ${path}: ${response.status} ${body}`);
    return { status: response.status, data: JSON.parse(body) as T };
  }
  async function enableOutbox() {
    const { data: { endpoint } } = await call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', {
      name: '합성 업무 생성', url: 'http://127.0.0.1:9/receiver', eventTypes: ['issue.created'], projectIds: [projectId],
    }, 201);
    await call(`/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  function sideEffects() {
    const nextNumber = Number(observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number);
    const totals = ['issues', 'activities', 'team_notifications', 'webhook_events', 'webhook_deliveries', 'issue_creation_requests']
      .map(table => Number(observer.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total));
    return [nextNumber, ...totals];
  }
  return { call, enableOutbox, observer, sideEffects, async restart() { await stop(); service = await start(); } };
}

test('ordinary ticket retries allocate one issue, key, audit, notification and outbound event', async t => {
  const { call, enableOutbox, sideEffects, restart } = await fixture(t);
  await enableOutbox();
  const before = sideEffects();
  const first = { requestId: randomUUID(), projectId, title: '긴급 일정 입력', assigneeId,
    labels: ['검수'], startDate: '2026-11-23', endDate: '2026-11-27', clientData: { nested: [null, { code: 1, selected: false }] } };
  const reordered = { clientData: { nested: [null, { selected: false, code: 1 }] }, assigneeId, endDate: first.endDate,
    requestId: first.requestId.toUpperCase(), title: first.title, projectId, startDate: first.startDate, labels: first.labels };

  for (const requestId of [null, 0, '', 'invalid', '00000000-0000-1000-8000-000000000000']) {
    const { data } = await call<Failure>('/issues', 'POST', { ...first, requestId }, 400);
    assert.equal(data.details.reason, 'invalid_request_id');
  }
  assert.deepEqual(sideEffects(), before);
  const requests = await Promise.all([first, reordered].map(input => call<Issue>('/issues', 'POST', input, [200, 201])));
  assert.deepEqual(requests.map(value => value.status).sort(), [200, 201]);
  const issue = requests[0].data;
  assert.deepEqual(requests[1].data, issue);
  assert.equal(issue.key, `NEO-${before[0]}`);
  assert.equal(issue.reporterId, actorId);
  assert.equal(issue.startDate, first.startDate);
  assert.equal(issue.endDate, first.endDate);
  assert.deepEqual(sideEffects(), before.map(value => value + 1));
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.filter(value => value.title === first.title), [issue]);
  assert.equal(workspace.activities.filter(value => value.resourceId === issue.id && value.action === '티켓 생성').length, 1);

  for (const changed of [
    { ...first, title: '다른 업무' }, { ...first, dueDate: null }, { ...first, projectId: 'project-team' },
    { ...first, clientData: { nested: [null, { code: '1', selected: false }] } },
  ]) {
    const { data } = await call<Failure>('/issues', 'POST', changed, 409);
    assert.equal(data.details.reason, 'request_conflict');
  }
  assert.equal((await call<Failure>('/issues', 'POST', first, 409, assigneeId)).data.details.reason, 'request_conflict');
  const { data: updated } = await call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, title: '저장 뒤 수정' });
  await restart();
  assert.deepEqual((await call<Issue>('/issues', 'POST', reordered)).data, updated);
});

test('a failed create or receipt insert rolls back the issue and all side effects and permits retry', async t => {
  const { call, enableOutbox, observer, sideEffects } = await fixture(t);
  await enableOutbox();
  const request = { requestId: randomUUID(), projectId, title: '복구할 업무', assigneeId };
  const before = sideEffects();
  await call('/issues', 'POST', { ...request, title: '' }, 400);
  observer.exec("CREATE TRIGGER fail_issue_creation_receipt BEFORE INSERT ON issue_creation_requests BEGIN SELECT RAISE(ABORT,'synthetic issue receipt failure'); END");
  try {
    await call('/issues', 'POST', request, 500);
    assert.deepEqual(sideEffects(), before);
  } finally { observer.exec('DROP TRIGGER fail_issue_creation_receipt'); }
  const { data } = await call<Issue>('/issues', 'POST', request, 201);
  assert.equal(data.key, `NEO-${before[0]}`);
  assert.deepEqual((await call<Issue>('/issues', 'POST', request)).data, data);
  assert.deepEqual(sideEffects(), before.map(value => value + 1));

  const legacy = { projectId, title: request.title, assigneeId };
  const legacyFirst = await call<Issue>('/issues', 'POST', legacy, 201);
  const legacySecond = await call<Issue>('/issues', 'POST', legacy, 201);
  assert.notEqual(legacyFirst.data.id, legacySecond.data.id);
});

test('issue reporters preserve unknown history, declared team members, explicit clearing and scoped queries', async t => {
  const { call, sideEffects, restart } = await fixture(t);
  const { data: initial } = await call<WorkspaceSnapshot>('/workspace');
  const legacy = initial.issues.find(issue => issue.projectId === projectId)!;
  const namedReporter = initial.users.find(user => user.id === assigneeId)!;
  assert.equal(Object.hasOwn(legacy, 'reporterId'), false);
  const { data: legacyEdited } = await call<Issue>(`/issues/${legacy.id}`, 'PATCH', {
    expectedVersion: legacy.version, title: `${legacy.title} 수정`,
  });
  assert.equal(Object.hasOwn(legacyEdited, 'reporterId'), false);

  const input = { projectId, title: '별도 요청자 업무', assigneeId: actorId };
  const beforeInvalid = sideEffects();
  for (const reporterId of ['', 42, [], { id: assigneeId }, 'missing-team-member']) {
    await call('/issues', 'POST', { ...input, reporterId }, 400);
  }
  assert.deepEqual(sideEffects(), beforeInvalid);
  const { data: named } = await call<Issue>('/issues', 'POST', { ...input, reporterId: assigneeId }, 201);
  assert.equal(named.reporterId, assigneeId);
  assert.equal(named.assigneeId, actorId);
  const { data: unassigned } = await call<Issue>('/issues', 'POST', { ...input, title: '요청자 미지정 업무', reporterId: null }, 201);
  assert.equal(unassigned.reporterId, null);
  await call<Issue>('/issues', 'POST', { ...input, projectId: 'project-team', reporterId: assigneeId }, 201);

  const { data: { token } } = await call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '요청 업무 조회', access: 'read', projectIds: [projectId], expiresAt: null,
  }, 201);
  const findReported = async () => (await call<Issue[]>(`/v1/issues?projectId=${projectId}&reporterId=${assigneeId}`,
    'GET', undefined, 200, actorId, token)).data.map(issue => issue.id);
  assert.deepEqual(await findReported(), [named.id]);
  await call('/v1/issues?projectId=project-team&reporterId=user-min', 'GET', undefined, 403, actorId, token);
  for (const path of ['/v1/issues?reporterId=missing-team-member', '/v1/issues?reporterId=user-min&reporterId=user-seo', '/v1/issues?reporterId=']) {
    await call(path, 'GET', undefined, 400, actorId, token);
  }

  await call(`/issues/${named.id}`, 'PATCH', { expectedVersion: named.version + 1, reporterId: null }, 409);
  await call(`/issues/${named.id}`, 'PATCH', { expectedVersion: named.version, reporterId: 'missing-team-member' }, 400);
  assert.deepEqual(await findReported(), [named.id]);
  const { data: changed } = await call<Issue>(`/issues/${named.id}`, 'PATCH', { expectedVersion: named.version, reporterId: null });
  assert.equal(changed.reporterId, null);
  assert.equal(changed.version, named.version + 1);
  assert.deepEqual(await findReported(), []);
  await restart();
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.find(issue => issue.id === named.id), changed);
  assert.ok(current.activities.some(activity => activity.resourceId === named.id && activity.actorId === actorId &&
    activity.detail.includes(`요청자 ${namedReporter.name} → 미지정`)));
});

test('used issue request IDs survive deletion, trash restoration and workspace replacement', async t => {
  const { call, observer, restart } = await fixture(t);
  const input = { requestId: randomUUID(), projectId, title: '복원할 신규 업무' };
  const { data: issue } = await call<Issue>('/issues', 'POST', input, 201);
  const { data: { trashEntryId } } = await call<{ trashEntryId: string }>(`/issues/${issue.id}?expectedVersion=${issue.version}`, 'DELETE');
  const retryUnavailable = async () => {
    assert.equal((await call<Failure>('/issues', 'POST', input, 409)).data.details.reason, 'result_unavailable');
  };
  await retryUnavailable();
  await call(`/trash/${trashEntryId}/restore`, 'POST', {});
  const { data: restored } = await call<Issue>('/issues', 'POST', input);
  assert.equal(restored.id, issue.id);
  assert.ok(restored.version > issue.version);

  const { data: backup } = await call<WorkspaceSnapshot>('/export');
  assert.ok(!JSON.stringify(backup).includes(input.requestId));
  observer.exec("CREATE TRIGGER fail_issue_replacement BEFORE INSERT ON issues BEGIN SELECT RAISE(ABORT,'synthetic issue replacement failure'); END");
  try {
    await call('/import', 'POST', { data: backup }, 500);
    assert.deepEqual((await call<Issue>('/issues', 'POST', input)).data, restored);
  } finally { observer.exec('DROP TRIGGER fail_issue_replacement'); }
  await call('/import', 'POST', { data: backup });
  await restart();
  await retryUnavailable();
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.filter(value => value.title === input.title).map(value => value.id), [issue.id]);
  const { data: newIssue } = await call<Issue>('/issues', 'POST', { ...input, requestId: randomUUID() }, 201);
  assert.notEqual(newIssue.id, issue.id);
});

test('public API creation retries retain the fixed actor and enforce write and project scopes', async t => {
  const { call } = await fixture(t);
  async function key(project: string, access: 'read' | 'write', actor = actorId) {
    return (await call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 업무 생성 키', projectIds: [project], access, expiresAt: null }, 201, actor)).data.token;
  }
  const write = await key(projectId, 'write');
  const otherScope = await key('project-team', 'write');
  const otherActor = await key(projectId, 'write', assigneeId);
  const read = await key(projectId, 'read');
  const input = { requestId: randomUUID(), projectId, title: 'API 생성 재시도', actorId: assigneeId };
  const { data: issue } = await call<Issue>('/v1/issues', 'POST', input, 201, assigneeId, write);
  assert.equal(issue.reporterId, actorId);
  assert.deepEqual((await call<Issue>('/v1/issues', 'POST', input, 200, assigneeId, write)).data, issue);
  await call('/v1/issues', 'POST', input, 403, actorId, otherScope);
  await call('/v1/issues', 'POST', input, 403, actorId, read);
  assert.equal((await call<Failure>('/v1/issues', 'POST', input, 409, actorId, otherActor)).data.details.reason, 'request_conflict');
  assert.equal((await call<Failure>('/v1/issues', 'POST', { ...input, projectId: 'project-team' }, 409, actorId, otherScope)).data.details.reason, 'request_conflict');
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.filter(value => value.title === input.title), [issue]);
  assert.equal(workspace.activities.find(value => value.resourceId === issue.id && value.action === '티켓 생성')?.actorId, actorId);
});

const clonePath = (id: string) => `/issues/${id}/clone`;

test('cloning saves a fresh issue and one symmetric relation, with idempotent retries after source and relation changes', async t => {
  const { call, enableOutbox, sideEffects, restart } = await fixture(t);
  const { data: parent } = await call<Issue>('/issues', 'POST', { projectId, title: '원본 상위 업무' }, 201);
  const { data: cycle } = await call<PlanningItem>('/planning-items', 'POST', { projectId, kind: 'cycle', name: '원본 계획' }, 201);
  const { data: source } = await call<Issue>('/issues', 'POST', {
    projectId, title: '원본 업무', description: '원본 설명', labels: ['원본'], parentId: parent.id, cycleId: cycle.id, reporterId: assigneeId,
  }, 201);
  await call('/comments', 'POST', { resourceType: 'issue', resourceId: source.id, body: '원본 의견' }, 201);
  await call(`/issues/${source.id}/relations`, 'POST', { otherIssueId: parent.id, direction: 'outgoing', type: 'blocks' }, 201);
  await enableOutbox();
  const before = sideEffects();
  const issueFields = { title: '편집한 복제 업무', description: '복제 설명', type: source.type, labels: ['검토,복제'],
    assigneeId, startDate: '2026-11-23', endDate: '2026-11-27', plannedEffortMinutes: 0 };
  const input = { requestId: randomUUID(), expectedSourceVersion: source.version, issue: issueFields };
  const path = clonePath(source.id);
  const results = await Promise.all([input, { ...input, requestId: input.requestId.toUpperCase() }]
    .map(body => call<IssueCloneResult>(path, 'POST', body, [200, 201])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  const created = results.find(result => result.status === 201)!.data;
  const replay = results.find(result => result.status === 200)!.data;
  assert.equal(created.duplicate, false);
  assert.deepEqual(replay, { ...created, duplicate: true });
  const { issue, relation } = created;
  assert.deepEqual(Object.fromEntries(Object.keys(issueFields).map(key => [key, issue[key as keyof Issue]])), issueFields);
  assert.equal(issue.key, `NEO-${before[0]}`);
  assert.notEqual(issue.id, source.id);
  assert.equal(issue.projectId, projectId);
  assert.equal(issue.reporterId, actorId);
  assert.equal(issue.version, 1);
  assert.equal(issue.parentId, null);
  assert.equal(issue.cycleId, null);
  assert.equal(issue.moduleId, null);
  assert.equal(issue.releaseId, null);
  assert.deepEqual((await call(`/comments?resourceType=issue&resourceId=${issue.id}`)).data, []);
  assert.ok(relation);
  assert.equal(relation.type, 'related');
  assert.equal(relation.origin, 'teamspace');
  assert.deepEqual([relation.sourceIssueId, relation.targetIssueId], [source.id, issue.id].sort());
  assert.deepEqual((await call<IssueRelation[]>(`/issues/${issue.id}/relations`)).data, [relation]);
  assert.deepEqual(sideEffects(), before.map((value, index) => value + (index === 2 ? 3 : 1)));
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.issues.find(item => item.id === source.id), source);
  assert.equal(workspace.activities.filter(item => item.resourceId === issue.id && item.actorId === actorId).length, 2);
  assert.ok(workspace.activities.some(item => item.resourceId === source.id && item.detail === `관련 업무 · ${issue.key}`));

  for (const [route, body, actor] of [
    [path, { ...input, issue: { ...input.issue, title: '다른 입력' } }, actorId],
    [clonePath(parent.id), input, actorId],
    [path, input, assigneeId],
    ['/issues', { ...input, ...issueFields, projectId, sourceIssueId: source.id }, actorId],
  ] as const) {
    assert.equal((await call<Failure>(route, 'POST', body, 409, actor)).data.details.reason, 'request_conflict');
  }
  await call(`/issues/${source.id}`, 'PATCH', { title: '변경한 원본', expectedVersion: source.version });
  await call(`/issues/${issue.id}/relations/${relation.id}?expectedVersion=${relation.version}`, 'DELETE');
  await restart();
  assert.deepEqual((await call<IssueCloneResult>(path, 'POST', input)).data, { issue, relation: null, duplicate: true });
  assert.deepEqual((await call<IssueRelation[]>(`/issues/${issue.id}/relations`)).data, []);
});

test('clone failures roll back links, keys and effects, and receipts survive trash and workspace replacement', async t => {
  const { call, enableOutbox, observer, sideEffects } = await fixture(t);
  const { data: source } = await call<Issue>('/issues', 'POST', { projectId, title: '버전으로 보호한 원본' }, 201);
  const { data: edited } = await call<Issue>(`/issues/${source.id}`, 'PATCH', { expectedVersion: source.version, description: '원본 변경' });
  await enableOutbox();
  const before = sideEffects();
  const input = { requestId: randomUUID(), expectedSourceVersion: edited.version, issue: { title: '다시 복제할 업무', assigneeId } };
  const path = clonePath(source.id);
  const { data: changed } = await call<Failure>(path, 'POST', { ...input, expectedSourceVersion: source.version }, 409);
  assert.deepEqual(changed.details, { reason: 'source_version_changed', currentVersion: edited.version });
  const { data: missing } = await call<Failure>(clonePath('missing-issue'), 'POST', input, 404);
  assert.equal(missing.details.reason, 'source_missing');
  await call(path, 'POST', { ...input, issue: { ...input.issue, projectId: 'project-team' } }, 400);
  await call(path, 'POST', { ...input, issue: { ...input.issue, title: '' } }, 400);
  assert.deepEqual(sideEffects(), before);

  for (const table of ['issue_relations', 'issue_creation_requests']) {
    observer.exec(`CREATE TRIGGER fail_clone BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic clone failure'); END`);
    try {
      await call(path, 'POST', input, 500);
      assert.deepEqual(sideEffects(), before);
      assert.deepEqual((await call<IssueRelation[]>(`/issues/${source.id}/relations`)).data, []);
    } finally { observer.exec('DROP TRIGGER fail_clone'); }
  }

  const { data: { issue, relation } } = await call<IssueCloneResult>(path, 'POST', input, 201);
  assert.equal(issue.key, `NEO-${before[0]}`);
  const { data: { trashEntryId } } = await call<{ trashEntryId: string }>(`/issues/${issue.id}?expectedVersion=${issue.version}`, 'DELETE');
  assert.equal((await call<Failure>(path, 'POST', input, 409)).data.details.reason, 'result_unavailable');
  await call(`/trash/${trashEntryId}/restore`, 'POST', {});
  const { data: restored } = await call<IssueCloneResult>(path, 'POST', input);
  assert.equal(restored.issue.id, issue.id);
  assert.ok(restored.issue.version > issue.version);
  assert.equal(restored.relation?.id, relation?.id);

  const { data: backup } = await call<WorkspaceSnapshot>('/export');
  assert.ok(!JSON.stringify(backup).includes(input.requestId));
  await call('/import', 'POST', { data: backup });
  assert.equal((await call<Failure>(path, 'POST', input, 409)).data.details.reason, 'result_unavailable');
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.filter(value => value.title === input.issue.title).map(value => value.id), [issue.id]);
});

test('public clone uses the key owner and validates the source, target and explicit parent and planning references', async t => {
  const { call } = await fixture(t);
  async function key(project: string | null, access: 'read' | 'write') {
    return (await call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 복제 키', projectIds: project ? [project] : null, access }, 201)).data.token;
  }
  const read = await key(projectId, 'read');
  const write = await key(projectId, 'write');
  const wide = await key(null, 'write');
  const otherProject = 'project-team';
  const { data: source } = await call<Issue>('/issues', 'POST', { projectId, title: '복제 API 원본' }, 201);
  const { data: outside } = await call<Issue>('/issues', 'POST', { projectId: otherProject, title: '범위 밖 업무' }, 201);
  const { data: cycle } = await call<PlanningItem>('/planning-items', 'POST', { projectId, kind: 'cycle', name: '복제 계획' }, 201);
  const { data: outsideCycle } = await call<PlanningItem>('/planning-items', 'POST', { projectId: otherProject, kind: 'cycle', name: '범위 밖 계획' }, 201);
  const path = `/v1${clonePath(source.id)}`;
  const input = { requestId: randomUUID(), expectedSourceVersion: source.version, actorId: assigneeId,
    issue: { title: 'API 복제 업무', parentId: source.id, cycleId: cycle.id } };
  await call(path, 'POST', input, 401);
  await call(path, 'POST', input, 403, actorId, read);
  await call(`/v1${clonePath(outside.id)}`, 'POST', input, 403, actorId, write);
  const { data: missing } = await call<Failure>(`/v1${clonePath('missing-issue')}`, 'POST', input, 404, actorId, write);
  assert.equal(missing.details.reason, 'source_missing');
  await call(path, 'POST', { ...input, issue: { ...input.issue, parentId: outside.id } }, 403, actorId, write);
  await call(path, 'POST', { ...input, issue: { ...input.issue, cycleId: outsideCycle.id } }, 403, actorId, write);
  await call(path, 'POST', { ...input, issue: { ...input.issue, projectId: otherProject } }, 400, actorId, wide);
  const { data: result } = await call<IssueCloneResult>(path, 'POST', input, 201, assigneeId, write);
  assert.equal(result.issue.parentId, source.id);
  assert.equal(result.issue.cycleId, cycle.id);
  assert.deepEqual((await call<IssueCloneResult>(path, 'POST', input, 200, assigneeId, write)).data, { ...result, duplicate: true });
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  const activities = workspace.activities.filter(value => value.resourceId === result.issue.id);
  assert.equal(activities.length, 2);
  assert.ok(activities.every(item => item.actorId === actorId));
});

const successorPath = (id: string) => `/issues/${id}/schedule-successors`;
function successorRequest(predecessor: Issue, calendar: WorkCalendar, issue: Record<string, unknown>,
  type: DependencyType = 'FS', lagDays = 0) {
  return { requestId: randomUUID(), expectedPredecessorVersion: predecessor.version, expectedCalendarVersion: calendar.version,
    type, lagDays, issue };
}

test('a new successor uses normal issue fields and one scheduled edge for every dependency type', async t => {
  const { call } = await fixture(t);
  const { data: predecessor } = await call<Issue>('/issues', 'POST', {
    projectId, title: '선행 업무', startDate: '2026-11-24', endDate: '2026-11-26',
  }, 201);
  const { data: calendar } = await call<WorkCalendar>(`/projects/${projectId}/calendar`);
  const variants = [['FS', 0], ['SS', -3650], ['FF', 2], ['SF', 3650]] as const;
  for (const [type, lagDays] of variants) {
    const issueFields = { title: `${type} 후행 업무`, startDate: '2026-11-23', endDate: '2026-11-23', assigneeId };
    const payload = successorRequest(predecessor, calendar, issueFields, type, lagDays);
    const { data: successor } = await call<Issue>(successorPath(predecessor.id), 'POST', payload, 201);
    assert.equal(successor.projectId, projectId);
    assert.equal(successor.parentId, null);
    assert.equal(successor.startDate, issueFields.startDate);
    assert.equal(successor.endDate, issueFields.endDate);
    assert.equal(successor.assigneeId, assigneeId);
    assert.equal(successor.reporterId, actorId);
    const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(workspace.dependencies.filter(link => link.successorId === successor.id)
      .map(({ predecessorId, type, lagDays, version }) => ({ predecessorId, type, lagDays, version })),
    [{ predecessorId: predecessor.id, type, lagDays, version: 1 }]);
    const activities = workspace.activities.filter(activity => activity.resourceId === successor.id);
    assert.equal(activities.length, 2);
    assert.ok(activities.every(activity => activity.actorId === actorId));
    assert.ok(activities.some(activity => activity.action === '티켓 생성'));
    assert.ok(activities.some(activity => activity.action === '선행 업무 연결' && activity.detail === predecessor.key));
    assert.ok(workspace.activities.some(activity => activity.resourceId === predecessor.id && activity.actorId === actorId &&
      activity.action === '후행 업무 생성' && activity.detail === `${successor.key} ${successor.title}`));
    if (type === 'FS') {
      const { data: preview } = await call<SchedulePreview>('/schedule/preview', 'POST', { issueIds: [successor.id], days: 0 });
      assert.ok(preview.warnings.some(warning => warning.startsWith(`${predecessor.key} → ${successor.key}`)));
    }
  }
});

test('schedule successor receipts are scoped to the actor and predecessor and replay after calendar and link changes', async t => {
  const { call, restart } = await fixture(t);
  const { data: predecessor } = await call<Issue>('/issues', 'POST', { projectId, title: '버전 확인 선행 업무' }, 201);
  const { data: otherPredecessor } = await call<Issue>('/issues', 'POST', { projectId, title: '다른 선행 업무' }, 201);
  const calendarPath = `/projects/${projectId}/calendar`;
  const { data: calendar } = await call<WorkCalendar>(calendarPath);
  const payload = successorRequest(predecessor, calendar, { title: '한번만 만들 후행 업무', startDate: null }, 'FF');
  const path = successorPath(predecessor.id);
  const reordered = { issue: { startDate: null, title: payload.issue.title }, lagDays: payload.lagDays, type: payload.type,
    expectedCalendarVersion: payload.expectedCalendarVersion, expectedPredecessorVersion: payload.expectedPredecessorVersion,
    requestId: payload.requestId.toUpperCase() };
  const results = await Promise.all([payload, reordered].map(input => call<Issue>(path, 'POST', input, [200, 201])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  const successor = results[0].data;
  assert.deepEqual(results[1].data, successor);
  assert.equal(successor.startDate, null);
  assert.equal(successor.endDate, null);
  const conflict = async (route: string, input: unknown, actor?: string) =>
    assert.equal((await call<Failure>(route, 'POST', input, 409, actor)).data.details.reason, 'request_conflict');
  await conflict(path, { ...payload, lagDays: 1 });
  await conflict(path, { ...payload, issue: { ...payload.issue, title: '변경된 입력' } });
  await conflict(successorPath(otherPredecessor.id), payload);
  await conflict(path, payload, assigneeId);
  await conflict('/issues', { ...payload, projectId, predecessorId: predecessor.id, title: payload.issue.title });
  const genericInput = { ...payload, requestId: randomUUID() };
  await call<Issue>('/issues', 'POST', { ...genericInput, projectId, type: predecessor.type, title: '일반 생성' }, 201);
  await conflict(path, genericInput);

  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  const dependency = workspace.dependencies.find(link => link.successorId === successor.id);
  assert.ok(dependency);
  await call(`/dependencies/${dependency.id}?expectedVersion=${dependency.version}`, 'DELETE');
  await call(`/issues/${predecessor.id}`, 'PATCH', { title: '선행 업무 수정', expectedVersion: predecessor.version });
  await call(calendarPath, 'PATCH', { name: '수정한 작업 달력', expectedVersion: calendar.version });
  await restart();
  assert.deepEqual((await call<Issue>(path, 'POST', reordered)).data, successor);
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.filter(issue => issue.title === payload.issue.title), [successor]);
  assert.equal(current.dependencies.some(link => link.successorId === successor.id), false);
  const { data: deleted } = await call<{ trashEntryId: string }>(`/issues/${successor.id}?expectedVersion=${successor.version}`, 'DELETE');
  assert.ok(deleted.trashEntryId);
  assert.equal((await call<Failure>(path, 'POST', payload, 409)).data.details.reason, 'result_unavailable');
});

test('successor creation validates versions and the workflow, and rolls back the issue, edge, and receipt on failure', async t => {
  const { call, enableOutbox, observer, sideEffects } = await fixture(t);
  await enableOutbox();
  const { data: predecessor } = await call<Issue>('/issues', 'POST', { projectId, title: '원자적으로 연결할 업무' }, 201);
  const { data: calendar } = await call<WorkCalendar>(`/projects/${projectId}/calendar`);
  const path = successorPath(predecessor.id);
  const workflowPath = `/projects/${projectId}/workflow`;
  const { data: workflow } = await call<ProjectWorkflow>(workflowPath);
  await call(workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    fieldRules: [...workflow.fieldRules, { issueType: predecessor.type, statusId: workflow.initialStatusId, requiredFields: ['description'] }] });

  const payload = successorRequest(predecessor, calendar, { title: '연결 결과를 한번만 저장', assigneeId, type: predecessor.type });
  const receiptAndEffects = () => [...sideEffects(), Number(observer.prepare('SELECT COUNT(*) AS total FROM dependencies').get()?.total)];
  const before = receiptAndEffects();
  const missingSource = await call<Failure>(successorPath('unknown-predecessor'), 'POST', payload, 404);
  assert.equal(missingSource.data.details.reason, 'predecessor_missing');
  for (const request of [
    { ...payload, requestId: undefined }, { ...payload, requestId: '00000000-0000-1000-8000-000000000000' },
    { ...payload, expectedPredecessorVersion: '1' }, { ...payload, expectedCalendarVersion: 0 },
    { ...payload, lagDays: 3651 }, { ...payload, type: 'unknown' }, { ...payload, predecessorId: 'spoofed' },
    { ...payload, issue: null }, { ...payload, issue: { ...payload.issue, projectId: 'project-team' } },
  ]) await call(path, 'POST', request, 400);
  for (const [field, reason, version] of [
    ['expectedPredecessorVersion', 'predecessor_changed', predecessor.version],
    ['expectedCalendarVersion', 'calendar_changed', calendar.version],
  ] as const) {
    const { data } = await call<Failure>(path, 'POST', { ...payload, [field]: version + 1 }, 409);
    assert.deepEqual(data.details, { reason, currentVersion: version });
  }
  await call(path, 'POST', payload, 422);
  assert.deepEqual(receiptAndEffects(), before);

  const complete = { ...payload, issue: { ...payload.issue, description: '워크플로에서 요구하는 설명' } };
  for (const table of ['dependencies', 'issue_creation_requests']) {
    observer.exec(`CREATE TRIGGER fail_successor_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic successor write failure'); END`);
    try {
      await call(path, 'POST', complete, 500);
      assert.deepEqual(receiptAndEffects(), before);
    } finally { observer.exec('DROP TRIGGER fail_successor_write'); }
  }
  const { data: successor } = await call<Issue>(path, 'POST', complete, 201);
  assert.equal(successor.key, `NEO-${before[0]}`);
  assert.deepEqual((await call<Issue>(path, 'POST', complete)).data, successor);
  assert.deepEqual(receiptAndEffects(), before.map((value, index) => value + (index === 2 ? 3 : 1)));
});

const prerequisitePath = (id: string) => `/issues/${id}/schedule-predecessors`;
function prerequisiteRequest(successor: Issue, calendar: WorkCalendar, issue: Record<string, unknown>,
  type: DependencyType = 'FS', lagDays = 0) {
  return { requestId: randomUUID(), expectedSuccessorVersion: successor.version, expectedCalendarVersion: calendar.version,
    type, lagDays, issue };
}

test('new prerequisites use normal issue fields and preserve the existing successor for every dependency type', async t => {
  const { call } = await fixture(t);
  const { data: successor } = await call<Issue>('/issues', 'POST', {
    projectId, title: '기존 후행 업무', startDate: '2026-11-24', endDate: '2026-11-26',
  }, 201);
  const { data: calendar } = await call<WorkCalendar>(`/projects/${projectId}/calendar`);
  for (const [type, lagDays] of [['FS', 0], ['SS', -3650], ['FF', 2], ['SF', 3650]] as const) {
    const fields = { title: `${type} 선행 업무`, startDate: '2026-11-30', endDate: '2026-11-30', assigneeId };
    const { data: prerequisite } = await call<Issue>(prerequisitePath(successor.id), 'POST',
      prerequisiteRequest(successor, calendar, fields, type, lagDays), 201);
    assert.equal(prerequisite.projectId, projectId);
    assert.equal(prerequisite.parentId, null);
    assert.equal(prerequisite.reporterId, actorId);
    assert.equal(prerequisite.assigneeId, assigneeId);
    assert.equal(prerequisite.startDate, fields.startDate);
    assert.equal(prerequisite.endDate, fields.endDate);
    const { data: saved } = await call<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(saved.issues.find(issue => issue.id === successor.id), successor);
    assert.deepEqual(saved.dependencies.filter(link => link.predecessorId === prerequisite.id)
      .map(({ successorId, type, lagDays, version }) => ({ successorId, type, lagDays, version })),
    [{ successorId: successor.id, type, lagDays, version: 1 }]);
    assert.ok(saved.activities.some(activity => activity.resourceId === prerequisite.id && activity.actorId === actorId &&
      activity.action === '티켓 생성'));
    assert.ok(saved.activities.some(activity => activity.resourceId === successor.id && activity.actorId === actorId &&
      activity.action === '선행 업무 연결' && activity.detail === prerequisite.key));
    assert.ok(saved.activities.some(activity => activity.resourceId === successor.id && activity.actorId === actorId &&
      activity.action === '선행 업무 생성' && activity.detail === `${prerequisite.key} ${prerequisite.title}`));
    if (type === 'FS') {
      const { data: preview } = await call<SchedulePreview>('/schedule/preview', 'POST', { issueIds: [successor.id], days: 0 });
      assert.ok(preview.warnings.some(warning => warning.startsWith(`${prerequisite.key} → ${successor.key}`)));
    }
  }
});

test('prerequisite receipts bind the actor, successor and direction and replay without recreating a removed link', async t => {
  const { call, restart } = await fixture(t);
  const { data: successor } = await call<Issue>('/issues', 'POST', { projectId, title: '요청을 확인할 후행 업무' }, 201);
  const { data: other } = await call<Issue>('/issues', 'POST', { projectId, title: '다른 후행 업무' }, 201);
  const calendarPath = `/projects/${projectId}/calendar`;
  const { data: calendar } = await call<WorkCalendar>(calendarPath);
  const payload = prerequisiteRequest(successor, calendar, { title: '한번만 만들 선행 업무', endDate: null }, 'SF', -1);
  const path = prerequisitePath(successor.id);
  const reordered = { issue: { endDate: null, title: payload.issue.title }, lagDays: payload.lagDays, type: payload.type,
    expectedCalendarVersion: payload.expectedCalendarVersion, expectedSuccessorVersion: payload.expectedSuccessorVersion,
    requestId: payload.requestId.toUpperCase() };
  const results = await Promise.all([payload, reordered].map(input => call<Issue>(path, 'POST', input, [200, 201])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  const prerequisite = results[0].data;
  assert.deepEqual(results[1].data, prerequisite);
  assert.equal(prerequisite.startDate, null);
  assert.equal(prerequisite.endDate, null);

  const expectConflict = async (route: string, input: unknown, actor?: string) =>
    assert.equal((await call<Failure>(route, 'POST', input, 409, actor)).data.details.reason, 'request_conflict');
  await expectConflict(path, { ...payload, lagDays: 0 });
  await expectConflict(path, payload, assigneeId);
  await expectConflict(prerequisitePath(other.id), payload);
  await expectConflict(successorPath(successor.id), { ...successorRequest(successor, calendar, payload.issue, payload.type, payload.lagDays),
    requestId: payload.requestId });
  await expectConflict('/issues', { ...payload.issue, projectId, requestId: payload.requestId });

  const { data: saved } = await call<WorkspaceSnapshot>('/workspace');
  const dependency = saved.dependencies.find(link => link.predecessorId === prerequisite.id);
  assert.ok(dependency);
  await call(`/dependencies/${dependency.id}?expectedVersion=${dependency.version}`, 'DELETE');
  await call(`/issues/${successor.id}`, 'PATCH', { title: '재시도 전 수정한 후행 업무', expectedVersion: successor.version });
  await call(calendarPath, 'PATCH', { name: '재시도 전 수정한 달력', expectedVersion: calendar.version });
  await restart();
  assert.deepEqual((await call<Issue>(path, 'POST', reordered)).data, prerequisite);
  const { data: current } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(current.issues.filter(issue => issue.title === payload.issue.title), [prerequisite]);
  assert.ok(!current.dependencies.some(link => link.predecessorId === prerequisite.id));
  await call(`/issues/${prerequisite.id}?expectedVersion=${prerequisite.version}`, 'DELETE');
  assert.equal((await call<Failure>(path, 'POST', payload, 409)).data.details.reason, 'result_unavailable');
});

test('prerequisite creation rejects stale versions and rolls back workflow errors and failed writes', async t => {
  const { call, enableOutbox, observer, sideEffects } = await fixture(t);
  await enableOutbox();
  const { data: successor } = await call<Issue>('/issues', 'POST', { projectId, title: '선행 업무를 만들 대상' }, 201);
  const { data: calendar } = await call<WorkCalendar>(`/projects/${projectId}/calendar`);
  const workflowPath = `/projects/${projectId}/workflow`;
  const { data: workflow } = await call<ProjectWorkflow>(workflowPath);
  await call(workflowPath, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    fieldRules: [...workflow.fieldRules, { issueType: successor.type, statusId: workflow.initialStatusId, requiredFields: ['description'] }] });
  const path = prerequisitePath(successor.id);
  const payload = prerequisiteRequest(successor, calendar, { title: '원자적으로 만들 선행 업무', assigneeId, type: successor.type });
  const persisted = () => [...sideEffects(), Number(observer.prepare('SELECT COUNT(*) AS total FROM dependencies').get()?.total)];
  const before = persisted();
  const { data: missing } = await call<Failure>(prerequisitePath('unknown-successor'), 'POST', payload, 404);
  assert.equal(missing.details.reason, 'successor_missing');
  for (const input of [
    { ...payload, requestId: undefined }, { ...payload, expectedSuccessorVersion: '1' }, { ...payload, expectedCalendarVersion: 0 },
    { ...payload, lagDays: -3651 }, { ...payload, type: 'unknown' }, { ...payload, successorId: 'spoofed' },
    { ...payload, issue: null }, { ...payload, issue: { ...payload.issue, projectId: 'project-team' } },
  ]) await call(path, 'POST', input, 400);
  for (const [field, reason, currentVersion] of [
    ['expectedSuccessorVersion', 'successor_changed', successor.version],
    ['expectedCalendarVersion', 'calendar_changed', calendar.version],
  ] as const) {
    const { data } = await call<Failure>(path, 'POST', { ...payload, [field]: currentVersion + 1 }, 409);
    assert.deepEqual(data.details, { reason, currentVersion });
  }
  await call(path, 'POST', payload, 422);
  assert.deepEqual(persisted(), before);

  const complete = { ...payload, issue: { ...payload.issue, description: '워크플로에서 요구하는 설명' } };
  for (const table of ['dependencies', 'issue_creation_requests']) {
    observer.exec(`CREATE TRIGGER fail_prerequisite_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic prerequisite write failure'); END`);
    try {
      await call(path, 'POST', complete, 500);
      assert.deepEqual(persisted(), before);
    } finally { observer.exec('DROP TRIGGER fail_prerequisite_write'); }
  }
  const { data: prerequisite } = await call<Issue>(path, 'POST', complete, 201);
  assert.equal(prerequisite.key, `NEO-${before[0]}`);
  assert.deepEqual((await call<Issue>(path, 'POST', complete)).data, prerequisite);
  assert.deepEqual(persisted(), before.map((value, index) => value + (index === 2 ? 3 : 1)));
});

test('document create retries bind imported section links once with one draft and one revision', async t => {
  const { call, observer, restart } = await fixture(t);
  const sectionId = markdownImportSectionId(1), missingSectionId = markdownImportSectionId(2);
  const input = {
    requestId: randomUUID(), projectId: null, title: 'Markdown 배포 안내',
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: '배포 절 열기', marks: [{ type: 'link', attrs: { href: `#${sectionId}` } }] },
        { type: 'text', text: '일치하지 않는 링크', marks: [{ type: 'link', attrs: { href: `#${missingSectionId}` } }] },
      ] },
      { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: '배포' }] },
    ] },
  };
  const before = Number(observer.prepare('SELECT COUNT(*) AS n FROM documents').get()?.n);
  await call('/documents', 'POST', { ...input, requestId: '' }, 400);
  const retries = await Promise.all([
    call<DocPage>('/documents', 'POST', input, [200, 201]),
    call<DocPage>('/documents', 'POST', { ...input, requestId: input.requestId.toUpperCase() }, [200, 201]),
  ]);
  assert.deepEqual(retries.map(row => row.status).sort(), [200, 201]);
  const document = retries[0].data;
  assert.deepEqual(retries[1].data, document);
  assert.equal(document.status, 'draft');
  assert.deepEqual(document.content.content?.[0].content?.map(row => row.marks?.[0].attrs?.href),
    [documentSectionHash(document.id, sectionId), `#${missingSectionId}`]);
  assert.equal(Number(observer.prepare('SELECT COUNT(*) AS n FROM documents').get()?.n), before + 1);
  const { data: revisions } = await call<DocRevision[]>(`/documents/${document.id}/revisions`);
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].content, document.content);
  const { data: workspace } = await call<WorkspaceSnapshot>('/workspace');
  assert.equal(workspace.activities.filter(row => row.resourceId === document.id && row.action === '문서 생성').length, 1);
  assert.equal((await call<Failure>('/documents', 'POST', { ...input, title: '변경한 입력' }, 409)).data.details.reason, 'request_conflict');
  assert.equal((await call<Failure>('/documents', 'POST', input, 409, assigneeId)).data.details.reason, 'request_conflict');
  await restart();
  assert.deepEqual((await call<DocPage>('/documents', 'POST', input)).data, document);
});

test('document request receipts roll back with creation and follow trash and native replacement', async t => {
  const { call, observer } = await fixture(t);
  const input = { requestId: randomUUID(), projectId, title: '재시도 문서' };
  observer.exec("CREATE TRIGGER fail_document_receipt BEFORE INSERT ON document_creation_requests BEGIN SELECT RAISE(ABORT,'synthetic document receipt failure'); END");
  try {
    await call('/documents', 'POST', input, 500);
    assert.equal((await call<WorkspaceSnapshot>('/workspace')).data.documents.some(row => row.title === input.title), false);
  } finally { observer.exec('DROP TRIGGER fail_document_receipt'); }
  const { data: document } = await call<DocPage>('/documents', 'POST', input, 201);
  const { data: { trashEntryId } } = await call<{ trashEntryId: string }>(`/documents/${document.id}?expectedVersion=${document.version}`, 'DELETE');
  const unavailable = async () => assert.equal((await call<Failure>('/documents', 'POST', input, 409)).data.details.reason, 'result_unavailable');
  await unavailable();
  await call(`/trash/${trashEntryId}/restore`, 'POST', {});
  assert.equal((await call<DocPage>('/documents', 'POST', input)).data.id, document.id);
  const backup = (await call<WorkspaceSnapshot>('/export')).data;
  assert.equal(JSON.stringify(backup).includes(input.requestId), false);
  await call('/import', 'POST', { data: backup });
  await unavailable();
  const legacy = await call<DocPage>('/documents', 'POST', { projectId, title: input.title }, 201);
  assert.notEqual(legacy.data.id, document.id);

  const { data: key } = await call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '문서 생성 키', projectIds: [projectId], access: 'write', expiresAt: null,
  }, 201);
  const apiInput = { ...input, requestId: randomUUID(), title: '자동화로 저장한 문서' };
  const { data: created } = await call<DocPage>('/v1/documents', 'POST', apiInput, 201, assigneeId, key.token);
  assert.deepEqual((await call<DocPage>('/v1/documents', 'POST', apiInput, 200, assigneeId, key.token)).data, created);
  assert.equal(created.authorId, actorId);
});
