import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  ApiKeyCreated, DeliveryBlockerReport, GitlabLink, Issue, IssueRelation, SavedView, SavedViewState,
} from '../../shared/types.js';

const projectId = 'project-neo';
const otherProjectId = 'project-team';
const route = (project = projectId) => `/projects/${project}/delivery-blockers`;

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

  async function request<T>(url: string, expectedStatus = 200, options: { method?: string; body?: object; token?: string } = {}) {
    const response = await fetch(base + url, {
      method: options.method ?? 'GET', headers: {
        'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body && JSON.stringify(options.body),
    });
    const result = await response.json() as T;
    assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return { result, headers: response.headers };
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
