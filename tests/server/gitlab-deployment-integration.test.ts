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
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { AutomationPreview, AutomationRule, AutomationRun, GitlabDeploymentPage, GitlabDeploymentPreviewResult, GitlabDeploymentReviewResult, GitlabDeploymentSyncResult, GitlabLink, GitlabSettings, GitlabWebhookStatus, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';

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

async function mockGitlab(t: TestContext, handler: (path: string, response: ServerResponse, projectUrl: string) => void, options: {
  extraRepositoryIds?: number[];
  projectFailure?: () => number | null;
} = {}) {
  const requests: { method?: string; path: string; token?: string }[] = [];
  const repositoryPaths = new Map([repositoryId, ...(options.extraRepositoryIds ?? [])].map(id => [`/gitlab/api/v4/projects/${id}`, id]));
  const mock = createServer((request, response) => {
    const path = new URL(request.url ?? '/', root).pathname;
    requests.push({ method: request.method, path, token: request.headers['private-token'] as string | undefined });
    response.setHeader('Content-Type', 'application/json');
    const id = repositoryPaths.get(path);
    if (id) {
      const status = options.projectFailure?.();
      if (status) response.writeHead(status).end(JSON.stringify({ message: 'private upstream project details' }));
      else response.end(JSON.stringify({ id, web_url: remoteProject, path_with_namespace: 'team/repo' }));
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

const deploymentPreviewPath = `${integrationPath}/deployments/preview`;
const deploymentListPath = (id: number) => `/gitlab/api/v4/projects/${id}/deployments`;

function previewDeployment(id: number, status = 'success') {
  return { id, sha: mergeSha, status, updated_at: timestamp(), environment: { name: 'synthetic internal production' }, deployable: null };
}

test('deployment preview distinguishes complete, empty, partial, and rejected reads without persisting GitLab state', async t => {
  const savedToken = 'synthetic-deployment-preview-token';
  const list = deploymentListPath(repositoryId);
  let mode: 'ok' | 'empty' | 'failed-only' | 'association-denied' | 'rate-limited' | 'limited' | 'deployment-denied' | 'list-rate-limited' | 'project-denied' = 'ok';
  const remote = await mockGitlab(t, (path, response) => {
    if (path === list) {
      if (mode === 'deployment-denied') return response.writeHead(403).end(JSON.stringify({ message: savedToken }));
      if (mode === 'list-rate-limited') return response.writeHead(429).end(JSON.stringify({ message: savedToken }));
      if (mode === 'limited') response.setHeader('X-Next-Page', '2');
      return response.end(JSON.stringify(mode === 'empty' ? [] : mode === 'failed-only' ? [previewDeployment(1, 'failed')]
        : [previewDeployment(2), previewDeployment(1, 'failed')]));
    }
    assert.equal(path, `${list}/2/merge_requests`);
    if (mode === 'association-denied' || mode === 'rate-limited') {
      return response.writeHead(mode === 'association-denied' ? 403 : 429).end(JSON.stringify({ message: savedToken }));
    }
    response.end(JSON.stringify([{ id: 102, iid: 2, state: 'merged', target_project_id: repositoryId, title: 'synthetic internal MR' }]));
  }, { projectFailure: () => mode === 'project-denied' ? 401 : null });
  const f = await fixture(t, { baseUrl: remote.root, token: savedToken });
  const { version: settingsVersion } = await f.json<GitlabSettings>(integrationPath);
  const input = { repositoryId, expectedVersion: settingsVersion };
  const statePaths = ['/api/workspace', integrationPath, `${integrationPath}/sync-status`, `${integrationPath}/deployments?repositoryId=${repositoryId}`, `${integrationPath}/webhook-status`];
  const snapshot = () => Promise.all(statePaths.map(path => f.json(path)));
  const before = await snapshot();

  const run = async <T = GitlabDeploymentPreviewResult>(status = 200): Promise<T> => {
    const response = await f.request(deploymentPreviewPath, 'POST', input);
    const body = await response.text();
    assert.equal(response.status, status, body);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const privateValue of [savedToken, remote.root, 'synthetic internal', 'private upstream']) assert.ok(!body.includes(privateValue));
    return JSON.parse(body) as T;
  };
  const complete = { repositoryId, settingsVersion, status: 'ok', deploymentsRead: 2, successfulDeployments: 1,
    mergeRequestsRead: 1, deploymentLimitReached: false, associationUnavailable: 0, associationLimited: 0,
    associationDenied: 0, associationRateLimited: 0 };
  assert.deepEqual(await run(), complete);
  mode = 'empty';
  assert.deepEqual(await run(), { ...complete, status: 'empty', deploymentsRead: 0, successfulDeployments: 0, mergeRequestsRead: 0 });
  mode = 'failed-only';
  assert.deepEqual(await run(), { ...complete, deploymentsRead: 1, successfulDeployments: 0, mergeRequestsRead: 0 });
  mode = 'association-denied';
  assert.deepEqual(await run(), { ...complete, status: 'partial', mergeRequestsRead: 0, associationUnavailable: 1, associationDenied: 1 });
  mode = 'rate-limited';
  assert.deepEqual(await run(), { ...complete, status: 'partial', mergeRequestsRead: 0, associationUnavailable: 1, associationRateLimited: 1 });
  mode = 'limited';
  assert.deepEqual(await run(), { ...complete, status: 'partial', deploymentLimitReached: true });
  mode = 'deployment-denied';
  assert.deepEqual((await run<{ details: unknown }>(502)).details, {
    stage: 'deployments', httpStatus: 403, reason: '배포 조회 중 GitLab HTTP 403 응답',
  });
  mode = 'list-rate-limited';
  assert.deepEqual((await run<{ details: unknown }>(502)).details, {
    stage: 'deployments', httpStatus: 429, reason: '배포 조회 중 GitLab HTTP 429 응답',
  });
  mode = 'project-denied';
  assert.deepEqual((await run<{ details: unknown }>(502)).details, {
    stage: 'project', httpStatus: 401, reason: '저장소 조회 중 GitLab HTTP 401 응답',
  });
  assert.ok(remote.requests.every(request => request.method === 'GET' && request.token === savedToken));
  assert.equal(remote.requests.filter(request => request.path.endsWith('/merge_requests')).length, 4);
  assert.deepEqual(await snapshot(), before);
});

test('deployment preview uses an unsaved repository at the drafted address and discards results after a connection change', async t => {
  const savedToken = 'synthetic-saved-preview-credential', draftToken = 'synthetic-draft-preview-credential';
  const draftRepository = 43;
  const pending: ServerResponse[] = [];
  const saved = await mockGitlab(t, (path, response) => {
    assert.equal(path, deploymentListPath(repositoryId));
    pending.push(response);
  });
  const draft = await mockGitlab(t, (path, response) => {
    assert.equal(path, deploymentListPath(draftRepository));
    response.end('[]');
  }, { extraRepositoryIds: [draftRepository] });
  const f = await fixture(t, { baseUrl: saved.root, token: savedToken });
  const settings = await f.json<GitlabSettings>(integrationPath);
  const storedInput = { repositoryId, expectedVersion: settings.version };
  const draftInput = { repositoryId: draftRepository, expectedVersion: settings.version, baseUrl: draft.root, projectIds: [draftRepository] };

  for (const [body, status] of [
    [{ ...storedInput, repositoryId: draftRepository }, 403],
    [{ ...draftInput, projectIds: [repositoryId] }, 403],
    [{ ...storedInput, baseUrl: draft.root }, 400],
    [{ ...storedInput, projectIds: [repositoryId] }, 400],
    [{ ...storedInput, unexpected: 'x' }, 400],
    [{ ...storedInput, repositoryId: String(repositoryId) }, 400],
    [{ ...storedInput, expectedVersion: settings.version + 1 }, 409],
  ] as const) {
    assert.equal((await f.request(deploymentPreviewPath, 'POST', body)).status, status);
  }
  assert.equal((await f.request(`${deploymentPreviewPath}?repositoryId=42`, 'POST', storedInput)).status, 400);
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const { token: apiKey } = await f.json<{ token: string }>('/api/api-keys', 'POST', {
    name: 'Scoped key for deployment preview guard', access: 'write', projectIds: [project.id], expiresAt: null,
  }, { 'X-Actor-Id': user.id }, 201);
  const keyHeader = { Authorization: `Bearer ${apiKey}` };
  assert.equal((await f.request(deploymentPreviewPath.replace('/api/', '/api/v1/'), 'POST', storedInput, keyHeader)).status, 403);
  assert.equal(saved.requests.length, 0);
  assert.equal(draft.requests.length, 0);

  assert.equal((await f.json<GitlabDeploymentPreviewResult>(deploymentPreviewPath, 'POST', draftInput)).status, 'empty');
  assert.equal((await f.json<GitlabDeploymentPreviewResult>(deploymentPreviewPath, 'POST', { ...draftInput, token: draftToken })).status, 'empty');
  assert.deepEqual(draft.requests.map(row => [row.method, row.token]), [['GET', undefined], ['GET', undefined], ['GET', draftToken], ['GET', draftToken]]);
  assert.deepEqual(await f.json(integrationPath), settings);

  let expectedVersion = settings.version;
  for (const upstreamStatus of [200, 403]) {
    const response = f.request(deploymentPreviewPath, 'POST', { repositoryId, expectedVersion });
    const until = Date.now() + 5_000;
    while (!pending.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const captured = pending.shift();
    assert.ok(captured, 'expected a pending GitLab deployment list');
    const nextToken = `${savedToken}-${upstreamStatus}`;
    const updated = await f.json<GitlabSettings>(integrationPath, 'PATCH', { expectedVersion, token: nextToken });
    expectedVersion = updated.version;
    captured.writeHead(upstreamStatus).end('[]');
    const result = await response;
    assert.equal(result.status, 409);
    assert.equal((await result.json() as { details: { currentVersion: number } }).details.currentVersion, expectedVersion);
  }
  assert.deepEqual(saved.requests.map(row => [row.method, row.token]), [['GET', savedToken], ['GET', savedToken], ['GET', `${savedToken}-200`], ['GET', `${savedToken}-200`]]);
  assert.equal((await f.json<GitlabDeploymentPage>(`${integrationPath}/deployments?repositoryId=${repositoryId}`)).total, 0);
});

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
  const failedStaging = 'environment=stag&status=failed';
  const staging = { ...tracked, total: 1, items: [tracked.items[0]] };
  assert.deepEqual(await f.json<GitlabDeploymentPage>(`${repositoryPath}&${failedStaging}`), staging);
  for (const filters of ['status=unknown', 'status=success&status=failed', 'environment=production%0A', 'environment=a&environment=b']) {
    assert.equal((await f.request(`${repositoryPath}&${filters}`)).status, 400);
  }
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
  assert.deepEqual(await f.json<GitlabDeploymentPage>(`${apiIssuePath}?${failedStaging}`, 'GET', undefined, allowedKey), staging);
  assert.equal((await f.request(`${apiIssuePath}?${failedStaging}`, 'GET', undefined, deniedKey)).status, 403);
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

test('live deployment rules require exact environment and established SHA proof, preserve audit on restore and apply once', async t => {
  const f = await fixture(t);
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const headers = { 'X-Actor-Id': user.id };
  const [ticket, unverified] = await Promise.all(['Released feature', 'Unverified deployment text'].map(title =>
    f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title }, headers, 201)));
  assert.equal((await f.send(mergeRequest(ticket.key), 'Merge Request Hook')).status, 200);
  const otherMerge = mergeRequest(unverified.key, 102);
  otherMerge.object_attributes.sha = mergeSha;
  otherMerge.object_attributes.merge_commit_sha = 'd'.repeat(40);
  otherMerge.object_attributes.squash_commit_sha = 'e'.repeat(40);
  assert.equal((await f.send(otherMerge, 'Merge Request Hook')).status, 200);

  const environment = 'production/eu';
  const ruleDraft = { projectId: project.id, name: 'Mark production rollout', enabled: true, trigger: 'deployment.succeeded',
    gitlabProjectIds: [repositoryId], environment, issueTypes: [], fromStatuses: [ticket.status], toStatusId: 'done', actorId: user.id };
  const rulePath = '/api/automation-rules';
  await f.json(rulePath, 'POST', { ...ruleDraft, environment: ` ${environment}` }, headers, 400);
  const rule = await f.json<AutomationRule>(rulePath, 'POST', ruleDraft, headers, 201);
  assert.equal(rule.environment, environment);
  const preview = (name: string) => f.json<AutomationPreview>('/api/automation/preview', 'POST', {
    rule: ruleDraft, issueIds: [ticket.id], sample: { trigger: rule.trigger, gitlabProjectId: repositoryId, environment: name },
  }, headers);
  assert.equal((await preview('Production/eu')).outcomes[0].outcome, 'ignored');
  assert.equal((await preview(environment)).outcomes[0].outcome, 'changed');
  const getIssue = async (issue: Issue) => {
    const current = (await f.json<WorkspaceSnapshot>('/api/workspace')).issues.find(row => row.id === issue.id);
    assert.ok(current);
    return current;
  };
  const runsPath = `/api/automation-runs?projectId=${project.id}`;
  assert.equal((await getIssue(ticket)).status, ticket.status);
  assert.deepEqual(await f.json(runsPath), []);

  function live(id: number, name = environment, status = 'success') {
    return { ...deployment(id, mergeSha, status, 5, name), environment_tier: 'production',
      status_changed_at: new Date().toISOString(), commit_title: `Text alone ${unverified.key}` };
  }
  assert.equal((await f.send(deployment(300, mergeSha, 'success', 5, environment))).status, 200);
  assert.equal((await f.send(live(301, 'Production/eu'))).status, 200);
  assert.equal((await f.send(live(302, environment, 'running'))).status, 200);
  assert.equal((await f.send(live(303), 'Deployment Hook', 'wrong-token')).status, 401);
  assert.equal((await getIssue(ticket)).status, ticket.status);

  const eventId = randomUUID();
  const success = live(303);
  const first = await f.send(success, 'Deployment Hook', secret, eventId);
  assert.equal(first.status, 200);
  const { runs: [run] } = await first.json() as { runs: AutomationRun[] };
  assert.equal(run?.outcome, 'changed');
  assert.equal(run.ruleId, rule.id);
  assert.equal(run.issueId, ticket.id);
  assert.deepEqual(run.context && [run.context.trigger, run.context.objectKind, run.context.objectId, run.context.environment, run.context.branch],
    ['deployment.succeeded', 'deployment', '303', environment, '']);
  assert.equal((await getIssue(ticket)).status, 'done');
  assert.equal((await getIssue(ticket)).version, ticket.version + 1);
  assert.equal((await getIssue(unverified)).status, unverified.status);
  const replay = await (await f.send(success, 'Deployment Hook', secret, eventId)).json() as { duplicate: boolean };
  assert.equal(replay.duplicate, true);
  assert.equal((await f.send(live(303))).status, 200);
  assert.equal((await f.json<AutomationRun[]>(runsPath)).filter(row => row.outcome === 'changed').length, 1);

  const laterLinkedSha = 'f'.repeat(40);
  const noProof = { ...deployment(304, laterLinkedSha, 'success', 5, environment), status_changed_at: new Date().toISOString() };
  const { runs: initialRuns } = await (await f.send(noProof)).json() as { runs: AutomationRun[] };
  assert.deepEqual(initialRuns, []);
  const addedProof = mergeRequest(unverified.key, 103);
  addedProof.object_attributes.merge_commit_sha = laterLinkedSha;
  assert.equal((await f.send(addedProof, 'Merge Request Hook')).status, 200);
  const { runs: laterRuns } = await (await f.send({ ...noProof, status_changed_at: new Date().toISOString() })).json() as { runs: AutomationRun[] };
  assert.deepEqual(laterRuns, []);
  const outOfOrder = { ...noProof, deployment_id: 305 };
  const { runs: staleRuns } = await (await f.send(outOfOrder)).json() as { runs: AutomationRun[] };
  assert.deepEqual(staleRuns, []);
  assert.equal((await getIssue(unverified)).status, unverified.status);

  const archived = await f.json<{ schemaVersion: number; automationRules: AutomationRule[]; automationRuns: AutomationRun[] }>('/api/export');
  assert.equal(archived.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  await f.json('/api/import', 'POST', { data: { ...archived, schemaVersion: 74 } }, headers, 400);
  await f.json('/api/import', 'POST', { data: archived }, headers);
  const restored = (await f.json<AutomationRule[]>(`${rulePath}?projectId=${project.id}`)).find(row => row.id === rule.id);
  assert.deepEqual(restored && [restored.environment, restored.enabled, restored.enabledAt], [environment, false, null]);
  const restoredRun = (await f.json<AutomationRun[]>(runsPath)).find(row => row.id === run.id);
  assert.deepEqual(restoredRun?.context, run.context);
});

test('exact deployment status review verifies membership before reading and fences manual status changes', async t => {
  const id = 471;
  const environment = 'production/eu';
  const readToken = 'synthetic-exact-deployment-read';
  const list = deploymentListPath(repositoryId);
  let finish = '';
  let latestUnavailable = false;
  let holdExactRead: ((reply: () => void) => void) | undefined;
  const exact = () => ({ id, sha: mergeSha, status: 'success', updated_at: finish,
    environment: { name: environment }, deployable: { id: id + 800, status: 'success', finished_at: finish } });
  const remote = await mockGitlab(t, (path, response) => {
    if (path === `${list}/${id}`) {
      const reply = () => response.end(JSON.stringify(exact()));
      if (holdExactRead) holdExactRead(reply);
      else reply();
    } else if (path === list) response.end(JSON.stringify(latestUnavailable ? [] : [exact()]));
    else if (path === `${list}/${id}/merge_requests`) response.writeHead(403).end('{}');
    else response.writeHead(404).end('{}');
  });
  const f = await fixture(t, { baseUrl: remote.root, token: readToken });
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const headers = { 'X-Actor-Id': user.id };
  const issue = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Review production rollout', description: 'Deployment checklist' }, headers, 201);
  const unrelated = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Unrelated work' }, headers, 201);
  const issuePath = `/api/issues/${issue.id}`;
  const rulePath = '/api/automation-rules';
  const runsPath = `/api/automation-runs?projectId=${project.id}`;
  const mr = mergeRequest(issue.key);
  mr.project.web_url = remote.remoteProject;
  mr.object_attributes.url = `${remote.remoteProject}/-/merge_requests/1`;
  assert.equal((await f.send(mr, 'Merge Request Hook')).status, 200);
  function hooked(deploymentId: number, sha: string, status: string, changedAt: string) {
    const body = deployment(deploymentId, sha, status, 0, environment);
    return { ...body, status_changed_at: changedAt, environment_tier: 'production',
      project: { ...body.project, web_url: remote.remoteProject },
      commit_url: `${remote.remoteProject}/-/commit/${sha}`, deployable_url: `${remote.remoteProject}/-/jobs/${body.deployable_id}` };
  }
  assert.equal((await f.send(hooked(id, mergeSha, 'running', timestamp()))).status, 200);
  const { items: [selected] } = await f.deployments(issue.id);
  assert.equal(selected?.deploymentId, id);
  const path = (issueId: string, instance = selected.instance, repo = repositoryId, deploymentId = id) =>
    `/api/issues/${issueId}/gitlab-deployments/${instance}/${repo}/${deploymentId}/status-review`;
  for (const [url, value, expected] of [
    [path(unrelated.id), {}, 404], [path(issue.id, '0'.repeat(12)), {}, 403], [path(issue.id, selected.instance, 43), {}, 403],
    [path(issue.id, selected.instance, repositoryId, id + 1), {}, 404], [path(issue.id), { issueId: unrelated.id }, 400],
    [`${path(issue.id)}?x=1`, {}, 400],
  ] as const) {
    const rejected = await f.request(url, 'POST', value, headers);
    assert.equal(rejected.status, expected);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
  }
  const { token: apiKey } = await f.json<{ token: string }>('/api/api-keys', 'POST', {
    name: 'Exact deployment review route guard', access: 'write', projectIds: [project.id], expiresAt: null,
  }, headers, 201);
  assert.equal((await f.request(path(issue.id).replace('/api/', '/api/v1/'), 'POST', {}, { Authorization: `Bearer ${apiKey}` })).status, 403);
  assert.equal(remote.requests.length, 0);

  await f.json<AutomationRule>(rulePath, 'POST', { projectId: project.id, name: 'Production rollout rule', enabled: true,
    trigger: 'deployment.succeeded', gitlabProjectIds: [repositoryId], environment, issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    actorId: user.id }, headers, 201);
  finish = new Date().toISOString();
  const review = () => f.json<GitlabDeploymentReviewResult>(path(issue.id), 'POST', {}, headers);
  const workspace = () => f.json<WorkspaceSnapshot>('/api/workspace');
  const before = await workspace();
  const first = await review();
  assert.equal(first.state, 'ready');
  assert.equal(first.deployment.status, 'success');
  assert.equal(first.statusReview?.kind, 'suggestion');
  assert.ok(first.statusReview.kind === 'suggestion');
  const { suggestion } = first.statusReview;
  assert.equal(suggestion.evidence.trigger, 'deployment.succeeded');
  assert.equal(suggestion.evidence.occurredAt, finish);
  assert.ok(suggestion.evidence.trigger === 'deployment.succeeded');
  assert.deepEqual(suggestion.evidence.deployment, first.deployment);
  const after = await workspace();
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(after.activities, before.activities);
  assert.deepEqual(await f.json(runsPath), []);
  assert.equal((await f.deployments(issue.id)).items[0].status, 'success');

  const change = (token: string, status: number, expectedVersion = issue.version) => f.json<Issue>(issuePath, 'PATCH', {
    expectedVersion, status: 'done', gitlabStatusSuggestionToken: token,
  }, headers, status);
  latestUnavailable = true;
  assert.equal((await review()).state, 'latest-unverified');
  await change(suggestion.token, 409);
  latestUnavailable = false;
  const next = await review();
  assert.ok(next.statusReview?.kind === 'suggestion');
  const competingAt = new Date().toISOString();
  assert.ok(competingAt > finish);
  assert.equal((await f.send(hooked(id + 1, branchSha, 'success', competingAt))).status, 200);
  await change(next.statusReview.suggestion.token, 409);
  assert.equal((await review()).state, 'superseded');

  finish = new Date().toISOString();
  assert.ok(finish > competingAt);
  let respond!: () => void;
  const pendingRead = new Promise<void>(resolve => { holdExactRead = reply => { respond = reply; resolve(); }; });
  const pendingReview = f.request(path(issue.id), 'POST', {}, headers);
  await Promise.race([pendingRead, pendingReview.then(result => assert.fail(`Deployment read did not reach mock (${result.status})`))]);
  const updated = await f.json<Issue>(issuePath, 'PATCH', { expectedVersion: issue.version, title: 'Review production after a concurrent edit' }, headers);
  holdExactRead = undefined;
  respond();
  assert.equal((await pendingReview).status, 409);
  assert.equal((await f.deployments(issue.id)).items[0].changedAt, first.deployment.changedAt);

  const current = await review();
  assert.ok(current.statusReview?.kind === 'suggestion');
  const applied = await change(current.statusReview.suggestion.token, 200, updated.version);
  assert.equal(applied.status, 'done');
  assert.equal(applied.version, updated.version + 1);
  assert.deepEqual(await f.json(runsPath), []);
  assert.ok(remote.requests.every(request => request.method === 'GET' && request.token === readToken));
});

test('legacy pipeline links remain visible but require exact ticket evidence for deployment rules and review', async t => {
  const pipelineId = 481;
  const deploymentId = 482;
  const environment = 'production/reconfirmed';
  const list = deploymentListPath(repositoryId);
  let finishedAt = '';
  const exact = () => ({
    id: deploymentId, sha: branchSha, status: 'success', updated_at: finishedAt,
    environment: { name: environment }, deployable: { id: deploymentId + 800, status: 'success', finished_at: finishedAt },
  });
  const remote = await mockGitlab(t, (path, response) => {
    if (path === list) response.end(JSON.stringify([exact()]));
    else if (path === `${list}/${deploymentId}`) response.end(JSON.stringify(exact()));
    else if (path === `${list}/${deploymentId}/merge_requests`) response.end('[]');
    else response.writeHead(404).end('{}');
  });
  const f = await fixture(t, { baseUrl: remote.root, token: 'synthetic-pipeline-deployment-proof' });
  const workspace = () => f.json<WorkspaceSnapshot>('/api/workspace');
  const { projects: [project], users: [user] } = await workspace();
  const headers = { 'X-Actor-Id': user.id };
  const issue = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Confirm a legacy release pipeline' }, headers, 201);
  const issuePath = `/api/issues/${issue.id}`;
  const issueLinks = () => f.json<{ links: GitlabLink[] }>(`${issuePath}/gitlab-links?kind=pipeline`);
  const currentStatus = async () => (await workspace()).issues.find(row => row.id === issue.id)?.status;
  const pipeline = (key: string, at: string) => ({
    object_kind: 'pipeline', project: { id: repositoryId, web_url: remote.remoteProject, path_with_namespace: 'team/repo' },
    object_attributes: { id: pipelineId, project_id: repositoryId, ref: 'feature/release-shared', sha: branchSha,
      status: 'success', tag: false, source: 'push', finished_at: at, url: `${remote.remoteProject}/-/pipelines/${pipelineId}` },
    commit: { id: branchSha, message: key ? `${key} deployment evidence` : 'No ticket key in this event' },
  });
  const sendPipeline = async (key: string, at = new Date().toISOString()) => {
    const response = await f.send(pipeline(key, at), 'Pipeline Hook');
    assert.equal(response.status, 200);
    return response.json() as Promise<{ linked: number; runs: AutomationRun[] }>;
  };
  assert.equal((await sendPipeline(issue.key, timestamp())).linked, 1);
  const [current] = (await issueLinks()).links;
  assert.equal(current.pipelineTicketEvidence, 'direct-key');

  const backup = await f.json<{ schemaVersion: number; gitlabLinks: GitlabLink[] }>('/api/export');
  const historical = structuredClone(backup);
  historical.schemaVersion = 121;
  const oldPipeline = historical.gitlabLinks.find(link => link.id === current.id)!;
  delete oldPipeline.pipelineTicketEvidence;
  await f.json('/api/import', 'POST', { data: historical }, headers);
  assert.deepEqual((await issueLinks()).links, [oldPipeline]);

  await f.json('/api/automation-rules', 'POST', { projectId: project.id, name: 'Confirmed production deployment', enabled: true,
    trigger: 'deployment.succeeded', gitlabProjectIds: [repositoryId], environment, issueTypes: [], fromStatuses: [issue.status],
    toStatusId: 'done', actorId: user.id }, headers, 201);
  const delivery = (id: number, at: string) => {
    const body = deployment(id, branchSha, 'success', 0, environment);
    return { ...body, status_changed_at: at, environment_tier: 'production',
      project: { ...body.project, web_url: remote.remoteProject },
      commit_url: `${remote.remoteProject}/-/commit/${branchSha}`, deployable_url: `${remote.remoteProject}/-/jobs/${body.deployable_id}` };
  };
  const sendDeployment = async (body: ReturnType<typeof delivery>) => {
    const response = await f.send(body);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ runs: AutomationRun[]; deploymentUpdated?: boolean }>;
  };
  await sendPipeline('');
  assert.equal((await issueLinks()).links[0].pipelineTicketEvidence, undefined);
  finishedAt = new Date().toISOString();
  const originalDelivery = delivery(deploymentId, finishedAt);
  assert.deepEqual(await sendDeployment(originalDelivery), { ok: true, duplicate: false, linked: 0, runs: [], deploymentUpdated: true });
  assert.equal(await currentStatus(), issue.status);
  const { items: [selected] } = await f.deployments(issue.id);
  assert.equal(selected.deploymentId, deploymentId);
  const reviewPath = `${issuePath}/gitlab-deployments/${selected.instance}/${repositoryId}/${deploymentId}/status-review`;
  const review = () => f.json<GitlabDeploymentReviewResult>(reviewPath, 'POST', {}, headers);
  const unverified = await review();
  assert.equal(unverified.state, 'link-unverified');
  assert.equal(unverified.statusReview, undefined);

  assert.equal((await sendPipeline(issue.key)).linked, 1);
  const [reproved] = (await issueLinks()).links;
  assert.equal(reproved.id, current.id);
  assert.equal(reproved.pipelineTicketEvidence, 'direct-key');
  const ready = await review();
  assert.equal(ready.state, 'ready');
  assert.ok(ready.statusReview?.kind === 'suggestion');
  assert.equal(ready.statusReview.suggestion.evidence.link.id, current.id);
  assert.deepEqual((await sendDeployment(originalDelivery)).runs, []);
  assert.equal(await currentStatus(), issue.status);
  const next = await sendDeployment(delivery(deploymentId + 1, new Date().toISOString()));
  assert.deepEqual(next.runs.map(run => [run.issueId, run.outcome]), [[issue.id, 'changed']]);
  assert.equal(await currentStatus(), 'done');
});

test('an association-only deployment review requires the exact current included MR ID and IID', async t => {
  const id = 475;
  const sha = 'd'.repeat(40);
  const list = deploymentListPath(repositoryId);
  let finish = '';
  let associated: unknown = [{ id: 101, iid: 1, state: 'merged', target_project_id: repositoryId }];
  const exact = () => ({ id, sha, status: 'success', updated_at: finish,
    environment: { name: 'production' }, deployable: { id: 20, status: 'success', finished_at: finish } });
  const remote = await mockGitlab(t, (path, response) => {
    if (path === list) response.end(JSON.stringify([exact()]));
    else if (path === `${list}/${id}`) response.end(JSON.stringify(exact()));
    else if (path === `${list}/${id}/merge_requests` && associated) response.end(JSON.stringify(associated));
    else response.writeHead(403).end('{}');
  });
  const f = await fixture(t, { baseUrl: remote.root, token: 'synthetic-exact-association-token' });
  const { projects: [project], users: [user] } = await f.json<WorkspaceSnapshot>('/api/workspace');
  const headers = { 'X-Actor-Id': user.id };
  const issue = await f.json<Issue>('/api/issues', 'POST', { projectId: project.id, title: 'Review an included merge request' }, headers, 201);
  const mr = mergeRequest(issue.key);
  mr.project.web_url = remote.remoteProject;
  mr.object_attributes.url = `${remote.remoteProject}/-/merge_requests/1`;
  assert.equal((await f.send(mr, 'Merge Request Hook')).status, 200);
  await f.json<AutomationRule>('/api/automation-rules', 'POST', { projectId: project.id, name: 'Production rollout rule', enabled: true,
    trigger: 'deployment.succeeded', gitlabProjectIds: [repositoryId], environment: 'production', issueTypes: [], fromStatuses: [issue.status],
    toStatusId: 'done', actorId: user.id }, headers, 201);
  finish = new Date().toISOString();
  const { version: expectedVersion } = await f.json<GitlabSettings>(integrationPath);
  await f.json<GitlabDeploymentSyncResult>(`${integrationPath}/deployments/sync`, 'POST', { repositoryId, expectedVersion }, headers);
  const { items: [selected] } = await f.deployments(issue.id);
  assert.deepEqual(selected?.mergeRequests, [{ id: 101, iid: 1 }]);
  const issuePath = `/api/issues/${issue.id}`;
  const path = `${issuePath}/gitlab-deployments/${selected.instance}/${repositoryId}/${id}/status-review`;
  const review = () => f.json<GitlabDeploymentReviewResult>(path, 'POST', {}, headers);

  const ready = await review();
  assert.ok(ready.statusReview?.kind === 'suggestion');
  assert.equal(ready.statusReview.suggestion.evidence.link.iid, 1);
  associated = [{ id: 101, iid: 2, state: 'merged', target_project_id: repositoryId }];
  assert.equal((await review()).state, 'link-unverified');
  await f.json(issuePath, 'PATCH', { expectedVersion: issue.version, status: 'done', gitlabStatusSuggestionToken: ready.statusReview.suggestion.token }, headers, 409);
  associated = null;
  assert.equal((await review()).state, 'link-unverified');
  assert.deepEqual((await f.deployments(issue.id)).items[0].mergeRequests, [{ id: 101, iid: 1 }]);
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
