import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { GitlabManualUrlError, GitlabReadError, readGitlabManualObject, readGitlabProjectWebhookHistory, readGitlabSyncProject } from '../../server/gitlab-read-sync.js';

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

test('GitLab webhook history reads one reviewed receiver page and projects delivery diagnostics without private fields', async t => {
  const receiver = 'https://teamspace.example.test/api/integrations/gitlab/webhook';
  const paths: string[] = [];
  const origin = await upstream(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['private-token'], 'synthetic-hook-token');
    paths.push(request.url!);
    response.setHeader('X-Next-Page', '2');
    response.end(JSON.stringify([
      { id: 32, url: receiver, trigger: 'deployment_hooks', response_status: '200', execution_duration: 1.09064,
        created_at: '2026-01-22T11:20:30-07:00', request_headers: { authorization: 'private-header' },
        request_data: { private: 'private-payload' }, response_body: 'response-private-data', response_headers: { Date: 'Thu, 22 Jan 2026 18:20:31 GMT' } },
      { id: 45, url: receiver, trigger: 'merge_request_hooks', response_status: 401, execution_duration: 0.08 },
      { id: 23, url: `${receiver}?token=historical-private-target`, trigger: 'pipeline_hooks', response_status: '200' },
      { id: 24, url: 'https://older.example.test/api/integrations/gitlab/webhook', trigger: 'push_hooks', response_status: '200' },
      { id: 26, url: receiver, trigger: 'pipeline_hooks', response_status: 'internal error', execution_duration: -0.001,
        created_at: '2026-02-29T00:00:00Z', internal_error_message: 'private-connection-detail' },
      { id: 20, url: receiver, trigger: 'tag_push_hooks', response_status: '0', response_headers: { Date: 'Thu, 22 Jan 2026 18:20:31 GMT' } },
      { id: 18, url: receiver, trigger: 'push_hooks', response_status: 0, created_at: '2026-01-22T18:20:30', execution_duration: 0 },
      { id: 17, url: receiver, trigger: 'private-trigger-detail', response_status: '502', execution_duration: '1.25' },
      { id: 15, url: receiver, trigger: 'push_hooks', response_status: 'malformed status private-data' },
      { id: 12, url: receiver, trigger: 'push_hooks', response_status: '200' },
      { id: 12, url: receiver, trigger: 'merge_request_hooks', response_status: '400' },
      null,
    ]));
  });
  const result = await readGitlabProjectWebhookHistory({ baseUrl: `${origin}/gitlab/`, token: 'synthetic-hook-token' }, 42, 8, receiver);
  assert.deepEqual(paths, ['/gitlab/api/v4/projects/42/hooks/8/events?per_page=20&page=1']);
  assert.deepEqual(result, { partial: true, attempts: [
    { id: 32, event: 'deployment', status: 200, sentAt: '2026-01-22T18:20:30.000Z', durationMs: 1091 },
    { id: 45, event: 'merge_request', status: 401, sentAt: null, durationMs: 80 },
    { id: 26, event: 'pipeline', status: null, sentAt: null, durationMs: null },
    { id: 20, event: 'tag_push', status: null, sentAt: null, durationMs: null },
    { id: 18, event: 'push', status: null, sentAt: null, durationMs: 0 },
    { id: 17, event: 'other', status: 502, sentAt: null, durationMs: null },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /private|https:/u);
});

test('GitLab webhook history distinguishes an empty page, filtered attempts, incomplete coverage and invalid envelopes', async t => {
  const receiver = 'https://teamspace.example.test/api/integrations/gitlab/webhook';
  const attempt = { id: 1, url: receiver, trigger: 'push_hooks', response_status: '200' };
  const fullPage = Array.from({ length: 20 }, (_, index) => ({ ...attempt, id: index + 1 }));
  const fixtures: { rows: unknown; next?: string; status?: number }[] = [
    { rows: [] }, { rows: [attempt], next: '2' }, { rows: [null, { ...attempt, response_status: 600 }] },
    { rows: fullPage }, { rows: fullPage, next: '' }, { rows: {} }, { rows: [...fullPage, attempt] }, { rows: [], next: '2' },
    { rows: { private: 'do not include upstream failure object' }, status: 403 },
  ];
  let reads = 0;
  const origin = await upstream(t, (_request, response) => {
    const fixture = fixtures[reads++];
    response.statusCode = fixture.status ?? 200;
    if (fixture.next !== undefined) response.setHeader('X-Next-Page', fixture.next);
    response.end(JSON.stringify(fixture.rows));
  });
  const read = () => readGitlabProjectWebhookHistory({ baseUrl: origin }, 2, 3, receiver);
  assert.deepEqual(await read(), { attempts: [], partial: false });
  assert.deepEqual(await read(), { attempts: [{ id: 1, event: 'push', status: 200, sentAt: null, durationMs: null }], partial: true });
  assert.deepEqual(await read(), { attempts: [], partial: true });
  const limited = await read();
  assert.equal(limited.attempts.length, 20);
  assert.equal(limited.partial, true);
  assert.deepEqual(await read(), { ...limited, partial: false });
  for (let index = 0; index < 3; index++) {
    await assert.rejects(read, (error: unknown) => error instanceof GitlabReadError && error.code === 'invalid-response');
  }
  await assert.rejects(read, (error: unknown) => error instanceof GitlabReadError && error.httpStatus === 403 && !error.message.includes('private'));
  await assert.rejects(() => readGitlabProjectWebhookHistory({ baseUrl: origin }, 2, -1, receiver), GitlabReadError);
  await assert.rejects(() => readGitlabProjectWebhookHistory({ baseUrl: origin }, 2, 3, `${receiver}/`), GitlabReadError);
  assert.equal(reads, fixtures.length);
});

test('GitLab read scans preserve a configured subpath and cap MR pages and pipeline rows', async t => {
  const paths: string[] = [];
  const credentials: (string | string[] | undefined)[] = [];
  const origin = await upstream(t, (request, response) => {
    paths.push(request.url!);
    credentials.push(request.headers['private-token']);
    const url = new URL(request.url!, 'http://localhost');
    const rows = url.pathname.endsWith('/pipelines') ? 50 : 100;
    const start = (Number(url.searchParams.get('page') || '1') - 1) * rows;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(Array.from({ length: rows }, (_, index) => ({ id: start + index + 1 }))));
  });

  const result = await readGitlabSyncProject({ baseUrl: `${origin}/gitlab/`, token: 'synthetic-token' }, 42);
  assert.deepEqual(paths, [
    ...Array.from({ length: 10 }, (_, index) => `/gitlab/api/v4/projects/42/merge_requests?scope=all&per_page=100&page=${index + 1}`),
    '/gitlab/api/v4/projects/42/pipelines?per_page=50',
  ]);
  assert.deepEqual(new Set(credentials), new Set(['synthetic-token']));
  assert.equal(result.mergeRequests.length, 1_000);
  assert.deepEqual(result.mergeRequests.at(-1), { id: 1_000 });
  assert.equal(result.pipelines.length, 50);
  assert.equal(Object.hasOwn(result, 'history'), false);
});

test('optional repository history uses bounded numeric project paths and never follows remote pagination links', async t => {
  const paths: string[] = [];
  const token = 'synthetic-history-token';
  let outsideRequests = 0;
  const outside = await upstream(t, (_request, response) => {
    outsideRequests++;
    response.end('[]');
  });
  const origin = await upstream(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['private-token'], token);
    paths.push(request.url!);
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Link', `<${outside}/different-project>; rel="next"`);
    response.setHeader('X-Next-Page', '99');
    if (url.pathname.endsWith('/42')) {
      response.end(JSON.stringify({ id: 42, path_with_namespace: 'team/repository' }));
    } else if (url.pathname.endsWith('/branches')) {
      const offset = (Number(url.searchParams.get('page')) - 1) * 100;
      response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: `branch-${offset + index + 1}` }))));
    } else if (url.pathname.endsWith('/commits')) {
      response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: `commit-${index + 1}` }))));
    } else response.end('[]');
  });
  const basePath = '/gitlab/api/v4/projects/42';
  const result = await readGitlabSyncProject({ baseUrl: `${origin}/gitlab/`, token }, 42, { includeHistory: true });
  assert.deepEqual(paths, [
    basePath,
    ...Array.from({ length: 5 }, (_, index) => `${basePath}/repository/branches?per_page=100&page=${index + 1}`),
    `${basePath}/repository/commits?all=true&per_page=100`,
    `${basePath}/merge_requests?scope=all&per_page=100&page=1`,
    `${basePath}/pipelines?per_page=50`,
  ]);
  assert.equal(outsideRequests, 0);
  assert.deepEqual(result.history?.project, { id: 42, path_with_namespace: 'team/repository' });
  assert.equal(result.history?.branches.length, 500);
  assert.deepEqual(result.history?.branches.at(-1), { name: 'branch-500' });
  assert.equal(result.history?.commits.length, 100);
  assert.equal(result.history?.branchesLimited, true);
  assert.equal(result.history?.commitsLimited, true);
});

test('optional history stops after a short branch page and detects partial and oversized objects', async t => {
  const paths: string[] = [];
  const origin = await upstream(t, (request, response) => {
    paths.push(request.url!);
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    const projectId = url.pathname.split('/').at(-1);
    if (projectId === '42' || projectId === '43' || projectId === '44') {
      response.end(JSON.stringify({ id: Number(projectId) }));
    } else if (url.pathname.endsWith('/branches')) {
      response.end(url.pathname.includes('/43/') ? '[[]]' : '[{"name":"feature/TEAM-1"}]');
    } else if (url.pathname.endsWith('/commits') && url.pathname.includes('/44/')) {
      response.end(JSON.stringify(Array.from({ length: 101 }, () => ({ id: 'example' }))));
    } else response.end('[]');
  });

  const connection = { baseUrl: origin };
  const result = await readGitlabSyncProject(connection, 42, { includeHistory: true });
  assert.deepEqual(result.history, {
    project: { id: 42 }, branches: [{ name: 'feature/TEAM-1' }], commits: [], branchesLimited: false, commitsLimited: false,
  });
  assert.equal(paths.filter(path => path.includes('/branches?')).length, 1);
  await assert.rejects(readGitlabSyncProject(connection, 44, { includeHistory: true }), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'commits' && error.code === 'invalid-response');
  await assert.rejects(readGitlabSyncProject(connection, 43, { includeHistory: true }), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'branches' && error.code === 'invalid-response');
});

test('optional history requires an exact numeric project response and denies branch redirects', async t => {
  const seen: string[] = [];
  const syntheticToken = 'example-history-secret';
  let redirectedRequests = 0;
  const destination = await upstream(t, (_request, response) => {
    redirectedRequests++;
    response.end('[]');
  });
  const origin = await upstream(t, (request, response) => {
    seen.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/41')) response.end('{"id":"41"}');
    else if (request.url?.endsWith('/42')) response.end('{"id":43}');
    else if (request.url?.endsWith('/43')) response.end('{"id":43}');
    else {
      response.writeHead(302, { Location: `${destination}/${syntheticToken}` });
      response.end(syntheticToken);
    }
  });
  const connection = { baseUrl: origin, token: syntheticToken };
  for (const projectId of [41, 42]) {
    await assert.rejects(readGitlabSyncProject(connection, projectId, { includeHistory: true }), (error: unknown) =>
      error instanceof GitlabReadError && error.stage === 'project' && error.code === 'invalid-response');
  }
  await assert.rejects(readGitlabSyncProject(connection, 43, { includeHistory: true }), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'branches' && error.code === 'http' && error.httpStatus === 302 &&
      !error.message.includes(syntheticToken) && !error.message.includes(destination));
  assert.deepEqual(seen, [41, 42, 43].map(id => `/api/v4/projects/${id}`).concat('/api/v4/projects/43/repository/branches?per_page=100&page=1'));
  assert.equal(redirectedRequests, 0);
});

test('GitLab read errors report their stage and status without forwarding redirects or exposing upstream text', async t => {
  const syntheticToken = 'example-test-token';
  let redirectedRequests = 0;
  const destination = await upstream(t, (_request, response) => {
    redirectedRequests++;
    response.end('[]');
  });
  const origin = await upstream(t, (request, response) => {
    const path = request.url!;
    response.setHeader('Content-Type', 'application/json');
    if (path.includes('/1/')) {
      response.writeHead(302, { Location: `${destination}/${syntheticToken}` });
      response.end(syntheticToken);
    } else if (path.includes('/2/') && path.includes('/pipelines')) {
      response.end(`malformed response: ${syntheticToken}`);
    } else if (path.includes('/3/')) {
      response.writeHead(403);
      response.end(JSON.stringify({ message: syntheticToken }));
    } else if (path.includes('/4/') && path.includes('/pipelines')) {
      response.end(JSON.stringify(Array.from({ length: 51 }, () => ({ id: 1 }))));
    } else response.end('[]');
  });

  const expectedErrors = [
    { projectId: 1, stage: 'merge-requests', code: 'http', httpStatus: 302 },
    { projectId: 2, stage: 'pipelines', code: 'invalid-response', httpStatus: null },
    { projectId: 3, stage: 'merge-requests', code: 'http', httpStatus: 403 },
    { projectId: 4, stage: 'pipelines', code: 'invalid-response', httpStatus: null },
  ];
  for (const { projectId, stage, code, httpStatus } of expectedErrors) {
    await assert.rejects(readGitlabSyncProject({ baseUrl: origin, token: syntheticToken }, projectId), (error: unknown) => {
      assert.ok(error instanceof GitlabReadError);
      assert.deepEqual({ stage: error.stage, code: error.code, httpStatus: error.httpStatus }, { stage, code, httpStatus });
      assert.equal(error.message.includes(syntheticToken), false);
      assert.equal(error.message.includes(destination), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(redirectedRequests, 0);
});

test('GitLab read limits the decoded response even when the compressed size is small', async t => {
  const body = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  const origin = await upstream(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) });
    response.end(body);
  });

  await assert.rejects(readGitlabSyncProject({ baseUrl: origin }, 42), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'merge-requests' && error.code === 'response-too-large' && error.httpStatus === null);
});

test('GitLab read cancels an in-flight response without exposing the abort reason', async t => {
  let headersSent!: () => void;
  const entered = new Promise<void>(resolve => { headersSent = resolve; });
  const origin = await upstream(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('[');
    headersSent();
  });
  const controller = new AbortController();
  const read = readGitlabSyncProject({ baseUrl: origin }, 42, { signal: controller.signal });
  const checked = assert.rejects(read, (error: unknown) => error instanceof GitlabReadError && error.stage === 'merge-requests' &&
    error.code === 'timeout' && !error.message.includes('synthetic-abort-reason'));
  await entered;
  controller.abort(new Error('synthetic-abort-reason'));
  await checked;
});

test('direct GitLab reads verify nested project URLs and use the distinct MR and pipeline identifiers', async t => {
  const requests: string[] = [];
  const token = 'synthetic-manual-inspection';
  const projectApiPath = '/gitlab/api/v4/projects/42';
  const origin = await upstream(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['private-token'], token);
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === projectApiPath) {
      response.end(JSON.stringify({ id: 42, path_with_namespace: 'team/subgroup/repo', web_url: repository }));
    } else if (request.url === `${projectApiPath}/merge_requests/8`) {
      response.end(JSON.stringify({ id: 831, project_id: 42, target_project_id: 42, iid: 8, web_url: mergeRequest }));
    } else if (request.url === `${projectApiPath}/pipelines/764`) {
      response.end(JSON.stringify({ id: 764, project_id: 42, iid: 5, web_url: `${repository}/pipelines/764` }));
    } else response.writeHead(404).end();
  });
  const repository = `${origin}/gitlab/team/subgroup/repo`;
  const mergeRequest = `${repository}/-/merge_requests/8`;
  const pipeline = `${repository}/-/pipelines/764`;
  const connection = { baseUrl: `${origin}/gitlab/`, token };

  assert.deepEqual(await readGitlabManualObject(connection, 42, ` ${mergeRequest}/?diff_id=64#note_1 `), {
    kind: 'merge_request', webUrl: mergeRequest,
    object: { id: 831, project_id: 42, target_project_id: 42, iid: 8, web_url: mergeRequest },
  });
  assert.deepEqual(await readGitlabManualObject(connection, 42, `${repository}/pipelines/764#jobs`), {
    kind: 'pipeline', webUrl: pipeline,
    object: { id: 764, project_id: 42, iid: 5, web_url: pipeline },
  });
  assert.deepEqual(requests, [projectApiPath, `${projectApiPath}/merge_requests/8`, projectApiPath, `${projectApiPath}/pipelines/764`]);
});

test('foreign and malformed GitLab URLs cause no reads and a different repository stops after the configured project read', async t => {
  const requests: string[] = [];
  const origin = await upstream(t, (request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 42, web_url: `${origin}/gitlab/team/subgroup/repo` }));
  });
  const connection = { baseUrl: `${origin}/gitlab` };
  const wrongAddresses = [
    `${origin}/gitlab-other/team/subgroup/repo/-/merge_requests/8`,
    `${origin}/gitlab/team/subgroup/repo/-/issues/8`,
    `${origin}/gitlab/team/subgroup/repo/-/pipelines/9007199254740992`,
    `${origin}/gitlab/team/subgroup/repo/-/pipelines/0008`,
    `${origin}/gitlab/team/subgroup/re%2Fpo/-/merge_requests/8`,
    `${origin}/gitlab/team/subgroup/repo/%2e/-/merge_requests/8`,
    `${origin}/gitlab/team/subgroup/repo/%XY/-/merge_requests/8`,
    `${origin}/gitlab/team/subgroup/repo\\elsewhere/-/merge_requests/8`,
    `${origin.replace('://', '://user@')}/gitlab/team/subgroup/repo/-/merge_requests/8`,
    `${origin.replace('://', '://@')}/gitlab/team/subgroup/repo/-/merge_requests/8`,
    'https://example.invalid/gitlab/team/subgroup/repo/-/merge_requests/8',
  ];
  for (const url of wrongAddresses) {
    await assert.rejects(readGitlabManualObject(connection, 42, url), GitlabManualUrlError);
  }
  assert.deepEqual(requests, []);
  await assert.rejects(readGitlabManualObject(connection, 42, `${origin}/gitlab/other/repo/-/merge_requests/8`), GitlabManualUrlError);
  assert.deepEqual(requests, ['/gitlab/api/v4/projects/42']);
});

test('direct GitLab branch and commit reads verify exact refs and preserve the configured subpath', async t => {
  const requests: string[] = [];
  const resolved: [string, string][] = [];
  const token = 'synthetic-manual-reference-inspection';
  const basePath = '/gitlab/-/tree/instance';
  const projectPath = `${basePath}/api/v4/projects/42`;
  const branchName = 'feature/-/tree/기존-작업';
  const branchPath = `${projectPath}/repository/branches/${encodeURIComponent(branchName)}`;
  const sha = 'abcdef1234'.repeat(4);
  const head = '9876abcdef'.repeat(4);
  const commitPath = `${projectPath}/repository/commits/${sha}`;
  const origin = await upstream(t, (request, response) => {
    requests.push(request.url!);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['private-token'], token);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === projectPath) response.end(JSON.stringify({ id: 42, path_with_namespace: 'team/subgroup/repo', web_url: repository }));
    else if (request.url === branchPath) {
      assert.deepEqual(resolved.at(-1), [branchName, branchUrl]);
      response.end(JSON.stringify({ name: branchName, commit: { id: head }, web_url: 'https://outside.invalid/wrong' }));
    } else if (request.url === commitPath) {
      response.end(JSON.stringify({ id: sha, title: 'An existing non-keyed commit', committed_date: '2025-01-01T00:00:00Z' }));
    } else response.writeHead(404).end();
  });
  const baseUrl = origin + basePath;
  const repository = `${baseUrl}/team/subgroup/repo`;
  const branchUrl = `${repository}/-/tree/${encodeURIComponent(branchName)}`;
  const commitUrl = `${repository}/-/commit/${sha}`;
  const resolveBranch = (name: string, webUrl: string) => resolved.push([name, webUrl]);
  const unescapedBranchSlashes = branchName.split('/').map(encodeURIComponent).join('/');
  for (const pasted of [branchUrl, `${repository}/-/tree/${unescapedBranchSlashes}?ref_type=heads#files`]) {
    assert.deepEqual(await readGitlabManualObject({ baseUrl, token }, 42, pasted, undefined, resolveBranch), {
      kind: 'branch', webUrl: branchUrl, object: { name: branchName, commit: { id: head }, web_url: branchUrl },
    });
  }
  assert.deepEqual(await readGitlabManualObject({ baseUrl, token }, 42,
    `${repository}/-/commit/${sha.toUpperCase()}?view=parallel#note_1`, undefined, resolveBranch), {
    kind: 'commit', webUrl: commitUrl, object: { id: sha, title: 'An existing non-keyed commit',
      committed_date: '2025-01-01T00:00:00Z', web_url: commitUrl },
  });
  assert.deepEqual(requests, [projectPath, branchPath, projectPath, branchPath, projectPath, commitPath]);
  assert.deepEqual(resolved, [[branchName, branchUrl], [branchName, branchUrl]]);
});

test('direct GitLab ref reads reject foreign, ambiguous and inconsistent branch or commit identities', async t => {
  const requests: string[] = [];
  const projectPath = '/gitlab/api/v4/projects/42';
  const ref = 'feature/nested';
  const head = 'a1'.repeat(20);
  let object: Record<string, unknown>;
  let resolved = 0;
  const origin = await upstream(t, (request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === projectPath ? { id: 42, web_url: repository } : object));
  });
  const baseUrl = `${origin}/gitlab`;
  const repository = `${baseUrl}/team/repo`;
  const connection = { baseUrl };
  const branch = `${repository}/-/tree/${encodeURIComponent(ref)}`;
  const commit = `${repository}/-/commit/${head}`;
  const resolveBranch = () => resolved++;
  for (const url of [
    branch + '?ref_type=tags', branch + '?ref_type=heads&ref_type=tags', branch + '?ref_type=',
    `${repository}/-/tree/feature/%2e%2e/other`, `${repository}/-/tree/feature%2f%2fother`,
    `${repository}/-/tree/feature/%XY`, `${repository}/-/tree/feature%5cother`,
    `${baseUrl}/team%2frepo/-/tree/feature`, `${origin}/gitlab-other/team/repo/-/tree/feature`,
    `https://outside.invalid/gitlab/team/repo/-/tree/feature`,
    `${repository}/-/commit/${head.slice(0, 8)}`, commit + '/diff', `${repository}/-/commit/${'0'.repeat(40)}`,
  ]) await assert.rejects(readGitlabManualObject(connection, 42, url, undefined, resolveBranch), GitlabManualUrlError);
  assert.deepEqual(requests, []);
  assert.equal(resolved, 0);

  await assert.rejects(readGitlabManualObject(connection, 42, `${baseUrl}/other/repo/-/tree/feature`,
    undefined, resolveBranch), GitlabManualUrlError);
  assert.deepEqual(requests, [projectPath]);
  assert.equal(resolved, 0);

  for (const [url, reply, stage] of [
    [branch, { name: 'feature/another', commit: { id: head } }, 'branches'],
    [branch, { name: ref, commit: { id: '0'.repeat(40) } }, 'branches'],
    [branch, { name: ref, id: head }, 'branches'],
    [commit, { id: 'b2'.repeat(20) }, 'commits'],
    [commit, { id: head, project_id: 43 }, 'commits'],
  ] as const) {
    object = reply;
    await assert.rejects(readGitlabManualObject(connection, 42, url, undefined, resolveBranch), (error: unknown) =>
      error instanceof GitlabReadError && error.stage === stage && error.code === 'invalid-response');
  }
  assert.deepEqual(requests.slice(1), [
    ...Array.from({ length: 3 }, () => [projectPath, `${projectPath}/repository/branches/${encodeURIComponent(ref)}`]).flat(),
    ...Array.from({ length: 2 }, () => [projectPath, `${projectPath}/repository/commits/${head}`]).flat(),
  ]);
  assert.equal(resolved, 3);
});

test('direct GitLab reads require consistent project, object and returned web identities', async t => {
  let projectFields: Record<string, unknown>;
  let objectFields: Record<string, unknown>;
  const requests: string[] = [];
  const origin = await upstream(t, (request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/v4/projects/42' ? projectFields : objectFields));
  });
  const connection = { baseUrl: origin };
  const repository = `${origin}/team/repo`;
  const mergeRequest = `${repository}/-/merge_requests/8`;
  const pipeline = `${repository}/-/pipelines/764`;
  const goodProject = { id: 42, web_url: repository, path_with_namespace: 'team/repo' };
  const goodMr = { id: 30, project_id: 42, iid: 8, web_url: mergeRequest };
  for (const details of [{ id: 43 }, { path_with_namespace: 'different/repo' }, { web_url: `${repository}/elsewhere/..` }]) {
    projectFields = { ...goodProject, ...details };
    await assert.rejects(readGitlabManualObject(connection, 42, mergeRequest), (error: unknown) =>
      error instanceof GitlabReadError && error.stage === 'project' && error.code === 'invalid-response');
  }
  assert.deepEqual(requests, Array(3).fill('/api/v4/projects/42'));
  projectFields = goodProject;
  for (const details of [
    { project_id: 43 }, { target_project_id: 43 }, { iid: 9 }, { id: 0 }, { id: '30' },
    { web_url: `${repository}/-/merge_requests/9` }, { web_url: `${mergeRequest}?private_token=example` },
    { web_url: `${origin}/other/repo/-/merge_requests/8` }, { web_url: 'https://example.invalid/team/repo/-/merge_requests/8' },
  ]) {
    objectFields = { ...goodMr, ...details };
    await assert.rejects(readGitlabManualObject(connection, 42, mergeRequest), (error: unknown) =>
      error instanceof GitlabReadError && error.stage === 'merge-requests' && error.code === 'invalid-response');
  }
  objectFields = { id: 5, iid: 764, project_id: 42, web_url: pipeline };
  await assert.rejects(readGitlabManualObject(connection, 42, pipeline), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'pipelines' && error.code === 'invalid-response');
  assert.equal(requests.at(-1), '/api/v4/projects/42/pipelines/764');
});

test('direct GitLab reads never follow a redirect or expose its body and location', async t => {
  let redirected = 0;
  const token = 'synthetic-direct-read-token';
  const destination = await upstream(t, (_request, response) => {
    redirected++;
    response.end('{}');
  });
  const origin = await upstream(t, (request, response) => {
    if (request.url === '/api/v4/projects/42') {
      response.end(JSON.stringify({ id: 42, web_url: `${origin}/team/repo` }));
    } else response.writeHead(302, { Location: `${destination}/${token}` }).end(token);
  });
  await assert.rejects(readGitlabManualObject({ baseUrl: origin, token }, 42, `${origin}/team/repo/-/merge_requests/8`), (error: unknown) =>
    error instanceof GitlabReadError && error.stage === 'merge-requests' && error.httpStatus === 302 &&
    !error.message.includes(destination) && !error.message.includes(token));
  assert.equal(redirected, 0);
});
