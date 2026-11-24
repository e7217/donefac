import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type {
  AutomationRule, GitlabIssueRefreshResult, GitlabLink, GitlabMergeRequestPipeline, GitlabSettings, Issue, IssueAutomationRunPage, Project, WorkspaceSnapshot,
} from '../../shared/types.js';

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
const webhookSecret = 'synthetic-mr-pipeline-webhook-secret';
const repositoryPath = (id: number) => '/forge/api/v4/projects/' + id;
const mrPath = repositoryPath(targetRepository) + '/merge_requests/' + iid;
const pipelinePath = repositoryPath(sourceRepository) + '/pipelines/' + pipelineId;
const pipelineRef = `refs/merge-requests/${iid}/merge`;
type Options = { method?: string; body?: unknown; headers?: Record<string, string> };

async function fixture(t: TestContext, configuredRepositories = [targetRepository, sourceRepository, unrelatedRepository]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-mr-pipeline-'));
  const calls: { method: string; path: string; credential?: string | string[] }[] = [];
  let baseUrl = '';
  const targetUrl = () => baseUrl + '/team/app';
  const sourceUrl = () => baseUrl + '/fork/app';
  const mrUrl = () => targetUrl() + '/-/merge_requests/' + iid;
  const pipelineUrl = (id = pipelineId) => sourceUrl() + '/-/pipelines/' + id;
  const head = { id: pipelineId, project_id: sourceRepository, sha: pipelineSha,
    web_url: 'https://example.invalid/ignore-this-url?private_token=untrusted' };
  let headPipeline: unknown = head;
  let remotePipelineSha = pipelineSha;
  let remotePipelineAt = updatedAt;
  let remotePipelineSource: string | undefined = 'merge_request_event';
  let currentHead = sourceHead;
  let duringPipeline: (() => Promise<void> | void) | undefined;
  const remotePipeline = (id: number) => ({ id, project_id: sourceRepository, sha: remotePipelineSha, status: 'failed',
    updated_at: remotePipelineAt, finished_at: remotePipelineAt, ref: pipelineRef, source: remotePipelineSource, web_url: pipelineUrl(id) });
  const mock = createServer(async (req, res) => {
    const { pathname: path, searchParams } = new URL(req.url ?? '/', 'http://fixture.test');
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
    } else if (path === pipelinePath || path === repositoryPath(sourceRepository) + '/pipelines/' + (pipelineId + 1)) {
      await duringPipeline?.();
      const id = Number(path.split('/').at(-1));
      body = { ...remotePipeline(id), tag: false };
    } else if (path === repositoryPath(sourceRepository) + '/pipelines') {
      body = searchParams.get('ref') === pipelineRef && searchParams.get('source') === remotePipelineSource ? [remotePipeline(pipelineId)] : [];
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
      method: options.method ?? 'GET', headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...options.headers },
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
    body: { baseUrl, projectIds, token, webhookSecret, expectedVersion: (await call<GitlabSettings>(settingsPath)).version } });
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
    setPipelineAt(value: string) { remotePipelineAt = value; },
    setPipelineSource(value: string | undefined) { remotePipelineSource = value; },
    setDuringPipeline(next: typeof duringPipeline) { duringPipeline = next; },
    changeSourceHead() { currentHead = 'c'.repeat(40); },
  };
}

async function reviewedAttachment(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.call<GitlabMergeRequestPipeline>(f.path);
  assert.equal(result.kind, 'pipeline');
  const { repositoryId, pipelineId, sha } = result.pipeline;
  assert.match(result.revision, /^[a-f0-9]{64}$/u);
  return { method: 'POST', body: { repositoryId, pipelineId, sha, revision: result.revision } };
}

test('uses the verified MR head pipeline from a configured fork and reads jobs only on explicit request', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const response = await f.request<GitlabMergeRequestPipeline>(f.path);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/u);
  assert.equal(response.body.kind, 'pipeline');
  const { checkedAt, revision, ...value } = response.body;
  assert.equal(new Date(checkedAt).toISOString(), checkedAt);
  assert.match(revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(value, { kind: 'pipeline', linkId: f.link.id, repositoryId: targetRepository, mergeRequestIid: iid,
    pipeline: { repositoryId: sourceRepository, pipelineId, sha: pipelineSha, status: 'failed', webUrl: f.pipelineUrl(), updatedAt } });
  assert.deepEqual(f.calls.map(call => call.path), [
    repositoryPath(targetRepository), mrPath, repositoryPath(sourceRepository), pipelinePath, mrPath,
  ]);

  f.calls.length = 0;
  const detail = await f.call<GitlabMergeRequestPipeline>(f.path + '-jobs');
  assert.equal(detail.kind, 'pipeline');
  assert.equal(detail.revision, revision);
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
    assert.equal('revision' in result, false);
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

test('attaches a fork MR merged-result pipeline once and supports the normal linked status review', async t => {
  const f = await fixture(t);
  const rule = await f.call<AutomationRule>('/automation-rules', { method: 'POST', body: {
    projectId: f.issue.projectId, name: 'Review failed merged-result pipelines', enabled: true, trigger: 'pipeline.failed',
    gitlabProjectIds: [sourceRepository], branchPattern: 'refs/merge-requests/*', pipelineSources: ['merge_request_event'],
    issueTypes: [], fromStatuses: [f.issue.status], toStatusId: 'done',
  } }, 201);
  assert.equal(rule.enabled, true);
  f.setPipelineAt(new Date().toISOString());
  const before = await f.snapshot();
  const issuePath = `/issues/${encodeURIComponent(f.issue.id)}`;
  const history = () => f.call<IssueAutomationRunPage>(`${issuePath}/automation-runs`);
  const priorRuns = await history();
  const attach = await reviewedAttachment(f);
  assert.equal(attach.body.repositoryId, sourceRepository);
  assert.equal(attach.body.pipelineId, pipelineId);
  assert.equal(attach.body.sha, pipelineSha);
  assert.notEqual(attach.body.sha, sourceHead);
  assert.deepEqual(await f.snapshot(), before);

  const writes = await Promise.all([f.request<GitlabLink>(f.path, attach), f.request<GitlabLink>(f.path, attach)]);
  assert.deepEqual(writes.map(write => write.status).sort(), [200, 201]);
  const [link, retry] = writes.map(write => write.body);
  assert.deepEqual(link, retry);
  assert.ok(writes.every(write => /\bno-store\b/u.test(write.headers.get('cache-control') ?? '')));
  assert.ok(link.manualLinkId);
  assert.ok(link.id.endsWith(`:${sourceRepository}:pipeline:${pipelineId}:${f.issue.id}`));
  assert.deepEqual({ kind: link.kind, issueId: link.issueId, projectId: link.projectId, iid: link.iid,
    sha: link.sourceSha, ref: link.sourceBranch, webUrl: link.webUrl, state: link.state }, {
    kind: 'pipeline', issueId: f.issue.id, projectId: sourceRepository, iid: pipelineId,
    sha: pipelineSha, ref: pipelineRef, webUrl: f.pipelineUrl(), state: 'failed',
  });
  assert.equal(link.pipelineSource, 'merge_request_event');
  const after = await f.snapshot();
  assert.deepEqual(after.gitlabLinks.filter(value => value.kind === 'pipeline'), [link]);
  assert.deepEqual(after.gitlabLinks.find(value => value.id === f.link.id), f.link);
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual(await history(), priorRuns);
  const attachActivities = (snapshot: WorkspaceSnapshot) => snapshot.activities.filter(activity => activity.resourceId === f.issue.id &&
    activity.action === 'GitLab 활동 수동 연결' && activity.detail?.includes(String(pipelineId)));
  assert.deepEqual(attachActivities(before), []);
  assert.equal(attachActivities(after).length, 1);

  // An earlier classification remains visible when the exact detail omits source.
  f.setPipelineSource(undefined);
  const reviewPath = `${issuePath}/gitlab-links/${encodeURIComponent(link.id)}/status-review`;
  const readReview = () => f.call<GitlabIssueRefreshResult>(reviewPath, { method: 'POST', body: {} });
  const unclassified = await readReview();
  assert.deepEqual(unclassified.failures, []);
  assert.equal(unclassified.links[0]?.pipelineSource, 'merge_request_event');
  assert.equal(unclassified.statusReview, undefined);
  f.setPipelineSource('merge_request_event');
  const status = await readReview();
  assert.deepEqual(status.failures, []);
  assert.equal(status.links[0]?.pipelineSource, 'merge_request_event');
  assert.equal(status.statusReview?.kind, 'suggestion');
  if (status.statusReview?.kind === 'suggestion') {
    assert.equal(status.statusReview.suggestion.rule.id, rule.id);
    assert.equal(status.statusReview.suggestion.evidence.link.id, link.id);
    assert.equal(status.statusReview.suggestion.evidence.trigger, 'pipeline.failed');
  }
  assert.deepEqual((await f.snapshot()).issues, before.issues);
  assert.deepEqual(await history(), priorRuns);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
});

for (const existingKind of ['manual', 'automatic'] as const) {
  test(`keeps the exact ${existingKind} pipeline link and its attribution when attaching from the MR`, async t => {
    const f = await fixture(t);
    if (existingKind === 'manual') {
      await f.call<GitlabLink>(`/issues/${encodeURIComponent(f.issue.id)}/gitlab-links`, { method: 'POST', body: {
        repositoryId: sourceRepository, url: f.pipelineUrl(),
        expectedSettingsVersion: (await f.call<GitlabSettings>('/integrations/gitlab')).version,
      } }, 201);
    } else {
      const observed = await f.call<{ linked: number }>('/integrations/gitlab/webhook', { method: 'POST',
        headers: { 'X-Gitlab-Token': webhookSecret }, body: {
          object_kind: 'pipeline', project: { id: sourceRepository, web_url: f.pipelineUrl().split('/-/')[0] },
          object_attributes: { id: pipelineId, project_id: sourceRepository, sha: pipelineSha, ref: pipelineRef, source: 'merge_request_event',
            status: 'running', updated_at: new Date().toISOString(), url: f.pipelineUrl() },
          commit: { id: pipelineSha, message: `${f.issue.key} Pipeline deliberately linked from GitLab` },
        } });
      assert.equal(observed.linked, 1);
    }
    const input = await reviewedAttachment(f);
    const before = await f.snapshot();
    const known = before.gitlabLinks.find(value => value.kind === 'pipeline');
    assert.ok(known);
    assert.equal(Boolean(known.manualLinkId), existingKind === 'manual');
    const attached = await f.call<GitlabLink>(f.path, input, 200);
    assert.deepEqual(attached, known);
    assert.deepEqual(await f.snapshot(), before);
    assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
  });
}

test('rejects forged or stale MR pipeline reviews without attaching the original or a superseding pipeline', async t => {
  const f = await fixture(t);
  const attach = await reviewedAttachment(f);
  const other = await f.call<Issue>('/issues', { method: 'POST', body: { projectId: f.issue.projectId, title: '파이프라인 확인 없이 별도로 만든 업무' } }, 201);
  const wrongPath = f.path.replace(`/issues/${encodeURIComponent(f.issue.id)}/`, `/issues/${encodeURIComponent(other.id)}/`);
  const readCount = f.calls.length;
  await f.call(f.path, { ...attach, body: { ...attach.body, revision: 'short' } }, 400);
  await f.call(f.path, { ...attach, body: { ...attach.body, url: f.pipelineUrl() } }, 400);
  await f.call(wrongPath, attach, 404);
  assert.equal(f.calls.length, readCount);
  const initial = await f.snapshot();
  await f.call(f.path, { ...attach, body: { ...attach.body, revision: '0'.repeat(64) } }, 409);
  await f.call(f.path, { ...attach, body: { ...attach.body, repositoryId: unrelatedRepository } }, 409);

  f.changeSourceHead();
  await f.call(f.path, attach, 409);
  const changedHead = await reviewedAttachment(f);
  assert.notEqual(changedHead.body.revision, attach.body.revision);
  assert.equal(changedHead.body.pipelineId, attach.body.pipelineId);
  f.setHeadPipeline({ ...f.head, id: pipelineId + 1 });
  await f.call(f.path, changedHead, 409);
  assert.deepEqual(await f.snapshot(), initial);

  const changedPointer = await reviewedAttachment(f);
  assert.equal(changedPointer.body.pipelineId, pipelineId + 1);
  await f.configure([targetRepository, sourceRepository]);
  const changedSettings = await f.snapshot();
  await f.call(f.path, changedPointer, 409);
  assert.deepEqual(await f.snapshot(), changedSettings);
  const latest = await reviewedAttachment(f);
  const restored = await f.call<GitlabLink>(f.path, latest, 201);
  assert.equal(restored.iid, pipelineId + 1);
  assert.deepEqual((await f.snapshot()).gitlabLinks.filter(link => link.kind === 'pipeline'), [restored]);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.credential === token));
});

test('requires a fresh pipeline review when the anchor issue moves during verification', async t => {
  const f = await fixture(t);
  const destination = await f.call<Project>('/projects', { method: 'POST', body: { key: 'MOVED', name: '업무 이동 대상' } }, 201);
  const attach = await reviewedAttachment(f);
  const issue = (await f.snapshot()).issues.find(value => value.id === f.issue.id);
  assert.ok(issue);
  const move: IssueProjectMoveInput = { expectedVersion: issue.version, projectId: destination.id, includeConnected: false, mappings: [] };
  const movePath = `/issues/${encodeURIComponent(issue.id)}/project-move`;
  const preview = await f.call<IssueProjectMovePreview>(`${movePath}/preview`, { method: 'POST', body: move });
  assert.ok(preview.token);
  f.setDuringPipeline(async () => {
    f.setDuringPipeline(undefined);
    await f.call<IssueProjectMoveResult>(`${movePath}/apply`, { method: 'POST', body: { ...move, token: preview.token } });
  });

  await f.call(f.path, attach, 409);
  const moved = await f.snapshot();
  assert.equal(moved.issues.find(value => value.id === issue.id)?.projectId, destination.id);
  assert.deepEqual(moved.gitlabLinks.filter(value => value.kind === 'pipeline'), []);
  const fresh = await reviewedAttachment(f);
  assert.notEqual(fresh.body.revision, attach.body.revision);
  assert.equal((await f.call<GitlabLink>(f.path, fresh, 201)).issueId, issue.id);
});
