import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  ApiKeyCreated, DeliveryBlockerDraftResult, DeliveryBlockerReport, DocPage, DocRevision, GitlabLink, Issue, IssueRelation,
  SavedView, SavedViewState, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const otherProjectId = 'project-team';
const route = (project = projectId) => `/projects/${project}/delivery-blockers`;
const draftRoute = `${route()}/meeting-draft`;
type Conflict = { details: { reason: string } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-delivery-blockers-'));
  const app = createApp({ dataDir: directory, outboundWorker: false });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const database = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  t.after(async () => {
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { database.close(); app.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  async function request<T>(url: string, expectedStatus: number | number[] = 200,
    options: { method?: string; body?: object; token?: string; actorId?: string } = {}) {
    const response = await fetch(base + url, {
      method: options.method ?? 'GET', headers: {
        'Content-Type': 'application/json', 'X-Actor-Id': options.actorId ?? 'user-seo',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body && JSON.stringify(options.body),
    });
    const result = await response.json() as T;
    assert.ok([expectedStatus].flat().includes(response.status), `${response.status} ${JSON.stringify(result)}`);
    return { result, headers: response.headers, status: response.status };
  }
  const create = async <T>(url: string, body: object) => (await request<T>(url, 201, { method: 'POST', body })).result;
  const makeIssue = (title: string, fields: Partial<Issue> = {}) => create<Issue>('/issues', { projectId, title, ...fields });
  const block = (source: Issue, target: Issue) => create<IssueRelation>(`/issues/${target.id}/relations`, {
    otherIssueId: source.id, type: 'blocks', direction: 'incoming',
  });
  const makeView = (query: string, project = projectId, more: Partial<SavedViewState['filters']> = {}) =>
    create<SavedView>('/views', { name: `보기 ${query}`, projectId: project, layout: 'list', filters: {
      query, status: 'all', assigneeId: 'all', type: 'all', ...more,
    } });
  const makeKey = (projectIds: string[] | null) => create<ApiKeyCreated>('/api-keys', {
    name: '합성 진행 보고서', access: 'read', projectIds, expiresAt: null,
  });
  return { database, request, create, makeIssue, block, makeView, makeKey };
}

test('progress blockers apply saved views and exclude unauthorized causes from both evidence and totals', async t => {
  const { request, makeIssue, block, makeView, makeKey, create } = await fixture(t);
  const target = await makeIssue('필터 대상 통합 업무', { dueDate: '2030-01-15', startDate: '2030-01-07', endDate: '2030-01-08' });
  const otherTarget = await makeIssue('필터 대상 외부 차단만');
  const terminal = await makeIssue('필터 대상 완료', { status: 'done' });
  const internal = await makeIssue('프로젝트 내 선행 업무', { startDate: '2030-01-07', endDate: '2030-01-10' });
  const external = await makeIssue('다른 프로젝트 전용 설명', { projectId: otherProjectId });
  await block(internal, target);
  await block(external, target);
  await block(external, otherTarget);
  await block(external, terminal);
  await create('/dependencies', { predecessorId: internal.id, successorId: target.id, type: 'FS', lagDays: 0 });
  const view = await makeView('필터 대상');
  const foreignView = await makeView('다른 프로젝트', otherProjectId);
  const projectKey = await makeKey([projectId]);
  const crossProjectKey = await makeKey([projectId, otherProjectId]);
  const wideKey = await makeKey(null);
  const query = `${route()}?savedViewId=${view.id}`;
  const browser = await request<DeliveryBlockerReport>(query);
  const scoped = await request<DeliveryBlockerReport>(`/v1${query}`, 200, { token: projectKey.token });
  assert.equal(browser.headers.get('cache-control'), 'no-store');
  assert.deepEqual(browser.result.counts, { open: 2, affected: 2, reasons: { issue_block: 2, schedule_conflict: 1, gitlab: 0 } });
  assert.deepEqual(scoped.result.counts, { open: 2, affected: 1, reasons: { issue_block: 1, schedule_conflict: 1, gitlab: 0 } });
  assert.deepEqual(scoped.result.items.map(row => row.issue.id), [target.id]);
  assert.deepEqual(scoped.result.items[0].blockers.items.map(issue => issue.id), [internal.id]);
  assert.deepEqual(scoped.result.items[0].scheduleConflicts.items.map(link => [link.predecessor.id, link.requiredDate]), [[internal.id, '2030-01-11']]);
  assert.ok(!JSON.stringify(scoped.result).includes(external.id));
  assert.ok(!JSON.stringify(scoped.result).includes(external.title));
  for (const { token } of [crossProjectKey, wideKey]) {
    const { result } = await request<DeliveryBlockerReport>(`/v1${query}`, 200, { token });
    assert.equal(result.revision, browser.result.revision);
    assert.deepEqual(result.items, browser.result.items);
  }
  await request(`/v1${route(otherProjectId)}`, 403, { token: projectKey.token });
  await request(`/v1${query}`, 401);
  await request(`/v1${query}`, 403, { token: projectKey.token, method: 'POST', body: {} });
  await request(`${route()}?savedViewId=${foreignView.id}`, 404);
  for (const suffix of ['?reason=unknown', '?reason=gitlab&reason=issue_block', '?offset=20', '?offset=-1', '?projectId=project-team', '?revision=wrong']) {
    await request(route() + suffix, 400);
  }
});

test('progress blocker pages stay consistent across refreshes and stale revisions are rejected', async t => {
  const { request, makeIssue, block, makeView } = await fixture(t);
  const predecessor = await makeIssue('외부 검토 요청서');
  const targets: Issue[] = [];
  for (let index = 1; index <= 21; index++) {
    const target = await makeIssue(`릴리스 대상 검토 ${index}`, {
      dueDate: `2030-02-${String(index).padStart(2, '0')}`,
    });
    await block(predecessor, target);
    targets.push(target);
  }
  const view = await makeView('릴리스 대상 검토');
  const read = `${route()}?savedViewId=${view.id}&reason=issue_block`;
  const { result: first } = await request<DeliveryBlockerReport>(read);
  assert.equal(first.limit, 20);
  assert.equal(first.total, 21);
  assert.deepEqual(first.items.map(row => row.issue.id), targets.slice(0, 20).map(issue => issue.id));
  assert.ok(first.items.every(row => row.blockers.items[0].id === predecessor.id));
  const { result: last } = await request<DeliveryBlockerReport>(`${read}&offset=20&revision=${first.revision}`);
  assert.equal(last.revision, first.revision);
  assert.deepEqual(last.items.map(row => row.issue.id), [targets[20].id]);
  const { result: noConflicts } = await request<DeliveryBlockerReport>(`${route()}?savedViewId=${view.id}&reason=schedule_conflict`);
  assert.equal(noConflicts.total, 0);
  assert.equal(noConflicts.counts.affected, 21);
  await request(`/issues/${predecessor.id}`, 200, { method: 'PATCH', body: { status: 'done', expectedVersion: predecessor.version } });
  for (const offset of [0, 20]) {
    await request(`${read}&offset=${offset}&revision=${first.revision}`, 409);
  }
  const { result: current } = await request<DeliveryBlockerReport>(read);
  assert.equal(current.counts.open, 21);
  assert.equal(current.counts.affected, 0);
  assert.deepEqual(current.items, []);
});

test('progress blocker report respects a saved GitLab filter and latest recorded pipeline per branch', async t => {
  const { request, makeIssue, makeView, database } = await fixture(t);
  const staleFailure = await makeIssue('빌드 확인 이전 실패');
  const recentFailure = await makeIssue('빌드 확인 현재 실패');
  const other = await makeIssue('다른 업무 파이프라인');
  function pipeline(target: Issue, objectId: number, state: string) {
    const link: GitlabLink = {
      id: `gitlab:123abc123abc:17:pipeline:${objectId}:${target.id}`, issueId: target.id, projectId: 17, iid: objectId,
      kind: 'pipeline', title: `파이프라인 ${objectId}`, webUrl: 'https://gitlab.example.test/hidden-log',
      state, sourceBranch: 'demo-review', updatedAt: '2026-11-20T00:00:00Z',
    };
    database.prepare('INSERT INTO gitlab_links(id,issue_id,json) VALUES(?,?,?)').run(link.id, link.issueId, JSON.stringify(link));
  }
  pipeline(staleFailure, 100, 'failed');
  pipeline(staleFailure, 101, 'success');
  pipeline(recentFailure, 102, 'failed');
  pipeline(other, 103, 'failed');
  const view = await makeView('빌드 확인', projectId, { gitlab: 'failed_pipeline' });
  const { result } = await request<DeliveryBlockerReport>(`${route()}?savedViewId=${view.id}&reason=gitlab`);
  assert.deepEqual(result.counts, { open: 1, affected: 1, reasons: { issue_block: 0, schedule_conflict: 0, gitlab: 1 } });
  assert.deepEqual(result.items.map(row => [row.issue.id, row.gitlab]), [[recentFailure.id, { blockedMergeRequests: 0, failedPipelines: 1 }]]);
  assert.ok(!JSON.stringify(result).includes('hidden-log'));
});

test('meeting draft captures reviewed causes, rejects stale reports and replays one document after changes and backup', async t => {
  const { request, create, makeIssue, makeView, block } = await fixture(t);
  const external = await makeIssue('확정 시점의 승인 근거', { projectId: otherProjectId });
  const target = await makeIssue('회의 대상 검토', { dueDate: '2030-02-09' });
  await block(external, target);
  const view = await makeView('회의 대상');
  const url = `${route()}?savedViewId=${view.id}&reason=issue_block`;
  const { result: initial } = await request<DeliveryBlockerReport>(url);
  const body = { requestId: randomUUID(), revision: initial.revision, savedViewId: view.id, reason: 'issue_block', title: '회의 기록 초안' };
  const another = await makeIssue('회의 대상 기술 검토');
  await block(external, another);
  const conflict = await request<Conflict>(draftRoute, 409, { method: 'POST', body });
  assert.equal(conflict.result.details.reason, 'stale_report');
  let { result: workspace } = await request<WorkspaceSnapshot>('/workspace');
  assert.ok(!workspace.documents.some(document => document.title === body.title));

  const { result: updated } = await request<DeliveryBlockerReport>(url);
  const reviewed = { ...body, revision: updated.revision };
  const attempts = await Promise.all([1, 2].map(() => request<DeliveryBlockerDraftResult>(draftRoute, [200, 201], { method: 'POST', body: reviewed })));
  assert.deepEqual(attempts.map(attempt => attempt.status).sort(), [200, 201]);
  const document = attempts[0].result.document;
  assert.deepEqual(attempts[1].result.document, document);
  assert.equal(attempts.find(attempt => attempt.status === 200)?.result.duplicate, true);
  assert.equal(document.authorId, 'user-seo');
  assert.equal(document.projectId, projectId);
  assert.equal(document.status, 'draft');
  assert.equal(document.version, 1);
  assert.ok(document.plainText.includes('차단된 업무 2개'));
  assert.ok(document.plainText.includes(external.title));
  assert.ok(document.plainText.includes('2030-02-09'));
  assert.ok(document.plainText.includes('회의 메모'));
  assert.ok(JSON.stringify(document.content).includes(`#/${projectId}/reports/blockers?savedView=${view.id}&reason=issue_block`));
  ({ result: workspace } = await request<WorkspaceSnapshot>('/workspace'));
  assert.equal(workspace.documents.filter(item => item.title === body.title).length, 1);
  assert.deepEqual(workspace.resourceLinks.filter(link => link.documentId === document.id)
    .map(link => [link.issueId, link.kind]), [target, another, external].map(issue => [issue.id, '진행 차단 회의']));
  const { result: revisions } = await request<DocRevision[]>(`/documents/${document.id}/revisions`);
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].content, document.content);
  const otherActor = await request<Conflict>(draftRoute, 409, { method: 'POST', body: reviewed, actorId: 'user-min' });
  assert.equal(otherActor.result.details.reason, 'request_conflict');

  await request(`/issues/${external.id}`, 200, {
    method: 'PATCH', body: { expectedVersion: external.version, status: 'done', title: '현재 완료된 승인 근거' },
  });
  const { result: cleared } = await request<DeliveryBlockerReport>(url);
  assert.equal(cleared.total, 0);
  assert.deepEqual((await request<DeliveryBlockerDraftResult>(draftRoute, 200, { method: 'POST', body: reviewed })).result,
    { document, duplicate: true });
  await request(draftRoute, 422, { method: 'POST', body: { ...reviewed, requestId: randomUUID(), revision: cleared.revision } });

  const { result: backup } = await request<WorkspaceSnapshot>('/export');
  await request('/import', 200, { method: 'POST', body: { data: backup } });
  ({ result: workspace } = await request<WorkspaceSnapshot>('/workspace'));
  const restored = workspace.documents.find(item => item.id === document.id);
  assert.deepEqual(restored?.content, document.content);
  assert.equal(workspace.resourceLinks.filter(link => link.documentId === document.id).length, 3);
  assert.deepEqual((await request<DocRevision[]>(`/documents/${document.id}/revisions`)).result[0].content, document.content);
  const afterRestore = await request<Conflict>(draftRoute, 409, { method: 'POST', body: reviewed });
  assert.equal(afterRestore.result.details.reason, 'result_unavailable');
  const token = (await create<ApiKeyCreated>('/api-keys', { name: '다른 API', access: 'write', projectIds: [projectId] })).token;
  await request(`/v1${draftRoute}`, 403, { method: 'POST', token, body: reviewed });
});

test('meeting draft rolls back history and references on a failed link and cannot reuse an ordinary document receipt', async t => {
  const { database, request, create, makeIssue, block, makeView } = await fixture(t);
  const target = await makeIssue('회의 대상 개발');
  const blocker = await makeIssue('아직 남은 설계');
  await block(blocker, target);
  const view = await makeView('회의 대상 개발');
  const { result: report } = await request<DeliveryBlockerReport>(`${route()}?savedViewId=${view.id}`);
  const reviewed = { requestId: randomUUID(), savedViewId: view.id, revision: report.revision, title: '실행 원자성 검사' };
  for (const body of [{ ...reviewed, title: ' ' }, { ...reviewed, revision: undefined }, { ...reviewed, offset: 20 }, { ...reviewed, requestId: 'invalid' }]) {
    await request(draftRoute, 400, { method: 'POST', body });
  }
  const ordinary = await create<DocPage>('/documents', {
    ...reviewed, projectId, reason: null,
  });
  assert.equal((await request<Conflict>(draftRoute, 409, { method: 'POST', body: reviewed })).result.details.reason, 'request_conflict');
  const body = { ...reviewed, requestId: randomUUID() };
  const counts = () => ['documents', 'revisions', 'resource_links', 'activities', 'document_creation_requests']
    .map(table => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count));
  const before = counts();
  database.exec(`CREATE TRIGGER fail_meeting_draft_link BEFORE INSERT ON resource_links
    WHEN NEW.issue_id = '${blocker.id}' BEGIN SELECT RAISE(ABORT, 'synthetic meeting evidence failure'); END`);
  try {
    await request(draftRoute, 500, { method: 'POST', body });
    assert.deepEqual(counts(), before);
  } finally {
    database.exec('DROP TRIGGER fail_meeting_draft_link');
  }
  const { result } = await request<DeliveryBlockerDraftResult>(draftRoute, 201, { method: 'POST', body });
  assert.notEqual(result.document.id, ordinary.id);
  assert.deepEqual(counts(), before.map((count, index) => count + (index === 2 ? 2 : 1)));
});
