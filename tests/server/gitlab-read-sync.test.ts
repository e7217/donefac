import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { GitlabReadError, readGitlabSyncProject } from '../../server/gitlab-read-sync.js';

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
