import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { readGitlabDeploymentHistory } from '../../server/gitlab-deployment-read.js';
import { GitlabReadError } from '../../server/gitlab-read-sync.js';

const repositoryId = 42;
const path = `/gitlab/api/v4/projects/${repositoryId}`;
const token = 'synthetic-deployment-read-token';
const sha = 'ab'.repeat(20);
const updatedAt = '2025-02-03T14:15:16+09:00';

async function upstream(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, body: unknown) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function deployment(id: number, status = 'success', fields: Record<string, unknown> = {}) {
  return { id, status, sha, created_at: '2025-02-02T00:00:00Z', updated_at: updatedAt,
    environment: { id: 44, name: 'production/app' }, deployable: null, ...fields };
}

function mergeRequest(id: number, iid = id, fields: Record<string, unknown> = {}) {
  return { id, iid, state: 'merged', target_project_id: repositoryId, ...fields };
}

test('deployment REST reads normalize scoped URLs and retain only verified merged MR proof alongside partial failures', async t => {
  let foreignRequests = 0;
  const foreign = await upstream(t, (_request, response) => {
    foreignRequests++;
    json(response, []);
  });
  const requests: string[] = [];
  const origin = await upstream(t, (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push(request.url!);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['private-token'], token);
    const projectUrl = `${origin}/gitlab/group/subgroup/repository`;
    if (url.pathname === path) {
      json(response, { id: repositoryId, web_url: projectUrl, path_with_namespace: 'group/subgroup/repository' });
    } else if (url.pathname === `${path}/deployments`) {
      assert.deepEqual(Object.fromEntries(url.searchParams), { order_by: 'id', sort: 'desc', per_page: '50', page: '1' });
      response.setHeader('X-Next-Page', '');
      json(response, [
        deployment(10, 'created'), deployment(9, 'skipped'),
        deployment(8, 'success', { sha: sha.toUpperCase(), deployable: { id: 800, project_id: repositoryId, web_url: `${projectUrl}/-/jobs/800` },
          environment: { name: 'production/app', tier: 'production', external_url: `${foreign}/service` } }),
        deployment(7, 'failed', { deployable: { id: 700, project: { id: 43 }, web_url: `${foreign}/-/jobs/700` } }),
        deployment(6, 'running'), deployment(5, 'blocked'), deployment(4), deployment(3),
      ]);
    } else if (url.pathname === `${path}/deployments/8/merge_requests`) {
      assert.equal(url.searchParams.get('scope'), 'all');
      assert.equal(url.searchParams.get('state'), 'merged');
      if (url.searchParams.get('page') === '1') {
        response.setHeader('Link', `<${foreign}/wrong_scope?per_page=100&page=2>; rel="next"`);
        json(response, [mergeRequest(100, 20, { source_project_id: 91 }), mergeRequest(101, 21), mergeRequest(102, 22),
          mergeRequest(103, 23, { target_project_id: 999 }), mergeRequest(104, 24, { state: 'opened' })]);
      } else {
        assert.equal(url.searchParams.get('page'), '2');
        json(response, [mergeRequest(105, 25), mergeRequest(100, 20), mergeRequest(101, 30), mergeRequest(106, 22), mergeRequest(107, 27, { target_project_id: null })]);
      }
    } else if (url.pathname === `${path}/deployments/4/merge_requests`) {
      if (url.searchParams.get('page') === '1') {
        response.setHeader('X-Next-Page', '2');
        json(response, [mergeRequest(210, 50)]);
      } else response.writeHead(403).end('untrusted response text');
    } else if (url.pathname === `${path}/deployments/3/merge_requests`) {
      response.writeHead(404).end('association endpoint unavailable');
    } else {
      assert.fail(`Unexpected GitLab request ${request.url}`);
    }
  });

  const result = await readGitlabDeploymentHistory({ baseUrl: `${origin}/gitlab/`, token }, repositoryId);
  assert.equal(foreignRequests, 0);
  assert.equal(requests.length, 7);
  assert.equal(result.scanned, 8);
  assert.equal(result.deploymentLimitReached, false);
  assert.equal(result.associationUnavailable, 3);
  assert.equal(result.associationLimited, 0);
  assert.equal(result.associationDenied, 1);
  assert.equal(result.associationRateLimited, 0);
  assert.deepEqual(result.deployments.map(row => row.status), ['created', 'skipped', 'success', 'failed', 'running', 'blocked', 'success', 'success']);
  assert.deepEqual(result.deployments[2], {
    repositoryId, deploymentId: 8, environment: 'production/app', environmentTier: 'production', sha, status: 'success',
    changedAt: '2025-02-03T05:15:16.000Z', projectUrl: `${origin}/gitlab/group/subgroup/repository`,
    jobUrl: `${origin}/gitlab/group/subgroup/repository/-/jobs/800`, source: 'sync',
    mergeRequests: [{ id: 100, iid: 20 }, { id: 105, iid: 25 }],
  });
  assert.equal(result.deployments[3].jobUrl, undefined);
  assert.deepEqual(result.deployments[6].mergeRequests, [{ id: 210, iid: 50 }]);
  assert.equal(result.deployments[7].mergeRequests, undefined);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('deployment history caps scans and associated pages with bounded fan-out', async t => {
  let active = 0;
  let peak = 0;
  const associationCalls: string[] = [];
  const origin = await upstream(t, (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === path) {
      json(response, { id: repositoryId, web_url: `${origin}/gitlab/team/repo` });
    } else if (url.pathname === `${path}/deployments`) {
      assert.equal(url.searchParams.get('page'), '1');
      response.setHeader('X-Next-Page', '2');
      json(response, Array.from({ length: 50 }, (_, index) => deployment(50 - index, index < 8 ? 'success' : 'failed')));
    } else {
      const [, id] = /\/deployments\/(\d+)\/merge_requests$/.exec(url.pathname)!;
      const page = Number(url.searchParams.get('page'));
      associationCalls.push(`${id}:${page}`);
      peak = Math.max(peak, ++active);
      void setTimeout(20).then(() => {
        active--;
        if (id !== '50') {
          json(response, []);
          return;
        }
        response.setHeader('X-Next-Page', String(page + 1));
        json(response, Array.from({ length: 100 }, (_, index) => mergeRequest((page - 1) * 100 + index + 1)));
      });
    }
  });

  const result = await readGitlabDeploymentHistory({ baseUrl: `${origin}/gitlab`, token }, repositoryId);
  assert.equal(peak, 4);
  assert.equal(result.scanned, 50);
  assert.equal(result.deploymentLimitReached, true);
  assert.equal(result.associationUnavailable, 0);
  assert.equal(result.associationLimited, 1);
  assert.equal(result.deployments[0].mergeRequests?.length, 200);
  assert.deepEqual(associationCalls.filter(call => call.startsWith('50:')), ['50:1', '50:2']);
  assert.equal(associationCalls.length, 9);
});

test('deployment REST reader refuses unverified repositories, redirects, and invalid deployment identity or status', async t => {
  let outsideRequests = 0;
  const outside = await upstream(t, (_request, response) => {
    outsideRequests++;
    json(response, []);
  });
  const calls: string[] = [];
  const origin = await upstream(t, (request, response) => {
    calls.push(request.url!);
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname.endsWith('/43')) {
      json(response, { id: 42, web_url: `${origin}/gitlab/team/repo` });
    } else if (url.pathname.endsWith('/44')) {
      json(response, { id: 44, path_with_namespace: 'team/repo', web_url: `${outside}/gitlab/team/repo` });
    } else if (url.pathname.endsWith('/45')) {
      response.writeHead(302, { Location: `${outside}/gitlab/api/v4/projects/45` }).end();
    } else if (url.pathname.endsWith('/46') || url.pathname.endsWith('/47')) {
      json(response, { id: Number(url.pathname.split('/').at(-1)), web_url: `${origin}/gitlab/team/repo` });
    } else if (url.pathname.endsWith('/46/deployments')) {
      json(response, [deployment(1, 'future-unknown')]);
    } else if (url.pathname.endsWith('/47/deployments')) {
      json(response, [deployment(1, 'success', { project_id: 48 })]);
    } else assert.fail(`Unexpected GitLab request ${request.url}`);
  });
  const connection = { baseUrl: `${origin}/gitlab`, token };
  for (const [id, stage, httpStatus] of [[43, 'project', null], [44, 'project', null], [45, 'project', 302],
    [46, 'deployments', null], [47, 'deployments', null]] as const) {
    await assert.rejects(readGitlabDeploymentHistory(connection, id), (error: unknown) => {
      assert.ok(error instanceof GitlabReadError);
      assert.equal(error.stage, stage);
      assert.equal(error.httpStatus, httpStatus);
      assert.ok(!error.message.includes(token));
      return true;
    });
  }
  assert.equal(outsideRequests, 0);
  assert.equal(calls.length, 7);
});

test('canceling deployment import interrupts pending association fetches', async t => {
  let associationRequests = 0;
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const origin = await upstream(t, (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === path) {
      json(response, { id: repositoryId, web_url: `${origin}/gitlab/team/repo` });
    } else if (url.pathname === `${path}/deployments`) {
      json(response, Array.from({ length: 10 }, (_, index) => deployment(index + 1)));
    } else {
      associationRequests++;
      started.resolve();
    }
  });
  const pending = readGitlabDeploymentHistory({ baseUrl: `${origin}/gitlab`, token }, repositoryId, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(associationRequests >= 1 && associationRequests <= 4);
});
