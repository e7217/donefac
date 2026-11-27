import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import type { AutomationRule, GitlabBranchMergeRequestAttachment, GitlabBranchMergeRequests, GitlabLink, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const repositoryId = 42;
const projectId = 'project-neo';
const token = 'synthetic-gitlab-branch-mr-read-token';
const webhookSecret = 'synthetic-gitlab-branch-mr-webhook-secret';
const source = 'feature/검토+one';
const customTarget = 'release/두번째';
const sourceSha = 'a'.repeat(40);
const mainSha = 'b'.repeat(40);
const customSha = 'c'.repeat(40);
const projectPath = `/forge/api/v4/projects/${repositoryId}`;
const defaultListPath = `${projectPath}/merge_requests`;
const mergeRequestPath = (iid: number) => `${defaultListPath}/${iid}`;
const branchPath = (ref: string) => `${projectPath}/repository/branches/${encodeURIComponent(ref)}`;
const readPath = (issueId: string, linkId: string) =>
  `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/branch-merge-requests`;
const targetQuery = (targetBranch: string) => `?${new URLSearchParams({ targetBranch })}`;

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-gitlab-branch-merge-requests-'));
  const seen: { method?: string; url: URL; credential?: string | string[] }[] = [];
  let repositoryUrl = '';
  let projectOverrides: Record<string, unknown> = {};
  const branch = (ref: string, sha: string) => ({ name: ref, commit: { id: sha } });
  const branches = new Map<string, Record<string, unknown>>([
    [branchPath(source), branch(source, sourceSha)],
    [branchPath('main'), branch('main', mainSha)],
    [branchPath(customTarget), branch(customTarget, customSha)],
  ]);
  const mergeRequests = new Map<string, Record<string, unknown>>();
  let mrList: (page: number) => Record<string, unknown>[] = () => [];
  let listGate: (() => Promise<void>) | undefined;
  let mergeRequestGate: (() => Promise<void>) | undefined;
  let branchGate: ((path: string) => Promise<void> | undefined) | undefined;
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test');
    seen.push({ method: request.method, url, credential: request.headers['private-token'] });
    let body: unknown;
    if (url.pathname === projectPath) {
      body = { id: repositoryId, path_with_namespace: 'team/app', web_url: repositoryUrl, default_branch: 'main', ...projectOverrides };
    } else if (url.pathname === defaultListPath) {
      await listGate?.();
      body = mrList(Number(url.searchParams.get('page') ?? 1));
    } else if (url.pathname.startsWith(`${defaultListPath}/`)) {
      await mergeRequestGate?.();
      body = mergeRequests.get(url.pathname);
    } else {
      await branchGate?.(url.pathname);
      body = branches.get(url.pathname);
    }
    if (response.destroyed) return;
    response.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  repositoryUrl = `${baseUrl}/team/app`;
  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const stored = new Store(dataDir);
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    async function close(instance: typeof server) {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
    }
    try { await Promise.all([close(server), close(mock)]); }
    finally { stored.db.close(); runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, headers }: RequestOptions = {}) {
    const response = await fetch(apiUrl + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, headers: response.headers, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, expected = 200) {
    const response = await request<T>(path, options);
    assert.equal(response.status, expected, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const settings = () => call<GitlabSettings>('/integrations/gitlab');
  const configure = async (patch: { baseUrl?: string; projectIds?: number[]; token?: string; webhookSecret?: string }) =>
    call<GitlabSettings>('/integrations/gitlab', { method: 'PATCH', body: { expectedVersion: (await settings()).version, ...patch } });
  await configure({ baseUrl, projectIds: [repositoryId], token, webhookSecret });
  const createIssue = (title: string) => call<Issue>('/issues', { method: 'POST', body: { projectId, title } }, 201);
  const issue = await createIssue('저장된 업무 제목');
  const issuePath = `/issues/${issue.id}`;
  const attach = async () => call<GitlabLink>(`${issuePath}/gitlab-links`, { method: 'POST', body: {
    repositoryId, expectedSettingsVersion: (await settings()).version, url: `${repositoryUrl}/-/tree/${encodeURIComponent(source)}`,
  } }, 201);
  const link = await attach();
  seen.length = 0;
  const mrUrl = (iid: number) => `${repositoryUrl}/-/merge_requests/${iid}`;
  function mr(iid: number, overrides: Record<string, unknown> = {}) {
    return { id: 1_000 + iid, iid, title: `MR ${iid}`, source_branch: source, target_branch: 'main', source_project_id: repositoryId,
      target_project_id: repositoryId, project_id: repositoryId, web_url: mrUrl(iid), state: 'opened', sha: sourceSha,
      updated_at: new Date(Date.now() - 60_000).toISOString(), ...overrides };
  }
  return { issue, issuePath, link, seen, baseUrl, repositoryUrl, mrUrl, configure, createIssue, call, request, stored, attach,
    path: readPath(issue.id, link.id),
    snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    unlink: () => call(`${issuePath}/gitlab-links/${encodeURIComponent(link.id)}?${new URLSearchParams({ expectedManualLinkId: link.manualLinkId! })}`,
      { method: 'DELETE' }),
    changeTitle: (title: string) => call<Issue>(issuePath, { method: 'PATCH', body: { title, expectedVersion: issue.version } }),
    setProject(value: Record<string, unknown>) { projectOverrides = value; },
    setBranch(ref: string, value: Record<string, unknown> | null) {
      if (value) branches.set(branchPath(ref), value);
      else branches.delete(branchPath(ref));
    },
    setList(value: typeof mrList) { mrList = value; },
    setListGate(gate?: () => Promise<void>) { listGate = gate; },
    setBranchGate(gate?: typeof branchGate) { branchGate = gate; },
    setMergeRequestGate(gate?: () => Promise<void>) { mergeRequestGate = gate; },
    setMergeRequest(iid: number, value: Record<string, unknown> | null) {
      if (value) mergeRequests.set(mergeRequestPath(iid), value);
      else mergeRequests.delete(mergeRequestPath(iid));
    },
    mr,
    webhook(iid: number, values: Record<string, unknown>) {
      return call<{ linked: number; runs: unknown[] }>('/integrations/gitlab/webhook', { method: 'POST',
        headers: { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': webhookSecret }, body: {
          object_kind: 'merge_request', project: { id: repositoryId, web_url: repositoryUrl },
          object_attributes: mr(iid, { action: 'open', url: mrUrl(iid), ...values }),
        } });
    },
  };
}

test('reads the saved branch, scope, and heads and returns a GitLab form only after checking for open MRs', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const result = await f.request<GitlabBranchMergeRequests>(f.path);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const { checkedAt, newMergeRequestUrl, branchRevision, ...rest } = result.data;
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
  assert.match(branchRevision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(rest, { linkId: f.link.id, repositoryId, sourceBranch: source, sourceSha,
    defaultBranch: 'main', targetBranch: 'main', targetSha: mainSha, openMergeRequests: [], hasMore: false,
    suggestedTitle: `[${f.issue.key}] ${f.issue.title}` });
  const form = new URL(newMergeRequestUrl!);
  assert.equal(form.origin + form.pathname, `${f.repositoryUrl}/-/merge_requests/new`);
  assert.deepEqual(Object.fromEntries(form.searchParams), { 'merge_request[source_branch]': source,
    'merge_request[target_branch]': 'main', 'merge_request[source_project_id]': String(repositoryId),
    'merge_request[target_project_id]': String(repositoryId) });
  assert.ok(f.seen.every(request => request.method === 'GET' && request.credential === token));
  assert.equal(f.seen.filter(request => request.url.pathname === branchPath(source)).length, 2);
  assert.equal(f.seen.filter(request => request.url.pathname === branchPath('main')).length, 2);
  const mrRequest = f.seen.find(request => request.url.pathname === defaultListPath)!.url;
  assert.equal(mrRequest.searchParams.get('state'), 'opened');
  assert.equal(mrRequest.searchParams.get('scope'), 'all');
  assert.equal(mrRequest.searchParams.get('source_branch'), source);
  assert.equal(mrRequest.searchParams.has('target_branch'), false);
  assert.deepEqual(await f.snapshot(), before);
});

test('reports exact open MRs across targets while ignoring fork and different-source rows', async t => {
  const f = await fixture(t);
  f.setList(() => [f.mr(11, { source_project_id: 99 }), f.mr(14, { source_branch: 'feature/unrelated' }),
    f.mr(15, { target_branch: customTarget }), f.mr(17)]);
  const result = await f.call<GitlabBranchMergeRequests>(f.path + targetQuery('main'));
  assert.equal(result.newMergeRequestUrl, null);
  assert.equal(result.targetBranch, null);
  assert.equal(result.targetSha, null);
  assert.deepEqual(result.openMergeRequests, [
    { id: 1015, iid: 15, title: 'MR 15', targetBranch: customTarget, webUrl: f.mrUrl(15) },
    { id: 1017, iid: 17, title: 'MR 17', targetBranch: 'main', webUrl: f.mrUrl(17) },
  ]);
  assert.equal(f.seen.some(request => request.url.pathname === branchPath('main')), false);
});

test('suppresses GitLab form when an exhaustive duplicate check exceeds the page limit', async t => {
  const f = await fixture(t);
  f.setList(page => Array.from({ length: 50 }, (_, index) => f.mr(page * 100 + index, { source_project_id: 57 })));
  const result = await f.call<GitlabBranchMergeRequests>(f.path);
  assert.deepEqual(result.openMergeRequests, []);
  assert.equal(result.hasMore, true);
  assert.equal(result.newMergeRequestUrl, null);
  const listRequests = f.seen.filter(request => request.url.pathname === defaultListPath);
  assert.deepEqual(listRequests.map(request => request.url.searchParams.get('page')), ['1', '2', '3', '4']);
  assert.equal(f.seen.some(request => request.url.pathname === branchPath('main')), false);
});

test('accepts a verified custom target, requires distinct heads, and bounds the saved issue title', async t => {
  const f = await fixture(t);
  const titlePrefix = `[${f.issue.key}] 첫 줄 다음 줄 `;
  await f.changeTitle(`첫 줄\n다음 줄 ${'x'.repeat(254 - titlePrefix.length)}😀`);
  f.setProject({ default_branch: null });
  const noDefault = await f.call<GitlabBranchMergeRequests>(f.path);
  assert.equal(noDefault.newMergeRequestUrl, null);
  assert.equal(noDefault.defaultBranch, null);
  const verified = await f.call<GitlabBranchMergeRequests>(f.path + targetQuery(customTarget));
  assert.equal(verified.targetBranch, customTarget);
  assert.equal(verified.targetSha, customSha);
  assert.equal(new URL(verified.newMergeRequestUrl!).searchParams.get('merge_request[target_branch]'), customTarget);
  assert.equal(verified.suggestedTitle, titlePrefix + 'x'.repeat(254 - titlePrefix.length));
  assert.equal(verified.suggestedTitle.isWellFormed(), true);

  f.setBranch(customTarget, { name: customTarget, commit: { id: sourceSha } });
  const sameHead = await f.call<GitlabBranchMergeRequests>(f.path + targetQuery(customTarget));
  assert.equal(sameHead.targetSha, sameHead.sourceSha);
  assert.equal(sameHead.newMergeRequestUrl, null);
  f.setBranch(customTarget, null);
  await f.call(f.path + targetQuery(customTarget), {}, 404);
  await f.call(f.path + targetQuery(source), {}, 200);
});

test('rejects ambiguous query parameters and stale, unrelated, or malformed stored branch links before GitLab reads', async t => {
  const f = await fixture(t);
  for (const query of ['?targetBranch=', '?targetBranch=main&targetBranch=main', '?targetBranch[]=main', '?targetBranch[a]=main',
    '?targetBranch=main&repositoryId=42', '?targetBranch=%20main', '?sourceBranch=main']) {
    const result = await f.request(f.path + query);
    assert.equal(result.status, 400, query);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  const other = await f.createIssue('다른 업무');
  await f.call(readPath(other.id, f.link.id), {}, 404);
  const key = await f.call<{ token: string }>('/api-keys', { method: 'POST', body: {
    name: '브랜치 MR 조회 범위 검증', access: 'read', projectIds: [projectId], expiresAt: null,
  } }, 201);
  await f.call(`/v1${f.path}`, { headers: { Authorization: `Bearer ${key.token}` } }, 403);
  f.stored.put('gitlab_links', { ...f.link, state: 'deleted' });
  await f.call(f.path, {}, 404);
  f.stored.put('gitlab_links', { ...f.link, sourceBranch: 'main', title: 'main', webUrl: `${f.repositoryUrl}/-/tree/main` });
  await f.call(f.path, {}, 409);
  f.stored.put('gitlab_links', { ...f.link, webUrl: `http://wrong.test/team/app/-/tree/${encodeURIComponent(source)}` });
  await f.call(f.path, {}, 409);
  f.stored.put('gitlab_links', f.link);
  await f.configure({ projectIds: [57] });
  await f.call(f.path, {}, 403);
  assert.deepEqual(f.seen, []);
});

test('fails closed on incorrect GitLab project, branch, target SHA, or exact MR URL', async t => {
  const f = await fixture(t);
  f.setProject({ id: 57 });
  await f.call(f.path, {}, 502);
  f.setProject({});
  f.setBranch(source, { name: 'feature/wrong', commit: { id: sourceSha } });
  await f.call(f.path, {}, 502);
  f.setBranch(source, { name: source, commit: { id: '0'.repeat(40) } });
  await f.call(f.path, {}, 502);
  f.setBranch(source, { name: source, commit: { id: sourceSha } });
  f.setBranch('main', { name: 'main', commit: { id: 'invalid-sha' } });
  await f.call(f.path, {}, 502);
  f.setBranch('main', { name: 'main', commit: { id: mainSha } });
  f.setList(() => [f.mr(15, { web_url: `${f.baseUrl}/team/other/-/merge_requests/15` })]);
  await f.call(f.path, {}, 502);
  f.setList(() => [f.mr(15, { source_project_id: 57, target_project_id: 58, project_id: 58 })]);
  await f.call(f.path, {}, 502);
});

test('refuses to return a handoff if source, target, link, settings, saved issue, or workspace changes mid-read', async t => {
  const f = await fixture(t);
  async function race(change: () => void | Promise<unknown>, holdSecondTargetRead = false) {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const wait = () => { entered.resolve(); return resume.promise; };
    if (holdSecondTargetRead) {
      let targetReads = 0;
      f.setBranchGate(path => path === branchPath('main') && ++targetReads === 2 ? wait() : undefined);
    } else {
      f.setListGate(wait);
    }
    const reading = f.request<Partial<GitlabBranchMergeRequests>>(f.path);
    await Promise.race([entered.promise, reading.then(() => assert.fail('GitLab read did not reach the gate'))]);
    try { await change(); }
    finally { resume.resolve(); f.setListGate(); f.setBranchGate(); }
    const result = await reading;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.data.newMergeRequestUrl, undefined);
    assert.equal(result.data.openMergeRequests, undefined);
  }
  await race(() => f.setBranch(source, { name: source, commit: { id: 'd'.repeat(40) } }));
  await race(() => f.setBranch('main', { name: 'main', commit: { id: 'e'.repeat(40) } }), true);
  await race(async () => {
    await f.unlink();
    const replacement = await f.attach();
    assert.equal(replacement.id, f.link.id);
    assert.notEqual(replacement.manualLinkId, f.link.manualLinkId);
  });
  await race(() => f.configure({ token: `${token}-new` }));
  let issue: Issue = f.issue;
  await race(async () => { issue = await f.changeTitle('새로 저장된 업무 제목'); });
  await race(() => f.call(f.issuePath, { method: 'PATCH', body: { description: '별도로 편집한 설명', expectedVersion: issue.version } }));
  await race(() => f.stored.setSetting('attachmentImportGeneration', 'new-generation'));
});

async function reviewedMergeRequest(f: Awaited<ReturnType<typeof fixture>>, iid: number, overrides: Record<string, unknown> = {}) {
  const sample = f.mr(iid, overrides);
  f.setList(() => [sample]);
  f.setMergeRequest(iid, sample);
  const discovery = await f.call<GitlabBranchMergeRequests>(f.path);
  const mr = discovery.openMergeRequests[0]!;
  const attachment: GitlabBranchMergeRequestAttachment = {
    mergeRequestId: mr.id, mergeRequestIid: mr.iid, targetBranch: mr.targetBranch, branchRevision: discovery.branchRevision,
  };
  return { method: 'POST', body: attachment };
}

test('attaches the exact discovered MR once without enabling automation and retries after a close webhook', async t => {
  const f = await fixture(t);
  const rule = await f.call<AutomationRule>('/automation-rules', { method: 'POST', body: {
    projectId, name: 'Change a ticket when an MR opens', trigger: 'merge_request.opened', branchPattern: 'feature/*',
    gitlabProjectIds: [repositoryId], issueTypes: [], fromStatuses: [f.issue.status], toStatusId: 'done', actorId: 'user-seo', priority: 10,
  } }, 201);
  await f.call(`/automation-rules/${rule.id}`, { method: 'PATCH', body: { expectedVersion: rule.version, enabled: true } });
  const iid = 11;
  const attachment = await reviewedMergeRequest(f, iid, { target_branch: customTarget });
  const before = await f.snapshot();
  f.seen.length = 0;

  const writes = await Promise.all([f.request<GitlabLink>(f.path, attachment), f.request<GitlabLink>(f.path, attachment)]);
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 201]);
  const [attached, retried] = writes.map(result => result.data);
  assert.deepEqual(attached, retried);
  assert.ok(writes.every(result => result.headers.get('cache-control') === 'no-store'));
  assert.ok(attached.manualLinkId);
  assert.equal(attached.id.split(':').at(-2), String(attachment.body.mergeRequestId));
  assert.equal(attached.kind, 'merge_request');
  assert.equal(attached.issueId, f.issue.id);
  assert.equal(attached.projectId, repositoryId);
  assert.equal(attached.iid, iid);
  assert.equal(attached.webUrl, f.mrUrl(iid));
  assert.equal(attached.sourceBranch, source);
  assert.equal(attached.state, 'opened');
  assert.deepEqual(f.seen.map(({ url }) => url.pathname).sort(), [projectPath, projectPath, mergeRequestPath(iid), mergeRequestPath(iid)]);
  assert.ok(f.seen.every(request => request.method === 'GET' && request.credential === token));
  const after = await f.snapshot();
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(after.gitlabLinks.filter(link => link.kind === 'merge_request'), [attached]);
  assert.equal(after.activities.length, before.activities.length + 1);
  assert.equal(after.activities.filter(activity => activity.action === 'GitLab 활동 수동 연결' && activity.detail?.startsWith(`MR !${iid}`)).length, 1);

  const closed = { target_branch: customTarget, state: 'closed', updated_at: new Date(Date.now() - 100).toISOString() };
  assert.equal((await f.webhook(iid, { ...closed, action: 'close' })).linked, 1);
  f.setMergeRequest(iid, f.mr(iid, closed));
  const afterClose = await f.snapshot();
  const saved = afterClose.gitlabLinks.find(link => link.id === attached.id);
  assert.equal(saved?.state, 'closed');
  assert.equal(saved?.manualLinkId, attached.manualLinkId);
  assert.deepEqual(await f.call(f.path, attachment, 200), saved);
  assert.deepEqual(await f.snapshot(), afterClose);
});

test('preserves an existing exact automatic MR connection', async t => {
  const f = await fixture(t);
  const iid = 12;
  assert.equal((await f.webhook(iid, { title: `${f.issue.key} 자동으로 연결한 MR` })).linked, 1);
  const attachment = await reviewedMergeRequest(f, iid);
  const before = await f.snapshot();
  const saved = before.gitlabLinks.find(link => link.kind === 'merge_request' && link.iid === iid);
  assert.ok(saved);
  assert.equal(saved.manualLinkId, undefined);
  assert.deepEqual(await f.call(f.path, attachment, 200), saved);
  assert.deepEqual(await f.snapshot(), before);
});

test('rejects malformed requests and exact MR mismatches without writing to the issue', async t => {
  const f = await fixture(t);
  const iid = 13;
  const attachment = await reviewedMergeRequest(f, iid);
  const before = await f.snapshot();
  const receivedBeforeRejections = f.seen.length;
  for (const fields of [{ mergeRequestId: '1013' }, { mergeRequestIid: 0 }, { mergeRequestIid: 1.5 }, { mergeRequestId: Number.MAX_SAFE_INTEGER + 1 },
    { targetBranch: 'invalid branch' }, { targetBranch: source }, { branchRevision: 'short' }, { actorId: 1 }, { url: f.mrUrl(iid) }, { repositoryId }]) {
    await f.call(f.path, { ...attachment, body: { ...attachment.body, ...fields } }, 400);
  }
  await f.call(f.path + '?targetBranch=main', attachment, 400);
  await f.call(f.path, { ...attachment, body: { ...attachment.body, branchRevision: '0'.repeat(64) } }, 409);
  const other = await f.createIssue('브랜치와 연결되지 않은 업무');
  await f.call(readPath(other.id, f.link.id), attachment, 404);
  assert.equal(f.seen.length, receivedBeforeRejections);
  for (const fields of [{ state: 'merged' }, { state: 'closed' }, { id: 2000 }, { source_branch: 'feature/unrelated' },
    { target_branch: customTarget }, { source_project_id: repositoryId + 1 }, { target_project_id: undefined }]) {
    f.setMergeRequest(iid, f.mr(iid, fields));
    await f.call(f.path, attachment, 409);
  }
  f.setMergeRequest(iid, f.mr(iid, { web_url: `${f.baseUrl}/team/wrong/-/merge_requests/${iid}` }));
  await f.call(f.path, attachment, 502);
  f.setMergeRequest(iid, null);
  await f.call(f.path, attachment, 404);
  const after = await f.snapshot();
  assert.deepEqual(after.gitlabLinks, before.gitlabLinks);
  assert.deepEqual(after.issues.find(issue => issue.id === f.issue.id), f.issue);
  assert.deepEqual(after.activities.filter(activity => activity.resourceId === f.issue.id), before.activities.filter(activity => activity.resourceId === f.issue.id));
});

test('does not attach an MR if settings, issue, branch connection, or workspace change during its exact read', async t => {
  const f = await fixture(t);
  const iid = 14;
  async function race(change: () => void | Promise<unknown>) {
    const attachment = await reviewedMergeRequest(f, iid);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    f.setMergeRequestGate(() => { entered.resolve(); return resume.promise; });
    const applying = f.request(f.path, attachment);
    await Promise.race([entered.promise, applying.then(() => assert.fail('GitLab read did not reach the detail gate'))]);
    try { await change(); }
    finally { resume.resolve(); f.setMergeRequestGate(); }
    const result = await applying;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.ok((await f.snapshot()).gitlabLinks.every(link => link.kind !== 'merge_request'));
  }
  await race(() => f.configure({ token: `${token}-new` }));
  await race(() => f.changeTitle('검토 중 저장한 업무 제목'));
  await race(() => f.stored.setSetting('attachmentImportGeneration', 'changed-during-attachment'));
  await race(async () => {
    await f.unlink();
    const replacement = await f.attach();
    assert.equal(replacement.id, f.link.id);
    assert.notEqual(replacement.manualLinkId, f.link.manualLinkId);
  });
});
