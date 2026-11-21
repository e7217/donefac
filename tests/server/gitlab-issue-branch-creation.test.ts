import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { GitlabIssueBranchResult, GitlabIssueBranchReview, GitlabSettings, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';

const repositoryId = 42;
const repositoryPath = 'team/product';
const gitlabProjectPath = `/lab/api/v4/projects/${repositoryId}`;
const savedReadToken = 'gitlab-fixture-read-token';
const writeToken = 'gitlab-fixture-one-shot-credential';
const webhookSecret = 'gitlab-fixture-push-secret';
const actorId = 'user-seo';
const peerId = 'user-min';
const sourceSha = 'c'.repeat(40);
const laterSha = 'e'.repeat(40);
const startingSha = 'b'.repeat(40);

type Call = { method: string; path: string; token: string | string[] | undefined; body?: unknown };
type Mode = 'normal' | 'create-then-disconnect' | 'disconnect-before-create';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-issue-branch-'));
  const remoteCalls: Call[] = [];
  const heads = new Map([['main', sourceSha], ['release/current', startingSha]]);
  let baseUrl = '';
  let mode: Mode = 'normal';
  let afterWrite: (() => Promise<void>) | undefined;
  const remote = createServer(async (request, response) => {
    const method = request.method ?? '';
    const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
    const token = request.headers['private-token'];
    const body = method === 'POST' ? JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString()) as { branch: string; ref: string } : undefined;
    remoteCalls.push({ method, path, token, body });
    const reply = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (method === 'GET' && token !== savedReadToken && token !== writeToken) return reply({ message: 'Unauthorized' }, 401);
    if (method === 'GET' && path === gitlabProjectPath) {
      return reply({ id: repositoryId, path_with_namespace: repositoryPath, web_url: `${baseUrl}/${repositoryPath}`, default_branch: 'main' });
    }
    const branches = `${gitlabProjectPath}/repository/branches`;
    if (method === 'GET' && path.startsWith(`${branches}/`)) {
      const name = decodeURIComponent(path.slice(branches.length + 1));
      const sha = heads.get(name);
      return sha ? reply({ name, commit: { id: sha } }) : reply({ message: 'Branch not found' }, 404);
    }
    const commits = `${gitlabProjectPath}/repository/commits/`;
    if (method === 'GET' && path.startsWith(commits) && [...heads.values()].includes(path.slice(commits.length))) {
      return reply({ id: path.slice(commits.length), project_id: repositoryId });
    }
    if (method === 'POST' && path === branches && body) {
      if (token !== writeToken) return reply({ message: 'Forbidden' }, 403);
      if (heads.has(body.branch)) return reply({ message: 'Branch already exists' }, 400);
      if (mode === 'disconnect-before-create') return response.destroy();
      heads.set(body.branch, body.ref);
      if (mode === 'create-then-disconnect') return response.destroy();
      await afterWrite?.();
      return reply({ name: body.branch, commit: { id: body.ref }, web_url: 'https://untrusted.example.test/ignored' }, 201);
    }
    return reply({ message: 'Not found' }, 404);
  });
  baseUrl = `${await listen(remote)}/lab`;
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function stop() {
    try { await close(service.server); }
    finally { service.runtime.close(); }
  }
  t.after(async () => {
    try { await Promise.all([stop(), close(remote)]); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T>(path: string, status = 200, options: { method?: string; body?: unknown; actor?: string; headers?: Record<string, string> } = {}) {
    const response = await fetch(service.api + path, { method: options.method ?? 'GET', headers: {
      'Content-Type': 'application/json', 'X-Actor-Id': options.actor ?? actorId, ...options.headers,
    }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const result = await response.json() as T;
    assert.equal(response.status, status, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(writeToken), false);
    return result;
  }
  const post = <T>(path: string, body: unknown, status = 200, actor = actorId) => call<T>(path, status, { method: 'POST', body, actor });
  async function configure() {
    const settings = await call<GitlabSettings>('/integrations/gitlab');
    return call<GitlabSettings>('/integrations/gitlab', 200, { method: 'PATCH', body: {
      expectedVersion: settings.version, baseUrl, projectIds: [repositoryId], token: savedReadToken, webhookSecret,
    } });
  }
  const settings = await configure();
  const issue = await post<Issue>('/issues', { projectId: 'project-neo', title: '브랜치 생성 검증용 업무' }, 201);
  const path = `/issues/${issue.id}/gitlab-branch`;
  const selection = (branch: string) => ({ expectedSettingsVersion: settings.version, repositoryId, branch });
  async function review(branch: string, ref?: string) {
    const result = await post<GitlabIssueBranchReview>(`${path}/preview`, { ...selection(branch), ...(ref === undefined ? {} : { ref }) });
    if (result.state !== 'ready') throw new Error(`Expected ready branch review, got ${result.state}`);
    return result;
  }
  return {
    issue, settings, dataDir, path, call, post, selection, review, heads, remoteCalls, baseUrl,
    setMode(value: Mode) { mode = value; },
    waitBeforeReply(gate: () => Promise<void>) { afterWrite = gate; },
    writes: () => remoteCalls.filter(call => call.method === 'POST'),
    async restart() { await stop(); service = await start(); },
  };
}

test('ticket branch creation pins the reviewed commit, uses only a supplied write token and tracks later GitLab pushes', async t => {
  const f = await fixture(t);
  const branch = `feature/${f.issue.key}`;
  const review = await f.review(branch);
  const canonicalUrl = `${f.baseUrl}/${repositoryPath}/-/tree/${encodeURIComponent(branch)}`;
  assert.deepEqual(review.target, { repositoryId, repositoryPath, branch, ref: 'main', sourceSha, webUrl: canonicalUrl });
  assert.ok(f.remoteCalls.length > 0 && f.remoteCalls.every(call => call.method === 'GET' && call.token === savedReadToken));
  await f.post(`${f.path}/apply`, { previewId: review.previewId }, 400);
  await f.post(`${f.path}/apply`, { previewId: review.previewId, writeToken }, 409, peerId);
  assert.deepEqual(f.writes(), []);

  f.heads.set('main', laterSha);
  const created = await f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: review.previewId, writeToken }, 201);
  assert.equal(created.state, 'created');
  assert.equal(created.link?.issueId, f.issue.id);
  assert.equal(created.link?.sourceSha, sourceSha);
  assert.equal(created.link?.webUrl, canonicalUrl);
  assert.equal(created.link?.kind, 'branch');
  const replay = await f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: review.previewId, writeToken });
  assert.equal(replay.state, 'found');
  assert.deepEqual(replay.link, created.link);
  assert.deepEqual(f.writes(), [{ method: 'POST', path: `${gitlabProjectPath}/repository/branches`, token: writeToken,
    body: { branch, ref: sourceSha } }]);
  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(snapshot.issues.find(issue => issue.id === f.issue.id)?.status, f.issue.status);
  assert.equal(snapshot.activities.filter(activity => activity.resourceId === f.issue.id && activity.action === 'GitLab 브랜치 연결').length, 1);
  for (const file of readdirSync(f.dataDir).filter(name => name.startsWith('teamspace.sqlite'))) {
    assert.equal(readFileSync(join(f.dataDir, file)).includes(writeToken), false);
  }

  await f.call('/integrations/gitlab/webhook', 200, { method: 'POST', headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() }, body: {
    object_kind: 'push', project_id: repositoryId, ref: `refs/heads/${branch}`, before: sourceSha, after: laterSha, commits: [],
    project: { id: repositoryId, web_url: `${f.baseUrl}/${repositoryPath}`, path_with_namespace: repositoryPath },
  } });
  const revised = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(revised.gitlabLinks.find(link => link.id === created.link?.id)?.sourceSha, laterSha);
});

test('ambiguous remote branch creation reconciles across restarts without another POST, including absent and divergent heads', async t => {
  const f = await fixture(t);
  const branch = `feature/${f.issue.key}-lost`;
  const review = await f.review(branch, 'release/current');
  assert.equal(review.target.sourceSha, startingSha);
  f.setMode('create-then-disconnect');
  assert.equal((await f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: review.previewId, writeToken })).state, 'pending');
  await f.restart();
  assert.equal((await f.post<GitlabIssueBranchReview>(`${f.path}/preview`, f.selection(branch))).state, 'pending');
  const found = await f.post<GitlabIssueBranchResult>(`${f.path}/reconcile`, f.selection(branch));
  assert.equal(found.state, 'found');
  assert.equal(found.link?.issueId, f.issue.id);
  assert.equal(found.link?.sourceSha, startingSha);
  assert.equal(f.writes().length, 1);

  const missing = `feature/${f.issue.key}-missing`;
  const unresolved = await f.review(missing, sourceSha);
  f.setMode('disconnect-before-create');
  assert.equal((await f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: unresolved.previewId, writeToken })).state, 'pending');
  await f.restart();
  assert.equal((await f.post<GitlabIssueBranchResult>(`${f.path}/reconcile`, f.selection(missing))).state, 'pending');
  assert.equal((await f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: unresolved.previewId, writeToken })).state, 'pending');
  f.heads.set(missing, laterSha);
  const conflict = await f.post<GitlabIssueBranchResult>(`${f.path}/reconcile`, f.selection(missing));
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.observedSha, laterSha);
  assert.equal(conflict.link, undefined);
  assert.equal(f.writes().length, 2);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).gitlabLinks.filter(link => link.issueId === f.issue.id), [found.link]);
});

test('already present branches, stale settings and invalid repository or ref never initiate a branch write', async t => {
  const f = await fixture(t);
  const branch = `feature/${f.issue.key}-existing`;
  f.heads.set(branch, sourceSha);
  assert.equal((await f.post<GitlabIssueBranchReview>(`${f.path}/preview`, f.selection(branch))).state, 'existing');
  await f.post(`${f.path}/preview`, { ...f.selection('one'), repositoryId: 999 }, 403);
  await f.post(`${f.path}/preview`, { ...f.selection('../..') }, 400);
  await f.post(`${f.path}/preview`, f.selection(sourceSha), 400);
  await f.post(`${f.path}/preview`, { ...f.selection('valid'), ref: '0000000000000000000000000000000000000000' }, 400);

  const clean = await f.review(`feature/${f.issue.key}-stale`);
  await f.call<GitlabSettings>('/integrations/gitlab', 200, { method: 'PATCH', body: {
    expectedVersion: f.settings.version, token: `${savedReadToken}-rotated`, baseUrl: f.baseUrl, projectIds: [repositoryId], webhookSecret,
  } });
  const stale = await f.post<{ details: { reason: string } }>(`${f.path}/apply`, { previewId: clean.previewId, writeToken }, 409);
  assert.equal(stale.details.reason, 'settings_changed');
  assert.equal(f.writes().length, 0);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).gitlabLinks.some(link => link.issueId === f.issue.id), false);
});

test('a verified remote creation is kept when the ticket moves and a teammate explicitly links it afterward', async t => {
  const f = await fixture(t);
  const destination = await f.post<Project>('/projects', { key: 'MOVE', name: '브랜치 검증 도착 프로젝트' }, 201);
  const branch = `feature/${f.issue.key}-moving`;
  const review = await f.review(branch);
  const committed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.waitBeforeReply(async () => { committed.resolve(); await resume.promise; });
  const apply = f.post<GitlabIssueBranchResult>(`${f.path}/apply`, { previewId: review.previewId, writeToken });
  try {
    await Promise.race([committed.promise, apply.then(result => assert.fail(`GitLab did not delay its response: ${result.state}`))]);
    const movePath = `/issues/${f.issue.id}/project-move`;
    const input = { expectedVersion: f.issue.version, projectId: destination.id, includeConnected: false, mappings: [] };
    const checked = await f.post<IssueProjectMovePreview>(`${movePath}/preview`, input);
    assert.ok(checked.token);
    const moved = await f.post<IssueProjectMoveResult>(`${movePath}/apply`, { ...input, token: checked.token });
    assert.equal(moved.issues[0].id, f.issue.id);
    assert.equal(moved.issues[0].projectId, destination.id);
    assert.notEqual(moved.issues[0].key, f.issue.key);
  } finally { resume.resolve(); }

  const pendingLink = await apply;
  assert.equal(pendingLink.state, 'link_needed');
  assert.equal(pendingLink.link, undefined);
  assert.equal(pendingLink.observedSha, sourceSha);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).gitlabLinks.some(link => link.issueId === f.issue.id), false);
  const found = await f.post<GitlabIssueBranchResult>(`${f.path}/reconcile`, f.selection(branch), 200, peerId);
  assert.equal(found.state, 'found');
  assert.equal(found.link?.issueId, f.issue.id);
  assert.equal(found.link?.sourceBranch, branch);
  assert.equal(f.writes().length, 1);
});
