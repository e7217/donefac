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
import { reservationLocalDateTime } from '../../shared/time-reservations.js';
import type {
  ApiKeyCreated, DocPage, DocumentPublicationView, GitlabLink, Issue, IssueTimeReservationEntry, Project, ProjectWorkflow,
  TeamOverviewResult, User,
} from '../../shared/types.js';

const reference = '2026-11-20';
const query = new URLSearchParams({ date: reference }).toString();

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-overview-'));
  const service = createApp({ dataDir: directory, seed: false, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function response(path: string, options: { method?: string; body?: unknown; actor?: string; token?: string } = {}) {
    return fetch(base + path, {
      method: options.method,
      headers: { 'Content-Type': 'application/json', ...(options.actor ? { 'X-Actor-Id': options.actor } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function call<T = unknown>(path: string, expected = 200, options?: Parameters<typeof response>[1]) {
    const result = await response(path, options);
    const body: unknown = await result.json();
    assert.equal(result.status, expected, JSON.stringify(body));
    return body as T;
  }
  const member = await call<User>('/users', 201, { method: 'POST', body: { name: '합성 담당자', email: 'member@example.invalid' } });
  const teammate = await call<User>('/users', 201, { method: 'POST', body: { name: '합성 팀원', email: 'teammate@example.invalid' } });
  const project = await call<Project>('/projects', 201, { method: 'POST', body: { key: 'OVERVIEW', name: '합성 개요 프로젝트' } });
  const otherProject = await call<Project>('/projects', 201, { method: 'POST', body: { key: 'OTHER', name: '합성 다른 프로젝트' } });
  return {
    directory, call, response, member, teammate, project, otherProject,
    issue: (title: string, fields: Partial<Issue> = {}) => call<Issue>('/issues', 201, { method: 'POST', body: { projectId: project.id, title, ...fields } }),
    overview: (filters: Record<string, string> = {}) => call<TeamOverviewResult>(`/team-overview?${new URLSearchParams({ date: reference, ...filters })}`),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function gitlabLink(f: Fixture, issue: Issue, id: string, updatedAt: string): void {
  const link: GitlabLink = { id, issueId: issue.id, projectId: 412, iid: 1, kind: 'merge_request', title: id,
    webUrl: 'https://gitlab.example.invalid/test/repo/-/merge_requests/1', state: 'opened', updatedAt };
  const db = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try { db.prepare('INSERT INTO gitlab_links(id,issue_id,json) VALUES (?,?,?)').run(id, issue.id, JSON.stringify(link)); }
  finally { db.close(); }
}

async function draftReview(f: Fixture, title: string, projectId: string | null, reviewerId: string) {
  const document = await f.call<DocPage>('/documents', 201, {
    method: 'POST', body: { projectId, title, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIVATE_BODY' }] }] } },
  });
  const current = await f.call<DocumentPublicationView>(`/documents/${document.id}/publication`);
  const author = reviewerId === f.member.id ? f.teammate.id : f.member.id;
  const review = await f.call<DocumentPublicationView>(`/documents/${document.id}/publication`, 200, {
    method: 'POST', actor: author,
    body: { action: 'request', expectedVersion: current.version, workspaceGeneration: current.workspaceGeneration,
      expectedDocumentVersion: document.version, reviewerId, note: 'PRIVATE_NOTE' },
  });
  return { document, review };
}

async function reserve(f: Fixture, issue: Issue, userId: string, startAt: string, endAt: string) {
  return f.call<IssueTimeReservationEntry>(`/issues/${issue.id}/time-reservations`, 201, {
    method: 'POST', body: { userId, startAt, endAt, requestId: randomUUID() },
  });
}

test('team overview aggregates custom active workflows and effective deadlines; GitLab uses linked projects and Seoul cutoffs', async t => {
  const f = await fixture(t);
  const projectId = f.project.id, memberId = f.member.id;
  const configuration = await f.call<ProjectWorkflow>(`/projects/${projectId}/workflow`);
  await f.call(`/projects/${projectId}/workflow`, 200, {
    method: 'PATCH', body: { expectedVersion: configuration.version, ...configuration,
      statuses: [...configuration.statuses,
        { id: 'custom_review', label: '팀 확인', category: 'review', color: '#58a4bd' },
        { id: 'custom_shipped', label: '배포 완료', category: 'done', color: '#47835c' }],
    },
  });
  const overdue = await f.issue('목표 마감일 우선', { status: 'custom_review', assigneeId: f.teammate.id, collaboratorIds: [memberId],
    dueDate: '2026-11-19', startDate: reference, endDate: '2026-11-26' });
  const today = await f.issue('계획 종료일 대체', { assigneeId: memberId, endDate: reference });
  const soon = await f.issue('일곱 번째 날 포함', { assigneeId: memberId, dueDate: '2026-11-27' });
  const later = await f.issue('여덟 번째 날 제외', { assigneeId: memberId, dueDate: '2026-11-28', startDate: reference, endDate: '2026-11-22' });
  const noAssignee = await f.issue('날짜 없는 협력 업무', { collaboratorIds: [memberId] });
  const terminal = await f.issue('사용자 정의 완료 업무', { status: 'custom_shipped', assigneeId: memberId, dueDate: reference });
  await f.issue('취소 업무', { status: 'cancelled', assigneeId: memberId, dueDate: '2026-11-18' });
  const other = await f.issue('다른 프로젝트', { projectId: f.otherProject.id, assigneeId: f.teammate.id, dueDate: reference });
  gitlabLink(f, overdue, 'first-in-week', '2026-11-13T15:00:00.000Z');
  gitlabLink(f, today, 'before-start', '2026-11-13T14:59:59.999Z');
  gitlabLink(f, today, 'next-day', '2026-11-20T15:00:00.000Z');
  gitlabLink(f, noAssignee, 'invalid', '2026-11-31T00:00:00.000Z');
  gitlabLink(f, other, 'other-project', '2026-11-20T11:59:59.999Z');
  for (let index = 0; index < 11; index++) {
    gitlabLink(f, terminal, `terminal-${String(index).padStart(2, '0')}`, '2026-11-20T14:59:59.999Z');
  }

  const scoped = await f.overview({ projectId, memberId });
  assert.equal(scoped.timeZone, 'Asia/Seoul');
  assert.deepEqual(scoped.totals, { open: 5, overdue: 1, dueSoon: 2, unscheduled: 3, unassigned: 1 });
  assert.equal(Object.hasOwn(scoped, 'issueQueue'), false);
  assert.deepEqual(scoped.projects, [{ projectId, ...scoped.totals }]);
  assert.deepEqual(scoped.deadlines.items.map(item => [item.id, item.deadlineSource, item.timing]), [
    [overdue.id, 'dueDate', 'overdue'], [today.id, 'endDate', 'today'], [soon.id, 'dueDate', 'soon'],
  ]);
  assert.equal(scoped.deadlines.items[0].statusLabel, '팀 확인');
  assert.ok(!scoped.deadlines.items.some(item => item.id === later.id || item.id === terminal.id));
  assert.deepEqual([scoped.gitlab.total, scoped.gitlab.offset, scoped.gitlab.limit], [12, 0, 10]);
  assert.deepEqual(scoped.gitlab.items.map(item => [item.issueId, item.projectId, item.link.projectId]), Array(10).fill([terminal.id, projectId, 412]));
  const second = await f.overview({ projectId, memberId, gitlabOffset: '10', deadlineOffset: '10' });
  assert.deepEqual(second.gitlab.items.map(item => item.link.id), ['terminal-10', 'first-in-week']);
  assert.deepEqual(second.deadlines, { total: 3, offset: 10, limit: 10, items: [] });
  const whole = await f.overview();
  assert.equal(whole.totals.open, 6);
  assert.equal(whole.gitlab.total, 13);

  for (const [issueMetric, expected] of [
    ['open', [overdue, today, soon, later, noAssignee]],
    ['overdue', [overdue]],
    ['dueSoon', [today, soon]],
    ['unscheduled', [today, soon, noAssignee]],
    ['unassigned', [noAssignee]],
  ] as const) {
    const result = await f.overview({ projectId, memberId, issueMetric });
    assert.deepEqual(result.totals, scoped.totals);
    assert.deepEqual(result.deadlines, scoped.deadlines);
    assert.equal(result.issueQueue?.metric, issueMetric);
    assert.equal(result.issueQueue.total, scoped.totals[issueMetric]);
    assert.deepEqual(result.issueQueue.items.map(item => item.id), expected.map(item => item.id));
  }
  const open = (await f.overview({ projectId, memberId, issueMetric: 'open' })).issueQueue;
  assert.ok(open);
  assert.deepEqual(open.items.map(row => [row.startDate, row.endDate, row.deadline, row.deadlineSource, row.timing]), [
    [reference, '2026-11-26', '2026-11-19', 'dueDate', 'overdue'],
    [null, reference, reference, 'endDate', 'today'],
    [null, null, '2026-11-27', 'dueDate', 'soon'],
    [reference, '2026-11-22', '2026-11-28', 'dueDate', 'later'],
    [null, null, null, null, null],
  ]);
  assert.deepEqual(open.items[0], {
    id: overdue.id, projectId, key: overdue.key, title: overdue.title, assigneeId: f.teammate.id,
    startDate: reference, endDate: '2026-11-26', deadline: '2026-11-19', deadlineSource: 'dueDate', timing: 'overdue',
    priority: overdue.priority, statusLabel: '팀 확인', statusColor: '#58a4bd',
  });
  const acrossProjects = await f.overview({ issueMetric: 'open' });
  assert.ok(acrossProjects.issueQueue?.items.some(item => item.id === other.id));
  assert.ok(!acrossProjects.issueQueue?.items.some(item => item.id === terminal.id));
});

test('team overview independently pages the chosen issue metric by deadline, priority and numeric issue key', async t => {
  const f = await fixture(t);
  const first = await f.issue('날짜를 먼저 표시', { priority: 'low', endDate: reference });
  const urgent = await f.issue('날짜 없는 긴급 업무', { priority: 'urgent' });
  const undated = [];
  for (let index = 0; index < 10; index++) undated.push(await f.issue(`날짜 없는 업무 ${index}`));
  const unscoped = await f.overview({ issueMetric: 'unassigned' });
  assert.ok(unscoped.issueQueue);
  assert.deepEqual([unscoped.issueQueue.total, unscoped.issueQueue.offset, unscoped.issueQueue.limit], [12, 0, 10]);
  assert.deepEqual(unscoped.issueQueue.items.map(item => item.id), [first.id, urgent.id, ...undated.slice(0, 8).map(issue => issue.id)]);
  const next = await f.overview({ issueMetric: 'unassigned', issueOffset: '10' });
  assert.deepEqual(next.issueQueue?.items.map(item => item.id), undated.slice(8).map(issue => issue.id));
  assert.deepEqual(next.deadlines, unscoped.deadlines);
  const empty = await f.overview({ issueMetric: 'unassigned', memberId: f.member.id });
  assert.deepEqual(empty.issueQueue, { metric: 'unassigned', total: 0, offset: 0, limit: 10, items: [] });
  const stale = await f.overview({ issueMetric: 'unassigned', issueOffset: '20' });
  assert.deepEqual(stale.issueQueue, { metric: 'unassigned', total: 12, offset: 20, limit: 10, items: [] });
});

test('team overview pages pinned pending reviews and today’s reservations independently by reviewer and assigned user', async t => {
  const f = await fixture(t);
  const memberId = f.member.id, projectId = f.project.id;
  const reviews = [];
  for (let index = 0; index < 11; index++) reviews.push(await draftReview(f, `검토 고정본 ${index}`, projectId, memberId));
  const { document: pinned } = reviews[0];
  await f.call(`/documents/${pinned.id}`, 200, { method: 'PATCH', body: { expectedVersion: pinned.version, title: 'PRIVATE_DRAFT_TITLE' } });
  const common = await draftReview(f, '공통 문서 검토', null, memberId);
  const teammateReview = await draftReview(f, '팀원 검토', projectId, f.teammate.id);
  const changes = await draftReview(f, '수정 요청 뒤 제외', projectId, memberId);
  await f.call(`/documents/${changes.document.id}/publication`, 200, {
    method: 'POST', actor: memberId,
    body: { action: 'request_changes', expectedVersion: changes.review.version, workspaceGeneration: changes.review.workspaceGeneration,
      note: '수정 의견' },
  });

  const issue = await f.issue('담당자가 다른 시간 배정 업무', { assigneeId: f.teammate.id });
  const first = await reserve(f, issue, memberId, '2026-11-19T14:50:00.000Z', '2026-11-19T15:10:00.000Z');
  const lastTwenty = await reserve(f, issue, memberId, '2026-11-20T14:50:00.000Z', '2026-11-20T15:10:00.000Z');
  for (let hour = 0; hour < 9; hour++) {
    const time = `2026-11-20T0${hour}`;
    await reserve(f, issue, memberId, `${time}:00:00.000Z`, `${time}:30:00.000Z`);
  }
  await reserve(f, issue, memberId, '2026-11-19T14:30:00.000Z', '2026-11-19T14:50:00.000Z');
  await reserve(f, issue, memberId, '2026-11-20T15:10:00.000Z', '2026-11-20T15:30:00.000Z');
  const otherIssue = await f.issue('다른 프로젝트 배정', { projectId: f.otherProject.id });
  const otherReservation = await reserve(f, otherIssue, memberId, '2026-11-20T12:00:00.000Z', '2026-11-20T12:30:00.000Z');
  const teammateReservation = await reserve(f, issue, f.teammate.id, '2026-11-20T10:00:00.000Z', '2026-11-20T10:30:00.000Z');

  const scoped = await f.overview({ projectId, memberId });
  assert.equal(scoped.totals.open, 0);
  assert.equal(scoped.reviews.total, 11);
  assert.equal(scoped.reviews.items.length, 10);
  assert.ok(scoped.reviews.items.every(item => item.status === 'pending' && item.reviewerId === memberId && item.projectId === projectId));
  const lastPage = await f.overview({ projectId, memberId, reviewOffset: '10', reservationOffset: '10' });
  const allReviews = [...scoped.reviews.items, ...lastPage.reviews.items];
  assert.equal(lastPage.reviews.items.length, 1);
  assert.equal(new Set(allReviews.map(item => item.documentId)).size, 11);
  assert.equal(allReviews.find(item => item.documentId === pinned.id)?.revision.title, '검토 고정본 0');
  assert.ok(!JSON.stringify(allReviews).includes('PRIVATE_'));
  assert.deepEqual([scoped.reservations.total, scoped.reservations.limit, scoped.reservations.items[0].id], [11, 10, first.id]);
  assert.deepEqual(lastPage.reservations.items.map(item => item.id), [lastTwenty.id]);
  assert.ok(scoped.reservations.items.every(item => item.issueId === issue.id && item.userId === memberId));
  const team = await f.overview({ memberId, reviewOffset: '10', reservationOffset: '10' });
  assert.equal(team.reviews.total, 12);
  assert.ok(team.reviews.items.some(item => item.documentId === common.document.id));
  assert.ok(team.reservations.items.some(item => item.id === otherReservation.id));
  const teammate = await f.overview({ memberId: f.teammate.id });
  assert.deepEqual(teammate.reviews.items.map(item => item.documentId), [teammateReview.document.id]);
  assert.deepEqual(teammate.reservations.items.map(item => item.id), [teammateReservation.id]);
});

test('team overview rejects malformed filters and uses Seoul today with a no-store browser response', async t => {
  const f = await fixture(t);
  const before = reservationLocalDateTime(new Date().toISOString()).slice(0, 10);
  const read = await f.response('/team-overview');
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  const defaults = await read.json() as TeamOverviewResult;
  const after = reservationLocalDateTime(new Date().toISOString()).slice(0, 10);
  assert.ok([before, after].includes(defaults.date));
  for (const invalid of [
    `${query}&extra=1`, `${query}&date=2026-11-20`, 'date=2025-02-29', `${query}&projectId=&memberId=${f.member.id}`,
    `${query}&memberId=${f.member.id}&memberId=${f.teammate.id}`, `${query}&deadlineOffset=-1`, `${query}&reviewOffset=1.5`,
    `${query}&gitlabOffset=1000001`, `${query}&reservationOffset=0&reservationOffset=1`, `${query}&memberId=missing-member`,
    `${query}&issueMetric=`, `${query}&issueMetric=other`, `${query}&issueMetric=overdue&issueMetric=unassigned`,
    `${query}&issueOffset=0`, `${query}&issueMetric=open&issueOffset=-1`, `${query}&issueMetric=open&issueOffset=1000001`,
    `${query}&issueMetric=open&issueOffset=0&issueOffset=1`,
  ]) await f.call(`/team-overview?${invalid}`, 400);
  await f.call(`/team-overview?${query}&projectId=missing-project`, 404);
  const key = await f.call<ApiKeyCreated>('/api-keys', 201, {
    method: 'POST', actor: f.member.id, body: { name: '범위 확인용 키', access: 'read', projectIds: [f.project.id], expiresAt: null },
  });
  await f.call(`/v1/team-overview?${query}`, 403, { token: key.token });
});
