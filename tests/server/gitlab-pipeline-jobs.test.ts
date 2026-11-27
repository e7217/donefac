import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabLink, GitlabPipelineFailedTests, GitlabPipelineJobs, GitlabPipelineTestReport, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

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
const triggerJobsPath = `${pipelinePath}/trigger_jobs`;
const bridgesPath = `${pipelinePath}/bridges`;
const testReportPath = `${pipelinePath}/test_report_summary`;
const failedReportPath = `${pipelinePath}/test_report`;
const route = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/pipeline-jobs`;
const reportRoute = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/pipeline-test-report`;
const failedTestsRoute = (issueId: string, linkId: string) => `/issues/${encodeURIComponent(issueId)}/gitlab-links/${encodeURIComponent(linkId)}/pipeline-failed-tests`;

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type FailedReportPage = { body: unknown; status?: number; headers?: Record<string, string> };
type JobFixture = { id: number; name: string; stage: string; allow_failure: boolean; status: string; failure_reason: string | null;
  pipeline: { id: number; project_id: number; sha: string }; web_url: string };

async function fixture(t: TestContext) {
  const calls: { method?: string; url: URL; credential?: string | string[] }[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-gitlab-pipeline-jobs-'));
  let baseUrl = '';
  let pipeline = { id: pipelineId, iid: localIid, project_id: repositoryId, status: 'running', sha, updated_at: updatedAt,
    ref: 'main', yaml_errors: null as string | null };
  let jobs: JobFixture[] = [];
  let jobsStatus = 200;
  let paginationHeaders = false;
  let holdJobs: (() => Promise<void>) | undefined;
  let triggerJobs: unknown = [];
  let triggerJobsStatus = 200;
  let bridgeJobs: unknown = [];
  let bridgeJobsStatus = 404;
  let holdTriggers: (() => Promise<void>) | undefined;
  let testReport: unknown;
  let testReportStatus = 200;
  let holdTestReport: (() => Promise<void>) | undefined;
  let failedReportPages: FailedReportPage[] = [];
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
    } else if (url.pathname === testReportPath) {
      await holdTestReport?.();
      if (response.destroyed) return;
      if (testReportStatus === 302) response.setHeader('Location', `${baseUrl}/private-redirect-target`);
      response.writeHead(testReportStatus).end(JSON.stringify(testReportStatus === 200 ? testReport : { message: `${privateUpstream} ${token}` }));
    } else if (url.pathname === failedReportPath) {
      await holdTestReport?.();
      if (response.destroyed) return;
      const page = failedReportPages[Number(url.searchParams.get('page')) - 1];
      if (!page) { response.writeHead(404).end('{}'); return; }
      response.writeHead(page.status ?? 200, page.headers).end(JSON.stringify(page.body));
    } else if (url.pathname === triggerJobsPath || url.pathname === bridgesPath) {
      await holdTriggers?.();
      if (response.destroyed) return;
      const modern = url.pathname === triggerJobsPath;
      const status = modern ? triggerJobsStatus : bridgeJobsStatus;
      const rows = modern ? triggerJobs : bridgeJobs;
      if (status === 0) {
        response.destroy();
      } else if (status !== 200) {
        response.writeHead(status).end(JSON.stringify({ message: `${privateUpstream} ${token}` }));
      } else if (!Array.isArray(rows)) {
        response.end(JSON.stringify(rows));
      } else {
        const page = Number(url.searchParams.get('page'));
        const perPage = Number(url.searchParams.get('per_page'));
        const from = (page - 1) * perPage;
        response.setHeader('X-Next-Page', from + perPage < rows.length ? String(page + 1) : '');
        response.end(JSON.stringify(rows.slice(from, from + perPage)));
      }
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
    path: route(issue.id, link.id), reportPath: reportRoute(issue.id, link.id), snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    failedTestsPath: failedTestsRoute(issue.id, link.id),
    setPipeline(patch: Partial<typeof pipeline>) { pipeline = { ...pipeline, ...patch }; },
    setJobs(value: JobFixture[], withPagination = false) { jobs = value; paginationHeaders = withPagination; },
    setJobsStatus(status: number) { jobsStatus = status; }, setJobGate(gate?: () => Promise<void>) { holdJobs = gate; },
    setTriggerJobs(value: unknown, status = 200) { triggerJobs = value; triggerJobsStatus = status; },
    setBridgeJobs(value: unknown, status = 200) { bridgeJobs = value; bridgeJobsStatus = status; },
    setTriggerGate(gate?: () => Promise<void>) { holdTriggers = gate; },
    setTestReport(value: unknown, status = 200) { testReport = value; testReportStatus = status; },
    setTestReportGate(gate?: () => Promise<void>) { holdTestReport = gate; },
    setFailedReportPages(...pages: FailedReportPage[]) { failedReportPages = pages; },
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
  assert.deepEqual(pipeline, { linkId: f.link.id, repositoryId, pipelineId, status: 'failed', configurationError: true, hasMore: false,
    triggerJobs: { jobs: [], hasMore: false } });
  assert.deepEqual(jobs.slice(0, 2), [
    { id: 812, name: 'verify build', stage: 'test', status: 'failed', allowFailure: false, failureReason: 'script_failure', webUrl: f.jobUrl(812) },
    { id: 811, name: 'approve deployment', stage: 'deploy', status: 'manual', allowFailure: true, failureReason: null, webUrl: f.jobUrl(811) },
  ]);
  assert.equal(jobs.length, 3);
  assert.ok(!JSON.stringify(response.data).includes(token));
  assert.ok(!JSON.stringify(response.data).includes(privateUpstream));
  const paths = f.calls.map(call => call.url.pathname);
  assert.deepEqual(paths.slice(0, 2), [repositoryPath, pipelinePath]);
  assert.deepEqual(paths.slice(2, -1).sort(), [jobsPath, triggerJobsPath].sort());
  assert.equal(paths.at(-1), pipelinePath);
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

test('reads connected trigger jobs including successful dispatch with a failing downstream pipeline and sanitizes source links', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  f.setJobs([f.job(812)]);
  f.setTriggerJobs([
    { ...f.job(818, { name: 'dispatch child checks', status: 'success' }),
      downstream_pipeline: { id: 915, status: 'failed', web_url: `${f.baseUrl}/group/child/pipelines/915` } },
    { ...f.job(817, { name: `manual ${token}`, web_url: `https://elsewhere.invalid/team/app/-/jobs/817`, status: 'manual' }),
      downstream_pipeline: { id: 914, status: 'running', web_url: `${f.baseUrl}/group/child/-/pipelines/913` }, raw_child: privateUpstream },
    { ...f.job(816, { web_url: `${f.baseUrl}/group/child/-/jobs/816` }),
      downstream_pipeline: { id: 913, status: 'manual', web_url: `https://elsewhere.invalid/group/child/-/pipelines/913` } },
    { ...f.job(815, { web_url: `${f.jobUrl(815)}?private_token=${token}` }),
      downstream_pipeline: { id: 912, status: 'failed', web_url: `${new URL(f.baseUrl).origin}/group/outside/-/pipelines/912` } },
  ]);
  const result = await f.call<GitlabPipelineJobs>(f.path);
  assert.deepEqual(result.jobs.map(job => job.id), [812]);
  assert.deepEqual(result.triggerJobs, { hasMore: false, jobs: [
    { id: 818, name: 'dispatch child checks', stage: 'test', status: 'success', allowFailure: false, failureReason: null,
      webUrl: f.jobUrl(818), downstream: { id: 915, status: 'failed', webUrl: `${f.baseUrl}/group/child/-/pipelines/915` } },
    { id: 817, name: '이름 미확인', stage: 'test', status: 'manual', allowFailure: false, failureReason: null,
      webUrl: null, downstream: { id: 914, status: 'running', webUrl: null } },
    { id: 816, name: 'test-816', stage: 'test', status: 'failed', allowFailure: false, failureReason: 'script_failure',
      webUrl: null, downstream: { id: 913, status: 'manual', webUrl: null } },
    { id: 815, name: 'test-815', stage: 'test', status: 'failed', allowFailure: false, failureReason: 'script_failure',
      webUrl: null, downstream: { id: 912, status: 'failed', webUrl: null } },
  ] });
  const trigger = f.calls.find(({ url }) => url.pathname === triggerJobsPath)!;
  assert.deepEqual([...trigger.url.searchParams], [['per_page', '50'], ['page', '1']]);
  assert.ok(f.calls.every(({ method, url }) => method === 'GET' && [repositoryPath, pipelinePath, jobsPath, triggerJobsPath].includes(url.pathname)));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(privateUpstream));
  assert.deepEqual(await f.snapshot(), before);
});

test('falls back to legacy bridges only on an unavailable modern endpoint and keeps ordinary jobs on trigger failures', async t => {
  const f = await fixture(t);
  f.setJobs([f.job(812)]);
  f.setTriggerJobs([], 404);
  f.setBridgeJobs([f.job(818, { status: 'manual' })]);
  const legacy = await f.call<GitlabPipelineJobs>(f.path);
  assert.deepEqual(legacy.triggerJobs?.jobs.map(({ id, downstream }) => ({ id, downstream })), [{ id: 818, downstream: null }]);
  assert.deepEqual(f.calls.filter(({ url }) => [triggerJobsPath, bridgesPath].includes(url.pathname)).map(({ url }) => url.pathname),
    [triggerJobsPath, bridgesPath]);

  for (const [value, status] of [
    [null, 403], [null, 429], [null, 0], [{ jobs: [] }, 200],
    [[f.job(817, { pipeline: { id: pipelineId + 1, project_id: repositoryId, sha } })], 200],
    [[f.job(817, { pipeline: { id: pipelineId, project_id: repositoryId + 1, sha } })], 200],
    [[f.job(817, { pipeline: { id: pipelineId, project_id: repositoryId, sha: '2'.repeat(40) } })], 200],
  ] as const) {
    f.calls.length = 0;
    f.setTriggerJobs(value, status);
    const result = await f.call<GitlabPipelineJobs>(f.path);
    assert.equal(result.triggerJobs, null);
    assert.deepEqual(result.jobs.map(({ id }) => id), [812]);
    assert.ok(!f.calls.some(({ url }) => url.pathname === bridgesPath));
  }
});

test('returns ordinary jobs after an optional trigger lookup times out', async t => {
  const f = await fixture(t);
  f.setJobs([f.job(812)]);
  const release = Promise.withResolvers<void>();
  f.setTriggerGate(() => release.promise);
  try {
    const result = await f.call<GitlabPipelineJobs>(f.path);
    assert.deepEqual(result.jobs.map(({ id }) => id), [812]);
    assert.equal(result.triggerJobs, null);
    assert.ok(!f.calls.some(({ url }) => url.pathname === bridgesPath));
  } finally { release.resolve(); }
});

test('bounds trigger job pages and discards both results if the parent changes during trigger reads', async t => {
  const f = await fixture(t);
  f.setJobs([f.job(812)]);
  const triggers = Array.from({ length: 201 }, (_, index) => f.job(1900 - index, { status: 'success' }));
  f.setTriggerJobs(triggers);
  const limited = await f.call<GitlabPipelineJobs>(f.path);
  assert.equal(limited.triggerJobs?.hasMore, true);
  assert.deepEqual(limited.triggerJobs?.jobs.map(({ id }) => id), triggers.slice(0, 200).map(({ id }) => id));
  assert.deepEqual(f.calls.filter(({ url }) => url.pathname === triggerJobsPath).map(({ url }) => url.searchParams.get('page')), ['1', '2', '3', '4']);

  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setTriggerGate(() => { reached.resolve(); return release.promise; });
  const pending = f.request(f.path);
  try {
    await Promise.race([reached.promise, pending.then(response => assert.fail(`Job request ended early (${response.status})`))]);
    f.setPipeline({ status: 'failed' });
  } finally {
    release.resolve();
    f.setTriggerGate();
  }
  const stale = await pending;
  assert.equal(stale.status, 409);
  assert.ok(!Object.hasOwn(stale.data as object, 'jobs'));
  assert.ok(!Object.hasOwn(stale.data as object, 'triggerJobs'));
});

function reportTotals(count: number, passed = count, failed = 0, skipped = 0, errors = 0, suiteError: string | null = null) {
  return { time: 12, count, success: passed, failed, skipped, error: errors, suite_error: suiteError };
}

function reportSuite(name: string, count: number, passed = count, failed = 0, skipped = 0, errors = 0, suiteError: string | null = null) {
  return { name, total_time: 12, total_count: count, success_count: passed, failed_count: failed, skipped_count: skipped,
    error_count: errors, suite_error: suiteError, build_ids: [123] };
}

test('reads linked pipeline test counts without case details, secrets or changes to the workspace', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  f.setPipeline({ status: 'failed' });
  f.setTestReport({ total: reportTotals(7, 4, 1, 1, 1, privateUpstream), test_suites: [
    { ...reportSuite('Smoke tests', 4, 2, 1, 1), test_cases: [{ stack_trace: privateUpstream }] },
    { ...reportSuite('Integration tests', 3, 2, 0, 0, 1, `${privateUpstream} ${token}`), system_output: privateUpstream },
  ] });
  const response = await f.request<GitlabPipelineTestReport>(f.reportPath);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  const { checkedAt, ...report } = response.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(report, {
    linkId: f.link.id, repositoryId, pipelineId, status: 'failed', hasMore: false,
    total: { count: 7, passed: 4, failed: 1, skipped: 1, errors: 1, reportError: true },
    suites: [
      { name: 'Smoke tests', count: 4, passed: 2, failed: 1, skipped: 1, errors: 0, reportError: false },
      { name: 'Integration tests', count: 3, passed: 2, failed: 0, skipped: 0, errors: 1, reportError: true },
    ],
  });
  assert.deepEqual(f.calls.map(({ method, url, credential }) => [method, url.pathname, url.search, credential]),
    [repositoryPath, pipelinePath, testReportPath, pipelinePath].map(path => ['GET', path, '', token]));

  f.setTestReport({ total: reportTotals(0), test_suites: [] });
  const empty = await f.call<GitlabPipelineTestReport>(f.reportPath);
  assert.deepEqual(empty.total, { count: 0, passed: 0, failed: 0, skipped: 0, errors: 0, reportError: false });
  assert.deepEqual(empty.suites, []);
  assert.equal(empty.hasMore, false);

  f.setTestReport({ total: reportTotals(1), test_suites: [reportSuite(`suite ${token}`, 1)] });
  const redacted = await f.call<GitlabPipelineTestReport>(f.reportPath);
  assert.equal(redacted.suites[0].name, '이름 미확인');
  assert.ok(!JSON.stringify(redacted).includes(token));
  assert.deepEqual(await f.snapshot(), before);
});

test('bounds the test suite preview and rejects malformed reports or unverified ticket paths', async t => {
  const f = await fixture(t);
  const unrelated = await f.createIssue('Unlinked report ticket');
  await f.call(reportRoute(unrelated.id, f.link.id), undefined, 404);
  await f.call(reportRoute(f.issue.id, 'missing'), undefined, 404);
  await f.call(`${f.reportPath}?pipelineId=13`, undefined, 400);
  assert.equal(f.calls.length, 0);

  const suites = Array.from({ length: 51 }, (_, index) => reportSuite(`Suite ${index + 1}`, 1));
  f.setTestReport({ total: reportTotals(suites.length), test_suites: suites });
  const bounded = await f.call<GitlabPipelineTestReport>(f.reportPath);
  assert.equal(bounded.total.count, 51);
  assert.equal(bounded.hasMore, true);
  assert.deepEqual(bounded.suites.map(({ name }) => name), suites.slice(0, 50).map(({ name }) => name));
  assert.equal(f.calls.filter(({ url }) => url.pathname === testReportPath).length, 1);

  for (const total of [reportTotals(-1), reportTotals(2, 1), { ...reportTotals(1), count: Number.MAX_SAFE_INTEGER + 1 }]) {
    f.setTestReport({ total, test_suites: [] });
    await f.call(f.reportPath, undefined, 502);
  }
  f.setTestReport({ total: reportTotals(1), test_suites: [{ ...reportSuite('bad suite', 1), total_count: '1' }] });
  await f.call(f.reportPath, undefined, 502);
  for (const [status, expected] of [[302, 502], [403, 403], [404, 404], [429, 429]]) {
    f.setTestReport(null, status);
    const result = await f.call(f.reportPath, undefined, expected);
    assert.ok(!JSON.stringify(result).includes(privateUpstream));
    assert.ok(!JSON.stringify(result).includes(token));
  }
  assert.ok(f.calls.every(({ url }) => [repositoryPath, pipelinePath, testReportPath].includes(url.pathname)));
});

test('rejects a test report if the pipeline or current GitLab link changes during the read', async t => {
  const f = await fixture(t);
  f.setTestReport({ total: reportTotals(1), test_suites: [reportSuite('Smoke', 1)] });
  async function whileReading(change: () => void | Promise<unknown>) {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setTestReportGate(() => { reached.resolve(); return release.promise; });
    const pending = f.request(f.reportPath);
    try {
      await Promise.race([reached.promise, pending.then(response => assert.fail(`Report request ended early (${response.status})`))]);
      await change();
    } finally {
      release.resolve();
      f.setTestReportGate();
    }
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(!Object.hasOwn(result.data as object, 'suites'));
  }
  await whileReading(() => f.setPipeline({ updated_at: new Date(Date.parse(updatedAt) + 1000).toISOString() }));
  await whileReading(() => f.configure({ token: 'rotated-synthetic-report-read-token' }));
  await whileReading(() => f.call(`/issues/${f.issue.id}/gitlab-links/${encodeURIComponent(f.link.id)}?expectedManualLinkId=${f.link.manualLinkId}`, { method: 'DELETE' }));
  await f.call(f.reportPath, undefined, 404);
});

const failedReport = (failed_count: number, error_count: number, test_suites: unknown[] = []) => ({ failed_count, error_count, test_suites });

test('reads only display-safe failed and error test cases from the exact linked pipeline on demand', async t => {
  const f = await fixture(t);
  f.setPipeline({ status: 'failed' });
  const before = await f.snapshot();
  const longLabel = `${'가'.repeat(254)}🚀뒤`;
  f.setFailedReportPages({ body: failedReport(2, 1, [
    { name: 'Smoke\u2028tests', test_cases: [
      { status: 'success', name: 'Successful test' },
      { status: 'failed', name: 'failed\tcase\u202e', classname: 'Test\nCase', stack_trace: privateUpstream,
        system_output: token, file: privateUpstream, attachment: token, recent_failures: 7 },
      { status: 'skipped', name: 'Skipped test' },
      { status: 'error', name: longLabel },
    ] },
    { name: `suite ${token}`, test_cases: [{ status: 'failed', name: `case ${token}`, classname: `${token} Class` }] },
  ]) });
  const response = await f.request<GitlabPipelineFailedTests>(f.failedTestsPath);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  const { checkedAt, ...result } = response.data;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(result, {
    linkId: f.link.id, repositoryId, pipelineId, status: 'failed', hasMore: false,
    cases: [
      { suite: 'Smoke\u2028tests', name: 'failed case', className: 'Test Case', status: 'failed' },
      { suite: 'Smoke\u2028tests', name: `${'가'.repeat(254)}�`, status: 'error' },
      { suite: '이름 미확인', name: '이름 미확인', status: 'failed' },
    ],
  });
  assert.deepEqual(f.calls.map(({ method, url, credential }) => [method, url.pathname, url.search, credential]), [
    ['GET', repositoryPath, '', token], ['GET', pipelinePath, '', token],
    ['GET', failedReportPath, '?per_page=50&page=1', token], ['GET', pipelinePath, '', token],
  ]);
  assert.ok(!JSON.stringify(result).includes(privateUpstream));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.deepEqual(await f.snapshot(), before);
});

test('bounds displayed failed tests and follows only verified pagination, keeping incomplete reports distinguishable', async t => {
  const f = await fixture(t);
  const suite = (...test_cases: unknown[]) => ({ name: 'Smoke', test_cases });
  const item = (name: string) => ({ status: 'failed', name });
  const full = (...cases: unknown[]) => failedReport(cases.length, 0, [suite(...cases)]);
  const calls = () => f.calls.filter(({ url }) => url.pathname === failedReportPath).map(({ url }) => [
    url.searchParams.get('page'), url.searchParams.get('per_page'), [...url.searchParams.keys()].sort(),
  ]);
  const query = (page: string) => [page, '50', ['page', 'per_page']];
  const fiftyOne = Array.from({ length: 51 }, (_, index) => item(`Failed ${index + 1}`));
  f.setFailedReportPages({ body: full(...fiftyOne) });
  const capped = await f.call<GitlabPipelineFailedTests>(f.failedTestsPath);
  assert.equal(capped.hasMore, true);
  assert.deepEqual(capped.cases.map(({ name }) => name), fiftyOne.slice(0, 50).map(({ name }) => name));
  assert.deepEqual(calls(), [query('1')]);

  f.calls.length = 0;
  f.setFailedReportPages(
    { body: failedReport(1, 0, [suite({ status: 'success' })]), headers: { Link: `<${failedReportPath}?page=2&per_page=100>; rel="next"` } },
    { body: failedReport(1, 0, [suite(item('Second page'))]), headers: { 'X-Next-Page': '' } },
  );
  const second = await f.call<GitlabPipelineFailedTests>(f.failedTestsPath);
  assert.deepEqual(second.cases, [{ suite: 'Smoke', name: 'Second page', status: 'failed' }]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(calls(), [query('1'), query('2')]);

  f.calls.length = 0;
  f.setFailedReportPages(...Array.from({ length: 5 }, (_, index) => ({ body: full(), headers: { 'X-Next-Page': String(index + 2) } })));
  const limited = await f.call<GitlabPipelineFailedTests>(f.failedTestsPath);
  assert.deepEqual(limited.cases, []);
  assert.equal(limited.hasMore, true);
  assert.deepEqual(calls(), ['1', '2', '3', '4'].map(query));

  for (const [body, hasMore] of [
    [failedReport(0, 0), false],
    [failedReport(2, 0), true],
    [failedReport(0, 0, [{ ...suite(), suite_error: `${privateUpstream} ${token}` }]), true],
    [{ ...failedReport(0, 0), suite_error: `${privateUpstream} ${token}` }, true],
  ] as const) {
    f.setFailedReportPages({ body });
    const checked = await f.call<GitlabPipelineFailedTests>(f.failedTestsPath);
    assert.deepEqual(checked.cases, []);
    assert.equal(checked.hasMore, hasMore);
    assert.ok(!JSON.stringify(checked).includes(privateUpstream));
  }
});

test('validates the report and request boundaries without attempting foreign pagination or exposing upstream bodies', async t => {
  const f = await fixture(t);
  const unrelated = await f.createIssue('Unlinked failed tests ticket');
  const absent = await f.call<{ error: string }>(failedTestsRoute(unrelated.id, f.link.id), undefined, 404);
  await f.call(`${f.failedTestsPath}?page=2`, undefined, 400);
  assert.equal(f.calls.length, 0);
  const missing = await f.call<{ error: string }>(f.failedTestsPath, undefined, 404);
  assert.equal(missing.error, 'GitLab에서 이 파이프라인의 실패 테스트 상세를 제공하지 않습니다.');
  assert.notEqual(absent.error, missing.error);

  for (const body of [
    failedReport(-1, 0), failedReport(0, 0, [{ name: 'Malformed suite' }]),
    failedReport(0, 0, [{ name: 'Malformed case', test_cases: [{ status: 'unknown' }] }]),
  ]) {
    f.setFailedReportPages({ body });
    await f.call(f.failedTestsPath, undefined, 502);
  }
  f.calls.length = 0;
  const first = failedReport(1, 0, [{ name: 'Smoke', test_cases: [] }]);
  f.setFailedReportPages({ body: first, headers: { Link: '<https://other.example.test/tests?page=2>; rel="next"' } });
  await f.call(f.failedTestsPath, undefined, 502);
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), [repositoryPath, pipelinePath, failedReportPath]);

  f.setFailedReportPages({ body: first, headers: { 'X-Next-Page': '2' } });
  const missingPage = await f.call<{ error: string }>(f.failedTestsPath, undefined, 502);
  assert.notEqual(missingPage.error, missing.error);
  for (const [status, expected] of [[302, 502], [403, 403], [429, 429]]) {
    f.setFailedReportPages({ status, body: { message: `${privateUpstream} ${token}` }, headers: { Location: `${f.baseUrl}/private-target` } });
    const result = await f.call(f.failedTestsPath, undefined, expected);
    assert.ok(!JSON.stringify(result).includes(privateUpstream));
    assert.ok(!JSON.stringify(result).includes(token));
  }
  f.setFailedReportPages({ body: {}, headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } });
  await f.call(f.failedTestsPath, undefined, 502);
});

test('discards failed test details if the live pipeline or stored settings and link change during the lookup', async t => {
  const f = await fixture(t);
  f.setFailedReportPages({ body: failedReport(1, 0, [{ name: 'Smoke', test_cases: [{ status: 'failed', name: 'A failure' }] }]) });
  async function whileReading(change: () => void | Promise<unknown>) {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setTestReportGate(() => { reached.resolve(); return release.promise; });
    const pending = f.request(f.failedTestsPath);
    try {
      await Promise.race([reached.promise, pending.then(response => assert.fail(`Failed tests request ended early (${response.status})`))]);
      await change();
    } finally {
      release.resolve();
      f.setTestReportGate();
    }
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.ok(!Object.hasOwn(result.data as object, 'cases'));
  }
  await whileReading(() => f.setPipeline({ status: 'success' }));
  await whileReading(() => f.configure({ token: 'rotated-synthetic-failed-tests-token' }));
  await whileReading(() => f.call(`/issues/${f.issue.id}/gitlab-links/${encodeURIComponent(f.link.id)}?expectedManualLinkId=${f.link.manualLinkId}`, { method: 'DELETE' }));
  await f.call(f.failedTestsPath, undefined, 404);
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
  assert.ok(f.calls.every(call => [repositoryPath, pipelinePath, jobsPath, triggerJobsPath].includes(call.url.pathname)));

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
