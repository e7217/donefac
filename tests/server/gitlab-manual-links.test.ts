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
import type { AutomationRule, GitlabLink, GitlabSettings, GitlabSyncResult, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const actor = 'user-seo';
const repositoryId = 42;
const token = 'synthetic-gitlab-read';
const secret = 'synthetic-gitlab-events';
const sourceBranch = 'feature/existing-work';
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
  let branchHead = sha;
  const projectPath = `/gitlab/api/v4/projects/${repositoryId}`;
  const projectUrl = () => `${baseUrl}/team/subgroup/product`;
  const mrUrl = () => `${projectUrl()}/-/merge_requests/${mrIid}`;
  const pipelineUrl = () => `${projectUrl()}/-/pipelines/${pipelineId}`;
  const branchUrl = () => `${projectUrl()}/-/tree/${encodeURIComponent(sourceBranch)}`;
  const commitUrl = () => `${projectUrl()}/-/commit/${commitSha}`;
  let mr = { id: mrId, iid: mrIid, project_id: repositoryId, target_project_id: repositoryId,
    title: 'Existing implementation review', state: 'opened', source_branch: sourceBranch, sha, updated_at: instant(),
    detailed_merge_status: undefined as string | undefined };
  const mock = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ method: req.method, path, credential: req.headers['private-token'] });
    res.setHeader('Content-Type', 'application/json');
    const mergeRequest = { ...mr, web_url: mrUrl() };
    const pipeline = { id: pipelineId, iid: 12, project_id: repositoryId, ref: sourceBranch, sha,
      status: 'running', updated_at: instant(), web_url: pipelineUrl() };
    const branch = { name: sourceBranch, commit: { id: branchHead }, web_url: branchUrl() };
    const commitTitle = 'Existing repository changes';
    const commit = { id: commitSha, title: commitTitle, message: commitTitle, committed_date: instant(), web_url: commitUrl() };
    if (path === projectPath) res.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/subgroup/product', web_url: projectUrl() }));
    else if (path === `${projectPath}/merge_requests/${mrIid}`) {
      await objectGate?.();
      res.end(JSON.stringify(mergeRequest));
    } else if (path === `${projectPath}/pipelines/${pipelineId}`) res.end(JSON.stringify(pipeline));
    else if (path === `${projectPath}/merge_requests`) res.end(JSON.stringify([mergeRequest]));
    else if (path === `${projectPath}/pipelines`) res.end(JSON.stringify([pipeline]));
    else if (path === `${projectPath}/repository/branches/${encodeURIComponent(sourceBranch)}`) {
      await branchGate?.();
      res.end(JSON.stringify(branch));
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
  return { call, request, issue, attach, configure, links, webhook, push, instant, calls, projectPath, mrUrl: mrUrl(), pipelineUrl: pipelineUrl(),
    branchUrl: branchUrl(), commitUrl: commitUrl(), setBranchHead(value: string) { branchHead = value; },
    holdBranchRead(gate: () => Promise<void>) { branchGate = gate; },
    setMr(patch: Partial<typeof mr>) { mr = { ...mr, ...patch }; }, holdRead(gate: () => Promise<void>) { objectGate = gate; } };
}

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
