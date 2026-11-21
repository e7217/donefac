import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabDeploymentSyncResult, GitlabSettings, GitlabSyncResult, GitlabSyncStatus, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const integration = '/api/integrations/gitlab';
const statusPath = `${integration}/sync-status`;
const activityPath = `${integration}/sync`;
const deploymentPath = `${integration}/deployments/sync`;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-sync-status-'));
  async function start() {
    const app = createApp({ dataDir, outboundWorker: false });
    const listener = app.app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    return {
      url: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`,
      async close() {
        listener.closeAllConnections();
        await new Promise<void>(resolve => listener.close(() => resolve()));
        app.close();
      },
    };
  }
  let app = await start();
  t.after(async () => {
    try { await app.close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T>(path: string, method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(`${app.url}${path}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return { data: JSON.parse(text) as T, headers: response.headers, text };
  }
  return {
    call,
    async read() {
      const result = await call<GitlabSyncStatus>(statusPath);
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
      return result.data;
    },
    snapshot: async () => (await call<WorkspaceSnapshot>('/api/workspace')).data,
    async restart() { await app.close(); app = await start(); },
    persisted() {
      const database = new DatabaseSync(join(dataDir, 'teamspace.sqlite'), { readOnly: true });
      try { return JSON.stringify(database.prepare('SELECT json FROM gitlab_manual_sync_status').all()); }
      finally { database.close(); }
    },
  };
}

async function remoteGitlab(t: TestContext) {
  const token = `synthetic-read-token-${randomUUID()}`;
  const privateBody = `redact-upstream-${randomUUID()}`;
  const failures = new Map([['77:pipelines', 403], ['99:repository/commits', 503]]);
  const calls: { repositoryId: number; stage: string; method?: string; token?: string }[] = [];
  const at = new Date(Date.now() - 10_000).toISOString();
  let issueKey = '';
  const remote = createServer((request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname;
    const match = /^\/gitlab\/api\/v4\/projects\/(\d+)(?:\/(.+))?$/.exec(path);
    if (!match) return response.writeHead(404).end();
    const repositoryId = Number(match[1]);
    const stage = match[2] || 'project';
    const projectUrl = `${origin}/gitlab/team/repo-${repositoryId}`;
    const credential = request.headers['private-token'];
    calls.push({ repositoryId, stage, method: request.method, token: typeof credential === 'string' ? credential : undefined });
    response.setHeader('Content-Type', 'application/json');
    const failure = failures.get(`${repositoryId}:${stage}`);
    if (failure) {
      response.statusCode = failure;
      return response.end(JSON.stringify({ error: `${privateBody} ${token}`, href: `${projectUrl}?token=${token}` }));
    }
    if (stage === 'project') return response.end(JSON.stringify({ id: repositoryId, web_url: projectUrl, path_with_namespace: `team/repo-${repositoryId}` }));
    if (stage === 'merge_requests') return response.end(JSON.stringify([{
      id: repositoryId * 100, iid: 1, title: `${issueKey} 저장소 연결`, state: 'opened', source_branch: `feature/${issueKey}`,
      target_project_id: repositoryId, updated_at: at, web_url: `${projectUrl}/-/merge_requests/1`,
    }]));
    response.end('[]');
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  t.after(async () => {
    remote.closeAllConnections();
    await new Promise<void>(resolve => remote.close(() => resolve()));
  });
  return { token, privateBody, url: `${origin}/gitlab`, failures, calls, setIssue: (key: string) => { issueKey = key; } };
}

const emptyRows = [42, 77, 99].map(repositoryId => ({ repositoryId, activity: null, deployments: null }));

test('durable GitLab status restores independently completed activity and deployment attempts and fences old retries', async t => {
  const remote = await remoteGitlab(t);
  const f = await fixture(t);
  const { projects: [project] } = await f.snapshot();
  const { data: issue } = await f.call<Issue>('/api/issues', 'POST', { title: '합성 GitLab 동기화 진단 업무', projectId: project.id }, 201);
  remote.setIssue(issue.key);
  const { data: initial } = await f.call<GitlabSettings>(integration);
  const { data: settings } = await f.call<GitlabSettings>(integration, 'PATCH', {
    expectedVersion: initial.version, baseUrl: remote.url, projectIds: [42, 77, 99], token: remote.token,
  });
  const expectedVersion = settings.version;
  const pull = (body: object, status = 200) => f.call<GitlabSyncResult>(activityPath, 'POST', { expectedVersion, ...body }, status);
  const deploy = (repositoryId: number, status = 200) => f.call<GitlabDeploymentSyncResult>(deploymentPath, 'POST', { expectedVersion, repositoryId }, status);
  const read = async () => {
    const before = remote.calls.length;
    const received = await f.read();
    assert.equal(remote.calls.length, before);
    for (const secret of [remote.token, remote.privateBody]) assert.ok(!JSON.stringify(received).includes(secret));
    return received;
  };
  const touched = () => remote.calls.map(({ repositoryId, stage }) => [repositoryId, stage]);
  assert.deepEqual(await read(), { settingsVersion: expectedVersion, repositories: emptyRows });
  assert.equal(remote.calls.length, 0);

  const { data: synced } = await pull({ includeHistory: true });
  assert.equal(synced.partial, true);
  assert.equal(synced.linked, 1);
  const activity = await read();
  const [first, second, third] = activity.repositories;
  assert.ok(first.activity && second.activity && third.activity);
  assert.deepEqual([first.activity.result.status, second.activity.result.status, third.activity.result.status], ['ok', 'error', 'error']);
  assert.deepEqual(first.activity.result, synced.repositories[0]);
  assert.equal(first.activity.includeHistory, true);
  assert.equal(first.activity.lastSuccessfulAt, first.activity.completedAt);
  assert.ok(Number.isFinite(Date.parse(first.activity.completedAt)));
  assert.equal(second.activity.lastSuccessfulAt, null);
  assert.equal(second.activity.result.error?.stage, 'pipelines');
  assert.equal(second.activity.result.error?.httpStatus, 403);
  assert.equal(third.activity.result.error?.stage, 'commits');
  assert.equal(third.activity.result.error?.httpStatus, 503);

  remote.calls.length = 0;
  const failedAgain = await pull({ repositoryIds: [77] }, 502);
  assert.ok(!failedAgain.text.includes(remote.privateBody) && !failedAgain.text.includes(remote.token));
  assert.deepEqual(touched(), [[77, 'merge_requests'], [77, 'pipelines']]);
  const mixed = await read();
  assert.deepEqual(mixed.repositories[0], first);
  assert.deepEqual(mixed.repositories[2], third);
  assert.equal(mixed.repositories[1].activity?.includeHistory, false);
  assert.equal(mixed.repositories[1].activity?.result.status, 'error');
  assert.equal(mixed.repositories[1].activity?.lastSuccessfulAt, null);

  const { data: deploymentResult } = await deploy(42);
  assert.equal(deploymentResult.deploymentsRead, 0);
  assert.equal(deploymentResult.deploymentsStored, 0);
  const deployed = (await read()).repositories[0];
  assert.deepEqual(deployed.activity, first.activity);
  assert.equal(deployed.deployments?.status, 'ok');
  assert.deepEqual(deployed.deployments?.result, {
    repositoryId: 42, deploymentsRead: 0, deploymentsStored: 0, mergeRequestsStored: 0,
    associationUnavailable: 0, associationLimited: 0, deploymentLimitReached: false,
  });
  assert.equal(deployed.deployments?.lastSuccessfulAt, deployed.deployments?.completedAt);
  remote.failures.set('42:deployments', 403);
  const failedDeployment = await deploy(42, 502);
  assert.ok(!failedDeployment.text.includes(remote.privateBody) && !failedDeployment.text.includes(remote.token));
  const persisted = await read();
  const badDeployment = persisted.repositories[0].deployments;
  assert.ok(badDeployment && deployed.deployments);
  assert.deepEqual(persisted.repositories[0].activity, first.activity);
  assert.equal(badDeployment.status, 'error');
  assert.equal(badDeployment.lastSuccessfulAt, deployed.deployments.lastSuccessfulAt);
  assert.ok(Date.parse(badDeployment.completedAt) >= Date.parse(deployed.deployments.completedAt));
  assert.equal(badDeployment.result, null);
  assert.equal(badDeployment.error?.stage, 'deployments');
  assert.equal(badDeployment.error?.httpStatus, 403);
  assert.deepEqual(persisted.repositories.slice(1), mixed.repositories.slice(1));
  assert.ok(remote.calls.every(call => call.method === 'GET' && call.token === remote.token));
  const requestCount = remote.calls.length;
  await f.restart();
  assert.deepEqual(await read(), persisted);
  assert.equal(remote.calls.length, requestCount);
  assert.ok(!f.persisted().includes(remote.token) && !f.persisted().includes(remote.privateBody));

  remote.calls.length = 0;
  remote.failures.delete('77:pipelines');
  assert.equal((await pull({ repositoryIds: [77] })).data.linked, 1);
  assert.deepEqual(touched(), [[77, 'merge_requests'], [77, 'pipelines']]);
  const recovered = await read();
  assert.deepEqual(recovered.repositories[0], persisted.repositories[0]);
  assert.deepEqual(recovered.repositories[2], persisted.repositories[2]);
  assert.equal(recovered.repositories[1].activity?.result.status, 'ok');
  assert.equal(recovered.repositories[1].activity?.includeHistory, false);
  const afterActivity = await f.snapshot();
  assert.deepEqual(afterActivity.gitlabLinks.filter(link => link.issueId === issue.id).map(link => link.projectId).sort(), [42, 77]);
  assert.deepEqual(afterActivity.issues.find(row => row.id === issue.id), issue);
  assert.ok(!JSON.stringify(afterActivity).includes(remote.privateBody));

  remote.calls.length = 0;
  const { data: sameCredential } = await f.call<GitlabSettings>(integration, 'PATCH', { expectedVersion, token: remote.token });
  assert.notEqual(sameCredential.version, expectedVersion);
  assert.deepEqual(await read(), { ...recovered, settingsVersion: sameCredential.version });
  await pull({ repositoryIds: [99], includeHistory: true }, 409);
  await deploy(42, 409);
  assert.equal(remote.calls.length, 0);

  const { data: rotated } = await f.call<GitlabSettings>(integration, 'PATCH', { expectedVersion: sameCredential.version, token: `${remote.token}-rotated` });
  assert.deepEqual(await read(), { settingsVersion: rotated.version, repositories: emptyRows });
  assert.equal(remote.calls.length, 0);
  assert.deepEqual((await f.snapshot()).gitlabLinks, afterActivity.gitlabLinks);

  await f.call<GitlabSyncResult>(activityPath, 'POST', { expectedVersion: rotated.version, repositoryIds: [42] });
  assert.equal((await read()).repositories[0].activity?.result.status, 'ok');
  const { text: backupText, data: backup } = await f.call<unknown>('/api/export');
  assert.ok(!backupText.includes(remote.token) && !backupText.includes(remote.privateBody));
  await f.call('/api/import', 'POST', { data: backup });
  assert.deepEqual((await read()).repositories, emptyRows);
  assert.deepEqual((await f.snapshot()).gitlabLinks, afterActivity.gitlabLinks);
});
