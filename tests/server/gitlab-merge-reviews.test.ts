import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { AutomationRule, GitlabLink, GitlabMergeRequestChangedFiles, GitlabMergeRequestDiscussions, GitlabMergeRequestReview, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

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
const discussionsPath = `${mrPath}/discussions`;
const diffsPath = `${mrPath}/diffs`;
const route = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/merge-request-review`;
const discussionRoute = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/merge-request-discussions`;
const changedFilesRoute = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/merge-request-changed-files`;

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal };
type ResponseFixture = { status?: number; body: unknown; headers?: Record<string, string> };

function gitlabUser(id: number, overrides: Record<string, unknown> = {}) {
  return { id, name: `Reviewer ${id}`, username: `reviewer${id}`, email: `${privatePayload}@example.test`,
    avatar_url: `https://example.test/${privatePayload}`, organization: privatePayload, ...overrides };
}

function note(id: number, overrides: Record<string, unknown> = {}) {
  return { id, noteable_type: 'MergeRequest', noteable_id: mergeRequestId, noteable_iid: mergeRequestIid, project_id: repositoryId,
    system: false, resolvable: true, resolved: false, body: '검토 의견', author: gitlabUser(id), ...overrides };
}

function discussion(id: number, notes: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return { id: `discussion-${id}`, individual_note: false, notes, ...overrides };
}

function diffFile(path: string, overrides: Record<string, unknown> = {}) {
  return { old_path: path, new_path: path, new_file: false, deleted_file: false, renamed_file: false,
    diff: privatePayload, ...overrides };
}

async function fixture(t: TestContext) {
  const calls: { method?: string; url: URL; credential?: string | string[] }[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-gitlab-merge-reviews-'));
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
  const discussionPages = new Map<number, ResponseFixture>();
  const diffPages = new Map<number, ResponseFixture>();
  let holdDiscussions: ((response: import('node:http').ServerResponse) => Promise<void>) | undefined;
  let onDiffRead: (() => void) | undefined;

  const mock = createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    calls.push({ method: incoming.method, url, credential: incoming.headers['private-token'] });
    if (url.pathname === approvalsPath) await holdApprovals?.();
    if (url.pathname === discussionsPath) await holdDiscussions?.(response);
    if (url.pathname === diffsPath) onDiffRead?.();
    if (response.destroyed) return;
    let fixture: ResponseFixture;
    if (url.pathname === repositoryPath) fixture = { body: { id: repositoryId, path_with_namespace: 'team/app', web_url: repoUrl(), ...project } };
    else if (url.pathname === mrPath) fixture = { body: { web_url: mrUrl(), ...mr } };
    else if (url.pathname === reviewersPath) fixture = reviewers;
    else if (url.pathname === approvalsPath) fixture = approvals;
    else if (url.pathname === discussionsPath) fixture = discussionPages.get(Number(url.searchParams.get('page'))) ?? { body: [] };
    else if (url.pathname === diffsPath) fixture = diffPages.get(Number(url.searchParams.get('page'))) ?? { body: [] };
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
  async function request<T = unknown>(path: string, { method = 'GET', body, headers, signal }: RequestOptions = {}) {
    const response = await fetch(appUrl + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
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
    path: route(issue.id, link.id), discussionPath: discussionRoute(issue.id, link.id), filesPath: changedFilesRoute(issue.id, link.id),
    snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    runs: () => call(`/automation-runs?projectId=${projectId}`),
    unlink: (link: GitlabLink) => call(`${issueLinksPath}/${encodeURIComponent(link.id)}?${new URLSearchParams({ expectedManualLinkId: link.manualLinkId! })}`, { method: 'DELETE' }),
    setProject(value: Record<string, unknown>) { project = value; },
    setMr(patch: Record<string, unknown>) { mr = { ...mr, ...patch }; },
    setReviewers(value: ResponseFixture) { reviewers = value; },
    setApprovals(value: ResponseFixture) { approvals = value; },
    setApprovalGate(gate?: () => Promise<void>) { holdApprovals = gate; },
    setDiscussions(page: number, value: ResponseFixture) { discussionPages.set(page, value); },
    setDiscussionGate(gate?: typeof holdDiscussions) { holdDiscussions = gate; },
    setDiffs(page: number, value: ResponseFixture) { diffPages.set(page, value); },
    onDiffRead(callback?: typeof onDiffRead) { onDiffRead = callback; },
  };
}

test('changed files for a merged MR return bounded metadata from the exact linked object', async t => {
  const f = await fixture(t);
  f.setMr({ state: 'merged', changes_count: '1000+', diff_refs: { head_sha: sha, start_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40) } });
  f.setDiffs(1, { body: [
    diffFile('src/new.ts', { new_file: true }),
    diffFile('src/old.ts', { new_path: 'src/renamed.ts', renamed_file: true, generated_file: true }),
    diffFile('src/removed.ts', { deleted_file: true, collapsed: true }),
  ], headers: { 'X-Next-Page': '2' } });
  f.setDiffs(2, { body: [diffFile('src/edit.ts', { too_large: true })], headers: { 'X-Next-Page': '3' } });
  const before = await f.snapshot();
  const result = await f.request<GitlabMergeRequestChangedFiles>(f.filesPath);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.headers.get('cache-control') ?? '', /\bno-store\b/u);
  const { checkedAt, ...evidence } = result.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  const fileAnchor = (path: string) => createHash('sha1').update(path).digest('hex');
  assert.deepEqual(evidence, { linkId: f.link.id, repositoryId, mergeRequestIid, hasMore: true, files: [
    { oldPath: 'src/new.ts', newPath: 'src/new.ts', diffAnchor: fileAnchor('src/new.ts'), change: 'added', generated: false, diffLimited: false },
    { oldPath: 'src/old.ts', newPath: 'src/renamed.ts', diffAnchor: fileAnchor('src/renamed.ts'), change: 'renamed', generated: true, diffLimited: false },
    { oldPath: 'src/removed.ts', newPath: 'src/removed.ts', diffAnchor: fileAnchor('src/removed.ts'), change: 'deleted', generated: false, diffLimited: true },
    { oldPath: 'src/edit.ts', newPath: 'src/edit.ts', diffAnchor: fileAnchor('src/edit.ts'), change: 'modified', generated: false, diffLimited: true },
  ] });
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), [repositoryPath, mrPath, diffsPath, diffsPath, mrPath]);
  assert.deepEqual(f.calls.filter(({ url }) => url.pathname === diffsPath).map(({ url }) => url.search), [
    '?per_page=25&page=1', '?per_page=25&page=2',
  ]);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
  assert.ok(!JSON.stringify(result.data).includes(privatePayload));
  assert.deepEqual(await f.snapshot(), before);

  f.setDiffs(1, { body: [diffFile('a')] });
  f.setMr({ changes_count: '2' });
  assert.equal((await f.call<GitlabMergeRequestChangedFiles>(f.filesPath)).hasMore, true);
  f.setMr({ changes_count: '0' });
  f.setDiffs(1, { body: [] });
  const empty = await f.call<GitlabMergeRequestChangedFiles>(f.filesPath);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.hasMore, false);
});

test('changed files reject malformed or stale continuity and suppress sensitive paths', async t => {
  const f = await fixture(t);
  const other = await f.createIssue('MR 연결이 없는 업무');
  f.calls.length = 0;
  await f.call(changedFilesRoute(other.id, f.link.id), undefined, 404);
  await f.call(f.filesPath + '?page=2', undefined, 400);
  assert.deepEqual(f.calls, []);
  f.setDiffs(1, { status: 405, body: { secret: privatePayload } });
  await f.call(f.filesPath, undefined, 501);
  f.setDiffs(1, { body: [diffFile('src/' + token)] });
  const sensitive = await f.request(f.filesPath);
  assert.equal(sensitive.status, 502);
  assert.ok(!JSON.stringify(sensitive.data).includes(token));
  f.setDiffs(1, { body: [diffFile('src/same.ts')], headers: { 'X-Next-Page': '2' } });
  f.setDiffs(2, { body: [diffFile('src/same.ts')] });
  await f.call(f.filesPath, undefined, 502);
  f.setDiffs(1, { body: [diffFile('src/ok.ts')], headers: { Link: '<' + f.baseUrl + '/api/v4/projects/42/merge_requests/19/diffs?per_page=24&page=2>; rel="next"' } });
  await f.call(f.filesPath, undefined, 502);
  f.setMr({ diff_refs: { head_sha: sha, base_sha: 'b'.repeat(40) } });
  f.setDiffs(1, { body: [diffFile('src/ok.ts')] });
  f.onDiffRead(() => f.setMr({ diff_refs: { head_sha: sha, base_sha: 'd'.repeat(40) } }));
  await f.call(f.filesPath, undefined, 409);
});

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

test('lists one visible unresolved note per linked MR thread with bounded, plain display metadata', async t => {
  const f = await fixture(t);
  const before = await f.snapshot(), beforeRuns = await f.runs();
  f.setMr({ detailed_merge_status: 'discussions_not_resolved', blocking_discussions_resolved: false });
  f.setDiscussions(1, { body: [
    discussion(1, [note(11, { body: '첫 줄\n **검토** https://example.test/private', position: {
      new_path: 'src/new.ts', old_path: 'old.ts', new_line: 42, old_line: 8,
    }, web_url: `https://example.test/${privatePayload}`, suggestions: [privatePayload] }), note(12, { body: privatePayload })]),
    discussion(2, [note(21, { system: true, body: privatePayload }), note(22, { resolved: true, body: privatePayload }),
      note(23, { resolvable: false, body: privatePayload }), note(24, { confidential: true, body: privatePayload }),
      note(25, { author: null, body: 'a'.repeat(350), position: { old_path: 'src/old.ts', old_line: 3 } })]),
    discussion(3, [note(31, { internal: true, body: privatePayload }), note(32, { body: privatePayload })]),
    discussion(4, [note(41, { confidential: true, body: privatePayload }), note(42, { body: privatePayload })]),
    discussion(5, [note(51, { body: privatePayload })], { individual_note: true }),
    discussion(6, [note(61, { body: privatePayload })], { internal: true }),
    discussion(7, [note(71, { body: `token ${token}`, author: { name: token }, position: { new_path: token, new_line: 1 } })]),
    discussion(8, [note(81, { author: { username: 'fallback' }, body: '파일 검토', position: {
      new_path: 'file.txt', new_line: -1, old_path: 'https://example.test/private', old_line: 2,
    } })]),
  ] });
  const result = await f.request<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.headers.get('cache-control') ?? '', /\bno-store\b/u);
  const { checkedAt, ...data } = result.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(data, { linkId: f.link.id, repositoryId, mergeRequestIid, hasMore: false, threads: [
    { noteId: 11, author: 'Reviewer 11', excerpt: '첫 줄 **검토** [링크]', excerptTruncated: false, filePath: 'src/new.ts', line: 42, lineSide: 'new' },
    { noteId: 25, author: null, excerpt: 'a'.repeat(300), excerptTruncated: true, filePath: 'src/old.ts', line: 3, lineSide: 'old' },
    { noteId: 71, author: '[숨김]', excerpt: '[숨김]', excerptTruncated: false, filePath: null, line: null, lineSide: null },
    { noteId: 81, author: 'fallback', excerpt: '파일 검토', excerptTruncated: false, filePath: 'file.txt', line: null, lineSide: null },
  ] });
  const serialized = JSON.stringify(result.data);
  assert.ok(!serialized.includes(privatePayload) && !serialized.includes(token) && !serialized.includes('https://example.test/'));
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname, call.credential]), [
    ['GET', repositoryPath, token], ['GET', mrPath, token], ['GET', discussionsPath, token], ['GET', mrPath, token],
  ]);
  assert.deepEqual(Object.fromEntries(f.calls[2].url.searchParams), { per_page: '50', page: '1' });
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.runs(), beforeRuns);
});

test('bounds discussion pagination, verifies continuation metadata and distinguishes empty and partial results', async t => {
  const f = await fixture(t);
  const pages = () => f.calls.filter(call => call.url.pathname === discussionsPath).map(call => call.url.searchParams.get('page'));
  f.setDiscussions(1, { body: [discussion(1, [note(11, { resolved: true })])],
    headers: { Link: `<${discussionsPath}?per_page=50&page=2>; rel="next"` } });
  f.setDiscussions(2, { body: [discussion(2, [note(21)])], headers: { 'X-Next-Page': '' } });
  const secondPage = await f.call<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.deepEqual(secondPage.threads.map(thread => thread.noteId), [21]);
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(pages(), ['1', '2']);

  f.calls.length = 0;
  for (let page = 1; page <= 4; page++) f.setDiscussions(page, {
    body: [discussion(page, [note(page, { resolved: true })])], headers: { 'X-Next-Page': String(page + 1) },
  });
  const capped = await f.call<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.deepEqual(capped.threads, []);
  assert.equal(capped.hasMore, true);
  assert.deepEqual(pages(), ['1', '2', '3', '4']);

  f.calls.length = 0;
  f.setDiscussions(1, { body: Array.from({ length: 31 }, (_, index) => discussion(index, [note(index + 1)])),
    headers: { 'X-Next-Page': '2' } });
  const limited = await f.call<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.equal(limited.threads.length, 30);
  assert.equal(limited.hasMore, true);
  assert.deepEqual(pages(), ['1']);

  f.calls.length = 0;
  f.setDiscussions(1, { body: [discussion(1, [note(11)])], headers: { Link: '<https://untrusted.test/page?page=2>; rel="next"' } });
  await f.call(f.discussionPath, undefined, 502);
  assert.deepEqual(pages(), ['1']);
  f.setDiscussions(1, { body: [], headers: { 'X-Next-Page': '' } });
  const empty = await f.call<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.deepEqual(empty.threads, []);
  assert.equal(empty.hasMore, false);
});

test('checks linked MR discussions identity and reports access, unsupported, missing and invalid responses distinctly', async t => {
  const f = await fixture(t);
  const other = await f.createIssue('MR 연결이 없는 다른 업무');
  for (const path of [discussionRoute(other.id, f.link.id), discussionRoute(f.issue.id, 'missing-link')]) {
    const result = await f.request<{ error: string }>(path);
    assert.equal(result.status, 404);
    assert.equal(result.data.error, '업무에 연결된 GitLab MR을 찾을 수 없습니다.');
    assert.match(result.headers.get('cache-control') ?? '', /\bno-store\b/u);
  }
  await f.call(`${f.discussionPath}?page=2`, undefined, 400);
  const key = await f.call<{ token: string }>('/api-keys', { method: 'POST', body: {
    name: 'MR 토론 읽기 범위 검증', access: 'read', projectIds: [projectId], expiresAt: null,
  } }, 201);
  await f.call(`/v1${f.discussionPath}`, { headers: { Authorization: `Bearer ${key.token}` } }, 403);
  assert.equal(f.calls.length, 0);
  f.setProject({ id: repositoryId + 1 });
  await f.call(f.discussionPath, undefined, 502);
  f.setProject({});
  f.setMr({ id: mergeRequestId + 1 });
  await f.call(f.discussionPath, undefined, 502);
  assert.ok(!f.calls.some(call => call.url.pathname === discussionsPath));
  f.setMr({ id: mergeRequestId });

  for (const patch of [{ noteable_id: mergeRequestIid }, { noteable_iid: mergeRequestIid + 1 },
    { noteable_type: 'Issue' }, { project_id: repositoryId + 1 }]) {
    f.setDiscussions(1, { body: [discussion(1, [note(1, patch)])] });
    await f.call(f.discussionPath, undefined, 502);
  }
  f.setDiscussions(1, { body: [discussion(1, [note(1)]), discussion(2, [note(1)])] });
  await f.call(f.discussionPath, undefined, 502);

  for (const [upstream, expected] of [[401, 403], [403, 403], [404, 404], [405, 501], [501, 501], [429, 429], [302, 502]]) {
    f.setDiscussions(1, { status: upstream, body: { message: `${token} ${privatePayload}` },
      headers: { Location: `${f.baseUrl}/redirected-discussion` } });
    const result = await f.request<{ error: string }>(f.discussionPath);
    assert.equal(result.status, expected);
    assert.match(result.headers.get('cache-control') ?? '', /\bno-store\b/u);
    assert.ok(!result.data.error.includes(token) && !result.data.error.includes(privatePayload));
    if (expected === 404) assert.equal(result.data.error, 'GitLab에서 이 MR의 토론을 조회할 수 없습니다.');
    if (expected === 501) assert.equal(result.data.error, '이 GitLab 연결에서는 MR 토론 조회를 지원하지 않습니다.');
  }
  assert.ok(!f.calls.some(call => call.url.pathname.includes('redirected-discussion')));
  f.setDiscussions(1, { body: [discussion(1, [note(1)])], headers: { 'X-Next-Page': '2' } });
  f.setDiscussions(2, { status: 404, body: {} });
  await f.call(f.discussionPath, undefined, 502);
});

test('rejects stale linked discussions and cancels a GitLab fetch after browser disconnect', { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  f.setMr({ blocking_discussions_resolved: false, detailed_merge_status: 'discussions_not_resolved' });
  f.setDiscussions(1, { body: [discussion(1, [note(1)])] });
  async function whileReading(change: () => void | Promise<void>) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setDiscussionGate(() => { entered.resolve(); return release.promise; });
    const pending = f.request(f.discussionPath);
    try {
      await Promise.race([entered.promise, pending.then(response => assert.fail(`Discussions ended early (${response.status})`))]);
      await change();
    } finally {
      release.resolve();
      f.setDiscussionGate();
    }
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(!Object.hasOwn(result.data as object, 'threads'));
  }
  await whileReading(() => f.setMr({ blocking_discussions_resolved: true }));
  f.setMr({ blocking_discussions_resolved: false });
  await whileReading(() => f.setMr({ detailed_merge_status: 'mergeable' }));
  await whileReading(() => f.setMr({ sha: 'b'.repeat(40) }));
  await whileReading(async () => { await f.configure({ token: 'rotated-synthetic-discussion-token' }); });
  await whileReading(async () => { await f.unlink(f.link); await f.attach(); });

  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  f.setDiscussionGate(response => {
    response.once('close', () => closed.resolve());
    entered.resolve();
    return closed.promise;
  });
  const controller = new AbortController();
  const pending = f.request(f.discussionPath, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await rejected;
  await closed.promise;
  f.setDiscussionGate();
  const live = await f.call<GitlabMergeRequestDiscussions>(f.discussionPath);
  assert.deepEqual(live.threads.map(thread => thread.noteId), [1]);
});
