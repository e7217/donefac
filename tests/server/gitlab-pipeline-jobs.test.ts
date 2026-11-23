import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabLink, GitlabPipelineJobs, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const repositoryId = 42;
const pipelineId = 802;
const localIid = 19;
const projectId = 'project-neo';
const token = 'synthetic-gitlab-job-read-token';
const privateUpstream = 'synthetic-private-upstream-job-payload';
const sha = '1'.repeat(40);
const updatedAt = new Date(Date.now() - 60_000).toISOString();
const repositoryPath = `/forge/api/v4/projects/${repositoryId}`;
const pipelinePath = `${repositoryPath}/pipelines/${pipelineId}`;
const jobsPath = `${pipelinePath}/jobs`;
const route = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/pipeline-jobs`;

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type JobFixture = { id: number; name: string; stage: string; allow_failure: boolean; status: string; failure_reason: string | null;
  pipeline: { id: number; project_id: number; sha: string }; web_url: string };

async function fixture(t: TestContext) {
  const calls: { method?: string; url: URL; credential?: string | string[] }[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-pipeline-jobs-'));
  let baseUrl = '';
  let pipeline = { id: pipelineId, iid: localIid, project_id: repositoryId, status: 'running', sha, updated_at: updatedAt,
    ref: 'main', yaml_errors: null as string | null };
  let jobs: JobFixture[] = [];
  let jobsStatus = 200;
  let paginationHeaders = false;
  let holdJobs: (() => Promise<void>) | undefined;
  const repoUrl = () => `${baseUrl}/team/app`;
  const pipelineUrl = () => `${repoUrl()}/-/pipelines/${pipelineId}`;
  const jobUrl = (id: number) => `${repoUrl()}/-/jobs/${id}`;
  const job = (id: number, overrides: Partial<JobFixture> = {}): JobFixture => ({ id,
    name: `test-${id}`, stage: 'test', allow_failure: false, status: 'failed', failure_reason: 'script_failure',
    pipeline: { id: pipelineId, project_id: repositoryId, sha }, web_url: jobUrl(id), ...overrides });

  const mock = createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    calls.push({ method: incoming.method, url, credential: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === repositoryPath) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: repoUrl() }));
    } else if (url.pathname === pipelinePath) {
      response.end(JSON.stringify({ ...pipeline, web_url: pipelineUrl() }));
    } else if (url.pathname === jobsPath) {
      await holdJobs?.();
      if (response.destroyed) return;
      if (jobsStatus !== 200) {
        if (jobsStatus === 302) response.setHeader('Location', `${baseUrl}/private-redirect-target`);
        response.writeHead(jobsStatus).end(JSON.stringify({ message: `${privateUpstream} ${token}` }));
        return;
      }
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      const from = (page - 1) * perPage;
      if (paginationHeaders) {
        response.setHeader('X-Page', String(page));
        response.setHeader('X-Per-Page', String(perPage));
        response.setHeader('X-Next-Page', from + perPage < jobs.length ? String(page + 1) : '');
      }
      response.end(JSON.stringify(jobs.slice(from, from + perPage).map(row => ({ ...row,
        runner: { id: 9, ip_address: privateUpstream }, artifacts: [{ filename: privateUpstream }],
      }))));
    } else response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
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
  const configure = async (patch: Partial<Pick<GitlabSettings, 'baseUrl' | 'projectIds'>> & { token?: string }) =>
    call<GitlabSettings>('/integrations/gitlab', { method: 'PATCH', body: { expectedVersion: (await settings()).version, ...patch } });
  await configure({ baseUrl, projectIds: [repositoryId], token });
  const createIssue = (title: string) => call<Issue>('/issues', { method: 'POST', body: { projectId, title } }, 201);
  const issue = await createIssue('Select an existing build');
  const link = await call<GitlabLink>(`/issues/${issue.id}/gitlab-links`, { method: 'POST', body: {
    repositoryId, expectedSettingsVersion: (await settings()).version, url: pipelineUrl(),
  } }, 201);
  calls.length = 0;

  return { call, request, issue, link, createIssue, configure, baseUrl, calls, job, jobUrl,
    path: route(issue.id, link.id), snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    setPipeline(patch: Partial<typeof pipeline>) { pipeline = { ...pipeline, ...patch }; },
    setJobs(value: JobFixture[], withPagination = false) { jobs = value; paginationHeaders = withPagination; },
    setJobsStatus(status: number) { jobsStatus = status; }, setJobGate(gate?: () => Promise<void>) { holdJobs = gate; },
  };
}

test('looks up the connected pipeline by global ID and returns only live CI metadata without mutating saved activity', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  f.setPipeline({ status: 'failed', yaml_errors: `${privateUpstream} ${token}` });
  f.setJobs([
    f.job(812, { name: 'verify build' }),
    f.job(811, { name: 'approve deployment', stage: 'deploy', status: 'manual', allow_failure: true, failure_reason: null }),
    f.job(810, { name: `job ${token}`, stage: `stage ${token}` }),
  ]);
  const response = await f.request<GitlabPipelineJobs>(f.path);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  const { checkedAt, jobs, ...pipeline } = response.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(pipeline, { linkId: f.link.id, repositoryId, pipelineId, status: 'failed', configurationError: true, hasMore: false });
  assert.deepEqual(jobs.slice(0, 2), [
    { id: 812, name: 'verify build', stage: 'test', status: 'failed', allowFailure: false, failureReason: 'script_failure', webUrl: f.jobUrl(812) },
    { id: 811, name: 'approve deployment', stage: 'deploy', status: 'manual', allowFailure: true, failureReason: null, webUrl: f.jobUrl(811) },
  ]);
  assert.equal(jobs.length, 3);
  assert.ok(!JSON.stringify(response.data).includes(token));
  assert.ok(!JSON.stringify(response.data).includes(privateUpstream));
  assert.deepEqual(f.calls.map(call => call.url.pathname), [repositoryPath, pipelinePath, jobsPath, pipelinePath]);
  for (const call of f.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.credential, token);
  }
  const query = f.calls.find(call => call.url.pathname === jobsPath)!.url.searchParams;
  assert.deepEqual(query.getAll('scope[]'), ['failed', 'manual']);
  assert.equal(query.get('include_retried'), 'false');
  assert.equal(query.get('page'), '1');
  assert.equal(query.get('per_page'), '50');
  assert.deepEqual(await f.snapshot(), before);
});

test('reports the bounded ordered job list and fails closed on an ambiguous or out-of-scope result', async t => {
  const f = await fixture(t);
  const allJobs = Array.from({ length: 201 }, (_, index) => f.job(900 - index));
  f.setJobs(allJobs, true);
  const result = await f.call<GitlabPipelineJobs>(f.path);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.jobs.map(job => job.id), allJobs.slice(0, 200).map(job => job.id));
  assert.deepEqual(f.calls.filter(call => call.url.pathname === jobsPath).map(call => call.url.searchParams.get('page')), ['1', '2', '3', '4']);

  f.setJobs([f.job(812), f.job(812)]);
  await f.call(f.path, undefined, 502);
  f.setJobs([f.job(811, { pipeline: { id: pipelineId + 1, project_id: repositoryId, sha } })]);
  await f.call(f.path, undefined, 502);
  f.setJobs([f.job(810, { web_url: `${f.baseUrl}/unrelated/app/-/jobs/810` })]);
  await f.call(f.path, undefined, 502);

  const beforeMismatch = f.calls.length;
  f.setPipeline({ sha: '2'.repeat(40) });
  await f.call(f.path, undefined, 502);
  assert.ok(!f.calls.slice(beforeMismatch).some(call => call.url.pathname === jobsPath));
});

test('checks exact ticket and repository access before sending a GitLab read and suppresses upstream error bodies', async t => {
  const f = await fixture(t);
  const other = await f.createIssue('Unlinked ticket');
  await f.call(route(other.id, f.link.id), undefined, 404);
  await f.call(route(f.issue.id, 'missing-link'), undefined, 404);
  await f.call(`${f.path}?pipelineId=13`, undefined, 400);
  const key = await f.call<{ token: string }>('/api-keys', { method: 'POST', body: {
    name: 'Scoped read key', access: 'read', projectIds: [projectId], expiresAt: null,
  } }, 201);
  await f.call(`/v1${f.path}`, { headers: { Authorization: `Bearer ${key.token}` } }, 403);
  assert.equal(f.calls.length, 0);

  f.setJobsStatus(403);
  const denied = await f.call(f.path, undefined, 403);
  assert.ok(!JSON.stringify(denied).includes(privateUpstream));
  assert.ok(!JSON.stringify(denied).includes(token));
  f.setJobsStatus(429);
  const limited = await f.call(f.path, undefined, 429);
  assert.ok(!JSON.stringify(limited).includes(privateUpstream));
  f.setJobsStatus(302);
  await f.call(f.path, undefined, 502);
  assert.ok(f.calls.every(call => [repositoryPath, pipelinePath, jobsPath].includes(call.url.pathname)));

  const callsBefore = f.calls.length;
  await f.configure({ projectIds: [] });
  await f.call(f.path, undefined, 403);
  await f.configure({ baseUrl: `${f.baseUrl}/new-mount`, projectIds: [repositoryId], token });
  await f.call(f.path, undefined, 409);
  assert.equal(f.calls.length, callsBefore);
});

test('discards jobs when the live pipeline, saved credentials or link changed during the read', async t => {
  const f = await fixture(t);
  f.setJobs([f.job(812)]);
  async function whileReading(change: () => void | Promise<unknown>) {
    let arrived!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.setJobGate(() => { arrived(); return held; });
    const pending = f.request(f.path);
    try {
      await Promise.race([waiting, pending.then(response => assert.fail(`Jobs request ended early (${response.status})`))]);
      await change();
    } finally {
      release();
      f.setJobGate();
    }
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(!Object.hasOwn(result.data as object, 'jobs'));
  }
  await whileReading(() => f.setPipeline({ status: 'failed' }));
  await whileReading(() => f.configure({ token: 'rotated-synthetic-job-read-token' }));
  await whileReading(() => f.call(`/issues/${f.issue.id}/gitlab-links/${encodeURIComponent(f.link.id)}?expectedManualLinkId=${f.link.manualLinkId}`, { method: 'DELETE' }));
  await f.call(f.path, undefined, 404);
});
