import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabRepositorySearch, GitlabSettings } from '../../shared/types.js';

const settingsPath = '/integrations/gitlab';
const searchPath = `${settingsPath}/repository-search`;
const contextPath = '/tools/git';
const listPath = `${contextPath}/api/v4/projects`;
const pathWithNamespace = 'platform/subgroup/engine';
const token = 'synthetic-repository-read-token';
const draftToken = 'synthetic-unsaved-repository-token';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function source(t: TestContext, listener: RequestListener) {
  const upstream = createServer(listener);
  t.after(() => close(upstream));
  return await listen(upstream);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-gitlab-search-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = createServer(runtime.app);
  t.after(async () => {
    try { await close(server); }
    finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const baseUrl = await listen(server);
  async function call<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const result = await fetch(`${baseUrl}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await result.json() as T;
    assert.equal(result.status, status, JSON.stringify(data));
    return { data, cacheControl: result.headers.get('cache-control') };
  }
  return {
    call,
    async settings() { return (await call<GitlabSettings>(settingsPath)).data; },
    async configure(expectedVersion: number, baseUrl: string, projectIds: number[]) {
      return (await call<GitlabSettings>(settingsPath, { expectedVersion, baseUrl, projectIds, token }, 'PATCH')).data;
    },
  };
}

test('repository discovery reads the draft, pages GitLab names and resolves a full subgroup path without changing settings', async t => {
  const app = await fixture(t);
  const calls: { method?: string; url: URL; credential: string | string[] | undefined }[] = [];
  const origin = await source(t, (request, response) => {
    const baseUrl = `http://${request.headers.host}`;
    const url = new URL(request.url ?? '/', baseUrl);
    calls.push({ method: request.method, url, credential: request.headers['private-token'] });
    const row = { id: 42, name: 'Engine', path_with_namespace: pathWithNamespace, archived: false,
      web_url: `${baseUrl}${contextPath}/${pathWithNamespace}`, description: draftToken };
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === listPath) {
      const page = url.searchParams.get('page');
      response.setHeader('X-Next-Page', page === '1' ? '2' : '');
      response.end(JSON.stringify(page === '1' ? Array.from({ length: 20 }, (_, index) => index === 0 ? row : {
        ...row, id: 42 + index, path_with_namespace: `${pathWithNamespace}-${index}`, web_url: `${row.web_url}-${index}`,
      }) : []));
    } else if (decodeURIComponent(url.pathname) === `${listPath}/${pathWithNamespace}`) response.end(JSON.stringify(row));
    else response.writeHead(404).end();
  });
  const before = await app.settings();
  const body = { expectedVersion: before.version, baseUrl: `${origin}${contextPath}`, token: draftToken };
  const first = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query: ' platform ', page: 1 });
  assert.equal(first.cacheControl, 'no-store');
  assert.equal(first.data.settingsVersion, before.version);
  assert.equal(first.data.page, 1);
  assert.equal(first.data.hasNextPage, true);
  assert.equal(first.data.repositories.length, 20);
  const repository = { id: 42, name: 'Engine', pathWithNamespace, webUrl: `${origin}${contextPath}/${pathWithNamespace}` };
  assert.deepEqual(first.data.repositories[0], repository);
  assert.ok(!JSON.stringify(first.data).includes(draftToken));
  const second = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query: 'platform', page: 2 });
  assert.deepEqual(second.data, { settingsVersion: before.version, page: 2, hasNextPage: false, repositories: [] });
  const exact = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query: pathWithNamespace });
  assert.deepEqual(exact.data, { settingsVersion: before.version, page: 1, hasNextPage: false, repositories: [repository] });
  const absent = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query: 'platform/subgroup/absent' });
  assert.deepEqual(absent.data.repositories, []);
  assert.deepEqual(await app.settings(), before);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === 'GET' && call.credential === draftToken));
  assert.equal(calls[0].url.pathname, listPath);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { search: 'platform', search_namespaces: 'true',
    simple: 'true', archived: 'false', order_by: 'id', sort: 'asc', per_page: '20', page: '1' });
  assert.equal(calls[2].url.pathname, `${listPath}/${encodeURIComponent(pathWithNamespace)}`);
  assert.equal(calls[2].url.search, '');
});

test('discovery never forwards stored credentials to a new address and rejects results after a settings change', { timeout: 20_000 }, async t => {
  const app = await fixture(t);
  const stockCredentials: (string | string[] | undefined)[] = [];
  const newCredentials: (string | string[] | undefined)[] = [];
  let notifyPending: () => void = () => {};
  const pending = new Promise<void>(resolve => { notifyPending = resolve; });
  let heldResponse: (() => void) | undefined;
  const origin = await source(t, (request, response) => {
    stockCredentials.push(request.headers['private-token']);
    response.setHeader('Content-Type', 'application/json');
    if (new URL(request.url ?? '/', 'http://fixture.test').searchParams.get('search') === 'hold') {
      heldResponse = () => response.end('[]');
      notifyPending();
      return;
    }
    response.end('[]');
  });
  const other = await source(t, (request, response) => {
    newCredentials.push(request.headers['private-token']);
    response.setHeader('Content-Type', 'application/json').end('[]');
  });
  const saved = await app.configure((await app.settings()).version, `${origin}${contextPath}`, [18]);
  const body = { expectedVersion: saved.version, query: 'engine' };
  await app.call<GitlabRepositorySearch>(searchPath, { ...body, baseUrl: `${origin}${contextPath}/` });
  await app.call<GitlabRepositorySearch>(searchPath, { ...body, baseUrl: `${origin}/other-context` });
  await app.call<GitlabRepositorySearch>(searchPath, { ...body, baseUrl: `${other}${contextPath}` });
  await app.call<GitlabRepositorySearch>(searchPath, { ...body, baseUrl: `${other}${contextPath}`, token: draftToken });
  const conflict = app.call(searchPath, { ...body, query: 'hold' }, 'POST', 409);
  await pending;
  const changed = await app.configure(saved.version, `${origin}${contextPath}`, [18, 19]);
  heldResponse?.();
  await conflict;
  await app.call(searchPath, body, 'POST', 409);
  assert.deepEqual(stockCredentials, [token, undefined, token]);
  assert.deepEqual(newCredentials, [undefined, draftToken]);
  assert.deepEqual(await app.settings(), changed);
});

test('repository and HTTP clone addresses use one scoped exact lookup with a verified response', async t => {
  const app = await fixture(t);
  const requests: string[] = [];
  const origin = await source(t, (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const requestedPath = decodeURIComponent(url.pathname.slice(listPath.length + 1));
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    assert.equal(request.headers['private-token'], draftToken);
    const wrongPath = 'different/subgroup/engine';
    const returnedPath = requestedPath === wrongPath ? pathWithNamespace : requestedPath;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 42, name: 'Engine', path_with_namespace: returnedPath,
      web_url: `${url.origin}${contextPath}/${returnedPath}` }));
  });
  const before = await app.settings();
  const baseUrl = `${origin}${contextPath}`;
  const webUrl = `${baseUrl}/${pathWithNamespace}`;
  const body = { expectedVersion: before.version, baseUrl, token: draftToken };
  for (const query of [webUrl, `${webUrl}/`, `${webUrl}.git`, `${baseUrl}/%70latform/subgroup/engine`]) {
    const result = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query });
    assert.deepEqual(result.data, { settingsVersion: before.version, page: 1, hasNextPage: false,
      repositories: [{ id: 42, name: 'Engine', pathWithNamespace, webUrl }] });
  }
  assert.deepEqual(requests, Array(4).fill(`GET ${listPath}/${encodeURIComponent(pathWithNamespace)}`));

  const encodedToken = `%${draftToken.charCodeAt(0).toString(16)}${draftToken.slice(1)}`;
  for (const query of [webUrl.replace('http://', 'http://user:password@'), `${webUrl}?private_token=${draftToken}`, `${webUrl}#readme`,
    `${webUrl}/-/tree/main`, `${baseUrl}-other/${pathWithNamespace}`, `${origin}/other/${pathWithNamespace}`,
    `${baseUrl}/platform/subgroup/%2E%2E/engine`, `${baseUrl}/platform%2Fsubgroup/engine`, `${baseUrl}/platform/${encodedToken}`]) {
    const result = await app.call(searchPath, { ...body, query }, 'POST', 400);
    assert.ok(!JSON.stringify(result.data).includes(draftToken));
  }
  await app.call(searchPath, { ...body, query: webUrl, page: 2 }, 'POST', 400);
  assert.equal(requests.length, 4);

  await app.call(searchPath, { ...body, query: `${baseUrl}/different/subgroup/engine` }, 'POST', 502);
  assert.equal(requests.at(-1), `GET ${listPath}/${encodeURIComponent('different/subgroup/engine')}`);
  assert.deepEqual(await app.settings(), before);
});

test('repository discovery rejects invalid scope, unexpected responses and redirects without exposing the token', async t => {
  const app = await fixture(t);
  let outsideRequests = 0, upstreamRequests = 0;
  const outside = await source(t, (_request, response) => { outsideRequests++; response.end('[]'); });
  const origin = await source(t, (request, response) => {
    upstreamRequests++;
    const local = `http://${request.headers.host}`;
    const query = new URL(request.url ?? '/', local).searchParams.get('search');
    if (query === 'redirect') { response.writeHead(302, { Location: `${outside}/${draftToken}` }).end(draftToken); return; }
    const row = { id: 42, name: `Engine ${draftToken}`, path_with_namespace: pathWithNamespace, archived: false,
      web_url: query === 'foreign' ? `${outside}/${pathWithNamespace}` : `${local}${contextPath}/${pathWithNamespace}` };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(query === 'duplicate' ? [row, row] : [row]));
  });
  const settings = await app.settings();
  const body = { expectedVersion: settings.version, baseUrl: `${origin}${contextPath}`, token: draftToken };
  for (const invalid of [{ query: ' ' }, { query: 'engine', page: 21 }, { query: pathWithNamespace, page: 2 },
    { query: '/outside' }, { query: 'team/../outside' }, { query: 'https://outside.test/repo' }]) {
    await app.call(searchPath, { ...body, ...invalid }, 'POST', 400);
  }
  assert.equal(upstreamRequests, 0);
  for (const query of ['redirect', 'foreign', 'duplicate']) {
    const { data } = await app.call(searchPath, { ...body, query }, 'POST', 502);
    assert.ok(!JSON.stringify(data).includes(draftToken));
    assert.ok(!JSON.stringify(data).includes(outside));
  }
  const echoed = await app.call<GitlabRepositorySearch>(searchPath, { ...body, query: 'echo' });
  assert.deepEqual(echoed.data.repositories, []);
  assert.ok(!JSON.stringify(echoed.data).includes(draftToken));
  assert.equal(upstreamRequests, 4);
  assert.equal(outsideRequests, 0);
  assert.deepEqual(await app.settings(), settings);
});
