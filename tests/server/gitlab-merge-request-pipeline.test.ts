import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabLink, GitlabMergeRequestPipeline, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

const targetRepository = 42;
const sourceRepository = 73;
const unrelatedRepository = 99;
const iid = 19;
const mrId = 811;
const pipelineId = 901;
const sourceHead = 'a'.repeat(40);
const pipelineSha = 'b'.repeat(40);
const updatedAt = '2026-08-20T09:00:00.000Z';
const token = 'synthetic-mr-pipeline-read-token';
const repositoryPath = (id: number) => '/forge/api/v4/projects/' + id;
const mrPath = repositoryPath(targetRepository) + '/merge_requests/' + iid;
const pipelinePath = repositoryPath(sourceRepository) + '/pipelines/' + pipelineId;
type Options = { method?: string; body?: unknown };

async function fixture(t: TestContext, configuredRepositories = [targetRepository, sourceRepository, unrelatedRepository]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-mr-pipeline-'));
  const calls: { method: string; path: string; credential?: string | string[] }[] = [];
  let baseUrl = '';
  const targetUrl = () => baseUrl + '/team/app';
  const sourceUrl = () => baseUrl + '/fork/app';
  const mrUrl = () => targetUrl() + '/-/merge_requests/' + iid;
  const pipelineUrl = () => sourceUrl() + '/-/pipelines/' + pipelineId;
  const head = { id: pipelineId, project_id: sourceRepository, sha: pipelineSha,
    web_url: 'https://example.invalid/ignore-this-url?private_token=untrusted' };
  let headPipeline: unknown = head;
  let remotePipelineSha = pipelineSha;
  let currentHead = sourceHead;
  let duringPipeline: (() => Promise<void> | void) | undefined;
  const mock = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ method: req.method ?? '', path, credential: req.headers['private-token'] });
    let body: unknown;
    if (path === repositoryPath(targetRepository)) {
      body = { id: targetRepository, path_with_namespace: 'team/app', web_url: targetUrl() };
    } else if (path === repositoryPath(sourceRepository)) {
      body = { id: sourceRepository, path_with_namespace: 'fork/app', web_url: sourceUrl() };
    } else if (path === mrPath) {
      body = { id: mrId, iid, project_id: targetRepository, target_project_id: targetRepository, source_project_id: sourceRepository,
        state: 'opened', title: '연결할 MR', source_branch: 'feature/mr', sha: currentHead, diff_refs: { head_sha: currentHead },
        updated_at: updatedAt, web_url: mrUrl(), head_pipeline: headPipeline };
    } else if (path === pipelinePath) {
      await duringPipeline?.();
      body = { id: pipelineId, project_id: sourceRepository, sha: remotePipelineSha, status: 'failed', updated_at: updatedAt,
        ref: 'refs/merge-requests/19/merge', web_url: pipelineUrl() };
    } else if (path === pipelinePath + '/jobs') {
      body = [{ id: 509, name: 'ci-test', stage: 'test', status: 'failed', allow_failure: false,
        failure_reason: 'script_failure', web_url: sourceUrl() + '/-/jobs/509',
        pipeline: { id: pipelineId, project_id: sourceRepository, sha: pipelineSha } }];
    } else if (path === pipelinePath + '/trigger_jobs') {
      body = [];
    } else {
      res.statusCode = 404;
      body = { message: 'synthetic-unexpected-request' };
    }
    if (!res.destroyed) res.setHeader('Content-Type', 'application/json').end(JSON.stringify(body));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = 'http://127.0.0.1:' + (mock.address() as AddressInfo).port + '/forge';
  const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const appUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
  t.after(async () => {
    async function close(instance: typeof server) {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
    }
    try { await Promise.all([close(server), close(mock)]); }
    finally { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, options: Options = {}) {
    const response = await fetch(appUrl + path, {
      method: options.method ?? 'GET', headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  async function call<T>(path: string, options?: Options, status = 200) {
    const result = await request<T>(path, options);
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  const settingsPath = '/integrations/gitlab';
  const configure = async (projectIds: number[]) => call<GitlabSettings>(settingsPath, { method: 'PATCH',
    body: { baseUrl, projectIds, token, expectedVersion: (await call<GitlabSettings>(settingsPath)).version } });
  const configured = await configure(configuredRepositories);
  const issue = await call<Issue>('/issues', { method: 'POST', body: { projectId: 'project-neo', title: 'MR 실행을 확인할 업무' } }, 201);
  const link = await call<GitlabLink>('/issues/' + issue.id + '/gitlab-links', { method: 'POST',
    body: { repositoryId: targetRepository, url: mrUrl(), expectedSettingsVersion: configured.version } }, 201);
  const path = '/issues/' + encodeURIComponent(issue.id) + '/gitlab-links/' + encodeURIComponent(link.id) + '/merge-request-pipeline';
  calls.length = 0;
  return { calls, head, issue, link, path, pipelineUrl, request, call, configure,
    snapshot: () => call<WorkspaceSnapshot>('/workspace'),
    setHeadPipeline(value: unknown) { headPipeline = value; },
    setPipelineSha(value: string) { remotePipelineSha = value; },
    setDuringPipeline(next: typeof duringPipeline) { duringPipeline = next; },
    changeSourceHead() { currentHead = 'c'.repeat(40); },
  };
}

test('uses the verified MR head pipeline from a configured fork and reads jobs only on explicit request', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const response = await f.request<GitlabMergeRequestPipeline>(f.path);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/u);
  const { checkedAt, ...value } = response.body;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.deepEqual(value, { kind: 'pipeline', linkId: f.link.id, repositoryId: targetRepository, mergeRequestIid: iid,
    pipeline: { repositoryId: sourceRepository, pipelineId, sha: pipelineSha, status: 'failed', webUrl: f.pipelineUrl(), updatedAt } });
  assert.deepEqual(f.calls.map(call => call.path), [
    repositoryPath(targetRepository), mrPath, repositoryPath(sourceRepository), pipelinePath, mrPath,
  ]);

  f.calls.length = 0;
  const detail = await f.call<GitlabMergeRequestPipeline>(f.path + '-jobs');
  assert.equal(detail.kind, 'pipeline');
  if (detail.kind !== 'pipeline') return;
  assert.equal(detail.jobs?.linkId, f.link.id);
  assert.equal(detail.jobs?.repositoryId, sourceRepository);
  assert.equal(detail.jobs?.pipelineId, pipelineId);
  assert.deepEqual(detail.jobs?.jobs.map(job => [job.id, job.name, job.status]), [[509, 'ci-test', 'failed']]);
  assert.ok(f.calls.some(call => call.path === pipelinePath + '/jobs'));
  assert.equal(f.calls.at(-1)?.path, mrPath);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
  assert.ok(!JSON.stringify(detail).includes('untrusted'));
  assert.ok(!JSON.stringify(detail).includes(token));
  assert.deepEqual(await f.snapshot(), before);
});

test('distinguishes explicit absence, unreadable association, and a fork outside the connection', async t => {
  const f = await fixture(t, [targetRepository, unrelatedRepository]);
  assert.equal((await f.request(f.path + '?pipelineId=902')).status, 400);
  assert.equal(f.calls.length, 0);
  for (const [headPipeline, kind] of [
    [null, 'no_pipeline'],
    [undefined, 'pipeline_unavailable'],
    [f.head, 'repository_not_connected'],
  ] as const) {
    f.calls.length = 0;
    f.setHeadPipeline(headPipeline);
    const result = await f.call<GitlabMergeRequestPipeline>(f.path);
    assert.equal(result.kind, kind);
    assert.equal('pipeline' in result, false);
    assert.ok(f.calls.every(call => call.path === repositoryPath(targetRepository) || call.path === mrPath));
  }
  f.calls.length = 0;
  f.setHeadPipeline({ ...f.head, project_id: unrelatedRepository });
  const mismatched = await f.request(f.path);
  assert.ok(mismatched.status >= 400);
  assert.ok(f.calls.every(call => call.path === repositoryPath(targetRepository) || call.path === mrPath));
});

test('withholds the pipeline when its SHA, the remote MR head, or the local connection changes during verification', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  f.setPipelineSha('e'.repeat(40));
  const wrongSha = await f.request(f.path);
  assert.ok(wrongSha.status >= 400);
  assert.equal('pipeline' in (wrongSha.body as object), false);

  f.setPipelineSha(pipelineSha);
  f.setDuringPipeline(f.changeSourceHead);
  const changedHead = await f.request(f.path);
  assert.equal(changedHead.status, 409, JSON.stringify(changedHead.body));
  assert.equal('pipeline' in (changedHead.body as object), false);
  assert.deepEqual(await f.snapshot(), before);

  f.setDuringPipeline(async () => { await f.configure([targetRepository]); });
  const changedConnection = await f.request(f.path);
  assert.equal(changedConnection.status, 409, JSON.stringify(changedConnection.body));
  assert.equal('pipeline' in (changedConnection.body as object), false);
});
