import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { isGitlabManualLinkId } from '../../shared/gitlab-links.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { AutomationRule, GitlabIssueRefreshResult, GitlabLink, GitlabSettings, GitlabSyncResult, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const actor = 'user-seo';
const repositoryId = 42;
const token = 'synthetic-gitlab-read';
const secret = 'synthetic-gitlab-events';
const sourceBranch = 'feature/existing-work';
const secondaryBranch = 'fix/other-branch';
const sha = '1'.repeat(40);
const commitSha = 'a'.repeat(40);
const mrId = 1007;
const mrIid = 17;
const pipelineId = 215;
const pathFor = (id: string) => `/issues/${id}/gitlab-links`;
const deletePath = (id: string, link: GitlabLink) => `${pathFor(id)}/${encodeURIComponent(link.id)}?expectedManualLinkId=${link.manualLinkId}`;
type Backup = WorkspaceSnapshot & { schemaVersion: number; trashEntries: { id: string; gitlabLinks: GitlabLink[] }[] };
type Options = { method?: string; body?: unknown; headers?: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-manual-gitlab-'));
  const calls: { method: string | undefined; path: string; credential: string | string[] | undefined }[] = [];
  const time = Date.now() - 60_000;
  const instant = (offset = 0) => new Date(time + 1000 * offset).toISOString();
  let baseUrl = '';
  let objectGate: (() => Promise<void>) | undefined;
  let branchGate: (() => Promise<void>) | undefined;
  let projectRead = { id: repositoryId, status: 200 };
  let pipelineReadStatus = 200;
  let branchReadStatus = 200;
  let branchProof: Record<string, unknown> = {};
  let branchHead = sha;
  const projectPath = `/gitlab/api/v4/projects/${repositoryId}`;
  const branchPath = `${projectPath}/repository/branches/${encodeURIComponent(sourceBranch)}`;
  const projectUrl = () => `${baseUrl}/team/subgroup/product`;
  const mrUrl = () => `${projectUrl()}/-/merge_requests/${mrIid}`;
  const pipelineUrl = () => `${projectUrl()}/-/pipelines/${pipelineId}`;
  const branchUrl = () => `${projectUrl()}/-/tree/${encodeURIComponent(sourceBranch)}`;
  const secondaryBranchUrl = () => `${projectUrl()}/-/tree/${encodeURIComponent(secondaryBranch)}`;
  const commitUrl = () => `${projectUrl()}/-/commit/${commitSha}`;
  let mr = { id: mrId, iid: mrIid, project_id: repositoryId, target_project_id: repositoryId,
    title: 'Existing implementation review', state: 'opened', source_branch: sourceBranch, sha, updated_at: instant(),
    detailed_merge_status: undefined as string | undefined };
  let pipeline = { id: pipelineId, iid: 12, project_id: repositoryId, ref: sourceBranch, sha, status: 'running', updated_at: instant(),
    source: undefined as unknown, tag: undefined as unknown };
  const mock = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ method: req.method, path, credential: req.headers['private-token'] });
    res.setHeader('Content-Type', 'application/json');
    const mergeRequest = { ...mr, web_url: mrUrl() };
    const pipelineObject = { ...pipeline, web_url: pipelineUrl() };
    const branch = { name: sourceBranch, commit: { id: branchHead }, web_url: branchUrl(), ...branchProof };
    const commitTitle = 'Existing repository changes';
    const commit = { id: commitSha, title: commitTitle, message: commitTitle, committed_date: instant(), web_url: commitUrl() };
    if (path === projectPath) {
      res.statusCode = projectRead.status;
      res.end(JSON.stringify(projectRead.status === 200 ? { id: projectRead.id, path_with_namespace: 'team/subgroup/product', web_url: projectUrl() }
        : { message: `fixture ${token}` }));
    }
    else if (path === `${projectPath}/merge_requests/${mrIid}`) {
      await objectGate?.();
      res.end(JSON.stringify(mergeRequest));
    } else if (path === `${projectPath}/pipelines/${pipelineId}`) {
      res.statusCode = pipelineReadStatus;
      res.end(JSON.stringify(pipelineReadStatus === 200 ? pipelineObject : { message: `fixture ${token}` }));
    }
    else if (path === `${projectPath}/merge_requests`) res.end(JSON.stringify([mergeRequest]));
    else if (path === `${projectPath}/pipelines`) res.end(JSON.stringify([pipelineObject]));
    else if (path === branchPath) {
      const status = branchReadStatus;
      await branchGate?.();
      res.statusCode = status;
      res.end(JSON.stringify(status === 200 ? branch : { message: `fixture ${token}` }));
    } else if (path === `${projectPath}/repository/branches/${encodeURIComponent(secondaryBranch)}`) {
      res.end(JSON.stringify({ name: secondaryBranch, commit: { id: commitSha }, web_url: secondaryBranchUrl() }));
    } else if (path === `${projectPath}/repository/commits/${commitSha}`) res.end(JSON.stringify(commit));
    else if (path === `${projectPath}/repository/branches`) res.end(JSON.stringify([branch]));
    else if (path === `${projectPath}/repository/commits`) res.end(JSON.stringify([commit]));
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `fixture ${token}` }));
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/gitlab`;
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    async function close(instance: typeof server) {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
    }
    try { await Promise.all([close(server), close(mock)]); }
    finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, headers }: Options = {}) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: Options, status = 200) {
    const result = await request<T>(path, options);
    assert.equal(result.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const currentSettings = () => call<GitlabSettings>('/integrations/gitlab');
  const configure = async () => call<GitlabSettings>('/integrations/gitlab', { method: 'PATCH', body: {
    expectedVersion: (await currentSettings()).version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
  } });
  const settings = await configure();
  const issue = await call<Issue>('/issues', { method: 'POST', body: { projectId, title: 'Link existing code discussion' } }, 201);
  const attach = (url: string, expectedSettingsVersion = settings.version) => ({ method: 'POST', body: { url, repositoryId, expectedSettingsVersion } });
  const links = async (id = issue.id) => (await call<{ links: GitlabLink[] }>(pathFor(id))).links;
  const webhook = (kind: 'merge_request' | 'pipeline', attributes: Record<string, unknown>) => call<{ linked: number }>('/integrations/gitlab/webhook', {
    method: 'POST', headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
    body: { object_kind: kind, project: { id: repositoryId, web_url: projectUrl() }, object_attributes: attributes },
  });
  const push = (before: string, after: string, commits: Record<string, unknown>[] = [], branch = sourceBranch) => call<{ linked: number; runs: unknown[] }>(
    '/integrations/gitlab/webhook', { method: 'POST', headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() }, body: {
      object_kind: 'push', project_id: repositoryId, ref: `refs/heads/${branch}`, before, after, commits,
      project: { id: repositoryId, web_url: projectUrl(), path_with_namespace: 'team/subgroup/product' },
    } });
  return { call, request, issue, attach, configure, links, webhook, push, instant, calls, projectPath, branchPath, mrUrl: mrUrl(), pipelineUrl: pipelineUrl(),
    branchUrl: branchUrl(), secondaryBranchUrl: secondaryBranchUrl(), commitUrl: commitUrl(), setBranchHead(value: string) { branchHead = value; },
    holdBranchRead(gate?: () => Promise<void>) { branchGate = gate; },
    setProjectRead(patch: Partial<typeof projectRead>) { projectRead = { ...projectRead, ...patch }; },
    setBranchRead(status: number, proof: Record<string, unknown> = {}) { branchReadStatus = status; branchProof = proof; },
    setPipelineReadStatus(status: number) { pipelineReadStatus = status; },
    setPipeline(patch: Partial<typeof pipeline>) { pipeline = { ...pipeline, ...patch }; },
    setMr(patch: Partial<typeof mr>) { mr = { ...mr, ...patch }; }, holdRead(gate: () => Promise<void>) { objectGate = gate; } };
}

test('exact manual pipeline links share verified classification across aliases and reject contradictory detail', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const refresh = () => f.call<GitlabIssueRefreshResult>(`${path}/refresh`, { method: 'POST', body: {} });
  f.setPipeline({ source: 'https://example.test/not-a-source', tag: 'false' });
  const attached = await f.call<GitlabLink>(path, f.attach(f.pipelineUrl), 201);
  assert.equal(Object.hasOwn(attached, 'pipelineSource'), false);
  assert.equal(Object.hasOwn(attached, 'pipelineTag'), false);

  f.setPipeline({ source: 'push', tag: false });
  const classified = { ...attached, pipelineSource: 'push', pipelineTag: false };
  assert.deepEqual(await refresh(), { links: [classified], failures: [], skipped: 0 });
  const other = await f.call<Issue>('/issues', { method: 'POST', body: { projectId, title: 'A second ticket for the same pipeline' } }, 201);
  f.setPipeline({ source: 'schedule', tag: true, status: 'failed', updated_at: f.instant(1) });
  await f.call(pathFor(other.id), f.attach(f.pipelineUrl), 409);
  const rejected = await refresh();
  assert.deepEqual(rejected.links, []);
  assert.deepEqual(rejected.failures.map(failure => failure.linkId), [attached.id]);
  assert.deepEqual(await f.links(), [classified]);
  assert.deepEqual(await f.links(other.id), []);

  f.setPipeline({ source: undefined, tag: undefined, status: 'running', updated_at: f.instant(2) });
  const alias = await f.call<GitlabLink>(pathFor(other.id), f.attach(f.pipelineUrl), 201);
  assert.equal(alias.pipelineSource, 'push');
  assert.equal(alias.pipelineTag, false);
  assert.equal((await f.webhook('pipeline', { id: pipelineId, ref: sourceBranch, sha, status: 'success',
    updated_at: f.instant(3), url: f.pipelineUrl })).linked, 2);
  for (const id of [f.issue.id, other.id]) {
    const [current] = await f.links(id);
    assert.equal(current.state, 'success');
    assert.equal(current.pipelineSource, 'push');
    assert.equal(current.pipelineTag, false);
  }
});

test('ticket GitLab refresh reads exact linked objects, reports partial failure, and skips status automation', async t => {
  const f = await fixture(t);
  const mrTitle = `${f.issue.key} Existing implementation review`;
  const refreshPath = `${pathFor(f.issue.id)}/refresh`;
  await f.webhook('merge_request', { id: mrId, iid: mrIid, title: mrTitle, state: 'opened', action: 'open',
    source_branch: sourceBranch, sha, url: f.mrUrl, updated_at: f.instant() });
  const [originalMr] = await f.links();
  assert.equal(originalMr.manualLinkId, undefined);
  const pipeline = await f.call<GitlabLink>(pathFor(f.issue.id), f.attach(f.pipelineUrl), 201);
  const branch = await f.call<GitlabLink>(pathFor(f.issue.id), f.attach(f.branchUrl), 201);
  const commit = await f.call<GitlabLink>(pathFor(f.issue.id), f.attach(f.commitUrl), 201);
  const other = await f.call<Issue>('/issues', { method: 'POST', body: { projectId, title: 'Linked separately' } }, 201);
  const otherLink = await f.call<GitlabLink>(pathFor(other.id), f.attach(f.mrUrl), 201);
  const otherBranch = await f.call<GitlabLink>(pathFor(other.id), f.attach(f.branchUrl), 201);
  const unrelatedBranch = await f.call<GitlabLink>(pathFor(other.id), f.attach(f.secondaryBranchUrl), 201);
  const rule = await f.call<AutomationRule>('/automation-rules', { method: 'POST', body: {
    projectId, name: 'Merge moves ticket to done', trigger: 'merge_request.merged', branchPattern: 'feature/*', gitlabProjectIds: [repositoryId],
    issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: actor, priority: 10,
  } }, 201);
  await f.call(`/automation-rules/${rule.id}`, { method: 'PATCH', body: { expectedVersion: rule.version, enabled: true } });
  const before = await f.call<WorkspaceSnapshot>('/workspace');

  f.setMr({ title: mrTitle, state: 'merged', updated_at: f.instant(12) });
  f.setPipelineReadStatus(503);
  const branchHead = '2'.repeat(40);
  f.setBranchHead(branchHead);
  f.calls.length = 0;
  await f.call(refreshPath, { method: 'POST', body: { url: 'http://wrong.example.test' } }, 400);
  assert.equal(f.calls.length, 0);
  const refreshed = await f.call<GitlabIssueRefreshResult>(refreshPath, { method: 'POST', body: {} });
  assert.equal(refreshed.skipped, 0);
  assert.equal(refreshed.links.length, 2);
  const refreshedMr = refreshed.links.find(link => link.id === originalMr.id);
  assert.ok(refreshedMr);
  assert.equal(refreshedMr.state, 'merged');
  assert.equal(refreshedMr.manualLinkId, undefined);
  const refreshedBranch = refreshed.links.find(link => link.id === branch.id);
  assert.ok(refreshedBranch);
  assert.equal(refreshedBranch.sourceSha, branchHead);
  assert.equal(refreshedBranch.sourceBranch, sourceBranch);
  assert.equal(refreshedBranch.branchObservationSource, 'read');
  assert.equal(refreshedBranch.manualLinkId, branch.manualLinkId);
  assert.equal(refreshedBranch.webUrl, branch.webUrl);
  assert.deepEqual(refreshed.failures.map(failure => failure.linkId), [pipeline.id]);
  assert.doesNotMatch(JSON.stringify(refreshed), new RegExp(token));
  assert.deepEqual(new Set(f.calls.map(call => call.path)), new Set([
    f.projectPath, `${f.projectPath}/merge_requests/${mrIid}`, `${f.projectPath}/pipelines/${pipelineId}`, f.branchPath,
  ]));
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
  const aliases = new Map((await f.links(other.id)).map(link => [link.id, link]));
  assert.equal(aliases.size, 3);
  assert.deepEqual(aliases.get(otherLink.id), otherLink);
  assert.deepEqual(aliases.get(unrelatedBranch.id), unrelatedBranch);
  assert.deepEqual(aliases.get(otherBranch.id), { ...otherBranch, sourceSha: branchHead,
    branchObservationSource: 'read', updatedAt: refreshedBranch.updatedAt });
  assert.deepEqual((await f.links()).find(link => link.id === branch.id), refreshedBranch);
  assert.deepEqual((await f.links()).find(link => link.id === commit.id), commit);
  assert.deepEqual((await f.links()).find(link => link.id === pipeline.id), pipeline);

  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues.find(issue => issue.id === f.issue.id), before.issues.find(issue => issue.id === f.issue.id));
  assert.deepEqual(after.activities, before.activities);
  f.setPipelineReadStatus(200);
  f.setPipeline({ status: 'success', updated_at: f.instant(15) });
  const retried = await f.call<GitlabIssueRefreshResult>(refreshPath, { method: 'POST', body: {} });
  assert.deepEqual(retried.failures, []);
  const verifiedPipeline = retried.links.find(link => link.id === pipeline.id)!;
  assert.equal(verifiedPipeline.state, 'success');
  assert.equal(verifiedPipeline.manualLinkId, pipeline.manualLinkId);
  assert.deepEqual((await f.links()).find(link => link.id === pipeline.id), verifiedPipeline);
});

test('ticket GitLab refresh retains a newer webhook and rejects an in-flight connection change before saving', async t => {
  const f = await fixture(t);
  const refreshPath = `${pathFor(f.issue.id)}/refresh`;
  const mrTitle = `${f.issue.key} Existing implementation review`;
  const hookFields = { id: mrId, iid: mrIid, title: mrTitle, source_branch: sourceBranch, sha, url: f.mrUrl };
  await f.webhook('merge_request', { ...hookFields, state: 'opened', action: 'open', updated_at: f.instant() });
  const pipeline = await f.call<GitlabLink>(pathFor(f.issue.id), f.attach(f.pipelineUrl), 201);
  f.setMr({ title: mrTitle, state: 'opened', updated_at: f.instant(10) });

  async function holdRefresh(change: () => Promise<void>) {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    f.holdRead(() => { entered(); return resumed; });
    const pending = f.request<GitlabIssueRefreshResult>(refreshPath, { method: 'POST', body: {} });
    await Promise.race([waiting, pending.then(result => assert.fail(`MR read did not reach the mock endpoint (${result.status})`))]);
    try { await change(); }
    finally { release(); }
    return pending;
  }
  const newer = await holdRefresh(async () => {
    await f.webhook('merge_request', { ...hookFields, state: 'merged', action: 'merge', updated_at: f.instant(20) });
  });
  assert.equal(newer.status, 200);
  const merged = (await f.links()).find(link => link.kind === 'merge_request');
  assert.equal(merged?.state, 'merged');
  assert.deepEqual(newer.data.links.find(link => link.id === merged?.id), merged);

  f.setMr({ state: 'closed', updated_at: f.instant(30) });
  f.setPipeline({ status: 'success', updated_at: f.instant(31) });
  const changedSettings = await holdRefresh(async () => {
    const current = await f.call<GitlabSettings>('/integrations/gitlab');
    await f.call('/integrations/gitlab', { method: 'PATCH', body: { expectedVersion: current.version, token: 'rotated-synthetic-token' } });
  });
  assert.equal(changedSettings.status, 409);
  const saved = await f.links();
  assert.deepEqual(saved.find(link => link.id === merged?.id), merged);
  assert.deepEqual(saved.find(link => link.id === pipeline.id), pipeline);
});

test('ticket branch refresh preserves saved evidence when the exact repository or ref is unavailable', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const attached = await f.call<GitlabLink>(path, f.attach(f.branchUrl), 201);
  const before = await f.call<WorkspaceSnapshot>('/workspace');
  const changedHead = '2'.repeat(40);
  f.setBranchHead(changedHead);
  const refresh = () => f.call<GitlabIssueRefreshResult>(`${path}/refresh`, { method: 'POST', body: {} });
  async function preserves(saved: GitlabLink, paths: string[]) {
    f.calls.length = 0;
    const response = await refresh();
    assert.deepEqual(response.links, []);
    assert.deepEqual(response.failures.map(failure => failure.linkId), [attached.id]);
    assert.ok(response.failures[0].message.trim());
    assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
    assert.deepEqual(f.calls.map(call => call.path), paths);
    assert.deepEqual(await f.links(), [saved]);
  }

  f.setProjectRead({ id: 99 });
  await preserves(attached, [f.projectPath]);
  f.setProjectRead({ id: repositoryId, status: 404 });
  await preserves(attached, [f.projectPath]);
  f.setProjectRead({ status: 200 });
  const exactPaths = [f.projectPath, f.branchPath];
  f.setBranchRead(200, { name: 'feature/another-ref' });
  await preserves(attached, exactPaths);
  f.setBranchRead(200, { project_id: 99 });
  await preserves(attached, exactPaths);
  f.setBranchRead(200, { commit: { id: '0'.repeat(40) } });
  await preserves(attached, exactPaths);
  for (const status of [403, 404, 503]) {
    f.setBranchRead(status);
    await preserves(attached, exactPaths);
  }

  const zero = '0'.repeat(40);
  assert.equal((await f.push(sha, zero)).linked, 1);
  const [deleted] = await f.links();
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.sourceSha, sha);
  f.setBranchRead(404);
  await preserves(deleted, exactPaths);
  f.setBranchRead(200);
  const recreated = await refresh();
  assert.deepEqual(recreated.failures, []);
  assert.equal(recreated.links.length, 1);
  const [active] = recreated.links;
  assert.equal(active.id, attached.id);
  assert.equal(active.manualLinkId, attached.manualLinkId);
  assert.equal(active.sourceSha, changedHead);
  assert.equal(active.state, 'active');
  assert.equal(active.branchObservationSource, 'read');
  assert.deepEqual(await f.links(), [active]);
  const unchanged = await refresh();
  assert.equal(unchanged.links.length, 1);
  assert.equal(unchanged.links[0].sourceSha, active.sourceSha);
  assert.equal(unchanged.links[0].manualLinkId, active.manualLinkId);
  assert.deepEqual(unchanged.failures, []);

  assert.equal((await f.push(sha, '3'.repeat(40))).linked, 0);
  const nextHead = '4'.repeat(40);
  const nextPush = await f.push(changedHead, nextHead);
  assert.equal(nextPush.linked, 1);
  assert.deepEqual(nextPush.runs, []);
  const [pushed] = await f.links();
  assert.equal(pushed.sourceSha, nextHead);
  assert.equal(pushed.branchObservationSource, undefined);
  assert.equal(pushed.manualLinkId, attached.manualLinkId);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(after.activities, before.activities);
});

test('a deferred exact branch refresh cannot replace a concurrent attachment, push or refresh', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const attached = await f.call<GitlabLink>(path, f.attach(f.branchUrl), 201);
  const refresh = () => f.request<GitlabIssueRefreshResult>(`${path}/refresh`, { method: 'POST', body: {} });
  async function duringBranchRead(change: () => Promise<GitlabLink>) {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    f.holdBranchRead(() => { enter(); return released; });
    const pending = refresh();
    try {
      await Promise.race([entered, pending.then(({ status }) => assert.fail(`Branch read did not reach GitLab (${status})`))]);
      f.holdBranchRead();
      const saved = await change();
      release();
      const stale = await pending;
      assert.equal(stale.status, 200);
      assert.deepEqual(await f.links(), [saved]);
      assert.deepEqual(stale.data.links, []);
      assert.deepEqual(stale.data.failures.map(failure => failure.linkId), [attached.id]);
      assert.match(stale.data.failures[0].message, /브랜치 상태가 변경/);
    } finally { f.holdBranchRead(); release(); }
  }

  const other = await f.call<Issue>('/issues', { method: 'POST', body: { projectId, title: 'Linked during refresh' } }, 201);
  const attachedHead = '9'.repeat(40);
  f.setBranchHead('8'.repeat(40));
  await duringBranchRead(async () => {
    f.setBranchHead(attachedHead);
    const alias = await f.call<GitlabLink>(pathFor(other.id), f.attach(f.branchUrl), 201);
    assert.equal(alias.sourceSha, attachedHead);
    return attached;
  });
  assert.equal((await f.links(other.id))[0]?.sourceSha, attachedHead);

  f.setBranchHead('2'.repeat(40));
  const pushedHead = '3'.repeat(40);
  await duringBranchRead(async () => {
    const update = await f.push(attachedHead, pushedHead);
    assert.equal(update.linked, 2);
    assert.deepEqual(update.runs, []);
    const [pushed] = await f.links();
    assert.equal(pushed.sourceSha, pushedHead);
    assert.equal(pushed.branchObservationSource, undefined);
    return pushed;
  });

  f.setBranchHead('4'.repeat(40));
  const newHead = '5'.repeat(40);
  await duringBranchRead(async () => {
    f.setBranchHead(newHead);
    const current = await refresh();
    assert.equal(current.status, 200);
    assert.deepEqual(current.data.failures, []);
    assert.equal(current.data.links.length, 1);
    const [newer] = current.data.links;
    assert.equal(newer.sourceSha, newHead);
    assert.equal(newer.branchObservationSource, 'read');
    return newer;
  });

  f.setBranchHead('6'.repeat(40));
  await duringBranchRead(async () => {
    f.setBranchHead(newHead);
    const confirmed = await refresh();
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.data.failures, []);
    assert.equal(confirmed.data.links.length, 1);
    const [sameHead] = confirmed.data.links;
    assert.equal(sameHead.sourceSha, newHead);
    return sameHead;
  });
});

test('ticket GitLab refresh limits exact branch and workflow reads to the 20 most recent links', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 23 }, (_, index) => pipelineId + index);
  for (const [index, id] of ids.entries()) {
    await f.webhook('pipeline', { id, ref: `feature/${f.issue.key}`, sha, status: 'running',
      url: f.pipelineUrl.replace(String(pipelineId), String(id)), updated_at: f.instant(index) });
  }
  const branch = await f.call<GitlabLink>(pathFor(f.issue.id), f.attach(f.branchUrl), 201);
  const before = await f.links();
  assert.equal(before.length, 24);
  f.calls.length = 0;
  const result = await f.call<GitlabIssueRefreshResult>(`${pathFor(f.issue.id)}/refresh`, { method: 'POST', body: {} });
  assert.equal(result.skipped, 4);
  assert.equal(result.links.length + result.failures.length, 20);
  assert.equal(result.links.find(link => link.id === branch.id)?.branchObservationSource, 'read');
  assert.equal(f.calls.filter(call => call.path === f.branchPath).length, 1);
  assert.deepEqual(f.calls.filter(call => call.path.startsWith(`${f.projectPath}/pipelines/`)).map(call => call.path).sort(),
    ids.slice(4).map(id => `${f.projectPath}/pipelines/${id}`).sort());
  assert.deepEqual((await f.links()).filter(link => link.kind !== 'branch'), before.filter(link => link.kind !== 'branch'));
});

test('manual GitLab links verify saved repositories and store one canonical record per ticket and object', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  assert.equal((await f.request(path, f.attach('https://unconfigured.example.test/team/product/-/merge_requests/17'))).status, 400);
  const forged = f.attach(f.mrUrl);
  await f.call(path, { ...forged, body: { ...forged.body, repositoryId: 999 } }, 403);
  assert.equal(f.calls.length, 0);

  await f.webhook('merge_request', { id: mrId, iid: mrIid, title: 'Authenticated update', state: 'merged', action: 'merge',
    source_branch: sourceBranch, sha, url: f.mrUrl, updated_at: f.instant() });
  await f.call(path, f.attach(f.mrUrl), 409);
  assert.deepEqual(await f.links(), []);
  f.calls.length = 0;
  f.setMr({ updated_at: f.instant(1) });

  const copied = `${f.mrUrl}?diff_id=12#note_30`;
  const mr = await f.call<GitlabLink>(path, f.attach(copied), 201);
  assert.equal(mr.kind, 'merge_request');
  assert.equal(mr.iid, mrIid);
  assert.equal(mr.title, 'Existing implementation review');
  assert.equal(mr.webUrl, f.mrUrl);
  assert.ok(isGitlabManualLinkId(mr.manualLinkId));
  assert.deepEqual(f.calls, [f.projectPath, `${f.projectPath}/merge_requests/${mrIid}`].map(path => ({ method: 'GET', path, credential: token })));
  assert.deepEqual(await f.call(path, f.attach(f.mrUrl)), mr);
  const pipeline = await f.call<GitlabLink>(path, f.attach(f.pipelineUrl), 201);
  assert.equal(pipeline.kind, 'pipeline');
  assert.equal(pipeline.webUrl, f.pipelineUrl);
  assert.ok(isGitlabManualLinkId(pipeline.manualLinkId));
  const other = await f.call<Issue>('/issues', { method: 'POST', body: { projectId, title: 'Other issue' } }, 201);
  await f.call(deletePath(other.id, mr), { method: 'DELETE' }, 404);
  await f.call(deletePath(f.issue.id, { ...mr, manualLinkId: randomUUID() }), { method: 'DELETE' }, 409);
  await f.call(deletePath(f.issue.id, mr), { method: 'DELETE' });
  assert.deepEqual(await f.links(), [pipeline]);
  const replacement = await f.call<GitlabLink>(path, f.attach(f.mrUrl), 201);
  assert.equal(replacement.id, mr.id);
  assert.notEqual(replacement.manualLinkId, mr.manualLinkId);
  await f.call(deletePath(f.issue.id, mr), { method: 'DELETE' }, 409);
  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(snapshot.issues.find(issue => issue.id === f.issue.id), f.issue);
  assert.equal(snapshot.activities.filter(event => event.action === 'GitLab 활동 수동 연결').length, 3);
  assert.equal(snapshot.activities.filter(event => event.action === 'GitLab 수동 연결 해제').length, 1);
});

test('keyless branch and commit attachments reuse canonical activity and follow authenticated pushes', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const branch = await f.call<GitlabLink>(path, f.attach(`${f.branchUrl.replace('%2F', '/')}?ref_type=heads#files`), 201);
  assert.deepEqual({ kind: branch.kind, ref: branch.sourceBranch, head: branch.sourceSha, state: branch.state, url: branch.webUrl },
    { kind: 'branch', ref: sourceBranch, head: sha, state: 'active', url: f.branchUrl });
  assert.equal(branch.branchObservationSource, 'sync');
  assert.ok(isGitlabManualLinkId(branch.manualLinkId));
  assert.deepEqual(f.calls.map(call => [call.method, call.path, call.credential]), [
    ['GET', f.projectPath, token], ['GET', `${f.projectPath}/repository/branches/${encodeURIComponent(sourceBranch)}`, token],
  ]);
  const commit = await f.call<GitlabLink>(path, f.attach(`${f.commitUrl}?ref_type=heads`), 201);
  assert.deepEqual({ kind: commit.kind, sha: commit.sourceSha, title: commit.title, url: commit.webUrl },
    { kind: 'commit', sha: commitSha, title: 'Existing repository changes', url: f.commitUrl });
  assert.ok(isGitlabManualLinkId(commit.manualLinkId));
  assert.deepEqual(await f.call(path, f.attach(f.commitUrl)), commit);
  assert.equal((await f.call<GitlabLink>(path, f.attach(f.branchUrl))).manualLinkId, branch.manualLinkId);

  const readHead = '2'.repeat(40);
  f.setBranchHead(readHead);
  await f.call('/integrations/gitlab/sync', { method: 'POST', body: { includeHistory: true } });
  let current = (await f.links()).find(link => link.id === branch.id)!;
  assert.equal(current.sourceSha, readHead);
  assert.equal(current.branchObservationSource, 'sync');
  assert.equal(current.manualLinkId, branch.manualLinkId);

  const nextHead = '3'.repeat(40);
  let started!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { proceed = resolve; });
  f.holdBranchRead(() => { started(); return resume; });
  const pending = f.request<GitlabLink>(path, f.attach(f.branchUrl));
  await Promise.race([waiting, pending.then(result => assert.fail(`Branch read did not reach the mock endpoint (${result.status})`))]);
  try { assert.deepEqual((await f.push(readHead, nextHead)).runs, []); }
  finally { proceed(); }
  const refreshed = await pending;
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.sourceSha, nextHead);
  assert.equal(refreshed.data.manualLinkId, branch.manualLinkId);
  assert.equal(refreshed.data.branchObservationSource, undefined);
  assert.equal((await f.push(sha, '4'.repeat(40))).linked, 0);
  assert.equal((await f.links()).find(link => link.id === branch.id)?.sourceSha, nextHead);

  f.setBranchHead('6'.repeat(40));
  const mismatch = await f.call<{ error: string }>(path, f.attach(f.branchUrl), 409);
  assert.match(mismatch.error, /푸시/);
  assert.equal((await f.links()).find(link => link.id === branch.id)?.sourceSha, nextHead);

  const deletedHead = '0'.repeat(40);
  await f.push(nextHead, deletedHead);
  await f.call('/integrations/gitlab/sync', { method: 'POST', body: { includeHistory: true } });
  current = (await f.links()).find(link => link.id === branch.id)!;
  assert.equal(current.state, 'deleted');
  assert.equal(current.sourceSha, nextHead);
  assert.equal(current.manualLinkId, branch.manualLinkId);
  assert.deepEqual((await f.links()).find(link => link.id === commit.id), commit);

  await f.push(deletedHead, commitSha, [{ id: commitSha, title: commit.title, message: commit.title, url: f.commitUrl }], `feature/${f.issue.key}`);
  const promoted = (await f.links()).find(link => link.id === commit.id)!;
  assert.equal(promoted.manualLinkId, undefined);
  assert.equal(promoted.sourceSha, commitSha);
  assert.equal(promoted.sourceBranch, `feature/${f.issue.key}`);
  await f.call(deletePath(f.issue.id, commit), { method: 'DELETE' }, 409);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.issues.find(issue => issue.id === f.issue.id), f.issue);
  await f.call(deletePath(f.issue.id, current), { method: 'DELETE' });
  assert.ok(!(await f.links()).some(link => link.id === branch.id));
});

test('manual branch and commit identities survive native and trash restore with a fresh unlink guard', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const original = await Promise.all([f.branchUrl, f.commitUrl].map(url => f.call<GitlabLink>(path, f.attach(url), 201)));
  const restore = (data: Backup, status = 200) => f.call<{ error?: string }>('/import', { method: 'POST', body: { data } }, status);
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.match((await restore({ ...backup, schemaVersion: 59 }, 400)).error!, /schemaVersion 60/);

  const wrongBranch = structuredClone(backup);
  const branch = wrongBranch.gitlabLinks.find(link => link.id === original[0].id)!;
  const [, instance, repository, kind, , issue] = branch.id.split(':');
  branch.id = `gitlab:${instance}:${repository}:${kind}:${'a'.repeat(64)}:${issue}`;
  await restore(wrongBranch, 400);
  const wrongCommit = structuredClone(backup);
  wrongCommit.gitlabLinks.find(link => link.id === original[1].id)!.sourceSha = 'f'.repeat(40);
  await restore(wrongCommit, 400);

  await restore(backup);
  const restored = await f.links();
  for (const saved of original) {
    const live = restored.find(link => link.id === saved.id)!;
    assert.deepEqual({ ...live, manualLinkId: saved.manualLinkId }, saved);
    assert.notEqual(live.manualLinkId, saved.manualLinkId);
    await f.call(deletePath(f.issue.id, saved), { method: 'DELETE' }, 409);
  }
  const issueVersion = (await f.call<WorkspaceSnapshot>('/workspace')).issues.find(item => item.id === f.issue.id)!.version;
  const trash = await f.call<{ trashEntryId: string }>(`/issues/${f.issue.id}`, { method: 'DELETE', body: { expectedVersion: issueVersion } });
  const archived = await f.call<Backup>('/export');
  assert.deepEqual(new Set(archived.trashEntries.find(entry => entry.id === trash.trashEntryId)?.gitlabLinks.map(link => link.id)),
    new Set(original.map(link => link.id)));
  assert.match((await restore({ ...archived, schemaVersion: 59 }, 400)).error!, /schemaVersion 60/);
  await restore(archived);
  await f.call(`/trash/${trash.trashEntryId}/restore`, { method: 'POST', body: {} });
  for (const saved of restored) {
    const recovered = (await f.links()).find(link => link.id === saved.id)!;
    assert.deepEqual({ ...recovered, manualLinkId: saved.manualLinkId }, saved);
    assert.notEqual(recovered.manualLinkId, saved.manualLinkId);
    await f.call(deletePath(f.issue.id, recovered), { method: 'DELETE' });
  }
  assert.deepEqual(await f.links(), []);
});

test('the first keyless branch attachment cannot save a HEAD displaced during verification', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const newHead = '5'.repeat(40);
  let started!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { proceed = resolve; });
  f.holdBranchRead(() => { started(); return resume; });
  const pending = f.request(path, f.attach(f.branchUrl));
  await Promise.race([waiting, pending.then(result => assert.fail(`Branch read did not reach the mock endpoint (${result.status})`))]);
  try { assert.equal((await f.push(sha, newHead)).linked, 0); }
  finally { proceed(); }
  assert.equal((await pending).status, 409);
  assert.deepEqual(await f.links(), []);

  f.setBranchHead(newHead);
  const link = await f.call<GitlabLink>(path, f.attach(f.branchUrl), 201);
  assert.equal(link.sourceSha, newHead);
  assert.equal(link.branchObservationSource, undefined);
  assert.ok(isGitlabManualLinkId(link.manualLinkId));
});

test('exact GitLab refresh preserves corrected manual state without granting implicit automation', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  const created = await f.call<AutomationRule>('/automation-rules', { method: 'POST', body: {
    projectId, name: 'Explicit key automation', trigger: 'merge_request.merged', branchPattern: 'feature/*', gitlabProjectIds: [repositoryId],
    issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: actor, priority: 10,
  } }, 201);
  await f.call(`/automation-rules/${created.id}`, { method: 'PATCH', body: { expectedVersion: created.version, enabled: true } });
  const original = await f.call<GitlabLink>(path, f.attach(f.mrUrl), 201);
  const hookFields = { id: mrId, iid: mrIid, source_branch: sourceBranch, sha, url: f.mrUrl };
  await f.webhook('merge_request', { ...hookFields, title: 'Merge completed', state: 'merged', action: 'merge', updated_at: f.instant(20) });
  const [merged] = await f.links();
  assert.equal(merged.state, 'merged');
  assert.equal(merged.manualLinkId, original.manualLinkId);
  const savedIssue = async () => (await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === f.issue.id);
  assert.equal((await savedIssue())?.status, 'todo');
  await f.webhook('pipeline', { id: pipelineId, ref: sourceBranch, sha, status: 'success', updated_at: f.instant(21), url: f.pipelineUrl });
  assert.deepEqual(await f.links(), [merged]);
  await f.webhook('merge_request', { ...hookFields, title: 'Older event', state: 'opened', action: 'open', updated_at: f.instant(10) });
  assert.deepEqual(await f.links(), [merged]);

  f.setMr({ title: 'New canonical read title', state: 'opened', updated_at: f.instant(30) });
  const read = await f.call<GitlabSyncResult>('/integrations/gitlab/sync', { method: 'POST', body: {} });
  assert.equal(read.linked, 1);
  const [synced] = await f.links();
  assert.equal(synced.title, 'New canonical read title');
  assert.equal(synced.manualLinkId, original.manualLinkId);
  await f.webhook('merge_request', { ...hookFields, title: `${f.issue.key} Explicit association`, state: 'merged', action: 'merge',
    updated_at: new Date().toISOString() });
  const [automatic] = await f.links();
  assert.equal(automatic.id, original.id);
  assert.equal(automatic.manualLinkId, undefined);
  assert.equal(automatic.state, 'merged');
  assert.equal((await savedIssue())?.status, 'done');
  await f.call(deletePath(f.issue.id, original), { method: 'DELETE' }, 409);
  assert.deepEqual(await f.links(), [automatic]);
});

test('manual MR readiness rechecks the same revision and discards a response held across a webhook', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  f.setMr({ detailed_merge_status: 'ci_still_running' });
  const original = await f.call<GitlabLink>(path, f.attach(f.mrUrl), 201);
  assert.equal(original.mergeReadiness?.state, 'ci_running');

  f.setMr({ detailed_merge_status: 'mergeable', title: 'No metadata advance on this read' });
  const ready = await f.call<GitlabLink>(path, f.attach(f.mrUrl));
  assert.equal(ready.mergeReadiness?.state, 'ready');
  assert.equal(ready.title, original.title);
  assert.equal(ready.updatedAt, original.updatedAt);
  assert.equal(ready.manualLinkId, original.manualLinkId);

  let started!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { proceed = resolve; });
  f.holdRead(() => { started(); return resume; });
  const pending = f.request<GitlabLink>(path, f.attach(f.mrUrl));
  await waiting;
  const actionedAt = new Date().toISOString();
  try {
    await f.webhook('merge_request', { id: mrId, iid: mrIid, state: 'opened', action: 'unapproved',
      source_branch: sourceBranch, sha, updated_at: f.instant(), actioned_at: actionedAt });
  } finally { proceed(); }
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.mergeReadiness, { state: 'unknown', source: 'webhook', observedAt: actionedAt });
  assert.deepEqual(await f.links(), [result.data]);

  f.setMr({ detailed_merge_status: 'not_approved' });
  const waitingForApproval = await f.call<GitlabLink>(path, f.attach(f.mrUrl));
  assert.equal(waitingForApproval.mergeReadiness?.state, 'approval_required');
  assert.equal(waitingForApproval.mergeReadiness?.source, 'read');
  assert.equal(waitingForApproval.updatedAt, actionedAt);
  assert.equal(waitingForApproval.manualLinkId, original.manualLinkId);
});

test('GitLab link verification discards changed settings and restores manual links with a new unlink guard', async t => {
  const f = await fixture(t);
  const path = pathFor(f.issue.id);
  let started!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { proceed = resolve; });
  f.holdRead(() => { started(); return resume; });
  const pending = f.request(path, f.attach(f.mrUrl));
  await waiting;
  let settings: GitlabSettings;
  try { settings = await f.configure(); }
  finally { proceed(); }
  assert.equal((await pending).status, 409);
  assert.deepEqual(await f.links(), []);
  const link = await f.call<GitlabLink>(path, f.attach(f.mrUrl, settings.version), 201);
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const restore = (data: Backup, status = 200) => f.call<{ error?: string }>('/import', { method: 'POST', body: { data } }, status);
  assert.match((await restore({ ...backup, schemaVersion: 51 }, 400)).error!, /schemaVersion 52/);
  const tampered = structuredClone(backup);
  tampered.gitlabLinks.find(value => value.id === link.id)!.webUrl = `${f.mrUrl}/unexpected`;
  await restore(tampered, 400);
  await restore(backup);
  const [restored] = await f.links();
  assert.deepEqual({ ...restored, manualLinkId: link.manualLinkId }, link);
  assert.notEqual(restored.manualLinkId, link.manualLinkId);
  await f.call(deletePath(f.issue.id, link), { method: 'DELETE' }, 409);
  await restore({ ...backup, schemaVersion: 52 });
  const [legacyRestored] = await f.links();
  assert.deepEqual({ ...legacyRestored, manualLinkId: link.manualLinkId }, link);
  assert.notEqual(legacyRestored.manualLinkId, restored.manualLinkId);

  const saved = (await f.call<WorkspaceSnapshot>('/workspace')).issues.find(value => value.id === f.issue.id)!;
  const trash = await f.call<{ trashEntryId: string }>(`/issues/${saved.id}`, { method: 'DELETE', body: { expectedVersion: saved.version } });
  const archived = await f.call<Backup>('/export');
  assert.deepEqual(archived.trashEntries.find(value => value.id === trash.trashEntryId)?.gitlabLinks, [legacyRestored]);
  assert.match((await restore({ ...archived, schemaVersion: 51 }, 400)).error!, /schemaVersion 52/);
  await restore(archived);
  await f.call(`/trash/${trash.trashEntryId}/restore`, { method: 'POST', body: {} });
  const [recovered] = await f.links();
  assert.equal(recovered.id, link.id);
  assert.notEqual(recovered.manualLinkId, legacyRestored.manualLinkId);
  await f.call(deletePath(f.issue.id, legacyRestored), { method: 'DELETE' }, 409);
  await f.call(deletePath(f.issue.id, recovered), { method: 'DELETE' });
});
