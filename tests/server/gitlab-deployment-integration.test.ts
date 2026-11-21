import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabDeploymentPage, GitlabDeploymentSyncResult, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';

const integrationPath = '/api/integrations/gitlab';
const baseUrl = 'https://git.example.test/gitlab';
const projectUrl = `${baseUrl}/team/repo`;
const repositoryId = 42;
const secret = 'synthetic-deployment-webhook';
const mergeSha = 'a'.repeat(40);
const squashSha = 'b'.repeat(40);
const branchSha = 'c'.repeat(40);
const timestamp = (offset = 0) => new Date(Date.UTC(2024, 1, 10, 8, 0, offset)).toISOString();

async function fixture(t: TestContext, connection: { baseUrl?: string; token?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-deployment-http-'));
  const application = createApp({ dataDir, seed: true, outboundWorker: false });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    application.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  function request(path: string, method = 'GET', value?: unknown, headers?: Record<string, string>) {
    return fetch(`${root}${path}`, { method, headers: { ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }
  async function json<T>(path: string, method = 'GET', value?: unknown, headers?: Record<string, string>, status = 200) {
    const response = await request(path, method, value, headers);
    const body = await response.text();
    assert.equal(response.status, status, body);
    return JSON.parse(body) as T;
  }
  const settings = await json<GitlabSettings>(integrationPath);
  await json<GitlabSettings>(integrationPath, 'PATCH', { expectedVersion: settings.version, baseUrl, projectIds: [repositoryId], webhookSecret: secret, ...connection });
  const send = (body: object, event = 'Deployment Hook', token = secret, deliveryId = randomUUID()) => request(`${integrationPath}/webhook`, 'POST', body,
    { 'X-Gitlab-Token': token, 'X-Gitlab-Event': event, 'X-Gitlab-Event-UUID': deliveryId });
  const deployments = (issueId: string) => json<GitlabDeploymentPage>(`/api/issues/${issueId}/gitlab-deployments`);
  return { request, json, send, deployments };
}

function deployment(id: number, sha: string, status: string, seconds: number, environment = 'production') {
  return { object_kind: 'deployment', status, status_changed_at: timestamp(seconds), deployment_id: id,
    deployable_id: id + 800, deployable_url: `${projectUrl}/-/jobs/${id + 800}`, environment, environment_tier: environment,
    environment_external_url: 'https://outside.invalid/not-a-job', project: { id: repositoryId, web_url: projectUrl, path_with_namespace: 'team/repo' },
    commit_url: `${projectUrl}/-/commit/${sha}`, short_sha: sha.slice(0, 8) };
}

function mergeRequest(issueKey: string, id = 101, target = repositoryId) {
  return { object_kind: 'merge_request', project: { id: repositoryId, web_url: projectUrl }, object_attributes: {
    id, iid: id - 100, target_project_id: target, title: `${issueKey} MR`, state: 'merged', action: 'merge', source_branch: `feature/${issueKey}`,
    sha: branchSha, merge_commit_sha: mergeSha, squash_commit_sha: squashSha, updated_at: timestamp(2), url: `${projectUrl}/-/merge_requests/${id - 100}`,
  } };
}

async function mockGitlab(t: TestContext, handler: (path: string, response: ServerResponse, projectUrl: string) => void) {
  const requests: { method?: string; path: string; token?: string }[] = [];
  const mock = createServer((request, response) => {
    const path = new URL(request.url ?? '/', root).pathname;
    requests.push({ method: request.method, path, token: request.headers['private-token'] as string | undefined });
    response.setHeader('Content-Type', 'application/json');
    if (path === `/gitlab/api/v4/projects/${repositoryId}`) {
      response.end(JSON.stringify({ id: repositoryId, web_url: remoteProject, path_with_namespace: 'team/repo' }));
    } else handler(path, response, remoteProject);
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const root = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/gitlab`;
  const remoteProject = `${root}/team/repo`;
  t.after(async () => {
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
  });
  return { root, remoteProject, requests };
}

test('authenticated deployment first, merge later, scoped ticket evidence, and native archival restore are consistent', async t => {
  const f = await fixture(t);
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const headers = { 'X-Actor-Id': user.id };
  const issue = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Verified rollout' }, headers, 201);
  const fork = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Unrelated fork' }, headers, 201);
  const repositoryPath = `${integrationPath}/deployments?repositoryId=${repositoryId}`;
  const production = { ...deployment(10, mergeSha, 'success', 5), commit_title: `${fork.key} text alone must not link a deployment` };
  assert.equal((await f.send(production, 'Deployment Hook', 'incorrect')).status, 401);
  assert.equal((await f.json<GitlabDeploymentPage>(repositoryPath)).total, 0);
  const deliveryId = randomUUID();
  const accepted = await f.send(production, 'Deployment Hook', secret, deliveryId);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, duplicate: false, linked: 0, runs: [], deploymentUpdated: true });
  const duplicate = await (await f.send(production, 'Deployment Hook', secret, deliveryId)).json() as { duplicate: boolean };
  assert.equal(duplicate.duplicate, true);
  assert.equal((await f.deployments(issue.id)).total, 0);
  assert.equal((await f.json<GitlabDeploymentPage>(repositoryPath)).total, 1);

  assert.equal((await f.send(mergeRequest(issue.key), 'Merge Request Hook')).status, 200);
  assert.equal((await f.send(mergeRequest(fork.key, 102, 99), 'Merge Request Hook')).status, 200);
  const { links: [mr] } = await f.json<{ links: GitlabLink[] }>(`/api/issues/${issue.id}/gitlab-links?kind=merge_request`);
  assert.deepEqual(mr.mergeCommitShas, [mergeSha, squashSha]);
  assert.equal((await f.deployments(fork.id)).total, 0);

  for (const payload of [deployment(10, mergeSha, 'running', 3), deployment(10, mergeSha, 'approved', 9),
    deployment(11, branchSha, 'failed', 6), deployment(12, squashSha, 'failed', 7, 'staging')]) {
    assert.equal((await f.send(payload)).status, 200);
  }
  const tracked = await f.deployments(issue.id);
  assert.deepEqual(tracked.items.map(item => [item.environment, item.status, item.sha]), [
    ['staging', 'failed', squashSha], ['production', 'success', mergeSha],
  ]);
  assert.deepEqual(await f.json<GitlabDeploymentPage>(`/api/issues/${issue.id}/gitlab-deployments?offset=2`), { total: 2, limit: 50, offset: 2, items: [] });
  assert.equal((await f.json<WorkspaceSnapshot>('/api/workspace')).issues.find(row => row.id === issue.id)?.status, issue.status);
  assert.equal((await f.request(`${repositoryPath}&unexpected=true`)).status, 400);
  assert.equal((await f.request(`${integrationPath}/deployments?repositoryId=99`)).status, 403);
  const receipts = await f.json<GitlabWebhookStatus>(`${integrationPath}/webhook-status`);
  assert.deepEqual(receipts.repositories[0].lastDelivery?.event, 'deployment');
  assert.equal(receipts.repositories[0].lastDelivery?.deploymentUpdated, true);

  const other = await f.json<Project>('/api/projects', 'POST', { key: 'OPS', name: 'Other scoped project' }, headers, 201);
  async function readKey(projectId: string) {
    const { token } = await f.json<{ token: string }>('/api/api-keys', 'POST', {
      name: `Deployments ${projectId}`, access: 'read', projectIds: [projectId], expiresAt: null,
    }, headers, 201);
    return { Authorization: `Bearer ${token}` };
  }
  const allowedKey = await readKey(project.id), deniedKey = await readKey(other.id);
  const apiIssuePath = `/api/v1/issues/${issue.id}/gitlab-deployments`;
  assert.deepEqual(await f.json<GitlabDeploymentPage>(apiIssuePath, 'GET', undefined, allowedKey), tracked);
  assert.equal((await f.request(apiIssuePath, 'GET', undefined, deniedKey)).status, 403);
  assert.equal((await f.request('/api/v1/integrations/gitlab/deployments?repositoryId=42', 'GET', undefined, allowedKey)).status, 403);

  const { trashEntryId } = await f.json<{ trashEntryId: string }>(`/api/issues/${issue.id}`, 'DELETE', undefined, headers);
  const archive = await f.json<{ schemaVersion: number; gitlabDeployments: GitlabDeploymentPage['items'] }>('/api/export');
  assert.ok(archive.schemaVersion >= 72);
  assert.equal(archive.gitlabDeployments.length, 3);
  const older = { ...archive, schemaVersion: 71 };
  await f.json('/api/import', 'POST', { data: older }, undefined, 400);
  const corrupt = { ...archive, gitlabDeployments: archive.gitlabDeployments.map((record, index) => index ? record : { ...record, sha: 'bad-sha' }) };
  await f.json('/api/import', 'POST', { data: corrupt }, undefined, 400);
  assert.equal((await f.json<GitlabDeploymentPage>(repositoryPath)).total, 3);
  await f.json('/api/import', 'POST', { data: archive });
  assert.equal((await f.request(`/api/issues/${issue.id}/gitlab-deployments`)).status, 404);
  await f.json(`/api/trash/${trashEntryId}/restore`, 'POST', undefined, headers);
  assert.deepEqual(await f.deployments(issue.id), tracked);
});

test('REST backfill links every confirmed batched merge request and preserves both old backups and partial proof', async t => {
  const artifactSha = 'd'.repeat(40);
  const readToken = 'synthetic-deployment-read';
  const listPath = `/gitlab/api/v4/projects/${repositoryId}/deployments`;
  let unavailable = false;
  const mkDeployment = (id: number, status: string) => ({ id, sha: artifactSha, status, updated_at: timestamp(id - 440),
    created_at: timestamp(), environment: { id: 7, name: 'production' }, deployable: null });
  const mr = (id: number, target = repositoryId) => ({ id, iid: id - 100, target_project_id: target, state: 'merged' });
  const remote = await mockGitlab(t, (path, response) => {
    if (path === listPath) return response.end(JSON.stringify([mkDeployment(453, 'created'), mkDeployment(452, 'success'), mkDeployment(451, 'success'), mkDeployment(450, 'failed')]));
    if (path === `${listPath}/451/merge_requests` && !unavailable) {
      return response.end(JSON.stringify([mr(101), mr(102)]));
    }
    response.writeHead(path === `${listPath}/451/merge_requests` ? 403 : 404).end('{}');
  });
  const f = await fixture(t, { baseUrl: remote.root, token: readToken });
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const headers = { 'X-Actor-Id': user.id };
  const issues = await Promise.all(['First included MR', 'Second included MR', 'Other MR'].map(title =>
    f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title }, headers, 201)));
  for (const [index, issue] of issues.entries()) {
    const event = mergeRequest(issue.key, 101 + index);
    event.project.web_url = remote.remoteProject;
    event.object_attributes.url = `${remote.remoteProject}/-/merge_requests/${event.object_attributes.iid}`;
    assert.equal((await f.send(event, 'Merge Request Hook')).status, 200);
  }
  const entries = () => f.json<GitlabDeploymentPage>(`${integrationPath}/deployments?repositoryId=${repositoryId}`);
  const before = await f.json<Record<string, unknown>>('/api/export');
  await f.json('/api/import', 'POST', { data: { ...before, schemaVersion: 73 } });
  const { version: settingsVersion } = await f.json<GitlabSettings>(integrationPath);
  const sync = (version = settingsVersion, repo = repositoryId) => f.json<GitlabDeploymentSyncResult>(`${integrationPath}/deployments/sync`, 'POST', { expectedVersion: version, repositoryId: repo }, headers);
  assert.deepEqual(await sync(), { repositoryId, settingsVersion, deploymentsRead: 4, deploymentsStored: 4, mergeRequestsStored: 2,
    associationUnavailable: 1, associationLimited: 0, deploymentLimitReached: false });
  assert.equal((await entries()).total, 4);
  assert.equal((await entries()).items[0].status, 'created');
  const first = await f.deployments(issues[0].id);
  assert.deepEqual(first.items.map(row => [row.deploymentId, row.source, row.sha]), [[451, 'sync', artifactSha]]);
  assert.deepEqual(first.items[0].mergeRequests, [mr(101), mr(102)].map(({ id, iid }) => ({ id, iid })));
  assert.deepEqual(await f.deployments(issues[1].id), first);
  assert.equal((await f.deployments(issues[2].id)).total, 0);
  assert.ok(remote.requests.every(request => request.method === 'GET' && request.token === readToken));
  assert.ok(!remote.requests.some(request => /\/(450|453)\/merge_requests$/.test(request.path)));
  unavailable = true;
  assert.deepEqual(await sync(), { repositoryId, settingsVersion, deploymentsRead: 4, deploymentsStored: 0, mergeRequestsStored: 0,
    associationUnavailable: 2, associationLimited: 0, deploymentLimitReached: false });
  assert.deepEqual(await f.deployments(issues[0].id), first);
  assert.equal((await f.request(`${integrationPath}/deployments/sync`, 'POST', { expectedVersion: settingsVersion, repositoryId: 99 }, headers)).status, 403);

  const saved = await f.json<{ schemaVersion: number }>('/api/export');
  assert.ok(saved.schemaVersion >= 74);
  const rejected = await f.json<{ error: string }>('/api/import', 'POST', { data: { ...saved, schemaVersion: 73 } }, headers, 400);
  assert.match(rejected.error, /schemaVersion 74/);
  await f.json('/api/import', 'POST', { data: saved }, headers);
  assert.deepEqual(await f.deployments(issues[0].id), first);
});

test('deployment sync discards old connection reads and protects a webhook received during sync', async t => {
  const listPath = `/gitlab/api/v4/projects/${repositoryId}/deployments`;
  const pending: ServerResponse[] = [];
  const remote = await mockGitlab(t, (path, response) => {
    if (path === listPath) pending.push(response);
    else response.writeHead(404).end('{}');
  });
  const f = await fixture(t, { baseUrl: remote.root });
  const version = async () => (await f.json<GitlabSettings>(integrationPath)).version;
  const run = (expectedVersion: number) => f.request(`${integrationPath}/deployments/sync`, 'POST', { repositoryId, expectedVersion });
  const finish = async (id: number) => {
    const until = Date.now() + 5_000;
    while (!pending.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const response = pending.shift();
    assert.ok(response, 'expected a captured GitLab deployments request');
    response.end(JSON.stringify([{ id, sha: mergeSha, status: 'success', updated_at: timestamp(12),
      created_at: timestamp(), environment: { name: 'production' }, deployable: null }]));
  };
  const observe = (id: number) => {
    const event = deployment(id, mergeSha, 'failed', 11);
    return f.send({ ...event, project: { ...event.project, web_url: remote.remoteProject },
      commit_url: `${remote.remoteProject}/-/commit/${mergeSha}`, deployable_url: null });
  };
  const initial = await version();
  const running = run(initial);
  const until = Date.now() + 5_000;
  while (!pending.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(pending.length);
  assert.equal((await run(initial)).status, 409);
  assert.equal((await observe(453)).status, 200);
  await finish(453);
  const succeeded = await running;
  assert.equal(succeeded.status, 200);
  assert.equal((await succeeded.json() as GitlabDeploymentSyncResult).deploymentsStored, 0);
  const current = await f.json<GitlabDeploymentPage>(`${integrationPath}/deployments?repositoryId=${repositoryId}`);
  assert.deepEqual(current.items.map(row => [row.deploymentId, row.status, row.source]), [[453, 'failed', undefined]]);

  const stale = run(initial);
  const wait = Date.now() + 5_000;
  while (!pending.length && Date.now() < wait) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(pending.length);
  await f.json<GitlabSettings>(integrationPath, 'PATCH', { expectedVersion: initial, token: 'changed-token' });
  await finish(454);
  assert.equal((await stale).status, 409);
  assert.deepEqual(await f.json<GitlabDeploymentPage>(`${integrationPath}/deployments?repositoryId=${repositoryId}`), current);
});
