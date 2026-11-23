import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { AutomationRule, GitlabLink, GitlabMergeRequestReview, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const repositoryId = 42;
const mergeRequestId = 811;
const mergeRequestIid = 19;
const projectId = 'project-neo';
const token = 'synthetic-gitlab-review-read-token';
const privatePayload = 'synthetic-private-review-metadata';
const sha = 'a'.repeat(40);
const updatedAt = new Date(Date.now() - 60_000).toISOString();
const repositoryPath = `/forge/api/v4/projects/${repositoryId}`;
const mrPath = `${repositoryPath}/merge_requests/${mergeRequestIid}`;
const reviewersPath = `${mrPath}/reviewers`;
const approvalsPath = `${mrPath}/approvals`;
const route = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/merge-request-review`;

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type ResponseFixture = { status?: number; body: unknown; headers?: Record<string, string> };

function gitlabUser(id: number, overrides: Record<string, unknown> = {}) {
  return { id, name: `Reviewer ${id}`, username: `reviewer${id}`, email: `${privatePayload}@example.test`,
    avatar_url: `https://example.test/${privatePayload}`, organization: privatePayload, ...overrides };
}

async function fixture(t: TestContext) {
  const calls: { method?: string; url: URL; credential?: string | string[] }[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-merge-reviews-'));
  let baseUrl = '';
  const repoUrl = () => `${baseUrl}/team/app`;
  const mrUrl = () => `${repoUrl()}/-/merge_requests/${mergeRequestIid}`;
  let project: Record<string, unknown> = {};
  let mr: Record<string, unknown> = { id: mergeRequestId, iid: mergeRequestIid, project_id: repositoryId,
    target_project_id: repositoryId, state: 'opened', title: '비공개 MR 제목', sha, updated_at: updatedAt,
    source_branch: 'feature/review', author: gitlabUser(991), description: privatePayload, reviewers: [gitlabUser(12)] };
  let reviewers: ResponseFixture = { body: [] };
  let approvals: ResponseFixture = { body: { approved_by: [] } };
  let holdApprovals: (() => Promise<void>) | undefined;

  const mock = createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    calls.push({ method: incoming.method, url, credential: incoming.headers['private-token'] });
    if (url.pathname === approvalsPath) await holdApprovals?.();
    if (response.destroyed) return;
    let fixture: ResponseFixture;
    if (url.pathname === repositoryPath) fixture = { body: { id: repositoryId, path_with_namespace: 'team/app', web_url: repoUrl(), ...project } };
    else if (url.pathname === mrPath) fixture = { body: { web_url: mrUrl(), ...mr } };
    else if (url.pathname === reviewersPath) fixture = reviewers;
    else if (url.pathname === approvalsPath) fixture = approvals;
    else fixture = { status: 404, body: {} };
    response.writeHead(fixture.status ?? 200, { 'Content-Type': 'application/json', ...fixture.headers }).end(JSON.stringify(fixture.body));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    async function close(instance: typeof server) {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
    }
    try { await Promise.all([close(server), close(mock)]); }
    finally { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, headers }: RequestOptions = {}) {
    const response = await fetch(appUrl + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, headers: response.headers, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, status = 200) {
    const result = await request<T>(path, options);
    assert.equal(result.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const settings = () => call<GitlabSettings>('/integrations/gitlab');
  const configure = async (patch: Partial<Pick<GitlabSettings, 'baseUrl' | 'projectIds'>> & { token?: string; webhookSecret?: string }) =>
    call<GitlabSettings>('/integrations/gitlab', { method: 'PATCH', body: { expectedVersion: (await settings()).version, ...patch } });
  await configure({ baseUrl, projectIds: [repositoryId], token, webhookSecret: 'synthetic-gitlab-review-webhook' });
  const createIssue = (title: string) => call<Issue>('/issues', { method: 'POST', body: { projectId, title } }, 201);
  const issue = await createIssue('연결한 MR을 검토할 업무');
  mr.source_branch = `feature/${issue.key}`;
  const issueLinksPath = `/issues/${issue.id}/gitlab-links`;
  const attach = async () => call<GitlabLink>(issueLinksPath, { method: 'POST', body: {
    repositoryId, expectedSettingsVersion: (await settings()).version, url: mrUrl(),
  } }, 201);
  const link = await attach();
  calls.length = 0;

  return { call, request, issue, link, createIssue, configure, baseUrl, calls, attach,
    path: route(issue.id, link.id), snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    runs: () => call(`/automation-runs?projectId=${projectId}`),
    unlink: (link: GitlabLink) => call(`${issueLinksPath}/${encodeURIComponent(link.id)}?${new URLSearchParams({ expectedManualLinkId: link.manualLinkId! })}`, { method: 'DELETE' }),
    setProject(value: Record<string, unknown>) { project = value; },
    setMr(patch: Record<string, unknown>) { mr = { ...mr, ...patch }; },
    setReviewers(value: ResponseFixture) { reviewers = value; },
    setApprovals(value: ResponseFixture) { approvals = value; },
    setApprovalGate(gate?: () => Promise<void>) { holdApprovals = gate; },
  };
}

test('reads exact linked MR reviewers and approvals by repository and IID without writing or triggering automation', async t => {
  const f = await fixture(t);
  assert.equal(f.link.iid, mergeRequestIid);
  assert.ok(f.link.id.includes(`:merge_request:${mergeRequestId}:`));
  const rule = await f.call<AutomationRule>('/automation-rules', { method: 'POST', body: {
    projectId, name: 'MR 읽기가 상태를 바꾸지 않는지 확인', enabled: true, trigger: 'merge_request.merged',
    gitlabProjectIds: [repositoryId], branchPattern: 'feature/*', issueTypes: [], fromStatuses: [f.issue.status], toStatusId: 'done',
  } }, 201);
  assert.equal(rule.enabled, true);
  const before = await f.snapshot();
  const beforeRuns = await f.runs();
  f.setMr({ state: 'merged', title: `${f.issue.key} ${privatePayload}`, updated_at: new Date().toISOString() });
  f.setReviewers({ body: [{ user: gitlabUser(11), state: 'reviewed', github_login: privatePayload },
    { user: gitlabUser(12, { name: `Hidden ${token}` }), state: 'approved' }], headers: { 'X-Next-Page': '2' } });
  f.setApprovals({ body: { id: mergeRequestId, iid: mergeRequestIid, project_id: repositoryId,
    approved: false, approvals_required: 2, approvals_left: 0, approved_by: [{ user: gitlabUser(11), note: privatePayload }] } });

  const response = await f.request<GitlabMergeRequestReview>(f.path);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/u);
  const { checkedAt, ...review } = response.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(review, { linkId: f.link.id, repositoryId, mergeRequestIid, reviewerSource: 'reviewers', reviewersHasMore: true,
    reviewers: [{ id: 11, name: 'Reviewer 11', username: 'reviewer11', state: 'reviewed' },
      { id: 12, name: 'reviewer12', username: 'reviewer12', state: 'approved' }],
    approvals: { approvers: [{ id: 11, name: 'Reviewer 11', username: 'reviewer11' }], required: 2, remaining: 0, hasMore: false },
  });
  assert.ok(!JSON.stringify(response.data).includes(privatePayload));
  assert.ok(!JSON.stringify(response.data).includes(token));
  const paths = f.calls.map(call => call.url.pathname);
  assert.deepEqual(paths.slice(0, 2), [repositoryPath, mrPath]);
  assert.deepEqual(paths.slice(2, -1).sort(), [approvalsPath, reviewersPath].sort());
  assert.equal(paths.at(-1), mrPath);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
  const reviewerQuery = f.calls.find(call => call.url.pathname === reviewersPath)?.url.searchParams;
  assert.equal(reviewerQuery?.get('per_page'), '50');
  assert.equal(reviewerQuery?.get('page'), '1');
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.runs(), beforeRuns);
});

test('reviewers and approvals degrade independently and bound embedded and approval lists', async t => {
  const f = await fixture(t);
  const unavailable = { message: `${privatePayload} ${token}` };
  f.setReviewers({ body: [{ user: gitlabUser(11), state: 'unreviewed' }] });
  for (const status of [401, 403, 404, 405, 501]) {
    f.setApprovals({ status, body: unavailable });
    const review = await f.call<GitlabMergeRequestReview>(f.path);
    assert.deepEqual(review.reviewers, [{ id: 11, name: 'Reviewer 11', username: 'reviewer11', state: 'unreviewed' }]);
    assert.equal(review.reviewerSource, 'reviewers');
    assert.equal(review.approvals, null);
    assert.ok(!JSON.stringify(review).includes(privatePayload));
    assert.ok(!JSON.stringify(review).includes(token));
  }

  const users = Array.from({ length: 51 }, (_, index) => gitlabUser(index + 1));
  f.setMr({ reviewers: users, sha: undefined, updated_at: undefined });
  f.setReviewers({ status: 404, body: unavailable });
  f.setApprovals({ body: { id: mergeRequestId, iid: mergeRequestIid, project_id: repositoryId,
    approved: true, approvals_required: 0, approved_by: users.map(user => ({ user })) } });
  const fallback = await f.call<GitlabMergeRequestReview>(f.path);
  assert.equal(fallback.reviewerSource, 'merge_request');
  assert.deepEqual(fallback.reviewers.map(({ id, state }) => ({ id, state })), users.slice(0, 50).map(({ id }) => ({ id, state: 'unknown' })));
  assert.equal(fallback.reviewersHasMore, true);
  assert.equal(fallback.approvals?.approvers.length, 50);
  assert.equal(fallback.approvals?.hasMore, true);
  assert.equal(fallback.approvals?.required, null);
  assert.equal(fallback.approvals?.remaining, null);

  f.setMr({ reviewers: undefined });
  const missing = await f.call<GitlabMergeRequestReview>(f.path);
  assert.equal(missing.reviewerSource, 'unavailable');
  assert.deepEqual(missing.reviewers, []);
  assert.equal(missing.reviewersHasMore, false);
  assert.equal(missing.approvals?.approvers.length, 50);
});

test('fences the exact connected identity and suppresses upstream redirects and malformed responses', async t => {
  const f = await fixture(t);
  const other = await f.createIssue('MR 연결이 없는 업무');
  await f.call(route(other.id, f.link.id), undefined, 404);
  await f.call(route(f.issue.id, 'missing-link'), undefined, 404);
  await f.call(`${f.path}?mergeRequestIid=${mergeRequestId}`, undefined, 400);
  const key = await f.call<{ token: string }>('/api-keys', { method: 'POST', body: {
    name: 'MR 검토 읽기 범위 검증', access: 'read', projectIds: [projectId], expiresAt: null,
  } }, 201);
  await f.call(`/v1${f.path}`, { headers: { Authorization: `Bearer ${key.token}` } }, 403);
  assert.equal(f.calls.length, 0);

  f.setProject({ id: repositoryId + 1 });
  await f.call(f.path, undefined, 502);
  f.setProject({});
  for (const invalid of [{ id: mergeRequestId + 1 }, { iid: mergeRequestIid + 1 }, { target_project_id: repositoryId + 1 }]) {
    f.setMr(invalid);
    await f.call(f.path, undefined, 502);
    f.setMr({ id: mergeRequestId, iid: mergeRequestIid, target_project_id: repositoryId });
  }
  assert.ok(!f.calls.some(call => call.url.pathname === reviewersPath || call.url.pathname === approvalsPath));

  f.setReviewers({ status: 302, headers: { Location: `${f.baseUrl}/redirected-private-metadata` }, body: { message: `${privatePayload} ${token}` } });
  const redirect = await f.call(f.path, undefined, 502);
  assert.ok(!JSON.stringify(redirect).includes(privatePayload));
  assert.ok(!JSON.stringify(redirect).includes(token));
  assert.ok(!f.calls.some(call => call.url.pathname.includes('redirected-private-metadata')));
  f.setReviewers({ body: [{ user: gitlabUser(11, { username: token }), state: 'reviewed' }] });
  const malformed = await f.call(f.path, undefined, 502);
  assert.ok(!JSON.stringify(malformed).includes(privatePayload));
  assert.ok(!JSON.stringify(malformed).includes(token));
});

test('discards review responses held across live head, connection or the precise manual link changing', async t => {
  const f = await fixture(t);
  async function whileReading(change: () => void | Promise<void>) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setApprovalGate(() => { entered.resolve(); return release.promise; });
    const pending = f.request(f.path);
    try {
      await Promise.race([entered.promise, pending.then(response => assert.fail(`Review ended early (${response.status})`))]);
      await change();
    } finally {
      release.resolve();
      f.setApprovalGate();
    }
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(!Object.hasOwn(result.data as object, 'reviewers'));
    assert.ok(!Object.hasOwn(result.data as object, 'approvals'));
  }

  await whileReading(() => f.setMr({ sha: 'b'.repeat(40) }));
  f.setMr({ sha });
  await whileReading(async () => { await f.configure({ token: 'rotated-synthetic-review-token' }); });
  let replacement: GitlabLink | undefined;
  await whileReading(async () => {
    await f.unlink(f.link);
    replacement = await f.attach();
  });
  assert.equal(replacement?.id, f.link.id);
  assert.notEqual(replacement?.manualLinkId, f.link.manualLinkId);
  assert.equal((await f.call<GitlabMergeRequestReview>(f.path)).linkId, f.link.id);
});
