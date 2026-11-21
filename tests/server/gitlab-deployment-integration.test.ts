import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabDeploymentPage, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';

const integrationPath = '/api/integrations/gitlab';
const baseUrl = 'https://git.example.test/gitlab';
const projectUrl = `${baseUrl}/team/repo`;
const repositoryId = 42;
const secret = 'synthetic-deployment-webhook';
const mergeSha = 'a'.repeat(40);
const squashSha = 'b'.repeat(40);
const branchSha = 'c'.repeat(40);
const timestamp = (offset = 0) => new Date(Date.UTC(2024, 1, 10, 8, 0, offset)).toISOString();

async function fixture(t: TestContext) {
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
  await json<GitlabSettings>(integrationPath, 'PATCH', { expectedVersion: settings.version, baseUrl, projectIds: [repositoryId], webhookSecret: secret });
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
