import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  Dependency, Issue, IssuePastePreview, IssuePasteResult, ProjectIssueOrder, ProjectWorkflow, WebhookEndpointCreated, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const actorId = 'user-seo';
const assigneeId = 'user-min';
const path = (project = projectId) => `/projects/${project}/issues/paste`;
type Conflict = { details: { reason: string } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-paste-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  const database = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  async function stop() {
    service.server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())); }
    finally { service.runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(url: string, method = 'GET', body?: unknown,
    expectedStatus: number | number[] = 200, actor = actorId) {
    const response = await fetch(service.url + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as T;
    assert.ok([expectedStatus].flat().includes(response.status), `${response.status} ${JSON.stringify(result)}`);
    return { status: response.status, result };
  }
  async function preview(text: string, project = projectId) {
    return (await request<IssuePastePreview>(`${path(project)}-preview`, 'POST', { text })).result;
  }
  async function apply<T = IssuePasteResult>(previewId: string, status: number | number[] = 201, actor = actorId, project = projectId) {
    return request<T>(`${path(project)}-apply`, 'POST', { previewId }, status, actor);
  }
  function counts() {
    const sequence = Number(database.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number);
    return [sequence, ...['issues', 'activities', 'team_notifications', 'webhook_events', 'webhook_deliveries']
      .map(table => Number(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total))];
  }
  async function enableOutbox() {
    const { result: { endpoint } } = await request<WebhookEndpointCreated>('/webhook-endpoints', 'POST', {
      name: '합성 일괄 등록', url: 'http://127.0.0.1:9/listener', eventTypes: ['issue.created'], projectIds: [projectId],
    }, 201);
    await request(`/webhook-endpoints/${endpoint.id}`, 'PATCH', { expectedVersion: endpoint.version, enabled: true });
  }
  return { request, preview, apply, counts, database, enableOutbox, async restart() { await stop(); service = await start(); } };
}

const basic = '제목\n합성 업무 A\n합성 업무 B';
const linkedSheet = (rows: string[][]) => [
  ['제목', '임시 키', '선행 업무', '연결 유형', '근무일 간격', '시작일', '종료일', '담당자'],
  ...rows,
].map(row => row.join('\t')).join('\n');

test('issue paste reviews ordinary fields without side effects and applies the same actor-bound batch once', async t => {
  const { request, preview, apply, counts, enableOutbox, restart } = await fixture(t);
  await enableOutbox();
  const before = counts();
  const input = [
    '제목,설명,유형,상태,우선순위,담당자,시작일,종료일,목표 마감일,라벨',
    '"간트 준비, 1단계","첫 줄\r\n두 번째 줄",개선,진행 중,높음,MINSU@EXAMPLE.TEST,2026-12-01,2026-12-04,2026-12-09,"검토,회의,검토"',
    '실행 완료,,작업,done,LOW,김민수,2026-12-05,,,',
  ].join('\r\n');
  const proposal = await preview(input);
  assert.ok(proposal.previewId);
  assert.deepEqual(proposal.errors, []);
  assert.deepEqual(proposal.rows.map(row => row.line), [2, 4]);
  assert.deepEqual(proposal.rows[0], {
    line: 2, title: '간트 준비, 1단계', description: '첫 줄\r\n두 번째 줄', type: '개선',
    status: 'in_progress', priority: 'high', assigneeId, startDate: '2026-12-01', endDate: '2026-12-04',
    dueDate: '2026-12-09', labels: ['검토', '회의'],
    typeName: '개선', statusLabel: '진행 중', assigneeLabel: '김민수',
  });
  assert.deepEqual(counts(), before);
  assert.equal((await apply<Conflict>(proposal.previewId, 409, assigneeId)).result.details.reason, 'stale_preview');
  assert.equal((await apply<Conflict>(proposal.previewId, 409, actorId, 'project-team')).result.details.reason, 'stale_preview');
  await restart();
  const results = await Promise.all([apply(proposal.previewId, [200, 201]), apply(proposal.previewId, [200, 201])]);
  const applied = results.find(result => result.status === 201);
  const repeated = results.find(result => result.status === 200);
  assert.ok(applied && repeated);
  assert.equal(applied.result.duplicate, false);
  assert.deepEqual(repeated.result, { issues: applied.result.issues, duplicate: true });
  const [first, second] = applied.result.issues;
  assert.deepEqual([first.key, second.key], [`NEO-${before[0]}`, `NEO-${before[0] + 1}`]);
  assert.deepEqual([first.reporterId, second.reporterId], [actorId, actorId]);
  assert.equal(first.endDate, '2026-12-04');
  assert.equal(second.endDate, null);
  assert.equal(second.assigneeId, assigneeId);
  assert.equal(second.completedAt, second.createdAt);
  assert.equal(first.completedAt, null);
  assert.deepEqual(counts(), before.map(count => count + 2));
  const { result: order } = await request<ProjectIssueOrder>(`/projects/${projectId}/issue-order`);
  assert.deepEqual(order.issueIds.slice(-2), [first.id, second.id]);
  const { result: workspace } = await request<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.activities.filter(activity => activity.resourceId === first.id && activity.action === '티켓 생성')
    .map(activity => activity.actorId), [actorId]);
  await restart();
  assert.deepEqual((await apply(proposal.previewId, 200)).result, repeated.result);
  assert.equal((await apply<Conflict>(proposal.previewId, 409, assigneeId)).result.details.reason, 'stale_preview');
  assert.deepEqual(counts(), before.map(count => count + 2));
});

test('issue paste blocks inconsistent dates, ambiguous assignees and changed workflow requirements', async t => {
  const { request, preview, apply, counts } = await fixture(t);
  await request('/users', 'POST', { name: '김민수', email: 'minsu-2@example.test' }, 201);
  const before = counts();
  const invalid = await preview([
    '제목\t시작일\t종료일\t담당자',
    '정상\t2026-12-01\t2026-12-05\t',
    '거꾸로\t2026-12-05\t2026-12-01\t',
    '동명이인\t\t\t김민수',
    '잘못된 날짜\t2026-02-29\t\t',
  ].join('\n'));
  assert.equal(invalid.previewId, null);
  assert.deepEqual(invalid.rows.map(row => row.title), ['정상']);
  assert.deepEqual(invalid.errors.map(error => error.line), [3, 4, 5]);
  assert.match(invalid.errors[1].message, /여러 개/);
  assert.deepEqual(counts(), before);
  const byEmail = await preview('제목,담당자\n동명이인 확인,minsu@example.test');
  assert.ok(byEmail.previewId);
  assert.equal(byEmail.rows[0]?.assigneeLabel, '김민수 (minsu@example.test)');
  await request(`/users/${assigneeId}`, 'PATCH', { name: '김민수(개발)' });
  assert.equal((await apply<Conflict>(byEmail.previewId, 409)).result.details.reason, 'stale_preview');

  const verified = await preview(basic);
  assert.ok(verified.previewId);
  const workflowPath = `/projects/${projectId}/workflow`;
  const { result: workflow } = await request<ProjectWorkflow>(workflowPath);
  await request(workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    fieldRules: [{ issueType: '*', statusId: workflow.initialStatusId, requiredFields: ['dueDate'] }],
  });
  const beforeStale = counts();
  const conflict = await apply<Conflict>(verified.previewId, 409);
  assert.equal(conflict.result.details.reason, 'stale_preview');
  const after = await preview(basic);
  assert.equal(after.previewId, null);
  assert.deepEqual(after.errors.map(error => error.line), [2, 3]);
  assert.match(after.errors[0].message, /마감일/);
  assert.deepEqual(counts(), beforeStale);
});

test('issue paste rolls back all ordinary effects on a later insert failure and reports deleted results safely', async t => {
  const { request, preview, apply, database, counts, enableOutbox } = await fixture(t);
  await enableOutbox();
  const before = counts();
  const verified = await preview(basic);
  assert.ok(verified.previewId);
  database.exec(`CREATE TRIGGER fail_second_issue_paste BEFORE INSERT ON issues
    WHEN json_extract(NEW.json, '$.title')='합성 업무 B' BEGIN
      SELECT RAISE(ABORT,'synthetic second-row failure');
    END`);
  try {
    await apply(verified.previewId, 500);
    assert.deepEqual(counts(), before);
  } finally {
    database.exec('DROP TRIGGER fail_second_issue_paste');
  }
  const { result } = await apply(verified.previewId);
  const second = result.issues[1];
  const { result: trashed } = await request<{ trashEntryId: string }>(
    `/issues/${second.id}?expectedVersion=${second.version}`, 'DELETE',
  );
  const deleted = await apply<Conflict>(verified.previewId, 409);
  assert.equal(deleted.result.details.reason, 'result_unavailable');
  await request(`/trash/${trashed.trashEntryId}/restore`, 'POST', {});
  const { result: repeated } = await apply(verified.previewId, 200);
  assert.deepEqual(repeated.issues.map(({ id }) => id), result.issues.map(({ id }) => id));
});

test('issue paste rejects expired previews and clears pre-replacement IDs during native import', async t => {
  const { request, preview, apply, database } = await fixture(t);
  const expired = await preview(basic);
  assert.ok(expired.previewId);
  database.prepare('UPDATE issue_paste_requests SET expires_at=0 WHERE id=?').run(expired.previewId);
  assert.equal((await apply<Conflict>(expired.previewId, 409)).result.details.reason, 'stale_preview');

  const confirmed = await preview(basic);
  assert.ok(confirmed.previewId);
  const { result: saved } = await apply(confirmed.previewId);
  const waiting = await preview('제목\n아직 검토 중');
  assert.ok(waiting.previewId);
  const { result: backup } = await request<{ issues: Issue[] }>('/export');
  assert.ok(!JSON.stringify(backup).includes(confirmed.previewId));
  await request('/import', 'POST', { data: backup });
  for (const id of [waiting.previewId, confirmed.previewId]) {
    assert.equal((await apply<Conflict>(id, 409)).result.details.reason, 'stale_preview');
  }
  const { result: workspace } = await request<WorkspaceSnapshot>('/workspace');
  const created = workspace.issues.filter(issue => issue.title.startsWith('합성 업무 '));
  assert.deepEqual(created.map(issue => issue.id), saved.issues.map(issue => issue.id));
});

test('issue paste resolves forward and existing predecessors and replays the exact created links across restart', async t => {
  const { request, preview, apply, counts, restart } = await fixture(t);
  const { result: existing } = await request<Issue>('/issues', 'POST', {
    projectId, title: '이미 등록한 설계 준비', startDate: '2026-11-20', endDate: '2026-11-20',
  }, 201);
  const before = counts();
  const { result: prior } = await request<WorkspaceSnapshot>('/workspace');
  const proposal = await preview(linkedSheet([
    ['통합 배포', 'release', `${existing.key},new:design`, 'FS,SS', '0,-1', '2026-11-23', '2026-11-25', assigneeId],
    ['통합 설계', 'design', '', '', '', '2026-11-24', '2026-11-26', assigneeId],
    ['통합 검토', 'review', 'new:release', '', '', '', '2026-11-27', assigneeId],
  ]));
  assert.ok(proposal.previewId);
  assert.deepEqual(proposal.errors, []);
  assert.deepEqual(proposal.rows.map(row => [row.line, row.temporaryKey]), [[2, 'release'], [3, 'design'], [4, 'review']]);
  assert.deepEqual(proposal.rows[0].predecessors?.map(({ predecessor, type, lagDays }) => ({ predecessor, type, lagDays })), [
    { predecessor: { kind: 'existing', issueId: existing.id, key: existing.key, title: existing.title }, type: 'FS', lagDays: 0 },
    { predecessor: { kind: 'new', line: 3, temporaryKey: 'design', title: '통합 설계' }, type: 'SS', lagDays: -1 },
  ]);
  assert.match(proposal.rows[2].predecessors?.[0]?.warning ?? '', /시작일/u);
  assert.deepEqual(counts(), before);
  assert.deepEqual((await request<WorkspaceSnapshot>('/workspace')).result.dependencies, prior.dependencies);

  await restart();
  const responses = await Promise.all([apply(proposal.previewId, [200, 201]), apply(proposal.previewId, [200, 201])]);
  const created = responses.find(response => response.status === 201)?.result;
  const duplicate = responses.find(response => response.status === 200)?.result;
  assert.ok(created && duplicate && created.dependencies);
  assert.deepEqual(duplicate, { ...created, duplicate: true });
  const [release, design, review] = created.issues;
  assert.deepEqual(created.issues.map(issue => [issue.title, issue.key, issue.reporterId, issue.assigneeId]), [
    ['통합 배포', `NEO-${before[0]}`, actorId, assigneeId],
    ['통합 설계', `NEO-${before[0] + 1}`, actorId, assigneeId],
    ['통합 검토', `NEO-${before[0] + 2}`, actorId, assigneeId],
  ]);
  const { result: workspace } = await request<WorkspaceSnapshot>('/workspace');
  const createdLinkIds = new Set(created.dependencies.map(link => link.id));
  const links = workspace.dependencies.filter(link => createdLinkIds.has(link.id));
  assert.deepEqual(links, created.dependencies);
  assert.deepEqual(links.map(({ predecessorId, successorId, type, lagDays, version }) => [predecessorId, successorId, type, lagDays, version]), [
    [existing.id, release.id, 'FS', 0, 1],
    [design.id, release.id, 'SS', -1, 1],
    [release.id, review.id, 'FS', 0, 1],
  ]);
  assert.equal(review.startDate, null);
  const linkActivities = workspace.activities.filter(activity => [release.id, design.id, review.id].includes(activity.resourceId) &&
    activity.action === '선행 업무 연결');
  assert.deepEqual(new Set(linkActivities.map(activity => [activity.resourceId, activity.detail].join(':'))),
    new Set([`${release.id}:${existing.key}`, `${release.id}:${design.key}`, `${review.id}:${release.key}`]));
  assert.equal(linkActivities.length, 3);
  assert.ok(linkActivities.every(activity => activity.actorId === actorId));

  const [removed, edited] = links;
  await request(`/dependencies/${removed.id}?expectedVersion=${removed.version}`, 'DELETE');
  const { result: updated } = await request<Dependency>(`/dependencies/${edited.id}`, 'PATCH', {
    expectedVersion: edited.version, type: 'SF', lagDays: 3,
  });
  assert.equal(updated.type, 'SF');
  assert.equal(updated.lagDays, 3);
  await restart();
  assert.deepEqual((await apply(proposal.previewId, 200)).result, duplicate);
  const { result: afterReplay } = await request<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(afterReplay.dependencies.filter(link => createdLinkIds.has(link.id)), [updated, links[2]]);
});

test('linked issue paste rejects invalid graphs and guards the existing predecessor and calendar at apply', async t => {
  const { request, preview, apply, counts } = await fixture(t);
  const { result: existing } = await request<Issue>('/issues', 'POST', {
    projectId, title: '수정할 실제 선행 업무', startDate: '2026-11-20', endDate: '2026-11-20',
  }, 201);
  const { result: foreign } = await request<Issue>('/issues', 'POST', { projectId: 'project-team', title: '다른 프로젝트 선행 업무' }, 201);
  const before = counts();
  const invalidSheets = [
    { name: 'cycle', rows: [['순환 A', 'a', 'new:b', '', '', '', '', ''], ['순환 B', 'b', 'new:a', '', '', '', '', '']] },
    { name: 'foreign', rows: [['다른 프로젝트를 가리킴', 'a', foreign.key, '', '', '', '', '']] },
    { name: 'missing local reference', rows: [['없는 행을 가리킴', 'a', 'new:unknown', '', '', '', '', '']] },
    { name: 'duplicate edge', rows: [['같은 업무를 두 번 가리킴', 'a', `${existing.key},${existing.key}`, '', '', '', '', '']] },
  ];
  for (const { name, rows } of invalidSheets) {
    const rejected = await preview(linkedSheet(rows));
    assert.equal(rejected.previewId, null, name);
    assert.ok(rejected.errors.some(error => error.line === 2 || (name === 'cycle' && error.line === 3)), name);
    if (name === 'cycle') assert.match(rejected.errors.map(error => error.message).join('\n'), /순환/u);
  }
  assert.deepEqual(counts(), before);

  const text = linkedSheet([
    ['검토 이후 변경을 확인할 업무', 'a', existing.key, '', '', '2026-11-24', '2026-11-26', assigneeId],
  ]);
  const reviewed = await preview(text);
  assert.ok(reviewed.previewId);
  await request(`/issues/${existing.id}`, 'PATCH', { expectedVersion: existing.version, endDate: '2026-11-24' });
  const afterIssue = counts();
  assert.equal((await apply<Conflict>(reviewed.previewId, 409)).result.details.reason, 'stale_preview');
  assert.deepEqual(counts(), afterIssue);

  const reviewAfterIssue = await preview(text);
  assert.ok(reviewAfterIssue.previewId);
  const calendarPath = `/projects/${projectId}/calendar`;
  const { result: calendar } = await request<WorkCalendar>(calendarPath);
  await request(calendarPath, 'PATCH', { expectedVersion: calendar.version, name: '변경한 작업 달력' });
  const afterCalendar = counts();
  assert.equal((await apply<Conflict>(reviewAfterIssue.previewId, 409)).result.details.reason, 'stale_preview');
  assert.deepEqual(counts(), afterCalendar);
});

test('a late dependency write failure rolls back created issues, links, sequence and effects before retry', async t => {
  const { request, preview, apply, database, counts, enableOutbox } = await fixture(t);
  const { result: existing } = await request<Issue>('/issues', 'POST', { projectId, title: '원자적 저장의 선행 업무' }, 201);
  await enableOutbox();
  const before = counts();
  const { result: prior } = await request<WorkspaceSnapshot>('/workspace');
  const reviewed = await preview(linkedSheet([
    ['의존성 검증 첫째', 'a', `${existing.key},new:b`, 'FS,FF', '0,-1', '', '', assigneeId],
    ['의존성 검증 둘째', 'b', '', '', '', '', '', assigneeId],
  ]));
  assert.ok(reviewed.previewId);
  const receipt = () => database.prepare('SELECT json, expires_at FROM issue_paste_requests WHERE id=?').get(reviewed.previewId);
  const priorReceipt = receipt();
  database.exec(`CREATE TRIGGER fail_last_issue_paste_dependency BEFORE INSERT ON dependencies
    WHEN (SELECT COUNT(*) FROM dependencies) > ${prior.dependencies.length} BEGIN
      SELECT RAISE(ABORT,'synthetic final dependency failure');
    END`);
  try {
    await apply(reviewed.previewId, 500);
    assert.deepEqual(counts(), before);
    const { result: afterFailure } = await request<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(afterFailure.dependencies, prior.dependencies);
    assert.deepEqual(afterFailure.issues, prior.issues);
    assert.deepEqual(receipt(), priorReceipt);
  } finally {
    database.exec('DROP TRIGGER fail_last_issue_paste_dependency');
  }

  const { result: created } = await apply(reviewed.previewId);
  assert.deepEqual(created.issues.map(issue => issue.key), [`NEO-${before[0]}`, `NEO-${before[0] + 1}`]);
  assert.equal(created.dependencies?.length, 2);
  const committed = counts();
  assert.deepEqual((await apply(reviewed.previewId, 200)).result, { ...created, duplicate: true });
  assert.deepEqual(counts(), committed);
  const { result: after } = await request<WorkspaceSnapshot>('/workspace');
  assert.equal(after.dependencies.length, prior.dependencies.length + 2);
});
